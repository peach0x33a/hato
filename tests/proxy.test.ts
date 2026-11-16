import assert from "node:assert/strict";
import test from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";

test("ScopedProxyRouter prioritizes exact scope over parent and all, with direct override", () => {
  const router = new ScopedProxyRouter([
    { name: "global", url: "http://127.0.0.1:7890", scope: ["all"] },
    { name: "tg-socks", url: "socks5://127.0.0.1:1080", scope: ["gateway.telegram"] },
    { name: "cn-direct", url: "direct", scope: ["memory", "llm-calling.aliyun"] },
  ]);

  assert.deepEqual(router.resolveScope("gateway.telegram"), {
    mode: "proxy",
    url: "socks5://127.0.0.1:1080",
    matchedScope: "gateway.telegram",
  });
  assert.deepEqual(router.resolveScope("gateway.qq"), {
    mode: "proxy",
    url: "http://127.0.0.1:7890",
    matchedScope: "all",
  });
  assert.deepEqual(router.resolveScope("llm-calling.google-gateway"), {
    mode: "proxy",
    url: "http://127.0.0.1:7890",
    matchedScope: "all",
  });
  assert.deepEqual(router.resolveScope("llm-calling.aliyun"), {
    mode: "direct",
    matchedScope: "llm-calling.aliyun",
  });
  assert.deepEqual(router.resolveScope("memory.hindsight"), {
    mode: "direct",
    matchedScope: "memory",
  });
});

test("ScopedProxyRouter propagates scope across async awaits via AsyncLocalStorage", async () => {
  const router = new ScopedProxyRouter([]);
  assert.equal(router.getCurrentScope(), "all");

  const observed = await router.runWithScope("llm-calling.google-gateway", async () => {
    await new Promise((r) => setTimeout(r, 10));
    return router.getCurrentScope();
  });

  assert.equal(observed, "llm-calling.google-gateway");
  assert.equal(router.getCurrentScope(), "all");
});
