import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseToml } from "smol-toml";
import type { RetryPolicyConfig } from "../utils/retry.js";

export const ProxyRuleSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  scope: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

export const RetryPolicySchema = Type.Object({
  max_retries: Type.Number({ minimum: 0, maximum: 10 }),
  initial_delay_ms: Type.Number({ minimum: 0 }),
  backoff_multiplier: Type.Number({ minimum: 1 }),
  max_delay_ms: Type.Number({ minimum: 0 }),
  jitter: Type.Boolean(),
});

export const TavilySearchConfigSchema = Type.Object({
  provider: Type.Literal("tavily"),
  enabled: Type.Boolean(),
  api_key_env: Type.String({ minLength: 1 }),
  base_url: Type.String({ minLength: 1 }),
  max_results: Type.Number({ minimum: 1, maximum: 20 }),
  search_depth: Type.Union([Type.Literal("basic"), Type.Literal("advanced")]),
});

export const WebFetchConfigSchema = Type.Object({
  enabled: Type.Boolean(),
  timeout_ms: Type.Number({ minimum: 1000 }),
  max_chars: Type.Number({ minimum: 500 }),
});

export const WebBrowserConfigSchema = Type.Object({
  enabled: Type.Boolean(),
  headless: Type.Union([Type.Literal("auto"), Type.Boolean()]),
  channel: Type.Optional(Type.String({ minLength: 1 })),
  executable_path: Type.Optional(Type.String({ minLength: 1 })),
  profile_dir: Type.String({ minLength: 1 }),
  max_steps: Type.Number({ minimum: 1, maximum: 50 }),
  action_timeout_ms: Type.Number({ minimum: 1000 }),
  idle_timeout_minutes: Type.Number({ minimum: 0 }),
  xvfb: Type.Union([Type.Literal("auto"), Type.Boolean()]),
  display: Type.Optional(Type.String({ minLength: 1 })),
  model_slot: Type.Optional(
    Type.Union([
      Type.Literal("persona"),
      Type.Literal("worker"),
      Type.Literal("router"),
      Type.Literal("curator"),
    ]),
  ),
  novnc_hint: Type.Optional(Type.String({ minLength: 1 })),
});

export const WebConsoleConfigSchema = Type.Object({
  enabled: Type.Boolean(),
  host: Type.String({ minLength: 1 }),
  port: Type.Number({ minimum: 0, maximum: 65535 }),
  auth_token_env: Type.Optional(Type.String({ minLength: 1 })),
});

