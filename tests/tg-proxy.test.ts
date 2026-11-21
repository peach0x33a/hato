import assert from "node:assert/strict";
import test from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { TelegramAdapter } from "../src/gateway/tg.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("TelegramAdapter routes grammY Bot API calls through gateway.telegram scoped fetch with 60s timeout", async () => {
  const config = createDefaultHatoConfig();
  config.gateway.telegram.base_url = "https://tg-api.local.test";

  const proxyRouter = new ScopedProxyRouter([]);
  const requestedScopes: string[] = [];
  const fetchedUrls: string[] = [];

  const stubFetch: typeof globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchedUrls.push(url);
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 42,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 12345, type: "private" },
            text: "hello",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  proxyRouter.createScopedFetch = (scope: string) => {
    requestedScopes.push(scope);
    return stubFetch;
  };

  const adapter = new TelegramAdapter({
    config,
    botToken: "123456:TEST_TOKEN",
    proxyRouter,
    onInboundMessage: () => {},
  });

  assert.deepEqual(requestedScopes, ["gateway.telegram"]);

  // Verify grammY client timeoutSeconds is configured to 60 (instead of default 500)
  const botInternals = adapter as unknown as {
    bot: { api: { raw: unknown } & Record<string, unknown> };
  };
  const clientConfig = (botInternals.bot as unknown as { clientConfig?: { timeoutSeconds?: number } })
    .clientConfig;
  if (clientConfig && "timeoutSeconds" in clientConfig) {
    assert.equal(clientConfig.timeoutSeconds, 60);
  }

  const msgId = await adapter.sendText("12345", "hello");
  assert.equal(msgId, "42");
  assert.equal(fetchedUrls.length, 1);
  assert.ok(fetchedUrls[0]!.startsWith("https://tg-api.local.test/bot123456:TEST_TOKEN/sendMessage"));
});
