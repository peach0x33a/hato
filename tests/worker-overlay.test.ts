import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpConfig } from "../src/config/mcp.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import type { SkillEntry } from "../src/skills/loader.js";
import { prepareExternalCliOverlay } from "../src/worker/overlay.js";

test("prepareExternalCliOverlay builds clean ACP env, skills staging, and authorized ACP mcpServers", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-overlay-"));
  const runtimeRoot = join(tempDir, "worker-cli");
  const ticketWorkspace = join(tempDir, "ws-isolated");
  const hostRepoDir = join(tempDir, "host-repo");
  const skillSrcDir = join(tempDir, "worker-skills", "db-migrate");

  try {
    mkdirSync(ticketWorkspace, { recursive: true });
    mkdirSync(hostRepoDir, { recursive: true });
    mkdirSync(skillSrcDir, { recursive: true });

    writeFileSync(
      join(skillSrcDir, "SKILL.md"),
      "---\nname: db-migrate\ndescription: Safe migrations\n---\nRun dry-run first.",
      "utf8",
    );
    const workerSkill: SkillEntry = {
      name: "db-migrate",
      dirName: "db-migrate",
      zone: "worker",
      description: "Safe migrations",
      dirPath: skillSrcDir,
      skillFilePath: join(skillSrcDir, "SKILL.md"),
      hasReferences: false,
    };

    process.env.TEST_WORKER_MCP_KEY = "worker-mcp-secret-xyz";
    const hatoConfig = createDefaultHatoConfig();
    hatoConfig.worker.external_cli.permission_preset = "yolo";
    hatoConfig.worker.external_cli.env = {
      PIP_INDEX_URL: "https://pypi.tuna.tsinghua.edu.cn/simple",
    };

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
      },
    };

    const agyOverlay = prepareExternalCliOverlay({
      backend: "antigravity-cli",
      ticketId: "tk-overlay-1",
      workspaceDir: ticketWorkspace,
      isHostRepo: false,
      hatoConfig,
      mcpConfig,
      allowedMcpServers: ["worker_gh", "personal_weather"],
      selectedSkills: [workerSkill],
      contextMcp: {
        command: "bun",
        args: ["context-server.ts"],
        env: { HATO_CONTEXT_ID: "ctx-1" },
      },
      workerProxyEnv: { HTTP_PROXY: "http://127.0.0.1:7890" },
      runtimeRootDir: runtimeRoot,
      baseEnv: {
        PATH: process.env.PATH ?? "/usr/bin",
        HOME: "/tmp/home",
        TG_BOT_TOKEN: "should-not-leak",
      },
    });

    assert.equal(agyOverlay.command, "agy");
    assert.ok(agyOverlay.args.includes("acp"));
    assert.ok(agyOverlay.args.includes("--dangerously-skip-permissions"));
    assert.equal(agyOverlay.env.TG_BOT_TOKEN, undefined);
    assert.equal(agyOverlay.env.HTTP_PROXY, "http://127.0.0.1:7890");
    assert.equal(
      agyOverlay.env.PIP_INDEX_URL,
      "https://pypi.tuna.tsinghua.edu.cn/simple",
    );

    const mcpNames = agyOverlay.mcpServers.map((s) => s.name);
    assert.deepEqual(mcpNames, ["hato_context", "worker_gh"]);
    const workerGh = agyOverlay.mcpServers.find((s) => s.name === "worker_gh");
    assert.ok(workerGh && !("type" in workerGh && workerGh.type === "http"));
    if (workerGh && "env" in workerGh) {
      assert.deepEqual(workerGh.env, [
        { name: "GH_TOKEN", value: "worker-mcp-secret-xyz" },
      ]);
    }

    assert.equal(agyOverlay.stagedSkillsDir, join(ticketWorkspace, ".agents", "skills"));
    assert.ok(existsSync(join(ticketWorkspace, ".agents", "skills", "db-migrate", "SKILL.md")));

    // Host repo mode stages skills outside the repo checkout
    const hostOverlay = prepareExternalCliOverlay({
      backend: "codex-cli",
      ticketId: "tk-overlay-host",
      workspaceDir: hostRepoDir,
      isHostRepo: true,
      hatoConfig,
      mcpConfig,
      allowedMcpServers: [],
      selectedSkills: [workerSkill],
      runtimeRootDir: runtimeRoot,
    });
    assert.equal(hostOverlay.command, "codex-acp");
    assert.equal(existsSync(join(hostRepoDir, ".agents")), false);
    assert.ok(hostOverlay.stagedSkillsDir?.startsWith(join(runtimeRoot, "skills")));
    assert.match(
      readFileSync(join(hostOverlay.stagedSkillsDir!, "db-migrate", "SKILL.md"), "utf8"),
      /Safe migrations/,
    );
  } finally {
    delete process.env.TEST_WORKER_MCP_KEY;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
