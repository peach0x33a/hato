import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseToml } from "smol-toml";
import { getOptionalSecret } from "./secrets.js";

export const MCP_ZONES = ["personal", "worker"] as const;
export type McpZone = (typeof MCP_ZONES)[number];

const SAFE_MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

export const McpServerConfigSchema = Type.Object({
  zone: Type.Union([Type.Literal("personal"), Type.Literal("worker")]),
  enabled: Type.Optional(Type.Boolean()),
  transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
  description: Type.Optional(Type.String()),
  command: Type.Optional(Type.String({ minLength: 1 })),
  args: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
  env_refs: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }))),
  env_passthrough: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  url: Type.Optional(Type.String({ minLength: 1 })),
  headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
  bearer_token_env: Type.Optional(Type.String({ minLength: 1 })),
  proxy_scope: Type.Optional(Type.String({ minLength: 1 })),
  allowed_tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  disabled_tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  confirm_tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  timeout_ms: Type.Optional(Type.Number({ minimum: 500 })),
});

export const McpConfigSchema = Type.Object({
  servers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), McpServerConfigSchema)),
});

export type McpServerConfig = Static<typeof McpServerConfigSchema>;
export type McpConfig = Static<typeof McpConfigSchema>;

export interface ResolvedMcpServerConfig {
  name: string;
  zone: McpZone;
  enabled: boolean;
  transport: "stdio" | "http";
  description: string;
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  envRefs: Record<string, string>;
  envPassthrough: string[];
  url?: string;
  headers: Record<string, string>;
  bearerTokenEnv?: string;
  proxyScope: string;
  allowedTools: string[];
  disabledTools: string[];
  confirmTools: string[];
  timeoutMs: number;
}

/**
 * Validate a parsed `config/mcp.toml` object against `McpConfigSchema` and transport invariants.
 */
export function validateMcpConfigObject(parsed: unknown, sourceLabel = "mcp config"): McpConfig {
  if (!Value.Check(McpConfigSchema, parsed)) {
    const errors = [...Value.Errors(McpConfigSchema, parsed)]
      .slice(0, 6)
      .map((err) => `${err.path || "<root>"}: ${err.message}`)
      .join("; ");
    throw new Error(`Invalid MCP config (${sourceLabel}): ${errors}`);
  }

  for (const [name, server] of Object.entries(parsed.servers ?? {})) {
    if (!SAFE_MCP_NAME_RE.test(name)) {
      throw new Error(
        `Invalid MCP server name "${name}" in ${sourceLabel}: expected alphanumeric/dot/dash/underscore`,
      );
    }
    if (server.transport === "stdio" && !server.command?.trim()) {
      throw new Error(`MCP server "${name}" uses stdio transport and requires "command"`);
    }
    if (server.transport === "http") {
      if (!server.url?.trim()) {
        throw new Error(`MCP server "${name}" uses http transport and requires "url"`);
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(server.url);
      } catch {
        throw new Error(`MCP server "${name}" has invalid URL: "${server.url}"`);
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(`MCP server "${name}" URL must use http or https protocol`);
      }
    }
  }

  return parsed;
}

/**
 * Parse and validate `config/mcp.toml`. Returns an empty server map when the file is absent.
 */
export function loadMcpConfig(configPath = "config/mcp.toml"): McpConfig {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    return { servers: {} };
  }
  const raw = readFileSync(absPath, "utf8");
  const parsed = parseToml(raw);
  return validateMcpConfigObject(parsed, absPath);
}

/**
 * Resolve normalized MCP server entries sorted deterministically by name, optionally filtered by zone.
 */
export function resolveMcpServerEntries(
  config: McpConfig,
  zone?: McpZone,
): ResolvedMcpServerConfig[] {
  const entries: ResolvedMcpServerConfig[] = [];
  const names = Object.keys(config.servers ?? {}).sort();

  for (const name of names) {
    const raw = config.servers![name]!;
    if (zone && raw.zone !== zone) continue;
    entries.push({
      name,
      zone: raw.zone,
      enabled: raw.enabled ?? true,
      transport: raw.transport,
      description: raw.description?.trim() ?? "",
      command: raw.command?.trim(),
      args: [...(raw.args ?? [])],
      cwd: raw.cwd?.trim(),
      env: { ...(raw.env ?? {}) },
      envRefs: { ...(raw.env_refs ?? {}) },
      envPassthrough: [...(raw.env_passthrough ?? [])],
      url: raw.url?.trim(),
      headers: { ...(raw.headers ?? {}) },
      bearerTokenEnv: raw.bearer_token_env?.trim(),
      proxyScope: raw.proxy_scope?.trim() || `mcp.${name}`,
      allowedTools: [...(raw.allowed_tools ?? [])],
      disabledTools: [...(raw.disabled_tools ?? [])],
      confirmTools: [...(raw.confirm_tools ?? [])],
      timeoutMs: raw.timeout_ms ?? 15_000,
    });
  }

  return entries;
}

/**
 * Evaluate whether a tool exposed by an MCP server is permitted under its whitelist/blacklist filters.
 */
export function isMcpToolPermitted(
  server: Pick<ResolvedMcpServerConfig, "allowedTools" | "disabledTools">,
  toolName: string,
): boolean {
  if (server.disabledTools.includes(toolName)) {
    return false;
  }
  if (server.allowedTools.length > 0) {
    return server.allowedTools.includes(toolName);
  }
  return true;
}

/**
 * Build explicit non-leaky env overrides for a stdio MCP server from static `env`,
 * `env_refs` (`TARGET_VAR = "SECRET_ENV"`), and `env_passthrough` (`["SECRET_ENV"]`).
 */
export function resolveMcpServerEnv(server: ResolvedMcpServerConfig): Record<string, string> {
  const out: Record<string, string> = { ...server.env };
  for (const envName of server.envPassthrough) {
    const secret = getOptionalSecret(envName);
    if (secret !== undefined) {
      out[envName] = secret;
    }
  }
  for (const [targetKey, secretEnvName] of Object.entries(server.envRefs)) {
    const secret = getOptionalSecret(secretEnvName);
    if (secret !== undefined) {
      out[targetKey] = secret;
    }
  }
  return out;
}

/**
 * Build HTTP headers for a remote MCP server, resolving `bearer_token_env` when configured.
 */
export function resolveMcpHttpHeaders(server: ResolvedMcpServerConfig): Record<string, string> {
  const headers: Record<string, string> = { ...server.headers };
  if (server.bearerTokenEnv && !headers.Authorization && !headers.authorization) {
    const token = getOptionalSecret(server.bearerTokenEnv);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
}
