import assert from "node:assert/strict";
import test from "node:test";
import { GrammyError, HttpError } from "grammy";
import { resolveGatewayRetryConfig, validateHatoConfigObject } from "../src/config/app.js";
import { getTelegramRetryAfterMs, isRetryableTelegramError } from "../src/gateway/tg.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { redactSensitiveTokens, summarizeError } from "../src/utils/logger.js";
import { computeBackoffDelayMs, retryWithBackoff } from "../src/utils/retry.js";

test("computeBackoffDelayMs and retryWithBackoff implement configurable exponential backoff", async () => {
  const policy = {
    maxRetries: 3,
    initialDelayMs: 100,
    backoffMultiplier: 2,
    maxDelayMs: 350,
    jitter: false,
  };

  assert.equal(computeBackoffDelayMs(0, policy), 100);
  assert.equal(computeBackoffDelayMs(1, policy), 200);
  assert.equal(computeBackoffDelayMs(2, policy), 350);
  assert.equal(computeBackoffDelayMs(0, { ...policy, jitter: true }, { randomFn: () => 0 }), 80);
  assert.equal(computeBackoffDelayMs(0, { ...policy, jitter: true }, { randomFn: () => 1 }), 120);
  assert.equal(computeBackoffDelayMs(0, policy, { retryAfterMs: 1500 }), 1500);

  const delays: number[] = [];
  let attempts = 0;
  const value = await retryWithBackoff(
    async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("ECONNRESET transient");
      }
      return "ok";
    },
    {
      policy,
      shouldRetry: () => true,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    },
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);

  let nonRetryableAttempts = 0;
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          nonRetryableAttempts++;
          throw new Error("Bad Request");
        },
        {
          policy,
          shouldRetry: () => false,
          sleepFn: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    /Bad Request/,
  );
  assert.equal(nonRetryableAttempts, 1);
});

test("isRetryableTelegramError distinguishes transient network/429/5xx errors from permanent 4xx", () => {
  const netErr = new HttpError("Network request for 'sendMessage' failed!", {
    code: "ECONNRESET",
    message: "socket disconnected",
  });
  assert.equal(isRetryableTelegramError(netErr), true);

  const err429 = new GrammyError(
    "Too Many Requests",
    {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 3",
      parameters: { retry_after: 3 },
    },
    "sendMessage",
    {},
  );
  assert.equal(isRetryableTelegramError(err429), true);
  assert.equal(getTelegramRetryAfterMs(err429), 3000);

  const err403 = new GrammyError(
    "Forbidden",
    {
      ok: false,
      error_code: 403,
      description: "Forbidden: bot was blocked by the user",
    },
    "sendMessage",
    {},
  );
  assert.equal(isRetryableTelegramError(err403), false);
});

test("summarizeError and redactSensitiveTokens suppress stack traces and hide bot tokens", () => {
  const inner = Object.assign(
    new Error("request to https://api.telegram.org/bot123456:AASecretToken_XYZ/sendMessage failed"),
    { code: "ECONNRESET" },
  );
  const outer = Object.assign(new Error("Network request for 'sendMessage' failed!"), {
    error: inner,
  });

  const summary = summarizeError(outer);
  assert.ok(!summary.includes("\n"));
  assert.ok(!summary.includes("AASecretToken_XYZ"));
  assert.ok(summary.includes("/bot***/sendMessage"));
  assert.ok(summary.includes("ECONNRESET"));
  assert.equal(redactSensitiveTokens("Authorization: Bearer sk-abc123"), "Authorization: Bearer ***");
});

test("resolveGatewayRetryConfig reads configured gateway.retry values and falls back safely", () => {
  const defaults = createDefaultHatoConfig();
  assert.deepEqual(resolveGatewayRetryConfig(defaults), {
    maxRetries: 3,
    initialDelayMs: 500,
    backoffMultiplier: 2,
    maxDelayMs: 8000,
    jitter: true,
  });

  const customized = validateHatoConfigObject({
    ...defaults,
    gateway: {
      ...defaults.gateway,
      retry: {
        max_retries: 5,
        initial_delay_ms: 250,
        backoff_multiplier: 3,
        max_delay_ms: 5000,
        jitter: false,
      },
    },
  });
  assert.deepEqual(resolveGatewayRetryConfig(customized), {
    maxRetries: 5,
    initialDelayMs: 250,
    backoffMultiplier: 3,
    maxDelayMs: 5000,
    jitter: false,
  });
});
