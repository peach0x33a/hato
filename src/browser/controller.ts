import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import type { ResolvedWebBrowserConfig } from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { assertSafeResolvedHost, validateFetchUrl } from "../persona/web-fetch.js";
import { logInfo, logWarn, summarizeError } from "../utils/logger.js";
import {
  buildBrowserLaunchArgs,
  parsePlaywrightProxy,
  prepareDisplayAndHeadless,
  resolveBrowserLaunchCandidates,
  type XvfbSession,
} from "./platform.js";

export interface BrowserElementEntry {
  ref: string;
  tag: string;
  type?: string;
  role?: string;
  label: string;
  value?: string;
  href?: string;
}

export interface BrowserPageSnapshot {
  url: string;
  title: string;
  elements: BrowserElementEntry[];
  bodyText: string;
}

export interface BrowserTabInfo {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserStatus {
  open: boolean;
  pendingTakeover: boolean;
  takeoverReason: string | null;
  displayMode: "xvfb" | "headed" | "headless" | "closed";
  xvfbDisplay: string | null;
  proxyKey: string | null;
  url: string | null;
  title: string | null;
  viewport: { width: number; height: number };
  tabs: BrowserTabInfo[];
}

export interface BrowserMouseInput {
  action: "move" | "down" | "up" | "click" | "dblclick" | "wheel";
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  deltaX?: number;
  deltaY?: number;
}

export interface BrowserKeyboardInput {
  action: "press" | "down" | "up" | "insertText";
  key?: string;
  text?: string;
}

export type BrowserStreamEvent =
  | { type: "status"; status: BrowserStatus }
  | { type: "frame"; dataUrl: string; width: number; height: number };

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export const BROWSER_PROXY_SCOPE = "browser";
const MAX_SNAPSHOT_ELEMENTS = 80;
const MAX_SNAPSHOT_TEXT_CHARS = 3_500;

const INIT_STEALTH_SCRIPT = `(() => {
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  } catch {}
})();`;

// Kept as pure JS string to avoid tsx/esbuild __name helper injection inside page.evaluate.
const SNAPSHOT_PAGE_SCRIPT = `((opts) => {
  const maxElements = opts.maxElements;
  const maxTextChars = opts.maxTextChars;
  const selector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='tab']",
    "[role='menuitem']",
    "[contenteditable='true']"
  ].join(",");

  document.querySelectorAll("[data-hato-ref]").forEach((el) => el.removeAttribute("data-hato-ref"));

  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };

  const clean = (val, maxLen) =>
    String(val || "").replace(/\\s+/g, " ").trim().slice(0, maxLen || 80);

  const elements = [];
  const seen = new Set();
  const nodes = document.querySelectorAll(selector);
  for (const el of nodes) {
    if (elements.length >= maxElements) break;
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);

    const ref = "e" + (elements.length + 1);
    el.setAttribute("data-hato-ref", ref);

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || undefined;
    const type = tag === "input" ? (el.getAttribute("type") || "text") : undefined;
    const aria = el.getAttribute("aria-label");
    const placeholder = el.getAttribute("placeholder");
    const title = el.getAttribute("title");
    const alt = el.getAttribute("alt");
    const innerText = clean(el.innerText || el.textContent, 80);
    const label = clean(aria || innerText || placeholder || title || alt || tag, 80);

    let value;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (type === "password") {
        value = el.value ? "***" : "";
      } else {
        value = clean(el.value, 60);
      }
    }

    const href = tag === "a" ? clean(el.getAttribute("href"), 120) : undefined;
    elements.push({ ref, tag, type, role, label, value, href });
  }

  const rawBody = document.body ? (document.body.innerText || document.body.textContent || "") : "";
  const bodyText = String(rawBody)
    .replace(/[ \\t]+/g, " ")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim()
    .slice(0, maxTextChars);

  return {
    url: location.href,
    title: clean(document.title, 120),
    elements,
    bodyText,
  };
})`;

/**
 * Formats a compact, low-token page snapshot for the isolated Browser sub-agent.
 */
export function formatBrowserSnapshotText(snapshot: BrowserPageSnapshot): string {
  const lines: string[] = [
    `页面标题: ${snapshot.title || "(无标题)"}`,
    `当前 URL: ${snapshot.url}`,
    "",
    `可交互元素 (${snapshot.elements.length}):`,
  ];

  if (snapshot.elements.length === 0) {
    lines.push("  (未检测到可见可交互元素)");
  } else {
    for (const el of snapshot.elements) {
      const kind = el.type ? `${el.tag}[type=${el.type}]` : el.role ? `${el.tag}[role=${el.role}]` : el.tag;
      const extras: string[] = [];
      if (el.value !== undefined && el.value !== "") extras.push(`value="${el.value}"`);
      if (el.href) extras.push(`href="${el.href}"`);
      lines.push(`  [${el.ref}] ${kind} "${el.label}"${extras.length ? ` (${extras.join(", ")})` : ""}`);
    }
  }

  lines.push("");
  lines.push("页面可见文本摘要:");
  lines.push(snapshot.bodyText || "(页面正文为空)");

  return lines.join("\n");
}

/**
 * Manages a persistent cross-platform Playwright Chrome context (macOS, Windows, Linux + Xvfb),
 * idle reaping, proxy scope binding, and takeover pause preservation.
 */
export class BrowserController {
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private xvfbSession: XvfbSession | null = null;
  private activeProxyKey = "";
  private activeDisplayMode: "xvfb" | "headed" | "headless" | "closed" = "closed";
  private activeDisplayEnv: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pendingTakeoverReason: string | null = null;
  private manualControl = false;
  private latestConfig: ResolvedWebBrowserConfig | null = null;
  private readonly streamListeners = new Set<(event: BrowserStreamEvent) => void>();
  private screencastSession: CDPSession | null = null;
  private screencastPage: Page | null = null;
  private screencastPollTimer: NodeJS.Timeout | null = null;
  private statusPollTimer: NodeJS.Timeout | null = null;
  private lastStatusJson = "";

