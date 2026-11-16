import { formatLocalDateTime } from "./clock.js";

export interface DateRangeResult {
  startMs: number;
  endMs: number;
  label: string;
}

/**
 * Convert a local YYYY-MM-DD wall-clock boundary (00:00:00) into UTC epoch ms
 * by iteratively refining against Intl output so DST/timezone offsets stay accurate.
 */
function localDateStartUtcMs(isoDate: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`Invalid ISO date: ${isoDate}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);

  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = formatLocalDateTime(guess, timeZone);
    const actualDay = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const targetDay = Date.UTC(y, m - 1, d, 0, 0, 0);
    const delta = targetDay - actualDay;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

function addCalendarDays(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Parse common Chinese relative date expressions into exact [startMs, endMs) UTC bounds
 * anchored to the user's timezone at nowMs.
 */
export function parseRelativeDateRange(
  query: string,
  nowMs: number,
  timeZone: string,
): DateRangeResult | null {
  const local = formatLocalDateTime(nowMs, timeZone);
  const today = local.isoDate;

  if (query.includes("今天") || query.includes("今日")) {
    return {
      startMs: localDateStartUtcMs(today, timeZone),
      endMs: localDateStartUtcMs(addCalendarDays(today, 1), timeZone),
      label: "今天",
    };
  }
  if (query.includes("昨天") || query.includes("昨日")) {
    const start = addCalendarDays(today, -1);
    return {
      startMs: localDateStartUtcMs(start, timeZone),
      endMs: localDateStartUtcMs(today, timeZone),
      label: "昨天",
    };
  }
  if (query.includes("前天")) {
    const start = addCalendarDays(today, -2);
    const end = addCalendarDays(today, -1);
    return {
      startMs: localDateStartUtcMs(start, timeZone),
      endMs: localDateStartUtcMs(end, timeZone),
      label: "前天",
    };
  }
  if (query.includes("上周")) {
    const weekdayIndex = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    const mondayOffset = weekdayIndex === 0 ? -6 : 1 - weekdayIndex;
    const thisMonday = addCalendarDays(today, mondayOffset);
    const lastMonday = addCalendarDays(thisMonday, -7);
    return {
      startMs: localDateStartUtcMs(lastMonday, timeZone),
      endMs: localDateStartUtcMs(thisMonday, timeZone),
      label: "上周",
    };
  }
  if (query.includes("本周") || query.includes("这周")) {
    const weekdayIndex = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    const mondayOffset = weekdayIndex === 0 ? -6 : 1 - weekdayIndex;
    const thisMonday = addCalendarDays(today, mondayOffset);
    const nextMonday = addCalendarDays(thisMonday, 7);
    return {
      startMs: localDateStartUtcMs(thisMonday, timeZone),
      endMs: localDateStartUtcMs(nextMonday, timeZone),
      label: "本周",
    };
  }
  if (query.includes("上个月") || query.includes("上月")) {
    const prevMonth = local.month === 1 ? 12 : local.month - 1;
    const prevYear = local.month === 1 ? local.year - 1 : local.year;
    const start = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
    const end = `${local.year}-${String(local.month).padStart(2, "0")}-01`;
    return {
      startMs: localDateStartUtcMs(start, timeZone),
      endMs: localDateStartUtcMs(end, timeZone),
      label: "上个月",
    };
  }

  const recentDaysMatch = /最近\s*(\d+)\s*天/.exec(query);
  if (recentDaysMatch) {
    const days = Math.max(1, Math.min(365, Number(recentDaysMatch[1])));
    const start = addCalendarDays(today, -(days - 1));
    return {
      startMs: localDateStartUtcMs(start, timeZone),
      endMs: localDateStartUtcMs(addCalendarDays(today, 1), timeZone),
      label: `最近 ${days} 天`,
    };
  }

  const explicitDateMatch = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(query);
  if (explicitDateMatch) {
    const target = `${explicitDateMatch[1]}-${explicitDateMatch[2]!.padStart(2, "0")}-${explicitDateMatch[3]!.padStart(2, "0")}`;
    return {
      startMs: localDateStartUtcMs(target, timeZone),
      endMs: localDateStartUtcMs(addCalendarDays(target, 1), timeZone),
      label: target,
    };
  }

  return null;
}
