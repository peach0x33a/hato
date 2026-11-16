import { diffCalendarDays, formatDurationZh, formatLocalDateTime, isWithinQuietHours } from "./clock.js";

export interface UpcomingMilestone {
  label: string;
  /** YYYY-MM-DD in user's active timezone */
  isoDate: string;
}

export interface ScheduleOverrideView {
  tempTimezone?: string | null;
  statusNote?: string | null;
  expiresAt: number;
}

export interface TimeCardInput {
  nowMs: number;
  baseTimezone: string;
  quietHours: { start: string; end: string };
  lastUserMessageMs?: number | null;
  /** Show elapsed time line once gap >= threshold (defaults to 30 min) */
  elapsedThresholdMinutes?: number;
  activeOverride?: ScheduleOverrideView | null;
  upcomingMilestones?: UpcomingMilestone[];
}

function formatDayCountdown(deltaDays: number, targetIsoDate: string, timeZone: string): string {
  const midnightRef = Date.parse(`${targetIsoDate}T12:00:00Z`);
  const weekday = Number.isNaN(midnightRef) ? "" : ` ${formatLocalDateTime(midnightRef, timeZone).weekdayZh}`;
  const mmdd = targetIsoDate.slice(5);

  if (deltaDays === 0) return `${mmdd}${weekday} (就是今天)`;
  if (deltaDays === 1) return `${mmdd}${weekday} (明天 · 还有 1 天)`;
  if (deltaDays > 1) return `${mmdd}${weekday} (还有 ${deltaDays} 天)`;
  if (deltaDays === -1) return `${mmdd}${weekday} (昨天 · 已过去 1 天)`;
  return `${mmdd}${weekday} (已过去 ${Math.abs(deltaDays)} 天)`;
}

/**
 * Render the ephemeral <time> card injected at the tail of the prompt.
 * Never persisted to conversation history so the prefix cache stays intact.
 */
export function renderTimeCard(input: TimeCardInput): string {
  const overrideValid =
    input.activeOverride && input.activeOverride.expiresAt > input.nowMs ? input.activeOverride : null;
  const effectiveTimezone = overrideValid?.tempTimezone || input.baseTimezone;
  const nowLocal = formatLocalDateTime(input.nowMs, effectiveTimezone);

  const lines: string[] = [
    `现在: ${nowLocal.fullStamp} (${effectiveTimezone}) · ${nowLocal.periodZh}`,
  ];

  const elapsedThresholdMs = (input.elapsedThresholdMinutes ?? 30) * 60_000;
  if (typeof input.lastUserMessageMs === "number") {
    const gapMs = input.nowMs - input.lastUserMessageMs;
    if (gapMs >= elapsedThresholdMs) {
      lines.push(`距用户上一条消息: ${formatDurationZh(gapMs)}`);
    }
  }

  if (overrideValid?.statusNote) {
    lines.push(`当前状态备注: ${overrideValid.statusNote}`);
  } else {
    const inQuiet = isWithinQuietHours(
      input.nowMs,
      effectiveTimezone,
      input.quietHours.start,
      input.quietHours.end,
    );
    lines.push(inQuiet ? "当前时段提示: 处于用户预设的夜间/休息免打扰时段" : "当前时段提示: 常规活跃时段");
  }

  if (input.upcomingMilestones && input.upcomingMilestones.length > 0) {
    const formatted = input.upcomingMilestones.map((item) => {
      const delta = diffCalendarDays(input.nowMs, item.isoDate, effectiveTimezone);
      return `${item.label} ${formatDayCountdown(delta, item.isoDate, effectiveTimezone)}`;
    });
    lines.push(`临近日期: ${formatted.join(" · ")}`);
  }

  return `<time>\n${lines.join("\n")}\n</time>`;
}

/**
 * Compute an immutable divider marker between two historical messages when their gap
 * exceeds the configured threshold.
 */
export function formatGapMarker(
  prevEpochMs: number,
  nextEpochMs: number,
  thresholdMinutes: number,
): string | null {
  const diffMs = nextEpochMs - prevEpochMs;
  if (diffMs < thresholdMinutes * 60_000) return null;
  return `—— ${formatDurationZh(diffMs)}后 ——`;
}