  constructor(private readonly proxyRouter: ScopedProxyRouter) {}

  isPendingTakeover(): boolean {
    return this.pendingTakeoverReason !== null;
  }

  getPendingTakeoverReason(): string | null {
    return this.pendingTakeoverReason;
  }

  setPendingTakeover(reason: string): void {
    this.pendingTakeoverReason = reason.trim() || "等待用户接管";
    this.clearIdleTimer();
    void this.emitStatusUpdate();
  }

  clearPendingTakeover(): void {
    this.pendingTakeoverReason = null;
    if (this.latestConfig && !this.manualControl) {
      this.scheduleIdleReap(this.latestConfig);
    }
    void this.emitStatusUpdate();
  }

  setManualControl(active: boolean): void {
    this.manualControl = active;
    if (active) {
      this.clearIdleTimer();
    } else if (this.latestConfig && !this.isPendingTakeover()) {
      this.scheduleIdleReap(this.latestConfig);
    }
    void this.emitStatusUpdate();
  }

  async ensurePage(config: ResolvedWebBrowserConfig): Promise<Page> {
    this.latestConfig = config;
    const proxyRes = this.proxyRouter.resolveScope(BROWSER_PROXY_SCOPE);
    const playwrightProxy = parsePlaywrightProxy(proxyRes);
    const nextProxyKey = playwrightProxy
      ? `${playwrightProxy.server}|${playwrightProxy.username ?? ""}`
      : "direct";

    if (this.context && nextProxyKey !== this.activeProxyKey && !this.isPendingTakeover()) {
      await this.dispose();
    }

    if (!this.context) {
      await this.launchContext(config, playwrightProxy, nextProxyKey);
    }

    const page = await this.resolveActivePage();
    this.touchActivity(config);
    return page;
  }

