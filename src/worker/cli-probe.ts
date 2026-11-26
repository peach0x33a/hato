import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import {
  resolveWorkerExternalCliConfig,
  type HatoConfig,
} from "../config/app.js";
import { probeAcpHandshake } from "./acp/client.js";
import { ACP_BACKEND_PROFILES, resolveAcpLaunchSpec } from "./acp/profiles.js";
import type { AcpHandshakeProbeResult } from "./acp/types.js";

const execFileAsync = promisify(execFile);

export const EXTERNAL_CLI_BACKENDS = [
  "codex-cli",
  "antigravity-cli",
  "opencode-v2",
  "external-pi",
  "claude-code",
] as const;

export type ExternalCliBackend = (typeof EXTERNAL_CLI_BACKENDS)[number];

export interface CliOptionChoice {
  key: string;
  label: string;
  kind: "enum" | "boolean";
  choices?: string[];
  hostDefault?: string | boolean;
  effectiveHatoValue?: string | boolean;
}

export interface ExternalCliModelOption {
  id: string;
  label?: string;
}

export interface ExternalCliProbeEntry {
  backend: ExternalCliBackend;
  enabled: boolean;
  command: string;
  commandSource?: "default" | "configured";
  resolvedPath?: string;
  installed: boolean;
  available: boolean;
  version?: string;
  v2Verified?: boolean;
  reason?: string;
  hostConfigPath?: string;
  hostSummary: Record<string, string | boolean | string[]>;
  options: CliOptionChoice[];
  models?: ExternalCliModelOption[];
  effectiveArgsPreview: string[];
  probedAtMs: number;
  acp?: {
    protocolVersion?: number;
    agentName?: string;
    agentVersion?: string;
    loadSession?: boolean;
    installHint?: string;
  };
}

export type ExecCommandFn = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>;

export type ProbeAcpFn = (params: {
  command: string;
  args: string[];
  timeoutMs?: number;
}) => Promise<AcpHandshakeProbeResult>;

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const MODEL_PROBE_TIMEOUT_MS = 6000;

async function defaultExecCommand(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const res = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
      env: process.env,
    });
    return {
      ok: true,
      stdout: String(res.stdout ?? ""),
      stderr: String(res.stderr ?? ""),
    };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: string; code?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
      error: e.code === "ENOENT" ? `command not found: ${command}` : (e.message ?? String(err)),
    };
  }
}

export interface HostCliDefaultsSnapshot {
  configPath?: string;
  summary: Record<string, string | boolean | string[]>;
  defaults: Record<string, string | boolean>;
}

/**
 * Read host CLI configuration strictly read-only to surface defaults (e.g. relay/model/approval)
 * without ever mutating host files or exposing raw API keys.
 */