export const HatoConfigSchema = Type.Object({
  paths: Type.Object({
    sqlite: Type.String({ minLength: 1 }),
    workspaces_dir: Type.String({ minLength: 1 }),
    prompts_dir: Type.String({ minLength: 1 }),
  }),
  prompts: Type.Optional(
    Type.Object({
      order: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      disabled: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
  ),
  owner: Type.Object({
    canonical_user_id: Type.String({ minLength: 1 }),
    timezone: Type.String({ minLength: 1 }),
    proactive_channel: Type.Union([Type.Literal("tg"), Type.Literal("qq"), Type.Literal("last_active")]),
    quiet_hours: Type.Object({
      start: Type.String({ pattern: "^\\d{1,2}:\\d{2}$" }),
      end: Type.String({ pattern: "^\\d{1,2}:\\d{2}$" }),
    }),
    channels: Type.Object({
      tg: Type.Object({
        user_ids: Type.Array(Type.Union([Type.Number(), Type.String()])),
      }),
      qq: Type.Object({
        open_ids: Type.Array(Type.String()),
      }),
    }),
  }),
  network: Type.Optional(
    Type.Object({
      proxies: Type.Optional(Type.Array(ProxyRuleSchema)),
    }),
  ),
  web: Type.Optional(
    Type.Object({
      search: Type.Optional(TavilySearchConfigSchema),
      fetch: Type.Optional(WebFetchConfigSchema),
      browser: Type.Optional(WebBrowserConfigSchema),
      console: Type.Optional(WebConsoleConfigSchema),
    }),
  ),
  gateway: Type.Object({
    debounce_ms: Type.Number({ minimum: 0 }),
    retry: Type.Optional(RetryPolicySchema),
    bubbles: Type.Object({
      enabled: Type.Boolean(),
      max_per_turn: Type.Number({ minimum: 1 }),
      delay_ms_range: Type.Tuple([Type.Number({ minimum: 0 }), Type.Number({ minimum: 0 })]),
      delimiter: Type.String({ minLength: 1 }),
    }),
    telegram: Type.Object({
      enabled: Type.Boolean(),
      base_url: Type.String({ minLength: 1 }),
      bot_token_env: Type.String({ minLength: 1 }),
      mode: Type.Union([Type.Literal("polling"), Type.Literal("webhook")]),
    }),
    qq: Type.Object({
      enabled: Type.Boolean(),
      base_url: Type.String({ minLength: 1 }),
      app_id: Type.String(),
      client_secret_env: Type.String(),
      fallback_channel: Type.Union([Type.Literal("tg"), Type.Literal("none")]),
    }),
  }),
  context: Type.Object({
    hot_messages_high_watermark: Type.Number({ minimum: 4 }),
    hot_messages_keep_after_compact: Type.Number({ minimum: 1 }),
    min_messages_to_compact: Type.Number({ minimum: 2 }),
    pre_compact_after_minutes: Type.Number({ minimum: 1 }),
    idle_commit_after_minutes: Type.Number({ minimum: 1 }),
    gap_marker_threshold_minutes: Type.Number({ minimum: 1 }),
    lookback: Type.Object({
      max_step_count: Type.Number({ minimum: 1 }),
      max_total_messages: Type.Number({ minimum: 1 }),
      max_hours: Type.Number({ minimum: 1 }),
    }),
  }),
  memory: Type.Object({
    provider: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("memoryecho"), Type.Literal("hindsight")]),
    ),
    recall: Type.Optional(
      Type.Object({
        mode: Type.Union([
          Type.Literal("hybrid"),
          Type.Literal("auto"),
          Type.Literal("tool"),
          Type.Literal("off"),
        ]),
        max_results: Type.Number({ minimum: 1, maximum: 20 }),
        min_query_chars: Type.Number({ minimum: 1, maximum: 50 }),
      }),
    ),
    curator: Type.Optional(
      Type.Object({
        enabled: Type.Boolean(),
        idle_retain_after_minutes: Type.Number({ minimum: 1 }),
        batch_message_threshold: Type.Number({ minimum: 2 }),
        max_batch_messages: Type.Number({ minimum: 2, maximum: 100 }),
      }),
    ),
    memoryecho: Type.Optional(
      Type.Object({
        enabled: Type.Boolean(),
        base_url: Type.String({ minLength: 1 }),
        api_key_env: Type.String({ minLength: 1 }),
        timeout_ms: Type.Number({ minimum: 1000 }),
        auto_create_vaults: Type.Boolean(),
        vaults: Type.Object({
          persona: Type.String(),
          tech: Type.String(),
        }),
      }),
    ),
    hindsight: Type.Optional(
      Type.Object({
        base_url: Type.String({ minLength: 1 }),
        embedding_dimensions: Type.Number({ minimum: 1 }),
        banks: Type.Object({
          persona: Type.String({ minLength: 1 }),
          tech: Type.String({ minLength: 1 }),
        }),
      }),
    ),
    open_loops: Type.Object({
      defer_after_chat_minutes: Type.Number({ minimum: 0 }),
      max_unanswered_streak: Type.Number({ minimum: 1 }),
    }),
  }),
  worker: Type.Object({
    default_backend: Type.Union([
      Type.Literal("builtin-pi"),
      Type.Literal("codex"),
      Type.Literal("claude-code"),
    ]),
    workspace_ttl_days: Type.Number({ minimum: 1 }),
    sandbox: Type.Object({
      image: Type.String({ minLength: 1 }),
      memory_limit: Type.String({ minLength: 1 }),
      cpus: Type.String({ minLength: 1 }),
      pids_limit: Type.Number({ minimum: 1 }),
    }),
    external_cli: Type.Object({
      allowed_repos: Type.Array(Type.String()),
    }),
  }),
});

export type ProxyRuleConfig = Static<typeof ProxyRuleSchema>;
export type RetryPolicyTomlConfig = Static<typeof RetryPolicySchema>;
export type TavilySearchConfig = Static<typeof TavilySearchConfigSchema>;
export type WebFetchConfig = Static<typeof WebFetchConfigSchema>;
export type WebBrowserConfig = Static<typeof WebBrowserConfigSchema>;
export type WebConsoleConfig = Static<typeof WebConsoleConfigSchema>;
export type HatoConfig = Static<typeof HatoConfigSchema>;

