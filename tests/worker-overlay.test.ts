import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import type { McpConfig } from "../src/config/mcp.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import type { SkillEntry } from "../src/skills/loader.js";
import { prepareExternalCliOverlay } from "../src/worker/overlay.js";

test("prepareExternalCliOverlay inherits host relay/auth while isolating personal MCP, secrets, and host repo git tree", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-overlay-"));
  const fakeHome = join(tempDir, "home");
  const runtimeRoot = join(tempDir, "worker-cli");
  const ticketWorkspace = join(tempDir, "ws-isolated");
  const hostRepoDir = join(tempDir, "host-repo");
  const skillSrcDir = join(tempDir, "worker-skills", "db-migrate");

  try {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });
    mkdirSync(ticketWorkspace, { recursive: true });
    mkdirSync(hostRepoDir, { recursive: true });
    mkdirSync(skillSrcDir, { recursive: true });

    writeFileSync(join(skillSrcDir, "SKILL.md"), "---\nname: db-migrate\ndescription: Safe migrations\n---\nRun dry-run first.", "utf8");
    const workerSkill: SkillEntry = {
      name: "db-migrate",
      dirName: "db-migrate",
      zone: "worker",
      description: "Safe migrations",
      dirPath: skillSrcDir,
      skillFilePath: join(skillSrcDir, "SKILL.md"),
      hasReferences: false,
    };

    const origCodexToml = `
model = "gpt-5.4"
model_provider = "my_relay"

[model_providers.my_relay]
name = "MyRelay"
base_url = "https://relay.example.com/v1"

[mcp_servers.personal_calendar]
command = "npx"
args = ["-y", "personal-cal"]

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`;
    writeFileSync(join(fakeHome, ".codex", "config.toml"), origCodexToml, "utf8");
    writeFileSync(join(fakeHome, ".codex", "auth.json"), '{"token":"host-oauth"}\n', "utf8");

    writeFileSync(
      join(fakeHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        model: "my_relay/sonnet",
        mcp: {
          personal_notes: { type: "local", command: ["node", "notes.js"] },
        },
      }),
      "utf8",
    );

    process.env.TEST_WORKER_MCP_KEY = "worker-mcp-secret-xyz";
    const hatoConfig = createDefaultHatoConfig();
    hatoConfig.worker.external_cli.permission_preset = "yolo";
    hatoConfig.worker.external_cli.reuse_host_auth_and_provider = true;
    hatoConfig.worker.external_cli.inherit_host_mcp = false;
    hatoConfig.worker.external_cli.host_mcp_allowlist = ["context7"];
    hatoConfig.worker.external_cli.env = { PIP_INDEX_URL: "https://pypi.tuna.tsinghua.edu.cn/simple" };

    const mcpConfig: McpConfig = {
      servers: {
        personal_weather: {
          zone: "personal",
          transport: "stdio",
          command: "npx",
          args: ["weather"],
        },
        worker_gh: {
          zone: "worker",
          transport: "stdio",
          command: "npx",
          args: ["-y", "gh-mcp"],
          env_refs: { GH_TOKEN: "TEST_WORKER_MCP_KEY" },
        },
        worker_disabled_by_mandate: {
          zone: "worker",
          transport: "stdio",
          command: "npx",
          args: ["other"],
        },
      },
    };

    const contextMcp = {
      command: "node",
      args: ["context-server.js"],
      env: { HATO_CTX_TOKEN: "ctx_tok_1" },
    };

    const baseEnv = {
      PATH: "/usr/bin:/bin",
      HOME: fakeHome,
      TG_BOT_TOKEN: "must-never-leak",
      MEMORYECHO_API_KEY: "must-never-leak-2",
    };

    // 1. Codex CLI overlay (isolated workspace)
    const codexOverlay = prepareExternalCliOverlay({
      backend: "codex-cli",
      ticketId: "t_0001",
      workspaceDir: ticketWorkspace,
      isHostRepo: false,
      hatoConfig,
      mcpConfig,
      allowedMcpServers: ["worker_gh"],
      selectedSkills: [workerSkill],
      contextMcp,
      workerProxyEnv: { HTTPS_PROXY: "http://127.0.0.1:7890" },
      hostHomeDir: fakeHome,
      runtimeRootDir: runtimeRoot,
      baseEnv,
    });

    assert.equal("TG_BOT_TOKEN" in codexOverlay.env, false);
    assert.equal("MEMORYECHO_API_KEY" in codexOverlay.env, false);
    assert.equal("HATO_CTX_TOKEN" in codexOverlay.env, false);
    assert.equal("GH_TOKEN" in codexOverlay.env, false);
    assert.equal(codexOverlay.env.HTTPS_PROXY, "http://127.0.0.1:7890");
    assert.ok(codexOverlay.env.CODEX_HOME);

    const shadowAuth = join(codexOverlay.env.CODEX_HOME!, "auth.json");
    assert.equal(lstatSync(shadowAuth).isSymbolicLink(), true);
    assert.equal(readlinkSync(shadowAuth), join(fakeHome, ".codex", "auth.json"));

    const shadowCodexCfg = parseToml(
      readFileSync(join(codexOverlay.env.CODEX_HOME!, "config.toml"), "utf8"),
    ) as Record<string, any>;
    assert.equal(shadowCodexCfg.model, "gpt-5.4");
    assert.equal(shadowCodexCfg.model_providers.my_relay.base_url, "https://relay.example.com/v1");
    assert.ok(shadowCodexCfg.mcp_servers.hato_context);
    assert.equal(shadowCodexCfg.mcp_servers.hato_context.env.HATO_CTX_TOKEN, "ctx_tok_1");
    assert.ok(shadowCodexCfg.mcp_servers.worker_gh);
    assert.equal(shadowCodexCfg.mcp_servers.worker_gh.env.GH_TOKEN, "worker-mcp-secret-xyz");
    assert.ok(shadowCodexCfg.mcp_servers.context7);
    assert.equal("personal_calendar" in shadowCodexCfg.mcp_servers, false);
    assert.equal("personal_weather" in shadowCodexCfg.mcp_servers, false);
    assert.equal("worker_disabled_by_mandate" in shadowCodexCfg.mcp_servers, false);

    // Host config untouched
    assert.equal(readFileSync(join(fakeHome, ".codex", "config.toml"), "utf8"), origCodexToml);
    assert.equal(
      existsSync(join(ticketWorkspace, ".agents", "skills", "db-migrate", "SKILL.md")),
      true,
    );

    // 2. Antigravity CLI overlay against real host repo: must NOT dirty hostRepoDir
    const agyOverlay = prepareExternalCliOverlay({
      backend: "antigravity-cli",
      ticketId: "t_0002",
      workspaceDir: hostRepoDir,
      isHostRepo: true,
      hatoConfig,
      mcpConfig,
      allowedMcpServers: ["worker_gh"],
      selectedSkills: [workerSkill],
      contextMcp,
      hostHomeDir: fakeHome,
      runtimeRootDir: runtimeRoot,
      baseEnv,
    });

    assert.equal(existsSync(join(hostRepoDir, ".agents")), false);
    assert.ok(agyOverlay.stagedSkillsDir);
    assert.equal(existsSync(join(agyOverlay.stagedSkillsDir!, "db-migrate", "SKILL.md")), true);
    assert.ok(agyOverlay.extraArgs.includes("--settings"));
    assert.ok(agyOverlay.extraArgs.includes("--disable-slash-commands"));
    assert.ok(agyOverlay.extraArgs.includes("--add-dir"));
    assert.deepEqual(agyOverlay.modeArgs, ["--mode", "auto", "--dangerously-skip-permissions"]);

    // 3. opencode-v2 overlay: enforces --standalone and OPENCODE_CONFIG isolation
    const ocOverlay = prepareExternalCliOverlay({
      backend: "opencode-v2",
      ticketId: "t_0003",
      workspaceDir: hostRepoDir,
      isHostRepo: true,
      hatoConfig,
      mcpConfig,
      allowedMcpServers: ["worker_gh"],
      selectedSkills: [workerSkill],
      contextMcp,
      hostHomeDir: fakeHome,
      runtimeRootDir: runtimeRoot,
      baseEnv,
    });

    assert.deepEqual(ocOverlay.modeArgs, ["--standalone", "--auto"]);
    assert.ok(ocOverlay.env.OPENCODE_CONFIG);
    const ocJson = JSON.parse(readFileSync(ocOverlay.env.OPENCODE_CONFIG!, "utf8")) as Record<
      string,
      any
    >;
    assert.equal(ocJson.model, "my_relay/sonnet");
    assert.ok(ocJson.mcp.hato_context);
    assert.ok(ocJson.mcp.worker_gh);
    assert.equal("personal_notes" in ocJson.mcp, false);
    assert.deepEqual(ocJson.permissions, [{ action: "*", resource: "*", effect: "allow" }]);
    assert.equal(
      ocOverlay.env.PIP_INDEX_URL,
      "https://pypi.tuna.tsinghua.edu.cn/simple",
    );
  } finally {
    delete process.env.TEST_WORKER_MCP_KEY;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
