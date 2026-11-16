export interface RetryPolicyConfig {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface RetryExecutionOptions {
  policy: RetryPolicyConfig;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  getRetryAfterMs?: (err: unknown) => number | undefined;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Computes exponential backoff delay (in ms) for a 0-based retry attempt index,
 * applying optional ±20% jitter and honoring upstream retry-after hints when provided.
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: RetryPolicyConfig,
  options?: { retryAfterMs?: number; randomFn?: () => number },
): number {
  const safeInitial = Math.max(0, policy.initialDelayMs);
  const safeMax = Math.max(0, policy.maxDelayMs);
  const safeMultiplier = Math.max(1, policy.backoffMultiplier);

  const raw = Math.round(safeInitial * Math.pow(safeMultiplier, Math.max(0, attempt)));
  let delay = safeMax > 0 ? Math.min(safeMax, raw) : raw;

  if (policy.jitter && delay > 0) {
    const rand = options?.randomFn ? options.randomFn() : Math.random();
    const factor = 0.8 + rand * 0.4;
    delay = Math.round(delay * factor);
    if (safeMax > 0) {
      delay = Math.min(safeMax, delay);
    }
  }

  const retryAfterMs = options?.retryAfterMs;
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    delay = Math.max(delay, Math.round(retryAfterMs));
  }

  return Math.max(0, delay);
}

/**
 * Executes an async operation with silent exponential-backoff retries.
 * Throws the final error only after retries are exhausted or `shouldRetry` returns false.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryExecutionOptions,
): Promise<T> {
  const maxRetries = Math.max(0, Math.floor(options.policy.maxRetries));
  const sleepFn = options.sleepFn ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries) {
        throw err;
      }
      if (options.shouldRetry && !options.shouldRetry(err, attempt)) {
        throw err;
      }

      const retryAfterMs = options.getRetryAfterMs?.(err);
      const delayMs = computeBackoffDelayMs(attempt, options.policy, {
        retryAfterMs,
        randomFn: options.randomFn,
      });
      await sleepFn(delayMs);
    }
  }
}
