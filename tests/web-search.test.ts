import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveTavilySearchConfig } from "../src/config/app.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { createPersonaReadOnlyTools } from "../src/persona/tools.js";
import { runTavilySearch } from "../src/persona/web-search.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { probeTavilySearch } from "../src/setup/probe.js";

test("runTavilySearch and web_search tool route via web_access proxy scope and format results", async () => {
  const received: Array<{
    method?: string;
    url?: string;
    auth?: string;
    body?: Record<string, unknown>;
  }> = [];

  const mockServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    received.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: parsed,
    });

    // If acting as HTTP proxy to target host or direct /search endpoint:
    if (req.url?.includes("/search")) {
      if (req.headers.authorization !== "Bearer tvly-test-key") {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ detail: "Invalid API key" }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          answer: "Tavily is a search engine optimized for AI agents.",
          results: [
            {
              title: "Tavily Official Docs",
              url: "https://docs.tavily.com/",
              content: "Real-time search API for LLMs.",
              published_date: "2026-11-01",
            },
          ],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolveListen) => {
    mockServer.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = mockServer.address();
  assert.ok(addr && typeof addr !== "string");
  const serverUrl = `http://127.0.0.1:${addr.port}`;

  const tempDir = mkdtempSync(join(tmpdir(), "hato-web-search-"));
  const dbHandle = openDatabase(join(tempDir, "hato.db"));
  const repo = new HatoRepository(dbHandle.db);

  const prevTavilyEnv = process.env.TAVILY_TEST_API_KEY;
  try {
    // Route `web_access` scope to our mock server acting as proxy so we verify `web_access` resolution.
    const proxyRouter = new ScopedProxyRouter([
      {
        name: "web-proxy",
        url: serverUrl,
        scope: ["web_access"],
      },
    ]);

    assert.equal(proxyRouter.resolveScope("web_access").mode, "proxy");
    assert.equal(proxyRouter.resolveScope("web_access.tavily").matchedScope, "web_access");

    const baseCfg = createDefaultHatoConfig();
    baseCfg.web = {
      search: {
        provider: "tavily",
        enabled: true,
        api_key_env: "TAVILY_TEST_API_KEY",
        base_url: "http://tavily.local",
        max_results: 4,
        search_depth: "basic",
      },
    };

    const resolvedCfg = resolveTavilySearchConfig(baseCfg);
    assert.equal(resolvedCfg.maxResults, 4);

    // 1. Missing env key returns friendly message without throwing.
    delete process.env.TAVILY_TEST_API_KEY;
    const missingRes = await runTavilySearch({
      config: resolvedCfg,
      proxyRouter,
      input: { query: "Tavily" },
    });
    assert.equal(missingRes.ok, false);
    assert.ok(missingRes.formattedText.includes("TAVILY_TEST_API_KEY"));

    // 2. Valid key executes via `web_access` scope and formats answer + results.
    process.env.TAVILY_TEST_API_KEY = "tvly-test-key";
    const tools = createPersonaReadOnlyTools({
      repo,
      canonicalUserId: "owner",
      getTimezone: () => "Asia/Singapore",
      getHatoConfig: () => baseCfg,
      proxyRouter,
    });
    const webTool = tools.find((t) => t.name === "web_search");
    assert.ok(webTool);

    const toolRes = await webTool.execute("call_1", {
      query: "Tavily search API",
      topic: "news",
      time_range: "week",
    });
    const textBlock = toolRes.content[0];
    assert.equal(textBlock?.type, "text");
    assert.ok(textBlock.text.includes("Tavily is a search engine optimized for AI agents."));
    assert.ok(textBlock.text.includes("https://docs.tavily.com/"));
    assert.equal(received.length, 1);
    assert.equal(received[0]?.auth, "Bearer tvly-test-key");
    assert.equal(received[0]?.body?.topic, "news");
    assert.equal(received[0]?.body?.time_range, "week");
    assert.equal(received[0]?.body?.max_results, 4);

    // 3. Probe verifies key and `web_access` proxy resolution cleanly.
    const probeOk = await probeTavilySearch({
      config: resolvedCfg,
      proxyRouter,
      apiKey: "tvly-test-key",
    });
    assert.equal(probeOk.ok, true);
    assert.equal(probeOk.resultCount, 1);
    assert.equal(probeOk.proxy.matchedScope, "web_access");

    const probeBad = await probeTavilySearch({
      config: resolvedCfg,
      proxyRouter,
      apiKey: "wrong-key",
    });
    assert.equal(probeBad.ok, false);
    assert.ok(probeBad.error?.includes("401"));
  } finally {
    if (prevTavilyEnv === undefined) delete process.env.TAVILY_TEST_API_KEY;
    else process.env.TAVILY_TEST_API_KEY = prevTavilyEnv;
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolveClose) => mockServer.close(() => resolveClose()));
  }
});
