import type { ModelsDevMappedMetadata } from "./models-dev.js";
import type { ScopedProxyRouter } from "./proxy.js";

const FETCH_TIMEOUT_MS = 15_000;

export interface UpstreamModelEntry {
  id: string;
  name?: string;
  ownedBy?: string;
  created?: number;
  group: string;
  modelsDev?: ModelsDevMappedMetadata;
}

export interface FetchUpstreamModelsParams {
  providerSlug: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
  providerHeaders?: Record<string, string>;
  proxyRouter?: ScopedProxyRouter;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface FetchUpstreamModelsResult {
  models: UpstreamModelEntry[];
  fetchedFrom: string;
  latencyMs: number;
}

const GROUP_PREFIX_RULES: Array<[RegExp, string]> = [
  [/^(gpt-|o[134](?:-|$)|chatgpt)/i, "openai"],
  [/^claude-/i, "claude"],
  [/^(gemini-|gemma-)/i, "gemini"],
  [/^deepseek-/i, "deepseek"],
  [/^(qwen|qwq)/i, "qwen"],
  [/^glm-/i, "glm"],
  [/^(kimi-|moonshot-)/i, "moonshot"],
  [/^minimax-/i, "minimax"],
  [/^grok-/i, "grok"],
  [/^llama/i, "llama"],
  [/^(mistral|mixtral|codestral)/i, "mistral"],
];

/**
 * Infer a Cherry Studio–style group name from a model ID (and optional ownedBy).
 */
export function inferModelGroup(modelId: string, ownedBy?: string): string {
  const trimmed = modelId.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx > 0) {
    return trimmed.slice(0, slashIdx).toLowerCase();
  }
  for (const [pattern, group] of GROUP_PREFIX_RULES) {
    if (pattern.test(trimmed)) {
      return group;
    }
  }
  const dashIdx = trimmed.indexOf("-");
  if (dashIdx > 0) {
    return trimmed.slice(0, dashIdx).toLowerCase();
  }
  const owner = ownedBy?.trim();
  if (owner && owner !== "system" && owner !== "organization-owner") {
    return owner.toLowerCase();
  }
  return "other";
}

function buildModelsEndpointUrl(api: string, rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  const cleaned = trimmed.replace(/\/(chat\/completions|responses|models)$/i, "");

  if (api === "anthropic-messages") {
    const hasVersion = /\/v\d+(?:alpha|beta)?$/i.test(cleaned);
    return hasVersion ? `${cleaned}/models` : `${cleaned}/v1/models`;
  }

  if (api === "google-generative-ai") {
    const sep = cleaned.includes("?") ? "&" : "?";
    return `${cleaned}/models${sep}pageSize=1000`;
  }

  return `${cleaned}/models`;
}

function parseOpenAiStyleModels(
  payload: unknown,
): Array<{ id: string; name?: string; ownedBy?: string; created?: number }> {
  const rawList = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : Array.isArray((payload as { models?: unknown }).models)
          ? (payload as { models: unknown[] }).models
          : null
      : null;

  if (!rawList) {
    throw new Error("上游返回的模型列表格式无法识别");
  }

  const out: Array<{ id: string; name?: string; ownedBy?: string; created?: number }> = [];
  for (const item of rawList) {
    if (typeof item === "string" && item.trim()) {
      out.push({ id: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const rawId =
      typeof rec.id === "string"
        ? rec.id
        : typeof rec.name === "string"
          ? rec.name
          : "";
    const id = rawId.trim();
    if (!id) continue;
    const displayName =
      typeof rec.display_name === "string" && rec.display_name.trim()
        ? rec.display_name.trim()
        : typeof rec.name === "string" && rec.name.trim() && rec.name.trim() !== id
          ? rec.name.trim()
          : undefined;
    const ownedBy =
      typeof rec.owned_by === "string" && rec.owned_by.trim()
        ? rec.owned_by.trim()
        : undefined;
    const created =
      typeof rec.created === "number" && Number.isFinite(rec.created)
        ? rec.created
        : undefined;
    out.push({ id, name: displayName, ownedBy, created });
  }
  return out;
}

function parseAnthropicModels(
  payload: unknown,
): Array<{ id: string; name?: string; ownedBy?: string; created?: number }> {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("Anthropic 上游返回的模型列表格式无法识别");
  }
  const out: Array<{ id: string; name?: string; ownedBy?: string; created?: number }> = [];
  for (const item of (payload as { data: unknown[] }).data) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;
    const name =
      typeof rec.display_name === "string" && rec.display_name.trim()
        ? rec.display_name.trim()
        : undefined;
    out.push({ id, name, ownedBy: "anthropic" });
  }
  return out;
}

function parseGoogleGeminiModels(
  payload: unknown,
): Array<{ id: string; name?: string; ownedBy?: string; created?: number }> {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { models?: unknown }).models)) {
    throw new Error("Google Gemini 上游返回的模型列表格式无法识别");
  }
  const out: Array<{ id: string; name?: string; ownedBy?: string; created?: number }> = [];
  for (const item of (payload as { models: unknown[] }).models) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const rawName = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!rawName) continue;
    const id = rawName.replace(/^models\//, "");
    if (!id) continue;
    const displayName =
      typeof rec.displayName === "string" && rec.displayName.trim()
        ? rec.displayName.trim()
        : undefined;
    out.push({ id, name: displayName, ownedBy: "google" });
  }
  return out;
}