export function readHostCliDefaults(
  backend: ExternalCliBackend,
  homeDir = homedir(),
): HostCliDefaultsSnapshot {
  if (backend === "codex-cli") {
    const cfgPath = join(homeDir, ".codex", "config.toml");
    if (!existsSync(cfgPath)) {
      return { configPath: cfgPath, summary: {}, defaults: {} };
    }
    try {
      const parsed = parseToml(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      const summary: Record<string, string | boolean | string[]> = {};
      const defaults: Record<string, string | boolean> = {};

      if (typeof parsed.model === "string") summary.model = parsed.model;
      if (typeof parsed.model_provider === "string") summary.model_provider = parsed.model_provider;
      if (
        typeof parsed.model_reasoning_effort === "string" &&
        parsed.model_reasoning_effort.trim()
      ) {
        summary.model_reasoning_effort = parsed.model_reasoning_effort.trim();
        defaults.effort = parsed.model_reasoning_effort.trim();
      }
      if (typeof parsed.sandbox_mode === "string") {
        summary.sandbox_mode = parsed.sandbox_mode;
        defaults.sandbox = parsed.sandbox_mode;
      }
      if (typeof parsed.approval_policy === "string") {
        summary.approval_policy = parsed.approval_policy;
        defaults.approval = parsed.approval_policy;
      }
      if (parsed.model_providers && typeof parsed.model_providers === "object") {
        summary.providers = Object.keys(parsed.model_providers as Record<string, unknown>);
      }
      if (parsed.mcp_servers && typeof parsed.mcp_servers === "object") {
        summary.host_mcp_servers = Object.keys(parsed.mcp_servers as Record<string, unknown>);
      }
      return { configPath: cfgPath, summary, defaults };
    } catch {
      return { configPath: cfgPath, summary: {}, defaults: {} };
    }
  }

  if (backend === "antigravity-cli") {
    const cfgPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    const mcpPath = join(homeDir, ".gemini", "config", "mcp_config.json");
    const summary: Record<string, string | boolean | string[]> = {};
    const defaults: Record<string, string | boolean> = {};

    if (existsSync(cfgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
        if (typeof parsed.agentMode === "string" && parsed.agentMode.trim()) {
          summary.agentMode = parsed.agentMode;
          defaults.mode = parsed.agentMode;
        }
        if (typeof parsed.model === "string" && parsed.model.trim()) {
          summary.model = parsed.model;
        }
        if (typeof parsed.modelProvider === "string" && parsed.modelProvider.trim()) {
          summary.modelProvider = parsed.modelProvider;
        }
        if (typeof parsed.enableTerminalSandbox === "boolean") {
          summary.enableTerminalSandbox = parsed.enableTerminalSandbox;
          defaults.sandbox = parsed.enableTerminalSandbox;
        }
      } catch {
        // ignore malformed host settings.json
      }
    }

    if (existsSync(mcpPath)) {
      try {
        const mcpParsed = JSON.parse(readFileSync(mcpPath, "utf8")) as Record<string, unknown>;
        if (mcpParsed.mcpServers && typeof mcpParsed.mcpServers === "object") {
          const names = Object.keys(mcpParsed.mcpServers as Record<string, unknown>);
          if (names.length > 0) {
            summary.host_mcp_servers = names;
          }
        }
      } catch {
        // ignore malformed host mcp_config.json
      }
    }

    return { configPath: cfgPath, summary, defaults };
  }

  if (backend === "opencode-v2") {
    const candidates = [
      join(homeDir, ".config", "opencode", "opencode.json"),
      join(homeDir, ".opencode.json"),
    ];
    for (const cfgPath of candidates) {
      if (!existsSync(cfgPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
        const summary: Record<string, string | boolean | string[]> = {};
        const defaults: Record<string, string | boolean> = {};
        if (typeof parsed.model === "string") {
          summary.model = parsed.model;
          const hashIdx = parsed.model.indexOf("#");
          if (hashIdx > 0 && hashIdx < parsed.model.length - 1) {
            defaults.effort = parsed.model.slice(hashIdx + 1).trim();
          }
        }
        if (typeof parsed.default_agent === "string") {
          summary.default_agent = parsed.default_agent;
          defaults.agent = parsed.default_agent;
        }
        if (parsed.mcp && typeof parsed.mcp === "object") {
          summary.host_mcp_servers = Object.keys(parsed.mcp as Record<string, unknown>);
        }
        return { configPath: cfgPath, summary, defaults };
      } catch {
        return { configPath: cfgPath, summary: {}, defaults: {} };
      }
    }
    return { summary: {}, defaults: {} };
  }

  if (backend === "claude-code") {
    const cfgPath = join(homeDir, ".claude", "settings.json");
    if (!existsSync(cfgPath)) {
      return { configPath: cfgPath, summary: {}, defaults: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      const summary: Record<string, string | boolean | string[]> = {};
      const defaults: Record<string, string | boolean> = {};
      if (typeof parsed.model === "string" && parsed.model.trim()) {
        summary.model = parsed.model.trim();
      }
      if (typeof parsed.effortLevel === "string" && parsed.effortLevel.trim()) {
        summary.effortLevel = parsed.effortLevel.trim();
        defaults.effort = parsed.effortLevel.trim();
      }
      return { configPath: cfgPath, summary, defaults };
    } catch {
      return { configPath: cfgPath, summary: {}, defaults: {} };
    }
  }

  return { summary: {}, defaults: {} };
}

const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, "");
}

function mergeModelOptions(
  primary: ExternalCliModelOption[],
  hostDefaultModel?: unknown,
): ExternalCliModelOption[] {
  const seen = new Set<string>();
  const out: ExternalCliModelOption[] = [];
  const pushItem = (item: ExternalCliModelOption) => {
    const id = item.id.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, ...(item.label && item.label.trim() ? { label: item.label.trim() } : {}) });
  };
  for (const item of primary) pushItem(item);
  if (typeof hostDefaultModel === "string" && hostDefaultModel.trim()) {
    pushItem({ id: hostDefaultModel.trim() });
  }
  return out;
}

