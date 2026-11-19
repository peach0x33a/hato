import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { resolveBrowserLaunchCandidates } from "../browser/platform.js";
import type { ResolvedWebBrowserConfig } from "../config/app.js";
import { logWarn, summarizeError } from "../utils/logger.js";

export type MarkdownRenderTheme = "light" | "dark";

export interface MarkdownRenderOptions {
  theme?: MarkdownRenderTheme;
}

export interface MarkdownImageRendererOptions {
  browserConfig?: Pick<ResolvedWebBrowserConfig, "channel" | "executablePath">;
  idleTimeoutMs?: number;
  viewportWidth?: number;
  deviceScaleFactor?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_VIEWPORT_WIDTH = 820;
const DEFAULT_DEVICE_SCALE_FACTOR = 2;

const LIGHT_THEME_CSS = `
  :root {
    --page-bg: #f3f5f8;
    --card-bg: #ffffff;
    --card-border: #e5e7eb;
    --card-shadow: 0 8px 28px rgba(15, 23, 42, 0.08);
    --text-primary: #1f2328;
    --text-muted: #59636e;
    --heading-border: #d8dee4;
    --code-bg: #f6f8fa;
    --code-border: #e5e7eb;
    --inline-code-bg: rgba(175, 184, 193, 0.2);
    --quote-border: #d0d7de;
    --quote-bg: #f8fafc;
    --table-border: #d0d7de;
    --table-header-bg: #f6f8fa;
    --table-alt-bg: #f9fbfd;
    --link-color: #0969da;
    --hr-color: #d8dee4;
  }
`;

const DARK_THEME_CSS = `
  :root {
    --page-bg: #0b0f17;
    --card-bg: #111827;
    --card-border: #1f2937;
    --card-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    --text-primary: #e6edf3;
    --text-muted: #9ca3af;
    --heading-border: #2d3748;
    --code-bg: #0d1117;
    --code-border: #30363d;
    --inline-code-bg: rgba(110, 118, 129, 0.35);
    --quote-border: #3b434f;
    --quote-bg: #161e2e;
    --table-border: #30363d;
    --table-header-bg: #161b22;
    --table-alt-bg: #141a24;
    --link-color: #58a6ff;
    --hr-color: #30363d;
  }
`;

const BASE_CSS = `
  * {
    box-sizing: border-box;
  }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--page-bg);
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
      "Microsoft YaHei", "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif;
    font-size: 16px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  .markdown-card {
    width: 780px;
    margin: 0;
    padding: 28px;
    background: var(--page-bg);
  }
  .markdown-surface {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 16px;
    box-shadow: var(--card-shadow);
    padding: 30px 34px;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  .markdown-surface > *:first-child {
    margin-top: 0 !important;
  }
  .markdown-surface > *:last-child {
    margin-bottom: 0 !important;
  }
  h1, h2, h3, h4, h5, h6 {
    margin: 1.3em 0 0.6em;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text-primary);
  }
  h1 {
    font-size: 1.75em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--heading-border);
  }
  h2 {
    font-size: 1.4em;
    padding-bottom: 0.25em;
    border-bottom: 1px solid var(--heading-border);
  }
  h3 { font-size: 1.18em; }
  h4 { font-size: 1.05em; }
  p {
    margin: 0.75em 0;
  }
  a {
    color: var(--link-color);
    text-decoration: none;
  }
  ul, ol {
    margin: 0.7em 0;
    padding-left: 1.75em;
  }
  li + li {
    margin-top: 0.25em;
  }
  li.task-list-item {
    list-style: none;
    margin-left: -1.35em;
  }
  li.task-list-item input[type="checkbox"] {
    margin-right: 0.5em;
    vertical-align: middle;
  }
  blockquote {
    margin: 0.9em 0;
    padding: 0.5em 1em;
    color: var(--text-muted);
    background: var(--quote-bg);
    border-left: 4px solid var(--quote-border);
    border-radius: 0 8px 8px 0;
  }
  blockquote > p:first-child { margin-top: 0; }
  blockquote > p:last-child { margin-bottom: 0; }
  code {
    font-family: "JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 0.88em;
    background: var(--inline-code-bg);
    padding: 0.15em 0.4em;
    border-radius: 6px;
  }
  pre {
    margin: 0.9em 0;
    padding: 14px 16px;
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    border-radius: 10px;
    overflow-x: auto;
    line-height: 1.5;
  }
  pre code {
    background: transparent;
    padding: 0;
    border-radius: 0;
    font-size: 0.86em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 1em 0;
    font-size: 0.93em;
  }
  th, td {
    border: 1px solid var(--table-border);
    padding: 8px 12px;
    text-align: left;
  }
  th {
    background: var(--table-header-bg);
    font-weight: 600;
  }
  tr:nth-child(even) td {
    background: var(--table-alt-bg);
  }
  hr {
    border: 0;
    border-top: 1px solid var(--hr-color);
    margin: 1.4em 0;
  }
  img {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
  }
`;

/**
 * Convert Markdown into a self-contained HTML5 document styled for light or dark mode.
 */
export function buildMarkdownDocumentHtml(
  markdown: string,
  theme: MarkdownRenderTheme = "light",
): string {
  const bodyHtml = Bun.markdown.html(markdown);
  const themeCss = theme === "dark" ? DARK_THEME_CSS : LIGHT_THEME_CSS;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<style>${themeCss}${BASE_CSS}</style>
</head>
<body>
  <div class="markdown-card">
    <div class="markdown-surface">${bodyHtml}</div>
  </div>
</body>
</html>`;
}

/**
 * High-performance Markdown-to-PNG renderer backed by `Bun.markdown.html` and a warm,
 * serial-queued headless Chromium page that auto-closes after idle inactivity.
 */
export class MarkdownImageRenderer {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private readonly browserConfig: Pick<ResolvedWebBrowserConfig, "channel" | "executablePath">;
  private readonly idleTimeoutMs: number;
  private readonly viewportWidth: number;
  private readonly deviceScaleFactor: number;

  constructor(options?: MarkdownImageRendererOptions) {
    this.browserConfig = options?.browserConfig ?? { channel: "chrome", executablePath: "" };
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.viewportWidth = options?.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
    this.deviceScaleFactor = options?.deviceScaleFactor ?? DEFAULT_DEVICE_SCALE_FACTOR;
  }

  /**
   * Render Markdown text into a PNG buffer.
   */
  render(markdown: string, options?: MarkdownRenderOptions): Promise<Buffer> {
    const trimmed = markdown.trim();
    if (!trimmed) {
      return Promise.reject(new Error("Markdown 内容为空，无法渲染。"));
    }
    const theme: MarkdownRenderTheme = options?.theme === "dark" ? "dark" : "light";

    return this.enqueue(async () => {
      if (this.disposed) {
        throw new Error("MarkdownImageRenderer has been disposed");
      }
      const html = buildMarkdownDocumentHtml(trimmed, theme);
      return await this.renderHtmlWithRetry(html);
    });
  }

  /**
   * Close the warm Chromium instance if open.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    await this.closeBrowser();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async renderHtmlWithRetry(html: string): Promise<Buffer> {
    try {
      return await this.renderHtmlOnWarmPage(html);
    } catch (err) {
      // Recover transparently once if the warm browser/page was closed externally.
      await this.closeBrowser();
      try {
        return await this.renderHtmlOnWarmPage(html);
      } catch (retryErr) {
        logWarn("RENDER", `markdown image render failed: ${summarizeError(retryErr)}`);
        throw retryErr instanceof Error ? retryErr : new Error(String(err));
      }
    }
  }

  private async renderHtmlOnWarmPage(html: string): Promise<Buffer> {
    this.clearIdleTimer();
    const page = await this.ensureWarmPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const png = await page.locator(".markdown-card").screenshot({ type: "png" });
    this.scheduleIdleClose();
    return Buffer.from(png);
  }

  private async ensureWarmPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    const browser = await this.ensureBrowser();
    if (!this.context) {
      this.context = await browser.newContext({
        viewport: { width: this.viewportWidth, height: 600 },
        deviceScaleFactor: this.deviceScaleFactor,
      });
    }
    this.page = await this.context.newPage();
    return this.page;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    const candidates = resolveBrowserLaunchCandidates({ config: this.browserConfig });
    const errors: string[] = [];

    for (const candidate of candidates) {
      try {
        const browser = await chromium.launch({
          headless: true,
          ...(candidate.executablePath ? { executablePath: candidate.executablePath } : {}),
          ...(candidate.channel ? { channel: candidate.channel } : {}),
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        });
        this.browser = browser;
        return browser;
      } catch (err) {
        errors.push(`${candidate.label}: ${summarizeError(err)}`);
      }
    }

    throw new Error(`未找到可用的 Chromium/Chrome 浏览器来渲染图片: ${errors.join("; ")}`);
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      void this.enqueue(() => this.closeBrowser());
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async closeBrowser(): Promise<void> {
    this.clearIdleTimer();
    const page = this.page;
    const context = this.context;
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;

    if (page && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
