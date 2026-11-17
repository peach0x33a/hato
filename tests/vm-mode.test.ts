import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveWorkerExecutionMode, resolveWorkerVmWorkdir } from "../src/config/app.js";
import { ensureHatoHomeConfig, resolveHatoHomeDir } from "../src/config/paths.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { loadZoneSkills, selectWorkerSkills } from "../src/skills/loader.js";
import { isProtectedEnvPath } from "../src/worker/builtin-pi.js";

test("resolveWorkerExecutionMode and resolveWorkerVmWorkdir handle isolated and vm_unrestricted modes", () => {
  const cfg = createDefaultHatoConfig();
  assert.equal(resolveWorkerExecutionMode(cfg), "isolated");
  assert.equal(resolveWorkerVmWorkdir(cfg), homedir());

  cfg.worker.execution_mode = "vm_unrestricted";
  cfg.worker.vm_workdir = "~/hato-vm-work";
  assert.equal(resolveWorkerExecutionMode(cfg), "vm_unrestricted");
  assert.equal(resolveWorkerVmWorkdir(cfg), resolve(homedir(), "hato-vm-work"));
});

test("ensureHatoHomeConfig migrates legacy files into HATO_HOME once without overwriting", () => {
  const prevHome = process.env.HATO_HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "hato-home-"));
  process.env.HATO_HOME = tempHome;
  try {
    assert.equal(resolveHatoHomeDir(), resolve(tempHome));
    const paths = ensureHatoHomeConfig();
    assert.equal(paths.hatoConfigPath, join(resolve(tempHome), "hato.toml"));
    assert.equal(paths.modelsConfigPath, join(resolve(tempHome), "models.toml"));
    assert.equal(paths.mcpConfigPath, join(resolve(tempHome), "mcp.toml"));
    assert.equal(paths.envPath, join(resolve(tempHome), ".env"));
    assert.equal(existsSync(paths.hatoConfigPath), true);

    writeFileSync(paths.hatoConfigPath, "# custom sentinel\n", "utf8");
    ensureHatoHomeConfig();
    assert.equal(readFileSync(paths.hatoConfigPath, "utf8"), "# custom sentinel\n");
  } finally {
    if (prevHome === undefined) delete process.env.HATO_HOME;
    else process.env.HATO_HOME = prevHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("isProtectedEnvPath blocks Hato .env files in cwd and HATO_HOME while allowing normal files", () => {
  const prevHome = process.env.HATO_HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "hato-env-guard-"));
  const tempProject = mkdtempSync(join(tmpdir(), "hato-user-proj-"));
  process.env.HATO_HOME = tempHome;
  try {
    mkdirSync(tempHome, { recursive: true });
    writeFileSync(join(tempHome, ".env"), "SECRET=1\n", "utf8");

    assert.equal(isProtectedEnvPath(join(tempHome, ".env")), true);
    assert.equal(isProtectedEnvPath(join(tempHome, ".env.local")), true);
    assert.equal(isProtectedEnvPath(join(process.cwd(), ".env")), true);

    assert.equal(isProtectedEnvPath(join(tempHome, "hato.toml")), false);
    assert.equal(isProtectedEnvPath(join(tempProject, ".env")), false);
  } finally {
    if (prevHome === undefined) delete process.env.HATO_HOME;
    else process.env.HATO_HOME = prevHome;
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempProject, { recursive: true, force: true });
  }
});

test("hato-self-ops and hato-vm-ops skills are discoverable in personal and worker zones", () => {
  const personal = loadZoneSkills("data/skills", "personal");
  assert.ok(personal.some((s) => s.name === "hato-self-ops"));

  const worker = selectWorkerSkills("data/skills", ["hato-vm-ops"]);
  assert.ok(worker.some((s) => s.name === "hato-vm-ops"));
});
