import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";
import { runStaticsCli } from "../src/cli/statics.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import {
  buildFailedTraceSteps,
  computeTurnMetrics,
  extractTraceErrorMessage,
  extractTraceSteps,
  formatLlmTelemetryLog,
  parseSinceSpec,
  renderStaticsReport,
  summarizeTurnTraces,
} from "../src/stats/metrics.js";

test("computeTurnMetrics and summarizeTurnTraces compute cache hit ratio, TTFT, and TPS accurately", () => {
  const m1 = computeTurnMetrics({
    inputTokens: 126,
    outputTokens: 82,
    cacheReadTokens: 1024,
    cacheWriteTokens: 0,
    latencyMs: 3945,
    ttftMs: 945,
    decodeMs: 3000,
  });
  assert.equal(m1.totalPromptTokens, 1150);
  assert.equal(m1.cacheHitRate, 0.8904);
  assert.equal(m1.decodeTps, 27.33);
  assert.equal(m1.e2eTps, 20.79);

  const now = Date.now();
  const summary = summarizeTurnTraces([
    {
      id: "t1",
      canonicalUserId: "owner",
      slot: "persona",
      provider: "custom",
      modelId: "m1",
      api: "openai-completions",
      inputTokens: 1000,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRate: 0,
      ttftMs: 600,
      tps: 20,
      latencyMs: 1600,
      userPreview: "hello",
      toolCallsJson: "[]",
      createdAt: now - 2000,
    },
    {
      id: "t2",
      canonicalUserId: "owner",
      slot: "persona",
      provider: "custom",
      modelId: "m1",
      api: "openai-completions",
      inputTokens: 100,
      outputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      cacheHitRate: 0.9,
      ttftMs: 400,
      tps: 40,
      latencyMs: 2900,
      userPreview: "how are you",
      toolCallsJson: "[]",
      createdAt: now,
    },
  ]);

  assert.equal(summary.turns, 2);
  assert.equal(summary.weightedCacheHitRate, 0.45);
  assert.equal(summary.warmCacheHitRate, 0.9);
  assert.equal(summary.avgTtftMs, 500);
  assert.equal(summary.avgDecodeTps, 30);

  // Guard against buffered/non-streaming <50ms decode windows producing 1000-6000+ tok/s
  const buffered = computeTurnMetrics({
    inputTokens: 500,
    outputTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 1000,
    ttftMs: 995,
    decodeMs: 5,
  });
  assert.equal(buffered.decodeTps, 30);
  assert.equal(buffered.e2eTps, 30);

  const singleToken = computeTurnMetrics({
    inputTokens: 100,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 500,
    ttftMs: 499,
    decodeMs: 1,
  });
  assert.equal(singleToken.decodeTps, 2);

  // Historical rows with bogus tps from <50ms decode windows fall back to e2e TPS in summary
  const sanitizedSummary = summarizeTurnTraces([
    {
      id: "t-bogus",
      canonicalUserId: "owner",
      slot: "router",
      provider: "claudeflare",
      modelId: "deepseek-flash",
      api: "openai-completions",
      inputTokens: 500,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRate: 0,
      ttftMs: 800,
      tps: 6107.2,
      latencyMs: 800,
      userPreview: "route",
      toolCallsJson: "[]",
      createdAt: now,
    },
  ]);
  assert.equal(sanitizedSummary.avgDecodeTps, 25);
});

