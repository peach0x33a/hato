import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  BROWSER_PROXY_SCOPE,
  formatBrowserSnapshotText,
  type BrowserController,
  type BrowserPageSnapshot,
} from "../src/browser/controller.js";
import {
  buildBrowserLaunchArgs,
  parsePlaywrightProxy,
  prepareDisplayAndHeadless,
  resolveBrowserLaunchCandidates,
} from "../src/browser/platform.js";
import { BrowserRuntime } from "../src/browser/runtime.js";
import { resolveWebBrowserConfig } from "../src/config/app.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("parsePlaywrightProxy parses direct, HTTP, and authenticated SOCKS5 proxy rules", () => {
  assert.equal(parsePlaywrightProxy({ mode: "direct", matchedScope: null }), undefined);

  assert.deepEqual(
    parsePlaywrightProxy({
      mode: "proxy",
      url: "http://127.0.0.1:19270",
      matchedScope: "browser",
    }),
    { server: "http://127.0.0.1:19270" },
  );

  assert.deepEqual(
    parsePlaywrightProxy({
      mode: "proxy",
      url: "socks5://alice:s%40cret@proxy.example.com:1080",
      matchedScope: "browser",
    }),
    {
      server: "socks5://proxy.example.com:1080",
      username: "alice",
      password: "s@cret",
    },
  );

  assert.equal(BROWSER_PROXY_SCOPE, "browser");
  const isolatedRouter = new ScopedProxyRouter([
    { name: "web-only", url: "http://127.0.0.1:19270", scope: ["web_access"] },
  ]);
  assert.equal(isolatedRouter.resolveScope(BROWSER_PROXY_SCOPE).mode, "direct");

  const browserRouter = new ScopedProxyRouter([
    { name: "web-only", url: "http://127.0.0.1:19270", scope: ["web_access"] },
    { name: "browser-only", url: "socks5://127.0.0.1:1080", scope: ["browser"] },
  ]);
  assert.deepEqual(browserRouter.resolveScope(BROWSER_PROXY_SCOPE), {
    mode: "proxy",
    url: "socks5://127.0.0.1:1080",
    matchedScope: "browser",
  });
});

test("resolveBrowserLaunchCandidates and prepareDisplayAndHeadless support Windows, macOS, and Linux", async () => {
  const winCandidates = resolveBrowserLaunchCandidates({
    config: { channel: "chrome" },
    platform: "win32",
    env: {
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
    },
    existsFn: (p) => p.includes("Google\\Chrome") || p.includes("msedge.exe"),
  });
  assert.ok(winCandidates.some((c) => c.channel === "chrome"));
  assert.ok(winCandidates.some((c) => c.executablePath?.endsWith("chrome.exe")));
  assert.equal(winCandidates.some((c) => c.channel === "msedge" || c.executablePath?.includes("Edge")), false);

  const macCandidates = resolveBrowserLaunchCandidates({
    config: { channel: "chrome", executablePath: "/custom/chrome" },
    platform: "darwin",
    existsFn: () => false,
  });
  assert.equal(macCandidates[0]?.executablePath, "/custom/chrome");
  assert.equal(macCandidates[1]?.channel, "chrome");

  const linuxCandidates = resolveBrowserLaunchCandidates({
    config: { channel: "chrome" },
    platform: "linux",
    findCommandFn: (cmd) => (cmd === "google-chrome" ? "/usr/bin/google-chrome" : null),
  });
  assert.ok(linuxCandidates.some((c) => c.executablePath === "/usr/bin/google-chrome"));

  const winDisplay = await prepareDisplayAndHeadless({
    config: { headless: "auto", xvfb: "auto" },
    platform: "win32",
  });
  assert.equal(winDisplay.headless, false);

  const linuxWithDisplay = await prepareDisplayAndHeadless({
    config: { headless: "auto", xvfb: "auto" },
    platform: "linux",
    env: { DISPLAY: ":0" },
  });
  assert.equal(linuxWithDisplay.headless, false);

  assert.ok(buildBrowserLaunchArgs("darwin").includes("--disable-blink-features=AutomationControlled"));
  assert.ok(buildBrowserLaunchArgs("linux").includes("--disable-dev-shm-usage"));
});

