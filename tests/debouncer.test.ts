import assert from "node:assert/strict";
import test from "node:test";
import { MessageDebouncer, mergeInboundBatches } from "../src/gateway/debouncer.js";
import type { InboundBatch } from "../src/gateway/types.js";

test("MessageDebouncer coalesces rapid messages into one batch", async () => {
  const flushed: InboundBatch[] = [];
  const debouncer = new MessageDebouncer(40, (batch) => {
    flushed.push(batch);
  });

  debouncer.enqueue({
    channel: "tg",
    platformUserId: "1001",
    platformMsgId: "m1",
    canonicalUserId: "owner",
    text: "帮我写个脚本",
    attachments: [],
    timestampMs: 1000,
  });

  assert.equal(debouncer.hasPending("owner"), true);

  await new Promise((r) => setTimeout(r, 15));
  debouncer.enqueue({
    channel: "tg",
    platformUserId: "1001",
    platformMsgId: "m2",
    canonicalUserId: "owner",
    replyToPlatformMsgId: "m0",
    text: "每天早上抓 HN",
    attachments: [{ kind: "image", filename: "shot.png" }],
    images: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestampMs: 1020,
  });

  await new Promise((r) => setTimeout(r, 70));
  assert.equal(debouncer.hasPending("owner"), false);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.combinedText, "帮我写个脚本\n每天早上抓 HN");
  assert.deepEqual(flushed[0]!.platformMsgIds, ["m1", "m2"]);
  assert.equal(flushed[0]!.replyToPlatformMsgId, "m0");
  assert.equal(flushed[0]!.attachments.length, 1);
  assert.equal(flushed[0]!.images?.length, 1);
  assert.equal(flushed[0]!.images?.[0]?.mimeType, "image/png");

  debouncer.enqueue({
    channel: "tg",
    platformUserId: "1001",
    platformMsgId: "m3",
    canonicalUserId: "owner",
    text: "应被 /new 取消",
    attachments: [],
    timestampMs: 2000,
  });
  assert.equal(debouncer.hasPending("owner"), true);
  assert.equal(debouncer.discardUser("owner"), true);
  assert.equal(debouncer.hasPending("owner"), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(flushed.length, 1);

  debouncer.dispose();
});

test("mergeInboundBatches coalesces queued batches from the same user into one turn", () => {
  const merged = mergeInboundBatches([
    {
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "1001",
      platformMsgIds: ["m10"],
      latestPlatformMsgId: "m10",
      combinedText: "好",
      attachments: [],
      firstTimestampMs: 1000,
      lastTimestampMs: 1000,
    },
    {
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "1001",
      platformMsgIds: ["m11"],
      latestPlatformMsgId: "m11",
      combinedText: "你别催了",
      attachments: [],
      firstTimestampMs: 3200,
      lastTimestampMs: 3200,
    },
  ]);

  assert.equal(merged.combinedText, "好\n你别催了");
  assert.deepEqual(merged.platformMsgIds, ["m10", "m11"]);
  assert.equal(merged.latestPlatformMsgId, "m11");
  assert.equal(merged.firstTimestampMs, 1000);
  assert.equal(merged.lastTimestampMs, 3200);
});
