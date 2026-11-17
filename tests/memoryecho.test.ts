import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { MemoryEchoStore, normalizeRecallEntries } from "../src/memory/memoryecho.js";
import { shouldAutoRecall } from "../src/memory/store.js";

test("MemoryEchoStore handles vault reuse, retain, degraded/402 semantics, query-readonly, chunked erase, and usage", async () => {
  const requests: Array<{
    method: string;
    url: string;
    auth?: string;
    body?: Record<string, unknown>;
  }> = [];

  let nextPipeline: "ok" | "degraded" | "402" = "ok";
  let nextRecallMode: "ok" | "degraded" | "402" = "ok";
  let createVaultCalls = 0;

  const mockServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;

    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "",
      auth: req.headers.authorization,
      body: parsed,
    });

    if (req.headers.authorization !== "Bearer as_test_secret") {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && req.url === "/api/v1/memory/vaults") {
      res.statusCode = 200;
      res.end(
        JSON.stringify([
          {
            id: "vault-persona-1",
            name: "hato-owner-persona",
            description: "existing persona vault",
            vault_type: "normal",
            memory_count: 3,
            storage_bytes: 512,
            created_at: "2026-11-16T00:00:00Z",
            updated_at: "2026-11-16T00:00:00Z",
          },
        ]),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/memory/vaults") {
      createVaultCalls++;
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          id: "vault-tech-1",
          name: parsed?.name ?? "hato-owner-tech",
          description: parsed?.description ?? null,
          vault_type: "normal",
          memory_count: 0,
          storage_bytes: 0,
          created_at: "2026-11-16T00:00:00Z",
          updated_at: "2026-11-16T00:00:00Z",
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/memory/append-user-message") {
      if (nextPipeline === "402") {
        res.statusCode = 402;
        res.end(
          JSON.stringify({
            error_code: "INSUFFICIENT_BALANCE",
            error: "余额不足",
            memory_id: "mem-denied-1",
            pipeline: "denied",
          }),
        );
        return;
      }
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          status: "ok",
          memory_id: nextPipeline === "degraded" ? "mem-deg-1" : "mem-ok-1",
          pipeline: nextPipeline,
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/memory/query-readonly") {
      if (nextRecallMode === "402") {
        res.statusCode = 402;
        res.end(JSON.stringify({ error_code: "QUOTA_EXHAUSTED", error: "本月额度已耗尽" }));
        return;
      }
      if (nextRecallMode === "degraded") {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            results: [],
            messages: [{ id: "fallback-1", role: "user", content: "近期兜底消息" }],
            degraded: true,
          }),
        );
        return;
      }
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          results: [
            {
              id: "mem-ok-1",
              content: "[2026-11-16 21:00] 用户喜欢深色模式",
              created_at: "2026-11-16T13:00:00Z",
            },
          ],
          degraded: false,
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url?.endsWith("/messages/erase")) {
      const ids = Array.isArray(parsed?.memory_ids) ? (parsed.memory_ids as string[]) : [];
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
          period: {
            kind: "calendar_month",
            start: "2026-11-01T00:00:00Z",
            end: "2026-12-01T00:00:00Z",
          },
          units_per_credit: 100_000_000,
          memory_create: { units: 4_500_000_000_000, user_paid_units: 0, count: 1 },
          memory_query: { units: 120_000_000, user_paid_units: 120_000_000, count: 12 },
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

  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    const proxyRouter = new ScopedProxyRouter([]);
    const store = new MemoryEchoStore(
      {
        enabled: true,
        baseUrl,
        apiKeyEnv: "MEMORYECHO_API_KEY",
        timeoutMs: 5000,
        autoCreateVaults: true,
        vaults: { persona: "", tech: "" },
      },
      proxyRouter,
      repo,
      "as_test_secret",
    );

    // 1. Discovers existing persona vault without creating a new one
    const pVault = await store.resolveVaultId("owner", "persona", { createIfMissing: true });
    assert.equal(pVault, "vault-persona-1");
    assert.equal(createVaultCalls, 0);

    // 2. Creates tech vault once and caches it
    const tVault1 = await store.resolveVaultId("owner", "tech", { createIfMissing: true });
    const tVault2 = await store.resolveVaultId("owner", "tech", { createIfMissing: true });
    assert.equal(tVault1, "vault-tech-1");
    assert.equal(tVault2, "vault-tech-1");
    assert.equal(createVaultCalls, 1);

    // 3. Retain ok, degraded, and 402 denied
    const okRes = await store.retain("owner", {
      bank: "persona",
      role: "user",
      content: "[2026-11-16 21:00] 用户喜欢深色模式",
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.status, "synced");
    assert.equal(okRes.externalMemoryId, "mem-ok-1");

    nextPipeline = "degraded";
    const degRes = await store.retain("owner", {
      bank: "persona",
      role: "user",
      content: "降级测试",
    });
    assert.equal(degRes.ok, false);
    assert.equal(degRes.status, "degraded");
    assert.equal(degRes.externalMemoryId, "mem-deg-1");

    nextPipeline = "402";
    const deniedRes = await store.retain("owner", {
      bank: "tech",
      role: "user",
      content: "扣费测试",
    });
    assert.equal(deniedRes.ok, false);
    assert.equal(deniedRes.status, "denied");
    assert.equal(deniedRes.errorCode, "INSUFFICIENT_BALANCE");

    // 4. Recall via query-readonly (normal, degraded, 402)
    const recOk = await store.recall("owner", { bank: "persona", query: "界面偏好" });
    assert.equal(recOk.ok, true);
    assert.equal(recOk.degraded, false);
    assert.equal(recOk.items.length, 1);
    assert.equal(recOk.items[0]!.id, "mem-ok-1");

    nextRecallMode = "degraded";
    const recDeg = await store.recall("owner", { bank: "persona", query: "界面偏好" });
    assert.equal(recDeg.ok, true);
    assert.equal(recDeg.degraded, true);
    assert.equal(recDeg.fallbackMessages?.length, 1);

    nextRecallMode = "402";
    const recDenied = await store.recall("owner", { bank: "persona", query: "界面偏好" });
    assert.equal(recDenied.ok, false);
    assert.equal(recDenied.errorCode, "QUOTA_EXHAUSTED");

    // 5. Erase chunks > 50 IDs into 2 calls
    const manyIds = Array.from({ length: 65 }, (_, i) => `m_${i}`);
    const eraseRes = await store.erase("owner", { bank: "persona", memoryIds: manyIds });
    assert.equal(eraseRes.ok, true);
    assert.equal(eraseRes.erased.length, 65);
    const eraseCalls = requests.filter((r) => r.url.endsWith("/messages/erase"));
    assert.equal(eraseCalls.length, 2);

    // 6. Usage calculation
    const usage = await store.getUsage();
    assert.ok(usage);
    assert.equal(usage.vaultCount, 2);
    assert.equal(usage.createCredits, 45000);
    assert.equal(usage.queryCredits, 1.2);
    assert.equal(usage.userPaidCredits, 1.2);

    // Ensure query-readonly was used, never /api/v1/memory/query
    assert.equal(
      requests.some((r) => r.url === "/api/v1/memory/query"),
      false,
    );
  } finally {
    dbHandle.close();
    await new Promise<void>((resolveClose) => mockServer.close(() => resolveClose()));
  }
});

