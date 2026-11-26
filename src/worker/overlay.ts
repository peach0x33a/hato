import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  resolveExternalCliCustomEnv,
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
import { resolveAcpCommand, resolveAcpLaunchSpec } from "./acp/profiles.js";
import type { WorkerExecutionMode } from "./acp/types.js";
import type { ExternalCliBackend } from "./cli-probe.js";

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
  executionMode?: WorkerExecutionMode;
  hatoConfig: HatoConfig;
  mcpConfig: McpConfig;
  allowedMcpServers: readonly string[];
  selectedSkills: readonly SkillEntry[];
  contextMcp?: ContextMcpSpec;
  workerProxyEnv?: Readonly<Record<string, string>>;
  runtimeRootDir?: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface PreparedExternalCliOverlay {
  backend: ExternalCliBackend;
  command: string;
  args: string[];
  env: Record<string, string>;
  mcpServers: McpServer[];
  stagedSkillsDir: string | null;
  desiredModel?: string;
  desiredEffort?: string;
  desiredMode?: string;
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
 * Build ACP-standard `mcpServers` list and clean environment/skills staging for an ACP worker.
 * All MCP injection happens over the ACP `session/new` / `session/load` protocol payload
 * rather than mutating host CLI config files.
 */
export function prepareExternalCliOverlay(
  params: PrepareExternalCliOverlayParams,
): PreparedExternalCliOverlay {
  const runtimeRootDir =
    params.runtimeRootDir ??
    resolve(dirname(params.hatoConfig.paths.workspaces_dir), "worker-cli");

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

  const executionMode: WorkerExecutionMode =
    params.executionMode ??
    (params.hatoConfig.worker.execution_mode === "vm_unrestricted" ? "vm_unrestricted" : "isolated");

  const launch = resolveAcpLaunchSpec(params.backend, params.hatoConfig, executionMode);
  const customEnv = resolveExternalCliCustomEnv(params.hatoConfig);
  const mcpServers = buildAcpMcpServers({
    contextMcp: params.contextMcp,
    workerServers: authorizedWorkerServers,
  });

  return {
    backend: params.backend,
    command: launch.command,
    args: launch.args,
    env: buildCleanWorkerEnv({
      baseEnv: params.baseEnv,
      workerProxyEnv: params.workerProxyEnv,
      extraEnv: customEnv,
    }),
    mcpServers,
    stagedSkillsDir,
    desiredModel: launch.desiredModel,
    desiredEffort: launch.desiredEffort,
    desiredMode: launch.desiredMode,
  };
}

export function resolveBackendCommand(backend: ExternalCliBackend, config: HatoConfig): string {
  return resolveAcpCommand(backend, config);
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

export function buildAcpMcpServers(params: {
  contextMcp?: ContextMcpSpec;
  workerServers: readonly ResolvedMcpServerConfig[];
}): McpServer[] {
  const servers: McpServer[] = [];

  if (params.contextMcp) {
    servers.push({
      name: "hato_context",
      command: params.contextMcp.command,
      args: params.contextMcp.args,
      env: Object.entries(params.contextMcp.env).map(([name, value]) => ({ name, value })),
    });
  }

  for (const srv of params.workerServers) {
    if (srv.transport === "stdio" && srv.command) {
      servers.push({
        name: srv.name,
        command: srv.command,
        args: srv.args,
        env: Object.entries(resolveMcpServerEnv(srv)).map(([name, value]) => ({ name, value })),
      });
    } else if (srv.transport === "http" && srv.url) {
      servers.push({
        type: "http",
        name: srv.name,
        url: srv.url,
        headers: Object.entries(resolveMcpHttpHeaders(srv)).map(([name, value]) => ({ name, value })),
      });
    }
  }

  return servers;
}

function sanitizeTicketToken(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_") || "ticket";
}
