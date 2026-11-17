import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../db/client.js";
import { HatoRepository } from "../db/repo.js";
import {
  expandEarlierContext,
  readTaskContext,
  type ContextLookbackLimits,
} from "../dispatch/context-slice.js";

/**
 * Create a scoped read-only MCP Server exposing `read_task_context` and `expand_earlier_context`
 * locked to a single `allowedContextId`.
 */
export function createScopedContextMcpServer(params: {
  repo: HatoRepository;
  allowedContextId: string;
  timezone?: string;
  lookback?: ContextLookbackLimits;
}): Server {
  const lookback: ContextLookbackLimits = params.lookback ?? {
    maxStepCount: 10,
    maxTotalMessages: 20,
    maxHours: 24,
  };
  let lookedBackTotal = 0;

  const server = new Server(
    { name: "hato-context", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_task_context",
        description:
          "Read the verbatim conversation slice and attachment paths bound to your assigned context_id.",
        inputSchema: {
          type: "object",
          properties: {
            context_id: {
              type: "string",
              description: "Scoped context_id assigned to this ticket",
            },
          },
          required: ["context_id"],
        },
      },
      {
        name: "expand_earlier_context",
        description:
          "Read a limited number of earlier messages prior to the initial slice when references are missing.",
        inputSchema: {
          type: "object",
          properties: {
            context_id: {
              type: "string",
              description: "Scoped context_id assigned to this ticket",
            },
            count: {
              type: "number",
              description: `Number of earlier messages to fetch (max ${lookback.maxStepCount} per call)`,
            },
          },
          required: ["context_id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const requestedCtxId = typeof args.context_id === "string" ? args.context_id.trim() : "";

    if (!requestedCtxId || requestedCtxId !== params.allowedContextId) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `拒绝访问：仅允许读取当前工单签发的 context_id="${params.allowedContextId}"。`,
          },
        ],
      };
    }

    if (request.params.name === "read_task_context") {
      const slice = readTaskContext({
        repo: params.repo,
        contextId: requestedCtxId,
        timezone: params.timezone,
        lookback,
      });
      return {
        content: [{ type: "text", text: slice.formattedText }],
      };
    }

    if (request.params.name === "expand_earlier_context") {
      const count = typeof args.count === "number" ? args.count : lookback.maxStepCount;
      const expanded = expandEarlierContext({
        repo: params.repo,
        contextId: requestedCtxId,
        count,
        alreadyLookedBack: lookedBackTotal,
        timezone: params.timezone,
        lookback,
      });
      lookedBackTotal += expanded.messages.length;
      return {
        content: [{ type: "text", text: expanded.formattedText }],
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `未知上下文工具: ${request.params.name}` }],
    };
  });

  return server;
}

async function runCliEntrypoint(): Promise<void> {
  const dbPath = process.env.HATO_DB_PATH?.trim();
  const contextId = process.env.HATO_CONTEXT_ID?.trim();
  const timezone = process.env.HATO_TIMEZONE?.trim() || "UTC";

  if (!dbPath || !contextId) {
    throw new Error("HATO_DB_PATH and HATO_CONTEXT_ID environment variables are required");
  }

  let lookback: ContextLookbackLimits = {
    maxStepCount: 10,
    maxTotalMessages: 20,
    maxHours: 24,
  };
  if (process.env.HATO_LOOKBACK_JSON) {
    try {
      const parsed = JSON.parse(process.env.HATO_LOOKBACK_JSON) as Partial<ContextLookbackLimits>;
      lookback = {
        maxStepCount: Number(parsed.maxStepCount) || 10,
        maxTotalMessages: Number(parsed.maxTotalMessages) || 20,
        maxHours: Number(parsed.maxHours) || 24,
      };
    } catch {
      // keep safe defaults
    }
  }

  const dbHandle = openDatabase(dbPath);
  const repo = new HatoRepository(dbHandle.db);
  const server = createScopedContextMcpServer({
    repo,
    allowedContextId: contextId,
    timezone,
    lookback,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("context-server.ts") || process.argv[1].endsWith("context-server.js"));

if (invokedDirectly) {
  runCliEntrypoint().catch((err) => {
    process.stderr.write(
      `[hato-context-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