test("runStaticsCli supports filtering, summary, --json, and help output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-statics-cli-"));
  const dbPath = join(tempDir, "hato.db");
  try {
    const handle = openDatabase(dbPath);
    const repo = new HatoRepository(handle.db);
    repo.insertTurnTrace({
      canonicalUserId: "owner",
      slot: "persona",
      provider: "provider-a",
      modelId: "model-alpha",
      api: "openai-completions",
      inputTokens: 150,
      outputTokens: 60,
      cacheReadTokens: 850,
      cacheWriteTokens: 0,
      ttftMs: 510,
      tps: 35.5,
      userPreview: "今天天气怎么样",
      recalledIds: [],
      timeCardText: "",
      toolCalls: [],
      latencyMs: 2200,
    });
    repo.insertTurnTrace({
      canonicalUserId: "owner",
      slot: "worker",
      provider: "provider-b",
      modelId: "model-beta",
      api: "anthropic-messages",
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      ttftMs: 420,
      tps: 50,
      userPreview: "写一个脚本",
      recalledIds: [],
      timeCardText: "",
      toolCalls: [],
      latencyMs: 2420,
    });
    handle.close();

    const helpText = runStaticsCli(["--help"]);
    assert.ok(helpText.includes("--limit"));

    const textReport = runStaticsCli(["--db", dbPath, "--slot", "persona", "--limit", "5"]);
    assert.ok(textReport.includes("model-alpha"));
    assert.ok(!textReport.includes("model-beta"));
    assert.ok(textReport.includes("85.0%"));
    assert.ok(textReport.includes("510ms"));
    assert.ok(textReport.includes("35.5 tok/s"));

    const jsonOut = runStaticsCli(["--db", dbPath, "--json"]);
    const parsed = JSON.parse(jsonOut) as { summary: { turns: number; weightedCacheHitRate: number } };
    assert.equal(parsed.summary.turns, 2);
    assert.equal(parsed.summary.weightedCacheHitRate, 0.825);

    const rendered = renderStaticsReport([]);
    assert.ok(rendered.includes("暂无匹配的调用记录"));

    const logLine = formatLlmTelemetryLog({
      slot: "persona",
      provider: "provider-a",
      modelId: "model-alpha",
      responseId: "resp_123",
      api: "openai-completions",
      stopReason: "stop",
      inputTokens: 150,
      outputTokens: 60,
      reasoningTokens: 12,
      cacheReadTokens: 850,
      cacheWriteTokens: 0,
      costTotal: 0.0012,
      ttftMs: 510,
      decodeMs: 1690,
      latencyMs: 2200,
      timeZone: "Asia/Singapore",
      timestampMs: Date.parse("2026-11-16T07:06:15Z"),
      color: false,
    });
    assert.ok(logLine.startsWith("[LLM] [PERSONA] [2026-11-16 15:06:15] "));
    assert.ok(logLine.includes("hit=85.0%"));
    assert.ok(logLine.includes("ttft=510ms"));
    assert.ok(logLine.includes("tps=35.5/s"));
    assert.ok(logLine.includes("resp=resp_123"));

    const coloredLogLine = formatLlmTelemetryLog({
      slot: "persona",
      provider: "provider-a",
      modelId: "model-alpha",
      api: "openai-completions",
      stopReason: "stop",
      inputTokens: 150,
      outputTokens: 60,
      cacheReadTokens: 850,
      cacheWriteTokens: 0,
      ttftMs: 510,
      decodeMs: 1690,
      latencyMs: 2200,
      timeZone: "Asia/Singapore",
      timestampMs: Date.parse("2026-11-16T07:06:15Z"),
      color: true,
    });
    assert.ok(coloredLogLine.includes("\x1b[1;35m[LLM]\x1b[0m"));
    assert.ok(coloredLogLine.includes("\x1b[1;32mhit=85.0%\x1b[0m"));

    assert.ok(parseSinceSpec("2h", 10_000_000) === 10_000_000 - 7_200_000);
    assert.throws(() => parseSinceSpec("invalid-span"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("formatLlmTelemetryLog, extractTraceSteps, buildFailedTraceSteps, and extractTraceErrorMessage surface redacted errors", () => {
  const errLine = formatLlmTelemetryLog({
    slot: "persona",
    provider: "custom-relay",
    modelId: "glm-5.3-flash",
    api: "openai-completions",
    stopReason: "error",
    errorMessage: "422 Invalid role: Bearer secret_token_123",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: 120,
    latencyMs: 120,
    color: false,
  });
  assert.ok(errLine.includes("stop=error"));
  assert.ok(errLine.includes("error="));
  assert.ok(errLine.includes("Bearer ***"));
  assert.ok(!errLine.includes("secret_token_123"));

  const extracted = extractTraceSteps([
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "401 Unauthorized: Bearer my_secret_key",
    },
  ]);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0]?.kind, "assistant");
  if (extracted[0]?.kind === "assistant") {
    assert.equal(extracted[0].stopReason, "error");
    assert.equal(extracted[0].errorMessage, "401 Unauthorized: Bearer ***");
  }

  // Exception thrown before any assistant message was emitted
  const syntheticSteps = buildFailedTraceSteps([], new Error("422 Input tag 'developer' invalid"));
  assert.equal(syntheticSteps.length, 1);
  assert.equal(syntheticSteps[0]?.kind, "assistant");
  if (syntheticSteps[0]?.kind === "assistant") {
    assert.equal(syntheticSteps[0].stopReason, "error");
    assert.ok(syntheticSteps[0].errorMessage?.includes("422 Input tag 'developer' invalid"));
  }
  assert.equal(
    extractTraceErrorMessage(JSON.stringify(syntheticSteps)),
    "422 Input tag 'developer' invalid",
  );
  assert.equal(extractTraceErrorMessage("[]"), null);
});
