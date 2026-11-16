import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";

test("HatoRepository persists messages, compaction drafts, and turn traces", () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    repo.ensureOwner({
      canonicalUserId: "owner",
      tgUserId: "12345",
      timezone: "Asia/Shanghai",
      proactiveChannel: "tg",
    });

    const m1 = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "p1",
      role: "user",
      content: "第一句话",
      createdAt: 1000,
    });
    const m2 = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "p2",
      role: "assistant",
      content: "你好呀",
      createdAt: 2000,
    });
    const m3 = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "p3",
      role: "user",
      content: "第三句话",
      createdAt: 3000,
    });

    assert.equal(repo.findMessageByPlatformId("tg", "p1")?.id, m1.id);
    assert.equal(repo.getHotMessages("owner", 0).length, 3);

    repo.saveDraftCompaction({
      canonicalUserId: "owner",
      draftSummary: "前两轮问候",
      draftUntilMsgId: m2.id,
      draftUntilTs: m2.createdAt,
    });

    const beforeCommit = repo.getWorkingMemory("owner");
    assert.equal(beforeCommit.draftSummary, "前两轮问候");
    assert.equal(beforeCommit.compactedUntilTs, 0);

    repo.commitCompaction({
      canonicalUserId: "owner",
      summaryText: "前两轮问候",
      compactedUntilMsgId: m2.id,
      compactedUntilTs: m2.createdAt,
    });

    const afterCommit = repo.getWorkingMemory("owner");
    assert.equal(afterCommit.summaryText, "前两轮问候");
    assert.equal(afterCommit.draftSummary, null);

    const hotAfter = repo.getHotMessages("owner", afterCommit.compactedUntilTs);
    assert.equal(hotAfter.length, 1);
    assert.equal(hotAfter[0]!.id, m3.id);

    repo.insertTurnTrace({
      canonicalUserId: "owner",
      slot: "persona",
      provider: "google-gateway",
      modelId: "gemini-4-hydrogen",
      api: "google-generative-ai",
      inputTokens: 1200,
      outputTokens: 85,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      recalledIds: [],
      timeCardText: "<time>\n现在: 2026-11-16\n</time>",
      toolCalls: [],
      latencyMs: 420,
    });

    const trace = repo.getLatestTurnTrace("owner");
    assert.ok(trace);
    assert.equal(trace.cacheReadTokens, 1000);
    assert.equal(trace.modelId, "gemini-4-hydrogen");
  } finally {
    handle.close();
  }
});
