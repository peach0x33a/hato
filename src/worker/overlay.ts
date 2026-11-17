import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  resolveWorkerExternalCliConfig,
  type HatoConfig,
} from "../config/app.js";
import {
  resolveMcpHttpHeaders,
  resolveMcpServerEntries,
  resolveMcpServerEnv,
  type McpConfig,
  type ResolvedMcpServerConfig,
} from "../config/mcp.js";
import type { SkillEntry } from "../skills/loader.js";
import { resolveEffectiveCliModeArgs, type ExternalCliBackend } from "./cli-probe.js";

export interface ContextMcpSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface PrepareExternalCliOverlayParams {
  backend: ExternalCliBackend;
  ticketId: string;
  workspaceDir: string;
  isHostRepo: boolean;
  hatoConfig: HatoConfig;
  mcpConfig: McpConfig;
  allowedMcpServers: readonly string[];
  selectedSkills: readonly SkillEntry[];
  contextMcp?: ContextMcpSpec;
  workerProxyEnv?: Readonly<Record<string, string>>;
  hostHomeDir?: string;
  runtimeRootDir?: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface PreparedExternalCliOverlay {
  backend: ExternalCliBackend;
  command: string;
  modeArgs: string[];
  extraArgs: string[];
  env: Record<string, string>;
  stagedSkillsDir: string | null;
  generatedFiles: string[];
}

const SAFE_SYSTEM_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;

/**
 * Construct a clean subprocess environment containing only safe OS vars, optional worker proxy vars,
 * and explicit tool/MCP env entries—never leaking Hato secrets such as TG_BOT_TOKEN.
 */
export function buildCleanWorkerEnv(params: {
  baseEnv?: Readonly<Record<string, string | undefined>>;
  workerProxyEnv?: Readonly<Record<string, string>>;
  extraEnv?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const source = params.baseEnv ?? process.env;
  const out: Record<string, string> = {};

  for (const key of SAFE_SYSTEM_ENV_KEYS) {
    const val = source[key];
    if (typeof val === "string" && val.length > 0) {
      out[key] = val;
    }
  }

  if (params.workerProxyEnv) {
    for (const [k, v] of Object.entries(params.workerProxyEnv)) {
      if (v) out[k] = v;
    }
  }
  if (params.extraEnv) {
    for (const [k, v] of Object.entries(params.extraEnv)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Copy selected Worker Skills into either the ticket workspace (`.agents/skills/`)
 * or an external read-only staging directory when targeting a real host `allowed_repos` checkout.
 */
export function stageWorkerSkills(params: {
  skills: readonly SkillEntry[];
  ticketId: string;
  workspaceDir: string;
  isHostRepo: boolean;
  runtimeRootDir: string;
}): string | null {
  if (params.skills.length === 0) {
    return null;
  }

  const targetRoot = params.isHostRepo
    ? resolve(params.runtimeRootDir, "skills", sanitizeTicketToken(params.ticketId))
    : resolve(params.workspaceDir, ".agents", "skills");

  mkdirSync(targetRoot, { recursive: true });
  for (const skill of params.skills) {
    const dest = join(targetRoot, skill.dirName);
    cpSync(skill.dirPath, dest, { recursive: true, force: true });
  }
  return targetRoot;
}

/**
 * Build a Hato-only isolation overlay for an External CLI worker invocation:
 * inherits host auth & relay config (when enabled) while stripping personal MCP/skills
 * and never modifying the user's host configuration files.
 */
export function prepareExternalCliOverlay(
  params: PrepareExternalCliOverlayParams,
): PreparedExternalCliOverlay {
  const hostHomeDir = params.hostHomeDir ?? homedir();
  const runtimeRootDir =
    params.runtimeRootDir ??
    resolve(dirname(params.hatoConfig.paths.workspaces_dir), "worker-cli");
  const extCfg = resolveWorkerExternalCliConfig(params.hatoConfig);
  const ticketToken = sanitizeTicketToken(params.ticketId);
  const generatedFiles: string[] = [];

  const authorizedWorkerServers = selectAuthorizedWorkerMcpServers(
    params.mcpConfig,
    params.allowedMcpServers,
  );

  const stagedSkillsDir = stageWorkerSkills({
    skills: params.selectedSkills,
    ticketId: params.ticketId,
    workspaceDir: params.workspaceDir,
    isHostRepo: params.isHostRepo,
    runtimeRootDir,
  });

  const resolvedMode = resolveEffectiveCliModeArgs(params.backend, params.hatoConfig);
  const command = resolveBackendCommand(params.backend, params.hatoConfig);

  const mcpSecretEnv: Record<string, string> = {};
  if (params.contextMcp) {
    Object.assign(mcpSecretEnv, params.contextMcp.env);
  }
  for (const srv of authorizedWorkerServers) {
    if (srv.transport === "stdio") {
      Object.assign(mcpSecretEnv, resolveMcpServerEnv(srv));
    }
  }

  if (params.backend === "codex") {
    const shadowCodexHome = resolve(runtimeRootDir, "codex", ticketToken);
    mkdirSync(shadowCodexHome, { recursive: true });

    if (extCfg.reuseHostAuthAndProvider) {
      const hostAuth = join(hostHomeDir, ".codex", "auth.json");
      const shadowAuth = join(shadowCodexHome, "auth.json");
      if (existsSync(hostAuth)) {
        ensureSymlink(hostAuth, shadowAuth);
        generatedFiles.push(shadowAuth);
      }
    }

    const hostCodexTomlPath = join(hostHomeDir, ".codex", "config.toml");
    let baseCodexObj: Record<string, unknown> = {};
    if (extCfg.reuseHostAuthAndProvider && existsSync(hostCodexTomlPath)) {
      try {
        baseCodexObj = parseToml(readFileSync(hostCodexTomlPath, "utf8")) as Record<string, unknown>;
      } catch {
        baseCodexObj = {};
      }
    }

    const hostMcpObj =
      baseCodexObj.mcp_servers && typeof baseCodexObj.mcp_servers === "object"
        ? (baseCodexObj.mcp_servers as Record<string, unknown>)
        : {};
    const nextMcpServers: Record<string, unknown> = {};

    if (extCfg.inheritHostMcp) {
      Object.assign(nextMcpServers, hostMcpObj);
    } else if (extCfg.hostMcpAllowlist.length > 0) {
      for (const allowedName of extCfg.hostMcpAllowlist) {
        if (allowedName in hostMcpObj) {
          nextMcpServers[allowedName] = hostMcpObj[allowedName];
        }
      }
    }

    if (params.contextMcp) {
      nextMcpServers.hato_context = {
        command: params.contextMcp.command,
        args: params.contextMcp.args,
        env: params.contextMcp.env,
      };
    }

    for (const srv of authorizedWorkerServers) {
      if (srv.transport === "stdio" && srv.command) {
        nextMcpServers[srv.name] = {
          command: srv.command,
          args: srv.args,
          ...(srv.cwd ? { cwd: srv.cwd } : {}),
          ...(Object.keys(resolveMcpServerEnv(srv)).length > 0
            ? { env: resolveMcpServerEnv(srv) }
            : {}),
        };
      } else if (srv.transport === "http" && srv.url) {
        const headers = resolveMcpHttpHeaders(srv);
        nextMcpServers[srv.name] = {
          url: srv.url,
          ...(Object.keys(headers).length > 0 ? { http_headers: headers } : {}),
        };
      }
    }

    const filteredCodexObj: Record<string, unknown> = { ...baseCodexObj };
    delete filteredCodexObj.mcp_servers;
    if (Object.keys(nextMcpServers).length > 0) {
      filteredCodexObj.mcp_servers = nextMcpServers;
    }

    const shadowConfigPath = join(shadowCodexHome, "config.toml");
    writeFileSync(shadowConfigPath, `${stringifyToml(filteredCodexObj)}\n`, "utf8");
    generatedFiles.push(shadowConfigPath);

    const extraArgs: string[] = [];
    if (params.isHostRepo && stagedSkillsDir) {
      extraArgs.push("--add-dir", stagedSkillsDir);
    }

    return {
      backend: params.backend,
      command,
      modeArgs: resolvedMode.args,
      extraArgs,
      env: buildCleanWorkerEnv({
        baseEnv: params.baseEnv,
        workerProxyEnv: params.workerProxyEnv,
        extraEnv: {
          ...mcpSecretEnv,
          CODEX_HOME: shadowCodexHome,
        },
      }),
      stagedSkillsDir,
      generatedFiles,
    };
  }

  if (params.backend === "agy") {
    const agyOverlayDir = resolve(runtimeRootDir, "agy", ticketToken);
    mkdirSync(agyOverlayDir, { recursive: true });

    const mcpServersMap = buildStandardMcpServersMap({
      contextMcp: params.contextMcp,
      workerServers: authorizedWorkerServers,
    });
    const mcpConfigPath = join(agyOverlayDir, "mcp_config.json");
    writeFileSync(mcpConfigPath, `${JSON.stringify({ mcpServers: mcpServersMap }, null, 2)}\n`, "utf8");
    generatedFiles.push(mcpConfigPath);

    const sessionSettings: Record<string, unknown> = {
      mcpConfigPath,
      mcpServers: mcpServersMap,
    };
    const settingsPath = join(agyOverlayDir, "settings.json");
    writeFileSync(settingsPath, `${JSON.stringify(sessionSettings, null, 2)}\n`, "utf8");
    generatedFiles.push(settingsPath);

    const extraArgs = ["--settings", settingsPath, "--disable-slash-commands"];
    if (params.isHostRepo && stagedSkillsDir) {
      extraArgs.push("--add-dir", stagedSkillsDir);
    }

    return {
      backend: params.backend,
      command,
      modeArgs: resolvedMode.args,
      extraArgs,
      env: buildCleanWorkerEnv({
        baseEnv: params.baseEnv,
        workerProxyEnv: params.workerProxyEnv,
        extraEnv: mcpSecretEnv,
      }),
      stagedSkillsDir,
      generatedFiles,
    };
  }

  if (params.backend === "opencode-v2") {
    const ocOverlayDir = resolve(runtimeRootDir, "opencode-v2", ticketToken);
    mkdirSync(ocOverlayDir, { recursive: true });

    const hostCandidates = [
      join(hostHomeDir, ".config", "opencode", "opencode.json"),
      join(hostHomeDir, ".opencode.json"),
    ];
    let baseOpenCodeObj: Record<string, unknown> = {};
    if (extCfg.reuseHostAuthAndProvider) {
      for (const candidate of hostCandidates) {
        if (!existsSync(candidate)) continue;
        try {
          baseOpenCodeObj = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
          break;
        } catch {
          baseOpenCodeObj = {};
        }
      }
    }

    const hostMcp =
      baseOpenCodeObj.mcp && typeof baseOpenCodeObj.mcp === "object"
        ? (baseOpenCodeObj.mcp as Record<string, unknown>)
        : {};
    const nextMcp: Record<string, unknown> = {};

    if (extCfg.inheritHostMcp) {
      Object.assign(nextMcp, hostMcp);
    } else if (extCfg.hostMcpAllowlist.length > 0) {
      for (const allowedName of extCfg.hostMcpAllowlist) {
        if (allowedName in hostMcp) {
          nextMcp[allowedName] = hostMcp[allowedName];
        }
      }
    }

    if (params.contextMcp) {
      nextMcp.hato_context = {
        type: "local",
        command: [params.contextMcp.command, ...params.contextMcp.args],
        environment: params.contextMcp.env,
        enabled: true,
      };
    }

    for (const srv of authorizedWorkerServers) {
      if (srv.transport === "stdio" && srv.command) {
        nextMcp[srv.name] = {
          type: "local",
          command: [srv.command, ...srv.args],
          environment: resolveMcpServerEnv(srv),
          enabled: true,
        };
      } else if (srv.transport === "http" && srv.url) {
        nextMcp[srv.name] = {
          type: "remote",
          url: srv.url,
          headers: resolveMcpHttpHeaders(srv),
          enabled: true,
        };
      }
    }

    const nextOpenCodeObj: Record<string, unknown> = {
      ...baseOpenCodeObj,
      mcp: nextMcp,
    };
    const overlayConfigPath = join(ocOverlayDir, "opencode.json");
    writeFileSync(overlayConfigPath, `${JSON.stringify(nextOpenCodeObj, null, 2)}\n`, "utf8");
    generatedFiles.push(overlayConfigPath);

    return {
      backend: params.backend,
      command,
      modeArgs: resolvedMode.args,
      extraArgs: [],
      env: buildCleanWorkerEnv({
        baseEnv: params.baseEnv,
        workerProxyEnv: params.workerProxyEnv,
        extraEnv: {
          ...mcpSecretEnv,
          OPENCODE_CONFIG: overlayConfigPath,
        },
      }),
      stagedSkillsDir,
      generatedFiles,
    };
  }

  if (params.backend === "claude-code") {
    const ccDir = resolve(runtimeRootDir, "claude-code", ticketToken);
    mkdirSync(ccDir, { recursive: true });
    const mcpServersMap = buildStandardMcpServersMap({
      contextMcp: params.contextMcp,
      workerServers: authorizedWorkerServers,
    });
    const mcpConfigPath = join(ccDir, "ticket_mcp.json");
    writeFileSync(mcpConfigPath, `${JSON.stringify({ mcpServers: mcpServersMap }, null, 2)}\n`, "utf8");
    generatedFiles.push(mcpConfigPath);

    const extraArgs = ["--strict-mcp-config", "--mcp-config", mcpConfigPath];
    if (params.isHostRepo && stagedSkillsDir) {
      extraArgs.push("--add-dir", stagedSkillsDir);
    }

    return {
      backend: params.backend,
      command,
      modeArgs: resolvedMode.args,
      extraArgs,
      env: buildCleanWorkerEnv({
        baseEnv: params.baseEnv,
        workerProxyEnv: params.workerProxyEnv,
        extraEnv: mcpSecretEnv,
      }),
      stagedSkillsDir,
      generatedFiles,
    };
  }

  return {
    backend: params.backend,
    command,
    modeArgs: resolvedMode.args,
    extraArgs: [],
    env: buildCleanWorkerEnv({
      baseEnv: params.baseEnv,
      workerProxyEnv: params.workerProxyEnv,
      extraEnv: mcpSecretEnv,
    }),
    stagedSkillsDir,
    generatedFiles,
  };
}

function resolveBackendCommand(backend: ExternalCliBackend, config: HatoConfig): string {
  const ext = config.worker.external_cli;
  if (backend === "codex") return ext.codex?.command?.trim() || "codex";
  if (backend === "agy") return ext.agy?.command?.trim() || "agy";
  if (backend === "opencode-v2") return ext.opencode_v2?.command?.trim() || "opencode";
  if (backend === "external-pi") return ext.external_pi?.command?.trim() || "pi";
  return ext.claude_code?.command?.trim() || "claude";
}

function selectAuthorizedWorkerMcpServers(
  mcpConfig: McpConfig,
  allowedNames: readonly string[],
): ResolvedMcpServerConfig[] {
  const allowSet = new Set(allowedNames.map((n) => n.trim()).filter(Boolean));
  return resolveMcpServerEntries(mcpConfig, "worker").filter(
    (srv) => srv.enabled && allowSet.has(srv.name),
  );
}

function buildStandardMcpServersMap(params: {
  contextMcp?: ContextMcpSpec;
  workerServers: readonly ResolvedMcpServerConfig[];
}): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  if (params.contextMcp) {
    map.hato_context = {
      command: params.contextMcp.command,
      args: params.contextMcp.args,
      env: params.contextMcp.env,
    };
  }
  for (const srv of params.workerServers) {
    if (srv.transport === "stdio" && srv.command) {
      map[srv.name] = {
        command: srv.command,
        args: srv.args,
        ...(srv.cwd ? { cwd: srv.cwd } : {}),
        env: resolveMcpServerEnv(srv),
      };
    } else if (srv.transport === "http" && srv.url) {
      map[srv.name] = {
        type: "http",
        url: srv.url,
        headers: resolveMcpHttpHeaders(srv),
      };
    }
  }
  return map;
}

function ensureSymlink(targetPath: string, linkPath: string): void {
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      unlinkSync(linkPath);
    }
  } catch {
    // linkPath does not exist
  }
  symlinkSync(targetPath, linkPath);
}

function sanitizeTicketToken(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_") || "ticket";
}
