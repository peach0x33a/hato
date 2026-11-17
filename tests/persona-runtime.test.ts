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
    assert.ok(resetResult.archivedSessionId);
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

    // Verify LLM can explicitly recall archived messages from past sessions using search_past_sessions
    let recalledSessionSnippet = "";
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("search_past_sessions", { query: "356 * 24" })], { stopReason: "toolUse" }),
      (ctx) => {
        const toolRes = ctx.messages.find((m) => m.role === "toolResult");
        if (toolRes && Array.isArray(toolRes.content)) {
          recalledSessionSnippet = toolRes.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n");
        }
        return fauxAssistantMessage("我在上次归档会话里找到了，当时算过 356 * 24 = 8544");
      },
    ]);

    const recallOut = await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123456789",
      platformMsgIds: ["m101b"],
      latestPlatformMsgId: "m101b",
      combinedText: "我上个会话问过啥乘法来着",
      attachments: [],
      firstTimestampMs: Date.now() - 800,
      lastTimestampMs: Date.now() - 800,
    });
    assert.ok(recallOut.toolCalls.includes("search_past_sessions"));
    assert.match(recalledSessionSnippet, /356 \* 24/);
    assert.match(recalledSessionSnippet, new RegExp(resetResult.archivedSessionId!));

    // Verify pre-tool immediate reply behavior:
    // 1) Model-provided text before toolUse is flushed once per turn, even across chained tool calls.
    const timeline: string[] = [];
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [{ type: "text", text: "好~我去算算看" }, fauxToolCall("calc", { expression: "10 + 5" })],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage([fauxToolCall("calc", { expression: "15 + 1" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("算出来是 16 呀"),
      // 2) Bare fast toolCall (calc) does not spam a synthetic pre-tool ack.
      () => fauxAssistantMessage([fauxToolCall("calc", { expression: "20 + 2" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("22 呀"),
    ]);

    const preReplyTurn1 = await runtime.handleUserBatch(
      {
        canonicalUserId: "owner",
        originChannel: "tg",
        originPlatformUserId: "123456789",
        platformMsgIds: ["m102"],
        latestPlatformMsgId: "m102",
        combinedText: "10 加 5 再加 1 等于几",
        attachments: [],
        firstTimestampMs: Date.now(),
        lastTimestampMs: Date.now(),
      },
      [],
      {
        sendBubblesToUser: async (early) => {
          timeline.push(`early:${early.join("|")}`);
        },
      },
    );
    assert.deepEqual(preReplyTurn1.earlyBubbles, ["好~我去算算看"]);
    assert.deepEqual(preReplyTurn1.bubbles, ["算出来是 16 呀"]);
    assert.deepEqual(timeline, ["early:好~我去算算看"]);

    const bareTimeline: string[] = [];
    const preReplyTurn2 = await runtime.handleUserBatch(
      {
        canonicalUserId: "owner",
        originChannel: "tg",
        originPlatformUserId: "123456789",
        platformMsgIds: ["m103"],
        latestPlatformMsgId: "m103",
        combinedText: "20 加 2 呢",
        attachments: [],
        firstTimestampMs: Date.now() + 10,
        lastTimestampMs: Date.now() + 10,
      },
      [],
      {
        sendBubblesToUser: async (early) => {
          bareTimeline.push(...early);
        },
      },
    );
    assert.deepEqual(bareTimeline, []);
    assert.deepEqual(preReplyTurn2.earlyBubbles, []);
    assert.deepEqual(preReplyTurn2.bubbles, ["22 呀"]);

    // 3) Supersede behavior: if a newer user message arrives while LLM is generating (before reply is sent),
    // keep the earlier user message, suppress the stale reply, and re-think with both messages.
    let newerPending = false;
    let rethoughtPromptText = "";
    const sentFollowup: string[] = [];
    faux.setResponses([
      () => {
        newerPending = true;
        return fauxAssistantMessage("这是会被拦截的旧回复");
      },
      (ctx) => {
        const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user");
        if (lastUser && typeof lastUser.content === "string") {
          rethoughtPromptText = lastUser.content;
        }
        return fauxAssistantMessage("收到啦，明天早上八点准时睡");
      },
    ]);

    const supersededTurn = await runtime.handleUserBatch(
      {
        canonicalUserId: "owner",
        originChannel: "tg",
        originPlatformUserId: "123456789",
        platformMsgIds: ["m104"],
        latestPlatformMsgId: "m104",
        combinedText: "明天八点提醒我睡觉",
        attachments: [],
        firstTimestampMs: Date.now() + 20,
        lastTimestampMs: Date.now() + 20,
      },
      [],
      {
        shouldSuppressSend: () => newerPending,
        sendBubblesToUser: async (early) => {
          sentFollowup.push(...early);
        },
      },
    );
    assert.equal(supersededTurn.superseded, true);
    assert.deepEqual(supersededTurn.bubbles, []);
    assert.deepEqual(sentFollowup, []);

    // Now the newer message arrives after debounce; LLM sees BOTH user messages merged without stale assistant reply.
    newerPending = false;
    const rethoughtTurn = await runtime.handleUserBatch(
      {
        canonicalUserId: "owner",
        originChannel: "tg",
        originPlatformUserId: "123456789",
        platformMsgIds: ["m105"],
        latestPlatformMsgId: "m105",
        combinedText: "早上",
        attachments: [],
        firstTimestampMs: Date.now() + 30,
        lastTimestampMs: Date.now() + 30,
      },
      [],
      {
        shouldSuppressSend: () => newerPending,
      },
    );
    assert.equal(rethoughtTurn.superseded, false);
    assert.deepEqual(rethoughtTurn.bubbles, ["收到啦，明天早上八点准时睡"]);
    assert.match(rethoughtPromptText, /明天八点提醒我睡觉/);
    assert.match(rethoughtPromptText, /早上/);
    assert.equal(rethoughtPromptText.includes("这是会被拦截的旧回复"), false);

    // 4) Long-task steer behavior: during an active tool turn, new user messages steer into the live loop
    // without aborting the tool, and shouldSendAck ("知道了") is true only once per turn.
    let steerAckCount = 0;
    let sawSteeredMessagesInSecondLlmStep = false;
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [{ type: "text", text: "好，我算一下" }, fauxToolCall("calc", { expression: "100 + 20" })],
          { stopReason: "toolUse" },
        ),
      (ctx) => {
        const joinedUserText = ctx.messages
          .filter((m) => m.role === "user")
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .join("\n");
        sawSteeredMessagesInSecondLlmStep =
          joinedUserText.includes("顺便加 10") && joinedUserText.includes("还要再加 5");
        return fauxAssistantMessage("100+20=120，加上10和5总共是135");
      },
    ]);

    const hotBeforeSteer = repo.getHotMessages("owner", 0).length;
    const steerTurn = await runtime.handleUserBatch(
      {
        canonicalUserId: "owner",
        originChannel: "tg",
        originPlatformUserId: "123456789",
        platformMsgIds: ["m106"],
        latestPlatformMsgId: "m106",
        combinedText: "帮我算 100 + 20",
        attachments: [],
        firstTimestampMs: Date.now() + 40,
        lastTimestampMs: Date.now() + 40,
      },
      [],
      {
        sendBubblesToUser: async () => {
          // Simulate user sending two follow-up messages during the active tool step.
          const r1 = runtime.handleIncomingDuringActiveTurn({
            channel: "tg",
            platformUserId: "123456789",
            platformMsgId: "m107",
            canonicalUserId: "owner",
            text: "顺便加 10",
            attachments: [],
            timestampMs: Date.now() + 45,
          });
          assert.equal(r1.action, "steered");
          if (r1.action === "steered" && r1.shouldSendAck) steerAckCount++;

          const r2 = runtime.handleIncomingDuringActiveTurn({
            channel: "tg",
            platformUserId: "123456789",
            platformMsgId: "m108",
            canonicalUserId: "owner",
            text: "还要再加 5",
            attachments: [],
            timestampMs: Date.now() + 46,
          });
          assert.equal(r2.action, "steered");
          assert.equal(r2.shouldSendAck, false);
          if (r2.action === "steered" && r2.shouldSendAck) steerAckCount++;
        },
      },
    );
    assert.equal(steerTurn.superseded, false);
    assert.equal(steerAckCount, 1);
    assert.equal(sawSteeredMessagesInSecondLlmStep, true);
    assert.deepEqual(steerTurn.bubbles, ["100+20=120，加上10和5总共是135"]);
    // M1 ("帮我算 100 + 20") + M2 ("顺便加 10") + M3 ("还要再加 5") + unified assistant reply = +4 rows
    assert.equal(repo.getHotMessages("owner", 0).length, hotBeforeSteer + 4);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
