import { summarizeError } from "../utils/logger.js";

const PURE_ERROR_NOTICE_RE =
  /^\[system_notice: reply_interrupted; count=(\d+); (?:reason|last_reason)="[^\n]*"; user_notified=true\]$/;

const ANY_ERROR_NOTICE_LINE_RE =
  /^\[system_notice: reply_interrupted; [^\n]*user_notified=true\]$/;

/**
 * Produces a concise, noise-free error reason suitable for structured system tags
 * (stripping URLs, stack traces, and nested JSON payloads).
 */
export function summarizeErrorForContext(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  const summarized = summarizeError(err);
  const combined = `${summarized}\n${raw}`;

  if (/\b429\b|RESOURCE_EXHAUSTED|quota\s+exceeded|rate[- ]?limit/i.test(combined)) {
    return "HTTP 429 quota/rate_limit";
  }
  if (/\b503\b|UNAVAILABLE|high demand|overloaded/i.test(combined)) {
    return "HTTP 503 model_unavailable";
  }
  if (/\b(500|502|504|52\d)\b|bad gateway|gateway timeout|internal server error/i.test(combined)) {
    return "HTTP 5xx upstream_error";
  }
  if (/\b(401|403)\b|unauthorized|forbidden|invalid api key|authentication/i.test(combined)) {
    return "HTTP 401/403 auth_error";
  }
  if (/\b400\b|context[- _]?length|too many tokens|maximum context/i.test(combined)) {
    return "HTTP 400 bad_request/context_limit";
  }
  if (
    /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network/i.test(
      combined,
    )
  ) {
    return "network_timeout_or_disconnect";
  }
  if (/AbortError|aborted|cancelled|canceled/i.test(combined)) {
    return "request_aborted";
  }

  const cleaned = summarized
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[{}\[\]"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "upstream_request_failed";
  }
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

function sanitizeTagValue(value: string): string {
  return value.replace(/["\r\n]+/g, "'").trim() || "unknown";
}

/**
 * Formats the assistant message persisted when a turn fails mid-flight or before replying.
 */
export function buildInterruptedAssistantText(params: {
  sentParts: string[];
  errorSummary: string;
  consecutiveCount?: number;
  delimiter?: string;
}): string {
  const safeReason = sanitizeTagValue(params.errorSummary);
  const parts = params.sentParts.map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0) {
    const notice = `[system_notice: reply_interrupted; stage=mid_turn; reason="${safeReason}"; user_notified=true]`;
    const sep = params.delimiter ?? "\n";
    return `${parts.join(sep)}\n${notice}`;
  }

  const count = Math.max(1, Math.floor(params.consecutiveCount ?? 1));
  if (count > 1) {
    return `[system_notice: reply_interrupted; count=${count}; last_reason="${safeReason}"; user_notified=true]`;
  }
  return `[system_notice: reply_interrupted; count=1; reason="${safeReason}"; user_notified=true]`;
}

/**
 * Parses a persisted message that contains only a system error-interruption notice
 * (so consecutive pure-error turns can be coalesced in place).
 */
export function parsePureErrorInterruptionNotice(content: string): { count: number } | null {
  const match = content.trim().match(PURE_ERROR_NOTICE_RE);
  if (!match) {
    return null;
  }
  const count = Number(match[1]);
  return Number.isFinite(count) && count >= 1 ? { count } : null;
}

/**
 * Removes transient error-interruption notice lines before feeding transcript text
 * into long-term memory extraction or rolling compaction summaries.
 */
export function stripErrorInterruptionNotices(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) => !ANY_ERROR_NOTICE_LINE_RE.test(line.trim()));
  return kept.join("\n").trim();
}
