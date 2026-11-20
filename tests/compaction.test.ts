import assert from "node:assert/strict";
import test from "node:test";
import { ActorLock } from "../src/bus/actor-bus.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { CompactionManager, computeNextScheduledClearMs } from "../src/memory/compaction.js";

test("CompactionManager promotes pre-computed draft on idle commit without calling LLM twice", async () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    const lock = new ActorLock();

    for (let i = 1; i <= 12; i++) {
      repo.appendRawMessage({
        canonicalUserId: "owner",
        channel: "tg",
        role: i % 2 === 1 ? "user" : "assistant",
        content: `消息 ${i}`,
        createdAt: i * 1000,
      });
    }

    let summarizeCalls = 0;
    let retainedCount = 0;
    const manager = new CompactionManager(
      {
        hotMessagesHighWatermark: 60,
        hotMessagesKeepAfterCompact: 4,
        minMessagesToCompact: 10,
        preCompactAfterMinutes: 50,
        idleCommitAfterMinutes: 60,
      },
      repo,
      lock,
      {
        async summarizeBlock({ messagesToSummarize }) {
          summarizeCalls++;
          return `摘要(${messagesToSummarize.length}条)`;
        },
        async ensureRetained(_user, messages) {
          retainedCount += messages.length;
        },
      },
    );

    const drafted = await manager.runPreCompactDraft("owner");
    assert.equal(drafted, true);
    assert.equal(summarizeCalls, 1);

    // Hot messages should still be untouched after Stage 1.
    const stateBeforeCommit = repo.getWorkingMemory("owner");
    assert.equal(repo.getHotMessages("owner", stateBeforeCommit.compactedUntilTs).length, 12);

    const committed = await manager.runIdleCommit("owner");
    assert.equal(committed, true);
    // Stage 2 reuses the draft without an extra summarizeBlock call!
    assert.equal(summarizeCalls, 1);
    assert.equal(retainedCount, 8);

    const stateAfterCommit = repo.getWorkingMemory("owner");
    assert.equal(stateAfterCommit.summaryText, "摘要(8条)");
    assert.equal(repo.getHotMessages("owner", stateAfterCommit.compactedUntilTs).length, 4);

    manager.dispose();
  } finally {
    handle.close();
  }
});

test("computeNextScheduledClearMs picks today if future, otherwise tomorrow in target timezone", () => {
  // 2026-11-20 00:30:00 Asia/Shanghai == 2026-11-19 16:30:00Z
  const beforeTarget = Date.parse("2026-11-19T16:30:00Z");
  const nextSameDay = computeNextScheduledClearMs(beforeTarget, "01:00", "Asia/Shanghai");
  assert.equal(nextSameDay, Date.parse("2026-11-19T17:00:00Z")); // 2026-11-20 01:00:00+08:00

  // 2026-11-20 02:00:00 Asia/Shanghai == 2026-11-19 18:00:00Z
  const afterTarget = Date.parse("2026-11-19T18:00:00Z");
  const nextDay = computeNextScheduledClearMs(afterTarget, "01:00", "Asia/Shanghai");
  assert.equal(nextDay, Date.parse("2026-11-20T17:00:00Z")); // 2026-11-21 01:00:00+08:00
});

test("CompactionManager scheduled mode defers active chat and clears/archives quiet users", async () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    const lock = new ActorLock();

    const baseNow = Date.parse("2026-11-20T17:00:00Z"); // 01:00 Asia/Shanghai
    // User A chatted 40 minutes ago (quiet >= 30m)
    repo.appendRawMessage({
      canonicalUserId: "user_quiet",
      channel: "tg",
      role: "user",
      content: "晚安",
      createdAt: baseNow - 40 * 60_000,
    });
    repo.getWorkingMemory("user_quiet");

    // User B chatted 5 minutes ago (active < 30m)
    repo.appendRawMessage({
      canonicalUserId: "user_active",
      channel: "tg",
      role: "user",
      content: "还在聊呢",
      createdAt: baseNow - 5 * 60_000,
    });
    repo.getWorkingMemory("user_active");

    const clearedUsers: string[] = [];
    const manager = new CompactionManager(
      {
        hotMessagesHighWatermark: 60,
        hotMessagesKeepAfterCompact: 10,
        minMessagesToCompact: 10,
        preCompactAfterMinutes: 50,
        idleCommitAfterMinutes: 60,
        clearMode: "scheduled",
        scheduledClearTime: "01:00",
        scheduledDeferMinutes: 30,
        timezone: "Asia/Shanghai",
      },
      repo,
      lock,
      {
        async summarizeBlock() {
          throw new Error("summarizeBlock should not be called in scheduled mode");
        },
        listActiveUserIds: () => repo.listWorkingMemoryUserIds(),
        async clearHotZoneAndArchive(uid) {
          clearedUsers.push(uid);
          const res = repo.resetWorkingContext(uid, baseNow);
          return res.clearedHotMessages > 0 || res.hadSummary;
        },
      },
    );

    const count = await manager.runScheduledSweep(baseNow);
    assert.equal(count, 1);
    assert.deepEqual(clearedUsers, ["user_quiet"]);

    // Quiet user's hot zone is now empty, but raw_messages & archived_sessions preserve history
    const quietWm = repo.getWorkingMemory("user_quiet");
    assert.equal(repo.getHotMessages("user_quiet", quietWm.compactedUntilTs).length, 0);

    // Active user's hot zone is still intact because they chatted 5m ago
    const activeWm = repo.getWorkingMemory("user_active");
    assert.equal(repo.getHotMessages("user_active", activeWm.compactedUntilTs).length, 1);

    // Simulate user_active sending a new message during deferral, then 31 minutes of silence
    manager.recordInteraction("user_active", baseNow + 10 * 60_000);
    const stillActive = await manager.evaluateScheduledClearForUser(
      "user_active",
      baseNow + 35 * 60_000,
    );
    assert.equal(stillActive, false);

    const nowQuiet = await manager.evaluateScheduledClearForUser(
      "user_active",
      baseNow + 41 * 60_000,
    );
    assert.equal(nowQuiet, true);
    assert.deepEqual(clearedUsers, ["user_quiet", "user_active"]);

    manager.dispose();
  } finally {
    handle.close();
  }
});
