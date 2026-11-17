import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadMcpConfig } from "../src/config/mcp.js";
import { McpClientPool } from "../src/mcp/pool.js";

test("McpClientPool isolates personal vs worker stdio servers, filters tools, and enforces confirm_tools", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-mcp-pool-"));
  const serverScript = join(tempDir, "mock-mcp-server.mjs");
  const sdkServerIndex = resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js");
  const sdkServerStdio = resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js");
  const sdkTypes = resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/types.js");

  writeFileSync(
    serverScript,
    `
import { Server } from ${JSON.stringify(sdkServerIndex)};
import { StdioServerTransport } from ${JSON.stringify(sdkServerStdio)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkTypes)};

const mode = process.argv[2] || "personal";
const server = new Server({ name: "mock-" + mode, version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (mode === "personal") {
    return {
      tools: [
        {
          name: "ping_personal",
          description: "Ping personal server",
          inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] }
        },
        {
          name: "blocked_secret_tool",
          description: "Should be filtered out",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    };
  }
  return {
    tools: [
      {
        name: "run_job",
        description: "Execute worker action",
        inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments || {};
  return {
    content: [{ type: "text", text: mode + ":" + req.params.name + ":" + JSON.stringify(args) }]
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`,
    "utf8",
  );

  const mcpToml = join(tempDir, "mcp.toml");
  writeFileSync(
    mcpToml,
    `
[servers.notes]
zone = "personal"
transport = "stdio"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(serverScript)}, "personal"]
allowed_tools = ["ping_personal"]

[servers.runner]
zone = "worker"
transport = "stdio"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(serverScript)}, "worker"]
confirm_tools = ["run_job"]
`,
    "utf8",
  );

  const pool = new McpClientPool();
  try {
    const cfg = loadMcpConfig(mcpToml);
    await pool.syncConfig(cfg, { eagerZones: ["personal"] });

    // Personal server is connected eagerly; worker server remains lazy until requested.
    const statusBeforeWorker = pool.getStatus();
    assert.equal(statusBeforeWorker.find((s) => s.name === "notes")?.connected, true);
    assert.equal(statusBeforeWorker.find((s) => s.name === "notes")?.exposedToolCount, 1);
    assert.equal(statusBeforeWorker.find((s) => s.name === "runner")?.connected, false);

    const personalTools = pool.getToolsForZone("personal");
    assert.deepEqual(
      personalTools.map((t) => t.name),
      ["mcp__notes__ping_personal"],
    );
    assert.throws(() => pool.getToolsForZone("worker"), /getToolsForWorker/);

    const pingResult = await personalTools[0]!.execute("call_1", { msg: "hi" });
    assert.equal(
      (pingResult.content[0] as { type: "text"; text: string }).text,
      'personal:ping_personal:{"msg":"hi"}',
    );

    // Worker tools connect lazily only for allowed servers and enforce confirm_tools
    const confirmCalls: string[] = [];
    const deniedTools = await pool.getToolsForWorker(["runner"], {
      onConfirmRequired: async ({ serverName, toolName }) => {
        confirmCalls.push(`${serverName}:${toolName}:deny`);
        return false;
      },
    });
    assert.deepEqual(
      deniedTools.map((t) => t.name),
      ["mcp__runner__run_job"],
    );
    await assert.rejects(
      () => deniedTools[0]!.execute("call_2", { target: "prod" }),
      /需要用户确认/,
    );

    const approvedTools = await pool.getToolsForWorker(["runner"], {
      onConfirmRequired: async ({ serverName, toolName }) => {
        confirmCalls.push(`${serverName}:${toolName}:allow`);
        return true;
      },
    });
    const workerResult = await approvedTools[0]!.execute("call_3", { target: "staging" });
    assert.equal(
      (workerResult.content[0] as { type: "text"; text: string }).text,
      'worker:run_job:{"target":"staging"}',
    );
    assert.deepEqual(confirmCalls, ["runner:run_job:deny", "runner:run_job:allow"]);
  } finally {
    await pool.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
