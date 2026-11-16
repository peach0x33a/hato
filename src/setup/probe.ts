import type { ResolvedTavilySearchConfig } from "../config/app.js";
import { supportsCustomFetchOption, type ModelSlot, type ModelRegistry } from "../config/models.js";
import type { ProxyResolution, ScopedProxyRouter } from "../config/proxy.js";
import { runTavilySearch } from "../persona/web-search.js";

export interface TavilyProbeResult {
  ok: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  latencyMs: number;
  proxy: ProxyResolution;
  resultCount?: number;
  error?: string;
}

export interface TelegramProbeResult {
  ok: boolean;
  baseUrl: string;
  latencyMs: number;
  proxy: ProxyResolution;
  botId?: number;
  username?: string;
  firstName?: string;
  error?: string;
}

export interface ModelProbeResult {
  ok: boolean;
  slot: ModelSlot;
  target: string;
  providerSlug: string;
  api: string;
  baseUrl: string;
  apiKeyEnv: string;
  latencyMs: number;
  proxy: ProxyResolution;
  replyPreview?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

/**
 * Verify Telegram Bot Token & gateway.telegram proxy/base_url using Telegram's getMe endpoint.
 */
export async function probeTelegramGateway(params: {
  baseUrl: string;
  botToken: string;
  proxyRouter: ScopedProxyRouter;
  timeoutMs?: number;
}): Promise<TelegramProbeResult> {
  const cleanBaseUrl = params.baseUrl.replace(/\/+$/, "");
  const scope = "gateway.telegram";
  const proxy = params.proxyRouter.resolveScope(scope);
  const startedAt = Date.now();

  if (!params.botToken.trim()) {
    return {
      ok: false,
      baseUrl: cleanBaseUrl,
      latencyMs: 0,
      proxy,
      error: "Bot Token 为空，无法发起 Telegram getMe 探测",
    };
  }

  try {
    const url = `${cleanBaseUrl}/bot${params.botToken.trim()}/getMe`;
    const res = await params.proxyRouter.scopedFetch(
      url,
      {
        method: "GET",
        signal: AbortSignal.timeout(params.timeoutMs ?? 10_000),
      },
      scope,
    );
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: { id?: number; username?: string; first_name?: string } }
      | null;
    const latencyMs = Date.now() - startedAt;

    if (!res.ok || !data?.ok || !data.result) {
      return {
        ok: false,
        baseUrl: cleanBaseUrl,
        latencyMs,
        proxy,
        error: data?.description ? `Telegram HTTP ${res.status}: ${data.description}` : `Telegram HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      baseUrl: cleanBaseUrl,
      latencyMs,
      proxy,
      botId: data.result.id,
      username: data.result.username,
      firstName: data.result.first_name,
    };
  } catch (err) {
    return {
      ok: false,
      baseUrl: cleanBaseUrl,
      latencyMs: Date.now() - startedAt,
      proxy,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Send a minimal one-turn handshake to the configured slot model through ScopedProxyRouter.
 */
export async function probeModelSlot(params: {
  slot?: ModelSlot;
  modelRegistry: ModelRegistry;
  proxyRouter: ScopedProxyRouter;
  envOverrides?: Record<string, string>;
  timeoutMs?: number;
}): Promise<ModelProbeResult> {
  const slot = params.slot ?? "persona";
  const resolved = params.modelRegistry.resolveSlot(slot);
  const scope = `llm-calling.${resolved.providerSlug}`;
  const proxy = params.proxyRouter.resolveScope(scope);
  const startedAt = Date.now();

  const hookWasInstalled = params.proxyRouter.isGlobalFetchHookInstalled();
  if (!hookWasInstalled) {
    params.proxyRouter.installGlobalFetchHook();
  }

  try {
    const overrideKey = resolved.apiKeyEnv ? params.envOverrides?.[resolved.apiKeyEnv]?.trim() : undefined;
    const apiKey = overrideKey || params.modelRegistry.resolveApiKeyForProvider(resolved.providerSlug);

    const scopedFetch: typeof globalThis.fetch = (input, init) =>
      params.proxyRouter.scopedFetch(input, init, scope);

    const result = await params.proxyRouter.runWithScope(scope, () =>
      params.modelRegistry.models.completeSimple(
        resolved.model,
        {
          messages: [
            {
              role: "user",
              content: "Reply with OK only.",
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: 16,
          ...(supportsCustomFetchOption(resolved.model.api) ? { fetch: scopedFetch } : {}),
          signal: AbortSignal.timeout(params.timeoutMs ?? 20_000),
          disableContinuation: true,
        },
      ),
    );

    const latencyMs = Date.now() - startedAt;
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      return {
        ok: false,
        slot,
        target: resolved.target,
        providerSlug: resolved.providerSlug,
        api: String(resolved.model.api),
        baseUrl: resolved.model.baseUrl,
        apiKeyEnv: resolved.apiKeyEnv,
        latencyMs,
        proxy,
        error: result.errorMessage || `Model stopped with reason "${result.stopReason}"`,
      };
    }

    const replyPreview = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim()
      .slice(0, 80);

    return {
      ok: true,
      slot,
      target: resolved.target,
      providerSlug: resolved.providerSlug,
      api: String(resolved.model.api),
      baseUrl: resolved.model.baseUrl,
      apiKeyEnv: resolved.apiKeyEnv,
      latencyMs,
      proxy,
      replyPreview: replyPreview || "(empty text response)",
      inputTokens: result.usage?.input,
      outputTokens: result.usage?.output,
    };
  } catch (err) {
    return {
      ok: false,
      slot,
      target: resolved.target,
      providerSlug: resolved.providerSlug,
      api: String(resolved.model.api),
      baseUrl: resolved.model.baseUrl,
      apiKeyEnv: resolved.apiKeyEnv,
      latencyMs: Date.now() - startedAt,
      proxy,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!hookWasInstalled) {
      params.proxyRouter.uninstallGlobalFetchHook();
    }
  }
}

/**
 * Verify Tavily web_search connectivity and API key under the `web_access.tavily` proxy scope.
 */
export async function probeTavilySearch(params: {
  config: ResolvedTavilySearchConfig;
  proxyRouter: ScopedProxyRouter;
  apiKey: string;
  timeoutMs?: number;
}): Promise<TavilyProbeResult> {
  const scope = "web_access.tavily";
  const proxy = params.proxyRouter.resolveScope(scope);
  const cleanBaseUrl = params.config.baseUrl.replace(/\/+$/, "");
  const startedAt = Date.now();

  if (!params.apiKey.trim()) {
    return {
      ok: false,
      baseUrl: cleanBaseUrl,
      apiKeyEnv: params.config.apiKeyEnv,
      latencyMs: 0,
      proxy,
      error: `${params.config.apiKeyEnv} 为空，未配置 Tavily API Key`,
    };
  }

  const out = await runTavilySearch({
    config: { ...params.config, enabled: true },
    proxyRouter: params.proxyRouter,
    apiKey: params.apiKey.trim(),
    input: {
      query: "OpenAI",
      searchDepth: "basic",
      maxResults: 1,
    },
    timeoutMs: params.timeoutMs ?? 12_000,
  });

  return {
    ok: out.ok,
    baseUrl: cleanBaseUrl,
    apiKeyEnv: params.config.apiKeyEnv,
    latencyMs: Date.now() - startedAt,
    proxy,
    resultCount: out.results.length,
    error: out.error,
  };
}
