import assert from "node:assert/strict";
import test from "node:test";
import { diffCalendarDays, formatDurationZh, formatLocalDateTime, isWithinQuietHours } from "../src/time/clock.js";
import { parseRelativeDateRange } from "../src/time/parse.js";
import { formatGapMarker, renderTimeCard } from "../src/time/timecard.js";

test("formatLocalDateTime formats Asia/Shanghai accurately", () => {
  const epoch = Date.parse("2026-11-16T05:15:00Z"); // 13:15 CST
  const parts = formatLocalDateTime(epoch, "Asia/Shanghai");
  assert.equal(parts.isoDate, "2026-11-16");
  assert.equal(parts.hour, 13);
  assert.equal(parts.minute, 15);
  assert.equal(parts.weekdayZh, "周一");
  assert.equal(parts.periodZh, "中午");
  assert.equal(parts.compactStamp, "11-16 13:15");
});

test("isWithinQuietHours handles overnight windows", () => {
  const lateNight = Date.parse("2026-11-16T15:45:00Z"); // 23:45 CST
  const earlyMorning = Date.parse("2026-11-16T23:30:00Z"); // 07:30 CST next day
  const afternoon = Date.parse("2026-11-16T06:00:00Z"); // 14:00 CST

  assert.equal(isWithinQuietHours(lateNight, "Asia/Shanghai", "23:30", "08:00"), true);
  assert.equal(isWithinQuietHours(earlyMorning, "Asia/Shanghai", "23:30", "08:00"), true);
  assert.equal(isWithinQuietHours(afternoon, "Asia/Shanghai", "23:30", "08:00"), false);
});

test("diffCalendarDays compares calendar days in target timezone", () => {
  // 2026-11-16 23:50 CST -> next calendar day 2026-11-17 is still 1 day ahead!
  const now = Date.parse("2026-11-16T15:50:00Z");
  assert.equal(diffCalendarDays(now, "2026-11-16", "Asia/Shanghai"), 0);
  assert.equal(diffCalendarDays(now, "2026-11-17", "Asia/Shanghai"), 1);
  assert.equal(diffCalendarDays(now, "2026-11-28", "Asia/Shanghai"), 12);
  assert.equal(diffCalendarDays(now, "2026-11-15", "Asia/Shanghai"), -1);
});

test("renderTimeCard applies active override and formats milestones", () => {
  const now = Date.parse("2026-11-16T03:38:00Z"); // 11:38 CST / 12:38 Tokyo
  const lastUserMsg = now - (3 * 24 + 2) * 3_600_000;

  const card = renderTimeCard({
    nowMs: now,
    baseTimezone: "Asia/Shanghai",
    quietHours: { start: "23:30", end: "08:00" },
    lastUserMessageMs: lastUserMsg,
    activeOverride: {
      tempTimezone: "Asia/Tokyo",
      statusNote: "本周在东京出差",
      expiresAt: now + 3_600_000,
    },
    upcomingMilestones: [
      { label: "面试", isoDate: "2026-11-25" },
      { label: "用户生日", isoDate: "2026-11-28" },
    ],
  });

  assert.match(card, /Asia\/Tokyo/);
  assert.match(card, /12:38/);
  assert.match(card, /距用户上一条消息: 3 天 2 小时/);
  assert.match(card, /本周在东京出差/);
  assert.match(card, /面试 11-25 周三 \(还有 9 天\)/);
  assert.match(card, /用户生日 11-28 周六 \(还有 12 天\)/);
});

test("formatGapMarker and formatDurationZh render cleanly", () => {
  const t0 = Date.parse("2026-11-13T15:10:00Z");
  const t1 = t0 + 60 * 60_000;
  const t2 = t0 + (2 * 24 + 12) * 3_600_000;

  assert.equal(formatGapMarker(t0, t1, 120), null);
  assert.equal(formatGapMarker(t0, t2, 120), "—— 2 天 12 小时后 ——");
  assert.equal(formatDurationZh(45 * 60_000), "45 分钟");
});

test("parseRelativeDateRange parses Chinese relative spans", () => {
  const now = Date.parse("2026-11-16T04:00:00Z"); // Monday 2026-11-16 12:00 CST
  const yesterday = parseRelativeDateRange("昨天我说的那个事", now, "Asia/Shanghai");
  assert.ok(yesterday);
  assert.equal(yesterday.label, "昨天");
  assert.equal(formatLocalDateTime(yesterday.startMs, "Asia/Shanghai").isoDate, "2026-11-15");
  assert.equal(formatLocalDateTime(yesterday.endMs, "Asia/Shanghai").isoDate, "2026-11-16");

  const lastWeek = parseRelativeDateRange("上周聊过的方案", now, "Asia/Shanghai");
  assert.ok(lastWeek);
  assert.equal(formatLocalDateTime(lastWeek.startMs, "Asia/Shanghai").isoDate, "2026-11-09");
  assert.equal(formatLocalDateTime(lastWeek.endMs, "Asia/Shanghai").isoDate, "2026-11-16");
});
