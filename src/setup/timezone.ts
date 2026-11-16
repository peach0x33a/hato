export interface TimezoneOption {
  value: string;
  label: string;
  hint?: string;
}

const CURATED_TIMEZONES: ReadonlyArray<{ zone: string; title: string }> = [
  { zone: "Asia/Shanghai", title: "北京时间" },
  { zone: "Asia/Singapore", title: "新加坡时间" },
  { zone: "Asia/Tokyo", title: "东京时间" },
  { zone: "America/New_York", title: "美东时间" },
  { zone: "Europe/London", title: "伦敦时间" },
  { zone: "UTC", title: "协调世界时" },
];

export function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getSystemTimezone(fallback = "Asia/Shanghai"): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved && isValidTimeZone(resolved)) {
      return resolved;
    }
  } catch {
    // Ignore host locale lookup errors and return fallback.
  }
  return fallback;
}

export function formatUtcOffsetLabel(timeZone: string, date = new Date()): string {
  try {
    const raw =
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value ?? "UTC";
    if (raw === "GMT" || raw === "GMT+0" || raw === "UTC") return "UTC+0";
    return raw.replace(/^GMT/, "UTC");
  } catch {
    return "";
  }
}

/**
 * List all runtime-supported IANA time zones (guaranteed to include UTC) with UTC offsets for search.
 */
export function listAllTimezoneOptions(): TimezoneOption[] {
  const supported =
    typeof Intl.supportedValuesOf === "function" ? [...Intl.supportedValuesOf("timeZone")] : [];
  const zones = new Set<string>(supported);
  zones.add("UTC");
  return [...zones]
    .sort((a, b) => a.localeCompare(b))
    .map((zone) => ({
      value: zone,
      label: zone,
      hint: formatUtcOffsetLabel(zone),
    }));
}

export const MORE_TIMEZONES_VALUE = "__more_timezones__";

/**
 * Build the primary timezone select menu:
 * - Always places `系统时区 (<sysTz>)` first
 * - Includes curated common zones (deduplicated against sysTz & currentConfigTz)
 * - Ends with a "更多（搜索全部 IANA 时区）" trigger
 */
export function buildTimezoneMenu(params?: {
  systemTimezone?: string;
  currentConfiguredTimezone?: string;
}): {
  options: TimezoneOption[];
  initialValue: string;
} {
  const sysTz = params?.systemTimezone ?? getSystemTimezone();
  const seen = new Set<string>();
  const options: TimezoneOption[] = [];

  options.push({
    value: sysTz,
    label: `系统时区 (${sysTz})`,
    hint: formatUtcOffsetLabel(sysTz),
  });
  seen.add(sysTz);

  const configured = params?.currentConfiguredTimezone?.trim();
  const hasDistinctConfigured =
    Boolean(configured) && configured !== sysTz && isValidTimeZone(configured!);

  for (const item of CURATED_TIMEZONES) {
    if (seen.has(item.zone) || !isValidTimeZone(item.zone)) continue;
    seen.add(item.zone);
    options.push({
      value: item.zone,
      label: item.zone,
      hint: `${item.title} · ${formatUtcOffsetLabel(item.zone)}`,
    });
  }

  if (hasDistinctConfigured && configured && !seen.has(configured)) {
    seen.add(configured);
    options.push({
      value: configured,
      label: `${configured}（当前已配置）`,
      hint: formatUtcOffsetLabel(configured),
    });
  }

  options.push({
    value: MORE_TIMEZONES_VALUE,
    label: "更多...",
    hint: "搜索全部 IANA 时区",
  });

  return {
    options,
    initialValue: sysTz,
  };
}
