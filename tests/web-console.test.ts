import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { BrowserStatus, BrowserStreamEvent } from "../src/browser/controller.js";
import type { BrowserRuntime } from "../src/browser/runtime.js";
import { ActorLock } from "../src/bus/actor-bus.js";
import { loadHatoConfig } from "../src/config/app.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { readEnvMap, writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { CompactionManager } from "../src/memory/compaction.js";
import { PersonaRuntime } from "../src/persona/agent.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { fetchTelegramUserProfiles } from "../src/setup/probe.js";
import { LiveTraceTracker } from "../src/stats/live-trace.js";
import { WebConsoleServer } from "../src/web-console/server.js";

function parseSseFrames(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data:"))
    .map((chunk) => JSON.parse(chunk.slice(5).trim()) as Record<string, unknown>);
}

test("WebConsoleServer enforces auth, masks secrets, streams chat SSE, controls Xvfb browser, and serves static SPA", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-1", name: "Faux Persona" }],
    tokensPerSecond: 10000,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-web-console-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");
  const promptsDir = join(tempDir, "prompts");
  const envPath = join(tempDir, ".env");
  const staticDir = join(tempDir, "static");
  mkdirSync(promptsDir, { recursive: true });
  mkdirSync(staticDir, { recursive: true });

  writeFileSync(join(promptsDir, "soul.md"), "你是 Hato 测试人设", "utf8");
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><html><body>HATO_SPA_OK</body></html>", "utf8");

  const tokenEnvName = "HATO_TEST_WEB_TOKEN_XYZ";
  const secretToken = "console-secret-987654";
  const tgTokenEnv = "HATO_TEST_TG_SECRET_XYZ";
  const rawTgToken = "123456:super-secret-tg-token-9999";
  process.env[tokenEnvName] = secretToken;
  process.env[tgTokenEnv] = rawTgToken;
  writeFileSync(envPath, `${tokenEnvName}=${secretToken}\n${tgTokenEnv}=${rawTgToken}\n`, "utf8");

  const cfg = createDefaultHatoConfig();
  cfg.paths.prompts_dir = promptsDir;
  cfg.gateway.telegram.bot_token_env = tgTokenEnv;
  cfg.web = {
    ...cfg.web,
    console: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      auth_token_env: tokenEnvName,
    },
  };
  writeHatoConfig(hatoTomlPath, cfg, { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-persona-1"
router = "faux-provider/faux-persona-1"
curator = "faux-provider/faux-persona-1"
worker = "faux-provider/faux-persona-1"
hindsight_llm = "faux-provider/faux-persona-1"

[providers]
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  let currentConfig = loadHatoConfig(hatoTomlPath);
  const repo = new HatoRepository(dbHandle.db);
  let modelRegistry = new ModelRegistry(modelsTomlPath, repo, {
    extraProviders: [faux.provider],
  });
  let proxyRouter = new ScopedProxyRouter(currentConfig.network?.proxies ?? []);
  const actorLock = new ActorLock();
  const liveTraceTracker = new LiveTraceTracker();
  const runtime = new PersonaRuntime(currentConfig, modelRegistry, proxyRouter, repo);
  runtime.setLiveTraceTracker(liveTraceTracker);
  const compaction = new CompactionManager(repo, modelRegistry);

  const recordedMouse: unknown[] = [];
  const recordedKeyboard: unknown[] = [];
  let browserOpen = false;
  let pendingTakeover = true;
  let browserUrl = "https://example.com";
  let viewportSize = { width: 1280, height: 800 };
  const streamListeners = new Set<(event: BrowserStreamEvent) => void>();

  const fakeBrowserStatus = (): BrowserStatus & { busy: boolean } => ({
    open: browserOpen,
    pendingTakeover,
    takeoverReason: pendingTakeover ? "需要登录验证码" : null,
    displayMode: browserOpen ? "xvfb" : "closed",
    xvfbDisplay: browserOpen ? ":99" : null,
    proxyKey: "http://127.0.0.1:7890",
    url: browserOpen ? browserUrl : null,
    title: browserOpen ? "Test Xvfb Browser" : null,
    viewport: { ...viewportSize },
    tabs: browserOpen ? [{ index: 0, title: "Test Xvfb Browser", url: browserUrl, active: true }] : [],
    busy: false,
  });

  const fakeBrowserRuntime = {
    isPendingTakeover: () => pendingTakeover,
    isBusy: () => false,
    getInteractiveStatus: async () => fakeBrowserStatus(),
    openBrowser: async () => {
      browserOpen = true;
      return fakeBrowserStatus();
    },
    closeBrowser: async () => {
      browserOpen = false;
      pendingTakeover = false;
      return fakeBrowserStatus();
    },
    navigateManual: async (url: string) => {
      browserOpen = true;
      browserUrl = url;
      return fakeBrowserStatus();
    },
    goBackManual: async () => fakeBrowserStatus(),
    goForwardManual: async () => fakeBrowserStatus(),
    reloadManual: async () => fakeBrowserStatus(),
    newTabManual: async (url?: string) => {
      browserOpen = true;
      if (url) browserUrl = url;
      return fakeBrowserStatus();
    },
    switchTabManual: async () => fakeBrowserStatus(),
    closeTabManual: async () => fakeBrowserStatus(),
    resumeTakeover: async () => {
      pendingTakeover = false;
      return fakeBrowserStatus();
    },
    beginManualControl: async () => fakeBrowserStatus(),
    endManualControl: async () => fakeBrowserStatus(),
    resizeViewportManual: async (width: number, height: number) => {
      viewportSize = { width, height };
      return fakeBrowserStatus();
    },
    dispatchMouse: async (input: unknown) => {
      recordedMouse.push(input);
    },
    dispatchKeyboard: async (input: unknown) => {
      recordedKeyboard.push(input);
    },
    captureScreenshot: async () => (browserOpen ? Buffer.from("fake-jpeg") : null),
    subscribeStream: (listener: (event: BrowserStreamEvent) => void) => {
      streamListeners.add(listener);
      listener({ type: "status", status: fakeBrowserStatus() });
      listener({ type: "frame", dataUrl: "data:image/jpeg;base64,QUJD", width: 1280, height: 800 });
      return () => {
        streamListeners.delete(listener);
      };
    },
  } as unknown as BrowserRuntime;

  const reloadAll = async () => {
    currentConfig = loadHatoConfig(hatoTomlPath);
    modelRegistry.reload();
    proxyRouter.reload(currentConfig.network?.proxies ?? []);
    runtime.updateConfig(currentConfig);
    return {
      slots: modelRegistry.listSlots().map((s) => ({
        slot: s.slot,
        target: s.target,
        api: String(s.model.api),
        baseUrl: s.model.baseUrl,
      })),
      proxyCount: currentConfig.network?.proxies?.length ?? 0,
      changes: ["已测试触发热重载"],
    };
  };

  const server = new WebConsoleServer({
    hatoConfigPath: hatoTomlPath,
    modelsConfigPath: modelsTomlPath,
    envPath,
    staticDir,
    getConfig: () => currentConfig,
    getModelRegistry: () => modelRegistry,
    getProxyRouter: () => proxyRouter,
    getRepo: () => repo,
    getPersonaRuntime: () => runtime,
    getBrowserRuntime: () => fakeBrowserRuntime,
    getCompactionManager: () => compaction,
    getLiveTraceTracker: () => liveTraceTracker,
    getActorLock: () => actorLock,
    getSlashDeps: () => ({
      repo,
      listModelSlots: () =>
        modelRegistry.listSlots().map((s) => ({
          slot: s.slot,
          target: s.target,
          api: String(s.model.api),
          baseUrl: s.model.baseUrl,
        })),
      listAvailableModels: () => modelRegistry.listTargets(),
      setModelSlot: (slot, target) => {
        const updated = modelRegistry.setSlotOverride(slot as "persona", target);
        return {
          slot: updated.slot,
          target: updated.target,
          api: String(updated.model.api),
          baseUrl: updated.model.baseUrl,
        };
      },
      reloadAll: async () => reloadAll(),
      forceCompact: async (uid) => compaction.forceCompact(uid),
      resetContext: async (uid) => {
        runtime.resetSession();
        return repo.resetWorkingContext(uid);
      },
    }),
    reloadAll,
  });

  try {
    const addr = await server.start();
    assert.ok(addr && addr.port > 0);
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const authHeaders = { Authorization: `Bearer ${secretToken}` };

    // 1. Static SPA + Health
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /HATO_SPA_OK/);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.authRequired, true);
    assert.equal(healthJson.pendingTakeover, true);

    // 2. Auth guard + masked secrets
    const unauthRes = await fetch(`${baseUrl}/api/config`);
    assert.equal(unauthRes.status, 401);

    const cfgRes = await fetch(`${baseUrl}/api/config`, { headers: authHeaders });
    assert.equal(cfgRes.status, 200);
    const cfgRaw = await cfgRes.text();
    assert.equal(cfgRaw.includes(rawTgToken), false, "raw secret must never leak to frontend");
    const cfgJson = JSON.parse(cfgRaw) as {
      ok: boolean;
      promptText: string;
      secretStates: Array<{ key: string; configured: boolean; masked: string }>;
    };
    assert.equal(cfgJson.promptText, "你是 Hato 测试人设");
    const tgEntry = cfgJson.secretStates.find((s) => s.key === tgTokenEnv);
    assert.ok(tgEntry?.configured);
    assert.match(tgEntry.masked, /\*\*\*/);

    // 3. Prompt save + reload diff + layered prompt blocks / order / enable-disable
    const savePromptRes = await fetch(`${baseUrl}/api/config/prompt`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ promptText: "更新后的 Hato 人设" }),
    });
    const savePromptJson = (await savePromptRes.json()) as { ok: boolean; error?: string; changes?: string[] };
    assert.equal(savePromptJson.ok, true, savePromptJson.error ?? "savePrompt failed");
    assert.match(readFileSync(join(promptsDir, "soul.md"), "utf8"), /更新后的/);

    const addBlockRes = await fetch(`${baseUrl}/api/config/prompts/block`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "01-rules",
        content: "CUSTOM_RULE_BLOCK",
        enabled: true,
      }),
    });
    const addBlockJson = (await addBlockRes.json()) as {
      ok: boolean;
      promptLayers: {
        blocks: Array<{ name: string; content: string }>;
        combinedText: string;
      };
    };
    assert.equal(addBlockJson.ok, true);
    assert.equal(addBlockJson.promptLayers.blocks.some((b) => b.name === "01-rules.md"), true);
    assert.match(addBlockJson.promptLayers.combinedText, /CUSTOM_RULE_BLOCK/);

    const orderRes = await fetch(`${baseUrl}/api/config/prompts/order`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order: ["soul", "block:01-rules.md", "system"],
        disabled: ["block:01-rules.md"],
      }),
    });
    const orderJson = (await orderRes.json()) as {
      ok: boolean;
      promptLayers: { order: string[]; disabled: string[]; combinedText: string };
    };
    assert.equal(orderJson.ok, true);
    assert.deepEqual(orderJson.promptLayers.order, ["soul", "block:01-rules.md", "system"]);
    assert.deepEqual(orderJson.promptLayers.disabled, ["block:01-rules.md"]);
    assert.equal(orderJson.promptLayers.combinedText.includes("CUSTOM_RULE_BLOCK"), false);
    assert.match(orderJson.promptLayers.combinedText, /更新后的 Hato 人设/);

    const delBlockRes = await fetch(`${baseUrl}/api/config/prompts/block?name=01-rules.md`, {
      method: "DELETE",
      headers: authHeaders,
    });
    const delBlockJson = (await delBlockRes.json()) as {
      ok: boolean;
      promptLayers: { blocks: Array<{ name: string }>; order: string[] };
    };
    assert.equal(delBlockJson.ok, true);
    assert.equal(delBlockJson.promptLayers.blocks.length, 0);
    assert.equal(delBlockJson.promptLayers.order.includes("block:01-rules.md"), false);

    // 4. Secret update persists to .env without leaking back raw value
    const saveSecretRes = await fetch(`${baseUrl}/api/config/secrets`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ updates: { TAVILY_API_KEY: "tvly-new-secret-8888" } }),
    });
    assert.equal(saveSecretRes.status, 200);
    assert.equal(readEnvMap(envPath).TAVILY_API_KEY, "tvly-new-secret-8888");

    // 4b. Per-model hello greeting test endpoint
    faux.setResponses([() => fauxAssistantMessage("hello")]);
    const modelTestRes = await fetch(`${baseUrl}/api/config/models/test`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        providerSlug: "faux-provider",
        api: "hato-faux-api",
        baseUrl: "http://127.0.0.1:0/faux",
        model: {
          id: "faux-persona-1",
          name: "Faux Persona",
        },
      }),
    });
    assert.equal(modelTestRes.status, 200);
    const modelTestJson = (await modelTestRes.json()) as {
      ok: boolean;
      result: { ok: boolean; target: string; replyPreview?: string };
    };
    assert.equal(modelTestJson.ok, true);
    assert.equal(modelTestJson.result.ok, true);
    assert.equal(modelTestJson.result.target, "faux-provider/faux-persona-1");
    assert.equal(modelTestJson.result.replyPreview, "hello");

    // 5. Chat SSE (normal reply + slash command)
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("calc", { expression: "6 * 7" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("算出来了\n---\n答案是 42"),
    ]);

    const chatRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "6乘以7是多少" }),
    });
    assert.equal(chatRes.status, 200);
    const chatEvents = parseSseFrames(await chatRes.text());
    const assistantEvt = chatEvents.find((e) => e.type === "assistant_bubbles");
    assert.ok(assistantEvt);
    assert.deepEqual(assistantEvt.bubbles, ["算出来了", "答案是 42"]);

    const slashRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/trace" }),
    });
    const slashEvents = parseSseFrames(await slashRes.text());
    assert.equal(slashEvents.some((e) => e.type === "slash_reply"), true);

    const historyRes = await fetch(`${baseUrl}/api/chat/history`, { headers: authHeaders });
    assert.equal(historyRes.status, 200);
    const historyJson = (await historyRes.json()) as {
      ok: boolean;
      messages: Array<{ role: string; createdAt: number; content: string; bubbles?: string[] }>;
    };
    assert.equal(historyJson.ok, true);
    const lastAssistant = [...historyJson.messages].reverse().find((m) => m.role === "assistant");
    assert.ok(lastAssistant);
    assert.equal(typeof lastAssistant.createdAt, "number");
    assert.ok(lastAssistant.createdAt > 0);
    assert.deepEqual(lastAssistant.bubbles, ["算出来了", "答案是 42"]);

    const staticsRes = await fetch(`${baseUrl}/api/statics`, { headers: authHeaders });
    assert.equal(staticsRes.status, 200);
    const staticsJson = (await staticsRes.json()) as {
      ok: boolean;
      traces: Array<{ stepsJson?: string }>;
    };
    assert.equal(staticsJson.ok, true);
    assert.ok(staticsJson.traces[0]?.stepsJson);
    const parsedSteps = JSON.parse(staticsJson.traces[0]!.stepsJson!) as Array<{
      kind: string;
      text?: string;
      name?: string;
      args?: unknown;
      output?: string;
    }>;
    assert.ok(parsedSteps.some((s) => s.kind === "tool" && s.name === "calc" && JSON.stringify(s.args).includes("6 * 7") && (s.output ?? "").includes("42")));
    assert.ok(parsedSteps.some((s) => s.kind === "assistant" && (s.text ?? "").includes("答案是 42")));

    // 5b. /new clears both chat context and active-session trajectory/statics
    const newRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/new" }),
    });
    assert.equal(newRes.status, 200);
    const staticsAfterNew = (await (await fetch(`${baseUrl}/api/statics`, { headers: authHeaders })).json()) as {
      ok: boolean;
      summary: { turns: number };
      traces: unknown[];
    };
    assert.equal(staticsAfterNew.ok, true);
    assert.equal(staticsAfterNew.traces.length, 0);
    assert.equal(staticsAfterNew.summary.turns, 0);

    // 5c. Archived session appears in /api/sessions and supports read-only chat + statics lookup
    const sessionsRes = await fetch(`${baseUrl}/api/sessions`, { headers: authHeaders });
    assert.equal(sessionsRes.status, 200);
    const sessionsJson = (await sessionsRes.json()) as {
      ok: boolean;
      sessions: Array<{ id: string; title: string; messageCount: number; traceCount: number }>;
    };
    assert.equal(sessionsJson.ok, true);
    assert.equal(sessionsJson.sessions.length, 1);
    const archived = sessionsJson.sessions[0]!;
    assert.match(archived.title, /6乘以7是多少/);
    assert.equal(archived.messageCount, 2);
    assert.equal(archived.traceCount, 1);

    const archivedHistoryJson = (await (
      await fetch(`${baseUrl}/api/chat/history?sessionId=${encodeURIComponent(archived.id)}`, {
        headers: authHeaders,
      })
    ).json()) as { ok: boolean; readonly: boolean; messages: Array<{ content: string }> };
    assert.equal(archivedHistoryJson.ok, true);
    assert.equal(archivedHistoryJson.readonly, true);
    assert.equal(archivedHistoryJson.messages.length, 2);

    const archivedStaticsJson = (await (
      await fetch(`${baseUrl}/api/statics?sessionId=${encodeURIComponent(archived.id)}`, {
        headers: authHeaders,
      })
    ).json()) as { ok: boolean; summary: { turns: number }; traces: unknown[] };
    assert.equal(archivedStaticsJson.ok, true);
    assert.equal(archivedStaticsJson.summary.turns, 1);
    assert.equal(archivedStaticsJson.traces.length, 1);

    // 6. Xvfb browser remote control endpoints (action, input, screenshot, SSE stream)
    const openRes = await fetch(`${baseUrl}/api/browser/action`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open", url: "https://hato.test/login" }),
    });
    const openJson = (await openRes.json()) as { ok: boolean; status: BrowserStatus };
    assert.equal(openJson.ok, true);
    assert.equal(openJson.status.open, true);
    assert.equal(openJson.status.displayMode, "xvfb");
    assert.equal(openJson.status.xvfbDisplay, ":99");
    assert.equal(openJson.status.url, "https://hato.test/login");

    const mouseRes = await fetch(`${baseUrl}/api/browser/input`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "mouse", action: "click", x: 320, y: 240, button: "left" }),
    });
    assert.equal(mouseRes.status, 200);

    const kbRes = await fetch(`${baseUrl}/api/browser/input`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "keyboard", action: "insertText", text: "hello" }),
    });
    assert.equal(kbRes.status, 200);
    assert.equal(recordedMouse.length, 1);
    assert.equal(recordedKeyboard.length, 1);

    const shotRes = await fetch(`${baseUrl}/api/browser/screenshot`, { headers: authHeaders });
    assert.equal(shotRes.status, 200);
    assert.equal(shotRes.headers.get("content-type"), "image/jpeg");

    const streamCtrl = new AbortController();
    const streamRes = await fetch(`${baseUrl}/api/browser/stream`, {
      headers: authHeaders,
      signal: streamCtrl.signal,
    });
    assert.equal(streamRes.status, 200);
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let decoded = "";
    while (!(decoded.includes('"type":"status"') && decoded.includes('"type":"frame"'))) {
      const nextChunk = await reader.read();
      if (nextChunk.done) break;
      decoded += decoder.decode(nextChunk.value, { stream: true });
    }
    streamCtrl.abort();
    assert.match(decoded, /"type":"status"/);
    assert.match(decoded, /"type":"frame"/);

    const resizeRes = await fetch(`${baseUrl}/api/browser/action`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resize", width: 1680, height: 960 }),
    });
    const resizeJson = (await resizeRes.json()) as { ok: boolean; status: BrowserStatus };
    assert.deepEqual(resizeJson.status.viewport, { width: 1680, height: 960 });

    const takeoverRes = await fetch(`${baseUrl}/api/browser/action`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "takeover" }),
    });
    assert.equal(takeoverRes.status, 200);

    const resumeRes = await fetch(`${baseUrl}/api/browser/action`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume_takeover" }),
    });
    const resumeJson = (await resumeRes.json()) as { ok: boolean; status: BrowserStatus };
    assert.equal(resumeJson.status.pendingTakeover, false);

    const cliProbeRes = await fetch(`${baseUrl}/api/worker/cli-probe`, {
      headers: authHeaders,
    });
    assert.equal(cliProbeRes.status, 200);
    const cliProbeJson = (await cliProbeRes.json()) as {
      ok: boolean;
      hatoOnlyScope: boolean;
      probes: Array<{ backend: string }>;
    };
    assert.equal(cliProbeJson.ok, true);
    assert.equal(cliProbeJson.hatoOnlyScope, true);
    assert.deepEqual(
      cliProbeJson.probes.map((p) => p.backend),
      ["codex-cli", "antigravity-cli", "opencode-v2", "external-pi", "claude-code"],
    );

    repo.createTicket({
      id: "t_web_1",
      canonicalUserId: "owner",
      status: "running",
      backend: "opencode-v2",
      briefTitle: "查天气 Python 脚本",
      originChannel: "web",
      progressNote: "正在编写脚本",
    });
    const ticketsRes = await fetch(`${baseUrl}/api/tickets`, { headers: authHeaders });
    assert.equal(ticketsRes.status, 200);
    const ticketsJson = (await ticketsRes.json()) as {
      ok: boolean;
      tickets: Array<{ id: string; status: string; backend: string; originChannel: string }>;
    };
    assert.equal(ticketsJson.ok, true);
    assert.equal(ticketsJson.tickets.length, 1);
    assert.equal(ticketsJson.tickets[0]?.id, "t_web_1");
    assert.equal(ticketsJson.tickets[0]?.originChannel, "web");

    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "web",
      role: "executed_event",
      content: "[工单 t_web_1 · 查天气 Python 脚本] (done): 内部执行日志",
      createdAt: Date.now() + 100,
    });
    const historyAfterTicketRes = await fetch(`${baseUrl}/api/chat/history`, { headers: authHeaders });
    const historyAfterTicketJson = (await historyAfterTicketRes.json()) as {
      ok: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(historyAfterTicketJson.ok, true);
    assert.equal(
      historyAfterTicketJson.messages.some((m) => m.content.includes("内部执行日志")),
      false,
    );

    // Verify /api/traces/stream emits snapshot, live active_update (filtered by uid), and trace_inserted
    const traceEventsReceived: string[] = [];
    const repoSubEvents: string[] = [];
    const unsubRepo = repo.subscribeTurnTrace((info) => repoSubEvents.push(info.id));

    const traceStreamCtrl = new AbortController();
    const traceStreamRes = await fetch(`${baseUrl}/api/traces/stream`, {
      headers: authHeaders,
      signal: traceStreamCtrl.signal,
    });
    assert.equal(traceStreamRes.status, 200);
    const traceReader = traceStreamRes.body!.getReader();
    const traceDecoder = new TextDecoder();
    let traceDecoded = "";

    const firstTraceChunk = await traceReader.read();
    traceDecoded += traceDecoder.decode(firstTraceChunk.value, { stream: true });
    assert.match(traceDecoded, /"type":"snapshot"/);

    liveTraceTracker.start({
      id: "live_test_1",
      canonicalUserId: "owner",
      slot: "worker",
      provider: "faux",
      modelId: "w1",
      api: "hato-faux",
      userPreview: "实时运行测试",
      startedAt: Date.now(),
      progressNote: "正在执行工具",
    });
    liveTraceTracker.start({
      id: "live_other_user",
      canonicalUserId: "someone_else",
      slot: "worker",
      provider: "faux",
      modelId: "w1",
      api: "hato-faux",
      userPreview: "不应泄漏给当前用户",
      startedAt: Date.now(),
    });
    liveTraceTracker.finish("live_test_1");
    liveTraceTracker.finish("live_other_user");

    const insertedTraceId = repo.insertTurnTrace({
      canonicalUserId: "owner",
      slot: "worker",
      provider: "builtin-pi",
      modelId: "w1",
      api: "hato-faux",
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      userPreview: "完成测试",
      recalledIds: [],
      timeCardText: "ok",
      toolCalls: ["run_command"],
      steps: [],
      latencyMs: 42,
    });

    while (
      !(
        traceDecoded.includes('"type":"active_update"') &&
        traceDecoded.includes('"type":"trace_inserted"')
      )
    ) {
      const next = await traceReader.read();
      if (next.done) break;
      traceDecoded += traceDecoder.decode(next.value, { stream: true });
    }
    traceStreamCtrl.abort();
    unsubRepo();

    for (const frame of parseSseFrames(traceDecoded)) {
      traceEventsReceived.push(String(frame.type));
    }
    assert.ok(traceEventsReceived.includes("snapshot"));
    assert.ok(traceEventsReceived.includes("active_update"));
    assert.ok(traceEventsReceived.includes("trace_inserted"));
    assert.equal(traceDecoded.includes("不应泄漏给当前用户"), false);
    assert.ok(traceDecoded.includes(insertedTraceId));
    assert.deepEqual(repoSubEvents, [insertedTraceId]);
  } finally {
    delete process.env[tokenEnvName];
    delete process.env[tgTokenEnv];
    await server.stop();
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fetchTelegramUserProfiles fetches displayName, username, and avatarDataUrl via Bot API", async () => {
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const mockTg = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/botMOCK_TOKEN/getChat?")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            id: 123456789,
            first_name: "Alice",
            last_name: "Hato",
            username: "alice_hato",
            photo: { small_file_id: "file_small_1" },
          },
        }),
      );
      return;
    }
    if (url.startsWith("/botMOCK_TOKEN/getFile?file_id=file_small_1")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { file_path: "photos/avatar.png" } }));
      return;
    }
    if (url === "/file/botMOCK_TOKEN/photos/avatar.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(tinyPng);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, description: "Not found" }));
  });

  await new Promise<void>((resolveListen) => mockTg.listen(0, "127.0.0.1", () => resolveListen()));
  const addr = mockTg.address() as { port: number };
  const proxyRouter = new ScopedProxyRouter([]);

  try {
    const profiles = await fetchTelegramUserProfiles({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      botToken: "MOCK_TOKEN",
      userIds: ["123456789", "123456789"],
      proxyRouter,
    });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.ok, true);
    assert.equal(profiles[0]?.displayName, "Alice Hato");
    assert.equal(profiles[0]?.username, "alice_hato");
    assert.equal(profiles[0]?.avatarDataUrl, `data:image/png;base64,${tinyPng.toString("base64")}`);

    const noToken = await fetchTelegramUserProfiles({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      botToken: "",
      userIds: ["123456789"],
      proxyRouter,
    });
    assert.equal(noToken[0]?.ok, false);
    assert.match(noToken[0]?.error ?? "", /Bot Token/);
  } finally {
    await new Promise<void>((resolveClose) => mockTg.close(() => resolveClose()));
  }
});

