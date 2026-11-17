import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { agyCliAdapter } from "../src/worker/adapters/agy.js";
import { codexCliAdapter } from "../src/worker/adapters/codex.js";
import { openCodeV2CliAdapter } from "../src/worker/adapters/opencode-v2.js";
import { ExternalCliRunner } from "../src/worker/external-cli.js";
import {
  normalizeExternalCliResult,
  snapshotWorkspaceFiles,
} from "../src/worker/result-normalizer.js";

test("Tier 1 CLI adapters parse real NDJSON formats and build start/resume args", () => {
  const codexStart = codexCliAdapter.parseStreamLine(
    '{"type":"thread.started","thread_id":"th_123"}',
  );
  assert.equal(codexStart?.sessionId, "th_123");
  const codexCmd = codexCliAdapter.parseStreamLine(
    '{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}',
  );
  assert.match(codexCmd?.progressNote ?? "", /npm test/);
  const codexMsg = codexCliAdapter.parseStreamLine(
    '{"type":"item.completed","item":{"type":"agent_message","text":"All tests pass"}}',
  );
  assert.equal(codexMsg?.finalText, "All tests pass");

  const agyInit = agyCliAdapter.parseStreamLine(
    '{"event":"init","conversation_id":"conv_99","init":{"cwd":"/tmp"}}',
  );
  assert.equal(agyInit?.sessionId, "conv_99");
  const agyDelta = agyCliAdapter.parseStreamLine(
    '{"event":"step_update","step_update":{"conversation_id":"conv_99","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"2"}}',
  );
  assert.equal(agyDelta?.textDelta, "2");
  const agyDone = agyCliAdapter.parseStreamLine(
    '{"event":"result","result":{"conversation_id":"conv_99","status":"SUCCESS","response":"2\\n"}}',
  );
  assert.equal(agyDone?.finalText, "2\n");
  assert.equal(agyDone?.done, true);

  const ocTool = openCodeV2CliAdapter.parseStreamLine(
    '{"type":"tool_use","sessionID":"ses_abc","part":{"tool":"bash"}}',
  );
  assert.equal(ocTool?.sessionId, "ses_abc");
  assert.match(ocTool?.progressNote ?? "", /bash/);
});

test("normalizeExternalCliResult detects artifacts, needs_input questions, and _hato_result.json", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-norm-"));
  try {
    const before = snapshotWorkspaceFiles(tempDir);
    writeFileSync(join(tempDir, "report.txt"), "ok", "utf8");
    writeFileSync(join(tempDir, "chart.png"), "png", "utf8");

    const doneRes = normalizeExternalCliResult({
      ticketId: "t_norm1",
      workspaceDir: tempDir,
      isHostRepo: false,
      beforeFilesSnapshot: before,
      exitCode: 0,
      signal: null,
      finalText: "已生成报表和图表。",
      stderrText: "",
    });
    assert.equal(doneRes.status, "done");
    assert.deepEqual(
      doneRes.artifacts.map((a) => `${a.filename}:${a.send_as}`),
      ["chart.png:photo", "report.txt:file"],
    );

    const askDir = join(tempDir, "ask");
    mkdirSync(askDir, { recursive: true });
    const askRes = normalizeExternalCliResult({
      ticketId: "t_norm2",
      workspaceDir: askDir,
      isHostRepo: false,
      beforeFilesSnapshot: new Set(),
      exitCode: 0,
      signal: null,
      finalText: "请问目标服务器 IP 是多少？",
      stderrText: "",
    });
    assert.equal(askRes.status, "needs_input");
    assert.match(askRes.question ?? "", /服务器 IP/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ExternalCliRunner runs mocked agy/codex stream and enforces OpenCode V2 gate", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-ext-runner-"));
  const cfg = createDefaultHatoConfig();
  cfg.paths.workspaces_dir = join(tempDir, "workspaces");
  cfg.paths.sqlite = join(tempDir, "hato.db");
  cfg.worker.external_cli.agy = {
    enabled: true,
    command: process.execPath,
  };

  const mockCliScript = join(tempDir, "mock-agy.mjs");
  writeFileSync(
    mockCliScript,
    `
console.log(JSON.stringify({ event: "init", conversation_id: "agy_conv_77", init: { cwd: process.cwd() } }));
console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: "agy_conv_77", step_type: "tool_call", tool_name: "write_to_file" } }));
console.log(JSON.stringify({ event: "result", result: { conversation_id: "agy_conv_77", status: "SUCCESS", response: "脚本已写入完成" } }));
`,
    "utf8",
  );

  try {
    const proxyRouter = new ScopedProxyRouter([]);
    const seenSessions: string[] = [];
    const seenProgress: string[] = [];

    const runner = new ExternalCliRunner({
      getHatoConfig: () => cfg,
      getMcpConfig: () => ({ servers: {} }),
      proxyRouter,
      verifyOpenCodeV2: async () => ({
        ok: false,
        reason: "检测到不兼容的裸 OpenCode (v1.0.0)；必须为 OpenCode V2",
      }),
      spawnProcess: ((_cmd: string, args: string[], opts: any) => {
        // Redirect execution to our mock NDJSON script while preserving overlay env/cwd assertions
        return import("node:child_process").then(() => undefined) as never;
      }) as never,
    });

    // 1. OpenCode V2 gate failure returns explicit failure without launching CLI
    const ocFail = await runner.execute(
      {
        ticketId: "t_oc_fail",
        canonicalUserId: "owner",
        backend: "opencode-v2",
        briefTitle: "test v2 gate",
        contextId: "ctx_t_oc_fail",
        externalSessionId: null,
      },
      {
        workspace_mode: "isolated",
        workspace_dir: join(tempDir, "workspaces", "t_oc_fail"),
        is_host_repo: false,
        network: "none",
        timeout_ms: 10_000,
        skills: [],
        allowed_mcp_servers: [],
        confirm_before: [],
      },
    );
    assert.equal(ocFail.status, "failed");
    assert.match(ocFail.narration_hint, /OpenCode V2/);

    // 2. Real child process execution using node mock script via spawn wrapper
    const { spawn } = await import("node:child_process");
    const realRunner = new ExternalCliRunner({
      getHatoConfig: () => cfg,
      getMcpConfig: () => ({ servers: {} }),
      proxyRouter,
      spawnProcess: ((_cmd, _args, opts) =>
        spawn(process.execPath, [mockCliScript], opts)) as typeof spawn,
    });

    const agyOk = await realRunner.execute(
      {
        ticketId: "t_agy_ok",
        canonicalUserId: "owner",
        backend: "agy",
        briefTitle: "写脚本",
        contextId: "ctx_t_agy_ok",
        externalSessionId: null,
      },
      {
        workspace_mode: "isolated",
        workspace_dir: join(tempDir, "workspaces", "t_agy_ok"),
        is_host_repo: false,
        network: "none",
        timeout_ms: 10_000,
        skills: [],
        allowed_mcp_servers: [],
        confirm_before: [],
      },
      {
        onSessionId: (sid) => seenSessions.push(sid),
        onProgress: (note) => seenProgress.push(note),
      },
    );

    assert.equal(agyOk.status, "done");
    assert.equal(agyOk.narration_hint, "脚本已写入完成");
    assert.deepEqual(seenSessions, ["agy_conv_77"]);
    assert.equal(seenProgress.length >= 1, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
