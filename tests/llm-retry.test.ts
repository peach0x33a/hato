import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { resolveLlmRetryConfig, validateHatoConfigObject } from "../src/config/app.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import {
  DEFAULT_LLM_RETRY_CONFIG,
  completeSimpleWithRetry,
  formatLlmRetryNotice,
  isRetryableLlmError,
  streamSimpleWithRetry,
  type LlmRetryNotice,
} from "../src/utils/llm-retry.js";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "google-generative-ai",
    provider: "google",
    model: "gemini-2.5-pro",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

test("isRetryableLlmError classifies 503 UNAVAILABLE and transient errors vs permanent 4xx/aborts", () => {
  const userReported503 =
    '{"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 503,\\n \\"message\\": \\"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.\\",\\n \\"status\\": \\"UNAVAILABLE\\"\\n }\\n}\\n","code":503,"status":""}}';

  assert.equal(isRetryableLlmError(userReported503), true);
  assert.equal(
    isRetryableLlmError(makeAssistantMessage({ stopReason: "error", errorMessage: userReported503 })),
    true,
  );
  assert.equal(isRetryableLlmError(new Error("429 Too Many Requests")), true);
  assert.equal(isRetryableLlmError(new Error("502 Bad Gateway")), true);
  assert.equal(isRetryableLlmError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), true);

  assert.equal(isRetryableLlmError(new Error("400 INVALID_ARGUMENT: bad schema")), false);
  assert.equal(isRetryableLlmError(new Error("401 UNAUTHENTICATED")), false);
  assert.equal(isRetryableLlmError(new Error("403 PERMISSION_DENIED")), false);
  assert.equal(isRetryableLlmError(makeAssistantMessage({ stopReason: "aborted", errorMessage: "Request was aborted" })), false);
  assert.equal(isRetryableLlmError(new Error("insufficient_quota")), false);
});

test("streamSimpleWithRetry retries up to 5 times by default and notifies on 3rd failed retry", async () => {
  assert.equal(DEFAULT_LLM_RETRY_CONFIG.maxRetries, 5);
  assert.equal(DEFAULT_LLM_RETRY_CONFIG.notifyAfterRetry, 3);

  let calls = 0;
  const notices: LlmRetryNotice[] = [];
  const sleeps: number[] = [];

  const stream = streamSimpleWithRetry(
    () => {
      calls++;
      const s = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = makeAssistantMessage();
        s.push({ type: "start", partial });
        if (calls <= 4) {
          const errMsg = makeAssistantMessage({
            stopReason: "error",
            errorMessage: '{"error":{"code":503,"status":"UNAVAILABLE"}}',
          });
          s.push({ type: "error", reason: "error", error: errMsg });
        } else {
          const okMsg = makeAssistantMessage({
            stopReason: "stop",
            content: [{ type: "text", text: "恢复啦" }],
          });
          s.push({ type: "text_start", contentIndex: 0, partial: okMsg });
          s.push({ type: "text_delta", contentIndex: 0, delta: "恢复啦", partial: okMsg });
          s.push({ type: "text_end", contentIndex: 0, content: "恢复啦", partial: okMsg });
          s.push({ type: "done", reason: "stop", message: okMsg });
        }
        s.end();
      });
      return s;
    },
    {
      policy: { initialDelayMs: 10, backoffMultiplier: 2, maxDelayMs: 100, jitter: false },
      onRetryNotice: (notice) => {
        notices.push(notice);
      },
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    },
  );

  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
  }
  const finalMsg = await stream.result();

  assert.equal(calls, 5);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.retryNumber, 3);
  assert.equal(notices[0]?.maxRetries, 5);
  assert.ok(formatLlmRetryNotice(notices[0]!).includes("3/5"));
  assert.deepEqual(sleeps, [10, 20, 40, 80]);

  assert.equal(events.filter((e) => e.type === "start").length, 1);
  assert.equal(events.filter((e) => e.type === "error").length, 0);
  assert.equal(finalMsg.stopReason, "stop");
  assert.equal(finalMsg.content[0]?.type === "text" ? finalMsg.content[0].text : "", "恢复啦");
});

