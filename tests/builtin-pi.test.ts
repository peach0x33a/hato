import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import type { WorkerMandate } from "../src/dispatch/schema.js";
import { writeHatoConfig } from "../src/config/store.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { BuiltinPiRunner, foldStaleWorkerToolOutputs } from "../src/worker/builtin-pi.js";

function setupBuiltinPiHarness(tempDir: string) {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-worker-1", name: "Faux Worker" }],
    tokensPerSecond: 10000,
  });

  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");
  const cfg = createDefaultHatoConfig();
  cfg.owner.timezone = "Asia/Shanghai";
  cfg.paths.workspaces_dir = join(tempDir, "workspaces");
  writeHatoConfig(hatoTomlPath, cfg, { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-worker-1"
router = "faux-provider/faux-worker-1"
curator = "faux-provider/faux-worker-1"
worker = "faux-provider/faux-worker-1"
hindsight_llm = "faux-provider/faux-worker-1"

[providers]
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  const repo = new HatoRepository(dbHandle.db);
  const modelRegistry = new ModelRegistry(modelsTomlPath, repo, {
    extraProviders: [faux.provider],
  });
  const proxyRouter = new ScopedProxyRouter([]);
  const backend = new BuiltinPiRunner({
    getHatoConfig: () => cfg,
    getMcpConfig: () => ({ mcpServers: {} }),
    modelRegistry,
    proxyRouter,
    repo,
  });

  return { faux, cfg, dbHandle, repo, backend };
}

test("BuiltinPiBackend register_script surfaces owner timezone and manage_scripts supports list/pause/reschedule/delete in vm_unrestricted", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-builtin-pi-scripts-"));
  const { faux, dbHandle, repo, backend } = setupBuiltinPiHarness(tempDir);
  try {
    const workdir = join(tempDir, "workspaces", "t_scripts");
    const scriptPath = join(workdir, "morning.py");
    repo.createTicket({
      id: "t_scripts",
      canonicalUserId: "owner",
      status: "running",
      backend: "builtin-pi",
      briefTitle: "脚本管理测试",
      originChannel: "qq",
    });

    const mandate: WorkerMandate = {
      ticket_id: "t_scripts",
      execution_mode: "vm_unrestricted",
      workspace_mode: "shared_host",
      workspace_dir: workdir,
      network: "none",
      skills: [],
      allowed_mcp_servers: [],
      confirm_before: [],
      timeout_ms: 60_000,
    };

    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall("write_file", { path: "morning.py", content: "print('hi')\n" }),
            fauxToolCall("register_script", {
              name: "晨报",
              script_path: scriptPath,
              cron_expr: "0 7 * * *",
            }),
          ],
          { stopReason: "toolUse" },
        ),
      (ctx) => {
        const regResultText = JSON.stringify(ctx.messages);
        assert.equal(regResultText.includes("Asia/Shanghai"), true);
        const created = repo.listScripts(10)[0]!;
        assert.ok(created);
        return fauxAssistantMessage(
          [
            fauxToolCall("manage_scripts", { action: "list" }),
            fauxToolCall("manage_scripts", { action: "pause", script_id: created.id }),
            fauxToolCall("manage_scripts", {
              action: "reschedule",
              script_id: created.id,
              cron_expr: "30 8 * * *",
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      () => {
        const updated = repo.listScripts(10)[0]!;
        assert.equal(updated.enabled, false);
        assert.equal(updated.cronExpr, "30 8 * * *");
        return fauxAssistantMessage(
          [fauxToolCall("manage_scripts", { action: "delete", script_id: updated.id })],
          { stopReason: "toolUse" },
        );
      },
      () => {
        assert.equal(repo.listScripts(10).length, 0);
        return fauxAssistantMessage(
          [
            fauxToolCall("finish_task", {
              status: "done",
              narration_hint: "已完成脚本注册与管理测试",
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      () => fauxAssistantMessage("done"),
    ]);

    const res = await backend.execute(
      {
        ticketId: "t_scripts",
        canonicalUserId: "owner",
        briefTitle: "脚本管理测试",
        originChannel: "qq",
        contextId: "ctx_t_scripts",
      },
      mandate,
    );
    assert.equal(res.status, "done");
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("BuiltinPiBackend manage_scripts requires confirmation in isolated mode", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-builtin-pi-confirm-"));
  const { faux, dbHandle, repo, backend } = setupBuiltinPiHarness(tempDir);
  try {
    const existing = repo.registerScript({
      ticketId: "t_old",
      name: "旧脚本",
      scriptPath: "/tmp/old.py",
      cronExpr: "0 9 * * *",
      notifyChannel: "qq",
    });
    repo.createTicket({
      id: "t_iso",
      canonicalUserId: "owner",
      status: "running",
      backend: "builtin-pi",
      briefTitle: "停用旧脚本",
      originChannel: "qq",
    });

    const mandate: WorkerMandate = {
      ticket_id: "t_iso",
      execution_mode: "isolated",
      workspace_mode: "isolated",
      workspace_dir: join(tempDir, "workspaces", "t_iso"),
      network: "none",
      skills: [],
      allowed_mcp_servers: [],
      confirm_before: [],
      timeout_ms: 60_000,
    };

    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("manage_scripts", { action: "pause", script_id: existing.id })],
          { stopReason: "toolUse" },
        ),
    ]);

    const paused = await backend.execute(
      {
        ticketId: "t_iso",
        canonicalUserId: "owner",
        briefTitle: "停用旧脚本",
        originChannel: "qq",
        contextId: "ctx_t_iso",
      },
      mandate,
    );
    assert.equal(paused.status, "awaiting_confirm");
    assert.equal(repo.listScripts(10)[0]?.enabled, true);

    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("manage_scripts", { action: "pause", script_id: existing.id })],
          { stopReason: "toolUse" },
        ),
      () =>
        fauxAssistantMessage(
          [fauxToolCall("finish_task", { status: "done", narration_hint: "已暂停旧脚本" })],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("done"),
    ]);

    const resumed = await backend.resume(
      {
        ticketId: "t_iso",
        canonicalUserId: "owner",
        briefTitle: "停用旧脚本",
        originChannel: "qq",
        contextId: "ctx_t_iso",
      },
      mandate,
      "确认",
    );
    assert.equal(resumed.status, "done");
    assert.equal(repo.listScripts(10)[0]?.enabled, false);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("foldStaleWorkerToolOutputs folds older large toolResult outputs while keeping recent 6 intact", () => {
  const bigText = "A".repeat(1200) + "MIDDLE" + "Z".repeat(1200);
  const messages = Array.from({ length: 8 }, (_, idx) => ({
    role: "toolResult" as const,
    toolCallId: `call_${idx}`,
    toolName: "run_command",
    content: [{ type: "text" as const, text: bigText }],
    isError: false,
    timestamp: 1000 + idx,
  }));

  const folded = foldStaleWorkerToolOutputs(messages, 6, 1600);
  assert.equal(folded.length, 8);

  // Oldest 2 should be folded
  for (const idx of [0, 1]) {
    const part = folded[idx]!.content[0] as { type: "text"; text: string };
    assert.ok(part.text.includes("历史工具输出已折叠"));
    assert.ok(part.text.startsWith("A".repeat(800)));
    assert.ok(part.text.endsWith("Z".repeat(600)));
  }

  // Recent 6 should remain verbatim
  for (let idx = 2; idx < 8; idx++) {
    const part = folded[idx]!.content[0] as { type: "text"; text: string };
    assert.equal(part.text, bigText);
  }

  // Original array must not be mutated
  assert.equal((messages[0]!.content[0] as { type: "text"; text: string }).text, bigText);
});