test("shouldAutoRecall skips short phatic acks and slash commands", () => {
  assert.equal(shouldAutoRecall("嗯", 4), false);
  assert.equal(shouldAutoRecall("早安呀", 4), false);
  assert.equal(shouldAutoRecall("好的", 2), false);
  assert.equal(shouldAutoRecall("谢谢你", 2), false);
  assert.equal(shouldAutoRecall("/trace", 2), false);
  assert.equal(shouldAutoRecall("我之前说周末要去哪里吃饭来着？", 4), true);
  assert.equal(shouldAutoRecall("DeepSeek 这周出新版了吗", 4), true);
});

test("normalizeRecallEntries parses live MemoryEcho litemem message.content blocks and strips wrappers", () => {
  const query = "用户 偏好 习惯";
  const raw = [
    {
      message: {
        content: [{ type: "text", text: "与用户对话的长期记忆:\n" }],
        id: "",
        iso_time: null,
        role: "user",
      },
      score: null,
    },
    {
      message: {
        content: [
          {
            type: "text",
            text: "与用户近期的对话记忆:\n[2026-11-17 00:10:19] user: 用户喜欢深色模式。",
          },
        ],
        id: "",
        iso_time: null,
        role: "user",
      },
      score: null,
    },
    {
      message: {
        content: [
          {
            type: "text",
            text: "以上为Prompt与用户记忆和提示有关内容\nUser Time: [2026-11-17 00:20:10]\n以下为用户本轮消息:",
          },
        ],
        id: "",
        iso_time: null,
        role: "user",
      },
      score: null,
    },
    {
      message: {
        content: [{ type: "text", text: query }],
        id: "echo-id-1",
        iso_time: null,
        role: "user",
      },
      score: null,
    },
  ];

  const items = normalizeRecallEntries(raw, "persona", query);
  assert.equal(items.length, 1);
  assert.match(items[0]!.content, /用户喜欢深色模式/);
});
