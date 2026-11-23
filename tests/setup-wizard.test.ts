import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHatoConfig } from "../src/config/app.js";
import { ModelRegistry, type ModelsFileConfig } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { writeHatoConfig, writeModelsConfig } from "../src/config/store.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import {
  buildQuickProxyRules,
  buildQuickSlots,
  formatSetupHelp,
  parseWizardCommand,
} from "../src/setup/wizard.js";

test("parseWizardCommand maps quick, full, legacy init, subcommands, and help flags", () => {
  assert.equal(parseWizardCommand([]), "menu");
  assert.equal(parseWizardCommand(["quick"]), "quick");
  assert.equal(parseWizardCommand(["--quick"]), "quick");
  assert.equal(parseWizardCommand(["init", "--quick"]), "quick");
  assert.equal(parseWizardCommand(["init", "quick"]), "quick");
  assert.equal(parseWizardCommand(["full"]), "full");
  assert.equal(parseWizardCommand(["--full"]), "full");
  assert.equal(parseWizardCommand(["init", "--full"]), "full");
  assert.equal(parseWizardCommand(["init", "full"]), "full");
  assert.equal(parseWizardCommand(["init"]), "init");
  assert.equal(parseWizardCommand(["provider"]), "provider-add");
  assert.equal(parseWizardCommand(["provider", "add"]), "provider-add");
  assert.equal(parseWizardCommand(["slots"]), "slots");
  assert.equal(parseWizardCommand(["proxy"]), "proxy");
  assert.equal(parseWizardCommand(["check"]), "check");
  assert.equal(parseWizardCommand(["-h"]), "help");
  assert.equal(parseWizardCommand(["--help"]), "help");
  assert.equal(parseWizardCommand(["help"]), "help");
});

test("buildQuickSlots binds all 5 required slots and falls back vision to persona cleanly", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-wizard-slots-"));
  const modelsPath = join(tempDir, "models.toml");

  try {
    const modelsCfg: ModelsFileConfig = {
      slots: buildQuickSlots("openai/gpt-5"),
      providers: {
        openai: {
          api: "openai-responses",
          base_url: "https://api.openai.com/v1",
          models: [
            {
              id: "gpt-5",
              name: "gpt-5",
              reasoning: true,
              input: ["text", "image"],
              context_window: 128000,
              max_tokens: 8192,
            },
          ],
        },
      },
    };
    writeModelsConfig(modelsPath, modelsCfg, { backup: false });

    const registry = new ModelRegistry(modelsPath);
    assert.equal(registry.resolveSlot("persona").target, "openai/gpt-5");
    assert.equal(registry.resolveSlot("router").target, "openai/gpt-5");
    assert.equal(registry.resolveSlot("curator").target, "openai/gpt-5");
    assert.equal(registry.resolveSlot("worker").target, "openai/gpt-5");
    assert.equal(registry.resolveSlot("hindsight_llm").target, "openai/gpt-5");
    assert.equal(registry.resolveSlot("vision").target, "openai/gpt-5");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildQuickProxyRules produces valid HatoConfig network rules and ScopedProxyRouter resolutions", () => {
  assert.deepEqual(buildQuickProxyRules(""), []);
  assert.deepEqual(buildQuickProxyRules("direct"), []);
  assert.deepEqual(buildQuickProxyRules("DIRECT"), []);

  const rules = buildQuickProxyRules("http://127.0.0.1:7890");
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.url, "http://127.0.0.1:7890");

  const tempDir = mkdtempSync(join(tmpdir(), "hato-wizard-proxy-"));
  const hatoPath = join(tempDir, "hato.toml");
  try {
    const cfg = createDefaultHatoConfig();
    cfg.network = { proxies: rules };
    writeHatoConfig(hatoPath, cfg, { backup: false });
    const loaded = loadHatoConfig(hatoPath);
    const router = new ScopedProxyRouter(loaded.network?.proxies ?? []);

    assert.equal(router.resolveScope("gateway.telegram").url, "http://127.0.0.1:7890");
    assert.equal(router.resolveScope("llm-calling.openai").url, "http://127.0.0.1:7890");
    assert.equal(router.resolveScope("web_access").url, "http://127.0.0.1:7890");
    assert.equal(router.resolveScope("memory").url, "http://127.0.0.1:7890");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("formatSetupHelp documents quick and full modes", () => {
  const help = formatSetupHelp();
  assert.ok(help.includes("quick"));
  assert.ok(help.includes("full"));
  assert.ok(help.includes("slots"));
});