export function parseAgyModelsOutput(raw: string): ExternalCliModelOption[] {
  const out: ExternalCliModelOption[] = [];
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^fetching\b/i.test(trimmed) || /^loading\b/i.test(trimmed)) continue;
    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx > 0) {
      const id = trimmed.slice(0, tabIdx).trim();
      const label = trimmed.slice(tabIdx + 1).trim();
      if (id && !/\s/.test(id)) {
        out.push({ id, label: label || undefined });
      }
      continue;
    }
    const parts = trimmed.split(/\s{2,}/);
    const id = parts[0]?.trim() ?? "";
    if (id && /^[A-Za-z0-9._:/-]+$/.test(id)) {
      out.push({ id, label: parts[1]?.trim() || undefined });
    }
  }
  return mergeModelOptions(out);
}

export function parseOpenCodeModelsOutput(raw: string): ExternalCliModelOption[] {
  const out: ExternalCliModelOption[] = [];
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /\s/.test(trimmed) || !trimmed.includes("/")) continue;
    out.push({ id: trimmed });
  }
  return mergeModelOptions(out);
}

export function parsePiListModelsOutput(raw: string): ExternalCliModelOption[] {
  const out: ExternalCliModelOption[] = [];
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^provider\s+/i.test(trimmed) || /^[-=]+$/.test(trimmed)) continue;
    const cols = trimmed.split(/\s{2,}|\t/).map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 2 && !/\s/.test(cols[0]!) && !/\s/.test(cols[1]!)) {
      const id = cols[0]!.includes("/") ? cols[0]! : `${cols[0]}/${cols[1]}`;
      out.push({ id });
    } else if (/^[A-Za-z0-9._:/-]+$/.test(trimmed)) {
      out.push({ id: trimmed });
    }
  }
  return mergeModelOptions(out);
}

export function readCodexCachedModels(homeDir = homedir()): ExternalCliModelOption[] {
  const cachePath = join(homeDir, ".codex", "models_cache.json");
  if (!existsSync(cachePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        visibility?: unknown;
        priority?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.models)) return [];
    const visible = parsed.models
      .filter((m) => typeof m?.slug === "string" && m.slug.trim() && m.visibility !== "hide")
      .sort((a, b) => {
        const pa = typeof a.priority === "number" ? a.priority : 9999;
        const pb = typeof b.priority === "number" ? b.priority : 9999;
        return pa - pb;
      });
    return mergeModelOptions(
      visible.map((m) => ({
        id: String(m.slug).trim(),
        label: typeof m.display_name === "string" ? m.display_name.trim() : undefined,
      })),
    );
  } catch {
    return [];
  }
}

export function readCodexSupportedEfforts(
  homeDir = homedir(),
  preferredModel?: string,
  hostDefaultEffort?: string,
): string[] {
  const fallback = ["low", "medium", "high", "xhigh"];
  const cachePath = join(homeDir, ".codex", "models_cache.json");
  const seen = new Set<string>();
  const push = (val: unknown) => {
    if (typeof val === "string" && val.trim()) seen.add(val.trim());
  };

  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
        models?: Array<{
          slug?: unknown;
          visibility?: unknown;
          supported_reasoning_levels?: Array<{ effort?: unknown }>;
        }>;
      };
      if (Array.isArray(parsed.models)) {
        const cleanPreferred = preferredModel?.trim();
        const exactModel = cleanPreferred
          ? parsed.models.find(
              (m) => typeof m?.slug === "string" && m.slug.trim() === cleanPreferred,
            )
          : undefined;
        if (exactModel && Array.isArray(exactModel.supported_reasoning_levels)) {
          for (const lvl of exactModel.supported_reasoning_levels) {
            push(lvl?.effort);
          }
        } else {
          for (const m of parsed.models) {
            if (m?.visibility === "hide" || !Array.isArray(m?.supported_reasoning_levels)) continue;
            for (const lvl of m.supported_reasoning_levels) {
              push(lvl?.effort);
            }
          }
        }
      }
    } catch {
      // fall back to standard reasoning levels
    }
  }

  if (seen.size === 0) {
    for (const item of fallback) push(item);
  }
  if (hostDefaultEffort?.trim()) {
    push(hostDefaultEffort.trim());
  }
  return [...seen];
}

