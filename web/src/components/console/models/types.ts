import type {
  ModelDefinitionConfig,
  ModelsFileConfig,
  ProviderConfig,
  SecretState,
} from "@/api";

export const API_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Gemini" },
  { value: "hato-faux-api", label: "Faux（本地测试）" },
];

export const API_OVERRIDE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "__inherit__", label: "继承供应商默认协议" },
  ...API_OPTIONS,
];

export type SlotKey = keyof ModelsFileConfig["slots"];

export interface SlotDefinition {
  key: SlotKey;
  label: string;
  accentClass: string;
  pillClass: string;
}

export const SLOT_DEFINITIONS: SlotDefinition[] = [
  {
    key: "persona",
    label: "主对话槽位",
    accentClass: "text-emerald-600 dark:text-emerald-400",
    pillClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  {
    key: "worker",
    label: "后台执行槽位",
    accentClass: "text-amber-600 dark:text-amber-400",
    pillClass:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  {
    key: "router",
    label: "轻量路由槽位",
    accentClass: "text-sky-600 dark:text-sky-400",
    pillClass:
      "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  {
    key: "curator",
    label: "上下文整理槽位",
    accentClass: "text-teal-600 dark:text-teal-400",
    pillClass:
      "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  },
  {
    key: "hindsight_llm",
    label: "记忆抽取槽位",
    accentClass: "text-violet-600 dark:text-violet-400",
    pillClass:
      "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  {
    key: "vision",
    label: "图像理解槽位（未配回退主对话）",
    accentClass: "text-rose-600 dark:text-rose-400",
    pillClass:
      "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
];

export interface ProviderPreset {
  id: string;
  label: string;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKeyEnv: string;
  initialModelId: string;
  initialModelName: string;
  initialModelVision: boolean;
  initialModelThinking: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    name: "deepseek",
    protocol: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    initialModelId: "deepseek-chat",
    initialModelName: "DeepSeek Chat",
    initialModelVision: false,
    initialModelThinking: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    name: "openai",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    initialModelId: "gpt-4.1-mini",
    initialModelName: "GPT-4.1 Mini",
    initialModelVision: true,
    initialModelThinking: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    name: "anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    initialModelId: "claude-sonnet-4-5",
    initialModelName: "Claude Sonnet 4.5",
    initialModelVision: true,
    initialModelThinking: true,
  },
  {
    id: "gemini",
    label: "Gemini",
    name: "google",
    protocol: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    initialModelId: "gemini-2.5-flash",
    initialModelName: "Gemini 2.5 Flash",
    initialModelVision: true,
    initialModelThinking: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    name: "openrouter",
    protocol: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    initialModelId: "anthropic/claude-sonnet-4.5",
    initialModelName: "Claude Sonnet 4.5 (OR)",
    initialModelVision: true,
    initialModelThinking: true,
  },
  {
    id: "ollama",
    label: "Ollama 本地",
    name: "ollama",
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    initialModelId: "qwen2.5:14b",
    initialModelName: "Qwen 2.5 14B",
    initialModelVision: false,
    initialModelThinking: false,
  },
];

export interface ModelAdvancedParams {
  contextWindow: string;
  maxOutputTokens: string;
  apiOverride: string;
  baseUrlOverride: string;
  customHeaders: string;
}

export interface ModelMetadataMapping {
  enabled: boolean;
  modelRef: string;
}

export interface UiModelEntry {
  uid: string;
  id: string;
  displayName: string;
  supportsVision: boolean;
  supportsThinking: boolean;
  modelsDev: ModelMetadataMapping;
  advanced: ModelAdvancedParams;
  preserved?: Pick<
    ModelDefinitionConfig,
    "cache_ttl_minutes" | "cost" | "thinking_level_map" | "compat"
  >;
}

export interface UiProviderConfig {
  uid: string;
  name: string;
  displayName?: string;
  protocol: string;
  baseUrl: string;
  apiKeyEnv: string;
  cacheTtlMinutes: string;
  customHeaders: string;
  models: UiModelEntry[];
  preserved?: Pick<ProviderConfig, "slug" | "compat">;
}

export interface ProviderDraft {
  name: string;
  displayName: string;
  protocol: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKeyValue: string;
  cacheTtlMinutes: string;
  customHeaders: string;
  includeInitialModel: boolean;
  initialModelId: string;
  initialModelName: string;
  initialModelVision: boolean;
  initialModelThinking: boolean;
  updatedAt?: string;
}

export type KeyStatus = "pending" | "configured" | "missing" | "not-needed";

export function resolveProviderKeyStatus(
  provider: Pick<UiProviderConfig, "protocol" | "apiKeyEnv">,
  secretStates: SecretState[],
  pendingSecrets: Record<string, string>,
): { status: KeyStatus; masked?: string } {
  if (provider.protocol === "hato-faux-api") {
    return { status: "not-needed" };
  }
  const envKey = provider.apiKeyEnv.trim();
  if (!envKey) {
    return { status: "missing" };
  }
  if (pendingSecrets[envKey]?.trim()) {
    return { status: "pending" };
  }
  const matched = secretStates.find((s) => s.key === envKey);
  if (matched?.configured) {
    return { status: "configured", masked: matched.masked };
  }
  return { status: "missing" };
}

export function deriveEnvName(providerName: string): string {
  const clean = providerName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return clean ? `${clean}_API_KEY` : "";
}

export function createUid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function formatTokenCount(raw: string): string | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = Math.round(n / 1_000);
    return `${k}K`;
  }
  return String(Math.round(n));
}

export function generateUniqueModelId(
  existingModels: Array<Pick<UiModelEntry, "id">>,
  base = "new-model",
): string {
  const taken = new Set(existingModels.map((m) => m.id.trim().toLowerCase()));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) {
    n += 1;
  }
  return `${base}-${n}`;
}

