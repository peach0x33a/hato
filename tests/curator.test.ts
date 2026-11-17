import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ActorLock } from "../src/bus/actor-bus.js";
import { tryHandleSlashCommand } from "../src/commands/slash.js";
import { loadHatoConfig } from "../src/config/app.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { CompactionManager } from "../src/memory/compaction.js";
import { MemoryCurator } from "../src/memory/curator.js";
import { MemoryEchoStore } from "../src/memory/memoryecho.js";
import { PersonaRuntime } from "../src/persona/agent.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("MemoryCurator extracts & routes persona/tech, supports degraded retry, hybrid recall, NO_REPLY, /memory, and /forget", async () => {
  const storedByVault: Record<string, Array<{ id: string; content: string }>> = {
    "v-persona": [],
    "v-tech": [],
  };
  let seq = 0;
  let forceDegradedOnce = true;
  const queryCalls: Array<{ libraryId: string; message: string }> = [];
  const erasedCalls: Array<{ vaultId: string; ids: string[] }> = [];

  const mockServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && req.url === "/api/v1/memory/vaults") {
      res.statusCode = 200;
      res.end(
        JSON.stringify([
          { id: "v-persona", name: "hato-owner-persona", vault_type: "normal", memory_count: 1, storage_bytes: 100 },
          { id: "v-tech", name: "hato-owner-tech", vault_type: "normal", memory_count: 1, storage_bytes: 100 },
        ]),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/memory/append-user-message") {
      const lib = String(parsed.library_id ?? "");
      const msg = String(parsed.message ?? "");
      seq++;
      const id = `mem_${seq}`;
      if (forceDegradedOnce && lib === "v-tech") {
        forceDegradedOnce = false;
        res.statusCode = 200;
        res.end(JSON.stringify({ status: "ok", memory_id: id, pipeline: "degraded" }));
        return;
      }
      storedByVault[lib]?.push({ id, content: msg });
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "ok", memory_id: id, pipeline: "ok" }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/memory/query-readonly") {
      const lib = String(parsed.library_id ?? "");
      const message = String(parsed.message ?? "");
      queryCalls.push({ libraryId: lib, message });
      const items = storedByVault[lib] ?? [];
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          results: items.map((item) => ({
            id: item.id,
            content: item.content,
            created_at: "2026-11-16T12:00:00Z",
          })),
          degraded: false,
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url?.includes("/messages/erase")) {
      const match = req.url.match(/\/vaults\/([^/]+)\/messages\/erase/);
      const vaultId = match ? match[1]! : "";
      const ids = Array.isArray(parsed.memory_ids) ? (parsed.memory_ids as string[]) : [];
      erasedCalls.push({ vaultId, ids });
      storedByVault[vaultId] = (storedByVault[vaultId] ?? []).filter((x) => !ids.includes(x.id));
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          erased: ids,
          already_erased: [],
          missing: [],
          unmapped: [],
          derived_cleanup_failed: false,
        }),
      );
      return;
    }

    if (req.method === "GET" && req.url === "/api/v1/memory/usage") {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          vault_count: 2,
          period: { kind: "calendar_month", start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" },
          units_per_credit: 100_000_000,
          memory_create: { units: 0, user_paid_units: 0, count: 0 },
          memory_query: { units: 50_000_000, user_paid_units: 50_000_000, count: 5 },
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolveListen) => mockServer.listen(0, "127.0.0.1", resolveListen));
  const addr = mockServer.address();
  assert.ok(addr && typeof addr !== "string");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-model-1", name: "Faux Model" }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-curator-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");

  const cfg = createDefaultHatoConfig();
  cfg.memory.provider = "memoryecho";
  cfg.memory.recall = { mode: "hybrid", max_results: 5, min_query_chars: 4 };
  cfg.memory.curator = {
    enabled: true,
    idle_retain_after_minutes: 10,
    batch_message_threshold: 12,
    max_batch_messages: 24,
  };
  cfg.memory.memoryecho = {
    enabled: true,
    base_url: baseUrl,
    api_key_env: "MEMORYECHO_API_KEY",
    timeout_ms: 5000,
    auto_create_vaults: false,
    vaults: { persona: "v-persona", tech: "v-tech" },
  };
  writeHatoConfig(hatoTomlPath, cfg, { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-model-1"
router = "faux-provider/faux-model-1"
curator = "faux-provider/faux-model-1"
worker = "faux-provider/faux-model-1"
hindsight_llm = "faux-provider/faux-model-1"

[providers]
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  try {
    const hatoConfig = loadHatoConfig(hatoTomlPath);
    const repo = new HatoRepository(dbHandle.db);
    const registry = new ModelRegistry(modelsTomlPath, repo, { extraProviders: [faux.provider] });
    const proxyRouter = new ScopedProxyRouter([]);
    const store = new MemoryEchoStore(
      {
        enabled: true,
        baseUrl,
        apiKeyEnv: "MEMORYECHO_API_KEY",
        timeoutMs: 5000,
        autoCreateVaults: false,
        vaults: { persona: "v-persona", tech: "v-tech" },
      },
      proxyRouter,
      repo,
      "as_test_key",
    );
    const curator = new MemoryCurator(hatoConfig, registry, proxyRouter, repo, store);
    const runtime = new PersonaRuntime(hatoConfig, registry, proxyRouter, repo, undefined, store);
    const actorLock = new ActorLock();
    const compaction = new CompactionManager(
      {
        hotMessagesHighWatermark: 60,
        hotMessagesKeepAfterCompact: 2,
        minMessagesToCompact: 4,
        preCompactAfterMinutes: 50,
        idleCommitAfterMinutes: 60,
      },
      repo,
      actorLock,
      {
        summarizeBlock: async () => "过渡摘要",
        ensureRetained: async (uid, msgs) => {
          await curator.retainBeforeCompaction(uid, msgs);
        },
      },
    );

    // Seed raw messages for Curator extraction
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "user",
      content: "我平时不吃香菜，另外项目主力用 TypeScript",
      createdAt: 1_794_800_000_000,
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "assistant",
      content: "记住啦，不吃香菜，写 TS 项目",
      createdAt: 1_794_800_005_000,
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "user",
      content: "好",
      createdAt: 1_794_800_010_000,
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "assistant",
      content: "晚安呀",
      createdAt: 1_794_800_015_000,
    });

    // 1. Curator extraction via CompactionManager.ensureRetained
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          JSON.stringify({
            persona: [{ fact: "用户不吃香菜。", occurred_at: "2026-11-16 11:20" }],
            tech: [{ fact: "用户项目主力使用 TypeScript。", occurred_at: "2026-11-16 11:20" }],
          }),
        ),
    ]);

    const compacted = await compaction.runIdleCommit("owner");
    assert.equal(compacted, true);

    // Persona synced, tech degraded on first try; the 2 kept hot messages remain pending retain
    const stats1 = repo.getMemorySyncStats("owner");
    assert.equal(stats1.synced, 1);
    assert.equal(stats1.degraded, 1);
    assert.equal(stats1.pendingRawMessages, 2);

    // 2. Retry degraded sync without calling Curator LLM again
    const retryRes = await curator.retryPendingSyncs("owner");
    assert.equal(retryRes.retriedCount, 1);
    assert.equal(retryRes.syncedCount, 1);
    const stats2 = repo.getMemorySyncStats("owner");
    assert.equal(stats2.synced, 2);
    assert.equal(stats2.degraded, 0);

    // 3. Hybrid recall: auto pre-recall (<recalled_memories> in Layer 4) + active recall_memory(bank="tech")
    let sawPersonaMemoryInTail = false;
    faux.setResponses([
      (ctx) => {
        const lastMsg = ctx.messages[ctx.messages.length - 1];
        if (lastMsg && lastMsg.role === "user" && typeof lastMsg.content === "string") {
          sawPersonaMemoryInTail =
            lastMsg.content.includes("<recalled_memories>") &&
            lastMsg.content.includes("用户不吃香菜");
        }
        return fauxAssistantMessage([fauxToolCall("recall_memory", { query: "项目用什么语言", bank: "tech" })], {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        const toolRes = ctx.messages[ctx.messages.length - 1];
        assert.equal(toolRes?.role, "toolResult");
        return fauxAssistantMessage("你不吃香菜，项目主力用 TypeScript 呀");
      },
      // Next turn: phatic "嗯" -> skips auto-recall and outputs [NO_REPLY]
      () => fauxAssistantMessage("[NO_REPLY]"),
    ]);

    const queryCountBefore = queryCalls.length;
    const turn1 = await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["pm1"],
      latestPlatformMsgId: "pm1",
      combinedText: "你还记得我饮食忌口和项目语言吗？",
      attachments: [],
      firstTimestampMs: Date.now(),
      lastTimestampMs: Date.now(),
    });

    assert.equal(sawPersonaMemoryInTail, true);
    assert.equal(turn1.silent, false);
    assert.deepEqual(turn1.toolCalls, ["recall_memory"]);
    assert.equal(queryCalls.length - queryCountBefore, 2); // 1 auto (persona) + 1 tool (tech)

    const trace1 = repo.getLatestTurnTrace("owner");
    assert.ok(trace1);
    const recalledIds = JSON.parse(trace1.recalledIdsJson) as string[];
    assert.ok(recalledIds.some((id) => id.startsWith("persona:")));
    assert.ok(recalledIds.some((id) => id.startsWith("tech:")));

    // Phatic turn returning [NO_REPLY] -> silent=true, no fake assistant message persisted
    const countBeforeSilent = repo.getHotMessages("owner", 0).length;
    const turn2 = await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["pm2"],
      latestPlatformMsgId: "pm2",
      combinedText: "嗯",
      attachments: [],
      firstTimestampMs: Date.now(),
      lastTimestampMs: Date.now(),
    });
    assert.equal(turn2.silent, true);
    assert.deepEqual(turn2.bubbles, []);
    // Only the user message was added (no assistant message!)
    assert.equal(repo.getHotMessages("owner", 0).length, countBeforeSilent + 1);
    assert.equal(queryCalls.length - queryCountBefore, 2); // No auto-recall for "嗯"

    // 4. Slash commands /memory and /forget
    const slashDeps = {
      repo,
      listModelSlots: () => [],
      listAvailableModels: () => [],
      setModelSlot: () => {
        throw new Error("unused");
      },
      reloadAll: async () => ({ slots: [], proxyCount: 0 }),
      forceCompact: async () => false,
      getMemoryStatus: async (uid: string) => ({
        provider: "memoryecho",
        configured: store.isConfigured(),
        recallMode: "hybrid",
        curatorEnabled: true,
        vaultIds: {
          persona: await store.resolveVaultId(uid, "persona", { createIfMissing: false }),
          tech: await store.resolveVaultId(uid, "tech", { createIfMissing: false }),
        },
        usage: await store.getUsage(),
      }),
      syncMemory: (uid: string) => curator.retainPending(uid, { includeDeniedRetries: true }),
      forgetMemory: (uid: string, query: string) => curator.forgetByQuery(uid, query),
    };

    const memoryReply = await tryHandleSlashCommand("owner", "/memory", slashDeps);
    assert.ok(memoryReply && memoryReply.includes("memoryecho") && memoryReply.includes("v-persona"));

    const forgetReply = await tryHandleSlashCommand("owner", "/forget 香菜", slashDeps);
    assert.ok(forgetReply && forgetReply.includes("本地清除 1 条") && forgetReply.includes("远程删除 1 条"));
    assert.equal(erasedCalls.length, 1);
    assert.equal(erasedCalls[0]!.vaultId, "v-persona");
    assert.equal(repo.getMemorySyncStats("owner").erased, 1);

    curator.dispose();
    compaction.dispose();
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolveClose) => mockServer.close(() => resolveClose()));
  }
});
