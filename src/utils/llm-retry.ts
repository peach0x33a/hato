import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import { logError, logWarn, redactSensitiveTokens, summarizeError } from "./logger.js";
import { computeBackoffDelayMs, retryWithBackoff, type RetryPolicyConfig } from "./retry.js";

export interface LlmRetryConfig extends RetryPolicyConfig {
  /** 1-based retry attempt at which to notify the user if still failing (0 disables). */
  notifyAfterRetry: number;
}

export const DEFAULT_LLM_RETRY_CONFIG: LlmRetryConfig = {
  maxRetries: 5,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 15_000,
  jitter: true,
  notifyAfterRetry: 3,
};

export interface LlmRetryNotice {
  retryNumber: number;
  maxRetries: number;
  delayMs: number;
  errorSummary: string;
}

export interface StreamRetryOptions {
  policy?: Partial<LlmRetryConfig>;
  signal?: AbortSignal;
  model?: Pick<Model<Api>, "api" | "provider" | "id">;
  slot?: string;
  onRetryNotice?: (notice: LlmRetryNotice) => void | Promise<void>;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  randomFn?: () => number;
}

const NON_RETRYABLE_PATTERNS = [
  /\b(400|401|403|404)\b/,
  /\b(INVALID_ARGUMENT|UNAUTHENTICATED|PERMISSION_DENIED|NOT_FOUND)\b/i,
  /insufficient_quota|quota exceeded|billing|out of budget|context_length_exceeded/i,
];

const RETRYABLE_PATTERNS = [
  /\b(429|500|502|503|504|520|521|522|523|524|529)\b/,
  /\b(UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL)\b/,
  /currently experiencing high demand/i,
  /high demand/i,
  /overloaded|server_busy|servers are currently busy|model is at capacity/i,
  /rate.?limit|too many requests|try again later/i,
  /service.?(?:is.?)?(?:temporarily.?)?unavailable|bad gateway|gateway timeout/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNABORTED|UND_ERR_/i,
  /fetch failed|socket hang up|premature close|connection closed|other side closed|network.?error|timed? out/i,
  /incomplete json segment|unexpected end of json input|unterminated string in json|unexpected eof|stream ended unexpectedly/i,
];

function extractErrorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const rec = err as Error & { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    const extra = [rec.code, rec.status, rec.statusCode].filter((v) => v !== undefined).join(" ");
    const causeText = rec.cause ? ` ${extractErrorText(rec.cause)}` : "";
    return `${err.name} ${extra} ${err.message}${causeText}`.trim();
  }
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err ?? "");
}

function isAbortLike(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  const text = extractErrorText(err).toLowerCase();
  return text.includes("request was aborted") || text.includes("aborterror");
}

/**
 * Classifies whether an LLM error (AssistantMessage or thrown exception) is transient and safe to retry.
 */
export function isRetryableLlmError(errOrMessage: unknown): boolean {
  if (errOrMessage && typeof errOrMessage === "object" && "role" in errOrMessage) {
    const msg = errOrMessage as AssistantMessage;
    if (msg.stopReason === "aborted") return false;
    if (isRetryableAssistantError(msg)) return true;
    const text = msg.errorMessage ?? "";
    if (!text) return false;
    return isRetryableLlmError(text);
  }

  if (isAbortLike(errOrMessage)) return false;
  const text = extractErrorText(errOrMessage);
  if (!text) return false;

  if (RETRYABLE_PATTERNS.some((re) => re.test(text))) {
    return true;
  }
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(text))) {
    return false;
  }
  return false;
}

export function formatLlmRetryNotice(notice: LlmRetryNotice): string {
  return `模型服务暂时拥挤，正在继续自动重试（第 ${notice.retryNumber}/${notice.maxRetries} 次仍未恢复），请稍等一下…`;
}

export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildSyntheticErrorMessage(
  errorText: string,
  stopReason: "error" | "aborted",
  model?: Pick<Model<Api>, "api" | "provider" | "id">,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model?.api ?? ("google-generative-ai" as Api),
    provider: model?.provider ?? "unknown",
    model: model?.id ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: errorText,
    timestamp: Date.now(),
  };
}

