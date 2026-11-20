import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { HindsightStore } from "../src/memory/hindsight.js";

describe("HindsightStore", () => {
  test("retain, recall, erase, and listVaults work against Hindsight REST API and degrade cleanly on error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-hindsight-"));
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.body ? await req.json().catch(() => undefined) : undefined;
        requests.push({ method: req.method, path: url.pathname, body });

        if (req.method === "PUT" && url.pathname.startsWith("/v1/default/banks/")) {
          return Response.json({ ok: true });
        }
        if (req.method === "POST" && url.pathname.endsWith("/memories")) {
          return Response.json({ results: [{ id: "hs_mem_1" }] });
        }
        if (req.method === "POST" && url.pathname.endsWith("/memories/recall")) {
          return Response.json({
            results: [
              {
                id: "hs_mem_1",
                text: "用户喜欢喝冰美式",
                score: 0.92,
                created_at: "2026-11-20T10:00:00Z",
                metadata: { role: "user" },
              },
            ],
          });
        }
        if (req.method === "DELETE" && url.pathname.endsWith("/hs_mem_1")) {
          return Response.json({ deleted: true });
        }
        if (req.method === "DELETE" && url.pathname.endsWith("/hs_missing")) {
          return new Response("Not Found", { status: 404 });
        }
        if (req.method === "GET" && url.pathname === "/v1/default/banks") {
          return Response.json({
            banks: [{ bank_id: "persona_u1", name: "hato-persona", memory_count: 1 }],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const dbHandle = openDatabase(join(dir, "test.db"));
      const repo = new HatoRepository(dbHandle.db);
      const store = new HindsightStore(
        {
          enabled: true,
          baseUrl: `http://127.0.0.1:${server.port}`,
          apiKeyEnv: "HINDSIGHT_API_KEY",
          timeoutMs: 5000,
          embeddingDimensions: 1024,
          banks: { persona: "persona", tech: "tech" },
        },
        new ScopedProxyRouter([]),
        repo,
      );

      expect(store.isConfigured()).toBe(true);

      const retained = await store.retain("u1", {
        bank: "persona",
        role: "user",
        content: "用户喜欢喝冰美式",
      });
      expect(retained.ok).toBe(true);
      expect(retained.status).toBe("synced");
      expect(retained.externalMemoryId).toBe("hs_mem_1");
      expect(retained.vaultId).toBe("persona_u1");

      repo.insertMemorySyncRecord({
        canonicalUserId: "u1",
        provider: "hindsight",
        bank: "persona",
        vaultId: "persona_u1",
        sourceMsgIds: ["m1"],
        content: "用户喜欢喝冰美式",
        externalMemoryId: "hs_mem_1",
        status: "synced",
      });

      const recalled = await store.recall("u1", { bank: "persona", query: "冰美式", limit: 5 });
      expect(recalled.ok).toBe(true);
      expect(recalled.degraded).toBe(false);
      expect(recalled.items).toHaveLength(1);
      expect(recalled.items[0]?.content).toBe("用户喜欢喝冰美式");

      const vaults = await store.listVaults();
      expect(vaults).toHaveLength(1);
      expect(vaults[0]?.id).toBe("persona_u1");

      const erased = await store.erase("u1", {
        bank: "persona",
        memoryIds: ["hs_mem_1", "hs_missing"],
      });
      expect(erased.ok).toBe(true);
      expect(erased.erased).toEqual(["hs_mem_1"]);
      expect(erased.alreadyErased).toEqual(["hs_missing"]);

      // Stop server -> recall degrades to local SQLite fallback cleanly
      server.stop(true);
      const degraded = await store.recall("u1", { bank: "persona", query: "冰美式", limit: 5 });
      expect(degraded.ok).toBe(false);
      expect(degraded.degraded).toBe(true);
      expect(degraded.fallbackMessages?.length).toBeGreaterThanOrEqual(1);

      dbHandle.close();
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
