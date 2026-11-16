const WEEKDAYS_ZH: Record<string, string> = {
  Sun: "周日",
  Mon: "周一",
  Tue: "周二",
  Wed: "周三",
  Thu: "周四",
  Fri: "周五",
  Sat: "周六",
};

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekdayZh: string;
  periodZh: string;
  /** YYYY-MM-DD in target timezone */
  isoDate: string;
  /** MM-DD HH:mm in target timezone */
  compactStamp: string;
  /** YYYY-MM-DD 周X HH:mm */
  fullStamp: string;
}

function getPeriodZh(hour: number): string {
  if (hour < 5) return "凌晨";
  if (hour < 9) return "早上";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 23) return "晚上";
  return "深夜";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Convert an epoch millisecond timestamp to calendar components in an IANA timezone.
 */
export function formatLocalDateTime(epochMs: number, timeZone: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(epochMs));
  const lookup = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "literal") {
      lookup.set(part.type, part.value);
    }
  }

  const year = Number(lookup.get("year"));
  const month = Number(lookup.get("month"));
  const day = Number(lookup.get("day"));
  const rawHour = Number(lookup.get("hour"));
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(lookup.get("minute"));
  const second = Number(lookup.get("second"));
  const weekdayShort = lookup.get("weekday") ?? "Mon";
  const weekdayZh = WEEKDAYS_ZH[weekdayShort] ?? weekdayShort;
  const periodZh = getPeriodZh(hour);

  const isoDate = `${year}-${pad2(month)}-${pad2(day)}`;
  const compactStamp = `${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`;
  const fullStamp = `${isoDate} ${weekdayZh} ${pad2(hour)}:${pad2(minute)}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekdayZh,
    periodZh,
    isoDate,
    compactStamp,
    fullStamp,
  };
}

function parseHhMmToMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) {
    throw new Error(`Invalid HH:mm time string: "${hhmm}"`);
  }
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Out-of-range HH:mm time string: "${hhmm}"`);
  }
  return h * 60 + m;
}

/**
 * Check whether epochMs falls within [start, end) quiet hours in the user's timezone.
 * Correctly handles overnight spans such as 23:30 -> 08:00.
 */
export function isWithinQuietHours(
  epochMs: number,
  timeZone: string,
  startHhMm: string,
  endHhMm: string,
): boolean {
  const local = formatLocalDateTime(epochMs, timeZone);
  const currentMinutes = local.hour * 60 + local.minute;
  const startMinutes = parseHhMmToMinutes(startHhMm);
  const endMinutes = parseHhMmToMinutes(endHhMm);

  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Compute calendar-day difference (targetDate - localDate(nowMs)) in the given timezone.
 * Positive means targetDate is in the future; 0 means today; negative means in the past.
 */
export function diffCalendarDays(nowMs: number, targetIsoDate: string, timeZone: string): number {
  const todayIso = formatLocalDateTime(nowMs, timeZone).isoDate;
  const matchToday = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayIso);
  const matchTarget = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetIsoDate.trim());
  if (!matchToday || !matchTarget) {
    throw new Error(`Invalid ISO date for diffCalendarDays: ${targetIsoDate}`);
  }

  const todayUtc = Date.UTC(Number(matchToday[1]), Number(matchToday[2]) - 1, Number(matchToday[3]));
  const targetUtc = Date.UTC(Number(matchTarget[1]), Number(matchTarget[2]) - 1, Number(matchTarget[3]));
  return Math.round((targetUtc - todayUtc) / 86_400_000);
}

/**
 * Format an elapsed millisecond duration into concise Chinese text.
 */
export function formatDurationZh(durationMs: number): string {
  const safeMs = Math.max(0, durationMs);
  const totalMinutes = Math.floor(safeMs / 60_000);
  if (totalMinutes < 1) return "刚刚";
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;

  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return remMinutes > 0 ? `${totalHours} 小时 ${remMinutes} 分钟` : `${totalHours} 小时`;
  }

  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days} 天 ${remHours} 小时` : `${days} 天`;
}
