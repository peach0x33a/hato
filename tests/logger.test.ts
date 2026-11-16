import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLogLine,
  formatLogTimestamp,
  getLogTimezone,
  setLogTimezone,
  shouldUseColor,
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
