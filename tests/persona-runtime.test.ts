import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
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
        if (lastMsg && lastMsg.role === "user") {
          const text =
            typeof lastMsg.content === "string"
              ? lastMsg.content
              : lastMsg.content
                  .filter((b): b is { type: "text"; text: string } => b.type === "text")
                  .map((b) => b.text)
                  .join("\n");
          observedPromptHasTime = text.includes("<time>") && text.includes("现在:");
        }
        return fauxAssistantMessage([fauxToolCall("calc", { expression: "356 * 24" })], {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        const lastToolResult = ctx.messages[ctx.messages.length - 1];
        assert.equal(lastToolResult?.role, "toolResult");
        return fauxAssistantMessage("帮你想好了\n[SPLIT]\n356 * 24 = 8544 呀");
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

    const summary = await runtime.summarizeCompactionBlock({
      canonicalUserId: "owner",
      previousSummary: "",
      messagesToSummarize: hot,
    });
    assert.equal(summary, "用户询问了乘法计算，助手已给出结果 8544。");

    const compactionTrace = repo.getLatestTurnTrace("owner");
    assert.ok(compactionTrace);
    assert.equal(compactionTrace.slot, "curator");
    assert.ok(compactionTrace.userPreview.startsWith("[上下文压缩]"));
    assert.ok(compactionTrace.timeCardText.includes("task: context_compaction"));
    assert.ok(compactionTrace.timeCardText.includes("compacted_messages: 2"));
    assert.ok(!compactionTrace.timeCardText.includes("warm_prefix_slot: persona"));

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
        if (lastUser) {
          rethoughtPromptText =
            typeof lastUser.content === "string"
              ? lastUser.content
              : lastUser.content
                  .filter((b): b is { type: "text"; text: string } => b.type === "text")
                  .map((b) => b.text)
                  .join("\n");
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
          .map((m) =>
            typeof m.content === "string"
              ? m.content
              : m.content
                  .filter((b): b is { type: "text"; text: string } => b.type === "text")
                  .map((b) => b.text)
                  .join("\n"),
          )
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

test("PersonaRuntime activates tools mid-turn, preserves multi-turn tool calls, prunes batch images, and adjusts thinking level", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-thinking", name: "Faux Thinking", reasoning: true }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-test-phase2-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");

  writeHatoConfig(hatoTomlPath, createDefaultHatoConfig(), { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-persona-thinking"
router = "faux-provider/faux-persona-thinking"
curator = "faux-provider/faux-persona-thinking"
worker = "faux-provider/faux-persona-thinking"
hindsight_llm = "faux-provider/faux-persona-thinking"

[providers]
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    const config = loadHatoConfig(hatoTomlPath);
    const registry = new ModelRegistry(modelsTomlPath, repo, {
      extraProviders: [faux.provider],
    });
    const proxyRouter = new ScopedProxyRouter(config.network?.proxies ?? []);
    const runtime = new PersonaRuntime(config, registry, proxyRouter, repo);

    // 1) Fixed full toolset: calc is immediately available on Step 1 without activate_tools
    let step1HasCalc = false;
    let step1ToolNames: string[] = [];
    faux.setResponses([
      (ctx) => {
        const tools = getCurrentTools(ctx.messages);
        step1ToolNames = tools.map((t) => t.name);
        step1HasCalc = tools.some((t) => t.name === "calc");
        return fauxAssistantMessage(
          [fauxToolCall("calc", { expression: "21 + 21" })],
          { stopReason: "toolUse" },
        );
      },
      () => fauxAssistantMessage("算出来是 42"),
    ]);

    const t1 = await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["m1"],
      latestPlatformMsgId: "m1",
      combinedText: "帮我看一下那个东西",
      attachments: [],
      firstTimestampMs: Date.now(),
      lastTimestampMs: Date.now(),
    });
    assert.equal(step1HasCalc, true);
    assert.equal(step1ToolNames.includes("activate_tools"), false);
    assert.deepEqual(t1.toolCalls, ["calc"]);
    assert.deepEqual(t1.bubbles, ["算出来是 42"]);

    // 2) Turn 2 keeps exact same fixed tools, preserves Turn 1 toolCall + toolResult blocks, and handles inline image
    let turn2ToolNames: string[] = [];
    let turn2SawPriorToolCalls = false;
    let turn2SawPriorToolResult = false;
    faux.setResponses([
      (ctx) => {
        turn2ToolNames = getCurrentTools(ctx.messages).map((t) => t.name);
        turn2SawPriorToolCalls = ctx.messages.some(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((c) => c.type === "toolCall" && c.name === "calc"),
        );
        turn2SawPriorToolResult = ctx.messages.some(
          (m) => m.role === "toolResult" && m.toolName === "calc",
        );
        return fauxAssistantMessage("看见图片啦");
      },
    ]);

    const tinyPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    await runtime.handleUserBatch(
      {
        canonicalUserId: "owner",
        originChannel: "tg",
        originPlatformUserId: "123",
        platformMsgIds: ["m2"],
        latestPlatformMsgId: "m2",
        combinedText: "看看这张图",
        attachments: [],
        firstTimestampMs: Date.now() + 10,
        lastTimestampMs: Date.now() + 10,
      },
      [{ type: "image", data: tinyPngBase64, mimeType: "image/png" }],
    );
    assert.equal(turn2SawPriorToolCalls, true);
    assert.equal(turn2SawPriorToolResult, true);

    // Turn 3 must not throw TypeError from pruned images and must not retain inline image payload
    let turn3HasInlineImage = true;
    faux.setResponses([
      (ctx) => {
        turn3HasInlineImage = ctx.messages.some(
          (m) =>
            m.role === "user" &&
            Array.isArray(m.content) &&
            m.content.some((part) => part.type === "image"),
        );
        return fauxAssistantMessage("继续聊");
      },
    ]);
    const t3 = await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["m3"],
      latestPlatformMsgId: "m3",
      combinedText: "下一句",
      attachments: [],
      firstTimestampMs: Date.now() + 20,
      lastTimestampMs: Date.now() + 20,
    });
    assert.equal(turn3HasInlineImage, false);
    assert.deepEqual(t3.bubbles, ["继续聊"]);

    // resetSession() clears prior live toolCall/toolResult messages
    runtime.resetSession();
    let afterResetHasToolResult = true;
    faux.setResponses([
      (ctx) => {
        afterResetHasToolResult = ctx.messages.some((m) => m.role === "toolResult");
        return fauxAssistantMessage("新会话开始");
      },
    ]);
    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["m4"],
      latestPlatformMsgId: "m4",
      combinedText: "重新开始",
      attachments: [],
      firstTimestampMs: Date.now() + 30,
      lastTimestampMs: Date.now() + 30,
    });
    assert.equal(afterResetHasToolResult, false);

    // 3) Autonomous set_thinking_level: scope="turn" vs scope="persist"
    const seenReasonings: Array<string | undefined> = [];
    faux.setResponses([
      (_ctx, opts) => {
        seenReasonings.push(opts?.reasoning);
        return fauxAssistantMessage(
          [fauxToolCall("set_thinking_level", { level: "high", scope: "turn", reason: "complex" })],
          { stopReason: "toolUse" },
        );
      },
      (_ctx, opts) => {
        seenReasonings.push(opts?.reasoning);
        return fauxAssistantMessage("单轮深度思考完成");
      },
    ]);
    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["m5"],
      latestPlatformMsgId: "m5",
      combinedText: "认真思考一下这个问题",
      attachments: [],
      firstTimestampMs: Date.now() + 40,
      lastTimestampMs: Date.now() + 40,
    });
    assert.deepEqual(seenReasonings, ["medium", "high"]);

    // Next turn reverts to default medium after scope="turn"
    let revertedReasoning: string | undefined;
    faux.setResponses([
      (_ctx, opts) => {
        revertedReasoning = opts?.reasoning;
        return fauxAssistantMessage(
          [fauxToolCall("set_thinking_level", { level: "high", scope: "persist" })],
          { stopReason: "toolUse" },
        );
      },
      (_ctx, opts) => {
        seenReasonings.push(opts?.reasoning);
        return fauxAssistantMessage("已持久化切换");
      },
    ]);
    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["m6"],
      latestPlatformMsgId: "m6",
      combinedText: "以后都深度思考",
      attachments: [],
      firstTimestampMs: Date.now() + 50,
      lastTimestampMs: Date.now() + 50,
    });
    assert.equal(revertedReasoning, "medium");
    assert.equal(seenReasonings[2], "high");
    assert.equal(registry.resolveSlotThinkingLevel("persona"), "high");

    // Subsequent turn retains persisted "high"
    let persistedTurnReasoning: string | undefined;
    faux.setResponses([
      (_ctx, opts) => {
        persistedTurnReasoning = opts?.reasoning;
        return fauxAssistantMessage("保持 high");
      },
    ]);
    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["m7"],
      latestPlatformMsgId: "m7",
      combinedText: "再试一次",
      attachments: [],
      firstTimestampMs: Date.now() + 60,
      lastTimestampMs: Date.now() + 60,
    });
    assert.equal(persistedTurnReasoning, "high");
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PersonaRuntime freezes ephemeral tail across multi-step tool loops and releases after turn", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-1", name: "Faux Persona" }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-cache-test-"));
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
    const proxyRouter = new ScopedProxyRouter([]);
    const runtime = new PersonaRuntime(hatoConfig, modelRegistry, proxyRouter, repo);

    let step1UserContent: unknown = null;
    let step2UserContent: unknown = null;
    let turn2UserContent: unknown = null;

    faux.setResponses([
      (ctx) => {
        step1UserContent = ctx.messages[0]?.content;
        // Simulate a new ticket being created during tool execution in this turn
        repo.createTicket({
          canonicalUserId: "owner",
          originChannel: "tg",
          backend: "builtin-pi",
          briefTitle: "新工单-缓存测试",
          status: "running",
        });
        return fauxAssistantMessage([fauxToolCall("calc", { expression: "1 + 1" })], {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        // Step 2 in the same turn must keep the exact same frozen user content (no <ticket_board> mutation)
        step2UserContent = ctx.messages[0]?.content;
        return fauxAssistantMessage("算好了，是 2");
      },
      (ctx) => {
        // Next turn after release must pick up the new ticket in <ticket_board>
        const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user");
        turn2UserContent = lastUser?.content;
        return fauxAssistantMessage("好的");
      },
    ]);

    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["m1"],
      latestPlatformMsgId: "m1",
      combinedText: "算一下 1 + 1",
      attachments: [],
      firstTimestampMs: Date.now(),
      lastTimestampMs: Date.now(),
    });

    assert.deepEqual(step2UserContent, step1UserContent);
    const step1Text = JSON.stringify(step1UserContent);
    assert.ok(!step1Text.includes("新工单-缓存测试"));

    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["m2"],
      latestPlatformMsgId: "m2",
      combinedText: "现在有任务吗",
      attachments: [],
      firstTimestampMs: Date.now() + 100,
      lastTimestampMs: Date.now() + 100,
    });

    const turn2Text = JSON.stringify(turn2UserContent);
    assert.ok(turn2Text.includes("新工单-缓存测试"));
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("summarizeCompactionBlock uses curator slot and neutral compaction system prompt", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [
      { id: "faux-persona-1", name: "Faux Persona", reasoning: true },
      { id: "faux-curator-1", name: "Faux Curator" },
    ],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-compaction-slot-test-"));
  const promptsDir = join(tempDir, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  const personaMarker = "UNIQUE_PERSONA_SOUL_MARKER_DO_NOT_LEAK";
  writeFileSync(join(promptsDir, "soul.md"), personaMarker, "utf8");

  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");

  const defaultCfg = createDefaultHatoConfig();
  defaultCfg.paths.prompts_dir = promptsDir;
  writeHatoConfig(hatoTomlPath, defaultCfg, { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-persona-1"
router = "faux-provider/faux-curator-1"
curator = "faux-provider/faux-curator-1"
worker = "faux-provider/faux-persona-1"
hindsight_llm = "faux-provider/faux-curator-1"

[slot_thinking]
persona = "high"
curator = "minimal"

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

    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "user",
      content: "明天早上八点提醒我开会",
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "assistant",
      content: "好的，我记下来了。",
    });
    const hot = repo.getHotMessages("owner", 0);
    assert.equal(hot.length, 2);

    let capturedSystemPrompt = "";
    faux.setResponses([
      (ctx) => {
        const sysMsg = ctx.messages.find((m) => m.role === "system") as
          | { role: "system"; content?: string }
          | undefined;
        capturedSystemPrompt =
          typeof sysMsg?.content === "string" ? sysMsg.content : ctx.systemPrompt ?? "";
        return fauxAssistantMessage("用户要求明早八点开会提醒，助手已确认记录。");
      },
    ]);

    const summary = await runtime.summarizeCompactionBlock({
      canonicalUserId: "owner",
      previousSummary: "",
      messagesToSummarize: hot,
    });

    assert.equal(summary, "用户要求明早八点开会提醒，助手已确认记录。");
    assert.ok(capturedSystemPrompt.includes("上下文整理助手"));
    assert.ok(!capturedSystemPrompt.includes(personaMarker));

    const trace = repo.getLatestTurnTrace("owner");
    assert.ok(trace);
    assert.equal(trace.slot, "curator");
    assert.equal(trace.provider, "faux-provider");
    assert.equal(trace.modelId, "faux-curator-1");
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("summarizeCompactionBlock in reuse_conversation mode forks live persona prefix for cache hit without mutating session", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [
      { id: "faux-persona-1", name: "Faux Persona", reasoning: true },
      { id: "faux-curator-1", name: "Faux Curator" },
    ],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-fork-compaction-test-"));
  const promptsDir = join(tempDir, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  const personaMarker = "UNIQUE_FORK_PERSONA_SOUL_MARKER";
  writeFileSync(join(promptsDir, "soul.md"), personaMarker, "utf8");

  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");

  const defaultCfg = createDefaultHatoConfig();
  defaultCfg.paths.prompts_dir = promptsDir;
  defaultCfg.context.compaction_mode = "reuse_conversation";
  writeHatoConfig(hatoTomlPath, defaultCfg, { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-persona-1"
router = "faux-provider/faux-curator-1"
curator = "faux-provider/faux-curator-1"
worker = "faux-provider/faux-persona-1"
hindsight_llm = "faux-provider/faux-curator-1"

[slot_thinking]
persona = "high"
curator = "minimal"

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

    let compactionHasPersonaMarker = false;
    let compactionToolCount = 0;
    let compactionSawPriorToolCall = false;
    let compactionReasoning: string | undefined;
    let nextTurnSawCompactionInstruction = false;

    faux.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall("calc", { expression: "12 * 12" })], {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("12 * 12 = 144 呀"),
      (ctx, options) => {
        const sysMsg = ctx.messages.find((m) => m.role === "system") as
          | { role: "system"; content?: string; toolsAdded?: Array<{ name: string }> }
          | undefined;
        const sysText = typeof sysMsg?.content === "string" ? sysMsg.content : ctx.systemPrompt ?? "";
        compactionHasPersonaMarker = sysText.includes(personaMarker);
        compactionToolCount = (sysMsg?.toolsAdded ?? ctx.tools ?? []).length;
        compactionSawPriorToolCall = ctx.messages.some(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === "toolCall" && b.name === "calc"),
        );
        compactionReasoning = options?.reasoning;
        return fauxAssistantMessage("用户让助手计算 12 * 12，助手已给出结果 144。");
      },
      (ctx) => {
        nextTurnSawCompactionInstruction = JSON.stringify(ctx.messages).includes(
          "上下文压缩（禁止调用任何工具",
        );
        return fauxAssistantMessage("在的呀");
      },
    ]);

    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123456789",
      platformMsgIds: ["m1"],
      latestPlatformMsgId: "m1",
      combinedText: "帮我算一下 12 * 12",
      attachments: [],
      firstTimestampMs: Date.now(),
      lastTimestampMs: Date.now(),
    });

    const hot = repo.getHotMessages("owner", 0);
    assert.equal(hot.length, 2);

    const summary = await runtime.summarizeCompactionBlock({
      canonicalUserId: "owner",
      previousSummary: "",
      messagesToSummarize: hot,
    });

    assert.equal(summary, "用户让助手计算 12 * 12，助手已给出结果 144。");
    assert.equal(compactionHasPersonaMarker, true);
    assert.ok(compactionToolCount > 0);
    assert.equal(compactionSawPriorToolCall, true);
    assert.equal(compactionReasoning, "high");

    const trace = repo.getLatestTurnTrace("owner");
    assert.ok(trace);
    assert.equal(trace.slot, "persona");
    assert.equal(trace.provider, "faux-provider");
    assert.equal(trace.modelId, "faux-persona-1");
    assert.ok(trace.userPreview.startsWith("[上下文压缩·复用对话]"));
    assert.ok(trace.timeCardText.includes("compaction_mode: reuse_conversation"));
    assert.ok(trace.timeCardText.includes("forked_live_prefix: true"));
    assert.ok(trace.cacheReadTokens > 0);
    assert.ok(trace.cacheHitRate > 0.7);

    // Ensure the live session was NOT mutated by the read-only fork
    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123456789",
      platformMsgIds: ["m2"],
      latestPlatformMsgId: "m2",
      combinedText: "还在吗",
      attachments: [],
      firstTimestampMs: Date.now() + 100,
      lastTimestampMs: Date.now() + 100,
    });
    assert.equal(nextTurnSawCompactionInstruction, false);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("summarizeCompactionBlock in reuse_conversation mode falls back to curator when model attempts tool call", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [
      { id: "faux-persona-1", name: "Faux Persona", reasoning: true },
      { id: "faux-curator-1", name: "Faux Curator" },
    ],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-fork-fallback-test-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");

  const defaultCfg = createDefaultHatoConfig();
  defaultCfg.context.compaction_mode = "reuse_conversation";
  writeHatoConfig(hatoTomlPath, defaultCfg, { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-persona-1"
router = "faux-provider/faux-curator-1"
curator = "faux-provider/faux-curator-1"
worker = "faux-provider/faux-persona-1"
hindsight_llm = "faux-provider/faux-curator-1"

[slot_thinking]
persona = "high"
curator = "minimal"

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

    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "user",
      content: "帮我算一下 1+1",
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "assistant",
      content: "等于 2。",
    });
    const hot = repo.getHotMessages("owner", 0);

    faux.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall("calc", { expression: "1+1" })], {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("回退摘要文本"),
    ]);

    const summary = await runtime.summarizeCompactionBlock({
      canonicalUserId: "owner",
      previousSummary: "",
      messagesToSummarize: hot,
    });

    assert.equal(summary, "回退摘要文本");
    const trace = repo.getLatestTurnTrace("owner");
    assert.ok(trace);
    assert.equal(trace.slot, "curator");
    assert.equal(trace.modelId, "faux-curator-1");
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PersonaRuntime persists successful send_file into raw_messages and exposes it to subsequent turns", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-1", name: "Faux Persona" }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-sendfile-history-test-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");
  const sampleFilePath = join(tempDir, "avatar.png");

  writeHatoConfig(hatoTomlPath, createDefaultHatoConfig(), { backup: false });
  writeFileSync(sampleFilePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
    const proxyRouter = new ScopedProxyRouter([]);
    const runtime = new PersonaRuntime(hatoConfig, modelRegistry, proxyRouter, repo);

    runtime.setSendFileHandler(async ({ channel, path }) => ({
      ok: true,
      message: `已发送文件到 ${channel.toUpperCase()}: ${path}`,
    }));

    let nextTurnSawSentFileEvent = false;
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("send_file", { path: sampleFilePath, caption: "你的头像" })],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("头像发给你啦！"),
      (ctx) => {
        nextTurnSawSentFileEvent = JSON.stringify(ctx.messages).includes(
          "已通过 send_file 发送文件到 QQ: avatar.png",
        );
        return fauxAssistantMessage("刚才已经发过啦");
      },
    ]);

    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "qq",
      originPlatformUserId: "u1",
      platformMsgIds: ["m1"],
      latestPlatformMsgId: "m1",
      combinedText: "把头像发给我",
      attachments: [],
      firstTimestampMs: Date.now(),
      lastTimestampMs: Date.now(),
    });

    const recent = repo.listRecentMessages("owner", 10);
    const sentEvent = recent.find(
      (m) => m.role === "executed_event" && m.content.includes("已通过 send_file 发送文件到 QQ: avatar.png"),
    );
    assert.ok(sentEvent);

    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "qq",
      originPlatformUserId: "u1",
      platformMsgIds: ["m2"],
      latestPlatformMsgId: "m2",
      combinedText: "你发了吗？",
      attachments: [],
      firstTimestampMs: Date.now() + 100,
      lastTimestampMs: Date.now() + 100,
    });

    assert.equal(nextTurnSawSentFileEvent, true);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PersonaRuntime preserves prior toolCalls on superseded batch and persists delegate/image_gen receipts", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-1", name: "Faux Persona" }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-superseded-receipt-test-"));
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
    const proxyRouter = new ScopedProxyRouter([]);
    const runtime = new PersonaRuntime(hatoConfig, modelRegistry, proxyRouter, repo);

    runtime.setDelegateHandler(() => ({ ticketId: "t_delegate_1", status: "routing" }));
    runtime.setImageGenHandler(() => ({ ticketId: "t_imggen_1", status: "running" }));

    let sawPriorDelegateToolCall = false;
    let sawDelegateReceiptAfterRefresh = false;
    let sawImageGenReceiptAfterRefresh = false;

    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("delegate", { hint: "跑一下晨报预览" })],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("这就去跑晨报看看～"),
      (ctx) => {
        const serialized = JSON.stringify(ctx.messages);
        sawPriorDelegateToolCall =
          serialized.includes("t_delegate_1") && serialized.includes("delegate");
        return fauxAssistantMessage(
          [fauxToolCall("image_gen", { prompt: "画一只小鸠" })],
          { stopReason: "toolUse" },
        );
      },
      () => fauxAssistantMessage("这就去画～"),
      (ctx) => {
        const serialized = JSON.stringify(ctx.messages);
        sawDelegateReceiptAfterRefresh = serialized.includes(
          "已通过 delegate 转交后台处理 (t_delegate_1",
        );
        sawImageGenReceiptAfterRefresh = serialized.includes(
          "已通过 image_gen 启动后台生图 (t_imggen_1",
        );
        return fauxAssistantMessage("收到啦");
      },
    ]);

    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "qq",
      originPlatformUserId: "u1",
      platformMsgIds: ["m1"],
      latestPlatformMsgId: "m1",
      combinedText: "帮我跑晨报",
      attachments: [],
      firstTimestampMs: Date.now(),
      lastTimestampMs: Date.now(),
    });

    // Superseded batch before prompt()
    const supersededOut = await runtime.handleUserBatch(
      {
        canonicalUserId: "owner",
        originChannel: "qq",
        originPlatformUserId: "u1",
        platformMsgIds: ["m2"],
        latestPlatformMsgId: "m2",
        combinedText: "群聊记录1",
        attachments: [],
        firstTimestampMs: Date.now() + 50,
        lastTimestampMs: Date.now() + 50,
      },
      [],
      { shouldSuppressSend: () => true },
    );
    assert.equal(supersededOut.superseded, true);

    // Next batch should still see prior turn's delegate toolCall/toolResult in memory
    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "qq",
      originPlatformUserId: "u1",
      platformMsgIds: ["m3"],
      latestPlatformMsgId: "m3",
      combinedText: "顺便画个头像",
      attachments: [],
      firstTimestampMs: Date.now() + 100,
      lastTimestampMs: Date.now() + 100,
    });
    assert.equal(sawPriorDelegateToolCall, true);

    // Force DB transcript refresh and verify persisted executed_event receipts survive
    runtime.refreshTranscriptFromDb({ force: true });
    await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "qq",
      originPlatformUserId: "u1",
      platformMsgIds: ["m4"],
      latestPlatformMsgId: "m4",
      combinedText: "刚派了啥",
      attachments: [],
      firstTimestampMs: Date.now() + 200,
      lastTimestampMs: Date.now() + 200,
    });
    assert.equal(sawDelegateReceiptAfterRefresh, true);
    assert.equal(sawImageGenReceiptAfterRefresh, true);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PersonaRuntime records a failed turn_traces row when the LLM call returns an error", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-1", name: "Faux Persona" }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-failed-trace-"));
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

    faux.setResponses([
      () => {
        throw new Error("422 Input tag 'developer' invalid");
      },
    ]);

    await assert.rejects(
      () =>
        runtime.handleUserBatch({
          canonicalUserId: "owner",
          originChannel: "web",
          originPlatformUserId: "owner",
          platformMsgIds: ["m_err_1"],
          latestPlatformMsgId: "m_err_1",
          combinedText: "你好",
          attachments: [],
          firstTimestampMs: Date.now(),
          lastTimestampMs: Date.now(),
        }),
      /422 Input tag 'developer' invalid/,
    );

    const traces = repo.listTurnTraces("owner", 10);
    assert.equal(traces.length, 1);
    assert.equal(traces[0]?.slot, "persona");
    assert.ok(traces[0]?.timeCardText.includes("[error]"));
    const steps = JSON.parse(traces[0]?.stepsJson ?? "[]") as Array<{
      kind?: string;
      stopReason?: string;
      errorMessage?: string;
    }>;
    assert.equal(steps[steps.length - 1]?.stopReason, "error");
    assert.ok(steps[steps.length - 1]?.errorMessage?.includes("422 Input tag 'developer' invalid"));
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
