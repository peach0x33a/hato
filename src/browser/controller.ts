import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { ResolvedWebBrowserConfig } from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
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

const WEB_ACCESS_BROWSER_SCOPE = "web_access.browser";
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
  private idleTimer: NodeJS.Timeout | null = null;
  private pendingTakeoverReason: string | null = null;
  private latestConfig: ResolvedWebBrowserConfig | null = null;

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
  }

  clearPendingTakeover(): void {
    this.pendingTakeoverReason = null;
    if (this.latestConfig) {
      this.scheduleIdleReap(this.latestConfig);
    }
  }

  async ensurePage(config: ResolvedWebBrowserConfig): Promise<Page> {
    this.latestConfig = config;
    const proxyRes = this.proxyRouter.resolveScope(WEB_ACCESS_BROWSER_SCOPE);
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

  async dispose(): Promise<void> {
    this.clearIdleTimer();
    this.pendingTakeoverReason = null;

    const ctx = this.context;
    this.context = null;
    this.activePage = null;
    this.activeProxyKey = "";

    if (ctx) {
      await ctx.close().catch(() => undefined);
    }

    const xvfb = this.xvfbSession;
    this.xvfbSession = null;
    if (xvfb) {
      await xvfb.dispose().catch(() => undefined);
    }
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
          viewport: { width: 1280, height: 800 },
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

    await openedContext.addInitScript(INIT_STEALTH_SCRIPT);
    openedContext.on("page", (newPage) => {
      this.activePage = newPage;
      newPage.once("close", () => {
        if (this.activePage === newPage) {
          const remaining = openedContext.pages();
          this.activePage = remaining[remaining.length - 1] ?? null;
        }
      });
    });
    openedContext.once("close", () => {
      if (this.context === openedContext) {
        this.context = null;
        this.activePage = null;
        this.pendingTakeoverReason = null;
        this.clearIdleTimer();
      }
    });

    this.context = openedContext;
    this.xvfbSession = displayPlan.xvfbSession ?? null;
    this.activeProxyKey = proxyKey;

    const existingPages = openedContext.pages();
    this.activePage = existingPages[existingPages.length - 1] ?? (await openedContext.newPage());

    logInfo(
      "BROWSER",
      `started (${usedLabel}, ${displayPlan.headless ? "headless" : displayPlan.displayEnv ? `headed Xvfb ${displayPlan.displayEnv}` : "headed"}, proxy=${proxyKey})`,
    );
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
    if (!this.isPendingTakeover()) {
      this.scheduleIdleReap(config);
    }
  }

  private scheduleIdleReap(config: ResolvedWebBrowserConfig): void {
    this.clearIdleTimer();
    if (config.idleTimeoutMinutes <= 0 || this.isPendingTakeover()) {
      return;
    }
    const ms = Math.max(10_000, config.idleTimeoutMinutes * 60_000);
    this.idleTimer = setTimeout(() => {
      if (this.isPendingTakeover()) return;
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
}

function normalizeNavigationUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`无效网页地址: "${rawUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`浏览器任务仅允许访问 http:// 或 https:// 网址，收到 "${parsed.protocol}"`);
  }
  return parsed.toString();
}

function escapeAttrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
