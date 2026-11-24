import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { EventBus } from "../src/bus/actor-bus.js";
import {
  listEnabledWorkerBackends,
  loadHatoConfig,
  resolveEffectiveDefaultBackend,
} from "../src/config/app.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { TicketCoordinator } from "../src/dispatch/coordinator.js";
import { NeutralRouter } from "../src/dispatch/router.js";
import type { WorkerResult } from "../src/dispatch/schema.js";
import { PersonaRuntime } from "../src/persona/agent.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { WorkerDispatcher } from "../src/worker/backend.js";
import { BuiltinPiRunner } from "../src/worker/builtin-pi.js";
import { ExternalCliRunner } from "../src/worker/external-cli.js";

test("End-to-end delegate() -> NeutralRouter -> BuiltinPiRunner (ask_user -> resume -> finish_task) -> bus ticket_result", async () => {
  const fauxPersona = fauxProvider({
    api: "hato-faux-persona-api",
    provider: "faux-persona",
    models: [{ id: "p1", name: "Faux Persona" }],
    tokensPerSecond: 10_000,
  });
  const fauxRouter = fauxProvider({
    api: "hato-faux-router-api",
    provider: "faux-router",
    models: [{ id: "r1", name: "Faux Router" }],
    tokensPerSecond: 10_000,
  });
  const fauxWorker = fauxProvider({
    api: "hato-faux-worker-api",
    provider: "faux-worker",
    models: [{ id: "w1", name: "Faux Worker" }],
    tokensPerSecond: 10_000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-e2e-dispatch-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");
  const promptsDir = join(tempDir, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, "soul.md"), "SECRET_PERSONA_SOUL_TOKEN_DO_NOT_LEAK", "utf8");

  const cfgObj = createDefaultHatoConfig();
  cfgObj.paths.prompts_dir = promptsDir;
  cfgObj.paths.workspaces_dir = join(tempDir, "workspaces");
  cfgObj.worker.default_backend = "builtin-pi";
  writeHatoConfig(hatoTomlPath, cfgObj, { backup: false });

  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-persona/p1"
router = "faux-router/r1"
curator = "faux-router/r1"
worker = "faux-worker/w1"
hindsight_llm = "faux-router/r1"

[providers]
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  try {
    const hatoConfig = loadHatoConfig(hatoTomlPath);
    const repo = new HatoRepository(dbHandle.db);
    repo.ensureOwner({
      canonicalUserId: "owner",
      timezone: "Asia/Shanghai",
      proactiveChannel: "tg",
    });

    const modelRegistry = new ModelRegistry(modelsTomlPath, repo, {
      extraProviders: [fauxPersona.provider, fauxRouter.provider, fauxWorker.provider],
    });
    const proxyRouter = new ScopedProxyRouter([]);
    const bus = new EventBus();

    const router = new NeutralRouter({
      getHatoConfig: () => hatoConfig,
      getMcpConfig: () => ({ servers: {} }),
      modelRegistry,
      proxyRouter,
      repo,
    });
    const builtinRunner = new BuiltinPiRunner({
      getHatoConfig: () => hatoConfig,
      modelRegistry,
      proxyRouter,
      repo,
    });
    const externalRunner = new ExternalCliRunner({
      getHatoConfig: () => hatoConfig,
      getMcpConfig: () => ({ servers: {} }),
      proxyRouter,
    });
    const dispatcher = new WorkerDispatcher(builtinRunner, externalRunner);
    const coordinator = new TicketCoordinator({
      getHatoConfig: () => hatoConfig,
      repo,
      router,
      dispatcher,
      bus,
    });

    const personaRuntime = new PersonaRuntime(
      hatoConfig,
      modelRegistry,
      proxyRouter,
      repo,
      undefined,
      null,
      hatoTomlPath,
    );
    personaRuntime.setDelegateHandler((input) => coordinator.enqueueDelegation(input));

    const emittedNeedsInput: Array<{ ticketId: string; question: string }> = [];
    const emittedResults: WorkerResult[] = [];
    bus.on("ticket_needs_input", (ev) => {
      emittedNeedsInput.push({ ticketId: ev.ticketId, question: ev.question });
    });
    bus.on("ticket_result", (ev) => {
      emittedResults.push(ev.result);
    });

    let routerSawPersonaSecret = false;
    let workerSawPersonaSecret = false;
    let observedContextSliceText = "";

    fauxPersona.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall("delegate", { hint: "写一个 hello.py 脚本" })], {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("好呀，我这就去写！"),
    ]);

    fauxRouter.setResponses([
      (ctx) => {
        const allText = `${ctx.systemPrompt ?? ""}\n${JSON.stringify(ctx.messages)}`;
        if (allText.includes("SECRET_PERSONA_SOUL_TOKEN_DO_NOT_LEAK")) {
          routerSawPersonaSecret = true;
        }
        const recent = repo.listRecentMessages("owner", 10);
        const firstId = recent[0]!.id;
        const lastId = recent[recent.length - 1]!.id;
        return fauxAssistantMessage(
          JSON.stringify({
            decision: "ticket",
            backend: "builtin-pi",
            brief_title: "生成 hello.py",
            context_range: { from_msg_id: firstId, to_msg_id: lastId },
            workspace_mode: "isolated",
            skills: [],
            allowed_mcp_servers: [],
            confirm_before: [],
          }),
        );
      },
      () =>
        fauxAssistantMessage(
          JSON.stringify({
            route: "reply_ticket",
            ticket_id: repo.listTickets("owner", 5)[0]!.id,
            objective_reply: "输出 Hello Hato",
          }),
        ),
    ]);

    fauxWorker.setResponses([
      (ctx) => {
        const allText = `${ctx.systemPrompt ?? ""}\n${JSON.stringify(ctx.messages)}`;
        if (allText.includes("SECRET_PERSONA_SOUL_TOKEN_DO_NOT_LEAK")) {
          workerSawPersonaSecret = true;
        }
        const tickets = repo.listTickets("owner", 5);
        const ctxId = tickets[0]!.contextId!;
        return fauxAssistantMessage([fauxToolCall("read_task_context", { context_id: ctxId })], {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        const last = ctx.messages[ctx.messages.length - 1];
        if (last?.role === "toolResult") {
          observedContextSliceText = JSON.stringify(last.content);
        }
        return fauxAssistantMessage(
          [fauxToolCall("ask_user", { question: "请问脚本里要输出谁的名字？" })],
          { stopReason: "toolUse" },
        );
      },
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall("write_file", {
              path: "hello.py",
              content: 'print("Hello Hato")\n',
            }),
          ],
          { stopReason: "toolUse" },
        ),
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall("finish_task", {
              status: "done",
              narration_hint: "已生成 hello.py，输出 Hello Hato。",
              artifact_paths: ["hello.py"],
            }),
          ],
          { stopReason: "toolUse" },
        ),
    ]);

    const now = Date.now();
    const personaOut = await personaRuntime.handleUserBatch({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123456",
      platformMsgIds: ["m_e2e_1"],
      latestPlatformMsgId: "m_e2e_1",
      combinedText: "帮我写个 hello.py 脚本",
      attachments: [],
      firstTimestampMs: now,
      lastTimestampMs: now,
    });

    assert.deepEqual(personaOut.toolCalls, ["delegate"]);
    assert.match(personaOut.rawText, /这就去写/);

    await coordinator.waitForIdle();

    assert.equal(routerSawPersonaSecret, false);
    assert.equal(workerSawPersonaSecret, false);
    assert.match(observedContextSliceText, /hello\.py/);
    assert.equal(emittedNeedsInput.length, 1);
    assert.match(emittedNeedsInput[0]!.question, /名字/);

    // User answers the needs_input prompt
    const routed = await coordinator.tryRouteInboundToTicket({
      canonicalUserId: "owner",
      originChannel: "tg",
      originPlatformUserId: "123456",
      platformMsgIds: ["m_e2e_2"],
      latestPlatformMsgId: "m_e2e_2",
      combinedText: "写 Hello Hato 就行",
      attachments: [],
      firstTimestampMs: now + 1000,
      lastTimestampMs: now + 1000,
    });
    assert.equal(routed.handledByTicket, true);

    await coordinator.waitForIdle();

    assert.equal(emittedResults.length, 1);
    assert.equal(emittedResults[0]!.status, "done");
    assert.match(emittedResults[0]!.narration_hint, /hello\.py/);

    const routerTraces = repo.listTurnTraces({ canonicalUserId: "owner", slot: "router", limit: 10 });
    assert.ok(routerTraces.length >= 1);
    assert.match(routerTraces[0]!.timeCardText, /Router Input Context/);
    assert.ok(routerTraces[0]!.stepsJson.includes('"kind":"assistant"'));

    const workerTraces = repo.listTurnTraces({ canonicalUserId: "owner", slot: "worker", limit: 10 });
    assert.ok(workerTraces.length >= 1);
    assert.match(workerTraces[0]!.userPreview ?? "", /工单/);
    assert.ok(workerTraces[0]!.stepsJson.includes("hello.py"));
    assert.equal(emittedResults[0]!.artifacts.length, 1);
    const artifactPath = emittedResults[0]!.artifacts[0]!.path;
    assert.equal(existsSync(artifactPath), true);
    assert.match(readFileSync(artifactPath, "utf8"), /Hello Hato/);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("listEnabledWorkerBackends and NeutralRouter exclude disabled external CLIs even when default_backend references them", async () => {
  const cfg = createDefaultHatoConfig();
  cfg.worker.default_backend = "opencode-v2";
  cfg.worker.external_cli.opencode_v2 = { enabled: false };
  cfg.worker.external_cli.codex_cli = { enabled: false };
  cfg.worker.external_cli.antigravity_cli = { enabled: true };
  cfg.worker.external_cli.external_pi = { enabled: false };
  cfg.worker.external_cli.claude_code = { enabled: false };

  const enabled = listEnabledWorkerBackends(cfg);
  assert.deepEqual(enabled, ["antigravity-cli", "builtin-pi"]);
  assert.equal(resolveEffectiveDefaultBackend(cfg), "antigravity-cli");

  const tempDir = mkdtempSync(join(tmpdir(), "hato-disabled-cli-"));
  const modelsToml = join(tempDir, "models.toml");
  writeFileSync(
    modelsToml,
    `[slots]
persona = "faux-router/r1"
router = "faux-router/r1"
curator = "faux-router/r1"
worker = "faux-router/r1"
hindsight_llm = "faux-router/r1"

[providers]
`,
    "utf8",
  );

  const fauxRouter = fauxProvider({
    api: "hato-faux-router-disabled",
    provider: "faux-router",
    models: [{ id: "r1", name: "R1" }],
    tokensPerSecond: 10_000,
  });
  let observedUserPrompt = "";
  fauxRouter.setResponses([
    (ctx) => {
      observedUserPrompt = JSON.stringify(ctx.messages);
      return fauxAssistantMessage(
        JSON.stringify({
          decision: "ticket",
          backend: "opencode-v2",
          brief_title: "尝试调用被禁用后端",
          context_range: { from_msg_id: "m1", to_msg_id: "m1" },
          workspace_mode: "isolated",
        }),
      );
    },
  ]);

  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    repo.ensureOwner({
      canonicalUserId: "owner",
      timezone: "Asia/Shanghai",
      proactiveChannel: "tg",
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "web",
      role: "user",
      content: "帮我改一下仓库代码",
      createdAt: Date.now(),
    });
    const registry = new ModelRegistry(modelsToml, repo, {
      extraProviders: [fauxRouter.provider],
    });
    const router = new NeutralRouter({
      getHatoConfig: () => cfg,
      getMcpConfig: () => ({ servers: {} }),
      modelRegistry: registry,
      proxyRouter: new ScopedProxyRouter([]),
      repo,
    });

    const decision = await router.routeDelegation({
      canonicalUserId: "owner",
      hint: "改仓库代码",
    });

    assert.equal(observedUserPrompt.includes("[default_backend]: antigravity-cli"), true);
    assert.equal(observedUserPrompt.includes("[enabled_backends]: antigravity-cli, builtin-pi"), true);
    assert.equal(decision.decision, "ticket");
    if (decision.decision === "ticket") {
      assert.equal(decision.backend, "antigravity-cli");
    }
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("BuiltinPiRunner marks failed on LLM error or timeout and records full trace steps/tokens", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-builtin-fail-"));
  const modelsToml = join(tempDir, "models.toml");
  writeFileSync(
    modelsToml,
    `[slots]
persona = "faux-worker/w1"
router = "faux-worker/w1"
curator = "faux-worker/w1"
worker = "faux-worker/w1"
hindsight_llm = "faux-worker/w1"

[providers]
`,
    "utf8",
  );

  const fauxWorker = fauxProvider({
    api: "hato-faux-worker-fail",
    provider: "faux-worker",
    models: [{ id: "w1", name: "W1" }],
    tokensPerSecond: 10_000,
  });

  const dbHandle = openDatabase(":memory:");
  try {
    const cfg = createDefaultHatoConfig();
    cfg.paths.workspaces_dir = join(tempDir, "workspaces");
    const repo = new HatoRepository(dbHandle.db);
    repo.ensureOwner({
      canonicalUserId: "owner",
      timezone: "Asia/Shanghai",
      proactiveChannel: "tg",
    });

    const registry = new ModelRegistry(modelsToml, repo, {
      extraProviders: [fauxWorker.provider],
    });
    const runner = new BuiltinPiRunner({
      getHatoConfig: () => cfg,
      modelRegistry: registry,
      proxyRouter: new ScopedProxyRouter([]),
      repo,
    });

    // 1. Non-retryable LLM error after an initial tool step must fail instead of returning "done"
    repo.createTicket({
      id: "t_err_1",
      canonicalUserId: "owner",
      status: "running",
      backend: "builtin-pi",
      briefTitle: "测试错误中断",
      originChannel: "web",
    });
    fauxWorker.setResponses([
      () => fauxAssistantMessage([fauxToolCall("run_command", { command: "echo hi" })], { stopReason: "toolUse" }),
      () =>
        fauxAssistantMessage("upstream rejected", {
          stopReason: "error",
          errorMessage: "400 INVALID_ARGUMENT: bad request",
        }),
    ]);

    const errRes = await runner.execute(
      {
        ticketId: "t_err_1",
        canonicalUserId: "owner",
        backend: "builtin-pi",
        briefTitle: "测试错误中断",
        contextId: "ctx_t_err_1",
        externalSessionId: null,
      },
      {
        workspace_mode: "isolated",
        workspace_dir: join(tempDir, "workspaces", "t_err_1"),
        is_host_repo: false,
        network: "egress",
        timeout_ms: 5000,
        skills: [],
        allowed_mcp_servers: [],
        confirm_before: [],
      },
    );

    assert.equal(errRes.status, "failed");
    assert.match(errRes.narration_hint, /400 INVALID_ARGUMENT/);
    assert.ok(errRes.trace);
    assert.deepEqual(errRes.trace.toolCalls, ["run_command"]);
    assert.ok(errRes.trace.steps.some((s) => s.kind === "tool" && s.name === "run_command"));

    // 2. Timeout abort must fail with timeout caveat instead of returning "done"
    repo.createTicket({
      id: "t_timeout_1",
      canonicalUserId: "owner",
      status: "running",
      backend: "builtin-pi",
      briefTitle: "测试超时中止",
      originChannel: "web",
    });
    fauxWorker.setResponses([
      () => fauxAssistantMessage([fauxToolCall("run_command", { command: "sleep 1" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("done"),
    ]);

    const timeoutRes = await runner.execute(
      {
        ticketId: "t_timeout_1",
        canonicalUserId: "owner",
        backend: "builtin-pi",
        briefTitle: "测试超时中止",
        contextId: "ctx_t_timeout_1",
        externalSessionId: null,
      },
      {
        workspace_mode: "isolated",
        workspace_dir: join(tempDir, "workspaces", "t_timeout_1"),
        is_host_repo: false,
        network: "egress",
        timeout_ms: 40,
        skills: [],
        allowed_mcp_servers: [],
        confirm_before: [],
      },
    );

    assert.equal(timeoutRes.status, "failed");
    assert.ok(timeoutRes.caveats.includes("timeout"));
    assert.match(timeoutRes.narration_hint, /超时/);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("NeutralRouter clips long messages, filters unavailable backends, and TicketCoordinator records backend as modelId", async () => {
  const cfg = createDefaultHatoConfig();
  cfg.worker.default_backend = "codex-cli";
  cfg.worker.external_cli.codex_cli = { enabled: true };
  cfg.worker.external_cli.opencode_v2 = { enabled: false };
  cfg.worker.external_cli.antigravity_cli = { enabled: false };
  cfg.worker.external_cli.external_pi = { enabled: false };
  cfg.worker.external_cli.claude_code = { enabled: false };

  const tempDir = mkdtempSync(join(tmpdir(), "hato-router-opt-"));
  const modelsToml = join(tempDir, "models.toml");
  writeFileSync(
    modelsToml,
    `[slots]
persona = "faux-router/r1"
router = "faux-router/r1"
curator = "faux-router/r1"
worker = "faux-router/r1"
hindsight_llm = "faux-router/r1"

[providers]
`,
    "utf8",
  );

  const fauxRouter = fauxProvider({
    api: "hato-faux-router-opt",
    provider: "faux-router",
    models: [{ id: "r1", name: "R1" }],
    tokensPerSecond: 10_000,
  });

  let capturedPrompt = "";
  fauxRouter.setResponses([
    (ctx) => {
      capturedPrompt = JSON.stringify(ctx.messages);
      return fauxAssistantMessage(
        JSON.stringify({
          decision: "ticket",
          backend: "codex-cli",
          brief_title: "测试裁剪与后端过滤",
          context_range: { from_msg_id: "m1", to_msg_id: "m1" },
          workspace_mode: "isolated",
        }),
      );
    },
  ]);

  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    repo.ensureOwner({
      canonicalUserId: "owner",
      timezone: "Asia/Shanghai",
      proactiveChannel: "qq",
    });
    repo.appendRawMessage({
      id: "m1",
      canonicalUserId: "owner",
      channel: "qq",
      role: "user",
      content: "HEAD_" + "X".repeat(2000) + "_TAIL",
      createdAt: Date.now(),
    });

    const registry = new ModelRegistry(modelsToml, repo, {
      extraProviders: [fauxRouter.provider],
    });
    const proxyRouter = new ScopedProxyRouter([]);
    const router = new NeutralRouter({
      getHatoConfig: () => cfg,
      getMcpConfig: () => ({ mcpServers: {} }),
      modelRegistry: registry,
      proxyRouter,
      repo,
      filterAvailableBackends: (backends) => backends.filter((b) => b !== "codex-cli"),
    });

    const decision = await router.routeDelegation({
      canonicalUserId: "owner",
      hint: "处理一下",
    });
    assert.equal(decision.decision, "ticket");
    if (decision.decision === "ticket") {
      assert.equal(decision.backend, "builtin-pi");
    }
    assert.ok(capturedPrompt.includes("截断"));
    assert.ok(capturedPrompt.indexOf("[routing_mode]") < capturedPrompt.indexOf("[delegate hint"));

    // Verify TicketCoordinator records backend ("codex-cli") rather than ticketId when workerTrace is absent
    const bus = new EventBus();
    const dispatcher = {
      dispatch: async () => ({
        ticket_id: "t_no_trace_1",
        status: "failed" as const,
        narration_hint: "binary missing",
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: ["ENOENT"],
      }),
      resume: async () => ({
        ticket_id: "t_no_trace_1",
        status: "done" as const,
        narration_hint: "ok",
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: [],
      }),
      abort: async () => false,
    };
    const coordinator = new TicketCoordinator({
      bus,
      repo,
      router,
      dispatcher: dispatcher as never,
      getHatoConfig: () => cfg,
    });

    repo.createTicket({
      id: "t_no_trace_1",
      canonicalUserId: "owner",
      status: "running",
      backend: "codex-cli",
      briefTitle: "测试 trace modelId",
      originChannel: "qq",
    });
    await (coordinator as unknown as {
      recordWorkerTrace: (p: {
        canonicalUserId: string;
        ticketId: string;
        backend: "codex-cli";
        briefTitle: string;
        mandate: { workspace_mode: "isolated"; workspace_dir: string };
        result: {
          ticket_id: string;
          status: "failed";
          narration_hint: string;
          verbatim_blocks: [];
          artifacts: [];
          required_secrets: [];
          caveats: string[];
        };
        latencyMs: number;
      }) => void;
    }).recordWorkerTrace({
      canonicalUserId: "owner",
      ticketId: "t_no_trace_1",
      backend: "codex-cli",
      briefTitle: "测试 trace modelId",
      mandate: { workspace_mode: "isolated", workspace_dir: tempDir },
      result: {
        ticket_id: "t_no_trace_1",
        status: "failed",
        narration_hint: "binary missing",
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: ["ENOENT"],
      },
      latencyMs: 120,
    });

    const traces = repo.listTurnTraces("owner", 10);
    const workerTrace = traces.find((t) => t.slot === "worker");
    assert.ok(workerTrace);
    assert.equal(workerTrace.modelId, "codex-cli");
    assert.notEqual(workerTrace.modelId, "t_no_trace_1");
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
