import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadModelsFileConfig, type ModelsFileConfig } from "../src/config/models.js";
import { ModelsDevRegistry, parseModelsDevRef, type ModelsDevCatalog } from "../src/config/models-dev.js";
import { writeModelsConfig } from "../src/config/store.js";

const SAMPLE_CATALOG: ModelsDevCatalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: false,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128000, output: 16384 },
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
      },
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    models: {
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 131072, output: 32768 },
      },
    },
  },
};

test("parseModelsDevRef parses provider/model and rejects invalid refs", () => {
  assert.deepEqual(parseModelsDevRef("openai/gpt-4o"), {
    providerId: "openai",
    modelId: "gpt-4o",
    ref: "openai/gpt-4o",
  });
  assert.deepEqual(parseModelsDevRef("openrouter/anthropic/claude-sonnet-4-5"), {
    providerId: "openrouter",
    modelId: "anthropic/claude-sonnet-4-5",
    ref: "openrouter/anthropic/claude-sonnet-4-5",
  });
  assert.equal(parseModelsDevRef("gpt-4o"), null);
  assert.equal(parseModelsDevRef("/gpt-4o"), null);
  assert.equal(parseModelsDevRef("openai/"), null);
  assert.equal(parseModelsDevRef("openai/gpt 4o"), null);
});

test("ModelsDevRegistry caches catalog, maps metadata, and searches entries", async () => {
  let fetchCount = 0;
  const registry = new ModelsDevRegistry({
    cacheTtlMs: 60_000,
    fetcher: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify(SAMPLE_CATALOG), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const gpt4o = await registry.lookup("openai/gpt-4o");
  assert.ok(gpt4o);
  assert.equal(gpt4o.ref, "openai/gpt-4o");
  assert.equal(gpt4o.name, "GPT-4o");
  assert.equal(gpt4o.reasoning, false);
  assert.deepEqual(gpt4o.input, ["text", "image"]);
  assert.equal(gpt4o.context_window, 128000);
  assert.equal(gpt4o.max_tokens, 16384);
  assert.deepEqual(gpt4o.cost, { input: 2.5, output: 10, cache_read: 1.25 });

  // Second lookup should hit cache
  const ds = await registry.lookup("deepseek/DEEPSEEK-V4-FLASH");
  assert.ok(ds);
  assert.equal(ds.ref, "deepseek/deepseek-v4-flash");
  assert.equal(ds.reasoning, true);
  assert.deepEqual(ds.input, ["text"]);
  assert.equal(fetchCount, 1);

  const missing = await registry.lookup("openai/non-existent");
  assert.equal(missing, null);

  const searchResults = await registry.search("deepseek");
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0]?.ref, "deepseek/deepseek-v4-flash");
  assert.equal(searchResults[0]?.reasoning, true);
  assert.equal(searchResults[0]?.supportsVision, false);

  const probeOk = await registry.probe();
  assert.equal(probeOk.ok, true);
  assert.equal(probeOk.providerCount, 2);
  assert.equal(probeOk.modelCount, 2);
  assert.ok(probeOk.latencyMs >= 0);

  const failingRegistry = new ModelsDevRegistry({
    fetcher: async () => new Response("upstream down", { status: 503 }),
  });
  const probeFail = await failingRegistry.probe();
  assert.equal(probeFail.ok, false);
  assert.match(probeFail.error ?? "", /503/);
});

test("models.toml schema validates and persists models_dev mapping", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-models-dev-"));
  const modelsToml = join(tempDir, "models.toml");
  try {
    const config: ModelsFileConfig = {
      slots: {
        persona: "relay/gpt-4o",
        router: "relay/gpt-4o",
        curator: "relay/gpt-4o",
        worker: "relay/gpt-4o",
        hindsight_llm: "relay/gpt-4o",
      },
      providers: {
        relay: {
          api: "openai-completions",
          base_url: "https://example.com/v1",
          models: [
            {
              id: "gpt-4o",
              name: "GPT-4o",
              reasoning: false,
              input: ["text", "image"],
              context_window: 128000,
              max_tokens: 16384,
              models_dev: {
                enabled: true,
                model_ref: "openai/gpt-4o",
              },
            },
          ],
        },
      },
    };

    writeModelsConfig(modelsToml, config, { backup: false });
    const loaded = loadModelsFileConfig(modelsToml);
    assert.equal(loaded.providers.relay?.models[0]?.models_dev?.enabled, true);
    assert.equal(loaded.providers.relay?.models[0]?.models_dev?.model_ref, "openai/gpt-4o");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
