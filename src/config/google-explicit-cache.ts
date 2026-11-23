import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ScopedProxyRouter } from "./proxy.js";
import { logInfo, logWarn } from "../utils/logger.js";

const DEFAULT_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TTL_MINUTES = 60;
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 1440;
const DEFAULT_MIN_ESTIMATED_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 15_000;
const SAFETY_BUFFER_MS = 60_000;
const KEY_FAILURE_COOLDOWN_MS = 5 * 60_000;
const UNSUPPORTED_ENDPOINT_COOLDOWN_MS = 15 * 60_000;

interface CachedContentEntry {
  name: string;
  provider: string;
  modelId: string;
  baseUrl: string;
  expiresAtMs: number;
}

export interface GoogleExplicitCacheOptions {
  proxyRouter?: ScopedProxyRouter;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  minEstimatedChars?: number;
}

/**
 * Manages Google Generative AI Explicit Context Caching (`cachedContents`)
 * for static `systemInstruction` + `tools` + `toolConfig` prefixes.
 * Falls back silently to implicit caching on unsupported proxies or errors.
 */
export class GoogleExplicitCacheManager {
  private readonly proxyRouter?: ScopedProxyRouter;
  private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly minEstimatedChars: number;

  private readonly entries = new Map<string, CachedContentEntry>();
  private readonly inflightCreates = new Map<string, Promise<CachedContentEntry | null>>();
  private readonly renewingNames = new Set<string>();
  private readonly keyCooldownUntil = new Map<string, number>();
  private readonly baseUrlCooldownUntil = new Map<string, number>();

  constructor(options: GoogleExplicitCacheOptions = {}) {
    this.proxyRouter = options.proxyRouter;
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.minEstimatedChars = options.minEstimatedChars ?? DEFAULT_MIN_ESTIMATED_CHARS;
  }

