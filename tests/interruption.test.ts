import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { loadHatoConfig } from "../src/config/app.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { PersonaRuntime } from "../src/persona/agent.js";
import {
  buildInterruptedAssistantText,
  parsePureErrorInterruptionNotice,
  stripErrorInterruptionNotices,
  summarizeErrorForContext,
} from "../src/persona/interruption.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("summarizeErrorForContext strips URLs/JSON and classifies common errors", () => {
  const quota429 = new Error(
    '{"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 429,\\n \\"message\\": \\"You exceeded your current quota. See https://ai.google.dev/gemini-api/docs/rate-limits\\"\\n }\\n}","code":429}}',
  );
  assert.equal(summarizeErrorForContext(quota429), "HTTP 429 quota/rate_limit");

  assert.equal(
    summarizeErrorForContext(new Error("503 UNAVAILABLE high demand")),
    "HTTP 503 model_unavailable",
  );
  assert.equal(
    summarizeErrorForContext(new Error("ECONNRESET socket hang up")),
    "network_timeout_or_disconnect",
  );
  const generic = summarizeErrorForContext(
    new Error("Unexpected upstream failure at https://example.com/v1/chat/completions with extra details"),
  );
  assert.ok(!generic.includes("https://"));
  assert.ok(generic.length <= 60);
});

test("buildInterruptedAssistantText, parsePureErrorInterruptionNotice, and stripErrorInterruptionNotices work consistently", () => {
  const pureSingle = buildInterruptedAssistantText({
    sentParts: [],
    errorSummary: "HTTP 429 quota/rate_limit",
  });
  assert.deepEqual(parsePureErrorInterruptionNotice(pureSingle), { count: 1 });
  assert.equal(stripErrorInterruptionNotices(pureSingle), "");

  const pureMulti = buildInterruptedAssistantText({
    sentParts: [],
    errorSummary: "HTTP 503 model_unavailable",
    consecutiveCount: 3,
  });
  assert.deepEqual(parsePureErrorInterruptionNotice(pureMulti), { count: 3 });
  assert.equal(stripErrorInterruptionNotices(pureMulti), "");

  const mixed = buildInterruptedAssistantText({
    sentParts: ["[已发送表情包 stk_1 到 TG]"],
    errorSummary: "HTTP 429 quota/rate_limit",
  });
  assert.equal(parsePureErrorInterruptionNotice(mixed), null);
  assert.equal(stripErrorInterruptionNotices(mixed), "[已发送表情包 stk_1 到 TG]");
});

test("PersonaRuntime persists sent sticker + concise error on mid-turn crash and coalesces consecutive pure errors", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-1", name: "Faux Persona" }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-interrupt-test-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");

  const baseConfig = createDefaultHatoConfig();
  baseConfig.llm_retry = {
    max_retries: 0,
    initial_delay_ms: 0,
    backoff_multiplier: 1,
    max_delay_ms: 0,
    jitter: false,
    notify_after_retry: 0,
  };
  writeHatoConfig(hatoTomlPath, baseConfig, { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-persona-1"
router = "faux-provider/faux-persona-1"
curator = "faux-provider/faux-persona-1"
worker = "faux-provider/faux-persona-1"
hindsight_llm = "faux-provider/faux-persona-1"

[providers]
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  try {
    const hatoConfig = loadHatoConfig(hatoTomlPath);
    const repo = new HatoRepository(dbHandle.db);
    const modelRegistry = new ModelRegistry(modelsTomlPath, repo, {
      extraProviders: [faux.provider],
    });
    const proxyRouter = new ScopedProxyRouter(hatoConfig.network?.proxies ?? []);
    const runtime = new PersonaRuntime(hatoConfig, modelRegistry, proxyRouter, repo);

    let stickerSentCount = 0;
    runtime.setStickerHandlers({
      onSearch: async () => [],
      onSend: async ({ stickerId }) => {
        stickerSentCount++;
        return { ok: true, message: `已发送表情包 ${stickerId} 到 TG` };
      },
      onSave: async () => ({ ok: true, message: "ok" }),
      onCollect: () => "ok",
    });

    // Turn 1: sends sticker, then fails with 429 on the follow-up generation step.
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("send_sticker", { sticker_id: "stk_happy_1" })],
          { stopReason: "toolUse" },
        ),
      () => {
        throw new Error(
          '429 {"error":{"code":429,"message":"You exceeded your current quota. https://ai.google.dev/gemini-api/docs/rate-limits"}}',
        );
      },
      // Turn 2: immediate 429
      () => {
        throw new Error("429 quota exceeded");
      },
      // Turn 3: immediate 503
      () => {
        throw new Error("503 UNAVAILABLE");
      },
    ]);

    const uid = hatoConfig.owner.canonical_user_id;
    const makeBatch = (text: string, id: string, ts: number) => ({
      canonicalUserId: uid,
      originChannel: "tg" as const,
      originPlatformUserId: "tg-user-1",
      combinedText: text,
      latestPlatformMsgId: id,
      replyToPlatformMsgId: null,
      attachments: [],
      firstTimestampMs: ts,
      lastTimestampMs: ts,
    });

    await assert.rejects(() => runtime.handleUserBatch(makeBatch("按心情挑张贴纸", "m1", 1000)), /429/);
    assert.equal(stickerSentCount, 1);

    const afterTurn1 = repo.getHotMessages(uid, 0);
    assert.equal(afterTurn1.length, 2);
    assert.equal(afterTurn1[1]!.role, "assistant");
    assert.match(afterTurn1[1]!.content, /已发送表情包 stk_happy_1 到 TG/);
    assert.match(
      afterTurn1[1]!.content,
      /\[system_notice: reply_interrupted; stage=mid_turn; reason="HTTP 429 quota\/rate_limit"; user_notified=true\]/,
    );

    // Turn 2: pure error (does NOT overwrite Turn 1's sticker+error record)
    await assert.rejects(() => runtime.handleUserBatch(makeBatch("noooo", "m2", 2000)), /429/);
    const afterTurn2 = repo.getHotMessages(uid, 0);
    assert.equal(afterTurn2.length, 4);
    assert.equal(
      afterTurn2[3]!.content,
      '[system_notice: reply_interrupted; count=1; reason="HTTP 429 quota/rate_limit"; user_notified=true]',
    );

    // Turn 3: another consecutive pure error (coalesced in place into Turn 2's notice!)
    await assert.rejects(() => runtime.handleUserBatch(makeBatch("还在吗", "m3", 3000)), /503/);
    const afterTurn3 = repo.getHotMessages(uid, 0);
    assert.equal(afterTurn3.length, 5);
    assert.equal(afterTurn3[3]!.role, "user");
    assert.equal(afterTurn3[4]!.role, "assistant");
    assert.equal(
      afterTurn3[4]!.content,
      '[system_notice: reply_interrupted; count=2; last_reason="HTTP 503 model_unavailable"; user_notified=true]',
    );
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
