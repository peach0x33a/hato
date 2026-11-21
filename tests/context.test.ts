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
    assert.match(String(llmMessages[0]!.content), /^\[11-13 23:10\] 明天要早起，先睡了$/);

    assert.equal(llmMessages[1]!.role, "assistant");
    assert.deepEqual(llmMessages[1]!.content, [{ type: "text", text: "晚安～" }]);

    // Executed event followed by QQ user turn merges cleanly into one user turn (alternating roles)
    // with gap marker, [来自 QQ] tag, and ephemeral <time> tail.
    assert.equal(llmMessages[2]!.role, "user");
    const lastText = String(llmMessages[2]!.content);
    assert.ok(lastText.includes("—— 2 天 12 小时后 ——"));
    assert.ok(lastText.includes("[事件 11-16 11:25 已执行] 每日 RSS 推送"));
    assert.ok(lastText.includes("[11-16 11:35] [来自 QQ] 在吗"));
    assert.ok(lastText.includes("<time>\n现在: 2026-11-16\n</time>"));
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
        "[附件 file: 07_服装02_居家休闲.png (path: /mnt/hato-data/media/inbound/1795251376602_f80c53.png)]",
      ),
    );
  }
});
