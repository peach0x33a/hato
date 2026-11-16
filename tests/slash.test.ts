import assert from "node:assert/strict";
import test from "node:test";
import { tryHandleSlashCommand } from "../src/commands/slash.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";

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
