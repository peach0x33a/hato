import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHatoConfig } from "../src/config/app.js";
import { writeHatoConfig } from "../src/config/store.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("loadHatoConfig parses and validates TOML config and rejects malformed configs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-app-cfg-"));
  const hatoToml = join(tempDir, "hato.toml");
  try {
    const defaults = createDefaultHatoConfig();
    defaults.owner.timezone = "Asia/Shanghai";
    writeHatoConfig(hatoToml, defaults, { backup: false });

    const cfg = loadHatoConfig(hatoToml);
    assert.equal(cfg.owner.canonical_user_id, "owner");
    assert.equal(cfg.owner.timezone, "Asia/Shanghai");
    assert.equal(cfg.gateway.telegram.base_url, "https://api.telegram.org");
    assert.equal(cfg.gateway.bubbles.max_per_turn, 3);
    assert.equal(cfg.context.idle_commit_after_minutes, 60);
    assert.equal(cfg.context.pre_compact_after_minutes, 50);
    assert.equal(cfg.worker.default_backend, "builtin-pi");

    writeFileSync(hatoToml, "[owner]\ncanonical_user_id = ''\n", "utf8");
    assert.throws(() => loadHatoConfig(hatoToml), /Invalid Hato config/);

    // Reject bare "opencode" while accepting "opencode-v2"
    const baseToml = readFileSync(hatoToml, "utf8");
    const validRaw = baseToml.replace(
      'canonical_user_id = ""',
      'canonical_user_id = "owner"',
    );
    writeHatoConfig(hatoToml, defaults, { backup: false });
    const defaultsToml = readFileSync(hatoToml, "utf8");
    assert.ok(validRaw.length > 0);

    writeFileSync(
      hatoToml,
      defaultsToml.replace('default_backend = "builtin-pi"', 'default_backend = "opencode"'),
      "utf8",
    );
    assert.throws(() => loadHatoConfig(hatoToml), /bare "opencode" is unsupported.*opencode-v2/);

    writeFileSync(
      hatoToml,
      defaultsToml.replace('default_backend = "builtin-pi"', 'default_backend = "opencode-v2"') +
        `\n[worker.external_cli.opencode]\nenabled = true\n`,
      "utf8",
    );
    assert.throws(
      () => loadHatoConfig(hatoToml),
      /bare \[worker\.external_cli\.opencode\] is unsupported.*opencode_v2/,
    );

    const validV2 = structuredClone(defaults) as unknown as Record<string, any>;
    validV2.worker.default_backend = "opencode-v2";
    validV2.worker.external_cli.permission_preset = "yolo";
    validV2.worker.external_cli.opencode_v2 = { enabled: true, auto: true };
    writeHatoConfig(hatoToml, validV2 as any, { backup: false });
    const loadedV2 = loadHatoConfig(hatoToml);
    assert.equal(loadedV2.worker.default_backend, "opencode-v2");
    assert.equal(loadedV2.worker.external_cli.permission_preset, "yolo");
    assert.equal(loadedV2.worker.external_cli.opencode_v2?.auto, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
