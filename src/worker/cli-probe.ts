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
  "codex",
  "agy",
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

export interface ExternalCliProbeEntry {
  backend: ExternalCliBackend;
  tier: 1 | 2 | 3;
  enabled: boolean;
  command: string;
  installed: boolean;
  available: boolean;
  version?: string;
  v2Verified?: boolean;
  reason?: string;
  hostConfigPath?: string;
  hostSummary: Record<string, string | boolean | string[]>;
  options: CliOptionChoice[];
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
 * Parse `agy --help` for dynamically supported `--mode`, `--sandbox`, and skip-permissions flags.
 */
export function parseAgyHelpModes(helpText: string): {
  modeChoices: string[];
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

  return {
    modeChoices,
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
} {
  const rawVer = params.versionText.trim();
  const verMatch = /(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)/i.exec(rawVer);
  const major = verMatch ? Number(verMatch[1]) : null;
  const version = verMatch ? `v${verMatch[1]}.${verMatch[2]}.${verMatch[3]}` : rawVer || undefined;

  const combinedHelp = `${params.rootHelpText}\n${params.runHelpText}`;
  const supportsStandalone = combinedHelp.includes("--standalone");
  const supportsAuto = combinedHelp.includes("--auto");
  const supportsAgent = combinedHelp.includes("--agent");
  const mentionsV2Api = /\bv2\b/i.test(params.rootHelpText);

  if (major === null || Number.isNaN(major)) {
    return {
      v2Verified: false,
      version,
      reason: `无法识别 OpenCode 版本号 ("${rawVer || "empty"}")；必须为 OpenCode V2。`,
      supportsAuto,
      supportsStandalone,
      supportsAgent,
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
    };
  }

  return {
    v2Verified: true,
    version,
    supportsAuto,
    supportsStandalone,
    supportsAgent,
  };
}

/**
 * Parse `claude --help` for permission mode options (Tier 3 preview).
 */
export function parseClaudeHelpModes(helpText: string): {
  permissionModes: string[];
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
  return {
    permissionModes,
    supportsSkipPermissions: helpText.includes("--dangerously-skip-permissions"),
  };
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
  if (backend === "codex") {
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

  if (backend === "agy") {
    const cfgPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    if (!existsSync(cfgPath)) {
      return { configPath: cfgPath, summary: {}, defaults: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      const summary: Record<string, string | boolean | string[]> = {};
      const defaults: Record<string, string | boolean> = {};
      if (typeof parsed.mode === "string") {
        summary.mode = parsed.mode;
        defaults.mode = parsed.mode;
      }
      if (typeof parsed.model === "string") summary.model = parsed.model;
      if (typeof parsed.sandbox === "boolean") {
        summary.sandbox = parsed.sandbox;
        defaults.sandbox = parsed.sandbox;
      }
      return { configPath: cfgPath, summary, defaults };
    } catch {
      return { configPath: cfgPath, summary: {}, defaults: {} };
    }
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
        if (typeof parsed.model === "string") summary.model = parsed.model;
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

  return { summary: {}, defaults: {} };
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

  if (backend === "codex") {
    const c = ext.codex;
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

    const args: string[] = [];
    if (approval === "bypass") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      if (sandbox) args.push("--sandbox", sandbox);
      if (approval === "approve-for-me") args.push("--approve-for-me");
    }
    if (c?.model) args.push("-m", c.model);

    return {
      args,
      effectiveOptions: {
        ...(sandbox ? { sandbox } : {}),
        ...(approval ? { approval } : {}),
      },
      preset,
    };
  }

  if (backend === "agy") {
    const a = ext.agy;
    let mode = a?.mode;
    let skipPermissions = a?.skip_permissions;
    let sandbox = a?.sandbox;

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

    const args: string[] = [];
    if (mode) args.push("--mode", mode);
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    if (sandbox) args.push("--sandbox");
    if (a?.model) args.push("--model", a.model);

    return {
      args,
      effectiveOptions: {
        ...(mode !== undefined ? { mode } : {}),
        ...(skipPermissions !== undefined ? { skip_permissions: skipPermissions } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
      },
      preset,
    };
  }

  if (backend === "opencode-v2") {
    const o = ext.opencode_v2;
    let auto = o?.auto;
    const agent = o?.agent;

    if (auto === undefined) {
      if (preset === "yolo" || preset === "auto_safe") {
        auto = true;
      } else {
        auto = false;
      }
    }

    const args = ["--standalone"];
    if (auto) args.push("--auto");
    if (agent?.trim()) args.push("--agent", agent.trim());
    if (o?.model) args.push("-m", o.model);

    return {
      args,
      effectiveOptions: {
        auto,
        ...(agent?.trim() ? { agent: agent.trim() } : {}),
      },
      preset,
    };
  }

  if (backend === "claude-code") {
    const cc = ext.claude_code;
    let permissionMode = cc?.permission_mode;
    let skipPermissions = cc?.skip_permissions;

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
    }

    const args: string[] = [];
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    if (cc?.model) args.push("--model", cc.model);

    return {
      args,
      effectiveOptions: {
        ...(permissionMode ? { permission_mode: permissionMode } : {}),
        ...(skipPermissions !== undefined ? { skip_permissions: skipPermissions } : {}),
      },
      preset,
    };
  }

  const ep = ext.external_pi;
  const args: string[] = [];
  if (ep?.model) args.push("--model", ep.model);
  return {
    args,
    effectiveOptions: {},
    preset,
  };
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
    tier: 1 | 2 | 3;
    enabled: boolean;
    command: string;
  }> = [
    {
      backend: "codex",
      tier: 1,
      enabled: ext.codex?.enabled ?? true,
      command: ext.codex?.command?.trim() || "codex",
    },
    {
      backend: "agy",
      tier: 1,
      enabled: ext.agy?.enabled ?? true,
      command: ext.agy?.command?.trim() || "agy",
    },
    {
      backend: "opencode-v2",
      tier: 1,
      enabled: ext.opencode_v2?.enabled ?? true,
      command: ext.opencode_v2?.command?.trim() || "opencode",
    },
    {
      backend: "external-pi",
      tier: 2,
      enabled: ext.external_pi?.enabled ?? false,
      command: ext.external_pi?.command?.trim() || "pi",
    },
    {
      backend: "claude-code",
      tier: 3,
      enabled: ext.claude_code?.enabled ?? false,
      command: ext.claude_code?.command?.trim() || "claude",
    },
  ];

  return Promise.all(
    specs.map((spec) => probeSingleCli(spec, config, { exec, homeDir, now })),
  );
}

async function probeSingleCli(
  spec: {
    backend: ExternalCliBackend;
    tier: 1 | 2 | 3;
    enabled: boolean;
    command: string;
  },
  config: HatoConfig,
  ctx: { exec: ExecCommandFn; homeDir: string; now: number },
): Promise<ExternalCliProbeEntry> {
  const hostDefaults = readHostCliDefaults(spec.backend, ctx.homeDir);
  const resolvedMode = resolveEffectiveCliModeArgs(spec.backend, config);

  if (spec.backend === "codex") {
    const [verRes, helpRes] = await Promise.all([
      ctx.exec(spec.command, ["--version"]),
      ctx.exec(spec.command, ["exec", "--help"]),
    ]);
    const installed = verRes.ok || helpRes.ok;
    const parsed = parseCodexHelpModes(helpRes.stdout || helpRes.stderr);

    const options: CliOptionChoice[] = [
      {
        key: "sandbox",
        label: "沙箱策略 (--sandbox)",
        kind: "enum",
        choices: parsed.sandboxChoices,
        hostDefault: hostDefaults.defaults.sandbox,
        effectiveHatoValue: resolvedMode.effectiveOptions.sandbox,
      },
      {
        key: "approval",
        label: "审批模式",
        kind: "enum",
        choices: [
          "host",
          ...(parsed.supportsApproveForMe ? ["approve-for-me"] : []),
          ...(parsed.supportsBypass ? ["bypass"] : []),
        ],
        hostDefault: hostDefaults.defaults.approval ?? "host",
        effectiveHatoValue: resolvedMode.effectiveOptions.approval ?? "host",
      },
    ];

    return {
      backend: spec.backend,
      tier: spec.tier,
      enabled: spec.enabled,
      command: spec.command,
      installed,
      available: installed,
      version: extractVersionLine(verRes.stdout || verRes.stderr),
      reason: installed ? undefined : verRes.error || helpRes.error,
      hostConfigPath: hostDefaults.configPath,
      hostSummary: hostDefaults.summary,
      options,
      effectiveArgsPreview: resolvedMode.args,
      probedAtMs: ctx.now,
    };
  }

  if (spec.backend === "agy") {
    const [verRes, helpRes] = await Promise.all([
      ctx.exec(spec.command, ["--version"]),
      ctx.exec(spec.command, ["--help"]),
    ]);
    const installed = verRes.ok || helpRes.ok;
    const parsed = parseAgyHelpModes(helpRes.stdout || helpRes.stderr);

    const options: CliOptionChoice[] = [
      {
        key: "mode",
        label: "执行模式 (--mode)",
        kind: "enum",
        choices: parsed.modeChoices,
        hostDefault: hostDefaults.defaults.mode,
        effectiveHatoValue: resolvedMode.effectiveOptions.mode,
      },
      ...(parsed.supportsSkipPermissions
        ? [
            {
              key: "skip_permissions",
              label: "跳过权限弹窗 (--dangerously-skip-permissions)",
              kind: "boolean" as const,
              hostDefault: false,
              effectiveHatoValue: Boolean(resolvedMode.effectiveOptions.skip_permissions),
            },
          ]
        : []),
      ...(parsed.supportsSandbox
        ? [
            {
              key: "sandbox",
              label: "启用终端沙箱 (--sandbox)",
              kind: "boolean" as const,
              hostDefault: hostDefaults.defaults.sandbox ?? false,
              effectiveHatoValue: Boolean(resolvedMode.effectiveOptions.sandbox),
            },
          ]
        : []),
    ];

    return {
      backend: spec.backend,
      tier: spec.tier,
      enabled: spec.enabled,
      command: spec.command,
      installed,
      available: installed,
      version: extractVersionLine(verRes.stdout || verRes.stderr),
      reason: installed ? undefined : helpRes.error || verRes.error,
      hostConfigPath: hostDefaults.configPath,
      hostSummary: hostDefaults.summary,
      options,
      effectiveArgsPreview: resolvedMode.args,
      probedAtMs: ctx.now,
    };
  }

  if (spec.backend === "opencode-v2") {
    const [verRes, rootHelpRes, runHelpRes] = await Promise.all([
      ctx.exec(spec.command, ["--version"]),
      ctx.exec(spec.command, ["--help"]),
      ctx.exec(spec.command, ["run", "--help"]),
    ]);
    const installed = verRes.ok || rootHelpRes.ok;

    if (!installed) {
      return {
        backend: spec.backend,
        tier: spec.tier,
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
            key: "auto",
            label: "自动审批 (--auto)",
            kind: "boolean",
            effectiveHatoValue: Boolean(resolvedMode.effectiveOptions.auto),
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
        key: "auto",
        label: "自动审批 (--auto)",
        kind: "boolean",
        hostDefault: false,
        effectiveHatoValue: Boolean(resolvedMode.effectiveOptions.auto),
      },
    ];

    return {
      backend: spec.backend,
      tier: spec.tier,
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
    const parsed = parseClaudeHelpModes(helpRes.stdout || helpRes.stderr);

    return {
      backend: spec.backend,
      tier: spec.tier,
      enabled: spec.enabled,
      command: spec.command,
      installed,
      available: installed,
      version: extractVersionLine(verRes.stdout || verRes.stderr),
      reason: installed ? undefined : verRes.error || helpRes.error,
      hostConfigPath: hostDefaults.configPath,
      hostSummary: hostDefaults.summary,
      options: [
        {
          key: "permission_mode",
          label: "权限模式 (--permission-mode)",
          kind: "enum",
          choices: parsed.permissionModes,
          effectiveHatoValue: resolvedMode.effectiveOptions.permission_mode,
        },
        {
          key: "skip_permissions",
          label: "跳过权限确认 (--dangerously-skip-permissions)",
          kind: "boolean",
          effectiveHatoValue: Boolean(resolvedMode.effectiveOptions.skip_permissions),
        },
      ],
      effectiveArgsPreview: resolvedMode.args,
      probedAtMs: ctx.now,
    };
  }

  const verRes = await ctx.exec(spec.command, ["--version"]);
  const installed = verRes.ok;
  return {
    backend: spec.backend,
    tier: spec.tier,
    enabled: spec.enabled,
    command: spec.command,
    installed,
    available: installed,
    version: extractVersionLine(verRes.stdout || verRes.stderr),
    reason: installed ? undefined : verRes.error,
    hostConfigPath: hostDefaults.configPath,
    hostSummary: hostDefaults.summary,
    options: [],
    effectiveArgsPreview: resolvedMode.args,
    probedAtMs: ctx.now,
  };
}

function extractVersionLine(raw: string): string | undefined {
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return firstLine || undefined;
}
