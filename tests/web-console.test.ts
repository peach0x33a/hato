import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  writeFileSync(join(promptsDir, "persona.md"), "你是 Hato 测试人设", "utf8");
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
  const runtime = new PersonaRuntime(currentConfig, modelRegistry, proxyRouter, repo);
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

    // 3. Prompt save + reload diff
    const savePromptRes = await fetch(`${baseUrl}/api/config/prompt`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ promptText: "更新后的 Hato 人设" }),
    });
    const savePromptJson = (await savePromptRes.json()) as { ok: boolean; error?: string; changes?: string[] };
    assert.equal(savePromptJson.ok, true, savePromptJson.error ?? "savePrompt failed");
    assert.match(readFileSync(join(promptsDir, "persona.md"), "utf8"), /更新后的/);

    // 4. Secret update persists to .env without leaking back raw value
    const saveSecretRes = await fetch(`${baseUrl}/api/config/secrets`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ updates: { TAVILY_API_KEY: "tvly-new-secret-8888" } }),
    });
    assert.equal(saveSecretRes.status, 200);
    assert.equal(readEnvMap(envPath).TAVILY_API_KEY, "tvly-new-secret-8888");

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
  } finally {
    delete process.env[tokenEnvName];
    delete process.env[tgTokenEnv];
    await server.stop();
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
