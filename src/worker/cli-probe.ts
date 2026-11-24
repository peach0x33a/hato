import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import {
  resolveWorkerExternalCliConfig,
  type ExternalCliPermissionPreset,
  type HatoConfig,
} from "../config/app.js";

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
}

export type ExecCommandFn = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>;

const DEFAULT_PROBE_TIMEOUT_MS = 4000;

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

export interface CliCapabilityVerification {
  verified: boolean;
  missing: string[];
  reason?: string;
}

/**
 * Verify that `codex exec --help` supports Hato's required headless flags.
 */
export function verifyCodexCapabilities(execHelpText: string): CliCapabilityVerification {
  const required = ["--json", "--skip-git-repo-check", "--output-schema"];
  const missing = required.filter((flag) => !execHelpText.includes(flag));
  if (missing.length > 0) {
    return {
      verified: false,
      missing,
      reason: `当前 Codex CLI 版本过旧，缺少必需能力（缺少: ${missing.join(", ")}）。`,
    };
  }
  return { verified: true, missing: [] };
}

/**
 * Parse `codex exec --help` for dynamically supported sandbox & approval options.
 */
export function parseCodexHelpModes(helpText: string): {
  sandboxChoices: string[];
  supportsApproveForMe: boolean;
  supportsBypass: boolean;
} {
  const sandboxMatch = /--sandbox[\s\S]{0,240}?\[possible values:\s*([^\]]+)\]/i.exec(helpText);
  const sandboxChoices = sandboxMatch
    ? sandboxMatch[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : ["read-only", "workspace-write", "danger-full-access"];

  return {
    sandboxChoices,
    supportsApproveForMe: helpText.includes("--approve-for-me"),
    supportsBypass: helpText.includes("--dangerously-bypass-approvals-and-sandbox"),
  };
}

/**
 * Verify that `agy --help` supports Hato's required headless streaming, schema, resume, and settings flags.
 */
export function verifyAgyCapabilities(helpText: string): CliCapabilityVerification {
  const required = [
    "--output-format",
    "stream-json",
    "--conversation",
    "--json-schema",
    "--settings",
  ];
  const missing = required.filter((token) => !helpText.includes(token));
  if (missing.length > 0) {
    return {
      verified: false,
      missing,
      reason: `当前 Antigravity CLI 版本过旧，缺少必需能力（缺少: ${missing.join(", ")}）。`,
    };
  }
  return { verified: true, missing: [] };
}

/**
 * Parse `agy --help` for dynamically supported `--mode`, `--effort`, `--sandbox`, and skip-permissions flags.
 */
export function parseAgyHelpModes(helpText: string): {
  modeChoices: string[];
  effortChoices: string[];
  supportsSandbox: boolean;
  supportsSkipPermissions: boolean;
} {
  const modeMatch = /--mode[^\n]*\(([^)]+)\)/.exec(helpText);
  const modeChoices = modeMatch
    ? modeMatch[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : ["accept-edits", "auto", "plan"];

  const effortMatch = /--effort[^\n]*\(([^)]+)\)/.exec(helpText);
  const effortChoices = effortMatch
    ? effortMatch[1]!
        .split(/[,|]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return {
    modeChoices,
    effortChoices,
    supportsSandbox: helpText.includes("--sandbox"),
    supportsSkipPermissions: helpText.includes("--dangerously-skip-permissions"),
  };
}

/**
 * Verify that `opencode` is strictly OpenCode V2 (`>= 2.x` + v2 flags such as `--standalone`),
 * rejecting legacy bare v1 binaries.
 */
