import { resolveWorkerExternalCliConfig, type HatoConfig } from "../../config/app.js";
import type { ExternalCliBackend } from "../cli-probe.js";
import type { AcpBackendProfile, AcpLaunchSpec, WorkerExecutionMode } from "./types.js";

function readExtraAcpArgs(section: unknown): string[] {
  if (!section || typeof section !== "object") return [];
  const raw = (section as { acp_args?: unknown }).acp_args;
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v ?? "").trim()).filter(Boolean);
}

export const ACP_BACKEND_PROFILES: Record<ExternalCliBackend, AcpBackendProfile> = {
  "antigravity-cli": {
    backend: "antigravity-cli",
    defaultCommand: "agy",
    baseArgs: ["acp"],
    installHint: "请安装 Antigravity CLI (agy) 并确保其在 PATH 中，或在设置中指定 command。",
    buildLaunchArgs(config, executionMode) {
      const ext = resolveWorkerExternalCliConfig(config);
      const agy = config.worker.external_cli.antigravity_cli;
      const args = [...this.baseArgs];
      const shouldSkipPerms =
        executionMode === "vm_unrestricted" ||
        agy?.skip_permissions === true ||
        (agy?.skip_permissions === undefined && ext.permissionPreset === "yolo");
      if (shouldSkipPerms) {
        args.push("--dangerously-skip-permissions");
      }
      if (agy?.sandbox === true) {
        args.push("--sandbox");
      }
      args.push(...readExtraAcpArgs(agy));
      return args;
    },
    desiredModel(config) {
      return config.worker.external_cli.antigravity_cli?.model?.trim() || undefined;
    },
    desiredEffort(config) {
      return config.worker.external_cli.antigravity_cli?.effort?.trim() || undefined;
    },
    desiredMode(config) {
      return config.worker.external_cli.antigravity_cli?.mode?.trim() || undefined;
    },
  },

  "opencode-v2": {
    backend: "opencode-v2",
    defaultCommand: "opencode",
    baseArgs: ["acp"],
    installHint: "请安装 OpenCode V2 (opencode) 并确保其在 PATH 中，或在设置中指定 command。",
    buildLaunchArgs(config) {
      const oc = config.worker.external_cli.opencode_v2;
      return [...this.baseArgs, ...readExtraAcpArgs(oc)];
    },
    desiredModel(config) {
      return config.worker.external_cli.opencode_v2?.model?.trim() || undefined;
    },
    desiredEffort(config) {
      return config.worker.external_cli.opencode_v2?.effort?.trim() || undefined;
    },
    desiredMode(config) {
      return config.worker.external_cli.opencode_v2?.agent?.trim() || undefined;
    },
  },

  "claude-code": {
    backend: "claude-code",
    defaultCommand: "claude-agent-acp",
    baseArgs: [],
    installHint:
      "请安装 Claude Code ACP Bridge: npm i -g @agentclientprotocol/claude-agent-acp，或在配置中自定义 command。",
    buildLaunchArgs(config) {
      const cc = config.worker.external_cli.claude_code;
      return [...this.baseArgs, ...readExtraAcpArgs(cc)];
    },
    desiredModel(config) {
      return config.worker.external_cli.claude_code?.model?.trim() || undefined;
    },
    desiredEffort(config) {
      return config.worker.external_cli.claude_code?.effort?.trim() || undefined;
    },
    desiredMode(config, executionMode) {
      const cc = config.worker.external_cli.claude_code;
      if (cc?.permission_mode?.trim()) return cc.permission_mode.trim();
      if (executionMode === "vm_unrestricted" || cc?.skip_permissions) return "bypassPermissions";
      return undefined;
    },
  },

  "codex-cli": {
    backend: "codex-cli",
    defaultCommand: "codex-acp",
    baseArgs: [],
    installHint:
      "请安装 Codex ACP Bridge: npm i -g @agentclientprotocol/codex-acp，或在配置中自定义 command。",
    buildLaunchArgs(config) {
      const cx = config.worker.external_cli.codex_cli;
      return [...this.baseArgs, ...readExtraAcpArgs(cx)];
    },
    desiredModel(config) {
      return config.worker.external_cli.codex_cli?.model?.trim() || undefined;
    },
    desiredEffort(config) {
      return config.worker.external_cli.codex_cli?.effort?.trim() || undefined;
    },
    desiredMode(config) {
      return config.worker.external_cli.codex_cli?.approval?.trim() || undefined;
    },
  },

  "external-pi": {
    backend: "external-pi",
    defaultCommand: "pi-acp",
    baseArgs: [],
    installHint: "请安装 Pi ACP Bridge: npm i -g pi-acp，或在配置中自定义 command。",
    buildLaunchArgs(config) {
      const pi = config.worker.external_cli.external_pi;
      return [...this.baseArgs, ...readExtraAcpArgs(pi)];
    },
    desiredModel(config) {
      return config.worker.external_cli.external_pi?.model?.trim() || undefined;
    },
    desiredEffort(config) {
      return config.worker.external_cli.external_pi?.effort?.trim() || undefined;
    },
    desiredMode() {
      return undefined;
    },
  },
};

export function resolveAcpCommand(backend: ExternalCliBackend, config: HatoConfig): string {
  const ext = config.worker.external_cli;
  const profile = ACP_BACKEND_PROFILES[backend];
  const configured =
    backend === "codex-cli"
      ? ext.codex_cli?.command
      : backend === "antigravity-cli"
        ? ext.antigravity_cli?.command
        : backend === "opencode-v2"
          ? ext.opencode_v2?.command
          : backend === "external-pi"
            ? ext.external_pi?.command
            : ext.claude_code?.command;
  return configured?.trim() || profile.defaultCommand;
}

export function resolveAcpLaunchSpec(
  backend: ExternalCliBackend,
  config: HatoConfig,
  executionMode: WorkerExecutionMode = "isolated",
): AcpLaunchSpec {
  const profile = ACP_BACKEND_PROFILES[backend];
  return {
    backend,
    command: resolveAcpCommand(backend, config),
    args: profile.buildLaunchArgs(config, executionMode),
    installHint: profile.installHint,
    desiredModel: profile.desiredModel(config),
    desiredEffort: profile.desiredEffort(config),
    desiredMode: profile.desiredMode(config, executionMode),
  };
}
