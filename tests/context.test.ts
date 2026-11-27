import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { convertHatoMessagesToLlm, hydrateTranscriptFromDb, rawRecordToAgentMessage } from "../src/persona/context.js";

test("hydrateTranscriptFromDb and convertHatoMessagesToLlm maintain prefix stability, gap markers, and ephemeral tail", () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    const t0 = Date.parse("2026-11-13T15:10:00Z"); // 23:10 CST
    const t1 = t0 + 60_000; // 23:11 CST
    const t2 = Date.parse("2026-11-16T03:35:00Z"); // 11:35 CST (~2 days 12 hours later)

    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "tg1",
      role: "user",
      content: "明天要早起，先睡了",
      createdAt: t0,
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "tg2",
      role: "assistant",
      content: "晚安～",
      createdAt: t1,
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "executed_event",
      content: "每日 RSS 推送，成功 3 条",
      createdAt: t2 - 600_000,
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "qq",
      platformMsgId: "qq1",
      replyToId: "tg1",
      role: "user",
      content: "在吗",
      createdAt: t2,
    });

    const hydrated = hydrateTranscriptFromDb(repo, "owner");
    const withTail = [
      ...hydrated,
      { role: "hato_ephemeral_tail" as const, text: "<time>\n现在: 2026-11-16\n</time>", timestamp: t2 },
    ];

    const llmMessages = convertHatoMessagesToLlm(withTail, {
      getTimezone: () => "Asia/Shanghai",
      gapMarkerThresholdMinutes: 120,
    });

    assert.equal(llmMessages.length, 3);
    assert.equal(llmMessages[0]!.role, "user");
    assert.deepEqual(llmMessages[0]!.content, [{ type: "text", text: "[11-13 23:10] 明天要早起，先睡了" }]);

    assert.equal(llmMessages[1]!.role, "assistant");
    assert.deepEqual(llmMessages[1]!.content, [{ type: "text", text: "晚安～" }]);

    // Executed event followed by QQ user turn merges into one user turn (alternating roles)
    // with separate TextContent parts for event, user, and ephemeral tail.
    assert.equal(llmMessages[2]!.role, "user");
    assert.ok(Array.isArray(llmMessages[2]!.content));
    const parts = llmMessages[2]!.content as Array<{ type: string; text?: string }>;
    assert.equal(parts.length, 3);
    assert.ok(parts[0]!.text!.includes("—— 2 天 12 小时后 ——"));
    assert.ok(parts[0]!.text!.includes("[Executed Event 11-16 11:25] 每日 RSS 推送"));
    assert.equal(parts[1]!.text, "[11-16 11:35] [via QQ] 在吗");
    assert.equal(parts[2]!.text, "<time>\n现在: 2026-11-16\n</time>");
  } finally {
    handle.close();
  }
});

test("rawRecordToAgentMessage exposes attachment localPath to Persona context", () => {
  const agentMsg = rawRecordToAgentMessage({
    id: "m_att_1",
    canonicalUserId: "owner",
    channel: "qq",
    platformMsgId: "qq_1",
    replyToId: null,
    role: "user",
    content: "你自己看看",
    attachments: [
      {
        kind: "file",
        filename: "07_服装02_居家休闲.png",
        mimeType: "file",
        localPath: "/mnt/hato-data/media/inbound/1795251376602_f80c53.png",
      },
    ],
    createdAt: Date.now(),
  });

  assert.equal(agentMsg.role, "hato_user_batch");
  if (agentMsg.role === "hato_user_batch") {
    assert.ok(
      agentMsg.text.includes(
        "[Attachment file: 07_服装02_居家休闲.png (path: /mnt/hato-data/media/inbound/1795251376602_f80c53.png)]",
      ),
    );
  }
});

