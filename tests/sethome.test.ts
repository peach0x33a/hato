import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { bindTelegramHomeChannel, writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { parseSethomeCommand, TelegramAdapter } from "../src/gateway/tg.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("parseSethomeCommand parses /sethome with optional code and @bot suffix", () => {
  assert.deepEqual(parseSethomeCommand("/sethome"), { isSethome: true, code: null });
  assert.deepEqual(parseSethomeCommand("/sethome@HatoBot"), { isSethome: true, code: null });
  assert.deepEqual(parseSethomeCommand("/sethome HATO-A1B2C3"), {
    isSethome: true,
    code: "HATO-A1B2C3",
  });
  assert.deepEqual(parseSethomeCommand("/sethome@HatoBot hatO-a1b2c3"), {
    isSethome: true,
    code: "hatO-a1b2c3",
  });
  assert.deepEqual(parseSethomeCommand("hello"), { isSethome: false, code: null });
});

test("HatoRepository generates one-time pairing code and TelegramAdapter guards /sethome claim", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-sethome-test-"));
  const hatoPath = join(tempDir, "hato.toml");
  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    let currentConfig = createDefaultHatoConfig();
    currentConfig.owner.channels.tg.user_ids = [];
    writeHatoConfig(hatoPath, currentConfig);

    const code1 = repo.getOrCreateHomePairingCode("tg");
    const code2 = repo.getOrCreateHomePairingCode("tg");
    const qqCode = repo.getOrCreateHomePairingCode("qq");
    assert.equal(code1, code2);
    assert.ok(code1.startsWith("HATO-"));
    assert.notEqual(qqCode, code1);

    const replies: string[] = [];
    const adapter = new TelegramAdapter({
      config: currentConfig,
      botToken: "123456:fake-test-token",
      proxyRouter: new ScopedProxyRouter([]),
      onInboundMessage: () => undefined,
      onClaimHome: async ({ platformUserId, code }) => {
        if (!repo.verifyAndConsumeHomePairingCode("tg", code)) {
          return { ok: false, reply: "配对码无效或已过期" };
        }
        const bound = bindTelegramHomeChannel({
          hatoConfigPath: hatoPath,
          repo,
          canonicalUserId: currentConfig.owner.canonical_user_id,
          tgUserId: platformUserId,
          currentConfig,
        });
        currentConfig = bound.updatedConfig;
        adapter.updateConfig(currentConfig);
        return { ok: true, reply: `认领成功: ${platformUserId}` };
      },
    });

    // Normal text from stranger when unbound is ignored
    const handledNormal = await adapter.handlePrivateTextForClaim({
      chatType: "private",
      fromUserId: "55555",
      messageId: "1",
      text: "hi bot",
      replyFn: async (t) => {
        replies.push(t);
      },
    });
    assert.equal(handledNormal, false);
    assert.equal(replies.length, 0);

    // /sethome without pairing code prompts for pairing code
    const handledNoCode = await adapter.handlePrivateTextForClaim({
      chatType: "private",
      fromUserId: "55555",
      messageId: "2",
      text: "/sethome",
      replyFn: async (t) => {
        replies.push(t);
      },
    });
    assert.equal(handledNoCode, true);
    assert.ok(replies[0]?.includes("配对码"));

    // Wrong code is rejected and does NOT consume real code
    const handledWrong = await adapter.handlePrivateTextForClaim({
      chatType: "private",
      fromUserId: "55555",
      messageId: "3",
      text: "/sethome HATO-000000",
      replyFn: async (t) => {
        replies.push(t);
      },
    });
    assert.equal(handledWrong, true);
    assert.ok(replies[1]?.includes("无效"));

    // Valid code (case-insensitive) succeeds, binds user, consumes code, and saves config
    const handledValid = await adapter.handlePrivateTextForClaim({
      chatType: "private",
      fromUserId: "777888",
      messageId: "4",
      text: `/sethome ${code1.toLowerCase()}`,
      replyFn: async (t) => {
        replies.push(t);
      },
    });
    assert.equal(handledValid, true);
    assert.equal(replies[2], "认领成功: 777888");
    assert.deepEqual(currentConfig.owner.channels.tg.user_ids, [777888]);
    assert.equal(repo.verifyAndConsumeHomePairingCode("tg", code1), false);
    // Consuming TG pairing code must not affect QQ pairing code
    assert.equal(repo.verifyAndConsumeHomePairingCode("qq", qqCode), true);

    // Once an owner is bound, unbound claim path rejects further claims
    const handledAfterBind = await adapter.handlePrivateTextForClaim({
      chatType: "private",
      fromUserId: "999999",
      messageId: "5",
      text: `/sethome ${code1}`,
      replyFn: async (t) => {
        replies.push(t);
      },
    });
    assert.equal(handledAfterBind, false);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