export function parseHeadersJson(
  raw: string,
  contextLabel = "请求头",
): { ok: true; headers?: Record<string, string> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, headers: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `${contextLabel} JSON 格式无效：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `${contextLabel}必须是 JSON 对象（例如 {"X-Custom": "1"}）`,
    };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.trim()) continue;
    if (v === undefined || v === null || typeof v === "object") {
      return {
        ok: false,
        error: `${contextLabel}字段 "${k}" 值必须为字符串或基础类型`,
      };
    }
    out[k] = String(v);
  }
  return {
    ok: true,
    headers: Object.keys(out).length > 0 ? out : undefined,
  };
}

export function validatePositiveIntInput(
  raw: string,
  fieldLabel: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: `${fieldLabel}不能为空` };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return { ok: false, error: `${fieldLabel}必须是大于 0 的整数` };
  }
  return { ok: true, value: n };
}

export function toUiProviders(config: ModelsFileConfig): UiProviderConfig[] {
  return Object.entries(config.providers).map(([slug, prov], provIndex) => ({
    uid: `prov-${provIndex}-${slug}`,
    name: slug,
    displayName: prov.name ?? "",
    protocol: prov.api,
    baseUrl: prov.base_url,
    apiKeyEnv: prov.api_key_env?.trim() || deriveEnvName(slug),
    cacheTtlMinutes:
      prov.cache_ttl_minutes !== undefined ? String(prov.cache_ttl_minutes) : "",
    customHeaders:
      prov.headers && Object.keys(prov.headers).length > 0
        ? JSON.stringify(prov.headers)
        : "",
    preserved: {
      slug: prov.slug,
      compat: prov.compat,
    },
    models: prov.models.map((m, modIndex) => ({
      uid: `mod-${provIndex}-${modIndex}-${m.id}`,
      id: m.id,
      displayName: m.name ?? m.id,
      supportsVision: Boolean(m.input?.includes("image")),
      supportsThinking: Boolean(m.reasoning),
      modelsDev: {
        enabled: false,
        modelRef: "",
      },
      advanced: {
        contextWindow: m.context_window !== undefined ? String(m.context_window) : "128000",
        maxOutputTokens: m.max_tokens !== undefined ? String(m.max_tokens) : "8192",
        apiOverride: m.api ?? "__inherit__",
        baseUrlOverride: m.base_url ?? "",
        customHeaders:
          m.headers && Object.keys(m.headers).length > 0 ? JSON.stringify(m.headers) : "",
      },
      preserved: {
        cache_ttl_minutes: m.cache_ttl_minutes,
        cost: m.cost,
        thinking_level_map: m.thinking_level_map,
        compat: m.compat,
      },
    })),
  }));
}

export type BuildModelsResult =
  | { ok: true; config: ModelsFileConfig }
  | { ok: false; error: string; providerUid?: string; modelUid?: string };

export function buildApiModelsConfig(
  slots: ModelsFileConfig["slots"],
  providers: UiProviderConfig[],
): BuildModelsResult {
  const apiProviders: Record<string, ProviderConfig> = {};

  for (const prov of providers) {
    const slug = prov.name.trim();
    if (!slug) {
      return { ok: false, error: "存在未填写名称的供应商", providerUid: prov.uid };
    }
    if (/\s|\//.test(slug)) {
      return {
        ok: false,
        error: `供应商名称 "${slug}" 不能包含空格或 "/"`,
        providerUid: prov.uid,
      };
    }
    if (apiProviders[slug]) {
      return {
        ok: false,
        error: `供应商名称 "${slug}" 重复`,
        providerUid: prov.uid,
      };
    }
    if (!prov.baseUrl.trim()) {
      return {
        ok: false,
        error: `供应商 "${slug}" 缺少 Base URL`,
        providerUid: prov.uid,
      };
    }

    const provHeadersRes = parseHeadersJson(
      prov.customHeaders,
      `供应商 "${slug}" 请求头`,
    );
    if (!provHeadersRes.ok) {
      return { ok: false, error: provHeadersRes.error, providerUid: prov.uid };
    }

    let parsedCacheTtl: number | undefined;
    if (prov.cacheTtlMinutes.trim()) {
      const ttlRes = validatePositiveIntInput(
        prov.cacheTtlMinutes,
        `供应商 "${slug}" 缓存 TTL`,
      );
      if (!ttlRes.ok) {
        return { ok: false, error: ttlRes.error, providerUid: prov.uid };
      }
      parsedCacheTtl = ttlRes.value;
    }

    const seenModelIds = new Set<string>();
    const apiModels: ModelDefinitionConfig[] = [];
    for (const m of prov.models) {
      const modelId = m.id.trim();
      if (!modelId) {
        return {
          ok: false,
          error: `供应商 "${slug}" 下存在未填写模型 ID 的条目`,
          providerUid: prov.uid,
          modelUid: m.uid,
        };
      }
      if (/\s/.test(modelId)) {
        return {
          ok: false,
          error: `模型 ID "${modelId}" 不能包含空白字符`,
          providerUid: prov.uid,
          modelUid: m.uid,
        };
      }
      if (seenModelIds.has(modelId)) {
        return {
          ok: false,
          error: `供应商 "${slug}" 下存在重复的模型 ID "${modelId}"`,
          providerUid: prov.uid,
          modelUid: m.uid,
        };
      }
      seenModelIds.add(modelId);

      const label = `${slug}/${modelId}`;
      const ctxRes = validatePositiveIntInput(
        m.advanced.contextWindow,
        `模型 "${label}" 上下文窗口`,
      );
      if (!ctxRes.ok) {
        return { ok: false, error: ctxRes.error, providerUid: prov.uid, modelUid: m.uid };
      }

      const maxOutRes = validatePositiveIntInput(
        m.advanced.maxOutputTokens,
        `模型 "${label}" 最大输出`,
      );
      if (!maxOutRes.ok) {
        return { ok: false, error: maxOutRes.error, providerUid: prov.uid, modelUid: m.uid };
      }

      const headersRes = parseHeadersJson(
        m.advanced.customHeaders,
        `模型 "${label}" 自定义请求头`,
      );
      if (!headersRes.ok) {
        return { ok: false, error: headersRes.error, providerUid: prov.uid, modelUid: m.uid };
      }

      const apiModel: ModelDefinitionConfig = {
        id: modelId,
        name: m.displayName.trim() || modelId,
        reasoning: m.supportsThinking,
        input: m.supportsVision ? ["text", "image"] : ["text"],
        context_window: ctxRes.value,
        max_tokens: maxOutRes.value,
      };

      if (m.advanced.apiOverride && m.advanced.apiOverride !== "__inherit__") {
        apiModel.api = m.advanced.apiOverride;
      }
      if (m.advanced.baseUrlOverride.trim()) {
        apiModel.base_url = m.advanced.baseUrlOverride.trim();
      }
      if (headersRes.headers) {
        apiModel.headers = headersRes.headers;
      }
      if (m.preserved?.cache_ttl_minutes !== undefined) {
        apiModel.cache_ttl_minutes = m.preserved.cache_ttl_minutes;
      }
      if (m.preserved?.cost !== undefined) {
        apiModel.cost = m.preserved.cost;
      }
      if (m.preserved?.thinking_level_map !== undefined) {
        apiModel.thinking_level_map = m.preserved.thinking_level_map;
      }
      if (m.preserved?.compat !== undefined) {
        apiModel.compat = m.preserved.compat;
      }

      apiModels.push(apiModel);
    }

    const apiProv: ProviderConfig = {
      api: prov.protocol,
      base_url: prov.baseUrl.trim(),
      api_key_env: prov.apiKeyEnv.trim() || deriveEnvName(slug),
      models: apiModels,
    };

    const trimmedDisplay = prov.displayName?.trim() ?? "";
    if (trimmedDisplay && trimmedDisplay !== slug) {
      apiProv.name = trimmedDisplay;
    }
    if (prov.preserved?.slug && prov.preserved.slug === slug) {
      apiProv.slug = prov.preserved.slug;
    }
    if (parsedCacheTtl !== undefined) {
      apiProv.cache_ttl_minutes = parsedCacheTtl;
    }
    if (provHeadersRes.headers) {
      apiProv.headers = provHeadersRes.headers;
    }
    if (prov.preserved?.compat !== undefined) {
      apiProv.compat = prov.preserved.compat;
    }

    apiProviders[slug] = apiProv;
  }

  return {
    ok: true,
    config: {
      slots: { ...slots },
      providers: apiProviders,
    },
  };
}

export function serializeComparableState(
  slots: ModelsFileConfig["slots"],
  providers: UiProviderConfig[],
): string {
  return JSON.stringify({
    slots,
    providers: providers.map((p) => ({
      name: p.name,
      displayName: p.displayName ?? "",
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKeyEnv: p.apiKeyEnv,
      cacheTtlMinutes: p.cacheTtlMinutes,
      customHeaders: p.customHeaders,
      models: p.models.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        supportsVision: m.supportsVision,
        supportsThinking: m.supportsThinking,
        advanced: m.advanced,
      })),
    })),
  });
}
