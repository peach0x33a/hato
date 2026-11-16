import { getSystemTimezone } from "../setup/timezone.js";
import { formatLocalDateTime } from "../time/clock.js";

export interface LogFormatOptions {
  timeZone?: string;
  timestampMs?: number;
  color?: boolean;
}

interface CategoryStyle {
  category: string;
  scope: string;
  body?: string;
}

const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  MSG: { category: "1;36", scope: "36" },
  LLM: { category: "1;35", scope: "35" },
  SYS: { category: "1;32", scope: "32" },
  WARN: { category: "1;33", scope: "33", body: "33" },
  ERR: { category: "1;31", scope: "31", body: "31" },
};

let defaultLogTimeZone = getSystemTimezone();

/**
 * Sets the process-wide default timezone used by runtime log timestamps.
 */
export function setLogTimezone(timeZone: string): void {
  const trimmed = timeZone.trim();
  if (trimmed) {
    defaultLogTimeZone = trimmed;
  }
}

/**
 * Returns the current default timezone used by runtime log timestamps.
 */
export function getLogTimezone(): string {
  return defaultLogTimeZone;
}

/**
 * Determines whether ANSI colors should be emitted for the target stream.
 */
export function shouldUseColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== "0" && process.env.FORCE_COLOR !== "";
  }
  return Boolean(stream.isTTY);
}

/**
 * Wraps text with an ANSI SGR sequence when color output is enabled.
 */
export function colorize(text: string, sgrCode: string, enabled: boolean): string {
  return enabled ? `\x1b[${sgrCode}m${text}\x1b[0m` : text;
}

/**
 * Formats an epoch timestamp as `YYYY-MM-DD HH:mm:ss` in the given or default timezone.
 */
export function formatLogTimestamp(
  timestampMs: number = Date.now(),
  timeZone: string = defaultLogTimeZone,
): string {
  const parts = formatLocalDateTime(timestampMs, timeZone);
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  const ss = String(parts.second).padStart(2, "0");
  return `${parts.isoDate} ${hh}:${mm}:${ss}`;
}

/**
 * Formats a structured log line matching `[CATEGORY] [SCOPE] [YYYY-MM-DD HH:mm:ss] message`.
 */
export function formatLogLine(
  category: string,
  scope: string,
  message: string,
  opts?: LogFormatOptions,
): string {
  const normalizedCategory = category.toUpperCase();
  const normalizedScope = scope.toUpperCase();
  const ts = formatLogTimestamp(opts?.timestampMs, opts?.timeZone);
  const useColor = opts?.color ?? shouldUseColor(process.stdout);

  const style = CATEGORY_STYLES[normalizedCategory] ?? { category: "1", scope: "1" };
  const categoryTag = colorize(`[${normalizedCategory}]`, style.category, useColor);
  const scopeTag = colorize(`[${normalizedScope}]`, style.scope, useColor);
  const timeTag = colorize(`[${ts}]`, "2", useColor);
  const body = style.body ? colorize(message, style.body, useColor) : message;

  return `${categoryTag} ${scopeTag} ${timeTag} ${body}`;
}

/**
 * Writes an informational system log line to stdout.
 */
export function logInfo(scope: string, message: string, opts?: LogFormatOptions): void {
  console.log(
    formatLogLine("SYS", scope, message, {
      ...opts,
      color: opts?.color ?? shouldUseColor(process.stdout),
    }),
  );
}

/**
 * Writes a warning log line to stderr/console.warn.
 */
export function logWarn(scope: string, message: string, opts?: LogFormatOptions): void {
  console.warn(
    formatLogLine("WARN", scope, message, {
      ...opts,
      color: opts?.color ?? shouldUseColor(process.stderr),
    }),
  );
}

/**
 * Redacts Telegram bot tokens and bearer secrets before printing error details to logs.
 */
export function redactSensitiveTokens(text: string): string {
  return text
    .replace(/(\/bot)\d+:[A-Za-z0-9_-]+/g, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***");
}

/**
 * Formats an error into a concise single-line summary (name/code + cause chain) without dumping stack traces.
 */
export function summarizeError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = err;

  for (let depth = 0; depth < 3 && cursor !== undefined && cursor !== null; depth++) {
    if (typeof cursor === "object") {
      if (seen.has(cursor)) break;
      seen.add(cursor);
    }

    if (cursor instanceof Error) {
      const rec = cursor as Error & {
        code?: unknown;
        errno?: unknown;
        error_code?: unknown;
        error?: unknown;
        cause?: unknown;
      };
      const tag =
        typeof rec.code === "string" && rec.code
          ? rec.code
          : typeof rec.error_code === "number"
            ? `${cursor.name} (${rec.error_code})`
            : cursor.name || "Error";
      const msg = redactSensitiveTokens(cursor.message.replace(/\s+/g, " ").trim());
      parts.push(msg ? `${tag}: ${msg}` : tag);
      cursor = rec.error ?? rec.cause;
      continue;
    }

    const raw = redactSensitiveTokens(String(cursor).replace(/\s+/g, " ").trim());
    if (raw) parts.push(raw);
    break;
  }

  return parts.join(" <- ") || "Unknown error";
}

/**
 * Writes an error log line with a concise, redacted single-line error summary to stderr.
 */
export function logError(
  scope: string,
  message: string,
  err?: unknown,
  opts?: LogFormatOptions,
): void {
  const fullMessage = err !== undefined ? `${message}: ${summarizeError(err)}` : message;
  const line = formatLogLine("ERR", scope, fullMessage, {
    ...opts,
    color: opts?.color ?? shouldUseColor(process.stderr),
  });
  console.error(line);
}
