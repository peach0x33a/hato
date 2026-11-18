import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpToolDefinition } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import {
  isMcpToolPermitted,
  resolveMcpHttpHeaders,
  resolveMcpServerEntries,
  resolveMcpServerEnv,
  type McpConfig,
  type McpZone,
  type ResolvedMcpServerConfig,
} from "../config/mcp.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { logInfo, logWarn, summarizeError } from "../utils/logger.js";

export interface McpServerRuntimeStatus {
  name: string;
  zone: McpZone;
  transport: "stdio" | "http";
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  exposedToolCount: number;
  lastError?: string;
}

export interface WorkerMcpToolsOptions {
  onConfirmRequired?: (params: {
    serverName: string;
    toolName: string;
    args: unknown;
  }) => Promise<boolean>;
}

interface ConnectedServerEntry {
  config: ResolvedMcpServerConfig;
  signature: string;
  client: Client;
  transport: Transport;
  tools: McpToolDefinition[];
  stderrTail: string[];
}

const MAX_STDERR_TAIL_LINES = 20;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Lightweight host-side MCP client pool supporting zone-isolated `personal` and `worker` tool exposure
 * for `@earendil-works/pi-agent-core` agents without building an external CLI proxy gateway.
 */
export class McpClientPool {
  private servers = new Map<string, ResolvedMcpServerConfig>();
  private connected = new Map<string, ConnectedServerEntry>();
  private lastErrors = new Map<string, string>();
  private inFlightConnects = new Map<string, Promise<ConnectedServerEntry | null>>();

  constructor(private readonly proxyRouter?: ScopedProxyRouter) {}

  /**
   * Reconcile pool state against a reloaded `McpConfig`.
   * Preserves unchanged active connections to avoid breaking Persona tool schema caches,
   * while closing removed, disabled, or modified servers.
   */
  async syncConfig(
    config: McpConfig,
    options?: {
      eagerZones?: readonly McpZone[];
    },
  ): Promise<void> {
    const entries = resolveMcpServerEntries(config);
    const nextServers = new Map(entries.map((entry) => [entry.name, entry]));
    const eagerZones = new Set<McpZone>(options?.eagerZones ?? ["personal"]);

    const toClose: string[] = [];
    for (const [name, current] of this.connected.entries()) {
      const next = nextServers.get(name);
      if (!next || !next.enabled || buildServerSignature(next) !== current.signature) {
        toClose.push(name);
      }
    }

    await Promise.all(toClose.map((name) => this.disconnectServer(name)));

    for (const name of [...this.lastErrors.keys()]) {
      const next = nextServers.get(name);
      if (!next || !next.enabled) {
        this.lastErrors.delete(name);
      }
    }

    this.servers = nextServers;

    const eagerTargets = entries.filter((entry) => entry.enabled && eagerZones.has(entry.zone));
    await Promise.all(eagerTargets.map((entry) => this.ensureConnected(entry.name)));
  }

  /**
   * Return `AgentTool[]` for all connected & enabled servers belonging to the requested zone.
   */
  getToolsForZone(zone: McpZone): AgentTool<any>[] {
    if (zone !== "personal") {
      throw new Error(
        `Zone "${zone}" tools must be requested via getToolsForWorker() with an explicit server allowlist.`,
      );
    }

    const tools: AgentTool<any>[] = [];
    for (const name of [...this.servers.keys()].sort()) {
      const server = this.servers.get(name);
      const entry = this.connected.get(name);
      if (!server || !server.enabled || server.zone !== "personal" || !entry) continue;

      for (const mcpTool of entry.tools) {
        if (!isMcpToolPermitted(server, mcpTool.name)) continue;
        tools.push(this.wrapMcpTool(server, mcpTool));
      }
    }
    return tools;
  }

  /**
   * Connect (lazily) and return `AgentTool[]` for explicitly authorized `worker` zone servers.
   */
  async getToolsForWorker(
    allowedServers: readonly string[],
    options?: WorkerMcpToolsOptions,
  ): Promise<AgentTool<any>[]> {
    const requested = [...new Set(allowedServers.map((s) => s.trim()).filter(Boolean))].sort();
    const tools: AgentTool<any>[] = [];

    for (const serverName of requested) {
      const server = this.servers.get(serverName);
      if (!server || !server.enabled || server.zone !== "worker") continue;
      const entry = await this.ensureConnected(serverName);
      if (!entry) continue;

      for (const mcpTool of entry.tools) {
        if (!isMcpToolPermitted(server, mcpTool.name)) continue;
        tools.push(this.wrapMcpTool(server, mcpTool, options));
      }
    }

    return tools;
  }