/**
 * Fetch available model IDs from an upstream provider's `/models` endpoint.
 */
export async function fetchUpstreamModels(
  params: FetchUpstreamModelsParams,
): Promise<FetchUpstreamModelsResult> {
  const api = params.api.trim();
  if (api === "hato-faux-api") {
    throw new Error("Faux 本地测试供应商没有上游模型名单，请使用手动添加。");
  }

  const baseUrl = params.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("请先配置供应商 Base URL");
  }

  const endpointUrl = buildModelsEndpointUrl(api, baseUrl);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(params.providerHeaders ?? {}),
  };

  const apiKey = params.apiKey?.trim();
  if (api === "anthropic-messages") {
    if (apiKey && !headers["x-api-key"] && !headers["X-Api-Key"]) {
      headers["x-api-key"] = apiKey;
    }
    if (!headers["anthropic-version"]) {
      headers["anthropic-version"] = "2023-06-01";
    }
  } else if (api === "google-generative-ai") {
    if (apiKey && !headers["x-goog-api-key"] && !headers["X-Goog-Api-Key"]) {
      headers["x-goog-api-key"] = apiKey;
    }
  } else {
    if (apiKey && !headers["Authorization"] && !headers["authorization"]) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }

  const fetcher = params.fetcher ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const exec = () =>
      fetcher(endpointUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

    const response = params.proxyRouter
      ? await params.proxyRouter.runWithScope(`llm-calling.${params.providerSlug.trim()}`, exec)
      : await exec();

    if (!response.ok) {
      let detail = "";
      try {
        const text = (await response.text()).trim();
        if (text) detail = `：${text.slice(0, 180)}`;
      } catch {
        // ignore body read failure
      }
      throw new Error(`上游返回 HTTP ${response.status}${detail}`);
    }

    const payload = (await response.json()) as unknown;
    const rawItems =
      api === "anthropic-messages"
        ? parseAnthropicModels(payload)
        : api === "google-generative-ai"
          ? parseGoogleGeminiModels(payload)
          : parseOpenAiStyleModels(payload);

    const deduped = new Map<string, UpstreamModelEntry>();
    for (const item of rawItems) {
      const existing = deduped.get(item.id);
      if (existing) {
        if (!existing.name && item.name) existing.name = item.name;
        continue;
      }
      deduped.set(item.id, {
        id: item.id,
        ...(item.name ? { name: item.name } : {}),
        ...(item.ownedBy ? { ownedBy: item.ownedBy } : {}),
        ...(item.created !== undefined ? { created: item.created } : {}),
        group: inferModelGroup(item.id, item.ownedBy),
      });
    }

    const models = Array.from(deduped.values()).sort(
      (a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id),
    );

    return {
      models,
      fetchedFrom: endpointUrl.replace(/([?&]key=)[^&]+/i, "$1***"),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
