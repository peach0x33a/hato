import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRuntimeLogs,
  formatLogLine,
  formatLogTimestamp,
  formatUserFacingTurnError,
  getLogTimezone,
  getRuntimeLogs,
  setLogTimezone,
  shouldUseColor,
  subscribeRuntimeLogs,
  summarizeError,
} from "../src/utils/logger.js";

test("logger formats [CATEGORY] [SCOPE] [YYYY-MM-DD HH:mm:ss] consistently and respects configured timezone", () => {
  const prevTz = getLogTimezone();
  const ts = Date.parse("2026-11-16T07:06:15Z");

  try {
    setLogTimezone("Asia/Singapore");
    assert.equal(getLogTimezone(), "Asia/Singapore");
    assert.equal(formatLogTimestamp(ts), "2026-11-16 15:06:15");
    assert.equal(
      formatLogLine("sys", "tg", "connected as @hato_bot", { timestampMs: ts, color: false }),
      "[SYS] [TG] [2026-11-16 15:06:15] connected as @hato_bot",
    );
    assert.equal(
      formatLogLine("warn", "models", "stale override", {
        timeZone: "UTC",
        timestampMs: ts,
        color: false,
      }),
      "[WARN] [MODELS] [2026-11-16 07:06:15] stale override",
    );
    assert.equal(
      formatLogLine("err", "compaction", "draft failed", {
        timeZone: "Asia/Tokyo",
        timestampMs: ts,
        color: false,
      }),
      "[ERR] [COMPACTION] [2026-11-16 16:06:15] draft failed",
    );

    const colored = formatLogLine("err", "compaction", "draft failed", {
      timeZone: "Asia/Singapore",
      timestampMs: ts,
      color: true,
    });
    assert.ok(colored.includes("\x1b[1;31m[ERR]\x1b[0m"));
    assert.ok(colored.includes("\x1b[31m[COMPACTION]\x1b[0m"));
    assert.ok(colored.includes("\x1b[2m[2026-11-16 15:06:15]\x1b[0m"));
    assert.ok(colored.includes("\x1b[31mdraft failed\x1b[0m"));
  } finally {
    setLogTimezone(prevTz);
  }
});

test("shouldUseColor respects NO_COLOR, FORCE_COLOR, and TTY stream status", () => {
  const prevNoColor = process.env.NO_COLOR;
  const prevForceColor = process.env.FORCE_COLOR;
  try {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    assert.equal(shouldUseColor({ isTTY: true }), true);
    assert.equal(shouldUseColor({ isTTY: false }), false);

    process.env.FORCE_COLOR = "1";
    assert.equal(shouldUseColor({ isTTY: false }), true);

    process.env.NO_COLOR = "1";
    assert.equal(shouldUseColor({ isTTY: true }), false);
  } finally {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
    if (prevForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prevForceColor;
  }
});

test("summarizeError condenses Cloudflare 502 HTML pages into a readable summary", () => {
  const cfErr = new Error(
    '{"error":{"message":"<!DOCTYPE html>\\n<html><head><title>misakacloud.dev | 502: Bad gateway</title><link rel=\\"stylesheet\\" href=\\"/cdn-cgi/styles/main.css\\" /></head><body><div id=\\"cf-wrapper\\">Bad gateway</div></body></html>"}}',
  );
  const summary = summarizeError(cfErr);
  assert.equal(summary.includes("<!DOCTYPE html>"), false);
  assert.ok(summary.includes("Cloudflare 上游网关返回错误"));
  assert.ok(summary.includes("misakacloud.dev | 502: Bad gateway"));
});

test("runtime log ring buffer records, strips ANSI, redacts tokens, filters, and notifies subscribers", () => {
  clearRuntimeLogs();
  const received: string[] = [];
  const unsub = subscribeRuntimeLogs((entry) => {
    received.push(`${entry.category}:${entry.scope}:${entry.message}`);
  });

  try {
    formatLogLine("sys", "tg", "\x1b[32mfetch https://api.telegram.org/bot12345:secret_abc/getMe\x1b[0m", {
      color: true,
    });
    formatLogLine("warn", "qq", "Authorization: Bearer tok_secret_123 failed", { color: false });
    formatLogLine("err", "persona", "turn failed", { color: false });
    formatLogLine("sys", "hidden", "should not record", { color: false, record: false });

    const all = getRuntimeLogs();
    assert.equal(all.length, 3);
    assert.equal(all[0]!.message, "fetch https://api.telegram.org/bot***/getMe");
    assert.equal(all[1]!.message, "Authorization: Bearer *** failed");
    assert.equal(received.length, 3);

    const onlyWarn = getRuntimeLogs({ category: "warn" });
    assert.equal(onlyWarn.length, 1);
    assert.equal(onlyWarn[0]!.scope, "QQ");

    const byQuery = getRuntimeLogs({ q: "turn failed" });
    assert.equal(byQuery.length, 1);
    assert.equal(byQuery[0]!.category, "ERR");

    const limited = getRuntimeLogs({ limit: 2 });
    assert.equal(limited.length, 2);
    assert.equal(limited[0]!.scope, "QQ");
    assert.equal(limited[1]!.scope, "PERSONA");
  } finally {
    unsub();
    clearRuntimeLogs();
  }
});

test("summarizeError unwraps nested Google API JSON and formatUserFacingTurnError maps friendly messages", () => {
  const nested503 = new Error(
    JSON.stringify({
      error: {
        message: JSON.stringify({
          error: {
            code: 503,
            message: "This model is currently experiencing high demand.",
            status: "UNAVAILABLE",
          },
        }),
        code: 503,
        status: "Service Unavailable",
      },
    }),
  );
  const summary = summarizeError(nested503);
  assert.equal(summary.includes('\\"error\\"'), false);
  assert.ok(summary.includes("HTTP 503"));
  assert.ok(summary.includes("This model is currently experiencing high demand."));

  assert.equal(
    formatUserFacingTurnError(nested503),
    "模型服务当前繁忙（503），自动重试后仍未恢复，请稍后再试～",
  );
  assert.equal(
    formatUserFacingTurnError(new Error("Incomplete JSON segment at the end")),
    "模型连接或响应流意外中断，请再发一次试试～",
  );
});
