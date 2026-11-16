import type { ResolvedWebFetchConfig } from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { logWarn } from "../utils/logger.js";

export interface WebFetchInput {
  url: string;
  maxChars?: number;
}

export interface WebFetchOutput {
  ok: boolean;
  url: string;
  finalUrl?: string;
  title?: string;
  contentType?: string;
  text: string;
  truncated?: boolean;
  error?: string;
}

const WEB_ACCESS_FETCH_SCOPE = "web_access.fetch";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
]);

/**
 * Validates and normalizes an external HTTP/HTTPS URL for `web_fetch`.
 */
export function validateFetchUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`无效 URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`仅支持 http:// 或 https:// 协议，收到 "${parsed.protocol}"`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTS.has(hostname)) {
    throw new Error(`出于安全限制，禁止访问云元数据地址 "${hostname}"`);
  }
  return parsed;
}

/**
 * Fetches a web URL under `web_access.fetch` proxy scope and converts HTML/JSON/text into clean readable content.
 */
export async function runWebFetch(params: {
  config: ResolvedWebFetchConfig;
  proxyRouter: ScopedProxyRouter;
  input: WebFetchInput;
  signal?: AbortSignal;
}): Promise<WebFetchOutput> {
  if (!params.config.enabled) {
    const text = "网页抓取已在配置中禁用（web.fetch.enabled = false）。";
    return { ok: false, url: params.input.url, text, error: text };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = validateFetchUrl(params.input.url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, url: params.input.url, text: msg, error: msg };
  }

  const maxChars = Math.max(500, Math.min(50_000, params.input.maxChars ?? params.config.maxChars));
  const timeoutSignal = AbortSignal.timeout(params.config.timeoutMs);
  const combinedSignal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  try {
    const res = await params.proxyRouter.runWithScope(WEB_ACCESS_FETCH_SCOPE, () =>
      params.proxyRouter.scopedFetch(
        parsedUrl.toString(),
        {
          method: "GET",
          redirect: "follow",
          headers: {
            "User-Agent": DEFAULT_USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
          signal: combinedSignal,
        },
        WEB_ACCESS_FETCH_SCOPE,
      ),
    );

    const finalUrl = res.url || parsedUrl.toString();
    const contentType = (res.headers.get("content-type") ?? "text/plain").toLowerCase();

    if (!res.ok) {
      const errMsg = `抓取失败 (HTTP ${res.status}): ${finalUrl}`;
      logWarn("WEB", errMsg);
      return { ok: false, url: parsedUrl.toString(), finalUrl, contentType, text: errMsg, error: errMsg };
    }

    if (
      !contentType.includes("text/") &&
      !contentType.includes("json") &&
      !contentType.includes("xml") &&
      !contentType.includes("javascript")
    ) {
      const msg = `目标资源不是文本网页（Content-Type: ${contentType}），无法按文本抓取；如需视觉查看请改用 browser_task。`;
      return { ok: false, url: parsedUrl.toString(), finalUrl, contentType, text: msg, error: msg };
    }

    const rawBody = await res.text();
    let title: string | undefined;
    let bodyText: string;

    if (contentType.includes("html") || contentType.includes("xhtml")) {
      const extracted = extractReadableTextFromHtml(rawBody);
      title = extracted.title;
      bodyText = extracted.text;
    } else if (contentType.includes("json")) {
      try {
        bodyText = JSON.stringify(JSON.parse(rawBody), null, 2);
      } catch {
        bodyText = rawBody.trim();
      }
    } else {
      bodyText = rawBody.trim();
    }

    const truncated = bodyText.length > maxChars;
    const clipped = truncated ? `${bodyText.slice(0, maxChars)}\n\n...[已截断，总长度 ${bodyText.length} 字符]` : bodyText;
    const headerLines = [`[网页内容] URL: ${finalUrl}`];
    if (title) headerLines.push(`标题: ${title}`);
    headerLines.push("");
    headerLines.push(clipped || "(页面正文为空，可能依赖前端 JS 渲染；可尝试改用 browser_task 打开)");

    return {
      ok: true,
      url: parsedUrl.toString(),
      finalUrl,
      title,
      contentType,
      text: headerLines.join("\n"),
      truncated,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const errMsg = `网页抓取请求异常: ${detail}`;
    logWarn("WEB", errMsg);
    return { ok: false, url: parsedUrl.toString(), text: errMsg, error: errMsg };
  }
}

/**
 * Extracts readable title and lightweight markdown-ish plain text from raw HTML without heavy DOM deps.
 */
export function extractReadableTextFromHtml(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]!.replace(/\s+/g, " ").trim()) : undefined;

  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  cleaned = cleaned
    .replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const cleanLabel = stripTags(label).replace(/\s+/g, " ").trim();
      if (!cleanLabel) return "";
      if (href.startsWith("javascript:")) return cleanLabel;
      return `${cleanLabel} (${href})`;
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      const heading = stripTags(inner).replace(/\s+/g, " ").trim();
      return heading ? `\n\n${"#".repeat(Number(level))} ${heading}\n\n` : "\n";
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
      const item = stripTags(inner).replace(/\s+/g, " ").trim();
      return item ? `\n- ${item}` : "";
    })
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|main|header|footer|aside|tr|blockquote|pre|ul|ol|table)>/gi, "\n\n");

  const plain = decodeHtmlEntities(stripTags(cleaned))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    title: title || undefined,
    text: plain,
  };
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}