export function verifyOpenCodeV2(params: {
  versionText: string;
  rootHelpText: string;
  runHelpText: string;
}): {
  v2Verified: boolean;
  version?: string;
  reason?: string;
  supportsAuto: boolean;
  supportsStandalone: boolean;
  supportsAgent: boolean;
  supportsModelVariant: boolean;
} {
  const rawVer = params.versionText.trim();
  const verMatch = /(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)/i.exec(rawVer);
  const major = verMatch ? Number(verMatch[1]) : null;
  const version = verMatch ? `v${verMatch[1]}.${verMatch[2]}.${verMatch[3]}` : rawVer || undefined;

  const combinedHelp = `${params.rootHelpText}\n${params.runHelpText}`;
  const supportsStandalone = combinedHelp.includes("--standalone");
  const supportsAuto = combinedHelp.includes("--auto");
  const supportsAgent = combinedHelp.includes("--agent");
  const supportsModelVariant = /--model[^\n]*#variant/i.test(combinedHelp);
  const mentionsV2Api = /\bv2\b/i.test(params.rootHelpText);

  if (major === null || Number.isNaN(major)) {
    return {
      v2Verified: false,
      version,
      reason: `无法识别 OpenCode 版本号 ("${rawVer || "empty"}")；必须为 OpenCode V2。`,
      supportsAuto,
      supportsStandalone,
      supportsAgent,
      supportsModelVariant,
    };
  }

  if (major < 2 || (!supportsStandalone && !mentionsV2Api)) {
    return {
      v2Verified: false,
      version,
      reason: `检测到不兼容的裸 OpenCode (${version ?? "v1"})；Hato 仅支持 OpenCode V2（主版本 >= 2 且支持 --standalone）。`,
      supportsAuto,
      supportsStandalone,
      supportsAgent,
      supportsModelVariant,
    };
  }

  if (params.runHelpText.trim() && !params.runHelpText.includes("--format")) {
    return {
      v2Verified: false,
      version,
      reason: `当前 OpenCode (${version ?? "v2"}) 缺少必需能力（缺少: --format）。`,
      supportsAuto,
      supportsStandalone,
      supportsAgent,
      supportsModelVariant,
    };
  }

  return {
    v2Verified: true,
    version,
    supportsAuto,
    supportsStandalone,
    supportsAgent,
    supportsModelVariant,
  };
}

/**
 * Verify that `claude --help` supports Hato's required headless flags and strict MCP isolation.
 */
export function verifyClaudeCapabilities(helpText: string): CliCapabilityVerification {
  const required = [
    "--print",
    "--output-format",
    "stream-json",
    "--resume",
    "--mcp-config",
    "--strict-mcp-config",
    "--json-schema",
  ];
  const missing = required.filter((token) => !helpText.includes(token));
  if (missing.length > 0) {
    return {
      verified: false,
      missing,
      reason: `当前 Claude Code 版本过旧，缺少必需能力（缺少: ${missing.join(", ")}）。`,
    };
  }
  return { verified: true, missing: [] };
}

/**
 * Verify that `pi --help` supports Hato's required JSON stream and session flags.
 */
export function verifyPiCapabilities(helpText: string): CliCapabilityVerification {
  const required = ["--mode", "--session"];
  const missing = required.filter((token) => !helpText.includes(token));
  if (missing.length > 0) {
    return {
      verified: false,
      missing,
      reason: `当前 Pi CLI 版本过旧，缺少必需能力（缺少: ${missing.join(", ")}）。`,
    };
  }
  return { verified: true, missing: [] };
}

/**
 * Parse `claude --help` for permission mode and `--effort` options.
 */
export function parseClaudeHelpModes(helpText: string): {
  permissionModes: string[];
  effortChoices: string[];
  supportsSkipPermissions: boolean;
} {
  const modeMatch = /--permission-mode[\s\S]{0,160}?\(([^)]+)\)/.exec(helpText);
  const permissionModes = modeMatch
    ? modeMatch[1]!
        .replace(/^choices\s*:\s*/i, "")
        .split(/[,|]/)
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
    : ["default", "acceptEdits", "plan", "bypassPermissions"];

  const effortMatch = /--effort[\s\S]{0,160}?\(([^)]+)\)/.exec(helpText);
  const effortChoices = effortMatch
    ? effortMatch[1]!
        .replace(/^choices\s*:\s*/i, "")
        .split(/[,|]/)
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
    : helpText.includes("--effort")
      ? ["low", "medium", "high", "max"]
      : [];

  return {
    permissionModes,
    effortChoices,
    supportsSkipPermissions: helpText.includes("--dangerously-skip-permissions"),
  };
}

/**
 * Parse `pi --help` for `--thinking` effort levels.
 */
