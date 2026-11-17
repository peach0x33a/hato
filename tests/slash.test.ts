import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildTelegramBotCommands, tryHandleSlashCommand } from "../src/commands/slash.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { TelegramAdapter } from "../src/gateway/tg.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("tryHandleSlashCommand handles /trace, /model, /reload, /compact, and ignores normal text", async () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    repo.insertTurnTrace({
      canonicalUserId: "owner",
      slot: "persona",
      provider: "google-gateway",
      modelId: "gemini-4-hydrogen",
      api: "google-generative-ai",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      recalledIds: [],
      timeCardText: "<time>\n现在: 2026-11-16\n</time>",
      toolCalls: ["calc"],
      latencyMs: 250,
    });

    let activeTarget = "google-gateway/gemini-4-hydrogen";
    const deps = {
      repo,
      listModelSlots: () => [
        { slot: "persona", target: activeTarget, api: "google-generative-ai", baseUrl: "https://example.com" },
      ],
      listAvailableModels: () => ["google-gateway/gemini-4-hydrogen", "openai-gateway/gpt-6.1-sol"],
      setModelSlot: (slot: string, target: string) => {
        activeTarget = target;
        return { slot, target, api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
      },
      reloadAll: async () => ({
        slots: [{ slot: "persona", target: activeTarget, api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
        proxyCount: 2,
        changes: ["network.proxies: (全部直连) -> local (http://127.0.0.1:7890 -> [browser])"],
      }),
      forceCompact: async () => true,
      resetContext: async () => ({
        clearedHotMessages: 6,
        hadSummary: true,
      }),
      setHomeChannel: async () => ({
        channel: "tg" as const,
        targetId: "123456789",
        addedToWhitelist: false,
        savedToConfig: true,
      }),
    };

    assert.equal(await tryHandleSlashCommand("owner", "你好呀", deps), null);

    const helpOut = await tryHandleSlashCommand("owner", "/help", deps);
    assert.ok(helpOut?.includes("/new"));
    assert.ok(helpOut?.includes("/sethome"));

    const newOut = await tryHandleSlashCommand("owner", "/new", deps);
    assert.ok(newOut?.includes("已开启新对话"));
    assert.ok(newOut?.includes("6 条热区消息"));
    assert.ok(newOut?.includes("前情摘要"));

    const homeOut = await tryHandleSlashCommand("owner", "/sethome", deps);
    assert.ok(homeOut?.includes("Home Channel"));
    assert.ok(homeOut?.includes("123456789"));

    const traceOut = await tryHandleSlashCommand("owner", "/trace", deps);
    assert.ok(traceOut?.includes("cache_read=80"));
    assert.ok(traceOut?.includes("44.4%"));
    assert.ok(traceOut?.includes("calc"));

    const missingPrefixOut = await tryHandleSlashCommand("owner", "/model set persona gpt-6.1-sol", deps);
    assert.ok(missingPrefixOut?.includes("必须带 Provider 前缀"));
    assert.ok(missingPrefixOut?.includes("openai-gateway/gpt-6.1-sol"));

    const setOut = await tryHandleSlashCommand("owner", "/model set persona openai-gateway/gpt-6.1-sol", deps);
    assert.ok(setOut?.includes("openai-gateway/gpt-6.1-sol"));

    const reloadOut = await tryHandleSlashCommand("owner", "/reload", deps);
    assert.ok(reloadOut?.includes("代理规则 2 条"));
    assert.ok(reloadOut?.includes("本次变更差异 (1 项)"));
    assert.ok(reloadOut?.includes("network.proxies"));

    const compactOut = await tryHandleSlashCommand("owner", "/compact", deps);
    assert.ok(compactOut?.includes("已完成一次热区上下文压缩"));
  } finally {
    handle.close();
  }
});

test("buildTelegramBotCommands and TelegramAdapter.syncBotCommands dynamically register scoped commands", async () => {
  const unbound = buildTelegramBotCommands({ memoryEnabled: false, unboundOnly: true });
  assert.deepEqual(
    unbound.map((c) => c.command),
    ["help", "sethome"],
  );

  const withoutMemory = buildTelegramBotCommands({ memoryEnabled: false });
  assert.equal(withoutMemory.some((c) => c.command === "memory"), false);
  assert.equal(withoutMemory.some((c) => c.command === "forget"), false);

  const withMemory = buildTelegramBotCommands({ memoryEnabled: true });
  assert.equal(withMemory.some((c) => c.command === "memory"), true);
  assert.equal(withMemory.some((c) => c.command === "forget"), true);
  for (const cmd of withMemory) {
    assert.match(cmd.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(cmd.description.length >= 1 && cmd.description.length <= 256);
  }

  const botApiCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const mockTgServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const method = (req.url ?? "").split("/").pop() ?? "";
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    botApiCalls.push({ method, body: parsed });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, result: true }));
  });

  await new Promise<void>((resolveListen) => mockTgServer.listen(0, "127.0.0.1", resolveListen));
  const addr = mockTgServer.address();
  assert.ok(addr && typeof addr !== "string");

  try {
    const cfg = createDefaultHatoConfig();
    cfg.gateway.telegram.base_url = `http://127.0.0.1:${addr.port}`;
    cfg.owner.channels.tg.user_ids = [];

    const adapter = new TelegramAdapter({
      config: cfg,
      botToken: "123456:test-token",
      proxyRouter: new ScopedProxyRouter([]),
      onInboundMessage: () => undefined,
    });

    // 1. Unbound mode: sets sethome + help in all_private_chats
    const didSync1 = await adapter.syncBotCommands();
    assert.equal(didSync1, true);
    const unboundSet = botApiCalls.find((c) => c.method === "setMyCommands");
    assert.ok(unboundSet);
    assert.deepEqual(unboundSet.body.scope, { type: "all_private_chats" });
    assert.equal((unboundSet.body.commands as Array<{ command: string }>).length, 2);

    // 2. Calling again with identical state skips duplicate API calls
    const countBeforeRepeat = botApiCalls.length;
    const didSyncRepeat = await adapter.syncBotCommands();
    assert.equal(didSyncRepeat, false);
    assert.equal(botApiCalls.length, countBeforeRepeat);

    // 3. Owner bound + MemoryEcho enabled: clears default/public scopes and sets full commands for owner chat_id
    botApiCalls.length = 0;
    const nextCfg = structuredClone(cfg);
    nextCfg.owner.channels.tg.user_ids = [2017924851];
    nextCfg.memory.provider = "memoryecho";
    nextCfg.memory.memoryecho!.enabled = true;
    adapter.updateConfig(nextCfg);
    const didSync2 = await adapter.syncBotCommands();
    assert.equal(didSync2, true);

    const chatSet = botApiCalls.find((c) => c.method === "setMyCommands");
    assert.ok(chatSet);
    assert.deepEqual(chatSet.body.scope, { type: "chat", chat_id: 2017924851 });
    const names = (chatSet.body.commands as Array<{ command: string }>).map((c) => c.command);
    assert.ok(names.includes("memory"));
    assert.ok(names.includes("forget"));
    assert.ok(names.includes("trace"));
    assert.equal(
      botApiCalls.filter((c) => c.method === "deleteMyCommands").length,
      3,
    );
  } finally {
    await new Promise<void>((resolveClose) => mockTgServer.close(() => resolveClose()));
  }
});
