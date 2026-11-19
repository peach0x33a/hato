import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveWorkerExecutionMode, resolveWorkerVmWorkdir } from "../src/config/app.js";
import { ensureHatoHomeConfig, resolveHatoHomeDir } from "../src/config/paths.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { loadZoneSkills, selectWorkerSkills } from "../src/skills/loader.js";
import { createPersonaReadOnlyTools } from "../src/persona/tools.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
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

test("ensureHatoHomeConfig ensures HATO_HOME directory exists and resolves config paths", () => {
  const prevHome = process.env.HATO_HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "hato-home-"));
  const nestedHome = join(tempHome, "nested");

  process.env.HATO_HOME = nestedHome;
  try {
    assert.equal(resolveHatoHomeDir(), resolve(nestedHome));
    const paths = ensureHatoHomeConfig();
    assert.equal(existsSync(paths.homeDir), true);
    assert.equal(paths.hatoConfigPath, join(resolve(nestedHome), "hato.toml"));
    assert.equal(paths.modelsConfigPath, join(resolve(nestedHome), "models.toml"));
    assert.equal(paths.mcpConfigPath, join(resolve(nestedHome), "mcp.toml"));
    assert.equal(paths.envPath, join(resolve(nestedHome), ".env"));
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
  const tempSkills = mkdtempSync(join(tmpdir(), "hato-skills-zone-"));
  try {
    mkdirSync(join(tempSkills, "personal", "hato-self-ops"), { recursive: true });
    mkdirSync(join(tempSkills, "worker", "hato-vm-ops"), { recursive: true });
    writeFileSync(
      join(tempSkills, "personal", "hato-self-ops", "SKILL.md"),
      "---\nname: hato-self-ops\ndescription: self ops\n---\nbody\n",
      "utf8",
    );
    writeFileSync(
      join(tempSkills, "worker", "hato-vm-ops", "SKILL.md"),
      "---\nname: hato-vm-ops\ndescription: vm ops\n---\nbody\n",
      "utf8",
    );

    const personal = loadZoneSkills(tempSkills, "personal");
    assert.ok(personal.some((s) => s.name === "hato-self-ops"));

    const worker = selectWorkerSkills(tempSkills, ["hato-vm-ops"]);
    assert.ok(worker.some((s) => s.name === "hato-vm-ops"));
  } finally {
    rmSync(tempSkills, { recursive: true, force: true });
  }
});

test("send_message and send_file support explicit cross-platform channel routing", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-cross-send-"));
  const sampleFile = join(tempDir, "sticker.png");
  writeFileSync(sampleFile, "png-bytes", "utf8");

  const calls: Array<{ tool: string; channel?: string; text?: string; path?: string }> = [];
  try {
    const tools = createPersonaReadOnlyTools({
      repo: {} as any,
      canonicalUserId: "owner",
      getTimezone: () => "Asia/Shanghai",
      getHatoConfig: () => createDefaultHatoConfig(),
      proxyRouter: new ScopedProxyRouter([]),
      onSendFile: async (input) => {
        calls.push({ tool: "send_file", channel: input.channel, path: input.path });
        return { ok: true, message: `sent to ${input.channel}` };
      },
      onSendMessage: async (input) => {
        calls.push({
          tool: "send_message",
          channel: input.channel,
          text: input.text,
          path: input.filePath,
        });
        return { ok: true, message: `delivered to ${input.channel}` };
      },
    });

    const sendFileTool = tools.find((t) => t.name === "send_file");
    const sendMsgTool = tools.find((t) => t.name === "send_message");
    assert.ok(sendFileTool);
    assert.ok(sendMsgTool);

    await sendFileTool.execute("c1", { path: sampleFile, channel: "qq" });
    await sendMsgTool.execute("c2", {
      channel: "qq",
      text: "贴纸发你啦",
      file_path: sampleFile,
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { tool: "send_file", channel: "qq", path: sampleFile });
    assert.deepEqual(calls[1], {
      tool: "send_message",
      channel: "qq",
      text: "贴纸发你啦",
      path: sampleFile,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
