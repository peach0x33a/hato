import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ScopedProxyRouter } from "./proxy.js";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const FETCH_TIMEOUT_MS = 15_000;
const DISK_CACHE_VERSION = 1;

interface ModelsDevDiskCachePayload {
  version: number;
  fetchedAtMs: number;
  catalog: ModelsDevCatalog;
}

export interface ModelsDevRawModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  attachment?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  limit?: {
    context?: number;
    output?: number;
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  canonical_model_id?: string;
}

export interface ModelsDevRawProvider {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevRawModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevRawProvider>;

export interface ModelsDevMappedMetadata {
  ref: string;
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  context_window?: number;
  max_tokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

export interface ModelsDevSearchItem {
  ref: string;
  name: string;
  providerName: string;
  reasoning: boolean;
  supportsVision: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelsDevProbeResult {
  ok: boolean;
  latencyMs: number;
  providerCount: number;
  modelCount: number;
  error?: string;
}

export interface ModelsDevRegistryOptions {
  apiUrl?: string;
  cacheTtlMs?: number;
  cacheFilePath?: string | null;
  getProxyRouter?: () => ScopedProxyRouter;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Parse a `<provider>/<model>` reference for models.dev lookup.
 */
export function parseModelsDevRef(rawRef: string): {
  providerId: string;
  modelId: string;
  ref: string;
} | null {
  const trimmed = rawRef.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) {
    return null;
  }
  const providerId = trimmed.slice(0, slashIdx).trim();
  const modelId = trimmed.slice(slashIdx + 1).trim();
  if (!providerId || !modelId || /\s/.test(providerId) || /\s/.test(modelId)) {
    return null;
  }
  return {
    providerId,
    modelId,
    ref: `${providerId}/${modelId}`,
  };
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded >= 1 ? rounded : undefined;
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function mapRawModelToMetadata(
  providerId: string,
  providerName: string,
  modelId: string,
  raw: ModelsDevRawModel,
): ModelsDevMappedMetadata {
  const inputModalities = Array.isArray(raw.modalities?.input) ? raw.modalities.input : [];
  const supportsVision = inputModalities.includes("image");
  const contextWindow = toPositiveInt(raw.limit?.context);
  const maxTokens = toPositiveInt(raw.limit?.output);

  const costInput = toNonNegativeNumber(raw.cost?.input);
  const costOutput = toNonNegativeNumber(raw.cost?.output);
  const costCacheRead = toNonNegativeNumber(raw.cost?.cache_read);
  const costCacheWrite = toNonNegativeNumber(raw.cost?.cache_write);
  const hasCost =
    costInput !== undefined ||
    costOutput !== undefined ||
    costCacheRead !== undefined ||
    costCacheWrite !== undefined;

  return {
    ref: `${providerId}/${modelId}`,
    providerId,
    providerName,
    modelId,
    name: raw.name?.trim() || raw.id?.trim() || modelId,
    reasoning: Boolean(raw.reasoning),
    input: supportsVision ? ["text", "image"] : ["text"],
    ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(hasCost
      ? {
          cost: {
            ...(costInput !== undefined ? { input: costInput } : {}),
            ...(costOutput !== undefined ? { output: costOutput } : {}),
            ...(costCacheRead !== undefined ? { cache_read: costCacheRead } : {}),
            ...(costCacheWrite !== undefined ? { cache_write: costCacheWrite } : {}),
          },
        }
      : {}),
  };
}

const CANONICAL_MATCH_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "xai",
  "mistral",
  "alibaba",
  "moonshotai",
  "zhipuai",
  "minimax",
  "openrouter",
] as const;

function derivePreferredProviders(hints?: { providerSlug?: string; api?: string }): string[] {
  const candidates: string[] = [];
  const push = (id: string) => {
    const normalized = id.trim().toLowerCase();
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  if (hints?.providerSlug) {
    push(hints.providerSlug);
    const base = hints.providerSlug.trim().toLowerCase().split(/[-_]/)[0];
    if (base) push(base);
  }

  switch (hints?.api) {
    case "google-generative-ai":
    case "google-vertex":
      push("google");
      break;
    case "anthropic-messages":
      push("anthropic");
      break;
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
      push("openai");
      break;
    case "mistral-conversations":
      push("mistral");
      break;
  }

  return candidates;
}

/**
 * Cached client for fetching, searching, and resolving model metadata from models.dev.
 */
export class ModelsDevRegistry {
  private readonly apiUrl: string;
  private readonly cacheTtlMs: number;
  private readonly cacheFilePath: string | null;
  private readonly getProxyRouter?: () => ScopedProxyRouter;
  private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>;

  private cachedCatalog: ModelsDevCatalog | null = null;
  private cachedAtMs = 0;
  private diskHydrated = false;
  private inflightFetch: Promise<ModelsDevCatalog> | null = null;

  constructor(options: ModelsDevRegistryOptions = {}) {
    this.apiUrl = options.apiUrl ?? MODELS_DEV_API_URL;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheFilePath = options.cacheFilePath ?? null;
    this.getProxyRouter = options.getProxyRouter;
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  }

  private hydrateFromDisk(): void {
    if (this.diskHydrated) return;
    this.diskHydrated = true;
    if (!this.cacheFilePath || this.cachedCatalog) return;

    try {
      if (!existsSync(this.cacheFilePath)) return;
      const raw = readFileSync(this.cacheFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ModelsDevDiskCachePayload>;
      if (
        parsed &&
        parsed.version === DISK_CACHE_VERSION &&
        typeof parsed.fetchedAtMs === "number" &&
        Number.isFinite(parsed.fetchedAtMs) &&
        parsed.catalog &&
        typeof parsed.catalog === "object" &&
        !Array.isArray(parsed.catalog)
      ) {
        this.cachedCatalog = parsed.catalog;
        this.cachedAtMs = parsed.fetchedAtMs;
      }
    } catch {
      // Ignore corrupt or unreadable cache files
    }
  }

  private persistToDisk(catalog: ModelsDevCatalog, fetchedAtMs: number): void {
    if (!this.cacheFilePath) return;
    try {
      mkdirSync(dirname(this.cacheFilePath), { recursive: true });
      const tmpPath = `${this.cacheFilePath}.tmp`;
      const payload: ModelsDevDiskCachePayload = {
        version: DISK_CACHE_VERSION,
        fetchedAtMs,
        catalog,
      };
      writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
      renameSync(tmpPath, this.cacheFilePath);
    } catch {
      // Ignore disk write errors so lookups never fail
    }
  }

  private async fetchAndPersist(): Promise<ModelsDevCatalog> {
    if (this.inflightFetch) {
      return this.inflightFetch;
    }

    const doFetch = async (): Promise<ModelsDevCatalog> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const exec = () =>
          this.fetcher(this.apiUrl, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
        const response = this.getProxyRouter
          ? await this.getProxyRouter().runWithScope("web_access", exec)
          : await exec();
        if (!response.ok) {
          throw new Error(`models.dev 返回 HTTP ${response.status}`);
        }
        const parsed = (await response.json()) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("models.dev 返回了无效的 JSON 结构");
        }
        const catalog = parsed as ModelsDevCatalog;
        const now = Date.now();
        this.cachedCatalog = catalog;
        this.cachedAtMs = now;
        this.diskHydrated = true;
        this.persistToDisk(catalog, now);
        return catalog;
      } finally {
        clearTimeout(timer);
        this.inflightFetch = null;
      }
    };

    this.inflightFetch = doFetch();
    return this.inflightFetch;
  }

  warmCache(): void {
    this.hydrateFromDisk();
    const isFresh =
      this.cachedCatalog !== null && Date.now() - this.cachedAtMs < this.cacheTtlMs;
    if (!isFresh && !this.inflightFetch) {
      void this.fetchAndPersist().catch(() => {});
    }
  }

  async getCatalog(forceRefresh = false): Promise<ModelsDevCatalog> {
    this.hydrateFromDisk();
    const now = Date.now();
    if (!forceRefresh && this.cachedCatalog) {
      if (now - this.cachedAtMs >= this.cacheTtlMs && !this.inflightFetch) {
        void this.fetchAndPersist().catch(() => {});
      }
      return this.cachedCatalog;
    }
    return this.fetchAndPersist();
  }

  matchModelFromCache(
    modelId: string,
    hints?: { providerSlug?: string; api?: string },
  ): ModelsDevMappedMetadata | null {
    this.hydrateFromDisk();
    if (!this.cachedCatalog) return null;

    const trimmed = modelId.trim();
    if (!trimmed) return null;

    const matchWithinProvider = (
      providerId: string,
      targetModelId: string,
    ): ModelsDevMappedMetadata | null => {
      const provider = this.cachedCatalog?.[providerId];
      if (!provider?.models) return null;
      const direct = provider.models[targetModelId];
      if (direct) {
        return mapRawModelToMetadata(
          providerId,
          provider.name?.trim() || providerId,
          targetModelId,
          direct,
        );
      }
      const lowerTarget = targetModelId.toLowerCase();
      for (const [key, candidate] of Object.entries(provider.models)) {
        if (key.toLowerCase() === lowerTarget || candidate.id?.toLowerCase() === lowerTarget) {
          return mapRawModelToMetadata(
            providerId,
            provider.name?.trim() || providerId,
            key,
            candidate,
          );
        }
      }
      return null;
    };

    // 1. Direct provider/model lookup when modelId contains "/"
    const parsedRef = parseModelsDevRef(trimmed);
    if (parsedRef) {
      const directMatch = matchWithinProvider(parsedRef.providerId, parsedRef.modelId);
      if (directMatch) return directMatch;
    }

    const searchId = parsedRef ? parsedRef.modelId : trimmed;

    // 2. Preferred providers derived from providerSlug / api hints
    const preferred = derivePreferredProviders(hints);
    for (const providerId of preferred) {
      const match = matchWithinProvider(providerId, searchId);
      if (match) return match;
    }

    // 3. Canonical providers
    const checked = new Set(preferred);
    for (const providerId of CANONICAL_MATCH_PROVIDERS) {
      if (checked.has(providerId)) continue;
      checked.add(providerId);
      const match = matchWithinProvider(providerId, searchId);
      if (match) return match;
    }

    // 4. Remaining providers
    for (const providerId of Object.keys(this.cachedCatalog)) {
      if (checked.has(providerId)) continue;
      const match = matchWithinProvider(providerId, searchId);
      if (match) return match;
    }

    return null;
  }

  async lookup(rawRef: string, forceRefresh = false): Promise<ModelsDevMappedMetadata | null> {
    const parsed = parseModelsDevRef(rawRef);
    if (!parsed) {
      throw new Error(`无效的 models.dev 映射 ID "${rawRef}"，格式应为 <provider>/<model>（例如 openai/gpt-4o）`);
    }

    const catalog = await this.getCatalog(forceRefresh);
    const provider = catalog[parsed.providerId];
    if (provider?.models) {
      const direct = provider.models[parsed.modelId];
      if (direct) {
        return mapRawModelToMetadata(
          parsed.providerId,
          provider.name?.trim() || parsed.providerId,
          parsed.modelId,
          direct,
        );
      }
      // Fallback: case-insensitive match within the specified provider
      const lowerModelId = parsed.modelId.toLowerCase();
      for (const [key, candidate] of Object.entries(provider.models)) {
        if (key.toLowerCase() === lowerModelId || candidate.id?.toLowerCase() === lowerModelId) {
          return mapRawModelToMetadata(
            parsed.providerId,
            provider.name?.trim() || parsed.providerId,
            key,
            candidate,
          );
        }
      }
    }

    return null;
  }

  async search(query: string, limit = 20): Promise<ModelsDevSearchItem[]> {
    const catalog = await this.getCatalog(false);
    const trimmed = query.trim().toLowerCase();
    const clampedLimit = Math.max(1, Math.min(50, limit));

    const scored: Array<{ score: number; item: ModelsDevSearchItem }> = [];

    for (const [providerId, provider] of Object.entries(catalog)) {
      if (!provider?.models) continue;
      const providerName = provider.name?.trim() || providerId;
      for (const [modelId, raw] of Object.entries(provider.models)) {
        const ref = `${providerId}/${modelId}`;
        const modelName = raw.name?.trim() || raw.id?.trim() || modelId;
        if (!trimmed) {
          scored.push({
            score: 1,
            item: {
              ref,
              name: modelName,
              providerName,
              reasoning: Boolean(raw.reasoning),
              supportsVision: Boolean(raw.modalities?.input?.includes("image")),
              contextWindow: toPositiveInt(raw.limit?.context),
              maxTokens: toPositiveInt(raw.limit?.output),
            },
          });
          continue;
        }

        const refLower = ref.toLowerCase();
        const nameLower = modelName.toLowerCase();
        const canonicalLower = raw.canonical_model_id?.toLowerCase() ?? "";

        let score = 0;
        if (refLower === trimmed) score = 100;
        else if (refLower.startsWith(trimmed)) score = 80;
        else if (modelId.toLowerCase().startsWith(trimmed)) score = 70;
        else if (refLower.includes(trimmed)) score = 50;
        else if (nameLower.includes(trimmed)) score = 40;
        else if (canonicalLower.includes(trimmed)) score = 30;

        if (score > 0) {
          scored.push({
            score,
            item: {
              ref,
              name: modelName,
              providerName,
              reasoning: Boolean(raw.reasoning),
              supportsVision: Boolean(raw.modalities?.input?.includes("image")),
              contextWindow: toPositiveInt(raw.limit?.context),
              maxTokens: toPositiveInt(raw.limit?.output),
            },
          });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score || a.item.ref.localeCompare(b.item.ref));
    return scored.slice(0, clampedLimit).map((entry) => entry.item);
  }

  async probe(): Promise<ModelsDevProbeResult> {
    const startedAt = Date.now();
    try {
      const catalog = await this.getCatalog(true);
      let providerCount = 0;
      let modelCount = 0;
      for (const provider of Object.values(catalog)) {
        if (!provider || typeof provider !== "object") continue;
        providerCount += 1;
        if (provider.models && typeof provider.models === "object") {
          modelCount += Object.keys(provider.models).length;
        }
      }
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        providerCount,
        modelCount,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        providerCount: 0,
        modelCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
