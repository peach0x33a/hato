import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { loadHatoConfig } from "../src/config/app.js";
import { loadMcpConfig } from "../src/config/mcp.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { McpClientPool } from "../src/mcp/pool.js";
import { PersonaRuntime } from "../src/persona/agent.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("PersonaRuntime exposes personal skills (Layer 1 index + read_skill) and personal MCP while isolating worker zone", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-1", name: "Faux Persona" }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-persona-zone-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");
  const mcpTomlPath = join(tempDir, "mcp.toml");
  const skillsDir = join(tempDir, "skills");
  const serverScript = join(tempDir, "echo-mcp.mjs");

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
const server = new Server({ name: "zone-" + mode, version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: mode === "personal" ? "echo_note" : "deploy_prod",
      description: "Test tool for " + mode,
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: mode + ":" + req.params.name + ":" + String(req.params.arguments?.text ?? "") }]
}));

await server.connect(new StdioServerTransport());
`,
    "utf8",
  );

  mkdirSync(join(skillsDir, "personal", "coffee-log"), { recursive: true });
  mkdirSync(join(skillsDir, "worker", "k8s-rollout"), { recursive: true });

  writeFileSync(
    join(skillsDir, "personal", "coffee-log", "SKILL.md"),
    `---\nname: coffee-log\ndescription: Record daily coffee intake notes\n---\nAlways ask roast preference if omitted.`,
    "utf8",
  );
  writeFileSync(
    join(skillsDir, "worker", "k8s-rollout", "SKILL.md"),
    `---\nname: k8s-rollout\ndescription: Manage Kubernetes production rollouts\n---\nSecret worker ops.`,
    "utf8",
  );

  const cfgObj = createDefaultHatoConfig();
  cfgObj.paths.skills_dir = skillsDir;
  writeHatoConfig(hatoTomlPath, cfgObj, { backup: false });

  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-persona-1"
router = "faux-provider/faux-persona-1"
curator = "faux-provider/faux-persona-1"
worker = "faux-provider/faux-persona-1"
hindsight_llm = "faux-provider/faux-persona-1"

[providers]
`,
    "utf8",
  );

  writeFileSync(
    mcpTomlPath,
    `
[servers.personal_svc]
zone = "personal"
transport = "stdio"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(serverScript)}, "personal"]

[servers.worker_svc]
zone = "worker"
transport = "stdio"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(serverScript)}, "worker"]
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  const mcpPool = new McpClientPool();

  try {
    const hatoConfig = loadHatoConfig(hatoTomlPath);
    await mcpPool.syncConfig(loadMcpConfig(mcpTomlPath), { eagerZones: ["personal"] });
    const repo = new HatoRepository(dbHandle.db);
    const modelRegistry = new ModelRegistry(modelsTomlPath, repo, {
      extraProviders: [faux.provider],
    });
    const proxyRouter = new ScopedProxyRouter(hatoConfig.network?.proxies ?? []);
    const runtime = new PersonaRuntime(
      hatoConfig,
      modelRegistry,
      proxyRouter,
      repo,
      undefined,
      null,
      hatoTomlPath,
      mcpPool,
    );

    let observedSystemPrompt = "";
    let observedToolNames: string[] = [];

    faux.setResponses([
      (ctx) => {
        const sysMsg = ctx.messages.find((m) => m.role === "system") as
          | { role: "system"; content?: string; toolsAdded?: Array<{ name: string }> }
          | undefined;
        observedSystemPrompt =
          typeof sysMsg?.content === "string" ? sysMsg.content : ctx.systemPrompt ?? "";
        observedToolNames = (sysMsg?.toolsAdded ?? ctx.tools ?? []).map((t) => t.name);
        return fauxAssistantMessage([fauxToolCall("read_skill", { name: "coffee-log" })], {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        const last = ctx.messages[ctx.messages.length - 1];
        assert.equal(last?.role, "toolResult");
        return fauxAssistantMessage(
          [fauxToolCall("mcp__personal_svc__echo_note", { text: "oat latte" })],
          { stopReason: "toolUse" },
        );
      },
      (ctx) => {
        const last = ctx.messages[ctx.messages.length - 1];
        assert.equal(last?.role, "toolResult");
        return fauxAssistantMessage("记好啦，今天喝了燕麦拿铁。");
      },
    ]);

    const now = Date.now();
    const out = await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123456",
      platformMsgIds: ["m_skill_1"],
      latestPlatformMsgId: "m_skill_1",
      combinedText: "帮我记一下今天喝了燕麦拿铁",
      attachments: [],
      firstTimestampMs: now,
      lastTimestampMs: now,
    });

    assert.match(observedSystemPrompt, /<available_skills>/);
    assert.match(observedSystemPrompt, /coffee-log: Record daily coffee intake notes/);
    assert.doesNotMatch(observedSystemPrompt, /k8s-rollout/);

    assert.equal(observedToolNames.includes("read_skill"), true);
    assert.equal(observedToolNames.includes("mcp__personal_svc__echo_note"), true);
    assert.equal(observedToolNames.includes("mcp__worker_svc__deploy_prod"), false);

    assert.deepEqual(out.toolCalls, ["read_skill", "mcp__personal_svc__echo_note"]);
    assert.match(out.rawText, /燕麦拿铁/);
  } finally {
    await mcpPool.closeAll();
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