function resolveEffectivePolicy(policy?: Partial<LlmRetryConfig>): LlmRetryConfig {
  return {
    maxRetries: policy?.maxRetries ?? DEFAULT_LLM_RETRY_CONFIG.maxRetries,
    initialDelayMs: policy?.initialDelayMs ?? DEFAULT_LLM_RETRY_CONFIG.initialDelayMs,
    backoffMultiplier: policy?.backoffMultiplier ?? DEFAULT_LLM_RETRY_CONFIG.backoffMultiplier,
    maxDelayMs: policy?.maxDelayMs ?? DEFAULT_LLM_RETRY_CONFIG.maxDelayMs,
    jitter: policy?.jitter ?? DEFAULT_LLM_RETRY_CONFIG.jitter,
    notifyAfterRetry: policy?.notifyAfterRetry ?? DEFAULT_LLM_RETRY_CONFIG.notifyAfterRetry,
  };
}

function formatLlmFailureContext(
  slot?: string,
  model?: Pick<Model<Api>, "api" | "provider" | "id"> & { baseUrl?: string },
): string {
  const parts: string[] = [];
  if (slot?.trim()) {
    parts.push(`[${slot.trim().toUpperCase()}]`);
  }
  if (model) {
    const modelLabel = `${model.provider}/${model.id}`;
    const apiLabel = String(model.api);
    const baseUrl = model.baseUrl?.trim() ? redactSensitiveTokens(model.baseUrl.trim()) : "";
    parts.push(
      baseUrl ? `${modelLabel} (${apiLabel} @ ${baseUrl})` : `${modelLabel} (${apiLabel})`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : "LLM request";
}

/**
 * Wraps a `streamSimple` invocation with automatic exponential-backoff retries on transient LLM errors
 * (e.g. HTTP 503/429/5xx or network failures) before any content delta is emitted.
 */
export function streamSimpleWithRetry(
  createStream: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  options: StreamRetryOptions = {},
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  const policy = resolveEffectivePolicy(options.policy);
  const maxRetries = Math.max(0, Math.floor(policy.maxRetries));
  const notifyAfterRetry = Math.max(0, Math.floor(policy.notifyAfterRetry));
  const sleep = options.sleepFn ?? abortableSleep;

  void (async () => {
    let notifiedUser = false;
    let lastErrorMessage: AssistantMessage | null = null;

    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) {
        const abortedMsg = lastErrorMessage
          ? { ...lastErrorMessage, stopReason: "aborted" as const, errorMessage: "Request was aborted" }
          : buildSyntheticErrorMessage("Request was aborted", "aborted", options.model);
        outer.push({ type: "error", reason: "aborted", error: abortedMsg });
        outer.end(abortedMsg);
        return;
      }

      const buffered: AssistantMessageEvent[] = [];
      let hasEmittedContent = false;
      let retryErrorSummary: string | null = null;

      try {
        const inner = await createStream();
        for await (const event of inner) {
          if (hasEmittedContent) {
            outer.push(event);
            if (event.type === "done" || event.type === "error") {
              outer.end();
              return;
            }
            continue;
          }

          if (event.type === "error") {
            lastErrorMessage = event.error;
            if (!options.signal?.aborted && attempt < maxRetries && isRetryableLlmError(event.error)) {
              retryErrorSummary = summarizeError(event.error.errorMessage ?? "LLM transient error");
              break;
            }
            if (event.reason !== "aborted" && !options.signal?.aborted) {
              logError(
                "LLM",
                `${formatLlmFailureContext(options.slot, options.model)} failed: ${summarizeError(
                  event.error.errorMessage ?? "LLM error",
                )}`,
              );
            }
            for (const b of buffered) outer.push(b);
            outer.push(event);
            outer.end();
            return;
          }

          if (event.type === "done") {
            for (const b of buffered) outer.push(b);
            outer.push(event);
            outer.end();
            return;
          }

          const hasVisibleContent =
            (event.type === "text_delta" && event.delta.length > 0) ||
            event.type === "toolcall_delta" ||
            event.type === "toolcall_end";

          if (!hasVisibleContent) {
            buffered.push(event);
            continue;
          }

          hasEmittedContent = true;
          for (const b of buffered) outer.push(b);
          outer.push(event);
        }

        if (retryErrorSummary === null) {
          if (hasEmittedContent) {
            outer.end();
            return;
          }
          const fallbackMsg =
            lastErrorMessage ??
            buildSyntheticErrorMessage("LLM stream ended unexpectedly without output", "error", options.model);
          if (!options.signal?.aborted && attempt < maxRetries && isRetryableLlmError(fallbackMsg)) {
            retryErrorSummary = summarizeError(fallbackMsg.errorMessage ?? "LLM stream ended unexpectedly");
          } else {
            if (!options.signal?.aborted && fallbackMsg.stopReason === "error") {
              logError(
                "LLM",
                `${formatLlmFailureContext(options.slot, options.model)} failed: ${summarizeError(
                  fallbackMsg.errorMessage ?? "LLM stream ended unexpectedly",
                )}`,
              );
            }
            for (const b of buffered) outer.push(b);
            outer.push({ type: "error", reason: "error", error: fallbackMsg });
            outer.end(fallbackMsg);
            return;
          }
        }
      } catch (err) {
        if (hasEmittedContent) {
          const msg = buildSyntheticErrorMessage(summarizeError(err), "error", options.model);
          if (!options.signal?.aborted) {
            logError(
              "LLM",
              `${formatLlmFailureContext(options.slot, options.model)} failed`,
              err,
            );
          }
          outer.push({ type: "error", reason: "error", error: msg });
          outer.end(msg);
          return;
        }
        if (!options.signal?.aborted && attempt < maxRetries && isRetryableLlmError(err)) {
          retryErrorSummary = summarizeError(err);
        } else {
          const stopReason = isAbortLike(err) || options.signal?.aborted ? "aborted" : "error";
          if (stopReason === "error") {
            logError(
              "LLM",
              `${formatLlmFailureContext(options.slot, options.model)} failed`,
              err,
            );
          }
          const msg = buildSyntheticErrorMessage(summarizeError(err), stopReason, options.model);
          for (const b of buffered) outer.push(b);
          outer.push({ type: "error", reason: stopReason, error: msg });
          outer.end(msg);
          return;
        }
      }

      const retryNumber = attempt + 1;
      const delayMs = computeBackoffDelayMs(attempt, policy, { randomFn: options.randomFn });
      const slotTag = options.slot ? `[${options.slot}] ` : "";
      logWarn(
        "LLM",
        `${slotTag}transient error, retry ${retryNumber}/${maxRetries} in ${delayMs}ms: ${retryErrorSummary}`,
      );

      if (notifyAfterRetry > 0 && retryNumber === notifyAfterRetry && !notifiedUser) {
        notifiedUser = true;
        if (options.onRetryNotice) {
          await Promise.resolve(
            options.onRetryNotice({
              retryNumber,
              maxRetries,
              delayMs,
              errorSummary: retryErrorSummary ?? "LLM transient error",
            }),
          ).catch(() => undefined);
        }
      }

      try {
        await sleep(delayMs, options.signal);
      } catch {
        const abortedMsg = lastErrorMessage
          ? { ...lastErrorMessage, stopReason: "aborted" as const, errorMessage: "Request was aborted" }
          : buildSyntheticErrorMessage("Request was aborted", "aborted", options.model);
        outer.push({ type: "error", reason: "aborted", error: abortedMsg });
        outer.end(abortedMsg);
        return;
      }
    }
  })();

  return outer;
}