export function parsePiHelpModes(helpText: string): {
  thinkingChoices: string[];
} {
  const thinkingMatch = /--thinking[\s\S]{0,160}?\(([^)]+)\)/.exec(helpText);
  const thinkingChoices = thinkingMatch
    ? thinkingMatch[1]!
        .replace(/^choices\s*:\s*/i, "")
        .split(/[,|]/)
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
    : helpText.includes("--thinking")
      ? ["off", "minimal", "low", "medium", "high", "xhigh"]
      : [];
  return { thinkingChoices };
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
        if (typeof parsed.toolPermission === "string" && parsed.toolPermission.trim()) {
          summary.toolPermission = parsed.toolPermission;
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
        // ignore empty or malformed host mcp_config.json
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

/**
 * Parse `agy models` tab-separated output into selectable model options.
 */
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

/**
 * Parse `opencode models` line-based `<provider>/<model>` output.
 */
export function parseOpenCodeModelsOutput(raw: string): ExternalCliModelOption[] {
  const out: ExternalCliModelOption[] = [];
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /\s/.test(trimmed) || !trimmed.includes("/")) continue;
    out.push({ id: trimmed });
  }
  return mergeModelOptions(out);
}

/**
 * Parse `pi --list-models` output lines into `<provider>/<model>` or model IDs.
 */
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

/**
 * Read Codex's live-refreshed `~/.codex/models_cache.json` catalog.
 */
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

/**
 * Read supported reasoning effort levels from Codex's `~/.codex/models_cache.json`.
 */
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

const MODEL_PROBE_TIMEOUT_MS = 6000;

/**
 * Live-probe selectable models for a specific external CLI backend.
 */
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
    const cmd = ext.external_pi?.command?.trim() || "pi";
    const res = await exec(cmd, ["--list-models"], MODEL_PROBE_TIMEOUT_MS);
    const parsed = res.ok ? parsePiListModelsOutput(res.stdout || res.stderr) : [];
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

/**
 * Resolve effective Hato-only CLI permission & mode arguments for a backend by combining
 * `permission_preset` with any explicit per-backend override in `hato.toml`.
 */
