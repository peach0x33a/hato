import { getSystemTimezone } from "../setup/timezone.js";
import { formatLocalDateTime } from "../time/clock.js";

export interface LogFormatOptions {
  timeZone?: string;
  timestampMs?: number;
  color?: boolean;
  record?: boolean;
}

export interface RuntimeLogEntry {
  id: number;
  timestampMs: number;
  timeText: string;
  category: string;
  scope: string;
  message: string;
}

const MAX_RUNTIME_LOGS = 1000;
const runtimeLogBuffer: RuntimeLogEntry[] = [];
const runtimeLogSubscribers = new Set<(entry: RuntimeLogEntry) => void>();
let nextRuntimeLogId = 1;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function recordRuntimeLog(entry: Omit<RuntimeLogEntry, "id">): void {
  const stored: RuntimeLogEntry = {
    id: nextRuntimeLogId++,
    ...entry,
  };
  runtimeLogBuffer.push(stored);
  if (runtimeLogBuffer.length > MAX_RUNTIME_LOGS) {
    runtimeLogBuffer.splice(0, runtimeLogBuffer.length - MAX_RUNTIME_LOGS);
  }
  for (const listener of runtimeLogSubscribers) {
    try {
      listener(stored);
    } catch {
      // Never allow log subscribers to break logging.
    }
  }
}

export function getRuntimeLogs(opts?: {
  limit?: number;
  category?: string;
  scope?: string;
  q?: string;
}): RuntimeLogEntry[] {
  const categoryFilter = opts?.category?.trim().toUpperCase();
  const scopeFilter = opts?.scope?.trim().toUpperCase();
  const queryFilter = opts?.q?.trim().toLowerCase();
  const limit =
    typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(MAX_RUNTIME_LOGS, Math.floor(opts.limit))
      : MAX_RUNTIME_LOGS;

  const filtered = runtimeLogBuffer.filter((entry) => {
    if (categoryFilter && categoryFilter !== "ALL" && entry.category !== categoryFilter) {
      return false;
    }
    if (scopeFilter && !entry.scope.includes(scopeFilter)) {
      return false;
    }
    if (queryFilter) {
      const hay = `${entry.category} ${entry.scope} ${entry.message}`.toLowerCase();
      if (!hay.includes(queryFilter)) return false;
    }
    return true;
  });

  if (filtered.length <= limit) {
    return [...filtered];
  }
  return filtered.slice(filtered.length - limit);
}

export function subscribeRuntimeLogs(listener: (entry: RuntimeLogEntry) => void): () => void {
  runtimeLogSubscribers.add(listener);
  return () => {
    runtimeLogSubscribers.delete(listener);
  };
}

export function clearRuntimeLogs(): void {
  runtimeLogBuffer.length = 0;
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
  const timestampMs = opts?.timestampMs ?? Date.now();
  const ts = formatLogTimestamp(timestampMs, opts?.timeZone);
  const useColor = opts?.color ?? shouldUseColor(process.stdout);

  if (opts?.record !== false) {
    recordRuntimeLog({
      timestampMs,
      timeText: ts,
      category: normalizedCategory,
      scope: normalizedScope,
      message: redactSensitiveTokens(stripAnsi(message)),
    });
  }

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

function unwrapNestedApiErrorJson(raw: string): string | null {
  const startIdx = raw.indexOf("{");
  if (startIdx < 0) return null;
  const candidate = raw.slice(startIdx).trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;

  let current: unknown;
  try {
    current = JSON.parse(candidate);
  } catch {
    return null;
  }

  let code: string | number | undefined;
  let status: string | undefined;
  let message: string | undefined;

  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const rec = current as Record<string, unknown>;
    const errObj =
      rec.error && typeof rec.error === "object" && !Array.isArray(rec.error)
        ? (rec.error as Record<string, unknown>)
        : rec;

    if (typeof errObj.code === "number" || typeof errObj.code === "string") {
      code = errObj.code;
    }
    if (typeof errObj.status === "string" && errObj.status.trim()) {
      status = errObj.status.trim();
    }

    const msg = typeof errObj.message === "string" ? errObj.message.trim() : "";
    if (!msg) break;
    message = msg;

    if (msg.startsWith("{")) {
      try {
        current = JSON.parse(msg);
        continue;
      } catch {
        break;
      }
    }
    break;
  }

  if (!message && code === undefined && !status) return null;
  const prefix = raw.slice(0, startIdx).trim();
  const codePart = code !== undefined ? `HTTP ${code}` : "";
  const statusPart = status ? `(${status})` : "";
  const header = [prefix, codePart, statusPart].filter(Boolean).join(" ");
  const body = message ? message.replace(/\s+/g, " ").trim() : "";
  const combined = header && body ? `${header}: ${body}` : header || body;
  return combined.length > 600 ? `${combined.slice(0, 597)}...` : combined;
}

function formatReadableErrorText(raw: string): string {
  const collapsed = redactSensitiveTokens(raw.replace(/\s+/g, " ").trim());
  if (!collapsed) return "";

  if (/<html[\s>]|<!doctype\s+html/i.test(collapsed)) {
    const titleMatch = collapsed.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim();
    const isCf = /cdn-cgi|cloudflare|cf-wrapper|cf-error-details/i.test(collapsed);
    const statusMatch =
      title?.match(/\b(403|429|500|502|503|504|52[0-9])\b/) ??
      collapsed.match(/\b(502|503|504|52[0-9])\b/);
    const statusText = statusMatch ? statusMatch[1] : "HTTP Error";
    const source = isCf ? "Cloudflare 上游网关" : "上游网关";
    if (title) {
      return `${source}返回错误 (${title})，请稍后重试`;
    }
    return `${source}返回 ${statusText} 错误，请稍后重试`;
  }

  const unwrapped = unwrapNestedApiErrorJson(raw.trim());
  if (unwrapped) {
    return redactSensitiveTokens(unwrapped);
  }

  return collapsed.length > 600 ? `${collapsed.slice(0, 597)}...` : collapsed;
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
      const msg = formatReadableErrorText(cursor.message);
      parts.push(msg ? `${tag}: ${msg}` : tag);
      cursor = rec.error ?? rec.cause;
      continue;
    }

    const raw = formatReadableErrorText(String(cursor));
    if (raw) parts.push(raw);
    break;
  }

  return parts.join(" <- ") || "Unknown error";
}

/**
 * Formats an LLM/turn failure into a concise, user-friendly IM message without raw JSON dumps.
 */
export function formatUserFacingTurnError(err: unknown): string {
  const summary = summarizeError(err);
  if (/User location is not supported/i.test(summary)) {
    return "模型接口返回地区限制（400 User location is not supported），请检查代理路由配置或切换模型～";
  }
  if (/\b503\b|UNAVAILABLE|high demand|overloaded|model is at capacity/i.test(summary)) {
    return "模型服务当前繁忙（503），自动重试后仍未恢复，请稍后再试～";
  }
  if (/\b429\b|RESOURCE_EXHAUSTED|rate.?limit|too many requests|quota/i.test(summary)) {
    return "模型接口触发限流或额度上限（429），请稍后再试～";
  }
  if (
    /incomplete json segment|unexpected end of json input|stream ended unexpectedly|ECONNRESET|timed? out/i.test(
      summary,
    )
  ) {
    return "模型连接或响应流意外中断，请再发一次试试～";
  }
  const clipped = summary.length > 180 ? `${summary.slice(0, 177)}...` : summary;
  return `处理刚才这条消息时出错了：${clipped}`;
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
