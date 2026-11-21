import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveApiKeyEnvFromSlug,
  ModelRegistry,
  parseQualifiedModelTarget,
  supportsCustomFetchOption,
} from "../src/config/models.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";

test("deriveApiKeyEnvFromSlug converts provider slug to <UPPER_SNAKE>_API_KEY", () => {
  assert.equal(deriveApiKeyEnvFromSlug("CustomRelay"), "CUSTOMRELAY_API_KEY");
  assert.equal(deriveApiKeyEnvFromSlug("custom-relay"), "CUSTOM_RELAY_API_KEY");
  assert.equal(deriveApiKeyEnvFromSlug("google-gateway"), "GOOGLE_GATEWAY_API_KEY");
  assert.equal(deriveApiKeyEnvFromSlug("anthropic-relay"), "ANTHROPIC_RELAY_API_KEY");
  assert.equal(deriveApiKeyEnvFromSlug("deepseek"), "DEEPSEEK_API_KEY");
  assert.throws(() => deriveApiKeyEnvFromSlug("bad/slug"), /Invalid provider slug/);
});

test("parseQualifiedModelTarget requires <provider>/<model_id> prefix and preserves nested model slashes", () => {
  assert.deepEqual(parseQualifiedModelTarget("custom-relay/claude-sonnet-4-5"), {
    providerSlug: "custom-relay",
    modelId: "claude-sonnet-4-5",
    target: "custom-relay/claude-sonnet-4-5",
  });
  assert.deepEqual(parseQualifiedModelTarget("custom-relay/anthropic/claude-sonnet-4-5"), {
    providerSlug: "custom-relay",
    modelId: "anthropic/claude-sonnet-4-5",
    target: "custom-relay/anthropic/claude-sonnet-4-5",
  });
  assert.throws(() => parseQualifiedModelTarget("claude-sonnet-4-5"), /provider prefix/i);
  assert.throws(() => parseQualifiedModelTarget("/claude-sonnet-4-5"), /provider prefix/i);
});

