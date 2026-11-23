import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HatoConfig } from "../src/config/app.js";
import type { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { MemoryCurator } from "../src/memory/curator.js";
import type { MemoryStore } from "../src/memory/store.js";

test("getMemorySyncRecordsByIds and forgetByRecordIds erase remote and local records", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-memory-bank-"));
  const dbPath = join(tempDir, "test.db");
  const handle = openDatabase(dbPath);

  try {
    const repo = new HatoRepository(handle.db);
    const uid = "owner_1";

    const r1 = repo.insertMemorySyncRecord({
      canonicalUserId: uid,
      provider: "memoryecho",
      bank: "persona",
      vaultId: "v_1",
      sourceMsgIds: ["m1"],
      content: "用户喜欢喝冰美式",
      externalMemoryId: "ext_1",
      status: "synced",
    });

    const r2 = repo.insertMemorySyncRecord({
      canonicalUserId: uid,
      provider: "memoryecho",
      bank: "persona",
      vaultId: "v_1",
      sourceMsgIds: ["m2"],
      content: "用户养了一只橘猫",
      externalMemoryId: "ext_2",
      status: "synced",
    });

    const fetched = repo.getMemorySyncRecordsByIds(uid, [r1.id, "non_existent"]);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0]?.id, r1.id);

    const erasedCalls: Array<{ bank: string; memoryIds: string[] }> = [];
    const mockStore: MemoryStore = {
      providerName: "memoryecho",
      isConfigured: () => true,
      resolveVaultId: async () => "v_1",
      retain: async () => ({ ok: true, status: "synced" }),
      recall: async (_u, p) => ({ ok: true, bank: p.bank, items: [], degraded: false }),
      erase: async (_u, p) => {
        erasedCalls.push({ bank: p.bank, memoryIds: p.memoryIds });
        return {
          ok: true,
          erased: p.memoryIds,
          alreadyErased: [],
          missing: [],
          unmapped: [],
          derivedCleanupFailed: false,
        };
      },
    };

    const minimalConfig = {
      owner: { canonical_user_id: uid, timezone: "Asia/Shanghai" },
      paths: { prompts_dir: tempDir },
    } as unknown as HatoConfig;

    const curator = new MemoryCurator(
      minimalConfig,
      {} as ModelRegistry,
      new ScopedProxyRouter([]),
      repo,
      mockStore,
    );

    const summary = await curator.forgetByRecordIds(uid, [r1.id]);
    assert.equal(summary.matchedCount, 1);
    assert.equal(summary.erasedRemoteCount, 1);
    assert.equal(summary.erasedLocalCount, 1);
    assert.equal(summary.failedCount, 0);
    assert.deepEqual(erasedCalls, [{ bank: "persona", memoryIds: ["ext_1"] }]);

    // r1 should now be erased and excluded from getMemorySyncRecordsByIds, while r2 remains active
    assert.equal(repo.getMemorySyncRecordsByIds(uid, [r1.id]).length, 0);
    const remaining = repo.listMemorySyncRecords(uid);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.id, r2.id);

    curator.dispose();
  } finally {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