test("streamSimpleWithRetry exhausts 5 retries and surfaces final error", async () => {
  let calls = 0;
  const notices: LlmRetryNotice[] = [];

  const stream = streamSimpleWithRetry(
    () => {
      calls++;
      const s = createAssistantMessageEventStream();
      queueMicrotask(() => {
        s.push({ type: "start", partial: makeAssistantMessage() });
        s.push({
          type: "error",
          reason: "error",
          error: makeAssistantMessage({
            stopReason: "error",
            errorMessage: '{"error":{"code":503,"status":"UNAVAILABLE"}}',
          }),
        });
        s.end();
      });
      return s;
    },
    {
      policy: { initialDelayMs: 1, jitter: false },
      onRetryNotice: (n) => {
        notices.push(n);
      },
      sleepFn: async () => {},
    },
  );

  const finalMsg = await stream.result();
  assert.equal(calls, 6); // 1 initial + 5 retries
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.retryNumber, 3);
  assert.equal(finalMsg.stopReason, "error");
  assert.ok(finalMsg.errorMessage?.includes("503"));
});

test("streamSimpleWithRetry fails fast on non-retryable 400 error and stops on abort", async () => {
  let badReqCalls = 0;
  const badStream = streamSimpleWithRetry(
    () => {
      badReqCalls++;
      const s = createAssistantMessageEventStream();
      queueMicrotask(() => {
        s.push({
          type: "error",
          reason: "error",
          error: makeAssistantMessage({ stopReason: "error", errorMessage: "400 INVALID_ARGUMENT" }),
        });
        s.end();
      });
      return s;
    },
    { sleepFn: async () => {} },
  );
  const badResult = await badStream.result();
  assert.equal(badReqCalls, 1);
  assert.equal(badResult.stopReason, "error");

  const ac = new AbortController();
  let abortedCalls = 0;
  const abortedStream = streamSimpleWithRetry(
    () => {
      abortedCalls++;
      const s = createAssistantMessageEventStream();
      queueMicrotask(() => {
        s.push({
          type: "error",
          reason: "error",
          error: makeAssistantMessage({ stopReason: "error", errorMessage: "503 UNAVAILABLE" }),
        });
        s.end();
      });
      return s;
    },
    {
      signal: ac.signal,
      sleepFn: async () => {
        ac.abort();
        throw new DOMException("Aborted", "AbortError");
      },
    },
  );
  const abortedResult = await abortedStream.result();
  assert.equal(abortedCalls, 1);
  assert.equal(abortedResult.stopReason, "aborted");
});

test("completeSimpleWithRetry retries transient assistant errors", async () => {
  let calls = 0;
  const res = await completeSimpleWithRetry(
    async () => {
      calls++;
      if (calls < 3) {
        return makeAssistantMessage({ stopReason: "error", errorMessage: "503 UNAVAILABLE" });
      }
      return makeAssistantMessage({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
    },
    { sleepFn: async () => {} },
  );
  assert.equal(calls, 3);
  assert.equal(res.stopReason, "stop");
});

test("resolveLlmRetryConfig returns 5 retries / notify 3 by default and respects config overrides", () => {
  const cfg = createDefaultHatoConfig();
  assert.ok(validateHatoConfigObject(cfg));
  assert.deepEqual(resolveLlmRetryConfig(cfg), DEFAULT_LLM_RETRY_CONFIG);

  const custom = {
    ...cfg,
    llm_retry: {
      max_retries: 7,
      notify_after_retry: 4,
    },
  };
  assert.ok(validateHatoConfigObject(custom));
  const resolved = resolveLlmRetryConfig(custom);
  assert.equal(resolved.maxRetries, 7);
  assert.equal(resolved.notifyAfterRetry, 4);
  assert.equal(resolved.initialDelayMs, DEFAULT_LLM_RETRY_CONFIG.initialDelayMs);
});
