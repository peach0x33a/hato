import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { ResolvedMemoryEchoConfig, ResolvedTavilySearchConfig } from "../config/app.js";
import { QqOpenApiClient } from "../gateway/qq-client.js";
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
 * Fetch the Telegram bot's own profile photo directly via getUserProfilePhotos + getFile
 * (since bots cannot call getChat on their own bot_id).
 */
export async function fetchTelegramBotAvatar(params: {
  baseUrl: string;
  botToken: string;
  botId: number | string;
  proxyRouter: ScopedProxyRouter;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const cleanBaseUrl = params.baseUrl.replace(/\/+$/, "");
  const token = params.botToken.trim();
  const botIdStr = String(params.botId).trim();
  if (!token || !botIdStr) return undefined;

  const scope = "gateway.telegram";
  const timeoutMs = params.timeoutMs ?? 5_000;
  try {
    const photosUrl = `${cleanBaseUrl}/bot${token}/getUserProfilePhotos?user_id=${encodeURIComponent(botIdStr)}&limit=1`;
    const photosRes = await params.proxyRouter.scopedFetch(
      photosUrl,
      { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
      scope,
    );
    const photosData = (await photosRes.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      result?: { photos?: Array<Array<{ file_id?: string }>> };
    } | null;
    if (!photosRes.ok || !photosData?.ok) {
      console.warn(
        `[WARN] [TG] getUserProfilePhotos failed for bot ${botIdStr}: HTTP ${photosRes.status} ${photosData?.description ?? ""}`,
      );
      return undefined;
    }
    const firstSizes = photosData.result?.photos?.[0];
    const fileId = firstSizes?.[firstSizes.length - 1]?.file_id?.trim() || firstSizes?.[0]?.file_id?.trim() || "";
    if (!fileId) return undefined;

    const getFileUrl = `${cleanBaseUrl}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const fileRes = await params.proxyRouter.scopedFetch(
      getFileUrl,
      { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
      scope,
    );
    const fileData = (await fileRes.json().catch(() => null)) as {
      ok?: boolean;
      result?: { file_path?: string };
    } | null;
    const filePath = fileData?.ok ? fileData.result?.file_path?.trim() : undefined;
    if (!filePath) return undefined;

    const cleanPath = filePath.replace(/^\/+/, "");
    const downloadUrl = `${cleanBaseUrl}/file/bot${token}/${cleanPath}`;
    const imgRes = await params.proxyRouter.scopedFetch(
      downloadUrl,
      { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
      scope,
    );
    if (!imgRes.ok) return undefined;
    const buf = await imgRes.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_TELEGRAM_AVATAR_BYTES) return undefined;
    const mime = inferImageMimeType(cleanPath, imgRes.headers.get("content-type"));
    return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * Update Telegram bot's own profile (name, description, short description, avatar) via Bot API.
 */
export async function updateTelegramBotProfile(params: {
  baseUrl: string;
  botToken: string;
  proxyRouter: ScopedProxyRouter;
  name?: string;
  description?: string;
  shortDescription?: string;
  avatarPath?: string;
  removeAvatar?: boolean;
  timeoutMs?: number;
}): Promise<{ ok: boolean; updated: string[]; error?: string }> {
  const cleanBaseUrl = params.baseUrl.replace(/\/+$/, "");
  const token = params.botToken.trim();
  if (!token) {
    return { ok: false, updated: [], error: "Bot Token 为空，无法修改 Telegram 机器人信息" };
  }

  const scope = "gateway.telegram";
  const timeoutMs = params.timeoutMs ?? 15_000;
  const updated: string[] = [];

  const callJsonMethod = async (method: string, body: Record<string, unknown>) => {
    const res = await params.proxyRouter.scopedFetch(
      `${cleanBaseUrl}/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
      scope,
    );
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (!res.ok || !data?.ok) {
      throw new Error(
        data?.description
          ? `${method} 失败 (HTTP ${res.status}): ${data.description}`
          : `${method} 失败 (HTTP ${res.status})`,
      );
    }
  };

  try {
    if (params.name !== undefined) {
      await callJsonMethod("setMyName", { name: params.name });
      updated.push("name");
    }
    if (params.description !== undefined) {
      await callJsonMethod("setMyDescription", { description: params.description });
      updated.push("description");
    }
    if (params.shortDescription !== undefined) {
      await callJsonMethod("setMyShortDescription", {
        short_description: params.shortDescription,
      });
      updated.push("short_description");
    }
    if (params.removeAvatar) {
      await callJsonMethod("removeMyProfilePhoto", {});
      updated.push("remove_avatar");
    } else if (params.avatarPath !== undefined) {
      const abs = resolve(params.avatarPath.trim());
      if (!existsSync(abs)) {
        throw new Error(`头像文件不存在: ${abs}`);
      }
      const bytes = readFileSync(abs);
      const mime = inferImageMimeType(abs, null);
      const form = new FormData();
      form.append(
        "photo",
        JSON.stringify({ type: "static", photo: "attach://avatar" }),
      );
      form.append("avatar", new Blob([bytes], { type: mime }), basename(abs));
      const tempReq = new Request("http://localhost", { method: "POST", body: form });
      const multipartContentType = tempReq.headers.get("content-type") || "multipart/form-data";
      const multipartBody = Buffer.from(await tempReq.arrayBuffer());
      const res = await params.proxyRouter.scopedFetch(
        `${cleanBaseUrl}/bot${token}/setMyProfilePhoto`,
        {
          method: "POST",
          headers: { "Content-Type": multipartContentType },
          body: multipartBody,
          signal: AbortSignal.timeout(timeoutMs),
        },
        scope,
      );
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        description?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(
          data?.description
            ? `setMyProfilePhoto 失败 (HTTP ${res.status}): ${data.description}`
            : `setMyProfilePhoto 失败 (HTTP ${res.status})`,
        );
      }
      updated.push("avatar");
    }

    return { ok: true, updated };
  } catch (err) {
    return {
      ok: false,
      updated,
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

export interface QqProbeResult {
  ok: boolean;
  baseUrl: string;
  latencyMs: number;
  proxy: ProxyResolution;
  gatewayUrl?: string;
  error?: string;
}

/**
 * Verify QQ Official Bot credentials (App Access Token exchange) and GET /gateway reachability.
 */
export async function probeQqGateway(params: {
  baseUrl: string;
  appId: string;
  clientSecret: string;
  proxyRouter: ScopedProxyRouter;
  tokenUrl?: string;
}): Promise<QqProbeResult> {
  const cleanBaseUrl = params.baseUrl.replace(/\/+$/, "");
  const scope = "gateway.qq";
  const proxy = params.proxyRouter.resolveScope(scope);
  const startedAt = Date.now();

  if (!params.appId.trim() || !params.clientSecret.trim()) {
    return {
      ok: false,
      baseUrl: cleanBaseUrl,
      latencyMs: 0,
      proxy,
      error: "QQ app_id 或 client_secret 为空，无法发起连通性探测",
    };
  }

  try {
    const client = new QqOpenApiClient({
      baseUrl: cleanBaseUrl,
      appId: params.appId.trim(),
      clientSecret: params.clientSecret.trim(),
      proxyRouter: params.proxyRouter,
      tokenUrl: params.tokenUrl,
    });
    const gatewayUrl = await client.getGatewayUrl();
    return {
      ok: true,
      baseUrl: cleanBaseUrl,
      latencyMs: Date.now() - startedAt,
      proxy,
      gatewayUrl,
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

export interface MemoryServiceProbeResult {
  ok: boolean;
  provider: string;
  baseUrl: string;
  latencyMs: number;
  proxy: ProxyResolution;
  vaultCount?: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Verify MemoryEcho (or configured external memory service) connectivity and API key.
 */
export async function probeMemoryService(params: {
  provider: "none" | "memoryecho" | "hindsight";
  memoryEcho: ResolvedMemoryEchoConfig;
  hindsight?: { base_url: string };
  proxyRouter: ScopedProxyRouter;
  apiKey: string;
  timeoutMs?: number;
}): Promise<MemoryServiceProbeResult> {
  if (params.provider === "hindsight") {
    const scope = "memory.hindsight";
    const proxy = params.proxyRouter.resolveScope(scope);
    const cleanBaseUrl = (params.hindsight?.base_url ?? "").trim().replace(/\/+$/, "");
    const startedAt = Date.now();
    if (!cleanBaseUrl) {
      return {
        ok: false,
        provider: params.provider,
        baseUrl: "",
        latencyMs: 0,
        proxy,
        error: "未配置 memory.hindsight.base_url",
      };
    }
    try {
      const probeUrls = [`${cleanBaseUrl}/health`, `${cleanBaseUrl}/v1/default/banks`, cleanBaseUrl];
      let lastStatus = 0;
      let lastRaw = "";
      for (const targetUrl of probeUrls) {
        const res = await params.proxyRouter.runWithScope(scope, () =>
          params.proxyRouter.scopedFetch(
            targetUrl,
            {
              method: "GET",
              signal: AbortSignal.timeout(params.timeoutMs ?? 10_000),
            },
            scope,
          ),
        );
        lastStatus = res.status;
        lastRaw = await res.text();
        if (res.ok) {
          return {
            ok: true,
            provider: params.provider,
            baseUrl: cleanBaseUrl,
            latencyMs: Date.now() - startedAt,
            proxy,
          };
        }
        if (res.status !== 404) break;
      }
      return {
        ok: false,
        provider: params.provider,
        baseUrl: cleanBaseUrl,
        latencyMs: Date.now() - startedAt,
        proxy,
        error: `Hindsight HTTP ${lastStatus}: ${lastRaw.slice(0, 200)}`,
      };
    } catch (err) {
      return {
        ok: false,
        provider: params.provider,
        baseUrl: cleanBaseUrl,
        latencyMs: Date.now() - startedAt,
        proxy,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const scope = "memory.memoryecho";
  const proxy = params.proxyRouter.resolveScope(scope);
  const cleanBaseUrl = params.memoryEcho.baseUrl.replace(/\/+$/, "");
  const startedAt = Date.now();

  if (params.provider === "none" || !params.memoryEcho.enabled) {
    return {
      ok: false,
      provider: params.provider,
      baseUrl: cleanBaseUrl,
      latencyMs: 0,
      proxy,
      skipped: true,
      error: "记忆服务未启用 (memory.provider=none)",
    };
  }

  if (params.provider !== "memoryecho") {
    return {
      ok: false,
      provider: params.provider,
      baseUrl: cleanBaseUrl,
      latencyMs: 0,
      proxy,
      error: `暂不支持探测记忆后端: ${params.provider}`,
    };
  }

  if (!params.apiKey.trim()) {
    return {
      ok: false,
      provider: params.provider,
      baseUrl: cleanBaseUrl,
      latencyMs: 0,
      proxy,
      error: `${params.memoryEcho.apiKeyEnv} 为空，未配置 MemoryEcho API Key`,
    };
  }

  try {
    const res = await params.proxyRouter.runWithScope(scope, () =>
      params.proxyRouter.scopedFetch(
        `${cleanBaseUrl}/api/v1/memory/vaults`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${params.apiKey.trim()}` },
          signal: AbortSignal.timeout(params.timeoutMs ?? params.memoryEcho.timeoutMs ?? 10_000),
        },
        scope,
      ),
    );
    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        provider: params.provider,
        baseUrl: cleanBaseUrl,
        latencyMs: Date.now() - startedAt,
        proxy,
        error: `HTTP ${res.status}: ${raw.slice(0, 200)}`,
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    const vaultCount = Array.isArray(parsed) ? parsed.length : undefined;
    return {
      ok: true,
      provider: params.provider,
      baseUrl: cleanBaseUrl,
      latencyMs: Date.now() - startedAt,
      proxy,
      vaultCount,
    };
  } catch (err) {
    return {
      ok: false,
      provider: params.provider,
      baseUrl: cleanBaseUrl,
      latencyMs: Date.now() - startedAt,
      proxy,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
