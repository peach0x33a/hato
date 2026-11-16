import type { ResolvedTavilySearchConfig } from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { getOptionalSecret } from "../config/secrets.js";
import { logWarn } from "../utils/logger.js";

export interface TavilySearchInput {
  query: string;
  topic?: "general" | "news" | "finance";
  searchDepth?: "basic" | "advanced";
  maxResults?: number;
  timeRange?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface TavilyResultItem {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
}

export interface TavilySearchOutput {
  ok: boolean;
  answer?: string;
  results: TavilyResultItem[];
  formattedText: string;
  error?: string;
}

interface TavilyApiResponse {
  answer?: unknown;
  results?: Array<{
    title?: unknown;
    url?: unknown;
    content?: unknown;
    score?: unknown;
    published_date?: unknown;
  }>;
  detail?: unknown;
  error?: unknown;
}

const MAX_SNIPPET_CHARS = 650;
const WEB_ACCESS_TAVILY_SCOPE = "web_access.tavily";

/**
 * Execute a real-time web search via Tavily Search API under the `web_access` proxy scope.
 */
export async function runTavilySearch(params: {
  config: ResolvedTavilySearchConfig;
  proxyRouter: ScopedProxyRouter;
  input: TavilySearchInput;
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<TavilySearchOutput> {
  if (!params.config.enabled) {
    const formattedText = "联网搜索已在配置中禁用（web.search.enabled = false）。";
    return { ok: false, results: [], formattedText, error: formattedText };
  }

  const query = params.input.query.trim();
  if (!query) {
    const formattedText = "搜索关键词不能为空。";
    return { ok: false, results: [], formattedText, error: formattedText };
  }

  const resolvedKey = (params.apiKey ?? getOptionalSecret(params.config.apiKeyEnv))?.trim();
  if (!resolvedKey) {
    const formattedText = `联网搜索尚未配置密钥：请在 .env 中设置 ${params.config.apiKeyEnv} 后再试（或运行 npm run setup 配置后发送 /reload）。`;
    return { ok: false, results: [], formattedText, error: formattedText };
  }

  const baseUrl = params.config.baseUrl.replace(/\/+$/, "");
  const endpoint = `${baseUrl}/search`;
  const maxResults = Math.max(1, Math.min(20, Math.round(params.input.maxResults ?? params.config.maxResults)));

  const body: Record<string, unknown> = {
    query,
    topic: params.input.topic ?? "general",
    search_depth: params.input.searchDepth ?? params.config.searchDepth,
    max_results: maxResults,
    include_answer: true,
  };
  if (params.input.timeRange) body.time_range = params.input.timeRange;
  if (params.input.includeDomains?.length) body.include_domains = params.input.includeDomains;
  if (params.input.excludeDomains?.length) body.exclude_domains = params.input.excludeDomains;

  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? 15_000);
  const combinedSignal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  try {
    const res = await params.proxyRouter.runWithScope(WEB_ACCESS_TAVILY_SCOPE, () =>
      params.proxyRouter.scopedFetch(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${resolvedKey}`,
          },
          body: JSON.stringify(body),
          signal: combinedSignal,
        },
        WEB_ACCESS_TAVILY_SCOPE,
      ),
    );

    const rawText = await res.text();
    let parsed: TavilyApiResponse | null = null;
    try {
      parsed = JSON.parse(rawText) as TavilyApiResponse;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const detail =
        extractErrorMessage(parsed) || rawText.trim().slice(0, 240) || `HTTP ${res.status}`;
      const errMsg = `Tavily 搜索失败 (HTTP ${res.status}): ${detail}`;
      logWarn("WEB", errMsg);
      return { ok: false, results: [], formattedText: errMsg, error: errMsg };
    }

    const answer = typeof parsed?.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : undefined;
    const results: TavilyResultItem[] = (Array.isArray(parsed?.results) ? parsed.results : [])
      .map((item) => ({
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : "(无标题)",
        url: typeof item.url === "string" ? item.url.trim() : "",
        content: typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim() : "",
        score: typeof item.score === "number" ? item.score : undefined,
        publishedDate:
          typeof item.published_date === "string" && item.published_date.trim()
            ? item.published_date.trim()
            : undefined,
      }))
      .filter((item) => item.url || item.content);

    return {
      ok: true,
      answer,
      results,
      formattedText: formatTavilyResults(query, answer, results),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const errMsg = `Tavily 搜索请求异常: ${detail}`;
    logWarn("WEB", errMsg);
    return { ok: false, results: [], formattedText: errMsg, error: errMsg };
  }
}

function formatTavilyResults(
  query: string,
  answer: string | undefined,
  results: TavilyResultItem[],
): string {
  const lines: string[] = [`[Tavily 搜索] query="${query}"`];
  if (answer) {
    lines.push(`摘要结论: ${answer}`);
  }
  if (results.length === 0) {
    lines.push("未找到相关公开网页结果。");
    return lines.join("\n\n");
  }

  for (let i = 0; i < results.length; i++) {
    const item = results[i]!;
    const snippet =
      item.content.length > MAX_SNIPPET_CHARS
        ? `${item.content.slice(0, MAX_SNIPPET_CHARS)}...`
        : item.content;
    const itemLines = [`[${i + 1}] ${item.title}`];
    if (item.url) itemLines.push(`URL: ${item.url}`);
    if (item.publishedDate) itemLines.push(`发布时间: ${item.publishedDate}`);
    if (snippet) itemLines.push(`内容: ${snippet}`);
    lines.push(itemLines.join("\n"));
  }

  return lines.join("\n\n");
}

function extractErrorMessage(parsed: TavilyApiResponse | null): string | null {
  if (!parsed) return null;
  if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail.trim();
  if (
    parsed.detail &&
    typeof parsed.detail === "object" &&
    "error" in parsed.detail &&
    typeof (parsed.detail as { error?: unknown }).error === "string"
  ) {
    return (parsed.detail as { error: string }).error.trim();
  }
  if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
  return null;
}