  invalidateForModel(provider: string, modelId: string): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.provider === provider && entry.modelId === modelId) {
        this.entries.delete(key);
      }
    }
  }

  async preparePayload(params: {
    model: Model<any>;
    apiKey?: string;
    payload: unknown;
    ttlMinutes?: number;
  }): Promise<unknown | undefined> {
    const { model, apiKey, payload } = params;
    if (model.api !== "google-generative-ai" || !apiKey?.trim()) {
      return undefined;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }

    const payloadObj = payload as Record<string, unknown>;
    const rawConfig = payloadObj.config;
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      return undefined;
    }
    const configObj = rawConfig as Record<string, unknown>;
    if (typeof configObj.cachedContent === "string" && configObj.cachedContent.trim()) {
      return undefined;
    }

    const systemInstruction =
      typeof configObj.systemInstruction === "string" ? configObj.systemInstruction : "";
    const tools = configObj.tools;
    const toolConfig = configObj.toolConfig;

    if (!systemInstruction && !tools) {
      return undefined;
    }

    const estimatedChars =
      systemInstruction.length +
      (tools ? JSON.stringify(tools).length : 0) +
      (toolConfig ? JSON.stringify(toolConfig).length : 0);

    if (estimatedChars < this.minEstimatedChars) {
      return undefined;
    }

    const baseUrl = normalizeGoogleBaseUrl(model.baseUrl);
    const modelName = model.id.startsWith("models/") ? model.id : `models/${model.id}`;
    const ttlMinutes = clampTtlMinutes(params.ttlMinutes);
    const ttlSeconds = Math.round(ttlMinutes * 60);

    const now = Date.now();
    const baseCooldown = this.baseUrlCooldownUntil.get(baseUrl) ?? 0;
    if (baseCooldown > now) {
      return undefined;
    }

    const cacheKey = computePrefixCacheKey({
      baseUrl,
      modelName,
      systemInstruction,
      tools,
      toolConfig,
      apiKey,
    });

    const keyCooldown = this.keyCooldownUntil.get(cacheKey) ?? 0;
    if (keyCooldown > now) {
      return undefined;
    }

    const existing = this.entries.get(cacheKey);
    if (existing && existing.expiresAtMs > now + SAFETY_BUFFER_MS) {
      const remainingMs = existing.expiresAtMs - now;
      const renewThresholdMs = Math.min(5 * 60_000, ttlSeconds * 1000 * 0.25);
      if (remainingMs < renewThresholdMs && !this.renewingNames.has(existing.name)) {
        void this.renewTtl(existing, apiKey, model, ttlSeconds);
      }
      return applyCachedContentToPayload(payloadObj, configObj, existing.name);
    }

    let inflight = this.inflightCreates.get(cacheKey);
    if (!inflight) {
      inflight = this.createCachedContent({
        cacheKey,
        baseUrl,
        modelName,
        model,
        apiKey,
        ttlSeconds,
        systemInstruction,
        tools,
        toolConfig,
      }).finally(() => {
        this.inflightCreates.delete(cacheKey);
      });
      this.inflightCreates.set(cacheKey, inflight);
    }

    const created = await inflight;
    if (!created) {
      return undefined;
    }
    return applyCachedContentToPayload(payloadObj, configObj, created.name);
  }

  private async createCachedContent(params: {
    cacheKey: string;
    baseUrl: string;
    modelName: string;
    model: Model<any>;
    apiKey: string;
    ttlSeconds: number;
    systemInstruction: string;
    tools: unknown;
    toolConfig: unknown;
  }): Promise<CachedContentEntry | null> {
    const endpoint = `${params.baseUrl}/cachedContents`;
    const body: Record<string, unknown> = {
      model: params.modelName,
      ttl: `${params.ttlSeconds}s`,
    };
    if (params.systemInstruction) {
      body.systemInstruction = {
        parts: [{ text: params.systemInstruction }],
      };
    }
    if (params.tools !== undefined) {
      body.tools = params.tools;
    }
    if (params.toolConfig !== undefined) {
      body.toolConfig = params.toolConfig;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": params.apiKey,
      ...(params.model.headers ?? {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const exec = () =>
        this.fetcher(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

      const response = this.proxyRouter
        ? await this.proxyRouter.runWithScope(`llm-calling.${params.model.provider}`, exec)
        : await exec();

      if (!response.ok) {
        const text = (await response.text().catch(() => "")).trim().slice(0, 200);
        if (response.status === 404 || response.status === 405 || response.status === 501) {
          this.baseUrlCooldownUntil.set(params.baseUrl, Date.now() + UNSUPPORTED_ENDPOINT_COOLDOWN_MS);
        } else {
          this.keyCooldownUntil.set(params.cacheKey, Date.now() + KEY_FAILURE_COOLDOWN_MS);
        }
        logWarn(
          "CACHE",
          `Google explicit cache create failed (${params.model.provider}/${params.model.id}, HTTP ${response.status}): ${text || "unknown error"}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        name?: unknown;
        expireTime?: unknown;
        usageMetadata?: { totalTokenCount?: unknown };
      };
      if (typeof data?.name !== "string" || !data.name.trim()) {
        this.keyCooldownUntil.set(params.cacheKey, Date.now() + KEY_FAILURE_COOLDOWN_MS);
        logWarn("CACHE", "Google explicit cache response missing cachedContent name");
        return null;
      }

      const parsedExpireMs =
        typeof data.expireTime === "string" ? Date.parse(data.expireTime) : Number.NaN;
      const expiresAtMs =
        Number.isFinite(parsedExpireMs) && parsedExpireMs > Date.now()
          ? parsedExpireMs
          : Date.now() + params.ttlSeconds * 1000;

      const entry: CachedContentEntry = {
        name: data.name.trim(),
        provider: params.model.provider,
        modelId: params.model.id,
        baseUrl: params.baseUrl,
        expiresAtMs,
      };
      this.entries.set(params.cacheKey, entry);

      const tokenCount =
        typeof data.usageMetadata?.totalTokenCount === "number"
          ? ` (${data.usageMetadata.totalTokenCount} tokens)`
          : "";
      logInfo(
        "CACHE",
        `created Google explicit cache ${entry.name} for ${params.model.provider}/${params.model.id}${tokenCount}`,
      );
      return entry;
    } catch (err) {
      this.keyCooldownUntil.set(params.cacheKey, Date.now() + KEY_FAILURE_COOLDOWN_MS);
      logWarn(
        "CACHE",
        `Google explicit cache error (${params.model.provider}/${params.model.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async renewTtl(
    entry: CachedContentEntry,
    apiKey: string,
    model: Model<any>,
    ttlSeconds: number,
  ): Promise<void> {
    this.renewingNames.add(entry.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const endpoint = `${entry.baseUrl}/${entry.name.replace(/^\/+/, "")}`;
      const exec = () =>
        this.fetcher(endpoint, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
            ...(model.headers ?? {}),
          },
          body: JSON.stringify({ ttl: `${ttlSeconds}s` }),
          signal: controller.signal,
        });

      const response = this.proxyRouter
        ? await this.proxyRouter.runWithScope(`llm-calling.${model.provider}`, exec)
        : await exec();

      if (response.ok) {
        const data = (await response.json().catch(() => ({}))) as { expireTime?: unknown };
        const parsedExpireMs =
          typeof data?.expireTime === "string" ? Date.parse(data.expireTime) : Number.NaN;
        entry.expiresAtMs =
          Number.isFinite(parsedExpireMs) && parsedExpireMs > Date.now()
            ? parsedExpireMs
            : Date.now() + ttlSeconds * 1000;
      }
    } catch {
      // Ignore background renewal failure; cache will simply be recreated after expiry
    } finally {
      clearTimeout(timer);
      this.renewingNames.delete(entry.name);
    }
  }
}

function normalizeGoogleBaseUrl(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_GOOGLE_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function clampTtlMinutes(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TTL_MINUTES;
  return Math.max(MIN_TTL_MINUTES, Math.min(MAX_TTL_MINUTES, raw));
}

function computePrefixCacheKey(input: {
  baseUrl: string;
  modelName: string;
  systemInstruction: string;
  tools: unknown;
  toolConfig: unknown;
  apiKey: string;
}): string {
  const apiKeyHash = createHash("sha256").update(input.apiKey).digest("hex").slice(0, 12);
  const raw = JSON.stringify({
    baseUrl: input.baseUrl,
    modelName: input.modelName,
    systemInstruction: input.systemInstruction,
    tools: input.tools ?? null,
    toolConfig: input.toolConfig ?? null,
    apiKeyHash,
  });
  return createHash("sha256").update(raw).digest("hex");
}

function applyCachedContentToPayload(
  payloadObj: Record<string, unknown>,
  configObj: Record<string, unknown>,
  cachedContentName: string,
): Record<string, unknown> {
  const nextConfig: Record<string, unknown> = {
    ...configObj,
    cachedContent: cachedContentName,
  };
  delete nextConfig.systemInstruction;
  delete nextConfig.tools;
  delete nextConfig.toolConfig;
  return {
    ...payloadObj,
    config: nextConfig,
  };
}
