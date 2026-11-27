import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { AcpSessionConnection, probeAcpHandshake } from "../src/worker/acp/client.js";
import { AcpEventMapper } from "../src/worker/acp/event-mapper.js";
import { evaluateAcpPermissionRequest } from "../src/worker/acp/permission-policy.js";

const FAKE_AGENT_PATH = resolve(process.cwd(), "tests/fixtures/fake-acp-agent.ts");

test("AcpEventMapper maps agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, and plan", () => {
  const mapper = new AcpEventMapper();
  mapper.resetForNewTurn();

  const thought = mapper.map({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "internal thought" },
  });
  assert.equal(thought.textDelta, undefined);
  assert.equal(thought.progressNote, "正在思考推理...");

  const tcStart = mapper.map({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Run tests",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "bun test" },
  });
  assert.equal(tcStart.activities[0]?.kind, "command");
  assert.equal(tcStart.activities[0]?.state, "running");
  assert.equal(tcStart.activities[0]?.command, "bun test");

  const tcDone = mapper.map({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    rawOutput: { stdout: "all green" },
  });
  assert.equal(tcDone.activities[0]?.kind, "command");
  assert.equal(tcDone.activities[0]?.state, "done");
  assert.equal(tcDone.activities[0]?.output, "all green");

  const plan = mapper.map({
    sessionUpdate: "plan",
    entries: [
      { content: "Step A", priority: "high", status: "completed" },
      { content: "Step B", priority: "medium", status: "pending" },
    ],
  });
  assert.equal(plan.activities[0]?.kind, "lifecycle");
  assert.match(plan.activities[0]?.text ?? "", /\[x\] Step A/);
  assert.match(plan.activities[0]?.text ?? "", /\[ \] Step B/);

  const msg = mapper.map({
    sessionUpdate: "agent_message_chunk",
    messageId: "m1",
    content: { type: "text", text: "Final answer" },
  });
  assert.equal(msg.textDelta, "Final answer");
  assert.equal(msg.activities[0]?.kind, "assistant");
  assert.equal(msg.activities[0]?.appendText, "Final answer");
});

test("evaluateAcpPermissionRequest enforces confirm_before and read_only vs yolo", () => {
  const baseReq = {
    sessionId: "s1",
    toolCall: {
      toolCallId: "tc-1",
      title: "Execute shell command",
      kind: "execute" as const,
      rawInput: { command: "git push origin main" },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ],
  };

  const confirmDenied = evaluateAcpPermissionRequest({
    request: baseReq,
    permissionPreset: "yolo",
    executionMode: "isolated",
    confirmBefore: ["git push"],
  });
  assert.equal(confirmDenied.response.outcome.outcome, "selected");
  if (confirmDenied.response.outcome.outcome === "selected") {
    assert.equal(confirmDenied.response.outcome.optionId, "reject");
  }
  assert.match(confirmDenied.confirmRequired?.reason ?? "", /git push/);

  const readOnlyDenied = evaluateAcpPermissionRequest({
    request: baseReq,
    permissionPreset: "read_only",
    executionMode: "isolated",
    confirmBefore: [],
  });
  assert.ok(readOnlyDenied.deniedReason);

  const yoloAllowed = evaluateAcpPermissionRequest({
    request: baseReq,
    permissionPreset: "yolo",
    executionMode: "isolated",
    confirmBefore: [],
  });
  assert.equal(yoloAllowed.deniedReason, undefined);
  if (yoloAllowed.response.outcome.outcome === "selected") {
    assert.equal(yoloAllowed.response.outcome.optionId, "allow");
  }
});

test("probeAcpHandshake succeeds against fake ACP agent and reports ENOENT cleanly", async () => {
  const okRes = await probeAcpHandshake({
    command: process.execPath,
    args: [FAKE_AGENT_PATH],
    timeoutMs: 5000,
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.installed, true);
  assert.equal(okRes.agentInfo?.name, "fake-acp-agent");
  assert.equal(okRes.agentCapabilities?.loadSession, true);

  const missingRes = await probeAcpHandshake({
    command: "definitely-not-installed-acp-binary-xyz",
    args: [],
    timeoutMs: 2000,
  });
  assert.equal(missingRes.ok, false);
  assert.equal(missingRes.installed, false);
});

test("AcpSessionConnection runs initialize -> session/new -> session/prompt -> close", async () => {
  const activities: string[] = [];
  const conn = new AcpSessionConnection({
    command: process.execPath,
    args: [FAKE_AGENT_PATH],
    cwd: process.cwd(),
    env: { ...process.env, FAKE_ACP_SCENARIO: "normal" } as Record<string, string>,
    callbacks: {
      onActivity: (act) => {
        if (act.title) activities.push(act.title);
      },
    },
  });

  try {
    const init = await conn.initialize(5000);
    assert.equal(init.agentInfo?.name, "fake-acp-agent");
    const sess = await conn.startSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    assert.ok(sess.sessionId.startsWith("acp-sess-"));
    const res = await conn.prompt("hello", 5000);
    assert.equal(res.stopReason, "end_turn");
    assert.match(res.finalText, /ACP_DONE/);
    assert.ok(activities.includes("执行命令"));
    assert.ok(activities.includes("执行计划"));
  } finally {
    await conn.close();
  }
});