test("ModelRegistry loads TOML N:M providers, enforces provider prefix on selection, and resolves <SLUG>_API_KEY", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-models-nm-"));
  const modelsToml = join(tempDir, "models.toml");
  const handle = openDatabase(":memory:");
  const prevCustomKey = process.env.CUSTOM_RELAY_API_KEY;
  const prevRelayKey = process.env.ANTHROPIC_RELAY_API_KEY;
  try {
    writeFileSync(
      modelsToml,
      `
[slots]
persona = "google-gateway/gemini-4-hydrogen"
router = "google-gateway/gemini-4-hydrogen"
curator = "google-gateway/gemini-4-hydrogen"
worker = "openai-gateway/gpt-6.1-sol"
hindsight_llm = "google-gateway/gemini-4-hydrogen"

[providers.google-gateway]
api = "google-generative-ai"
base_url = "https://generativelanguage.googleapis.com/v1beta"
cache_ttl_minutes = 60

[[providers.google-gateway.models]]
id = "gemini-4-hydrogen"
name = "Gemini 4 Hydrogen"

[[providers.google-gateway.models]]
id = "gemini-4-flash"
name = "Gemini 4 Flash"

[providers.openai-gateway]
api = "openai-responses"
base_url = "https://api.openai.com/v1"

[[providers.openai-gateway.models]]
id = "gpt-6.1-sol"
name = "GPT 6.1 Sol"

[providers.anthropic-relay]
api = "anthropic-messages"
base_url = "https://api.anthropic.com"
cache_ttl_minutes = 5

[[providers.anthropic-relay.models]]
id = "claude-sonnet-4-5"
name = "Claude Sonnet 4.5"

[providers.custom-relay]
api = "anthropic-messages"
base_url = "https://relay.example.com/anthropic"
cache_ttl_minutes = 5

[[providers.custom-relay.models]]
id = "claude-sonnet-4-5"
name = "Claude Sonnet 4.5 (Relay)"

[[providers.custom-relay.models]]
id = "gpt-6.1-sol"
name = "GPT 6.1 Sol (Relay)"
api = "openai-responses"
base_url = "https://relay.example.com/openai"
`,
      "utf8",
    );

    process.env.CUSTOM_RELAY_API_KEY = "custom-secret-token";
    process.env.ANTHROPIC_RELAY_API_KEY = "relay-secret-token";

    const repo = new HatoRepository(handle.db);
    const registry = new ModelRegistry(modelsToml, repo);

    // 1 Provider -> Multiple Models
    const persona = registry.resolveSlot("persona");
    assert.equal(persona.model.api, "google-generative-ai");
    assert.equal(persona.model.id, "gemini-4-hydrogen");
    assert.equal(persona.apiKeyEnv, "GOOGLE_GATEWAY_API_KEY");
    assert.equal(persona.cacheTtlMinutes, 60);

    const flash = registry.resolveTarget("google-gateway/gemini-4-flash");
    assert.equal(flash.providerSlug, "google-gateway");
    assert.equal(flash.model.id, "gemini-4-flash");

    // 1 Model ID -> Multiple Providers, disambiguated by provider prefix
    const customClaude = registry.resolveTarget("custom-relay/claude-sonnet-4-5");
    const relayClaude = registry.resolveTarget("anthropic-relay/claude-sonnet-4-5");
    assert.equal(customClaude.providerSlug, "custom-relay");
    assert.equal(relayClaude.providerSlug, "anthropic-relay");
    assert.notEqual(customClaude.model.baseUrl, relayClaude.model.baseUrl);
    assert.equal(registry.resolveApiKeyForProvider("custom-relay"), "custom-secret-token");
    assert.equal(registry.resolveApiKeyForProvider("anthropic-relay"), "relay-secret-token");

    // Same provider also exposes mixed-API gpt-6.1-sol alongside openai-gateway/gpt-6.1-sol
    const customGpt = registry.resolveTarget("custom-relay/gpt-6.1-sol");
    assert.equal(customGpt.model.api, "openai-responses");
    assert.equal(customGpt.providerSlug, "custom-relay");

    // Selecting a model WITHOUT provider prefix must be rejected with prefixed candidates listed
    assert.throws(
      () => registry.setSlotOverride("worker", "claude-sonnet-4-5"),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return (
          msg.includes("provider prefix") &&
          msg.includes("anthropic-relay/claude-sonnet-4-5") &&
          msg.includes("custom-relay/claude-sonnet-4-5")
        );
      },
    );

    const updated = registry.setSlotOverride("worker", "custom-relay/claude-sonnet-4-5");
    assert.equal(updated.model.api, "anthropic-messages");
    assert.equal(updated.providerSlug, "custom-relay");
    assert.equal(updated.cacheTtlMinutes, 5);

    // Reloading in a fresh instance must preserve the SQLite runtime override.
    const reloaded = new ModelRegistry(modelsToml, repo);
    assert.equal(reloaded.resolveSlot("worker").target, "custom-relay/claude-sonnet-4-5");

    // Missing derived env var raises an informative error naming <SLUG>_API_KEY
    delete process.env.CUSTOM_RELAY_API_KEY;
    assert.throws(() => registry.resolveApiKeyForProvider("custom-relay"), /CUSTOM_RELAY_API_KEY/);
  } finally {
    if (prevCustomKey === undefined) delete process.env.CUSTOM_RELAY_API_KEY;
    else process.env.CUSTOM_RELAY_API_KEY = prevCustomKey;
    if (prevRelayKey === undefined) delete process.env.ANTHROPIC_RELAY_API_KEY;
    else process.env.ANTHROPIC_RELAY_API_KEY = prevRelayKey;
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ModelRegistry supports custom slug env derivation, optional api_key_env override, and rejects unprefixed TOML slots", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-models-test-"));
  const modelsToml = join(tempDir, "models.toml");
  const prevSharedKey = process.env.SHARED_CUSTOM_KEY;
  try {
    process.env.SHARED_CUSTOM_KEY = "override-key-value";

    writeFileSync(
      modelsToml,
      `
[slots]
persona = "cf-alias/anthropic/claude-sonnet-4-5"
router = "cf-alias/anthropic/claude-sonnet-4-5"
curator = "cf-alias/anthropic/claude-sonnet-4-5"
worker = "custom-override/gpt-6.1-sol"
hindsight_llm = "cf-alias/anthropic/claude-sonnet-4-5"

[providers.gateway_key]
name = "Cloudflare Custom"
slug = "cf-alias"
api = "anthropic-messages"
base_url = "https://gateway.example.com/anthropic"

[[providers.gateway_key.models]]
id = "anthropic/claude-sonnet-4-5"
name = "Claude via Slash ID"

[providers.custom-override]
api = "openai-responses"
base_url = "https://api.example.com/v1"
api_key_env = "SHARED_CUSTOM_KEY"

[[providers.custom-override.models]]
id = "gpt-6.1-sol"
name = "GPT 6.1 Sol"
`,
      "utf8",
    );

    const registry = new ModelRegistry(modelsToml);
    const persona = registry.resolveSlot("persona");
    assert.equal(persona.providerSlug, "cf-alias");
    assert.equal(persona.providerDisplayName, "Cloudflare Custom");
    assert.equal(persona.apiKeyEnv, "CF_ALIAS_API_KEY");
    assert.equal(persona.model.id, "anthropic/claude-sonnet-4-5");
    assert.equal(registry.resolveApiKeyForProvider("custom-override"), "override-key-value");

    // Unprefixed slot definition in TOML must fail validation
    writeFileSync(
      modelsToml,
      `
[slots]
persona = "gpt-6.1-sol"
router = "custom-override/gpt-6.1-sol"
curator = "custom-override/gpt-6.1-sol"
worker = "custom-override/gpt-6.1-sol"
hindsight_llm = "custom-override/gpt-6.1-sol"

[providers.custom-override]
api = "openai-responses"
base_url = "https://api.example.com/v1"

[[providers.custom-override.models]]
id = "gpt-6.1-sol"
name = "GPT 6.1 Sol"
`,
      "utf8",
    );
    assert.throws(() => new ModelRegistry(modelsToml), /provider prefix/);
  } finally {
    if (prevSharedKey === undefined) delete process.env.SHARED_CUSTOM_KEY;
    else process.env.SHARED_CUSTOM_KEY = prevSharedKey;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ModelRegistry allows multiple API formats and base_urls under a single provider", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-models-multi-api-"));
  const modelsToml = join(tempDir, "models.toml");
  try {
    writeFileSync(
      modelsToml,
      `
[slots]
persona = "relay/gemini-4-hydrogen"
router = "relay/deepseek-flash"
curator = "relay/deepseek-flash"
worker = "relay/deepseek-flash"
hindsight_llm = "relay/deepseek-flash"

[providers.relay]
api = "openai-completions"
base_url = "https://relay.example.com/v1"

[[providers.relay.models]]
id = "deepseek-flash"
name = "DeepSeek Flash"
reasoning = true

[[providers.relay.models]]
id = "gemini-4-hydrogen"
name = "Gemini 4 Hydrogen"
api = "google-generative-ai"
base_url = "https://relay.example.com/v1beta"
cache_ttl_minutes = 45
reasoning = true
input = ["text", "image"]
`,
      "utf8",
    );

    const registry = new ModelRegistry(modelsToml);
    const persona = registry.resolveSlot("persona");
    const router = registry.resolveSlot("router");

    assert.equal(persona.model.api, "google-generative-ai");
    assert.equal(persona.model.baseUrl, "https://relay.example.com/v1beta");
    assert.equal(persona.cacheTtlMinutes, 45);
    assert.equal(supportsCustomFetchOption(persona.model.api), false);

    assert.equal(router.model.api, "openai-completions");
    assert.equal(router.model.baseUrl, "https://relay.example.com/v1");
    assert.equal(supportsCustomFetchOption(router.model.api), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ModelRegistry supports [slot_thinking], slot defaults/clamping, and persisted runtime thinking overrides", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-models-thinking-"));
  const modelsToml = join(tempDir, "models.toml");
  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    writeFileSync(
      modelsToml,
      `
[slots]
persona = "relay/reasoning-model"
router = "relay/reasoning-model"
curator = "relay/reasoning-model"
worker = "relay/reasoning-model"
hindsight_llm = "relay/plain-model"

[slot_thinking]
persona = "high"
worker = "medium"
hindsight_llm = "high"

[providers.relay]
api = "openai-completions"
base_url = "https://relay.example.com/v1"

[[providers.relay.models]]
id = "reasoning-model"
name = "Reasoning Model"
reasoning = true

[[providers.relay.models]]
id = "plain-model"
name = "Plain Model"
reasoning = false
`,
      "utf8",
    );

    const registry = new ModelRegistry(modelsToml, repo);
    assert.equal(registry.resolveSlotThinkingLevel("persona"), "high");
    assert.equal(registry.resolveSlotThinkingLevel("worker"), "medium");
    assert.equal(registry.resolveSlotThinkingLevel("router"), "minimal");
    assert.equal(registry.resolveSlotThinkingLevel("curator"), "minimal");
    assert.equal(registry.resolveSlotThinkingLevel("hindsight_llm"), "off");

    const updated = registry.setSlotThinkingOverride("persona", "low");
    assert.deepEqual(updated, {
      slot: "persona",
      requested: "low",
      effective: "low",
      reasoningSupported: true,
    });
    assert.equal(registry.resolveSlotThinkingLevel("persona"), "low");
    assert.equal(registry.getEffectiveSlotThinkingMap().persona, "low");

    // Overrides persist across ModelRegistry reload/re-instantiation via runtime_settings
    const reloadedRegistry = new ModelRegistry(modelsToml, repo);
    assert.equal(reloadedRegistry.resolveSlotThinkingLevel("persona"), "low");

    reloadedRegistry.clearSlotThinkingOverrides();
    assert.equal(reloadedRegistry.resolveSlotThinkingLevel("persona"), "high");

    assert.throws(() => reloadedRegistry.setSlotThinkingOverride("unknown_slot", "high"), /Unknown slot/);
    assert.throws(() => reloadedRegistry.setSlotThinkingOverride("persona", "invalid_level"), /Invalid thinking level/);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
