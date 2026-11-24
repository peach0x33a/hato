import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logWarn } from "../utils/logger.js";
import {
  clampThinkingLevel,
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type KnownApi,
  type Model,
  type ModelThinkingLevel,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseToml } from "smol-toml";
import type { HatoRepository } from "../db/repo.js";
import { requireSecret } from "./secrets.js";

export const KNOWN_APIS: readonly KnownApi[] = [
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "pi-messages",
];

export function supportsCustomFetchOption(api: Api): boolean {
  return api !== "google-generative-ai" && api !== "google-vertex";
}

export function resolveBuiltInApiStreams(api: Api): ProviderStreams | undefined {
  switch (api) {
    case "openai-completions":
      return openAICompletionsApi();
    case "openai-responses":
      return openAIResponsesApi();
    case "azure-openai-responses":
      return azureOpenAIResponsesApi();
    case "openai-codex-responses":
      return openAICodexResponsesApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
    case "bedrock-converse-stream":
      return bedrockConverseStreamApi();
    case "google-generative-ai":
      return googleGenerativeAIApi();
    case "google-vertex":
      return googleVertexApi();
    case "mistral-conversations":
      return mistralConversationsApi();
    case "pi-messages":
      return piMessagesApi();
    default:
      return undefined;
  }
}

export const PROVIDER_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Derive `<UPPER_SNAKE_SLUG>_API_KEY` from a provider slug.
 * Examples:
 * - `"CustomRelay"` -> `"CUSTOMRELAY_API_KEY"`
 * - `"google-gateway"` -> `"GOOGLE_GATEWAY_API_KEY"`
 */
export function deriveApiKeyEnvFromSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed || !PROVIDER_SLUG_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid provider slug "${slug}". Expected ${PROVIDER_SLUG_PATTERN} (cannot contain "/" or whitespace).`,
    );
  }
  const upperPrefix = trimmed
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!upperPrefix) {
    throw new Error(`Cannot derive API key env variable from provider slug "${slug}".`);
  }
  return `${upperPrefix}_API_KEY`;
}

/**
 * Parse a `<provider_slug>/<model_id>` model reference, enforcing a non-empty provider prefix.
 * Preserves nested slashes inside `model_id` (e.g. `"openrouter/anthropic/claude-sonnet-4-5"`).
 */
export function parseQualifiedModelTarget(targetInput: string): {
  providerSlug: string;
  modelId: string;
  target: string;
} {
  const trimmed = targetInput.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) {
    throw new Error(
      `Model selection "${targetInput}" must include the provider prefix "<provider>/<model_id>".`,
    );
  }
  const providerSlug = trimmed.slice(0, slashIdx);
  const modelId = trimmed.slice(slashIdx + 1);
  if (!PROVIDER_SLUG_PATTERN.test(providerSlug) || !modelId || /\s/.test(modelId)) {
    throw new Error(
      `Invalid model target "${targetInput}". Expected "<provider>/<model_id>" with a valid provider slug.`,
    );
  }
  return {
    providerSlug,
    modelId,
    target: `${providerSlug}/${modelId}`,
  };
}

export const MODEL_SLOTS = [
  "persona",
  "router",
  "curator",
  "worker",
  "hindsight_llm",
  "vision",
] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

export const THINKING_LEVEL_OPTIONS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ConfiguredThinkingLevel = (typeof THINKING_LEVEL_OPTIONS)[number];

export const DEFAULT_SLOT_THINKING_LEVEL: Record<ModelSlot, ModelThinkingLevel> = {
  persona: "medium",
  router: "minimal",
  curator: "minimal",
  worker: "medium",
  hindsight_llm: "minimal",
  vision: "off",
};

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const ModelEntrySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  api: Type.Optional(Type.String({ minLength: 1 })),
  base_url: Type.Optional(Type.String({ minLength: 1 })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  cache_ttl_minutes: Type.Optional(Type.Number({ minimum: 1 })),
  explicit_cache: Type.Optional(Type.Boolean()),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  context_window: Type.Optional(Type.Number({ minimum: 1 })),
  max_tokens: Type.Optional(Type.Number({ minimum: 1 })),
  cost: Type.Optional(
    Type.Object({
      input: Type.Optional(Type.Number({ minimum: 0 })),
      output: Type.Optional(Type.Number({ minimum: 0 })),
      cache_read: Type.Optional(Type.Number({ minimum: 0 })),
      cache_write: Type.Optional(Type.Number({ minimum: 0 })),
    }),
  ),
  thinking_level_map: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  models_dev: Type.Optional(
    Type.Object({
      enabled: Type.Boolean(),
      model_ref: Type.String(),
    }),
  ),
});

const ProviderConfigSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  slug: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.String({ minLength: 1 }),
  base_url: Type.String({ minLength: 1 }),
  api_key_env: Type.Optional(Type.String({ minLength: 1 })),
  cache_ttl_minutes: Type.Optional(Type.Number({ minimum: 1 })),
  explicit_cache: Type.Optional(Type.Boolean()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  models: Type.Array(ModelEntrySchema),
});

export const ModelsFileSchema = Type.Object({
  slots: Type.Object({
    persona: Type.String({ minLength: 3 }),
    router: Type.String({ minLength: 3 }),
    curator: Type.String({ minLength: 3 }),
    worker: Type.String({ minLength: 3 }),
    hindsight_llm: Type.String({ minLength: 3 }),
    vision: Type.Optional(Type.String({ minLength: 3 })),
  }),
  slot_thinking: Type.Optional(
    Type.Object({
      persona: Type.Optional(ThinkingLevelSchema),
      router: Type.Optional(ThinkingLevelSchema),
      curator: Type.Optional(ThinkingLevelSchema),
      worker: Type.Optional(ThinkingLevelSchema),
      hindsight_llm: Type.Optional(ThinkingLevelSchema),
      vision: Type.Optional(ThinkingLevelSchema),
    }),
  ),
  providers: Type.Record(Type.String(), ProviderConfigSchema),
});

export type ModelsFileConfig = Static<typeof ModelsFileSchema>;

export interface ResolvedProviderMeta {
  slug: string;
  name: string;
  api: Api;
  baseUrl: string;
  apiKeyEnv: string;
  cacheTtlMinutes: number;
  explicitCache: boolean;
  models: Model<Api>[];
}

export interface ResolvedTargetModel {
  target: string;
  providerSlug: string;
  /** Kept equal to providerSlug for caller compatibility (e.g. proxy scope & trace provider column). */
  providerName: string;
  providerDisplayName: string;
  apiKeyEnv: string;
  cacheTtlMinutes: number;
  explicitCache: boolean;
  model: Model<Api>;
}

export interface ResolvedModelSlot extends ResolvedTargetModel {
  slot: ModelSlot;
}

export interface ModelRegistryOptions {
  /** Optional programmatic providers (e.g., fauxProvider in tests) registered alongside TOML providers. */
  extraProviders?: Provider[];
}

const SLOT_OVERRIDES_SETTING_KEY = "model_slot_overrides";
const SLOT_THINKING_OVERRIDES_SETTING_KEY = "model_slot_thinking_overrides";

function parseHostname(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Resolve compatibility overrides for a model.
 *
 * `@earendil-works/pi-ai` only exempts a small hardcoded list of non-OpenAI endpoints in
 * `openai-completions`, so custom slugs or third-party relays default to `supportsDeveloperRole: true`,
 * `supportsStore: true`, `supportsLongCacheRetention: true`, and `max_completion_tokens`.
 * Many OpenAI-compatible servers reject `role: "developer"` (HTTP 422/400) or unknown fields.
 * Explicit `providerCompat` / `modelCompat` entries always take precedence over inferred defaults.
 */
export function resolveModelCompat(params: {
  api: Api;
  providerSlug: string;
  baseUrl: string;
  modelId: string;
  providerCompat?: Record<string, unknown>;
  modelCompat?: Record<string, unknown>;
}): Model<Api>["compat"] {
  const host = parseHostname(params.baseUrl);
  const slug = params.providerSlug.trim().toLowerCase();
  const modelId = params.modelId.trim();

  const inferred: Record<string, unknown> = {};

  if (params.api === "openai-completions") {
    const isOfficialOpenAIHost =
      host === "api.openai.com" ||
      host.endsWith(".openai.azure.com") ||
      host.endsWith(".cognitiveservices.azure.com");
    const isOpenRouter =
      slug === "openrouter" ||
      host === "openrouter.ai" ||
      host.endsWith(".openrouter.ai");
    const isGithubCopilot =
      slug === "github-copilot" ||
      host === "api.githubcopilot.com" ||
      host.endsWith(".githubcopilot.com");

    if (!isOfficialOpenAIHost && !isOpenRouter && !isGithubCopilot) {
      inferred.supportsDeveloperRole = false;
      inferred.supportsStore = false;
      inferred.supportsLongCacheRetention = false;
      if (!/(?:^|\/)(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/i.test(modelId)) {
        inferred.maxTokensField = "max_tokens";
      }

      if (slug === "mistral" || host === "api.mistral.ai" || host.endsWith(".mistral.ai")) {
        inferred.supportsReasoningEffort = false;
      } else if (host.includes("dashscope") || slug === "dashscope" || slug === "qwen") {
        inferred.thinkingFormat = "qwen";
        inferred.supportsReasoningEffort = false;
      } else if (slug === "minimax" || slug === "minimax-cn" || host.includes("minimax")) {
        inferred.supportsReasoningEffort = false;
      } else if (
        slug === "zhipuai" ||
        slug === "zhipu" ||
        slug === "zai" ||
        slug === "zai-coding-cn" ||
        host.endsWith("bigmodel.cn") ||
        host.endsWith("z.ai")
      ) {
        inferred.thinkingFormat = "zai";
        inferred.supportsReasoningEffort = false;
      } else if (host.includes("volces.com") || host.includes("bytepluses.com")) {
        inferred.supportsReasoningEffort = false;
      }
    }
  }

  const merged: Record<string, unknown> = {
    ...inferred,
    ...(params.providerCompat ?? {}),
    ...(params.modelCompat ?? {}),
  };

  return Object.keys(merged).length > 0 ? (merged as Model<Api>["compat"]) : undefined;
}

interface StoredProviderRecord extends ResolvedProviderMeta {
  isExtra: boolean;
}

interface BuiltModelsCatalog {
  config: ModelsFileConfig;
  providersBySlug: Map<string, StoredProviderRecord>;
  modelsByTarget: Map<string, ResolvedTargetModel>;
  providers: Provider[];
}

/**
 * Validate a parsed models.toml object (schema, provider slugs, N:M model IDs, and prefixed slots).
 */
export function validateModelsConfigObject(
  rawParsed: unknown,
  sourceLabel = "models config",
): ModelsFileConfig {
  return buildValidatedModelsCatalog(rawParsed, sourceLabel, []).config;
}

/**
 * Parse and validate config/models.toml without mutating a runtime registry or SQLite overrides.
 */
export function loadModelsFileConfig(configPath = "config/models.toml"): ModelsFileConfig {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    throw new Error(
      `Models config not found: ${absPath}. Run "npm run setup" or copy config/models.example.toml to ${configPath} first.`,
    );
  }
  const raw = readFileSync(absPath, "utf8");
  return validateModelsConfigObject(parseToml(raw), absPath);
}

function buildValidatedModelsCatalog(
  rawParsed: unknown,
  sourceLabel: string,
  extraProviders: readonly Provider[],
): BuiltModelsCatalog {
  if (!Value.Check(ModelsFileSchema, rawParsed)) {
    const errors = [...Value.Errors(ModelsFileSchema, rawParsed)]
      .slice(0, 6)
      .map((err) => `${err.path || "<root>"}: ${err.message}`)
      .join("; ");
    throw new Error(`Invalid models config (${sourceLabel}): ${errors}`);
  }

  const nextProvidersBySlug = new Map<string, StoredProviderRecord>();
  const nextMap = new Map<string, ResolvedTargetModel>();
  const nextProviders: Provider[] = [];

  for (const extra of extraProviders) {
    if (nextProvidersBySlug.has(extra.id)) {
      throw new Error(`Duplicate extra provider slug "${extra.id}".`);
    }
    const extraModels = [...extra.getModels()];
    const firstModelApi = (extraModels[0]?.api ?? "hato-faux-api") as Api;
    nextProviders.push(extra);
    nextProvidersBySlug.set(extra.id, {
      slug: extra.id,
      name: extra.name || extra.id,
      api: firstModelApi,
      baseUrl: extra.baseUrl ?? "",
      apiKeyEnv: "",
      cacheTtlMinutes: inferDefaultCacheTtl(firstModelApi),
      explicitCache: true,
      models: extraModels,
      isExtra: true,
    });
    for (const m of extraModels) {
      const target = `${extra.id}/${m.id}`;
      nextMap.set(target, {
        target,
        providerSlug: extra.id,
        providerName: extra.id,
        providerDisplayName: extra.name || extra.id,
        apiKeyEnv: "",
        cacheTtlMinutes: inferDefaultCacheTtl(m.api),
        explicitCache: true,
        model: m,
      });
    }
  }

  for (const [providerKey, providerCfg] of Object.entries(rawParsed.providers)) {
    const providerSlug = (providerCfg.slug ?? providerKey).trim();
    const derivedEnv = deriveApiKeyEnvFromSlug(providerSlug);
    if (nextProvidersBySlug.has(providerSlug)) {
      throw new Error(`Duplicate provider slug "${providerSlug}" in ${sourceLabel}`);
    }

    const providerDisplayName = (providerCfg.name ?? providerSlug).trim();
    const apiKeyEnv = providerCfg.api_key_env?.trim() || derivedEnv;

    const defaultApi = providerCfg.api as Api;
    const defaultStreams = resolveBuiltInApiStreams(defaultApi);
    if (!defaultStreams) {
      throw new Error(
        `Unsupported model api "${defaultApi}" for provider "${providerSlug}" in ${sourceLabel}. Supported APIs: ${KNOWN_APIS.join(", ")}`,
      );
    }

    const defaultTtl = providerCfg.cache_ttl_minutes ?? inferDefaultCacheTtl(defaultApi);
    const defaultExplicitCache = providerCfg.explicit_cache ?? true;
    const builtModels: Model<Api>[] = [];
    const seenModelIdsInProvider = new Set<string>();
    const apiStreamsMap: Partial<Record<Api, ProviderStreams>> = {
      [defaultApi]: defaultStreams,
    };

    for (const entry of providerCfg.models) {
      const modelId = entry.id.trim();
      if (!modelId || /\s/.test(modelId)) {
        throw new Error(`Invalid model id "${entry.id}" under provider "${providerSlug}" in ${sourceLabel}`);
      }
      if (seenModelIdsInProvider.has(modelId)) {
        throw new Error(`Duplicate model id "${modelId}" under provider "${providerSlug}" in ${sourceLabel}`);
      }
      seenModelIdsInProvider.add(modelId);

      const modelApi = (entry.api ?? defaultApi) as Api;
      if (!apiStreamsMap[modelApi]) {
        const modelStreams = resolveBuiltInApiStreams(modelApi);
        if (!modelStreams) {
          throw new Error(
            `Unsupported model api "${modelApi}" for "${providerSlug}/${modelId}" in ${sourceLabel}. Supported APIs: ${KNOWN_APIS.join(", ")}`,
          );
        }
        apiStreamsMap[modelApi] = modelStreams;
      }

      const mergedHeaders =
        providerCfg.headers || entry.headers
          ? { ...(providerCfg.headers ?? {}), ...(entry.headers ?? {}) }
          : undefined;

      const target = `${providerSlug}/${modelId}`;
      const model: Model<Api> = {
        id: modelId,
        name: entry.name,
        api: modelApi,
        provider: providerSlug,
        baseUrl: entry.base_url ?? providerCfg.base_url,
        reasoning: entry.reasoning ?? false,
        thinkingLevelMap: entry.thinking_level_map,
        input: entry.input ?? ["text"],
        cost: {
          input: entry.cost?.input ?? 0,
          output: entry.cost?.output ?? 0,
          cacheRead: entry.cost?.cache_read ?? 0,
          cacheWrite: entry.cost?.cache_write ?? 0,
        },
        contextWindow: entry.context_window ?? 128_000,
        maxTokens: entry.max_tokens ?? 8_192,
        headers: mergedHeaders,
        compat: resolveModelCompat({
          api: modelApi,
          providerSlug,
          baseUrl: entry.base_url ?? providerCfg.base_url,
          modelId,
          providerCompat: providerCfg.compat,
          modelCompat: entry.compat,
        }),
      };

      builtModels.push(model);
      nextMap.set(target, {
        target,
        providerSlug,
        providerName: providerSlug,
        providerDisplayName,
        apiKeyEnv,
        cacheTtlMinutes: entry.cache_ttl_minutes ?? providerCfg.cache_ttl_minutes ?? inferDefaultCacheTtl(modelApi),
        explicitCache: entry.explicit_cache ?? defaultExplicitCache,
        model,
      });
    }

    nextProvidersBySlug.set(providerSlug, {
      slug: providerSlug,
      name: providerDisplayName,
      api: defaultApi,
      baseUrl: providerCfg.base_url,
      apiKeyEnv,
      cacheTtlMinutes: defaultTtl,
      explicitCache: defaultExplicitCache,
      models: builtModels,
      isExtra: false,
    });

    nextProviders.push(
      createProvider({
        id: providerSlug,
        name: providerDisplayName,
        baseUrl: providerCfg.base_url,
        headers: providerCfg.headers,
        auth: {
          apiKey: envApiKeyAuth(`${providerDisplayName} API key`, [apiKeyEnv]),
        },
        models: builtModels,
        api: apiStreamsMap,
      }),
    );
  }

  for (const slot of MODEL_SLOTS) {
    const rawTarget = rawParsed.slots[slot] ?? (slot === "vision" ? rawParsed.slots.persona : undefined);
    if (!rawTarget) {
      throw new Error(`Missing target for slot "${slot}" in ${sourceLabel}`);
    }
    resolveTargetFromMap(nextMap, rawTarget, `slot "${slot}" in ${sourceLabel}`);
  }

  return {
    config: rawParsed,
    providersBySlug: nextProvidersBySlug,
    modelsByTarget: nextMap,
    providers: nextProviders,
  };
}

/**
 * Loads config/models.toml, derives `<SLUG>_API_KEY` env vars from provider slugs,
 * allows N:M provider<->model mappings with mandatory `<provider>/<model_id>` selection prefixes,
 * and supports runtime slot hot-switching persisted in SQLite.
 */
export class ModelRegistry {
  readonly models: MutableModels = createModels();
  private fileConfig!: ModelsFileConfig;
  private slotOverrides: Partial<Record<ModelSlot, string>> = {};
  private slotThinkingOverrides: Partial<Record<ModelSlot, ModelThinkingLevel>> = {};
  private readonly extraProviders: Provider[];
  private readonly providersBySlug = new Map<string, StoredProviderRecord>();
  private readonly modelsByTarget = new Map<string, ResolvedTargetModel>();

  constructor(
    private readonly configPath: string,
    private readonly repo?: HatoRepository,
    options?: ModelRegistryOptions,
  ) {
    this.extraProviders = options?.extraProviders ?? [];
    this.reload();
  }

  reload(): void {
    const absPath = resolve(this.configPath);
    if (!existsSync(absPath)) {
      throw new Error(
        `Models config not found: ${absPath}. Run "npm run setup" or copy config/models.example.toml to ${this.configPath} first.`,
      );
    }
    const raw = readFileSync(absPath, "utf8");
    const {
      config: parsed,
      providersBySlug: nextProvidersBySlug,
      modelsByTarget: nextMap,
      providers: nextProviders,
    } = buildValidatedModelsCatalog(parseToml(raw), absPath, this.extraProviders);

    const persistedOverrides =
      this.repo?.getRuntimeSetting<Partial<Record<ModelSlot, string>>>(SLOT_OVERRIDES_SETTING_KEY) ?? {};
    const validOverrides: Partial<Record<ModelSlot, string>> = {};
    let overridesChanged = false;

    for (const slot of MODEL_SLOTS) {
      const slotTargetRaw = parsed.slots[slot] ?? parsed.slots.persona;
      const normalizedSlotTarget = resolveTargetFromMap(
        nextMap,
        slotTargetRaw,
        `slot "${slot}" in ${absPath}`,
      ).target;

      let activeTarget = normalizedSlotTarget;
      const overrideRaw = persistedOverrides[slot];
      if (overrideRaw) {
        try {
          const parsedOverride = parseQualifiedModelTarget(overrideRaw);
          if (nextMap.has(parsedOverride.target)) {
            activeTarget = parsedOverride.target;
            validOverrides[slot] = parsedOverride.target;
          } else {
            throw new Error("missing");
          }
        } catch {
          logWarn(
            "MODELS",
            `Clearing stale runtime override "${overrideRaw}" for slot "${slot}"; falling back to "${normalizedSlotTarget}"`,
          );
          overridesChanged = true;
        }
      }

      if (!nextMap.has(activeTarget)) {
        throw new Error(`Slot "${slot}" references unknown model target "${activeTarget}" in ${absPath}`);
      }
    }

    if (overridesChanged) {
      this.repo?.setRuntimeSetting(SLOT_OVERRIDES_SETTING_KEY, validOverrides);
    }

    const persistedThinking =
      this.repo?.getRuntimeSetting<Record<string, unknown>>(SLOT_THINKING_OVERRIDES_SETTING_KEY) ?? {};
    const validThinking: Partial<Record<ModelSlot, ModelThinkingLevel>> = {};
    let thinkingChanged = false;
    for (const [k, v] of Object.entries(persistedThinking)) {
      if (
        MODEL_SLOTS.includes(k as ModelSlot) &&
        typeof v === "string" &&
        THINKING_LEVEL_OPTIONS.includes(v as ConfiguredThinkingLevel)
      ) {
        validThinking[k as ModelSlot] = v as ModelThinkingLevel;
      } else {
        thinkingChanged = true;
      }
    }
    if (thinkingChanged) {
      this.repo?.setRuntimeSetting(SLOT_THINKING_OVERRIDES_SETTING_KEY, validThinking);
    }

    this.fileConfig = parsed;
    this.slotOverrides = validOverrides;
    this.slotThinkingOverrides = validThinking;
    this.providersBySlug.clear();
    for (const [k, v] of nextProvidersBySlug) {
      this.providersBySlug.set(k, v);
    }
    this.modelsByTarget.clear();
    for (const [k, v] of nextMap) {
      this.modelsByTarget.set(k, v);
    }

    this.models.clearProviders();
    for (const p of nextProviders) {
      this.models.setProvider(p);
    }
  }

  resolveTarget(targetInput: string): ResolvedTargetModel {
    return resolveTargetFromMap(this.modelsByTarget, targetInput, "model selection");
  }

  resolveSlot(slot: ModelSlot): ResolvedModelSlot {
    const rawTarget =
      this.slotOverrides[slot] ??
      this.fileConfig.slots[slot] ??
      (slot === "vision" ? this.slotOverrides.persona ?? this.fileConfig.slots.persona : undefined);
    if (!rawTarget) {
      throw new Error(`Slot "${slot}" is not configured`);
    }
    const found = resolveTargetFromMap(this.modelsByTarget, rawTarget, `slot "${slot}"`);
    return {
      slot,
      ...found,
    };
  }

  resolveApiKeyForProvider(providerSlug: string): string | undefined {
    const provider = this.providersBySlug.get(providerSlug);
    if (!provider) {
      throw new Error(`Unknown model provider "${providerSlug}"`);
    }
    if (provider.isExtra) {
      return undefined;
    }
    return requireSecret(provider.apiKeyEnv, `provider "${provider.slug}"`);
  }

  setSlotOverride(slotInput: string, targetInput: string): ResolvedModelSlot {
    if (!MODEL_SLOTS.includes(slotInput as ModelSlot)) {
      throw new Error(`Unknown slot "${slotInput}". Valid slots: ${MODEL_SLOTS.join(", ")}`);
    }
    const resolved = resolveTargetFromMap(this.modelsByTarget, targetInput, `slot "${slotInput}"`);
    const slot = slotInput as ModelSlot;
    this.slotOverrides = { ...this.slotOverrides, [slot]: resolved.target };
    this.repo?.setRuntimeSetting(SLOT_OVERRIDES_SETTING_KEY, this.slotOverrides);
    return {
      slot,
      ...resolved,
    };
  }

  resolveSlotThinkingLevel(slot: ModelSlot, overrideLevel?: ModelThinkingLevel): ModelThinkingLevel {
    const resolved = this.resolveSlot(slot);
    if (!resolved.model.reasoning) {
      return "off";
    }
    const requested =
      overrideLevel ??
      this.slotThinkingOverrides[slot] ??
      this.fileConfig.slot_thinking?.[slot] ??
      DEFAULT_SLOT_THINKING_LEVEL[slot];
    return clampThinkingLevel(resolved.model, requested);
  }

  getEffectiveSlotThinkingMap(): Partial<Record<ModelSlot, ModelThinkingLevel>> {
    const merged: Partial<Record<ModelSlot, ModelThinkingLevel>> = {
      ...(this.fileConfig.slot_thinking ?? {}),
    };
    for (const slot of MODEL_SLOTS) {
      const ov = this.slotThinkingOverrides[slot];
      if (ov !== undefined) {
        merged[slot] = ov;
      }
    }
    return merged;
  }

  setSlotThinkingOverride(
    slotInput: string,
    levelInput: string | null,
  ): {
    slot: ModelSlot;
    requested: ModelThinkingLevel | null;
    effective: ModelThinkingLevel;
    reasoningSupported: boolean;
  } {
    if (!MODEL_SLOTS.includes(slotInput as ModelSlot)) {
      throw new Error(`Unknown slot "${slotInput}". Valid slots: ${MODEL_SLOTS.join(", ")}`);
    }
    const slot = slotInput as ModelSlot;
    const normalized = levelInput?.trim().toLowerCase() ?? "";
    const nextOverrides = { ...this.slotThinkingOverrides };
    let requested: ModelThinkingLevel | null = null;

    if (!normalized || normalized === "auto") {
      delete nextOverrides[slot];
    } else if (THINKING_LEVEL_OPTIONS.includes(normalized as ConfiguredThinkingLevel)) {
      requested = normalized as ModelThinkingLevel;
      nextOverrides[slot] = requested;
    } else {
      throw new Error(
        `Invalid thinking level "${levelInput}". Valid levels: auto, ${THINKING_LEVEL_OPTIONS.join(", ")}`,
      );
    }

    this.slotThinkingOverrides = nextOverrides;
    this.repo?.setRuntimeSetting(SLOT_THINKING_OVERRIDES_SETTING_KEY, this.slotThinkingOverrides);
    const resolved = this.resolveSlot(slot);
    return {
      slot,
      requested,
      effective: this.resolveSlotThinkingLevel(slot),
      reasoningSupported: Boolean(resolved.model.reasoning),
    };
  }

  clearSlotThinkingOverrides(): void {
    this.slotThinkingOverrides = {};
    this.repo?.setRuntimeSetting(SLOT_THINKING_OVERRIDES_SETTING_KEY, {});
  }

  getEffectiveSlots(): ModelsFileConfig["slots"] {
    const fileSlots = this.fileConfig.slots;
    const vision = this.slotOverrides.vision ?? fileSlots.vision;
    return {
      persona: this.slotOverrides.persona ?? fileSlots.persona,
      router: this.slotOverrides.router ?? fileSlots.router,
      curator: this.slotOverrides.curator ?? fileSlots.curator,
      worker: this.slotOverrides.worker ?? fileSlots.worker,
      hindsight_llm: this.slotOverrides.hindsight_llm ?? fileSlots.hindsight_llm,
      ...(vision ? { vision } : {}),
    };
  }

  clearSlotOverrides(): void {
    this.slotOverrides = {};
    this.repo?.setRuntimeSetting(SLOT_OVERRIDES_SETTING_KEY, {});
  }

  listProviders(): ResolvedProviderMeta[] {
    return [...this.providersBySlug.values()].map(({ isExtra: _isExtra, ...meta }) => meta);
  }

  listSlots(): ResolvedModelSlot[] {
    return MODEL_SLOTS.map((slot) => this.resolveSlot(slot));
  }

  listTargets(): string[] {
    return [...this.modelsByTarget.keys()].sort();
  }

  getFileConfig(): ModelsFileConfig {
    return structuredClone(this.fileConfig);
  }
}

function resolveTargetFromMap(
  modelsMap: ReadonlyMap<string, ResolvedTargetModel>,
  targetInput: string,
  contextLabel: string,
): ResolvedTargetModel {
  const trimmed = targetInput.trim();
  if (!trimmed.includes("/")) {
    const candidates = findTargetsByModelId(modelsMap, trimmed);
    const hint =
      candidates.length > 0
        ? ` Matching prefixed targets: ${candidates.join(", ")}.`
        : " Run /model list to see available <provider>/<model_id> targets.";
    throw new Error(
      `Model selection "${targetInput}" for ${contextLabel} must include the provider prefix "<provider>/<model_id>".${hint}`,
    );
  }

  const parsed = parseQualifiedModelTarget(trimmed);
  const found = modelsMap.get(parsed.target);
  if (!found) {
    const candidates = findTargetsByModelId(modelsMap, parsed.modelId);
    const hint =
      candidates.length > 0
        ? ` Did you mean: ${candidates.join(", ")}?`
        : " Run /model list to see available targets.";
    throw new Error(`Unknown model "${parsed.target}" for ${contextLabel}.${hint}`);
  }
  return found;
}

function findTargetsByModelId(modelsMap: ReadonlyMap<string, ResolvedTargetModel>, modelId: string): string[] {
  const matches: string[] = [];
  for (const entry of modelsMap.values()) {
    if (entry.model.id === modelId) {
      matches.push(entry.target);
    }
  }
  return matches.sort();
}

function inferDefaultCacheTtl(api: Api): number {
  if (api === "anthropic-messages") return 5;
  if (api === "google-generative-ai" || api === "google-vertex") return 60;
  return 30;
}
