import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { EventBus } from "../src/bus/actor-bus.js";
import { loadHatoConfig } from "../src/config/app.js";
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
    assert.equal(emittedResults[0]!.artifacts.length, 1);
    const artifactPath = emittedResults[0]!.artifacts[0]!.path;
    assert.equal(existsSync(artifactPath), true);
    assert.match(readFileSync(artifactPath, "utf8"), /Hello Hato/);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