test("WebConsoleServer manages slot thinking levels via GET /api/chat/history, PUT /api/config/thinking, GET /api/config, and PUT /api/config/models", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-web-thinking-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");
  const promptsDir = join(tempDir, "prompts");
  const envPath = join(tempDir, ".env");
  const staticDir = join(tempDir, "static");
  mkdirSync(promptsDir, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(promptsDir, "soul.md"), "你是 Hato", "utf8");
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><html><body>OK</body></html>", "utf8");

  const tokenEnvName = "HATO_TEST_WEB_THINK_TOKEN";
  const secretToken = "think-secret-1234";
  process.env[tokenEnvName] = secretToken;
  writeFileSync(envPath, `${tokenEnvName}=${secretToken}\n`, "utf8");

  const cfg = createDefaultHatoConfig();
  cfg.paths.prompts_dir = promptsDir;
  cfg.web = {
    ...cfg.web,
    console: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      auth_token_env: tokenEnvName,
    },
  };
  writeHatoConfig(hatoTomlPath, cfg, { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "relay/m1"
router = "relay/m1"
curator = "relay/m1"
worker = "relay/m1"
hindsight_llm = "relay/m1"

[providers.relay]
api = "openai-completions"
base_url = "https://relay.example.com/v1"

[[providers.relay.models]]
id = "m1"
name = "Relay Reasoning"
reasoning = true
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  let currentConfig = loadHatoConfig(hatoTomlPath);
  const repo = new HatoRepository(dbHandle.db);
  const modelRegistry = new ModelRegistry(modelsTomlPath, repo);
  const proxyRouter = new ScopedProxyRouter(currentConfig.network?.proxies ?? []);
  const actorLock = new ActorLock();
  const liveTraceTracker = new LiveTraceTracker();
  const runtime = new PersonaRuntime(currentConfig, modelRegistry, proxyRouter, repo);
  const compaction = new CompactionManager(repo, modelRegistry);
  const fakeBrowserRuntime = {
    isPendingTakeover: () => false,
    isBusy: () => false,
  } as unknown as BrowserRuntime;

  const reloadAll = async () => {
    currentConfig = loadHatoConfig(hatoTomlPath);
    modelRegistry.reload();
    proxyRouter.reload(currentConfig.network?.proxies ?? []);
    runtime.updateConfig(currentConfig);
    return {
      slots: modelRegistry.listSlots().map((s) => ({
        slot: s.slot,
        target: s.target,
        api: String(s.model.api),
        baseUrl: s.model.baseUrl,
      })),
      proxyCount: currentConfig.network?.proxies?.length ?? 0,
      changes: [],
    };
  };

  const server = new WebConsoleServer({
    hatoConfigPath: hatoTomlPath,
    modelsConfigPath: modelsTomlPath,
    envPath,
    staticDir,
    getConfig: () => currentConfig,
    getModelRegistry: () => modelRegistry,
    getProxyRouter: () => proxyRouter,
    getRepo: () => repo,
    getPersonaRuntime: () => runtime,
    getBrowserRuntime: () => fakeBrowserRuntime,
    getCompactionManager: () => compaction,
    getLiveTraceTracker: () => liveTraceTracker,
    getActorLock: () => actorLock,
    getSlashDeps: () => ({
      repo,
      listModelSlots: () => [],
      listAvailableModels: () => modelRegistry.listTargets(),
      setModelSlot: () => ({ slot: "persona", target: "relay/m1", api: "openai-completions", baseUrl: "" }),
      reloadAll: async () => reloadAll(),
      forceCompact: async (uid) => compaction.forceCompact(uid),
      resetContext: async (uid) => repo.resetWorkingContext(uid),
    }),
    reloadAll,
  });

  try {
    const addr = await server.start();
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const authHeaders = {
      Authorization: `Bearer ${secretToken}`,
      "Content-Type": "application/json",
    };

    const histRes = await fetch(`${baseUrl}/api/chat/history`, { headers: authHeaders });
    assert.equal(histRes.status, 200);
    const histBody = (await histRes.json()) as {
      slots: Array<{ slot: string; thinkingLevel?: string; reasoning?: boolean }>;
    };
    const personaSlot = histBody.slots.find((s) => s.slot === "persona");
    assert.equal(personaSlot?.reasoning, true);
    assert.equal(personaSlot?.thinkingLevel, "medium");

    // PUT /api/config/thinking updates slot thinking override
    const setRes = await fetch(`${baseUrl}/api/config/thinking`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ slot: "persona", level: "high" }),
    });
    assert.equal(setRes.status, 200);
    const setBody = (await setRes.json()) as {
      ok: boolean;
      effective: string;
      slots: Array<{ slot: string; thinkingLevel?: string }>;
    };
    assert.equal(setBody.effective, "high");
    assert.equal(setBody.slots.find((s) => s.slot === "persona")?.thinkingLevel, "high");

    // Invalid slot or level rejected with 400
    const badRes = await fetch(`${baseUrl}/api/config/thinking`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ slot: "persona", level: "bogus" }),
    });
    assert.equal(badRes.status, 400);

    // GET /api/config exposes effective slot_thinking
    const cfgRes = await fetch(`${baseUrl}/api/config`, { headers: authHeaders });
    assert.equal(cfgRes.status, 200);
    const cfgBody = (await cfgRes.json()) as {
      modelsConfig: {
        slots: Record<string, string>;
        slot_thinking?: Record<string, string>;
        providers: Record<string, unknown>;
      };
    };
    assert.equal(cfgBody.modelsConfig.slot_thinking?.persona, "high");

    // PUT /api/config/models persists [slot_thinking] and clears runtime overrides
    const putModelsRes = await fetch(`${baseUrl}/api/config/models`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        config: {
          ...cfgBody.modelsConfig,
          slot_thinking: { persona: "low" },
        },
      }),
    });
    assert.equal(putModelsRes.status, 200);
    assert.equal(modelRegistry.resolveSlotThinkingLevel("persona"), "low");

    const cfgAfterRes = await fetch(`${baseUrl}/api/config`, { headers: authHeaders });
    const cfgAfterBody = (await cfgAfterRes.json()) as {
      modelsConfig: { slot_thinking?: Record<string, string> };
    };
    assert.equal(cfgAfterBody.modelsConfig.slot_thinking?.persona, "low");
  } finally {
    delete process.env[tokenEnvName];
    await server.stop();
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