  /**
   * List runtime status for every configured MCP server (without exposing secrets).
   */
  getStatus(): McpServerRuntimeStatus[] {
    return [...this.servers.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((server) => {
        const entry = this.connected.get(server.name);
        const toolCount = entry?.tools.length ?? 0;
        const exposedToolCount = entry
          ? entry.tools.filter((t) => isMcpToolPermitted(server, t.name)).length
          : 0;
        return {
          name: server.name,
          zone: server.zone,
          transport: server.transport,
          enabled: server.enabled,
          connected: Boolean(entry),
          toolCount,
          exposedToolCount,
          lastError: this.lastErrors.get(server.name),
        };
      });
  }

  /**
   * Gracefully disconnect all active MCP clients and child processes.
   */
  async closeAll(): Promise<void> {
    const names = [...this.connected.keys()];
    await Promise.all(names.map((name) => this.disconnectServer(name)));
  }

  private async ensureConnected(name: string): Promise<ConnectedServerEntry | null> {
    const server = this.servers.get(name);
    if (!server || !server.enabled) return null;

    const existing = this.connected.get(name);
    if (existing && existing.signature === buildServerSignature(server)) {
      return existing;
    }

    const pending = this.inFlightConnects.get(name);
    if (pending) return pending;

    const connectPromise = this.connectServer(server).finally(() => {
      this.inFlightConnects.delete(name);
    });
    this.inFlightConnects.set(name, connectPromise);
    return connectPromise;
  }

  private async connectServer(server: ResolvedMcpServerConfig): Promise<ConnectedServerEntry | null> {
    if (this.connected.has(server.name)) {
      await this.disconnectServer(server.name);
    }

    const signature = buildServerSignature(server);
    const stderrTail: string[] = [];

    try {
      const { client, transport } = await this.openClientTransport(server, stderrTail);
      const listRes = await withTimeout(
        client.listTools(),
        server.timeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
        `MCP "${server.name}" listTools`,
      );
      const tools = [...(listRes.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name));

      const entry: ConnectedServerEntry = {
        config: server,
        signature,
        client,
        transport,
        tools,
        stderrTail,
      };
      this.connected.set(server.name, entry);
      this.lastErrors.delete(server.name);
      logInfo(
        "MCP",
        `connected ${server.zone}:${server.name} (${server.transport}) -> ${tools.length} tool(s)`,
      );
      return entry;
    } catch (err) {
      const tailSuffix = stderrTail.length > 0 ? ` | stderr: ${stderrTail.slice(-3).join(" / ")}` : "";
      const message = `${summarizeError(err)}${tailSuffix}`;
      this.lastErrors.set(server.name, message);
      logWarn("MCP", `failed to connect ${server.zone}:${server.name}: ${message}`);
      return null;
    }
  }

  private async openClientTransport(
    server: ResolvedMcpServerConfig,
    stderrTail: string[],
  ): Promise<{ client: Client; transport: Transport }> {
    if (server.transport === "stdio") {
      if (!server.command) {
        throw new Error(`stdio MCP "${server.name}" missing command`);
      }
      const env = {
        ...getDefaultEnvironment(),
        ...resolveMcpServerEnv(server),
      };
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env,
        stderr: "pipe",
      });

      const stderrStream = transport.stderr;
      if (stderrStream) {
        stderrStream.on("data", (chunk: Buffer | string) => {
          const text = String(chunk).trim();
          if (!text) return;
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            stderrTail.push(line.trim());
            if (stderrTail.length > MAX_STDERR_TAIL_LINES) {
              stderrTail.shift();
            }
          }
        });
      }

