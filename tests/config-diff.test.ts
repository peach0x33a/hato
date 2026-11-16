import assert from "node:assert/strict";
import test from "node:test";
import { collectReloadDiff, fingerprintSecret, type ReloadSnapshot } from "../src/config/diff.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("collectReloadDiff reports slot, model, proxy, config field, prompt, and secret differences safely", () => {
  const baseCfg = createDefaultHatoConfig();
  baseCfg.network = {
    proxies: [{ name: "llm", url: "http://user:pass123@127.0.0.1:19270", scope: ["llm-calling"] }],
  };

  const prev: ReloadSnapshot = {
    hatoConfig: baseCfg,
    slots: [
      {
        slot: "persona",
        target: "relay/deepseek-flash",
        api: "openai-completions",
        baseUrl: "https://relay.example/v1",
        reasoning: true,
        input: ["text", "image"],
      },
    ],
    availableTargets: ["relay/deepseek-flash"],
    promptText: "你好",
    secretFingerprints: {
      TAVILY_API_KEY: fingerprintSecret("old-secret-token"),
      EXTRA_KEY: "",
    },
  };

  // Zero-change check
  assert.deepEqual(collectReloadDiff(prev, prev), []);

  const nextCfg = structuredClone(baseCfg);
  nextCfg.network = {
    proxies: [
      { name: "llm", url: "http://user:pass123@127.0.0.1:19270", scope: ["llm-calling", "browser"] },
    ],
  };
  nextCfg.web!.search!.base_url = "https://api.tavily.com";
  nextCfg.gateway.retry!.max_retries = 5;

  const next: ReloadSnapshot = {
    hatoConfig: nextCfg,
    slots: [
      {
        slot: "persona",
        target: "relay/gemini-4-hydrogen",
        api: "google-generative-ai",
        baseUrl: "https://relay.example/v1beta",
        reasoning: true,
        input: ["text", "image"],
      },
    ],
    availableTargets: ["relay/deepseek-flash", "relay/gemini-4-hydrogen"],
    promptText: "你好，更新后的提示词",
    secretFingerprints: {
      TAVILY_API_KEY: fingerprintSecret("new-secret-token"),
      EXTRA_KEY: fingerprintSecret("added-key"),
    },
  };

  const diff = collectReloadDiff(prev, next);
  const joined = diff.join("\n");

  assert.ok(joined.includes("槽位 persona"));
  assert.ok(joined.includes("google-generative-ai"));
  assert.ok(joined.includes("新增模型: relay/gemini-4-hydrogen"));
  assert.ok(joined.includes("network.proxies"));
  assert.ok(joined.includes("browser"));
  assert.ok(!joined.includes("pass123"));
  assert.ok(joined.includes("gateway.retry.max_retries: 3 -> 5"));
  assert.ok(joined.includes("人设提示词: 已更新"));
  assert.ok(joined.includes("密钥 TAVILY_API_KEY: 已更新"));
  assert.ok(joined.includes("密钥 EXTRA_KEY: 未设置 -> 已配置"));
  assert.ok(!joined.includes("old-secret-token"));
  assert.ok(!joined.includes("new-secret-token"));
});