test("convertHatoMessagesToLlm merges same-kind user parts, splits cross-kind parts, anchors tail, and folds openai-completions", () => {
  const t0 = Date.parse("2026-11-21T10:00:00Z");
  const baseMessages = [
    {
      role: "hato_compaction_summary" as const,
      text: "摘要A",
      compactedUntilTs: t0 - 120_000,
      timestamp: t0 - 120_000,
    },
    {
      role: "hato_compaction_summary" as const,
      text: "摘要B",
      compactedUntilTs: t0 - 60_000,
      timestamp: t0 - 60_000,
    },
    {
      role: "hato_executed_event" as const,
      id: "ev1",
      text: "事件1",
      timestamp: t0 - 30_000,
    },
    {
      role: "hato_executed_event" as const,
      id: "ev2",
      text: "事件2",
      timestamp: t0 - 20_000,
    },
    {
      role: "hato_user_batch" as const,
      id: "u1",
      channel: "tg" as const,
      text: "第一句",
      images: [],
      timestamp: t0,
    },
    {
      role: "hato_user_batch" as const,
      id: "u2",
      channel: "tg" as const,
      text: "第二句",
      images: [],
      timestamp: t0 + 1_000,
    },
    {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "tc1", name: "calc", arguments: {} }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: t0 + 2_000,
    },
    {
      role: "toolResult" as const,
      toolCallId: "tc1",
      toolName: "calc",
      content: [{ type: "text" as const, text: "42" }],
      isError: false,
      timestamp: t0 + 3_000,
    },
    // Steering user message arriving mid-loop must NOT steal the anchored ephemeral tail
    {
      role: "hato_user_batch" as const,
      id: "u_steer",
      channel: "tg" as const,
      text: "顺便补充一句",
      images: [],
      timestamp: t0 + 4_000,
    },
    {
      role: "hato_ephemeral_tail" as const,
      text: "<time>\n现在: 2026-11-21\n</time>",
      timestamp: t0,
      anchorMessageId: "u2",
    },
  ];

  // 1. Structured parts (non-openai-completions)
  const structured = convertHatoMessagesToLlm(baseMessages, {
    getTimezone: () => "Asia/Shanghai",
    gapMarkerThresholdMinutes: 120,
    modelApi: "anthropic-messages",
  });

  assert.equal(structured.length, 4);
  assert.equal(structured[0]!.role, "user");
  const firstUserParts = structured[0]!.content as Array<{ type: string; text?: string }>;
  // 4 parts: merged summary, merged event, merged user, anchored ephemeral tail
  assert.equal(firstUserParts.length, 4);
  assert.ok(firstUserParts[0]!.text!.includes("摘要A") && firstUserParts[0]!.text!.includes("摘要B"));
  assert.ok(firstUserParts[1]!.text!.includes("事件1") && firstUserParts[1]!.text!.includes("事件2"));
  assert.ok(firstUserParts[2]!.text!.includes("第一句") && firstUserParts[2]!.text!.includes("第二句"));
  assert.equal(firstUserParts[3]!.text, "<time>\n现在: 2026-11-21\n</time>");

  // Steering message stays clean without ephemeral tail
  assert.equal(structured[3]!.role, "user");
  const steerParts = structured[3]!.content as Array<{ type: string; text?: string }>;
  assert.equal(steerParts.length, 1);
  assert.ok(steerParts[0]!.text!.includes("顺便补充一句"));

  // 2. openai-completions folds text-only user messages to plain strings, keeps image-bearing as array
  const withImageMessages = [
    ...baseMessages.slice(0, 6),
    {
      role: "hato_user_batch" as const,
      id: "u_img",
      channel: "tg" as const,
      text: "看图",
      images: [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }],
      timestamp: t0 + 2_000,
    },
  ];
  const folded = convertHatoMessagesToLlm(baseMessages, {
    getTimezone: () => "Asia/Shanghai",
    gapMarkerThresholdMinutes: 120,
    modelApi: "openai-completions",
  });
  assert.equal(typeof folded[0]!.content, "string");
  assert.ok((folded[0]!.content as string).includes("<time>\n现在: 2026-11-21\n</time>"));
  assert.equal(typeof folded[3]!.content, "string");

  const foldedWithImage = convertHatoMessagesToLlm(withImageMessages, {
    getTimezone: () => "Asia/Shanghai",
    gapMarkerThresholdMinutes: 120,
    modelApi: "openai-completions",
  });
  assert.ok(Array.isArray(foldedWithImage[0]!.content));
});

test("convertHatoMessagesToLlm renders pinned HatoUserBatchMessage.ephemeralTail append-only", () => {
  const t0 = Date.parse("2026-11-21T02:00:00Z");
  const pinnedMessages = [
    {
      role: "hato_user_batch" as const,
      id: "u1",
      channel: "qq" as const,
      text: "第一轮问题",
      images: [],
      ephemeralTail: "<time>\n现在: 2026-11-21 10:00\n</time>",
      timestamp: t0,
    },
    {
      role: "hato_persona_turn" as const,
      id: "a1",
      channel: "qq" as const,
      text: "第一轮回答",
      timestamp: t0 + 1000,
    },
    {
      role: "hato_user_batch" as const,
      id: "u2",
      channel: "qq" as const,
      text: "第二轮追问",
      images: [],
      ephemeralTail: "<time>\n现在: 2026-11-21 10:05\n</time>",
      timestamp: t0 + 5 * 60_000,
    },
  ];

  const structured = convertHatoMessagesToLlm(pinnedMessages, {
    getTimezone: () => "Asia/Shanghai",
    gapMarkerThresholdMinutes: 120,
    modelApi: "anthropic-messages",
  });
  assert.equal(structured.length, 3);
  const u1Parts = structured[0]!.content as Array<{ type: string; text?: string }>;
  assert.equal(u1Parts.length, 2);
  assert.equal(u1Parts[1]!.text, "<time>\n现在: 2026-11-21 10:00\n</time>");

  const folded = convertHatoMessagesToLlm(pinnedMessages, {
    getTimezone: () => "Asia/Shanghai",
    gapMarkerThresholdMinutes: 120,
    modelApi: "openai-completions",
  });
  assert.equal(typeof folded[0]!.content, "string");
  assert.ok((folded[0]!.content as string).endsWith("<time>\n现在: 2026-11-21 10:00\n</time>"));
  assert.equal(typeof folded[2]!.content, "string");
  assert.ok((folded[2]!.content as string).endsWith("<time>\n现在: 2026-11-21 10:05\n</time>"));
});