export function resolveEffectiveCliModeArgs(
  backend: ExternalCliBackend,
  config: HatoConfig,
): {
  args: string[];
  effectiveOptions: Record<string, string | boolean>;
  preset: ExternalCliPermissionPreset;
} {
  const ext = config.worker.external_cli;
  const preset = resolveWorkerExternalCliConfig(config).permissionPreset;

  if (backend === "codex-cli") {
    const c = ext.codex_cli;
    let sandbox = c?.sandbox;
    let approval = c?.approval;

    if (!sandbox && !approval) {
      if (preset === "yolo") {
        approval = "bypass";
      } else if (preset === "auto_safe") {
        sandbox = "workspace-write";
        approval = "approve-for-me";
      } else if (preset === "read_only") {
        sandbox = "read-only";
      } else {
        approval = "host";
      }
    }

    const effort = c?.effort?.trim() || undefined;
    const args: string[] = [];
    if (approval === "bypass" || (sandbox === "danger-full-access" && approval !== "host")) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      if (sandbox) args.push("--sandbox", sandbox);
      if (approval === "approve-for-me") args.push("--approve-for-me");
    }
    if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    if (c?.model) args.push("-m", c.model);

    return {
      args,
      effectiveOptions: {
        ...(sandbox ? { sandbox } : {}),
        ...(approval ? { approval } : {}),
        ...(effort ? { effort } : {}),
      },
      preset,
    };
  }

  if (backend === "antigravity-cli") {
    const a = ext.antigravity_cli;
    let mode = a?.mode;
    let skipPermissions = a?.skip_permissions;
    let sandbox = a?.sandbox;
    const effort = a?.effort?.trim() || undefined;

    if (mode === undefined && skipPermissions === undefined && sandbox === undefined) {
      if (preset === "yolo") {
        mode = "auto";
        skipPermissions = true;
        sandbox = false;
      } else if (preset === "auto_safe") {
        mode = "auto";
        skipPermissions = false;
        sandbox = true;
      } else if (preset === "read_only") {
        mode = "plan";
        skipPermissions = false;
        sandbox = true;
      }
    }

    const modelHasTierSuffix = Boolean(
      a?.model && /-(low|medium|high|xhigh|max)$/i.test(a.model.trim()),
    );
    const effectiveEffort = !modelHasTierSuffix ? effort : undefined;

    const args: string[] = [];
    if (mode) args.push("--mode", mode);
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    if (sandbox) args.push("--sandbox");
    if (effectiveEffort) args.push("--effort", effectiveEffort);
    if (a?.model) args.push("--model", a.model);

    return {
      args,
      effectiveOptions: {
        ...(mode !== undefined ? { mode } : {}),
        ...(skipPermissions !== undefined ? { skip_permissions: skipPermissions } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
        ...(effectiveEffort !== undefined ? { effort: effectiveEffort } : {}),
      },
      preset,
    };
  }

  if (backend === "opencode-v2") {
    const o = ext.opencode_v2;
    let permissionMode = o?.permission_mode;
    let auto = o?.auto;
    const agent = o?.agent;

    if (!permissionMode) {
      if (auto !== undefined) {
        permissionMode = auto ? "auto" : "ask";
      } else if (preset === "yolo") {
        permissionMode = "full_access";
        auto = true;
      } else if (preset === "auto_safe") {
        permissionMode = "auto";
        auto = true;
      } else {
        permissionMode = "ask";
        auto = false;
      }
    } else {
      auto = permissionMode === "auto" || permissionMode === "full_access";
    }

    const effort = o?.effort?.trim() || undefined;
    const args = ["--standalone"];
    if (auto) args.push("--auto");
    if (agent?.trim()) args.push("--agent", agent.trim());
    if (o?.model) {
      const modelArg =
        o.model.includes("#") || !effort ? o.model : `${o.model}#${effort}`;
      args.push("-m", modelArg);
    }

    return {
      args,
      effectiveOptions: {
        auto,
        permission_mode: permissionMode,
        ...(agent?.trim() ? { agent: agent.trim() } : {}),
        ...(effort ? { effort } : {}),
      },
      preset,
    };
  }

  if (backend === "claude-code") {
    const cc = ext.claude_code;
    let permissionMode = cc?.permission_mode;
    let skipPermissions = cc?.skip_permissions;
    const effort = cc?.effort?.trim() || undefined;

    if (permissionMode === undefined && skipPermissions === undefined) {
      if (preset === "yolo") {
        permissionMode = "bypassPermissions";
        skipPermissions = true;
      } else if (preset === "auto_safe") {
        permissionMode = "acceptEdits";
        skipPermissions = false;
      } else if (preset === "read_only") {
        permissionMode = "plan";
        skipPermissions = false;
      }
    } else if (permissionMode === "bypassPermissions" && skipPermissions === undefined) {
      skipPermissions = true;
    }

    const args: string[] = [];
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    if (effort) args.push("--effort", effort);
    if (cc?.model) args.push("--model", cc.model);

    return {
      args,
      effectiveOptions: {
        ...(permissionMode ? { permission_mode: permissionMode } : {}),
        ...(skipPermissions !== undefined ? { skip_permissions: skipPermissions } : {}),
        ...(effort ? { effort } : {}),
      },
      preset,
    };
  }

  const ep = ext.external_pi;
  const piEffort = ep?.effort?.trim() || undefined;
  const args: string[] = [];
  if (piEffort) args.push("--thinking", piEffort);
  if (ep?.model) args.push("--model", ep.model);
  return {
    args,
    effectiveOptions: {
      ...(piEffort ? { effort: piEffort } : {}),
    },
    preset,
  };
}

const cliCapabilityCache = new Map<
  string,
  { available: boolean; reason?: string; checkedAtMs: number }
>();