/**
 * Executes a non-streaming `completeSimple` call with exponential-backoff retries on transient LLM errors.
 */
export async function completeSimpleWithRetry<T extends AssistantMessage>(
  fn: () => Promise<T>,
  options: StreamRetryOptions = {},
): Promise<T> {
  const policy = resolveEffectivePolicy(options.policy);
  let notifiedUser = false;

  try {
    const res = await retryWithBackoff(
      async (attempt) => {
        if (options.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const res = await fn();
        if (res.stopReason === "error" && !options.signal?.aborted && attempt < policy.maxRetries && isRetryableLlmError(res)) {
          const err = new Error(res.errorMessage || "LLM transient error");
          const retryNumber = attempt + 1;
          if (policy.notifyAfterRetry > 0 && retryNumber === policy.notifyAfterRetry && !notifiedUser) {
            notifiedUser = true;
            await Promise.resolve(
              options.onRetryNotice?.({
                retryNumber,
                maxRetries: policy.maxRetries,
                delayMs: 0,
                errorSummary: summarizeError(res.errorMessage ?? "LLM transient error"),
              }),
            ).catch(() => undefined);
          }
          throw err;
        }
        return res;
      },
      {
        policy,
        shouldRetry: (err) => !options.signal?.aborted && isRetryableLlmError(err),
        sleepFn: (ms) => (options.sleepFn ?? abortableSleep)(ms, options.signal),
        randomFn: options.randomFn,
      },
    );
    if (res.stopReason === "error" && !options.signal?.aborted) {
      logError(
        "LLM",
        `${formatLlmFailureContext(options.slot, options.model)} failed: ${summarizeError(
          res.errorMessage ?? "LLM error",
        )}`,
      );
    }
    return res;
  } catch (err) {
    if (!isAbortLike(err) && !options.signal?.aborted) {
      logError("LLM", `${formatLlmFailureContext(options.slot, options.model)} failed`, err);
    }
    throw err;
  }
}