      const client = new Client({ name: "hato-mcp-client", version: "0.1.0" }, { capabilities: {} });
      await withTimeout(
        client.connect(transport),
        server.timeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
        `MCP "${server.name}" stdio connect`,
      );
      return { client, transport };
    }

    if (!server.url) {
      throw new Error(`http MCP "${server.name}" missing url`);
    }

    const url = new URL(server.url);
    const headers = resolveMcpHttpHeaders(server);
    const scopedFetch = this.proxyRouter
      ? this.proxyRouter.createScopedFetch(server.proxyScope)
      : globalThis.fetch;

    const streamableTransport = new StreamableHTTPClientTransport(url, {
      fetch: scopedFetch,
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
    const streamableClient = new Client(
      { name: "hato-mcp-client", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await withTimeout(
        streamableClient.connect(streamableTransport),
        server.timeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
        `MCP "${server.name}" HTTP connect`,
      );
      return { client: streamableClient, transport: streamableTransport };
    } catch (streamableErr) {
      await streamableClient.close().catch(() => undefined);

      // Fall back to legacy SSE transport when a remote MCP endpoint does not speak Streamable HTTP.
      const sseTransport = new SSEClientTransport(url, {
        fetch: scopedFetch,
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
      const sseClient = new Client(
        { name: "hato-mcp-client", version: "0.1.0" },
        { capabilities: {} },
      );
      try {
        await withTimeout(
          sseClient.connect(sseTransport),
          server.timeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
          `MCP "${server.name}" SSE connect`,
        );
        return { client: sseClient, transport: sseTransport };
      } catch {
        await sseClient.close().catch(() => undefined);
        throw streamableErr;
      }
    }
  }

  private async disconnectServer(name: string): Promise<void> {
    const entry = this.connected.get(name);
    if (!entry) return;
    this.connected.delete(name);
    await entry.client.close().catch(() => undefined);
  }

  private wrapMcpTool(
    server: ResolvedMcpServerConfig,
    mcpTool: McpToolDefinition,
    workerOptions?: WorkerMcpToolsOptions,
  ): AgentTool<TSchema> {
    const namespacedName = formatMcpToolName(server.name, mcpTool.name);
    const parameters = normalizeMcpInputSchema(mcpTool.inputSchema) as unknown as TSchema;
    const requiresConfirm =
      server.zone === "worker" && server.confirmTools.includes(mcpTool.name);

    return {
      name: namespacedName,
      label: `${server.name}:${mcpTool.name}`,
      description:
        mcpTool.description?.trim() ||
        `MCP tool "${mcpTool.name}" from server "${server.name}".`,
      parameters,
      execute: async (_toolCallId, input, signal) => {
        if (requiresConfirm && workerOptions?.onConfirmRequired) {
          const approved = await workerOptions.onConfirmRequired({
            serverName: server.name,
            toolName: mcpTool.name,
            args: input,
          });
          if (!approved) {
            throw new Error(
              `工具调用 "${server.name}:${mcpTool.name}" 需要用户确认，当前未获批准。`,
            );
          }
        }

        const entry = await this.ensureConnected(server.name);
        if (!entry) {
          throw new Error(`MCP 服务 "${server.name}" 当前不可用。`);
        }

        const args =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};

        const result = await withTimeout(
          entry.client.callTool(
            {
              name: mcpTool.name,
              arguments: args,
            },
            undefined,
            {
              signal,
              timeout: server.timeoutMs,
            },
          ),
          server.timeoutMs + 1000,
          `MCP tool "${server.name}:${mcpTool.name}"`,
        );

        const formatted = formatMcpCallResult(result);
        if (result.isError) {
          const msg = formatted.content
            .filter((b): b is TextContent => b.type === "text")
            .map((b) => b.text)
            .join("\n") || "MCP tool returned an error";
          throw new Error(msg);
        }
        return formatted;
      },
    };
  }
}

export function formatMcpToolName(serverName: string, toolName: string): string {
  const clean = (raw: string) =>
    raw
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "tool";
  return `mcp__${clean(serverName)}__${clean(toolName)}`.slice(0, 64);
}

export function normalizeMcpInputSchema(
  schema: McpToolDefinition["inputSchema"] | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const copy: Record<string, unknown> = { ...schema };
  if (!copy.type) {
    copy.type = "object";
  }
  if (copy.type === "object" && (!copy.properties || typeof copy.properties !== "object")) {
    copy.properties = {};
  }
  return copy;
}

function formatMcpCallResult(raw: Awaited<ReturnType<Client["callTool"]>>): AgentToolResult<unknown> {
  const content: (TextContent | ImageContent)[] = [];

  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string") {
        content.push({ type: "text", text: item.text });
      } else if (
        item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string"
      ) {
        content.push({
          type: "image",
          data: item.data,
          mimeType: item.mimeType,
        });
      } else if (item.type === "resource" && item.resource && typeof item.resource === "object") {
        const resObj = item.resource as { uri?: string; text?: string };
        const text = resObj.text ?? JSON.stringify(item.resource);
        content.push({
          type: "text",
          text: resObj.uri ? `[resource: ${resObj.uri}]\n${text}` : text,
        });
      } else {
        content.push({ type: "text", text: JSON.stringify(item) });
      }
    }
  }

  if (content.length === 0 && raw.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(raw.structuredContent, null, 2) });
  }
  if (content.length === 0 && raw.toolResult !== undefined) {
    content.push({ type: "text", text: JSON.stringify(raw.toolResult, null, 2) });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "(MCP tool completed with empty output)" });
  }

  return {
    content,
    details: {
      isError: Boolean(raw.isError),
      structuredContent: raw.structuredContent,
    },
  };
}

function buildServerSignature(server: ResolvedMcpServerConfig): string {
  return JSON.stringify({
    zone: server.zone,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: resolveMcpServerEnv(server),
    url: server.url,
    headers: resolveMcpHttpHeaders(server),
    proxyScope: server.proxyScope,
    allowedTools: server.allowedTools,
    disabledTools: server.disabledTools,
    confirmTools: server.confirmTools,
    timeoutMs: server.timeoutMs,
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