export async function probeExternalCliModels(
  backend: ExternalCliBackend,
  config: HatoConfig,
  options?: { exec?: ExecCommandFn; homeDir?: string },
): Promise<ExternalCliModelOption[]> {
  const exec = options?.exec ?? defaultExecCommand;
  const homeDir = options?.homeDir ?? homedir();
  const ext = config.worker.external_cli;
  const hostDefaults = readHostCliDefaults(backend, homeDir);

  if (backend === "codex-cli") {
    return mergeModelOptions(readCodexCachedModels(homeDir), hostDefaults.summary.model);
  }
  if (backend === "antigravity-cli") {
    const cmd = ext.antigravity_cli?.command?.trim() || "agy";
    const res = await exec(cmd, ["models"], MODEL_PROBE_TIMEOUT_MS);
    const parsed = res.ok ? parseAgyModelsOutput(res.stdout || res.stderr) : [];
    return mergeModelOptions(parsed, hostDefaults.summary.model);
  }
  if (backend === "opencode-v2") {
    const cmd = ext.opencode_v2?.command?.trim() || "opencode";
    const res = await exec(cmd, ["models"], MODEL_PROBE_TIMEOUT_MS);
    const parsed = res.ok ? parseOpenCodeModelsOutput(res.stdout || res.stderr) : [];
    return mergeModelOptions(parsed, hostDefaults.summary.model);
  }
  if (backend === "external-pi") {
    const parsed = await exec("pi", ["--list-models"], MODEL_PROBE_TIMEOUT_MS).then((res) =>
      res.ok ? parsePiListModelsOutput(res.stdout || res.stderr) : [],
    );
    return mergeModelOptions(parsed, hostDefaults.summary.model);
  }
  return mergeModelOptions(
    [
      { id: "sonnet", label: "Claude Sonnet (latest)" },
      { id: "opus", label: "Claude Opus (latest)" },
      { id: "haiku", label: "Claude Haiku (latest)" },
    ],
    hostDefaults.summary.model,
  );
}

interface CachedCliCapability {
  available: boolean;
  reason?: string;
  checkedAtMs: number;
}

const cliCapabilityCache = new Map<string, CachedCliCapability>();

function recordCapabilityCache(
  backend: ExternalCliBackend,
  command: string,
  available: boolean,
  reason?: string,
): void {
  cliCapabilityCache.set(`${backend}::${command.trim()}`, {
    available,
    reason,
    checkedAtMs: Date.now(),
  });
}

export function getCachedExternalCliAvailability(
  backend: ExternalCliBackend,
  command: string,
): { available: boolean; reason?: string } | undefined {
  const hit = cliCapabilityCache.get(`${backend}::${command.trim()}`);
  return hit ? { available: hit.available, reason: hit.reason } : undefined;
}

function formatProbeFailureReason(
  backend: ExternalCliBackend,
  command: string,
  handshake: AcpHandshakeProbeResult,
): string {
  const profile = ACP_BACKEND_PROFILES[backend];
  if (!handshake.installed) {
    return `未找到 ACP 命令 "${command}"。${profile.installHint}`;
  }
  return handshake.error || `ACP initialize 握手失败 (${command})`;
}

/**
 * Lightweight ACP `initialize` handshake verification used at startup/reload
 * and before launching an external worker.
 */
export async function verifyExternalCliBackend(
  backend: ExternalCliBackend,
  config: HatoConfig,
  deps?: { probeAcp?: ProbeAcpFn; force?: boolean },
): Promise<{ ok: boolean; reason?: string }> {
  const executionMode =
    config.worker.execution_mode === "vm_unrestricted" ? "vm_unrestricted" : "isolated";
  const launch = resolveAcpLaunchSpec(backend, config, executionMode);

  if (!deps?.probeAcp && !deps?.force) {
    const cached = getCachedExternalCliAvailability(backend, launch.command);
    if (cached) {
      return { ok: cached.available, reason: cached.reason };
    }
  }

  const probeFn =
    deps?.probeAcp ??
    ((p: { command: string; args: string[]; timeoutMs?: number }) =>
      probeAcpHandshake({
        command: p.command,
        args: p.args,
        timeoutMs: p.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      }));

  const handshake = await probeFn({
    command: launch.command,
    args: launch.args,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
  });

  const ok = handshake.ok;
  const reason = ok ? undefined : formatProbeFailureReason(backend, launch.command, handshake);

  if (!deps?.probeAcp) {
    recordCapabilityCache(backend, launch.command, ok, reason);
  }
  return { ok, reason };
}

export async function warmExternalCliCapabilities(config: HatoConfig): Promise<void> {
  await Promise.all(
    EXTERNAL_CLI_BACKENDS.map((backend) =>
      verifyExternalCliBackend(backend, config, { force: true }).catch(() => undefined),
    ),
  );
}

/**
 * Probe all configured external worker backends via ACP `initialize` handshake.
 */
