import assert from "node:assert/strict";
import test from "node:test";
import { ActorLock, EventBus } from "../src/bus/actor-bus.js";

test("ActorLock serializes tasks per actor without cross-actor blocking", async () => {
  const lock = new ActorLock();
  const trace: string[] = [];

  const p1 = lock.run("owner", async () => {
    trace.push("owner-1-start");
    await new Promise((r) => setTimeout(r, 30));
    trace.push("owner-1-end");
  });

  const p2 = lock.run("owner", async () => {
    trace.push("owner-2-start");
    trace.push("owner-2-end");
  });

  await Promise.all([p1, p2]);
  assert.deepEqual(trace, ["owner-1-start", "owner-1-end", "owner-2-start", "owner-2-end"]);
  assert.equal(lock.isBusy("owner"), false);
});

test("EventBus dispatches typed events to registered listeners", async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  const off = bus.on("executed_event", (evt) => {
    seen.push(evt.summary);
  });

  await bus.emit({
    type: "executed_event",
    canonicalUserId: "owner",
    channel: "tg",
    summary: "每日 RSS 推送已完成",
    occurredAtMs: 1234,
  });

  off();
  await bus.emit({
    type: "executed_event",
    canonicalUserId: "owner",
    channel: "tg",
    summary: "ignored",
    occurredAtMs: 1235,
  });

  assert.deepEqual(seen, ["每日 RSS 推送已完成"]);
});
