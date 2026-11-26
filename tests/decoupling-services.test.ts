import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventBus } from "../src/bus/actor-bus.js";
import { loadHatoConfig } from "../src/config/app.js";
import { ConfigMutationService } from "../src/config/mutation.js";
import { writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { ConfirmationService } from "../src/gateway/confirmation.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("ConfigMutationService serializes concurrent patchHatoConfigAndReload calls without losing updates", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-cfg-mut-"));
  try {
    const cfgPath = join(tempDir, "hato.toml");
    const initial = createDefaultHatoConfig();
    writeHatoConfig(cfgPath, initial);

    let reloadCount = 0;
    const service = new ConfigMutationService({
      hatoConfigPath: cfgPath,
      onReload: async () => {
        await new Promise((r) => setTimeout(r, 10));
        reloadCount += 1;
        return reloadCount;
      },
    });

    await Promise.all([
      service.patchHatoConfigAndReload((base) => ({
        ...base,
        gateway: { ...base.gateway, debounce_ms: 1234 },
      })),
      service.patchHatoConfigAndReload((base) => ({
        ...base,
        owner: { ...base.owner, timezone: "UTC" },
      })),
    ]);

    const finalCfg = loadHatoConfig(cfgPath);
    assert.equal(finalCfg.gateway.debounce_ms, 1234);
    assert.equal(finalCfg.owner.timezone, "UTC");
    assert.equal(reloadCount, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ConfirmationService dispatches registered handlers, handles cancel, and falls back for worker tickets", async () => {
  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    repo.ensureOwner({
      canonicalUserId: "owner",
      timezone: "Asia/Shanghai",
      proactiveChannel: "tg",
    });
    const bus = new EventBus();
    const fallbackCalls: Array<{ ticketId: string; approved: boolean }> = [];
    const service = new ConfirmationService({
      repo,
      bus,
      onFallbackConfirm: async (ticketId, approved) => {
        fallbackCalls.push({ ticketId, approved });
        return `worker:${ticketId}:${approved}`;
      },
    });

    let ranValue = "";
    service.registerHandler<{ value: string }>("custom_op", async (_uid, payload) => {
      ranValue = payload.value;
      return { ok: true, message: `applied ${payload.value}` };
    });

    const req1 = await service.requestConfirm({
      canonicalUserId: "owner",
      channel: "tg",
      kind: "custom_op",
      briefTitle: "op1",
      progressNote: "waiting",
      promptText: "confirm op1?",
      payload: { value: "hello" },
    });
    const res1 = await service.handleConfirmAction(req1.ticketId, true);
    assert.equal(ranValue, "hello");
    assert.match(res1, /^已确认并执行/);
    assert.equal(repo.getTicket(req1.ticketId)?.status, "done");

    const req2 = await service.requestConfirm({
      canonicalUserId: "owner",
      channel: "tg",
      kind: "custom_op",
      briefTitle: "op2",
      progressNote: "waiting",
      promptText: "confirm op2?",
      payload: { value: "world" },
    });
    const res2 = await service.handleConfirmAction(req2.ticketId, false);
    assert.match(res2, /^已取消工单/);
    assert.equal(repo.getTicket(req2.ticketId)?.status, "cancelled");

    repo.createTicket({
      id: "t_worker_1",
      canonicalUserId: "owner",
      status: "awaiting_confirm",
      backend: "builtin-pi",
      briefTitle: "worker confirm",
      originChannel: "tg",
    });
    const res3 = await service.handleConfirmAction("t_worker_1", true);
    assert.equal(res3, "worker:t_worker_1:true");
    assert.deepEqual(fallbackCalls, [{ ticketId: "t_worker_1", approved: true }]);
  } finally {
    dbHandle.close();
  }
});
