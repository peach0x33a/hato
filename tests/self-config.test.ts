import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { loadHatoConfig } from "../src/config/app.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { PersonaRuntime } from "../src/persona/agent.js";
import { loadLayeredPrompts } from "../src/persona/prompts.js";
import { runSelfConfigAction } from "../src/persona/self-config.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("loadLayeredPrompts assembles blocks, system.md, and soul.md in default and custom order", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-prompts-"));
  try {
    mkdirSync(join(tempDir, "blocks"), { recursive: true });
    writeFileSync(join(tempDir, "blocks", "01-user.md"), "USER_BLOCK_1", "utf8");
    writeFileSync(join(tempDir, "blocks", "02-style.md"), "USER_BLOCK_2", "utf8");
    writeFileSync(join(tempDir, "system.md"), "SYSTEM_RULES", "utf8");
    writeFileSync(join(tempDir, "soul.md"), "SOUL_PERSONA", "utf8");

    const def = loadLayeredPrompts(tempDir);
    assert.equal(def.mode, "layered");
    assert.equal(
      def.combinedText,
      ["USER_BLOCK_1", "USER_BLOCK_2", "SYSTEM_RULES", "SOUL_PERSONA"].join("\n\n"),
    );

    const custom = loadLayeredPrompts(tempDir, ["soul", "block:02-style.md", "system", "blocks"]);
    assert.equal(
      custom.combinedText,
      ["SOUL_PERSONA", "USER_BLOCK_2", "SYSTEM_RULES", "USER_BLOCK_1"].join("\n\n"),
    );

    const disabledOne = loadLayeredPrompts(
      tempDir,
      ["soul", "block:02-style.md", "system", "blocks"],
      ["block:02-style.md", "system"],
    );
    assert.equal(disabledOne.combinedText, ["SOUL_PERSONA", "USER_BLOCK_1"].join("\n\n"));

    const disabledWildcard = loadLayeredPrompts(tempDir, ["blocks", "system", "soul"], ["blocks", "soul"]);
    assert.equal(disabledWildcard.combinedText, "SYSTEM_RULES");

    // Legacy directory with only persona.md still works seamlessly
    const legacyDir = mkdtempSync(join(tmpdir(), "hato-legacy-prompts-"));
    try {
      writeFileSync(join(legacyDir, "persona.md"), "LEGACY_PERSONA", "utf8");
      const leg = loadLayeredPrompts(legacyDir);
      assert.equal(leg.mode, "legacy");
      assert.equal(leg.combinedText, "LEGACY_PERSONA");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("self_config tool safely edits hato.toml, prompt layers, model slots, and relationship facts while blocking protected paths", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    ],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-selfcfg-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");
  const promptsDir = join(tempDir, "prompts");
  mkdirSync(join(promptsDir, "blocks"), { recursive: true });

  writeFileSync(join(promptsDir, "blocks", "01-user.md"), "USER_RULE_TOP", "utf8");
  writeFileSync(join(promptsDir, "system.md"), "SYSTEM_IMMUTABLE", "utf8");
  writeFileSync(join(promptsDir, "soul.md"), "# Soul\n原始人设", "utf8");

  const cfg = createDefaultHatoConfig();
  cfg.paths.prompts_dir = promptsDir;
  cfg.prompts = { order: ["blocks", "system", "soul"] };
  writeHatoConfig(hatoTomlPath, cfg, { backup: false });

  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/model-a"
router = "faux-provider/model-a"
curator = "faux-provider/model-a"
worker = "faux-provider/model-a"
hindsight_llm = "faux-provider/model-a"

[providers]
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  try {
    let activeConfig = loadHatoConfig(hatoTomlPath);
    const repo = new HatoRepository(dbHandle.db);
    const registry = new ModelRegistry(modelsTomlPath, repo, { extraProviders: [faux.provider] });
    const proxyRouter = new ScopedProxyRouter([]);
    const runtime = new PersonaRuntime(
      activeConfig,
      registry,
      proxyRouter,
      repo,
      undefined,
      null,
      hatoTomlPath,
    );

    let reloadCount = 0;
    const reloadHandler = async () => {
      reloadCount++;
      activeConfig = loadHatoConfig(hatoTomlPath);
      runtime.updateConfig(activeConfig);
    };
    runtime.setReloadHandler(reloadHandler);

    const deps = {
      hatoConfigPath: hatoTomlPath,
      getHatoConfig: () => activeConfig,
      getModelRegistry: () => registry,
      repo,
      onReloadRuntime: reloadHandler,
    };

    // 1. Inspect sanitized config & prompt layers
    const inspectRes = await runSelfConfigAction(deps, { action: "inspect" });
    assert.equal(inspectRes.ok, true);
    assert.ok(!inspectRes.summary.includes("TG_BOT_TOKEN"));
    assert.ok(inspectRes.summary.includes("USER_RULE_TOP"));
    assert.ok(inspectRes.summary.includes("原始人设"));
    assert.ok(inspectRes.summary.includes('"system_chars": 16'));

    // 2. Patch allowed fields (debounce_ms + prompts.order)
    const patchRes = await runSelfConfigAction(deps, {
      action: "patch_hato",
      config_patch: {
        gateway: { debounce_ms: 4500 },
        prompts: { order: ["soul", "system", "blocks"] },
      },
    });
    assert.equal(patchRes.ok, true);
    assert.equal(activeConfig.gateway.debounce_ms, 4500);
    assert.deepEqual(activeConfig.prompts?.order, ["soul", "system", "blocks"]);
    assert.equal(existsSync(`${hatoTomlPath}.bak`), true);
    assert.equal(
      runtime.getBasePersonaPrompt(),
      ["# Soul\n原始人设", "SYSTEM_IMMUTABLE", "USER_RULE_TOP"].join("\n\n"),
    );

    // 3. Reject protected paths
    for (const forbidden of [
      { paths: { sqlite: "/tmp/evil.db" } },
      { owner: { channels: { tg: { user_ids: [999] } } } },
      { web: { search: { api_key_env: "OTHER_ENV" } } },
      { worker: { external_cli: { allowed_repos: ["/"] } } },
      { gateway: { telegram: { base_url: "https://evil.example.com" } } },
    ]) {
      const denied = await runSelfConfigAction(deps, {
        action: "patch_hato",
        config_patch: forbidden,
      });
      assert.equal(denied.ok, false);
      assert.match(denied.summary, /拒绝修改受保护配置路径/);
    }

    // 4. Upsert & delete prompt block + path traversal guard
    const upRes = await runSelfConfigAction(deps, {
      action: "upsert_prompt_block",
      block_name: "02-tone.md",
      content: "CUSTOM_TONE_BLOCK",
    });
    assert.equal(upRes.ok, true);
    assert.ok(runtime.getBasePersonaPrompt().includes("CUSTOM_TONE_BLOCK"));

    await assert.rejects(
      () =>
        runSelfConfigAction(deps, {
          action: "upsert_prompt_block",
          block_name: "../.env",
          content: "EVIL",
        }),
      /非法提示词块名称/,
    );

    const delRes = await runSelfConfigAction(deps, {
      action: "delete_prompt_block",
      block_name: "02-tone",
    });
    assert.equal(delRes.ok, true);
    assert.equal(runtime.getBasePersonaPrompt().includes("CUSTOM_TONE_BLOCK"), false);

    // 5. Switch model slot + relationship facts + end-to-end tool execution via PersonaRuntime
    const slotRes = await runSelfConfigAction(deps, {
      action: "set_model_slot",
      slot: "curator",
      target: "faux-provider/model-b",
    });
    assert.equal(slotRes.ok, true);
    assert.equal(registry.resolveSlot("curator").target, "faux-provider/model-b");

    const factRes = await runSelfConfigAction(deps, {
      action: "set_relationship_fact",
      fact_key: "昵称",
      fact_value: "阿鸠",
    });
    assert.equal(factRes.ok, true);
    assert.deepEqual(repo.listRelationshipFacts(), [{ key: "昵称", value: "阿鸠" }]);

    // 6. Persona invokes self_config tool mid-turn to append a rule to soul.md
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall("self_config", {
              action: "edit_soul",
              append_note: "以后少用波浪号",
            }),
          ],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("好呀，记在 soul.md 里了"),
    ]);

    const turnOut = await runtime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123",
      platformMsgIds: ["m1"],
      latestPlatformMsgId: "m1",
      combinedText: "以后少用波浪号，写进你的设定里",
      attachments: [],
      firstTimestampMs: Date.now(),
      lastTimestampMs: Date.now(),
    });

    assert.deepEqual(turnOut.toolCalls, ["self_config"]);
    assert.deepEqual(turnOut.bubbles, ["好呀，记在 soul.md 里了"]);
    assert.match(readFileSync(join(promptsDir, "soul.md"), "utf8"), /以后少用波浪号/);
    assert.match(runtime.getBasePersonaPrompt(), /以后少用波浪号/);
    assert.ok(reloadCount >= 5);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
