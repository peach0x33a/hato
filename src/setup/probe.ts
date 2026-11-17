import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { ResolvedTavilySearchConfig } from "../config/app.js";
import {
  resolveBuiltInApiStreams,
  supportsCustomFetchOption,
  type ModelSlot,
  type ModelRegistry,
} from "../config/models.js";
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

export interface TelegramUserProfileResult {
  id: string;
  ok: boolean;
  firstName?: string;
  lastName?: string;
  username?: string;
  displayName?: string;
  avatarDataUrl?: string;
  error?: string;
}

const MAX_TELEGRAM_AVATAR_BYTES = 512 * 1024;

function inferImageMimeType(filePath: string, headerType: string | null): string {
  const cleanHeader = headerType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (cleanHeader.startsWith("image/")) {
    return cleanHeader;
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

async function fetchSingleTelegramUserProfile(params: {
  cleanBaseUrl: string;
  token: string;
  userId: string;
  proxyRouter: ScopedProxyRouter;
  timeoutMs: number;
}): Promise<TelegramUserProfileResult> {
  const { cleanBaseUrl, token, userId, proxyRouter, timeoutMs } = params;
  const scope = "gateway.telegram";

  try {
    const chatUrl = `${cleanBaseUrl}/bot${token}/getChat?chat_id=${encodeURIComponent(userId)}`;
    const chatRes = await proxyRouter.scopedFetch(
      chatUrl,
      { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
      scope,
    );
    const chatData = (await chatRes.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      result?: {
        id?: number;
        first_name?: string;
        last_name?: string;
        username?: string;
        title?: string;
        photo?: {
          small_file_id?: string;
          big_file_id?: string;
        };
      };
    } | null;

    if (!chatRes.ok || !chatData?.ok || !chatData.result) {
      return {
        id: userId,
        ok: false,
        error: chatData?.description
          ? `Telegram HTTP ${chatRes.status}: ${chatData.description}`
          : `Telegram HTTP ${chatRes.status}`,
      };
    }

    const r = chatData.result;
    const firstName = r.first_name?.trim() || undefined;
    const lastName = r.last_name?.trim() || undefined;
    const username = r.username?.trim() || undefined;
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const displayName =
      fullName || r.title?.trim() || (username ? `@${username}` : undefined);

    let fileId = r.photo?.small_file_id?.trim() || r.photo?.big_file_id?.trim() || "";
    if (!fileId && /^\d+$/.test(userId)) {
      try {
        const photosUrl = `${cleanBaseUrl}/bot${token}/getUserProfilePhotos?user_id=${encodeURIComponent(userId)}&limit=1`;
        const photosRes = await proxyRouter.scopedFetch(
          photosUrl,
          { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
          scope,
        );
        const photosData = (await photosRes.json().catch(() => null)) as {
          ok?: boolean;
          result?: {
            photos?: Array<Array<{ file_id?: string }>>;
          };
        } | null;
        const firstSizes = photosData?.ok ? photosData.result?.photos?.[0] : undefined;
        if (firstSizes && firstSizes.length > 0) {
          fileId = firstSizes[0]?.file_id?.trim() || "";
        }
      } catch {
        // Photo lookup fallback is optional; keep user name/id.
      }
    }

    let avatarDataUrl: string | undefined;
    if (fileId) {
      try {
        const getFileUrl = `${cleanBaseUrl}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
        const fileRes = await proxyRouter.scopedFetch(
          getFileUrl,
          { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
          scope,
        );
        const fileData = (await fileRes.json().catch(() => null)) as {
          ok?: boolean;
          result?: { file_path?: string };
        } | null;
        const filePath = fileData?.ok ? fileData.result?.file_path?.trim() : undefined;
        if (filePath) {
          const cleanPath = filePath.replace(/^\/+/, "");
          const downloadUrl = `${cleanBaseUrl}/file/bot${token}/${cleanPath}`;
          const imgRes = await proxyRouter.scopedFetch(
            downloadUrl,
            { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
            scope,
          );
          if (imgRes.ok) {
            const buf = await imgRes.arrayBuffer();
            if (buf.byteLength > 0 && buf.byteLength <= MAX_TELEGRAM_AVATAR_BYTES) {
              const mime = inferImageMimeType(cleanPath, imgRes.headers.get("content-type"));
              avatarDataUrl = `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
            }
          }
        }
      } catch {
        // Avatar download failure should not hide user name/username.
      }
    }

    return {
      id: userId,
      ok: true,
      firstName,
      lastName,
      username,
      displayName,
      avatarDataUrl,
    };
  } catch (err) {
    return {
      id: userId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch Telegram user profile metadata (display name, username, avatar data URL)
 * via Bot API under the `gateway.telegram` proxy scope.
 */
export async function fetchTelegramUserProfiles(params: {
  baseUrl: string;
  botToken: string;
  userIds: Array<string | number>;
  proxyRouter: ScopedProxyRouter;
  timeoutMs?: number;
}): Promise<TelegramUserProfileResult[]> {
  const cleanBaseUrl = params.baseUrl.replace(/\/+$/, "");
  const token = params.botToken.trim();
  const seen = new Set<string>();
  const uniqueIds: string[] = [];
  for (const raw of params.userIds) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
    if (uniqueIds.length >= 25) break;
  }

  if (uniqueIds.length === 0) return [];
  if (!token) {
    return uniqueIds.map((id) => ({
      id,
      ok: false,
      error: "Bot Token 未配置",
    }));
  }

  const timeoutMs = params.timeoutMs ?? 8_000;
  return Promise.all(
    uniqueIds.map((userId) =>
      fetchSingleTelegramUserProfile({
        cleanBaseUrl,
        token,
        userId,
        proxyRouter: params.proxyRouter,
        timeoutMs,
      }),
    ),
  );
}

export interface AdHocModelProbeResult {
  ok: boolean;
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

async function runModelProbeCompletion(params: {
  modelsClient: MutableModels;
  model: Model<Api>;
  providerSlug: string;
  apiKeyEnv: string;
  apiKey?: string;
  proxyRouter: ScopedProxyRouter;
  promptText: string;
  maxTokens: number;
  timeoutMs?: number;
}): Promise<AdHocModelProbeResult> {
  const target = `${params.providerSlug}/${params.model.id}`;
  const scope = `llm-calling.${params.providerSlug}`;
  const proxy = params.proxyRouter.resolveScope(scope);
  const startedAt = Date.now();

  const hookWasInstalled = params.proxyRouter.isGlobalFetchHookInstalled();
  if (!hookWasInstalled) {
    params.proxyRouter.installGlobalFetchHook();
  }

  try {
    const scopedFetch: typeof globalThis.fetch = (input, init) =>
      params.proxyRouter.scopedFetch(input, init, scope);

    const result = await params.proxyRouter.runWithScope(scope, () =>
      params.modelsClient.completeSimple(
        params.model,
        {
          messages: [
            {
              role: "user",
              content: params.promptText,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: params.apiKey,
          maxTokens: params.maxTokens,
          ...(supportsCustomFetchOption(params.model.api) ? { fetch: scopedFetch } : {}),
          signal: AbortSignal.timeout(params.timeoutMs ?? 20_000),
          disableContinuation: true,
        },
      ),
    );

    const latencyMs = Date.now() - startedAt;
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      return {
        ok: false,
        target,
        providerSlug: params.providerSlug,
        api: String(params.model.api),
        baseUrl: params.model.baseUrl,
        apiKeyEnv: params.apiKeyEnv,
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
      .slice(0, 120);

    return {
      ok: true,
      target,
      providerSlug: params.providerSlug,
      api: String(params.model.api),
      baseUrl: params.model.baseUrl,
      apiKeyEnv: params.apiKeyEnv,
      latencyMs,
      proxy,
      replyPreview: replyPreview || "(empty text response)",
      inputTokens: result.usage?.input,
      outputTokens: result.usage?.output,
    };
  } catch (err) {
    return {
      ok: false,
      target,
      providerSlug: params.providerSlug,
      api: String(params.model.api),
      baseUrl: params.model.baseUrl,
      apiKeyEnv: params.apiKeyEnv,
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
  const startedAt = Date.now();

  let apiKey: string | undefined;
  try {
    const overrideKey = resolved.apiKeyEnv ? params.envOverrides?.[resolved.apiKeyEnv]?.trim() : undefined;
    apiKey = overrideKey || params.modelRegistry.resolveApiKeyForProvider(resolved.providerSlug);
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
      proxy: params.proxyRouter.resolveScope(`llm-calling.${resolved.providerSlug}`),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const probe = await runModelProbeCompletion({
    modelsClient: params.modelRegistry.models,
    model: resolved.model,
    providerSlug: resolved.providerSlug,
    apiKeyEnv: resolved.apiKeyEnv,
    apiKey,
    proxyRouter: params.proxyRouter,
    promptText: "Reply with OK only.",
    maxTokens: 16,
    timeoutMs: params.timeoutMs,
  });

  return {
    slot,
    ...probe,
  };
}

/**
 * Test a specific provider/model configuration (saved or unsaved UI draft) with a greeting asking for "hello".
 */
export async function probeAdHocModel(params: {
  providerSlug: string;
  api: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKeyOverride?: string;
  providerHeaders?: Record<string, string>;
  model: {
    id: string;
    name?: string;
    api?: string;
    base_url?: string;
    headers?: Record<string, string>;
    reasoning?: boolean;
    input?: Array<"text" | "image">;
    context_window?: number;
    max_tokens?: number;
  };
  modelRegistry: ModelRegistry;
  proxyRouter: ScopedProxyRouter;
  envOverrides?: Record<string, string>;
  timeoutMs?: number;
}): Promise<AdHocModelProbeResult> {
  const providerSlug = params.providerSlug.trim();
  const modelId = params.model.id.trim();
  const target = `${providerSlug}/${modelId}`;
  const modelApi = (params.model.api?.trim() || params.api.trim()) as Api;
  const baseUrl = params.model.base_url?.trim() || params.baseUrl.trim();
  const apiKeyEnv = params.apiKeyEnv.trim();
  const scope = `llm-calling.${providerSlug}`;
  const proxy = params.proxyRouter.resolveScope(scope);

  if (modelApi === "hato-faux-api") {
    try {
      const resolved = params.modelRegistry.resolveTarget(target);
      return await runModelProbeCompletion({
        modelsClient: params.modelRegistry.models,
        model: resolved.model,
        providerSlug: resolved.providerSlug,
        apiKeyEnv: resolved.apiKeyEnv,
        apiKey: undefined,
        proxyRouter: params.proxyRouter,
        promptText: "你好！请只回复 hello。",
        maxTokens: 64,
        timeoutMs: params.timeoutMs,
      });
    } catch (err) {
      return {
        ok: false,
        target,
        providerSlug,
        api: String(modelApi),
        baseUrl,
        apiKeyEnv,
        latencyMs: 0,
        proxy,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const streams = resolveBuiltInApiStreams(modelApi);
  if (!streams) {
    return {
      ok: false,
      target,
      providerSlug,
      api: String(modelApi),
      baseUrl,
      apiKeyEnv,
      latencyMs: 0,
      proxy,
      error: `不支持的接口协议: ${String(modelApi)}`,
    };
  }

  const apiKey =
    params.apiKeyOverride?.trim() ||
    (apiKeyEnv ? params.envOverrides?.[apiKeyEnv]?.trim() || process.env[apiKeyEnv]?.trim() : "") ||
    "";
  if (!apiKey) {
    return {
      ok: false,
      target,
      providerSlug,
      api: String(modelApi),
      baseUrl,
      apiKeyEnv,
      latencyMs: 0,
      proxy,
      error: apiKeyEnv
        ? `未找到密钥环境变量 ${apiKeyEnv}，请先在「配置供应商」或「密钥与自检」中配置`
        : "未配置 API Key 或密钥变量名",
    };
  }

  const mergedHeaders =
    params.providerHeaders || params.model.headers
      ? { ...(params.providerHeaders ?? {}), ...(params.model.headers ?? {}) }
      : undefined;

  const modelObj: Model<Api> = {
    id: modelId,
    name: params.model.name?.trim() || modelId,
    api: modelApi,
    provider: providerSlug,
    baseUrl,
    reasoning: params.model.reasoning ?? false,
    input: params.model.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.model.context_window ?? 128_000,
    maxTokens: params.model.max_tokens ?? 8_192,
    headers: mergedHeaders,
  };

  const tempModels = createModels();
  tempModels.setProvider(
    createProvider({
      id: providerSlug,
      name: providerSlug,
      baseUrl,
      headers: params.providerHeaders,
      auth: { apiKey: envApiKeyAuth(`${providerSlug} API key`, apiKeyEnv ? [apiKeyEnv] : []) },
      models: [modelObj],
      api: { [modelApi]: streams },
    }),
  );

  return runModelProbeCompletion({
    modelsClient: tempModels,
    model: modelObj,
    providerSlug,
    apiKeyEnv,
    apiKey,
    proxyRouter: params.proxyRouter,
    promptText: "你好！请只回复 hello。",
    maxTokens: 64,
    timeoutMs: params.timeoutMs,
  });
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
