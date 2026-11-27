import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { stringify as stringifyToml } from "smol-toml";
import { EventBus } from "../src/bus/actor-bus.js";
import { tryExecuteSlashCommand } from "../src/commands/slash.js";
import { HatoConfigSchema, resolveBackendPermissionPreset } from "../src/config/app.js";
import type { McpConfig } from "../src/config/mcp.js";
import { ModelRegistry, ModelsFileSchema } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import type { WorkerExecutionDispatcher } from "../src/contracts/worker.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { TicketCoordinator } from "../src/dispatch/coordinator.js";
import { TelegramAdapter } from "../src/gateway/tg.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import type { SkillEntry } from "../src/skills/loader.js";
import { evaluateAcpPermissionRequest } from "../src/worker/acp/permission-policy.js";
import { resolveAcpLaunchSpec } from "../src/worker/acp/profiles.js";
import { prepareExternalCliOverlay } from "../src/worker/overlay.js";

test("TicketCoordinator.abortActiveForUser cancels awaiting_confirm and needs_input tickets", async () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    const bus = new EventBus();
    const abortedIds: string[] = [];
    const dispatcher: WorkerExecutionDispatcher = {
      execute: async () => {
        throw new Error("not expected");
      },
      resume: async () => {
        throw new Error("not expected");
      },
      abort: async (id) => {
        abortedIds.push(id);
      },
      abortAll: async () => {},
    };
    const coord = new TicketCoordinator({
      getHatoConfig: () => createDefaultHatoConfig(),
      repo,
      router: {} as any,
      dispatcher,
      bus,
    });

    repo.createTicket({
      id: "t_confirm",
      canonicalUserId: "owner",
      status: "awaiting_confirm",
      backend: "builtin-pi",
      briefTitle: "Confirm task",
      originChannel: "tg",
    });
    repo.createTicket({
      id: "t_input",
      canonicalUserId: "owner",
      status: "needs_input",
      backend: "builtin-pi",
      briefTitle: "Input task",
      originChannel: "qq",
    });

    const stopped = await coord.abortActiveForUser("owner");
    assert.deepEqual(
      stopped.map((s) => s.id).sort(),
      ["t_confirm", "t_input"],
    );
    assert.deepEqual(abortedIds.sort(), ["t_confirm", "t_input"]);
    assert.equal(repo.getTicket("t_confirm")?.status, "cancelled");
    assert.equal(repo.getTicket("t_input")?.status, "cancelled");
  } finally {
    handle.close();
  }
});

test("evaluateAcpPermissionRequest separates confirmRequired, honors approvedConfirmKeys, and enforces Worker MCP policies", () => {
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" as const },
    { optionId: "reject", name: "Reject", kind: "reject_once" as const },
  ];

  const confirmHit = evaluateAcpPermissionRequest({
    request: {
      sessionId: "s1",
      toolCall: { toolCallId: "tc1", title: "run git push origin main", kind: "execute" },
      options,
    },
    permissionPreset: "auto_safe",
    executionMode: "isolated",
    confirmBefore: ["git push"],
  });
  assert.ok(confirmHit.confirmRequired);
  assert.equal(confirmHit.deniedReason, undefined);

  const approvedBypass = evaluateAcpPermissionRequest({
    request: {
      sessionId: "s1",
      toolCall: { toolCallId: "tc1", title: "run git push origin main", kind: "execute" },
      options,
    },
    permissionPreset: "auto_safe",
    executionMode: "isolated",
    confirmBefore: ["git push"],
    approvedConfirmKeys: new Set([confirmHit.confirmRequired.key]),
  });
  assert.equal(approvedBypass.confirmRequired, undefined);
  assert.equal(approvedBypass.deniedReason, undefined);
  if (approvedBypass.response.outcome.outcome === "selected") {
    assert.equal(approvedBypass.response.outcome.optionId, "allow");
  }

  const mcpPolicies = [
    {
      name: "db_srv",
      allowedTools: ["query", "drop_table"],
      deniedTools: ["drop_table"],
      confirmTools: ["query"],
    },
  ];
  const mcpDenied = evaluateAcpPermissionRequest({
    request: {
      sessionId: "s1",
      toolCall: { toolCallId: "tc2", name: "mcp__db_srv__drop_table", title: "drop_table", kind: "execute" },
      options,
    },
    permissionPreset: "yolo",
    executionMode: "isolated",
    confirmBefore: [],
    workerMcpPolicies: mcpPolicies,
  });
  assert.match(mcpDenied.deniedReason ?? "", /denied_tools/);

  const mcpConfirm = evaluateAcpPermissionRequest({
    request: {
      sessionId: "s1",
      toolCall: { toolCallId: "tc3", name: "mcp__db_srv__query", title: "query", kind: "execute" },
      options,
    },
    permissionPreset: "yolo",
    executionMode: "isolated",
    confirmBefore: [],
    workerMcpPolicies: mcpPolicies,
  });
  assert.ok(mcpConfirm.confirmRequired);
  assert.match(mcpConfirm.confirmRequired.reason, /db_srv:query/);
});

test("resolveBackendPermissionPreset and ACP profiles honor per-backend preset, codex sandbox, and opencode permission_mode", () => {
  const cfg = createDefaultHatoConfig();
  cfg.worker.external_cli.permission_preset = "auto_safe";
  cfg.worker.external_cli.codex_cli = {
    enabled: true,
    permission_preset: "read_only",
    sandbox: "workspace-write",
  };
  cfg.worker.external_cli.opencode_v2 = {
    enabled: true,
    permission_mode: "plan",
  };

  assert.equal(resolveBackendPermissionPreset(cfg, "codex-cli"), "read_only");
  assert.equal(resolveBackendPermissionPreset(cfg, "claude-code"), "auto_safe");

  const codexSpec = resolveAcpLaunchSpec("codex-cli", cfg, "isolated");
  assert.ok(codexSpec.args.includes("-c"));
  assert.ok(codexSpec.args.includes("sandbox_mode=workspace-write"));
  assert.equal(codexSpec.desiredMode, "read-only");

  const ocSpec = resolveAcpLaunchSpec("opencode-v2", cfg, "isolated");
  assert.equal(ocSpec.desiredMode, "plan");
});

