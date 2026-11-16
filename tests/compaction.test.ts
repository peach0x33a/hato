import assert from "node:assert/strict";
import test from "node:test";
import { ActorLock } from "../src/bus/actor-bus.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { CompactionManager } from "../src/memory/compaction.js";

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