function recordCapabilityCache(
  backend: ExternalCliBackend,
  command: string,
  available: boolean,
  reason?: string,
): void {
  cliCapabilityCache.set(`${backend}::${command.trim()}`, {
    available,
    ...(reason ? { reason } : {}),
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

/**
 * Lightweight local capability check (`--version` + `--help` only, skipping slow `models` network queries)
 * used at startup/reload and before launching an external CLI worker.
 */
export async function verifyExternalCliBackend(
  backend: ExternalCliBackend,
  config: HatoConfig,
  deps?: { exec?: ExecCommandFn; force?: boolean },
): Promise<{ ok: boolean; reason?: string }> {
  const ext = config.worker.external_cli;
  const command =
    backend === "codex-cli"
      ? ext.codex_cli?.command?.trim() || "codex"
      : backend === "antigravity-cli"
        ? ext.antigravity_cli?.command?.trim() || "agy"
        : backend === "opencode-v2"
          ? ext.opencode_v2?.command?.trim() || "opencode"
          : backend === "claude-code"
            ? ext.claude_code?.command?.trim() || "claude"
            : ext.external_pi?.command?.trim() || "pi";

  if (!deps?.exec && !deps?.force) {
    const cached = getCachedExternalCliAvailability(backend, command);
    if (cached) {
      return { ok: cached.available, reason: cached.reason };
    }
  }

  const exec = deps?.exec ?? defaultExecCommand;
  let ok = false;
  let reason: string | undefined;

  if (backend === "codex-cli") {
    const helpRes = await exec(command, ["exec", "--help"]);
    if (!helpRes.ok) {
      reason = helpRes.error || "Codex CLI 未安装或不可执行";
    } else {
      const cap = verifyCodexCapabilities(helpRes.stdout || helpRes.stderr);
      ok = cap.verified;
      reason = cap.reason;
    }
  } else if (backend === "antigravity-cli") {
    const helpRes = await exec(command, ["--help"]);
    if (!helpRes.ok) {
      reason = helpRes.error || "Antigravity CLI 未安装或不可执行";
    } else {
      const cap = verifyAgyCapabilities(helpRes.stdout || helpRes.stderr);
      ok = cap.verified;
      reason = cap.reason;
    }
  } else if (backend === "opencode-v2") {
    const [verRes, rootHelpRes, runHelpRes] = await Promise.all([
      exec(command, ["--version"]),
      exec(command, ["--help"]),
      exec(command, ["run", "--help"]),
    ]);
    if (!verRes.ok && !rootHelpRes.ok) {
      reason = verRes.error || rootHelpRes.error || "OpenCode V2 未安装或不可执行";
    } else {
      const v2 = verifyOpenCodeV2({
        versionText: verRes.stdout || verRes.stderr,
        rootHelpText: rootHelpRes.stdout || rootHelpRes.stderr,
        runHelpText: runHelpRes.stdout || runHelpRes.stderr,
      });
      ok = v2.v2Verified;
      reason = v2.reason;
    }
  } else if (backend === "claude-code") {
    const helpRes = await exec(command, ["--help"]);
    if (!helpRes.ok) {
      reason = helpRes.error || "Claude Code 未安装或不可执行";
    } else {
      const cap = verifyClaudeCapabilities(helpRes.stdout || helpRes.stderr);
      ok = cap.verified;
      reason = cap.reason;
    }
  } else {
    const helpRes = await exec(command, ["--help"]);
    if (!helpRes.ok) {
      reason = helpRes.error || "Pi CLI 未安装或不可执行";
    } else {
      const cap = verifyPiCapabilities(helpRes.stdout || helpRes.stderr);
      ok = cap.verified;
      reason = cap.reason;
    }
  }

  if (!deps?.exec) {
    recordCapabilityCache(backend, command, ok, reason);
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
 * Probe all configured external CLI backends dynamically: version/V2 verification,
 * supported mode options parsed from `--help`, host default config summary, and Hato-only preview args.
 */
export async function probeAllExternalClis(
  config: HatoConfig,
  deps?: {
    exec?: ExecCommandFn;
    homeDir?: string;
  },
): Promise<ExternalCliProbeEntry[]> {
  const exec = deps?.exec ?? defaultExecCommand;
  const homeDir = deps?.homeDir ?? homedir();
  const now = Date.now();
  const ext = config.worker.external_cli;

  const specs: Array<{
    backend: ExternalCliBackend;
    enabled: boolean;
    command: string;
    commandSource: "default" | "configured";
  }> = [
    {
      backend: "codex-cli",
      enabled: ext.codex_cli?.enabled ?? true,
      command: ext.codex_cli?.command?.trim() || "codex",
      commandSource: ext.codex_cli?.command?.trim() ? "configured" : "default",
    },
    {
      backend: "antigravity-cli",
      enabled: ext.antigravity_cli?.enabled ?? true,
      command: ext.antigravity_cli?.command?.trim() || "agy",
      commandSource: ext.antigravity_cli?.command?.trim() ? "configured" : "default",
    },
    {
      backend: "opencode-v2",
      enabled: ext.opencode_v2?.enabled ?? true,
      command: ext.opencode_v2?.command?.trim() || "opencode",
      commandSource: ext.opencode_v2?.command?.trim() ? "configured" : "default",
    },
    {
      backend: "external-pi",
      enabled: ext.external_pi?.enabled ?? false,
      command: ext.external_pi?.command?.trim() || "pi",
      commandSource: ext.external_pi?.command?.trim() ? "configured" : "default",
    },
    {
      backend: "claude-code",
      enabled: ext.claude_code?.enabled ?? false,
      command: ext.claude_code?.command?.trim() || "claude",
      commandSource: ext.claude_code?.command?.trim() ? "configured" : "default",
    },
  ];

  const resolveBinaryPath = !deps?.exec;

  return Promise.all(
    specs.map(async (spec) => {
      const entry = await probeSingleCli(spec, config, { exec, homeDir, now });
      if (resolveBinaryPath) {
        recordCapabilityCache(spec.backend, spec.command, entry.available, entry.reason);
      }
      const resolvedPath =
        resolveBinaryPath && entry.installed
          ? await resolveBinaryLocation(spec.command)
          : undefined;
      return {
        ...entry,
        commandSource: spec.commandSource,
        ...(resolvedPath ? { resolvedPath } : {}),
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

async function probeSingleCli(
  spec: {
    backend: ExternalCliBackend;
    enabled: boolean;
    command: string;
  },
  config: HatoConfig,
  ctx: { exec: ExecCommandFn; homeDir: string; now: number },
): Promise<ExternalCliProbeEntry> {
  const hostDefaults = readHostCliDefaults(spec.backend, ctx.homeDir);
  const resolvedMode = resolveEffectiveCliModeArgs(spec.backend, config);

  if (spec.backend === "codex-cli") {
    const [verRes, helpRes] = await Promise.all([
      ctx.exec(spec.command, ["--version"]),
      ctx.exec(spec.command, ["exec", "--help"]),
    ]);
    const installed = verRes.ok || helpRes.ok;
    const helpText = helpRes.stdout || helpRes.stderr;
    const parsed = parseCodexHelpModes(helpText);
    const cap = installed ? verifyCodexCapabilities(helpText) : { verified: false, missing: [] };

    const codexModeChoices = [
      ...parsed.sandboxChoices.filter((c) => c !== "danger-full-access"),
      ...(parsed.supportsApproveForMe ? ["approve-for-me"] : []),
      ...(parsed.sandboxChoices.includes("danger-full-access") || parsed.supportsBypass
        ? ["danger-full-access"]
        : []),
      "host",
    ];
    const effectiveCodexMode =
      resolvedMode.effectiveOptions.approval === "bypass" ||
      resolvedMode.effectiveOptions.sandbox === "danger-full-access"
        ? "danger-full-access"
        : resolvedMode.effectiveOptions.approval === "approve-for-me"
          ? "approve-for-me"
          : (resolvedMode.effectiveOptions.sandbox ?? resolvedMode.effectiveOptions.approval);

    const codexEffortChoices = readCodexSupportedEfforts(
      ctx.homeDir,
      config.worker.external_cli.codex_cli?.model ??
        (typeof hostDefaults.summary.model === "string" ? hostDefaults.summary.model : undefined),
      typeof hostDefaults.defaults.effort === "string" ? hostDefaults.defaults.effort : undefined,
    );

    const options: CliOptionChoice[] = [
      {
        key: "codex_mode",
        label: "执行与权限模式",
        kind: "enum",
        choices: codexModeChoices,
        hostDefault: hostDefaults.defaults.sandbox,
        effectiveHatoValue: effectiveCodexMode,
      },
      {
        key: "effort",
        label: "思考强度",
        kind: "enum",
        choices: codexEffortChoices,
        hostDefault: hostDefaults.defaults.effort,
        effectiveHatoValue: resolvedMode.effectiveOptions.effort,
      },
    ];

    const models = installed
      ? mergeModelOptions(readCodexCachedModels(ctx.homeDir), hostDefaults.summary.model)
      : [];

    return {
      backend: spec.backend,
      enabled: spec.enabled,
      command: spec.command,
      installed,
      available: installed && cap.verified,
      version: extractVersionLine(verRes.stdout || verRes.stderr),
      reason: !installed ? verRes.error || helpRes.error : cap.reason,
      hostConfigPath: hostDefaults.configPath,
      hostSummary: hostDefaults.summary,
      options,
      models,
      effectiveArgsPreview: resolvedMode.args,
      probedAtMs: ctx.now,
    };
  }

  if (spec.backend === "antigravity-cli") {
    const [verRes, helpRes, modelsRes] = await Promise.all([
      ctx.exec(spec.command, ["--version"]),
      ctx.exec(spec.command, ["--help"]),
      ctx.exec(spec.command, ["models"], MODEL_PROBE_TIMEOUT_MS),
    ]);
    const installed = verRes.ok || helpRes.ok;
    const helpText = helpRes.stdout || helpRes.stderr;
    const parsed = parseAgyHelpModes(helpText);
    const cap = installed ? verifyAgyCapabilities(helpText) : { verified: false, missing: [] };
    const models = installed
      ? mergeModelOptions(
          modelsRes.ok ? parseAgyModelsOutput(modelsRes.stdout || modelsRes.stderr) : [],
          hostDefaults.summary.model,
        )
      : [];

    const agyModeChoices = [
      ...parsed.modeChoices,
      ...(parsed.supportsSkipPermissions && !parsed.modeChoices.includes("skip-permissions")
        ? ["skip-permissions"]
        : []),
    ];

    const options: CliOptionChoice[] = [
      {
        key: "mode",
        label: "执行模式",
        kind: "enum",
        choices: agyModeChoices,
        hostDefault: hostDefaults.defaults.mode,
        effectiveHatoValue: resolvedMode.effectiveOptions.skip_permissions
          ? "skip-permissions"
          : resolvedMode.effectiveOptions.mode,
      },
      ...(parsed.supportsSandbox
        ? [
            {
              key: "sandbox",
              label: "终端沙箱",
              kind: "boolean" as const,
              hostDefault: hostDefaults.defaults.sandbox ?? false,
              effectiveHatoValue: Boolean(resolvedMode.effectiveOptions.sandbox),
            },
          ]
        : []),
      ...(parsed.effortChoices.length > 0
        ? [
            {
              key: "effort",
              label: "思考强度",
              kind: "enum" as const,
              choices: parsed.effortChoices,
              effectiveHatoValue: resolvedMode.effectiveOptions.effort,
            },
          ]
        : []),
    ];

    return {
      backend: spec.backend,
      enabled: spec.enabled,
      command: spec.command,
      installed,
      available: installed && cap.verified,
      version: extractVersionLine(verRes.stdout || verRes.stderr),
      reason: !installed ? helpRes.error || verRes.error : cap.reason,
      hostConfigPath: hostDefaults.configPath,
      hostSummary: hostDefaults.summary,
      options,
      models,
      effectiveArgsPreview: resolvedMode.args,
      probedAtMs: ctx.now,
    };
  }

  if (spec.backend === "opencode-v2") {
    const [verRes, rootHelpRes, runHelpRes, modelsRes] = await Promise.all([
      ctx.exec(spec.command, ["--version"]),
      ctx.exec(spec.command, ["--help"]),
      ctx.exec(spec.command, ["run", "--help"]),
      ctx.exec(spec.command, ["models"], MODEL_PROBE_TIMEOUT_MS),
    ]);
    const installed = verRes.ok || rootHelpRes.ok;

    if (!installed) {
      return {
        backend: spec.backend,
        enabled: spec.enabled,
        command: spec.command,
        installed: false,
        available: false,
        v2Verified: false,
        reason: verRes.error || rootHelpRes.error || "opencode 未安装",
        hostConfigPath: hostDefaults.configPath,
        hostSummary: hostDefaults.summary,
        options: [
          {
            key: "permission_mode",
            label: "权限模式",
            kind: "enum",
            choices: ["ask", "auto", "full_access"],
            hostDefault: "ask",
            effectiveHatoValue: resolvedMode.effectiveOptions.permission_mode ?? "ask",
          },
        ],
        effectiveArgsPreview: resolvedMode.args,
        probedAtMs: ctx.now,
      };
    }

    const v2 = verifyOpenCodeV2({
      versionText: verRes.stdout || verRes.stderr,
      rootHelpText: rootHelpRes.stdout || rootHelpRes.stderr,
      runHelpText: runHelpRes.stdout || runHelpRes.stderr,
    });

    const options: CliOptionChoice[] = [
      {
        key: "permission_mode",
        label: "权限模式",
        kind: "enum",
        choices: v2.supportsAuto ? ["ask", "auto", "full_access"] : ["ask"],
        hostDefault: "ask",
        effectiveHatoValue: resolvedMode.effectiveOptions.permission_mode ?? "ask",
      },
      ...(v2.supportsModelVariant || v2.v2Verified
        ? [
            {
              key: "effort",
              label: "思考强度",
              kind: "enum" as const,
              choices: ["low", "medium", "high", "xhigh", "max"],
              hostDefault: hostDefaults.defaults.effort,
              effectiveHatoValue: resolvedMode.effectiveOptions.effort,
            },
          ]
        : []),
    ];

    const models = mergeModelOptions(
      modelsRes.ok ? parseOpenCodeModelsOutput(modelsRes.stdout || modelsRes.stderr) : [],
      hostDefaults.summary.model,
    );

    return {
      backend: spec.backend,
      enabled: spec.enabled,
      command: spec.command,
      installed: true,
      available: v2.v2Verified,
      version: v2.version,
      v2Verified: v2.v2Verified,
      reason: v2.reason,
      hostConfigPath: hostDefaults.configPath,
      hostSummary: hostDefaults.summary,
      options,
      models,
      effectiveArgsPreview: resolvedMode.args,
      probedAtMs: ctx.now,
    };
  }

  if (spec.backend === "claude-code") {
    const [verRes, helpRes] = await Promise.all([
      ctx.exec(spec.command, ["--version"]),
      ctx.exec(spec.command, ["--help"]),
    ]);
    const installed = verRes.ok || helpRes.ok;
    const helpText = helpRes.stdout || helpRes.stderr;
    const parsed = parseClaudeHelpModes(helpText);
    const cap = installed ? verifyClaudeCapabilities(helpText) : { verified: false, missing: [] };
    const models = installed
      ? mergeModelOptions(
          [
            { id: "sonnet", label: "Claude Sonnet (latest)" },
            { id: "opus", label: "Claude Opus (latest)" },
            { id: "haiku", label: "Claude Haiku (latest)" },
          ],
          hostDefaults.summary.model,
        )
      : [];

    return {
      backend: spec.backend,
      enabled: spec.enabled,
      command: spec.command,
      installed,
      available: installed && cap.verified,
      version: extractVersionLine(verRes.stdout || verRes.stderr),
      reason: !installed ? verRes.error || helpRes.error : cap.reason,
      hostConfigPath: hostDefaults.configPath,
      hostSummary: hostDefaults.summary,
      options: [
        {
          key: "permission_mode",
          label: "权限模式",
          kind: "enum",
          choices: parsed.permissionModes,
          effectiveHatoValue: resolvedMode.effectiveOptions.skip_permissions
            ? "bypassPermissions"
            : resolvedMode.effectiveOptions.permission_mode,
        },
        ...(parsed.effortChoices.length > 0
          ? [
              {
                key: "effort",
                label: "思考强度",
                kind: "enum" as const,
                choices: parsed.effortChoices,
                hostDefault: hostDefaults.defaults.effort,
                effectiveHatoValue: resolvedMode.effectiveOptions.effort,
              },
            ]
          : []),
      ],
      models,
      effectiveArgsPreview: resolvedMode.args,
      probedAtMs: ctx.now,
    };
  }

  const [verRes, helpRes, modelsRes] = await Promise.all([
    ctx.exec(spec.command, ["--version"]),
    ctx.exec(spec.command, ["--help"]),
    ctx.exec(spec.command, ["--list-models"], MODEL_PROBE_TIMEOUT_MS),
  ]);
  const installed = verRes.ok || helpRes.ok;
  const piHelpText = helpRes.stdout || helpRes.stderr;
  const parsedPi = parsePiHelpModes(piHelpText);
  const piCap = installed ? verifyPiCapabilities(piHelpText) : { verified: false, missing: [] };
  const models = installed
    ? mergeModelOptions(
        modelsRes.ok ? parsePiListModelsOutput(modelsRes.stdout || modelsRes.stderr) : [],
        hostDefaults.summary.model,
      )
    : [];
  return {
    backend: spec.backend,
    enabled: spec.enabled,
    command: spec.command,
    installed,
    available: installed && piCap.verified,
    version: extractVersionLine(verRes.stdout || verRes.stderr),
    reason: !installed ? verRes.error || helpRes.error : piCap.reason,
    hostConfigPath: hostDefaults.configPath,
    hostSummary: hostDefaults.summary,
    options:
      parsedPi.thinkingChoices.length > 0
        ? [
            {
              key: "effort",
              label: "思考强度",
              kind: "enum",
              choices: parsedPi.thinkingChoices,
              effectiveHatoValue: resolvedMode.effectiveOptions.effort,
            },
          ]
        : [],
    models,
    effectiveArgsPreview: resolvedMode.args,
    probedAtMs: ctx.now,
  };
}

function extractVersionLine(raw: string): string | undefined {
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const semver = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/.exec(firstLine);
  return semver ? semver[0] : firstLine;
}
