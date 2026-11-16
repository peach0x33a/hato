import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runStaticsCli } from "../src/cli/statics.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import {
  computeTurnMetrics,
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
});

test("openDatabase migrates legacy turn_traces columns and backfills cache_hit_rate without losing data", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-migrate-test-"));
  const dbPath = join(tempDir, "legacy.db");
  try {
    // Simulate a legacy DB created before cache_hit_rate, ttft_ms, tps, and user_preview existed.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE turn_traces (
        id TEXT PRIMARY KEY,
        canonical_user_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        api TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        recalled_ids_json TEXT NOT NULL DEFAULT '[]',
        time_card_text TEXT NOT NULL DEFAULT '',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        latency_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO turn_traces VALUES (
        'tr_legacy_1', 'owner', 'persona', 'relay', 'model-x', 'openai-completions',
        126, 82, 1024, 0, '[]', '', '[]', 3945, 1700000000000
      );
    `);
    legacy.close();

    const handle = openDatabase(dbPath);
    try {
      const repo = new HatoRepository(handle.db);
      const rows = repo.listTurnTraces();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.cacheHitRate, 0.8904);
      assert.equal(rows[0]!.ttftMs, null);
      assert.equal(rows[0]!.tps, null);
      assert.equal(rows[0]!.userPreview, null);
    } finally {
      handle.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
