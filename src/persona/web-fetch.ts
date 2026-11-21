import { isIP } from "node:net";
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
const MAX_REDIRECT_HOPS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
]);

function isPrivateOrBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateOrBlockedIpv6(rawHost: string): boolean {
  const ip = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (ip === "::" || ip === "::1" || ip === "0:0:0:0:0:0:0:1" || ip === "0:0:0:0:0:0:0:0") {
    return true;
  }
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(ip)) return true; // link-local fe80::/10
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice("::ffff:".length);
    if (mapped.includes(".")) {
      return isPrivateOrBlockedIpv4(mapped);
    }
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      const lo = parseInt(hexMatch[2]!, 16);
      const ipv4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      return isPrivateOrBlockedIpv4(ipv4);
    }
  }
  return false;
}

/**
 * Validates and normalizes an external HTTP/HTTPS URL for `web_fetch`.
 */
export function validateFetchUrl(
  rawUrl: string,
  options?: { allowPrivateNetworks?: boolean },
): URL {
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
  const bareHost = hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_METADATA_HOSTS.has(bareHost)) {
    throw new Error(`出于安全限制，禁止访问云元数据地址 "${hostname}"`);
  }
  if (!options?.allowPrivateNetworks) {
    if (
      bareHost === "localhost" ||
      bareHost.endsWith(".localhost") ||
      bareHost.endsWith(".local") ||
      bareHost.endsWith(".internal")
    ) {
      throw new Error(`出于安全限制，禁止访问本地或内网地址 "${hostname}"`);
    }
    const ipVersion = isIP(bareHost);
    if (ipVersion === 4 && isPrivateOrBlockedIpv4(bareHost)) {
      throw new Error(`出于安全限制，禁止访问内网或环回 IP 地址 "${hostname}"`);
    }
    if (ipVersion === 6 && isPrivateOrBlockedIpv6(bareHost)) {
      throw new Error(`出于安全限制，禁止访问内网或环回 IPv6 地址 "${hostname}"`);
    }
  }
  return parsed;
}

async function readResponseTextBounded(res: Response, maxBytes: number): Promise<string> {
  const declaredLen = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    throw new Error(`响应体过大 (${declaredLen} bytes)，超出安全上限 (${maxBytes} bytes)`);
  }
  if (!res.body) {
    return await res.text();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`响应体过大（超过 ${maxBytes} bytes 安全上限），已中止读取`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetches a web URL under `web_access.fetch` proxy scope and converts HTML/JSON/text into clean readable content.
 */
export async function runWebFetch(params: {
  config: ResolvedWebFetchConfig;
  proxyRouter: ScopedProxyRouter;
  input: WebFetchInput;
  signal?: AbortSignal;
  allowPrivateNetworks?: boolean;
}): Promise<WebFetchOutput> {
  if (!params.config.enabled) {
    const text = "网页抓取已在配置中禁用（web.fetch.enabled = false）。";
    return { ok: false, url: params.input.url, text, error: text };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = validateFetchUrl(params.input.url, {
      allowPrivateNetworks: params.allowPrivateNetworks,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, url: params.input.url, text: msg, error: msg };
  }

  const maxChars = Math.max(500, Math.min(50_000, params.input.maxChars ?? params.config.maxChars));
  const timeoutSignal = AbortSignal.timeout(params.config.timeoutMs);
  const combinedSignal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  try {
    let currentUrl = parsedUrl;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      res = await params.proxyRouter.runWithScope(WEB_ACCESS_FETCH_SCOPE, () =>
        params.proxyRouter.scopedFetch(
          currentUrl.toString(),
          {
            method: "GET",
            redirect: "manual",
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
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) break;
        if (hop === MAX_REDIRECT_HOPS) {
          throw new Error(`重定向次数超过上限 (${MAX_REDIRECT_HOPS})`);
        }
        const nextUrl = new URL(location, currentUrl);
        currentUrl = validateFetchUrl(nextUrl.toString(), {
          allowPrivateNetworks: params.allowPrivateNetworks,
        });
        continue;
      }
      break;
    }

    if (!res) {
      throw new Error("未收到有效 HTTP 响应");
    }

    const finalUrl = res.url || currentUrl.toString();
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

    const rawBody = await readResponseTextBounded(res, MAX_RESPONSE_BYTES);
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
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}