export interface ResolvedWebConsoleConfig {
  enabled: boolean;
  host: string;
  port: number;
  authTokenEnv?: string;
}

/**
 * Resolve effective web console HTTP server config with loopback defaults.
 */
export function resolveWebConsoleConfig(config: HatoConfig): ResolvedWebConsoleConfig {
  const c = config.web?.console;
  return {
    enabled: c?.enabled ?? true,
    host: c?.host ?? "127.0.0.1",
    port: c?.port ?? 3820,
    authTokenEnv: c?.auth_token_env,
  };
}

export interface ResolvedWebFetchConfig {
  enabled: boolean;
  timeoutMs: number;
  maxChars: number;
}

export interface ResolvedWebBrowserConfig {
  enabled: boolean;
  headless: "auto" | boolean;
  channel: string;
  executablePath?: string;
  profileDir: string;
  maxSteps: number;
  actionTimeoutMs: number;
  idleTimeoutMinutes: number;
  xvfb: "auto" | boolean;
  display?: string;
  modelSlot: "persona" | "worker" | "router" | "curator";
  novncHint?: string;
}

/**
 * Resolve effective web_fetch config with safe defaults when [web.fetch] is omitted.
 */
export function resolveWebFetchConfig(config: HatoConfig): ResolvedWebFetchConfig {
  const fetchCfg = config.web?.fetch;
  return {
    enabled: fetchCfg?.enabled ?? true,
    timeoutMs: fetchCfg?.timeout_ms ?? 15_000,
    maxChars: fetchCfg?.max_chars ?? 12_000,
  };
}

/**
 * Resolve effective browser automation config with safe defaults when [web.browser] is omitted.
 */
export function resolveWebBrowserConfig(config: HatoConfig): ResolvedWebBrowserConfig {
  const b = config.web?.browser;
  return {
    enabled: b?.enabled ?? true,
    headless: b?.headless ?? "auto",
    channel: b?.channel ?? "chrome",
    executablePath: b?.executable_path,
    profileDir: b?.profile_dir ?? "./data/browser-profile",
    maxSteps: b?.max_steps ?? 15,
    actionTimeoutMs: b?.action_timeout_ms ?? 15_000,
    idleTimeoutMinutes: b?.idle_timeout_minutes ?? 5,
    xvfb: b?.xvfb ?? "auto",
    display: b?.display,
    modelSlot: b?.model_slot ?? "persona",
    novncHint: b?.novnc_hint,
  };
}

/**
 * Resolve effective gateway outbound retry & exponential backoff config with safe defaults.
 */
export function resolveGatewayRetryConfig(config: HatoConfig): RetryPolicyConfig {
  const retry = config.gateway.retry;
  return {
    maxRetries: retry?.max_retries ?? 3,
    initialDelayMs: retry?.initial_delay_ms ?? 500,
    backoffMultiplier: retry?.backoff_multiplier ?? 2,
    maxDelayMs: retry?.max_delay_ms ?? 8000,
    jitter: retry?.jitter ?? true,
  };
}

export interface ResolvedTavilySearchConfig {
  provider: "tavily";
  enabled: boolean;
  apiKeyEnv: string;
  baseUrl: string;
  maxResults: number;
  searchDepth: "basic" | "advanced";
}

export type MemoryProviderName = "none" | "memoryecho" | "hindsight";
export type MemoryRecallMode = "hybrid" | "auto" | "tool" | "off";

export interface ResolvedMemoryEchoConfig {
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  timeoutMs: number;
  autoCreateVaults: boolean;
  vaults: {
    persona: string;
    tech: string;
  };
}

export interface ResolvedMemoryRecallConfig {
  mode: MemoryRecallMode;
  maxResults: number;
  minQueryChars: number;
}

export interface ResolvedMemoryCuratorConfig {
  enabled: boolean;
  idleRetainAfterMinutes: number;
  batchMessageThreshold: number;
  maxBatchMessages: number;
}

/**
 * Resolve effective long-term memory provider from explicit `memory.provider`
 * or `memory.memoryecho.enabled`.
 */
export function resolveMemoryProvider(config: HatoConfig): MemoryProviderName {
  if (config.memory.provider) return config.memory.provider;
  if (config.memory.memoryecho?.enabled) return "memoryecho";
  return "none";
}