test("prepareExternalCliOverlay isolates HOME when inherit_host_mcp=false and adds --add-dir for host_repo skills", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-overlay-iso-"));
  const runtimeRoot = join(tempDir, "worker-cli");
  const hostRepo = join(tempDir, "repo");
  const skillDir = join(tempDir, "skills", "my-skill");
  try {
    mkdirSync(hostRepo, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: my-skill\n---\nHello", "utf8");

    const cfg = createDefaultHatoConfig();
    cfg.worker.external_cli.inherit_host_mcp = false;
    cfg.worker.external_cli.reuse_host_auth_and_provider = false;
    const mcpCfg: McpConfig = { servers: {} };
    const skill: SkillEntry = {
      name: "my-skill",
      dirName: "my-skill",
      zone: "worker",
      description: "desc",
      dirPath: skillDir,
      skillFilePath: join(skillDir, "SKILL.md"),
      hasReferences: false,
    };

    const overlay = prepareExternalCliOverlay({
      backend: "claude-code",
      ticketId: "t_iso_1",
      workspaceDir: hostRepo,
      isHostRepo: true,
      executionMode: "isolated",
      hatoConfig: cfg,
      mcpConfig: mcpCfg,
      allowedMcpServers: [],
      selectedSkills: [skill],
      runtimeRootDir: runtimeRoot,
      baseEnv: { HOME: "/real/home", ANTHROPIC_API_KEY: "secret-key", PATH: "/usr/bin" },
    });

    assert.notEqual(overlay.env.HOME, "/real/home");
    assert.equal(overlay.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(overlay.args.includes("--strict-mcp-config"));
    assert.ok(overlay.args.includes("--add-dir"));
    assert.ok(overlay.stagedSkillsDir && overlay.args.includes(overlay.stagedSkillsDir));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("slash /forget uses replyToText fallback and /help filters unavailable commands", async () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    let forgottenQuery = "";
    const outForget = await tryExecuteSlashCommand({
      canonicalUserId: "owner",
      channel: "tg",
      platformUserId: "1",
      text: "/forget",
      replyToText: "old fact to forget",
      deps: {
        repo,
        forgetMemory: async (_uid, query) => {
          forgottenQuery = query;
          return {
            matchedCount: 1,
            erasedLocalCount: 1,
            erasedRemoteCount: 1,
            alreadyErasedCount: 0,
            missingRemoteCount: 0,
            unmappedCount: 0,
            failedCount: 0,
            errors: [],
          };
        },
      },
    });
    assert.equal(forgottenQuery, "old fact to forget");
    assert.match(outForget?.text ?? "", /遗忘处理完成/);

    const outHelpWebNoMem = await tryExecuteSlashCommand({
      canonicalUserId: "owner",
      channel: "web",
      platformUserId: "owner",
      text: "/help",
      deps: {
        repo,
      },
    });
    assert.ok(outHelpWebNoMem?.text);
    assert.doesNotMatch(outHelpWebNoMem.text, /\/sethome/);
    assert.doesNotMatch(outHelpWebNoMem.text, /\/forget/);
    assert.doesNotMatch(outHelpWebNoMem.text, /\/memory/);
  } finally {
    handle.close();
  }
});

test("TelegramAdapter handles unbound /help and schemas accept omitted hindsight_llm & worker.sandbox", async () => {
  const cfg = createDefaultHatoConfig();
  delete (cfg.worker as any).sandbox;
  assert.equal(Value.Check(HatoConfigSchema, cfg), true);

  const modelsCfg = {
    slots: {
      persona: "openai-gw/gpt-6.1-sol",
      router: "openai-gw/gpt-6.1-sol",
      curator: "openai-gw/gpt-6.1-sol",
      worker: "openai-gw/gpt-6.1-sol",
    },
    providers: {
      "openai-gw": {
        name: "OpenAI GW",
        api: "openai-responses",
        base_url: "https://api.openai.com/v1",
        api_key_env: "OPENAI_API_KEY",
        models: [
          {
            id: "gpt-6.1-sol",
            name: "GPT 6.1 Sol",
          },
        ],
      },
    },
  };
  assert.equal(Value.Check(ModelsFileSchema, modelsCfg), true);

  const tempDir = mkdtempSync(join(tmpdir(), "hato-models-opt-"));
  const modelsPath = join(tempDir, "models.toml");
  writeFileSync(modelsPath, stringifyToml(modelsCfg as any), "utf8");
  const registry = new ModelRegistry(modelsPath);
  assert.equal(registry.resolveSlot("hindsight_llm").target, modelsCfg.slots.curator);
  rmSync(tempDir, { recursive: true, force: true });

  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    const tg = new TelegramAdapter({
      botToken: "123:test",
      config: cfg,
      proxyRouter: new ScopedProxyRouter([]),
      onInboundMessage: async () => {},
      onClaimHome: async () => ({ ok: true, reply: "ok" }),
    });

    const replies: string[] = [];
    const handled = await tg.handlePrivateTextForClaim({
      chatType: "private",
      fromUserId: "999",
      messageId: "1",
      text: "/help",
      replyFn: async (r) => {
        replies.push(r);
      },
    });
    assert.equal(handled, true);
    assert.match(replies[0] ?? "", /\/sethome/);
    void repo;
  } finally {
    handle.close();
  }
});