export async function probeAllExternalClis(
  config: HatoConfig,
  deps?: {
    exec?: ExecCommandFn;
    probeAcp?: ProbeAcpFn;
    homeDir?: string;
  },
): Promise<ExternalCliProbeEntry[]> {
  const exec = deps?.exec ?? defaultExecCommand;
  const homeDir = deps?.homeDir ?? homedir();
  const now = Date.now();
  const ext = config.worker.external_cli;
  const executionMode =
    config.worker.execution_mode === "vm_unrestricted" ? "vm_unrestricted" : "isolated";

  const probeFn =
    deps?.probeAcp ??
    ((p: { command: string; args: string[]; timeoutMs?: number }) =>
      probeAcpHandshake({
        command: p.command,
        args: p.args,
        timeoutMs: p.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      }));

  const resolveBinaryPath = !deps?.probeAcp;

  const specs: Array<{
    backend: ExternalCliBackend;
    enabled: boolean;
    commandSource: "default" | "configured";
  }> = [
    {
      backend: "codex-cli",
      enabled: ext.codex_cli?.enabled ?? true,
      commandSource: ext.codex_cli?.command?.trim() ? "configured" : "default",
    },
    {
      backend: "antigravity-cli",
      enabled: ext.antigravity_cli?.enabled ?? true,
      commandSource: ext.antigravity_cli?.command?.trim() ? "configured" : "default",
    },
    {
      backend: "opencode-v2",
      enabled: ext.opencode_v2?.enabled ?? true,
      commandSource: ext.opencode_v2?.command?.trim() ? "configured" : "default",
    },
    {
      backend: "external-pi",
      enabled: ext.external_pi?.enabled ?? false,
      commandSource: ext.external_pi?.command?.trim() ? "configured" : "default",
    },
    {
      backend: "claude-code",
      enabled: ext.claude_code?.enabled ?? false,
      commandSource: ext.claude_code?.command?.trim() ? "configured" : "default",
    },
  ];

  return Promise.all(
    specs.map(async (spec) => {
      const launch = resolveAcpLaunchSpec(spec.backend, config, executionMode);
      const hostDefaults = readHostCliDefaults(spec.backend, homeDir);
      const handshake = await probeFn({
        command: launch.command,
        args: launch.args,
        timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      });

      const available = handshake.ok;
      const installed = handshake.installed;
      const reason = available
        ? undefined
        : formatProbeFailureReason(spec.backend, launch.command, handshake);

      if (resolveBinaryPath) {
        recordCapabilityCache(spec.backend, launch.command, available, reason);
      }

      const resolvedPath =
        resolveBinaryPath && installed ? await resolveBinaryLocation(launch.command) : undefined;

      const models = available
        ? await probeExternalCliModels(spec.backend, config, { exec, homeDir }).catch(() => [])
        : [];

      const agentVersion = handshake.agentInfo?.version ?? undefined;
      const agentName = handshake.agentInfo?.name ?? undefined;
      const extCfg = resolveWorkerExternalCliConfig(config);

      const options: CliOptionChoice[] = [
        {
          key: "permission_preset",
          label: "权限预设",
          kind: "enum",
          choices: ["yolo", "auto_safe", "read_only", "follow_host", "custom"],
          effectiveHatoValue: extCfg.permissionPreset,
        },
        ...(launch.desiredEffort
          ? [
              {
                key: "effort",
                label: "思考强度",
                kind: "enum" as const,
                choices:
                  spec.backend === "codex-cli"
                    ? readCodexSupportedEfforts(homeDir, launch.desiredModel)
                    : ["low", "medium", "high", "xhigh", "max"],
                hostDefault: hostDefaults.defaults.effort,
                effectiveHatoValue: launch.desiredEffort,
              },
            ]
          : []),
      ];

      return {
        backend: spec.backend,
        enabled: spec.enabled,
        command: launch.command,
        commandSource: spec.commandSource,
        ...(resolvedPath ? { resolvedPath } : {}),
        installed,
        available,
        version: agentVersion,
        ...(spec.backend === "opencode-v2" ? { v2Verified: available } : {}),
        ...(reason ? { reason } : {}),
        hostConfigPath: hostDefaults.configPath,
        hostSummary: hostDefaults.summary,
        options,
        models,
        effectiveArgsPreview: launch.args,
        probedAtMs: now,
        acp: {
          protocolVersion: handshake.protocolVersion,
          agentName,
          agentVersion,
          loadSession: Boolean(handshake.agentCapabilities?.loadSession),
          installHint: launch.installHint,
        },
      };
    }),
  );
}

async function resolveBinaryLocation(command: string): Promise<string | undefined> {
  if (!command.trim()) return undefined;
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const res = await execFileAsync(locator, [command], {
      timeout: 1500,
      maxBuffer: 64 * 1024,
      env: process.env,
    });
    const first = String(res.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return first || undefined;
  } catch {
    return undefined;
  }
}
