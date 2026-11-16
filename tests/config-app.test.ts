import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
