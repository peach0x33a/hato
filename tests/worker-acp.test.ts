import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import type { WorkerMandate } from "../src/dispatch/schema.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { workerActivityHub } from "../src/worker/activity-stream.js";
import type { TicketExecutionHandle } from "../src/worker/backend.js";
import { ExternalCliRunner } from "../src/worker/external-cli.js";

const FAKE_AGENT_PATH = resolve(process.cwd(), "tests/fixtures/fake-acp-agent.ts");

function makeRunner(scenario: string, extraEnv?: Record<string, string>) {
  const tempRoot = mkdtempSync(join(tmpdir(), "hato-acp-runner-"));
  const workspaceDir = join(tempRoot, "ws");
  const config = createDefaultHatoConfig();
  config.paths.workspaces_dir = join(tempRoot, "workspaces");
  config.paths.sqlite = join(tempRoot, "hato.db");
  config.worker.external_cli.claude_code = {
    enabled: true,
    command: process.execPath,
    acp_args: [FAKE_AGENT_PATH],
  };
  config.worker.external_cli.env = {
    FAKE_ACP_SCENARIO: scenario,
    ...extraEnv,
  };

  const runner = new ExternalCliRunner({
    getHatoConfig: () => config,
    getMcpConfig: () => ({
      servers: {
        worker_tool: {
          zone: "worker",
          transport: "stdio",
          command: "echo",
          args: ["ok"],
        },
        personal_tool: {
          zone: "personal",
          transport: "stdio",
          command: "echo",
          args: ["secret"],
        },
      },
    }),
    proxyRouter: new ScopedProxyRouter([]),
    verifyBackendCapabilities: async () => ({ ok: true }),
  });

  const ticket: TicketExecutionHandle = {
    ticketId: `tk-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    canonicalUserId: "user-1",
    backend: "claude-code",
    briefTitle: "ACP 集成测试任务",
    contextId: "ctx-1",
    externalSessionId: null,
  };

  const mandate: WorkerMandate = {
    workspace_mode: "isolated",
    workspace_dir: workspaceDir,
    is_host_repo: false,
    network: "none",
    timeout_ms: 8000,
    skills: [],
    allowed_mcp_servers: ["worker_tool"],
    confirm_before: [],
  };

  return {
    tempRoot,
    runner,
    ticket,
    mandate,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

test("ExternalCliRunner executes ACP workflow, records sessionId, and streams activities", async () => {
  const ctx = makeRunner("normal");
  let capturedSessionId: string | undefined;
  const progressNotes: string[] = [];

  try {
    const res = await ctx.runner.execute(ctx.ticket, ctx.mandate, {
      onSessionId: (sid) => {
        capturedSessionId = sid;
      },
      onProgress: (note) => {
        progressNotes.push(note);
      },
    });

    assert.equal(res.status, "done");
    assert.ok(capturedSessionId?.startsWith("acp-sess-"));
    assert.match(res.narration_hint, /ACP_DONE/);
    assert.ok(progressNotes.length > 0);
    const items = workerActivityHub.getItems(ctx.ticket.ticketId);
    assert.ok(items.some((i) => i.kind === "command" && i.state === "done"));
    assert.ok(items.some((i) => i.kind === "lifecycle" && i.title === "Worker 执行完成"));
  } finally {
    await ctx.runner.abortAll();
    ctx.cleanup();
  }
});

test("ExternalCliRunner injects hato_context and authorized worker MCP servers via ACP mcpServers", async () => {
  const ctx = makeRunner("mcp_echo");
  try {
    const res = await ctx.runner.execute(ctx.ticket, ctx.mandate);
    assert.equal(res.status, "done");
    const raw = res.narration_hint.replace(/^MCP_SERVERS:/, "");
    const mcpNames = JSON.parse(raw) as string[];
    assert.ok(mcpNames.includes("hato_context"));
    assert.ok(mcpNames.includes("worker_tool"));
    assert.equal(mcpNames.includes("personal_tool"), false);
  } finally {
    await ctx.runner.abortAll();
    ctx.cleanup();
  }
});

test("ExternalCliRunner parks pooled ACP session on needs_input and reuses same PID on resume", async () => {
  const ctx = makeRunner("needs_input_then_resume");
  let sessionId = "";
  try {
    const first = await ctx.runner.execute(ctx.ticket, ctx.mandate, {
      onSessionId: (sid) => {
        sessionId = sid;
      },
    });
    assert.equal(first.status, "needs_input");
    assert.match(first.question ?? "", /哪个环境/);

    const pidFromSession = sessionId.replace("acp-sess-", "");
    ctx.ticket.externalSessionId = sessionId;

    const second = await ctx.runner.resume(ctx.ticket, ctx.mandate, "CONFIRMED_REPLY prod");
    assert.equal(second.status, "done");
    assert.match(second.narration_hint, new RegExp(`pid=${pidFromSession}`));
    assert.match(second.narration_hint, /turn=2/);
  } finally {
    await ctx.runner.abortAll();
    ctx.cleanup();
  }
});

test("ExternalCliRunner blocks confirm_before actions via ACP request_permission", async () => {
  const ctx = makeRunner("permission_confirm");
  ctx.mandate.confirm_before = ["DROP TABLE"];
  try {
    const res = await ctx.runner.execute(ctx.ticket, ctx.mandate);
    assert.equal(res.status, "needs_input");
    assert.match(res.question ?? "", /DROP TABLE/);
  } finally {
    await ctx.runner.abortAll();
    ctx.cleanup();
  }
});

test("ExternalCliRunner sends session/cancel on abort", async () => {
  const ctx = makeRunner("cancel_on_abort");
  try {
    const runPromise = ctx.runner.execute(ctx.ticket, ctx.mandate);
    await new Promise((r) => setTimeout(r, 200));
    await ctx.runner.abort(ctx.ticket.ticketId);
    const res = await runPromise;
    assert.equal(res.status, "failed");
    assert.match(res.narration_hint, /中止/);
  } finally {
    await ctx.runner.abortAll();
    ctx.cleanup();
  }
});