  async navigate(config: ResolvedWebBrowserConfig, rawUrl: string): Promise<BrowserPageSnapshot> {
    const url = normalizeNavigationUrl(rawUrl);
    const page = await this.ensurePage(config);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.actionTimeoutMs,
    });
    await page.waitForTimeout(450);
    this.touchActivity(config);
    return this.readSnapshot(page);
  }

  async snapshot(config: ResolvedWebBrowserConfig): Promise<BrowserPageSnapshot> {
    const page = await this.ensurePage(config);
    this.touchActivity(config);
    return this.readSnapshot(page);
  }

  async click(config: ResolvedWebBrowserConfig, ref: string): Promise<BrowserPageSnapshot> {
    const page = await this.ensurePage(config);
    const locator = page.locator(`[data-hato-ref="${escapeAttrValue(ref)}"]`).first();
    await locator.waitFor({ state: "visible", timeout: Math.min(config.actionTimeoutMs, 6_000) });
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(120);
    await locator.click({ timeout: config.actionTimeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(450);
    const latestPage = await this.resolveActivePage();
    this.touchActivity(config);
    return this.readSnapshot(latestPage);
  }

  async type(
    config: ResolvedWebBrowserConfig,
    ref: string,
    text: string,
    opts?: { submit?: boolean; clear?: boolean },
  ): Promise<BrowserPageSnapshot> {
    const page = await this.ensurePage(config);
    const locator = page.locator(`[data-hato-ref="${escapeAttrValue(ref)}"]`).first();
    await locator.waitFor({ state: "visible", timeout: Math.min(config.actionTimeoutMs, 6_000) });
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: config.actionTimeoutMs });
    if (opts?.clear !== false) {
      await locator.fill("", { timeout: config.actionTimeoutMs }).catch(() => undefined);
    }
    await locator.fill(text, { timeout: config.actionTimeoutMs });
    if (opts?.submit) {
      await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    } else {
      await page.waitForTimeout(200);
    }
    const latestPage = await this.resolveActivePage();
    this.touchActivity(config);
    return this.readSnapshot(latestPage);
  }

  async scroll(
    config: ResolvedWebBrowserConfig,
    direction: "down" | "up",
    pixels = 640,
  ): Promise<BrowserPageSnapshot> {
    const page = await this.ensurePage(config);
    const delta = direction === "up" ? -Math.abs(pixels) : Math.abs(pixels);
    await page.evaluate(`window.scrollBy(0, ${delta})`);
    await page.waitForTimeout(300);
    this.touchActivity(config);
    return this.readSnapshot(page);
  }

  async back(config: ResolvedWebBrowserConfig): Promise<BrowserPageSnapshot> {
    const page = await this.ensurePage(config);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: config.actionTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(350);
    this.touchActivity(config);
    return this.readSnapshot(page);
  }

  async wait(config: ResolvedWebBrowserConfig, ms: number): Promise<BrowserPageSnapshot> {
    const page = await this.ensurePage(config);
    const bounded = Math.max(100, Math.min(10_000, Math.round(ms)));
    await page.waitForTimeout(bounded);
    this.touchActivity(config);
    return this.readSnapshot(page);
  }

  async screenshot(config: ResolvedWebBrowserConfig): Promise<Buffer> {
    const page = await this.ensurePage(config);
    this.touchActivity(config);
    return page.screenshot({ type: "png", fullPage: false });
  }

  async screenshotJpeg(quality = 75): Promise<Buffer | null> {
    if (!this.context) return null;
    try {
      const page = await this.resolveActivePage();
      if (this.latestConfig) this.touchActivity(this.latestConfig);
      return await page.screenshot({
        type: "jpeg",
        quality: Math.max(20, Math.min(95, Math.round(quality))),
        fullPage: false,
      });
    } catch {
      return null;
    }
  }

  async getStatus(): Promise<BrowserStatus> {
    if (!this.context) {
      return {
        open: false,
        pendingTakeover: this.isPendingTakeover(),
        takeoverReason: this.pendingTakeoverReason,
        displayMode: "closed",
        xvfbDisplay: null,
        proxyKey: null,
        url: null,
        title: null,
        viewport: { ...DEFAULT_VIEWPORT },
        tabs: [],
      };
    }

    const active = await this.resolveActivePage().catch(() => null);
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const tabs: BrowserTabInfo[] = await Promise.all(
      pages.map(async (p, index) => ({
        index,
        url: p.url(),
        title: await p.title().catch(() => ""),
        active: active ? p === active : index === pages.length - 1,
      })),
    );
    const activeTab = tabs.find((t) => t.active) ?? tabs[tabs.length - 1] ?? null;
    const viewport = active?.viewportSize() ?? { ...DEFAULT_VIEWPORT };

    return {
      open: true,
      pendingTakeover: this.isPendingTakeover(),
      takeoverReason: this.pendingTakeoverReason,
      displayMode: this.activeDisplayMode,
      xvfbDisplay: this.xvfbSession?.display ?? this.activeDisplayEnv,
      proxyKey: this.activeProxyKey || null,
      url: activeTab?.url ?? null,
      title: activeTab?.title ?? null,
      viewport,
      tabs,
    };
  }

  async getCurrentPageInfo(): Promise<{ url: string; title: string } | null> {
    if (!this.context) return null;
    try {
      const page = await this.resolveActivePage();
      return {
        url: page.url(),
        title: await page.title().catch(() => ""),
      };
    } catch {
      return null;
    }
  }

  async navigateManual(config: ResolvedWebBrowserConfig, rawUrl: string): Promise<BrowserStatus> {
    const url = normalizeNavigationUrl(rawUrl);
    const page = await this.ensurePage(config);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.actionTimeoutMs });
    this.touchActivity(config);
    await this.emitStatusUpdate();
    return this.getStatus();
  }

  async forward(config: ResolvedWebBrowserConfig): Promise<BrowserStatus> {
    const page = await this.ensurePage(config);
    await page.goForward({ waitUntil: "domcontentloaded", timeout: config.actionTimeoutMs }).catch(() => undefined);
    this.touchActivity(config);
    await this.emitStatusUpdate();
    return this.getStatus();
  }

  async reloadPage(config: ResolvedWebBrowserConfig): Promise<BrowserStatus> {
    const page = await this.ensurePage(config);
    await page.reload({ waitUntil: "domcontentloaded", timeout: config.actionTimeoutMs }).catch(() => undefined);
    this.touchActivity(config);
    await this.emitStatusUpdate();
    return this.getStatus();
  }

  async newTab(config: ResolvedWebBrowserConfig, rawUrl?: string): Promise<BrowserStatus> {
    await this.ensurePage(config);
    const ctx = this.context;
    if (!ctx) throw new Error("BrowserContext is not open");
    const page = await ctx.newPage();
    this.activePage = page;
    await this.syncScreencastTarget();
    if (rawUrl?.trim()) {
      const url = normalizeNavigationUrl(rawUrl);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.actionTimeoutMs });
    }
    this.touchActivity(config);
    await this.emitStatusUpdate();
    return this.getStatus();
  }

  async switchTab(config: ResolvedWebBrowserConfig, index: number): Promise<BrowserStatus> {
    await this.ensurePage(config);
    if (!this.context) return this.getStatus();
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const target = pages[index];
    if (!target) {
      throw new Error(`标签页索引 #${index} 不存在`);
    }
    this.activePage = target;
    await target.bringToFront().catch(() => undefined);
    await this.syncScreencastTarget();
    this.touchActivity(config);
    await this.emitStatusUpdate();
    return this.getStatus();
  }

  async closeTab(config: ResolvedWebBrowserConfig, index: number): Promise<BrowserStatus> {
    if (!this.context) return this.getStatus();
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const target = pages[index];
    if (!target) return this.getStatus();
    if (pages.length <= 1) {
      await target.goto("about:blank").catch(() => undefined);
    } else {
      await target.close().catch(() => undefined);
      await this.resolveActivePage().catch(() => undefined);
    }
    await this.syncScreencastTarget();
    this.touchActivity(config);
    await this.emitStatusUpdate();
    return this.getStatus();
  }

  async dispatchMouse(config: ResolvedWebBrowserConfig, input: BrowserMouseInput): Promise<void> {
    if (!this.context) {
      throw new Error("浏览器尚未打开，请先打开浏览器");
    }
    const page = await this.resolveActivePage();
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const clamp = (n: number | undefined, max: number) =>
      Math.max(0, Math.min(max, Number.isFinite(n) ? Number(n) : 0));
    const x = clamp(input.x, viewport.width);
    const y = clamp(input.y, viewport.height);
    const button = input.button ?? "left";

    switch (input.action) {
      case "move":
        await page.mouse.move(x, y);
        break;
      case "down":
        await page.mouse.move(x, y);
        await page.mouse.down({ button });
        break;
      case "up":
        await page.mouse.move(x, y);
        await page.mouse.up({ button });
        break;
      case "click":
        await page.mouse.click(x, y, { button });
        break;
      case "dblclick":
        await page.mouse.dblclick(x, y, { button });
        break;
      case "wheel":
        await page.mouse.move(x, y);
        await page.mouse.wheel(Number(input.deltaX) || 0, Number(input.deltaY) || 0);
        break;
    }
    this.touchActivity(config);
    void this.emitStatusUpdate();
  }

  async dispatchKeyboard(config: ResolvedWebBrowserConfig, input: BrowserKeyboardInput): Promise<void> {
    if (!this.context) {
      throw new Error("浏览器尚未打开，请先打开浏览器");
    }
    const page = await this.resolveActivePage();
    switch (input.action) {
      case "press":
        if (input.key) await page.keyboard.press(input.key);
        break;
      case "down":
        if (input.key) await page.keyboard.down(input.key);
        break;
      case "up":
        if (input.key) await page.keyboard.up(input.key);
        break;
      case "insertText":
        if (input.text) await page.keyboard.insertText(input.text);
        break;
    }
    this.touchActivity(config);
    void this.emitStatusUpdate();
  }

  async resizeViewport(
    config: ResolvedWebBrowserConfig,
    width: number,
    height: number,
  ): Promise<BrowserStatus> {
    const page = await this.ensurePage(config);
    const boundedW = Math.max(640, Math.min(1920, Math.round(width)));
    const boundedH = Math.max(480, Math.min(1080, Math.round(height)));
    await page.setViewportSize({ width: boundedW, height: boundedH });
    await this.detachScreencast();
    await this.syncScreencastTarget();
    this.touchActivity(config);
    await this.emitStatusUpdate();
    return this.getStatus();
  }

  subscribeStream(listener: (event: BrowserStreamEvent) => void): () => void {
    this.streamListeners.add(listener);
    if (this.streamListeners.size === 1) {
      this.startStreamPump();
    }
    void this.getStatus().then((status) => {
      if (this.streamListeners.has(listener)) {
        listener({ type: "status", status });
      }
    });
    return () => {
      this.streamListeners.delete(listener);
      if (this.streamListeners.size === 0) {
        this.stopStreamPump();
      }
    };
  }

  async dispose(): Promise<void> {
    this.clearIdleTimer();
    this.pendingTakeoverReason = null;
    this.manualControl = false;
    await this.detachScreencast();

    const ctx = this.context;
    this.context = null;
    this.activePage = null;
    this.activeProxyKey = "";
    this.activeDisplayMode = "closed";
    this.activeDisplayEnv = null;

    if (ctx) {
      await ctx.close().catch(() => undefined);
    }

    const xvfb = this.xvfbSession;
    this.xvfbSession = null;
    if (xvfb) {
      await xvfb.dispose().catch(() => undefined);
    }
    await this.emitStatusUpdate();
  }

  private async launchContext(
    config: ResolvedWebBrowserConfig,
    proxyOption: ReturnType<typeof parsePlaywrightProxy>,
    proxyKey: string,
  ): Promise<void> {
    const absProfileDir = resolve(config.profileDir);
    mkdirSync(absProfileDir, { recursive: true });

    const displayPlan = await prepareDisplayAndHeadless({ config });
    const candidates = resolveBrowserLaunchCandidates({ config });
    const launchArgs = buildBrowserLaunchArgs();
    const launchEnv = displayPlan.displayEnv
      ? { ...process.env, DISPLAY: displayPlan.displayEnv }
      : undefined;

    let lastErr: unknown;
    let openedContext: BrowserContext | null = null;
    let usedLabel = "";

    for (const candidate of candidates) {
      try {
        openedContext = await chromium.launchPersistentContext(absProfileDir, {
          headless: displayPlan.headless,
          ...(candidate.channel ? { channel: candidate.channel } : {}),
          ...(candidate.executablePath ? { executablePath: candidate.executablePath } : {}),
          ...(proxyOption ? { proxy: proxyOption } : {}),
          ...(launchEnv ? { env: launchEnv } : {}),
          ignoreDefaultArgs: ["--enable-automation"],
          args: launchArgs,
          viewport: { ...DEFAULT_VIEWPORT },
        });
        usedLabel = candidate.label;
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!openedContext) {
      if (displayPlan.xvfbSession) {
        await displayPlan.xvfbSession.dispose().catch(() => undefined);
      }
      throw new Error(
        `无法启动浏览器（尝试了 ${candidates.map((c) => c.label).join(", ")}）：${summarizeError(lastErr)}`,
      );
    }

    const dnsCache = new Map<string, number>();
    await openedContext.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      let protocol: string;
      try {
        protocol = new URL(reqUrl).protocol;
      } catch {
        await route.abort("accessdenied");
        return;
      }
      if (protocol === "about:" || protocol === "data:" || protocol === "blob:") {
        await route.continue();
        return;
      }
      if (protocol !== "http:" && protocol !== "https:") {
        await route.abort("accessdenied");
        return;
      }
      try {
        const parsed = validateFetchUrl(reqUrl);
        if (proxyKey === "direct") {
          const now = Date.now();
          const cachedUntil = dnsCache.get(parsed.hostname);
          if (!cachedUntil || cachedUntil <= now) {
            await assertSafeResolvedHost(parsed.hostname);
            dnsCache.set(parsed.hostname, now + 60_000);
          }
        }
        await route.continue();
      } catch {
        await route.abort("accessdenied");
      }
    });

    await openedContext.addInitScript(INIT_STEALTH_SCRIPT);
    openedContext.on("page", (newPage) => {
      this.activePage = newPage;
      void this.syncScreencastTarget();
      void this.emitStatusUpdate();
      newPage.once("close", () => {
        if (this.activePage === newPage) {
          const remaining = openedContext.pages();
          this.activePage = remaining[remaining.length - 1] ?? null;
          void this.syncScreencastTarget();
        }
        void this.emitStatusUpdate();
      });
    });
    openedContext.once("close", () => {
      if (this.context === openedContext) {
        this.context = null;
        this.activePage = null;
        this.activeDisplayMode = "closed";
        this.activeDisplayEnv = null;
        this.pendingTakeoverReason = null;
        this.clearIdleTimer();
        void this.detachScreencast();
        void this.emitStatusUpdate();
      }
    });

    this.context = openedContext;
    this.xvfbSession = displayPlan.xvfbSession ?? null;
    this.activeProxyKey = proxyKey;
    this.activeDisplayMode = displayPlan.headless
      ? "headless"
      : displayPlan.xvfbSession || displayPlan.displayEnv
        ? "xvfb"
        : "headed";
    this.activeDisplayEnv = displayPlan.displayEnv ?? null;

    const existingPages = openedContext.pages();
    this.activePage = existingPages[existingPages.length - 1] ?? (await openedContext.newPage());

    logInfo(
      "BROWSER",
      `started (${usedLabel}, ${displayPlan.headless ? "headless" : displayPlan.displayEnv ? `headed Xvfb ${displayPlan.displayEnv}` : "headed"}, proxy=${proxyKey})`,
    );
    await this.syncScreencastTarget();
    void this.emitStatusUpdate();
  }

  private async resolveActivePage(): Promise<Page> {
    if (!this.context) {
      throw new Error("BrowserContext is not open");
    }
    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }
    const openPages = this.context.pages().filter((p) => !p.isClosed());
    if (openPages.length > 0) {
      this.activePage = openPages[openPages.length - 1]!;
      return this.activePage;
    }
    this.activePage = await this.context.newPage();
    return this.activePage;
  }

  private async readSnapshot(page: Page): Promise<BrowserPageSnapshot> {
    const raw = (await page.evaluate(
      `(${SNAPSHOT_PAGE_SCRIPT})({ maxElements: ${MAX_SNAPSHOT_ELEMENTS}, maxTextChars: ${MAX_SNAPSHOT_TEXT_CHARS} })`,
    )) as BrowserPageSnapshot;
    return raw;
  }

  private touchActivity(config: ResolvedWebBrowserConfig): void {
    if (!this.isPendingTakeover() && !this.manualControl) {
      this.scheduleIdleReap(config);
    }
  }

  private scheduleIdleReap(config: ResolvedWebBrowserConfig): void {
    this.clearIdleTimer();
    if (config.idleTimeoutMinutes <= 0 || this.isPendingTakeover() || this.manualControl) {
      return;
    }
    const ms = Math.max(10_000, config.idleTimeoutMinutes * 60_000);
    this.idleTimer = setTimeout(() => {
      if (this.isPendingTakeover() || this.manualControl) return;
      logInfo("BROWSER", `idle for ${config.idleTimeoutMinutes}m, closing browser process to release memory`);
      void this.dispose().catch((err) => {
        logWarn("BROWSER", `idle dispose error: ${summarizeError(err)}`);
      });
    }, ms);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private startStreamPump(): void {
    void this.syncScreencastTarget();
    if (!this.statusPollTimer) {
      this.statusPollTimer = setInterval(() => {
        void this.emitStatusUpdate(false);
      }, 1_000);
      this.statusPollTimer.unref();
    }
  }

  private stopStreamPump(): void {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
    this.lastStatusJson = "";
    void this.detachScreencast();
  }

  private async emitStatusUpdate(force = true): Promise<void> {
    if (this.streamListeners.size === 0) return;
    const status = await this.getStatus();
    const serialized = JSON.stringify(status);
    if (!force && serialized === this.lastStatusJson) return;
    this.lastStatusJson = serialized;
    this.broadcastStream({ type: "status", status });
  }

  private broadcastStream(event: BrowserStreamEvent): void {
    for (const listener of this.streamListeners) {
      try {
        listener(event);
      } catch {
        // ignore listener failure
      }
    }
  }

  private async syncScreencastTarget(): Promise<void> {
    if (this.streamListeners.size === 0 || !this.context) {
      await this.detachScreencast();
      return;
    }

    const targetPage = await this.resolveActivePage().catch(() => null);
    if (!targetPage || targetPage.isClosed()) {
      await this.detachScreencast();
      return;
    }
    if (this.screencastPage === targetPage && (this.screencastSession || this.screencastPollTimer)) {
      return;
    }

    await this.detachScreencast();
    this.screencastPage = targetPage;

    // Push an immediate initial frame before CDP delta frames arrive.
    const initial = await targetPage
      .screenshot({ type: "jpeg", quality: 72, fullPage: false })
      .catch(() => null);
    if (initial && this.streamListeners.size > 0) {
      const vp = targetPage.viewportSize() ?? DEFAULT_VIEWPORT;
      this.broadcastStream({
        type: "frame",
        dataUrl: `data:image/jpeg;base64,${initial.toString("base64")}`,
        width: vp.width,
        height: vp.height,
      });
    }

    try {
      const cdp = await this.context.newCDPSession(targetPage);
      if (this.streamListeners.size === 0 || this.screencastPage !== targetPage) {
        await cdp.detach().catch(() => undefined);
        return;
      }
      this.screencastSession = cdp;
      cdp.on("Page.screencastFrame", (payload: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
        if (this.streamListeners.size > 0) {
          const vp = targetPage.viewportSize() ?? DEFAULT_VIEWPORT;
          this.broadcastStream({
            type: "frame",
            dataUrl: `data:image/jpeg;base64,${payload.data}`,
            width: payload.metadata?.deviceWidth || vp.width,
            height: payload.metadata?.deviceHeight || vp.height,
          });
        }
        void cdp.send("Page.screencastFrameAck", { sessionId: payload.sessionId }).catch(() => undefined);
      });
      const activeVp = targetPage.viewportSize() ?? DEFAULT_VIEWPORT;
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 74,
        maxWidth: Math.max(activeVp.width, DEFAULT_VIEWPORT.width),
        maxHeight: Math.max(activeVp.height, DEFAULT_VIEWPORT.height),
        everyNthFrame: 1,
      });
      return;
    } catch {
      await this.detachScreencast();
      this.screencastPage = targetPage;
    }

    // Fallback frame poll if CDP screencast is unsupported on the active page.
    this.screencastPollTimer = setInterval(() => {
      if (!this.context || !this.screencastPage || this.screencastPage.isClosed()) return;
      void this.screencastPage
        .screenshot({ type: "jpeg", quality: 72, fullPage: false })
        .then((buf) => {
          if (this.streamListeners.size === 0 || !this.screencastPage) return;
          const vp = this.screencastPage.viewportSize() ?? DEFAULT_VIEWPORT;
          this.broadcastStream({
            type: "frame",
            dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
            width: vp.width,
            height: vp.height,
          });
        })
        .catch(() => undefined);
    }, 450);
    this.screencastPollTimer.unref();
  }

  private async detachScreencast(): Promise<void> {
    if (this.screencastPollTimer) {
      clearInterval(this.screencastPollTimer);
      this.screencastPollTimer = null;
    }
    const cdp = this.screencastSession;
    this.screencastSession = null;
    this.screencastPage = null;
    if (cdp) {
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  }
}

const BLOCKED_BROWSER_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
]);

export function normalizeNavigationUrl(rawUrl: string): string {
  return validateFetchUrl(rawUrl).toString();
}

function escapeAttrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
