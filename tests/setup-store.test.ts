import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { loadHatoConfig } from "../src/config/app.js";
import { ModelRegistry, type ModelsFileConfig } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { bindTelegramHomeChannel, mergeEnvFile, readEnvMap, writeHatoConfig, writeModelsConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { probeModelSlot, probeTelegramGateway } from "../src/setup/probe.js";
import {
  buildTimezoneMenu,
  formatUtcOffsetLabel,
  listAllTimezoneOptions,
  MORE_TIMEZONES_VALUE,
} from "../src/setup/timezone.js";

test("mergeEnvFile preserves existing secrets and comments while merging updates", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-env-test-"));
  const envPath = join(tempDir, ".env");
  try {
    writeFileSync(
      envPath,
      "# Personal secrets\nTG_BOT_TOKEN=old-tg\nEXISTING_OTHER=keep-me\n",
      "utf8",
    );

    mergeEnvFile(envPath, {
      TG_BOT_TOKEN: undefined, // keep existing when skipped
      CUSTOM_RELAY_API_KEY: "relay-secret-123",
      QUOTED_KEY: "hello world # comment",
    });

    const parsed = readEnvMap(envPath);
    assert.equal(parsed.TG_BOT_TOKEN, "old-tg");
    assert.equal(parsed.EXISTING_OTHER, "keep-me");
    assert.equal(parsed.CUSTOM_RELAY_API_KEY, "relay-secret-123");
    assert.equal(parsed.QUOTED_KEY, "hello world # comment");
    const raw = readFileSync(envPath, "utf8");
    assert.ok(raw.includes("# Personal secrets"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeHatoConfig and writeModelsConfig validate, backup existing TOML to .bak, and round-trip cleanly", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-toml-store-"));
  const hatoPath = join(tempDir, "hato.toml");
  const modelsPath = join(tempDir, "models.toml");
  try {
    const hatoCfg = createDefaultHatoConfig();
    hatoCfg.owner.timezone = "Asia/Shanghai";
    writeHatoConfig(hatoPath, hatoCfg);
    assert.equal(existsSync(`${hatoPath}.bak`), false);

    hatoCfg.owner.timezone = "Asia/Tokyo";
    const secondWrite = writeHatoConfig(hatoPath, hatoCfg);
    assert.equal(secondWrite.backupPath, `${hatoPath}.bak`);
    assert.equal(existsSync(`${hatoPath}.bak`), true);
    assert.equal(loadHatoConfig(hatoPath).owner.timezone, "Asia/Tokyo");
    assert.equal(loadHatoConfig(`${hatoPath}.bak`).owner.timezone, "Asia/Shanghai");

    const modelsCfg: ModelsFileConfig = {
      slots: {
        persona: "custom-relay/claude-sonnet-4-5",
        router: "custom-relay/claude-sonnet-4-5",
        curator: "custom-relay/claude-sonnet-4-5",
        worker: "custom-relay/gpt-6.1-sol",
        hindsight_llm: "custom-relay/claude-sonnet-4-5",
      },
      providers: {
        "custom-relay": {
          api: "anthropic-messages",
          base_url: "https://relay.example.com/anthropic",
          models: [
            { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
            {
              id: "gpt-6.1-sol",
              name: "GPT 6.1 Sol",
              api: "openai-responses",
              base_url: "https://relay.example.com/openai",
            },
          ],
        },
      },
    };

    writeModelsConfig(modelsPath, modelsCfg);
    const registry = new ModelRegistry(modelsPath);
    assert.equal(registry.resolveSlot("persona").apiKeyEnv, "CUSTOM_RELAY_API_KEY");
    assert.equal(registry.resolveSlot("worker").model.api, "openai-responses");

    // Writing an invalid models config must fail BEFORE overwriting existing file
    assert.throws(() =>
      writeModelsConfig(modelsPath, {
        ...modelsCfg,
        slots: { ...modelsCfg.slots, persona: "claude-sonnet-4-5" },
      }),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bindTelegramHomeChannel updates whitelist, proactive_channel, .bak backup, and SQLite home_channel", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-home-bind-"));
  const hatoPath = join(tempDir, "hato.toml");
  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    const initial = createDefaultHatoConfig();
    initial.owner.proactive_channel = "last_active";
    writeHatoConfig(hatoPath, initial);

    const bound = bindTelegramHomeChannel({
      hatoConfigPath: hatoPath,
      repo,
      canonicalUserId: "owner",
      tgUserId: "987654321",
      currentConfig: initial,
    });

    assert.equal(bound.addedToWhitelist, true);
    assert.equal(bound.savedToConfig, true);
    assert.equal(bound.updatedConfig.owner.proactive_channel, "tg");
    assert.deepEqual(bound.updatedConfig.owner.channels.tg.user_ids, [987654321]);
    assert.equal(existsSync(`${hatoPath}.bak`), true);

    const reloaded = loadHatoConfig(hatoPath);
    assert.equal(reloaded.owner.proactive_channel, "tg");
    assert.deepEqual(reloaded.owner.channels.tg.user_ids, [987654321]);

    const storedHome = repo.getHomeChannel();
    assert.equal(storedHome?.channel, "tg");
    assert.equal(storedHome?.targetId, "987654321");

    // Calling again for same user must not duplicate user_ids
    const rebound = bindTelegramHomeChannel({
      hatoConfigPath: hatoPath,
      repo,
      canonicalUserId: "owner",
      tgUserId: "987654321",
      currentConfig: bound.updatedConfig,
    });
    assert.equal(rebound.addedToWhitelist, false);
    assert.deepEqual(rebound.updatedConfig.owner.channels.tg.user_ids, [987654321]);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("probeTelegramGateway and probeModelSlot validate connectivity cleanly through ScopedProxyRouter", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/botvalid-token/getMe") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { id: 42, username: "hato_test_bot", first_name: "Hato" } }));
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, description: "Unauthorized" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const tempDir = mkdtempSync(join(tmpdir(), "hato-probe-test-"));
  const modelsToml = join(tempDir, "models.toml");
  try {
    const proxyRouter = new ScopedProxyRouter([]);

    const okTg = await probeTelegramGateway({ baseUrl, botToken: "valid-token", proxyRouter });
    assert.equal(okTg.ok, true);
    assert.equal(okTg.username, "hato_test_bot");

    const badTg = await probeTelegramGateway({ baseUrl, botToken: "wrong", proxyRouter });
    assert.equal(badTg.ok, false);
    assert.ok(badTg.error?.includes("Unauthorized"));

    const faux = fauxProvider({
      api: "hato-faux-api",
      provider: "faux-probe",
      models: [{ id: "probe-1", name: "Probe 1" }],
      tokensPerSecond: 10000,
    });
    faux.setResponses([() => fauxAssistantMessage("OK")]);

    writeFileSync(
      modelsToml,
      `
[slots]
persona = "faux-probe/probe-1"
router = "faux-probe/probe-1"
curator = "faux-probe/probe-1"
worker = "faux-probe/probe-1"
hindsight_llm = "faux-probe/probe-1"

[providers]
`,
      "utf8",
    );

    const modelRegistry = new ModelRegistry(modelsToml, undefined, { extraProviders: [faux.provider] });
    const okModel = await probeModelSlot({ modelRegistry, proxyRouter });
    assert.equal(okModel.ok, true);
    assert.equal(okModel.replyPreview, "OK");
    assert.equal(okModel.target, "faux-probe/probe-1");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("buildTimezoneMenu defaults to system timezone and includes searchable IANA list under 更多", () => {
  const menu = buildTimezoneMenu({
    systemTimezone: "Asia/Singapore",
    currentConfiguredTimezone: "Asia/Shanghai",
  });
  assert.equal(menu.initialValue, "Asia/Singapore");
  assert.equal(menu.options[0]?.value, "Asia/Singapore");
  assert.equal(menu.options[0]?.label, "系统时区 (Asia/Singapore)");
  assert.equal(menu.options[0]?.hint, "UTC+8");
  // Curated options should not duplicate Asia/Singapore
  assert.equal(menu.options.filter((o) => o.value === "Asia/Singapore").length, 1);
  assert.equal(menu.options[menu.options.length - 1]?.value, MORE_TIMEZONES_VALUE);
  assert.equal(menu.options[menu.options.length - 1]?.label, "更多...");

  const all = listAllTimezoneOptions();
  assert.ok(all.some((o) => o.value === "Asia/Singapore" && o.hint === "UTC+8"));
  assert.ok(all.some((o) => o.value === "Europe/Berlin"));
  assert.ok(all.some((o) => o.value === "UTC" && o.hint === "UTC+0"));
  assert.equal(formatUtcOffsetLabel("Asia/Tokyo"), "UTC+9");
});
