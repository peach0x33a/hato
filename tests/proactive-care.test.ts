import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorLock } from "../src/bus/actor-bus.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { ProactiveCareScheduler } from "../src/dispatch/proactive-care.js";
import { parseCuratorExtractionJson } from "../src/memory/curator.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { parseLocalDateTimeToEpochMs } from "../src/time/clock.js";

describe("proactive-care", () => {
  test("parseLocalDateTimeToEpochMs and parseCuratorExtractionJson parse open_loops cleanly", () => {
    const parsed = parseCuratorExtractionJson(
      JSON.stringify({
        persona: [{ fact: "用户明天有牙科复诊。", occurred_at: "2026-11-20 20:00" }],
        tech: [],
        open_loops: [{ content: "关心用户牙科复诊情况", due_at: "2026-11-21 11:30" }],
      }),
    );

    expect(parsed.persona).toHaveLength(1);
    expect(parsed.openLoops).toEqual([
      { content: "关心用户牙科复诊情况", dueAt: "2026-11-21 11:30" },
    ]);

    const ts = parseLocalDateTimeToEpochMs("2026-11-21 11:30", "Asia/Singapore");
    expect(ts).not.toBeNull();
    expect(new Date(ts!).toISOString()).toBe("2026-11-21T03:30:00.000Z");
  });

  test("ProactiveCareScheduler respects quiet_hours, defer_after_chat_minutes, max_unanswered_streak, and user reply resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-proactive-"));
    try {
      const dbHandle = openDatabase(join(dir, "test.db"));
      const repo = new HatoRepository(dbHandle.db);
      repo.ensureOwner({
        canonicalUserId: "u1",
        timezone: "Asia/Singapore",
        proactiveChannel: "tg",
      });

      const cfg = createDefaultHatoConfig();
      cfg.owner.timezone = "Asia/Singapore";
      cfg.owner.quiet_hours = { start: "23:30", end: "08:00" };
      cfg.memory.open_loops = {
        defer_after_chat_minutes: 5,
        max_unanswered_streak: 2,
      };

      const deliveries: string[] = [];
      const scheduler = new ProactiveCareScheduler({
        getHatoConfig: () => cfg,
        repo,
        actorLock: new ActorLock(),
        deliverOpenLoop: async ({ loopId, content }) => {
          deliveries.push(`${loopId}:${content}`);
          return "sent";
        },
      });

      // 2026-11-21 02:00 Asia/Singapore (inside quiet hours 23:30-08:00)
      const quietNow = parseLocalDateTimeToEpochMs("2026-11-21 02:00", "Asia/Singapore")!;
      const loop = repo.createOpenLoop({
        canonicalUserId: "u1",
        content: "记得吃药",
        dueAt: quietNow - 60_000,
        notifyChannel: "tg",
      });

      await scheduler.tick(quietNow);
      expect(deliveries).toEqual([]);

      // 2026-11-21 10:00 Asia/Singapore, user just chatted 2 minutes ago -> deferred
      const activeChatNow = parseLocalDateTimeToEpochMs("2026-11-21 10:00", "Asia/Singapore")!;
      repo.appendRawMessage({
        canonicalUserId: "u1",
        channel: "tg",
        role: "user",
        content: "早安",
        createdAt: activeChatNow - 2 * 60_000,
      });

      await scheduler.tick(activeChatNow);
      expect(deliveries).toEqual([]);

      // 10 minutes after last user message -> fires 1st time
      const fire1Now = activeChatNow + 10 * 60_000;
      await scheduler.tick(fire1Now);
      expect(deliveries).toHaveLength(1);
      const after1 = repo.getOpenLoop(loop.id)!;
      expect(after1.status).toBe("pending");
      expect(after1.unansweredStreak).toBe(1);
      expect(after1.dueAt).toBeGreaterThan(fire1Now);

      // Simulate user replying -> resolves fired open loop as done
      const resolvedCount = repo.resolveFiredOpenLoopsOnUserReply("u1");
      expect(resolvedCount).toBe(1);
      expect(repo.getOpenLoop(loop.id)!.status).toBe("done");

      // Another loop reaches max_unanswered_streak=2 -> paused
      const loop2 = repo.createOpenLoop({
        canonicalUserId: "u1",
        content: "喝水提醒",
        dueAt: fire1Now - 1000,
        notifyChannel: "tg",
      });
      await scheduler.tick(fire1Now);
      const afterLoop2First = repo.getOpenLoop(loop2.id)!;
      expect(afterLoop2First.unansweredStreak).toBe(1);
      expect(afterLoop2First.status).toBe("pending");

      await scheduler.tick(afterLoop2First.dueAt + 1000);
      const afterLoop2Second = repo.getOpenLoop(loop2.id)!;
      expect(afterLoop2Second.unansweredStreak).toBe(2);
      expect(afterLoop2Second.status).toBe("paused");

      dbHandle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("repo.createScheduleOverride and clearScheduleOverrides manage temporary timezone/status overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-override-"));
    try {
      const dbHandle = openDatabase(join(dir, "test.db"));
      const repo = new HatoRepository(dbHandle.db);
      repo.ensureOwner({
        canonicalUserId: "u1",
        timezone: "Asia/Singapore",
        proactiveChannel: "tg",
      });

      const now = Date.now();
      const created = repo.createScheduleOverride({
        canonicalUserId: "u1",
        tempTimezone: "Asia/Tokyo",
        statusNote: "出差中",
        expiresAt: now + 3600_000,
      });

      const active = repo.getActiveScheduleOverride("u1", now);
      expect(active?.id).toBe(created.id);
      expect(active?.tempTimezone).toBe("Asia/Tokyo");
      expect(active?.statusNote).toBe("出差中");

      expect(repo.getActiveScheduleOverride("u1", now + 7200_000)).toBeNull();
      expect(repo.clearScheduleOverrides("u1")).toBe(1);
      expect(repo.getActiveScheduleOverride("u1", now)).toBeNull();

      dbHandle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ProactiveCareScheduler snoozes failed deliveries without incrementing unansweredStreak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-proactive-fail-"));
    try {
      const dbHandle = openDatabase(join(dir, "test.db"));
      const repo = new HatoRepository(dbHandle.db);
      repo.ensureOwner({
        canonicalUserId: "u1",
        timezone: "Asia/Singapore",
        proactiveChannel: "tg",
      });

      const cfg = createDefaultHatoConfig();
      cfg.owner.timezone = "Asia/Singapore";
      cfg.owner.quiet_hours = { start: "23:30", end: "08:00" };
      cfg.memory.open_loops = {
        defer_after_chat_minutes: 5,
        max_unanswered_streak: 2,
      };

      const scheduler = new ProactiveCareScheduler({
        getHatoConfig: () => cfg,
        repo,
        actorLock: new ActorLock(),
        deliverOpenLoop: async () => "failed",
      });

      const now = parseLocalDateTimeToEpochMs("2026-11-21 10:00", "Asia/Singapore")!;
      const loop = repo.createOpenLoop({
        canonicalUserId: "u1",
        content: "喝水提醒",
        dueAt: now - 1000,
        notifyChannel: "tg",
      });

      await scheduler.tick(now);
      const afterFail = repo.getOpenLoop(loop.id)!;
      expect(afterFail.status).toBe("pending");
      expect(afterFail.unansweredStreak).toBe(0);
      expect(afterFail.dueAt).toBeGreaterThan(now);

      dbHandle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
