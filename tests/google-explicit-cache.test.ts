import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { GoogleExplicitCacheManager } from "../src/config/google-explicit-cache.js";

function makeGoogleModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65536,
    ...overrides,
  };
}

function makePayload(extraSystem = "x".repeat(5000)) {
  return {
    model: "gemini-3.5-flash-lite",
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    config: {
      systemInstruction: `System prompt ${extraSystem}`,
      tools: [{ functionDeclarations: [{ name: "calc", description: "Calculate" }] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      temperature: 0.7,
    },
  };
}

test("GoogleExplicitCacheManager creates, reuses, renews, and invalidates cachedContents", async () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let expireTime = new Date(Date.now() + 3600_000).toISOString();

  const manager = new GoogleExplicitCacheManager({
    minEstimatedChars: 1000,
    fetcher: async (url, init) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });

      if (method === "POST") {
        return new Response(
          JSON.stringify({
            name: "cachedContents/cache_abc123",
            expireTime,
            usageMetadata: { totalTokenCount: 2048 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "PATCH") {
        return new Response(
          JSON.stringify({
            name: "cachedContents/cache_abc123",
            expireTime: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  const model = makeGoogleModel();
  const payload1 = makePayload();

  // 1) First call creates cachedContent and strips prefix from config
  const out1 = (await manager.preparePayload({
    model,
    apiKey: "gem-key-1",
    payload: payload1,
    ttlMinutes: 60,
  })) as { config: Record<string, unknown> };

  assert.ok(out1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "POST");
  assert.equal(
    calls[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/cachedContents",
  );
  assert.equal(out1.config.cachedContent, "cachedContents/cache_abc123");
  assert.equal(out1.config.systemInstruction, undefined);
  assert.equal(out1.config.tools, undefined);
  assert.equal(out1.config.toolConfig, undefined);
  assert.equal(out1.config.temperature, 0.7);

  // 2) Second identical call reuses cache with 0 extra POST calls
  const out2 = (await manager.preparePayload({
    model,
    apiKey: "gem-key-1",
    payload: makePayload(),
    ttlMinutes: 60,
  })) as { config: Record<string, unknown> };
  assert.equal(out2.config.cachedContent, "cachedContents/cache_abc123");
  assert.equal(calls.length, 1);

  // 3) Invalidate forces a new POST on next call
  manager.invalidateForModel("google", "gemini-3.5-flash-lite");
  expireTime = new Date(Date.now() + 120_000).toISOString(); // near expiry to test PATCH renewal next
  const out3 = (await manager.preparePayload({
    model,
    apiKey: "gem-key-1",
    payload: makePayload(),
    ttlMinutes: 60,
  })) as { config: Record<string, unknown> };
  assert.equal(out3.config.cachedContent, "cachedContents/cache_abc123");
  assert.equal(calls.length, 2);

  // 4) Near-expiry reuse triggers background PATCH renewal
  const out4 = (await manager.preparePayload({
    model,
    apiKey: "gem-key-1",
    payload: makePayload(),
    ttlMinutes: 60,
  })) as { config: Record<string, unknown> };
  assert.equal(out4.config.cachedContent, "cachedContents/cache_abc123");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.method, "PATCH");
  assert.equal(
    calls[2]?.url,
    "https://generativelanguage.googleapis.com/v1beta/cachedContents/cache_abc123",
  );
});

test("GoogleExplicitCacheManager falls back gracefully on unsupported endpoint or HTTP error", async () => {
  let postCount = 0;
  const manager = new GoogleExplicitCacheManager({
    minEstimatedChars: 100,
    fetcher: async () => {
      postCount += 1;
      return new Response("not implemented", { status: 404 });
    },
  });

  const model = makeGoogleModel({ baseUrl: "https://relay.example.com/v1beta/" });
  const first = await manager.preparePayload({
    model,
    apiKey: "k1",
    payload: makePayload("y".repeat(500)),
  });
  assert.equal(first, undefined);
  assert.equal(postCount, 1);

  // Cooldown prevents spamming 404 endpoint on immediate next turn
  const second = await manager.preparePayload({
    model,
    apiKey: "k1",
    payload: makePayload("y".repeat(500)),
  });
  assert.equal(second, undefined);
  assert.equal(postCount, 1);
});