test("BrowserRuntime executes isolated tasks, sends takeover screenshots, and resumes cleanly", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-browser-runtime-"));
  const modelsToml = join(tempDir, "models.toml");

  try {
    writeFileSync(
      modelsToml,
      `
[slots]
persona = "faux/faux-model"
router = "faux/faux-model"
curator = "faux/faux-model"
worker = "faux/faux-model"
hindsight_llm = "faux/faux-model"

[providers.placeholder]
api = "openai-completions"
base_url = "https://example.invalid/v1"

[[providers.placeholder.models]]
id = "unused"
name = "Unused"
`,
      "utf8",
    );

    const faux = fauxProvider({
      api: "hato-faux-browser-api",
      providerId: "faux-browser",
      models: [
        {
          id: "faux-model",
          name: "Faux Browser Model",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 1024,
        },
      ],
      tokensPerSecond: 10000,
    });

    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("browser_navigate", { url: "https://example.com/login" }, { id: "c1" })],
          { stopReason: "toolUse" },
        ),
      () =>
        fauxAssistantMessage(
          [fauxToolCall("browser_request_takeover", { reason: "需要扫码登录" }, { id: "c2" })],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("已暂停等待扫码登录。", { stopReason: "stop" }),
      () =>
        fauxAssistantMessage([fauxToolCall("browser_snapshot", {}, { id: "c3" })], {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("登录后查看余额成功：100 元。", { stopReason: "stop" }),
    ]);

    const registry = new ModelRegistry(modelsToml, undefined, { extraProviders: [faux.provider] });
    const hatoCfg = createDefaultHatoConfig();
    const proxyRouter = new ScopedProxyRouter([]);

    let pendingTakeover: string | null = null;
    let loggedIn = false;
    const sentPhotos: Array<{ bytes: number; caption?: string }> = [];

    const fakeSnapshot = (): BrowserPageSnapshot => ({
      url: loggedIn ? "https://example.com/dashboard" : "https://example.com/login",
      title: loggedIn ? "Dashboard" : "Login",
      elements: loggedIn
        ? [{ ref: "e1", tag: "button", label: "刷新" }]
        : [{ ref: "e1", tag: "button", label: "扫码登录" }],
      bodyText: loggedIn ? "欢迎回来，余额 100 元" : "请扫码登录",
    });

    assert.ok(formatBrowserSnapshotText(fakeSnapshot()).includes("[e1] button"));

    const fakeController = {
      isPendingTakeover: () => pendingTakeover !== null,
      setPendingTakeover: (r: string) => {
        pendingTakeover = r;
      },
      clearPendingTakeover: () => {
        pendingTakeover = null;
      },
      navigate: async () => fakeSnapshot(),
      snapshot: async () => fakeSnapshot(),
      screenshot: async () => Buffer.from("fake-png-bytes"),
      getCurrentPageInfo: async () => ({
        url: fakeSnapshot().url,
        title: fakeSnapshot().title,
      }),
      dispose: async () => undefined,
    } as unknown as BrowserController;

    const runtime = new BrowserRuntime(hatoCfg, registry, proxyRouter, fakeController);

    // 1. Hits takeover and pushes screenshot to Telegram callback.
    const res1 = await runtime.runTask(
      { goal: "打开示例站看看余额", startUrl: "https://example.com/login" },
      {
        sendPhotoToUser: async (photo, caption) => {
          sentPhotos.push({ bytes: photo.byteLength, caption });
        },
      },
    );
    assert.equal(res1.status, "needs_takeover");
    assert.equal(res1.sentScreenshot, true);
    assert.equal(sentPhotos.length, 1);
    assert.ok(sentPhotos[0]?.caption?.includes("需要扫码登录"));
    assert.equal(runtime.isPendingTakeover(), true);

    // 2. User logs in & resumes on the existing open session.
    loggedIn = true;
    const res2 = await runtime.runTask({ goal: "继续查看余额", resume: true });
    assert.equal(res2.status, "completed");
    assert.equal(runtime.isPendingTakeover(), false);
    assert.ok(res2.summary.includes("100"));

    // Verify default resolved browser config values.
    assert.equal(resolveWebBrowserConfig(hatoCfg).idleTimeoutMinutes, 5);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