/**
 * Resolve effective MemoryEcho provider config with safe defaults.
 */
export function resolveMemoryEchoConfig(config: HatoConfig): ResolvedMemoryEchoConfig {
  const me = config.memory.memoryecho;
  const provider = resolveMemoryProvider(config);
  return {
    enabled: provider === "memoryecho" && (me?.enabled ?? true),
    baseUrl: me?.base_url ?? "https://api.artific.social",
    apiKeyEnv: me?.api_key_env ?? "MEMORYECHO_API_KEY",
    timeoutMs: me?.timeout_ms ?? 15_000,
    autoCreateVaults: me?.auto_create_vaults ?? true,
    vaults: {
      persona: me?.vaults?.persona?.trim() ?? "",
      tech: me?.vaults?.tech?.trim() ?? "",
    },
  };
}

export const DEFAULT_PROMPT_ORDER = ["blocks", "system", "soul"] as const;

/**
 * Resolve Layer 1 static prompt assembly order from `[prompts].order`
 * (defaults to `["blocks", "system", "soul"]`).
 */
export function resolvePromptOrder(config: HatoConfig): string[] {
  const configured = config.prompts?.order;
  if (!configured || configured.length === 0) {
    return [...DEFAULT_PROMPT_ORDER];
  }
  return configured.map((item) => item.trim()).filter(Boolean);
}

/**
 * Resolve disabled Layer 1 prompt tokens from `[prompts].disabled`
 * (e.g. `["system", "block:01-user.md"]`).
 */
export function resolvePromptDisabled(config: HatoConfig): string[] {
  const configured = config.prompts?.disabled;
  if (!configured || configured.length === 0) {
    return [];
  }
  return configured.map((item) => item.trim()).filter(Boolean);
}

/**
 * Resolve effective memory recall strategy (hybrid = auto pre-recall + active recall_memory tool).
 */
export function resolveMemoryRecallConfig(config: HatoConfig): ResolvedMemoryRecallConfig {
  const r = config.memory.recall;
  return {
    mode: r?.mode ?? "hybrid",
    maxResults: r?.max_results ?? 6,
    minQueryChars: r?.min_query_chars ?? 4,
  };
}

/**
 * Resolve effective Memory Curator distillation and batching config.
 */
export function resolveMemoryCuratorConfig(config: HatoConfig): ResolvedMemoryCuratorConfig {
  const c = config.memory.curator;
  return {
    enabled: c?.enabled ?? true,
    idleRetainAfterMinutes: c?.idle_retain_after_minutes ?? 10,
    batchMessageThreshold: c?.batch_message_threshold ?? 12,
    maxBatchMessages: c?.max_batch_messages ?? 24,
  };
}

/**
 * Resolve effective Tavily search config with safe defaults when [web.search] is omitted.
 */
export function resolveTavilySearchConfig(config: HatoConfig): ResolvedTavilySearchConfig {
  const search = config.web?.search;
  return {
    provider: "tavily",
    enabled: search?.enabled ?? true,
    apiKeyEnv: search?.api_key_env ?? "TAVILY_API_KEY",
    baseUrl: search?.base_url ?? "https://api.tavily.com",
    maxResults: search?.max_results ?? 5,
    searchDepth: search?.search_depth ?? "basic",
  };
}

/**
 * Validate a parsed TOML object against HatoConfigSchema.
 */
export function validateHatoConfigObject(parsed: unknown, sourceLabel = "hato config"): HatoConfig {
  if (!Value.Check(HatoConfigSchema, parsed)) {
    const errors = [...Value.Errors(HatoConfigSchema, parsed)]
      .slice(0, 6)
      .map((err) => `${err.path || "<root>"}: ${err.message}`)
      .join("; ");
    throw new Error(`Invalid Hato config (${sourceLabel}): ${errors}`);
  }
  return parsed;
}

/**
 * Parse and validate config/hato.toml using smol-toml and TypeBox.
 */
export function loadHatoConfig(configPath = "config/hato.toml"): HatoConfig {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    throw new Error(
      `Config file not found: ${absPath}. Run "npm run setup" or copy config/hato.example.toml to ${configPath} first.`,
    );
  }
  const raw = readFileSync(absPath, "utf8");
  const parsed = parseToml(raw);
  return validateHatoConfigObject(parsed, absPath);
}
