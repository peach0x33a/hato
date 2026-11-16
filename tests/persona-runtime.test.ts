import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { loadHatoConfig } from "../src/config/app.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { PersonaRuntime } from "../src/persona/agent.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("PersonaRuntime runs pi-agent-core tool loop, scoped proxy context, bubbles, and warm compaction", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-1", name: "Faux Persona" }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-test-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");

  writeHatoConfig(hatoTomlPath, createDefaultHatoConfig(), { backup: false });
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

  const dbHandle = openDatabase(":memory:");
  try {
    const hatoConfig = loadHatoConfig(hatoTomlPath);
    const repo = new HatoRepository(dbHandle.db);
    const modelRegistry = new ModelRegistry(modelsTomlPath, repo, {
      extraProviders: [faux.provider],
    });
    const proxyRouter = new ScopedProxyRouter(hatoConfig.network?.proxies ?? []);
    const runtime = new PersonaRuntime(hatoConfig, modelRegistry, proxyRouter, repo);

    let observedScope = "";
    let observedPromptHasTime = false;

    faux.setResponses([
      (ctx) => {
        observedScope = proxyRouter.getCurrentScope();
        const lastMsg = ctx.messages[ctx.messages.length - 1];
        if (lastMsg && lastMsg.role === "user" && typeof lastMsg.content === "string") {
          observedPromptHasTime = lastMsg.content.includes("<time>") && lastMsg.content.includes("现在:");
        }
        return fauxAssistantMessage([fauxToolCall("calc", { expression: "356 * 24" })], {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        const lastToolResult = ctx.messages[ctx.messages.length - 1];
        assert.equal(lastToolResult?.role, "toolResult");
        return fauxAssistantMessage("帮你想好了\n---\n356 * 24 = 8544 呀");
      },
      () => fauxAssistantMessage("用户询问了乘法计算，助手已给出结果 8544。"),
    ]);

    const out = await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123456789",
      platformMsgIds: ["m100"],
      latestPlatformMsgId: "m100",
      combinedText: "帮我算下 356 * 24",
      attachments: [],
      firstTimestampMs: Date.now(),
      lastTimestampMs: Date.now(),
    });

    assert.equal(observedScope, "llm-calling.faux-provider");
    assert.equal(observedPromptHasTime, true);
    assert.deepEqual(out.toolCalls, ["calc"]);
    assert.deepEqual(out.bubbles, ["帮你想好了", "356 * 24 = 8544 呀"]);
    assert.equal(typeof out.ttftMs, "number");
    assert.ok(out.ttftMs >= 0);

    const trace = repo.getLatestTurnTrace("owner");
    assert.ok(trace);
    assert.equal(trace.provider, "faux-provider");
    assert.equal(trace.userPreview, "帮我算下 356 * 24");
    assert.equal(typeof trace.ttftMs, "number");
    assert.equal(typeof trace.cacheHitRate, "number");
    assert.ok(trace.timeCardText.includes("<time>"));
    assert.ok(JSON.parse(trace.toolCallsJson).includes("calc"));

    const hot = repo.getHotMessages("owner", 0);
    assert.equal(hot.length, 2);

    const summary = await runtime.summarizeBlockWithWarmPrefix({
      canonicalUserId: "owner",
      previousSummary: "",
      messagesToSummarize: hot,
    });
    assert.equal(summary, "用户询问了乘法计算，助手已给出结果 8544。");

    // Simulate /new clearing both rolled summary and hot messages, even if next Telegram
    // message carries a 1-second-truncated timestamp slightly <= reset cutoff.
    repo.commitCompaction({
      canonicalUserId: "owner",
      summaryText: summary,
      compactedUntilMsgId: hot[0]!.id,
      compactedUntilTs: hot[0]!.createdAt,
    });
    const resetResult = repo.resetWorkingContext("owner");
    assert.equal(resetResult.clearedHotMessages, 1);
    assert.equal(resetResult.hadSummary, true);
    runtime.resetSession();

    assert.equal(repo.getWorkingMemory("owner").summaryText, "");
    assert.equal(repo.getLastUserMessage("owner"), null);

    let newTurnRoles: string[] = [];
    let sawOldMessage = false;
    faux.setResponses([
      (ctx) => {
        newTurnRoles = ctx.messages.map((m) => m.role);
        sawOldMessage = ctx.messages.some(
          (m) => typeof m.content === "string" && (m.content.includes("356 * 24") || m.content.includes("前情对话滚动摘要")),
        );
        return fauxAssistantMessage("开启全新对话啦");
      },
    ]);

    const afterNewOut = await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123456789",
      platformMsgIds: ["m101"],
      latestPlatformMsgId: "m101",
      combinedText: "重新聊聊",
      attachments: [],
      firstTimestampMs: Date.now() - 900,
      lastTimestampMs: Date.now() - 900,
    });
    assert.equal(afterNewOut.rawText, "开启全新对话啦");
    assert.equal(sawOldMessage, false);
    assert.deepEqual(newTurnRoles, ["system", "user"]);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
