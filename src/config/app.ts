import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseToml } from "smol-toml";
import type { RetryPolicyConfig } from "../utils/retry.js";
import { DEFAULT_LLM_RETRY_CONFIG, type LlmRetryConfig } from "../utils/llm-retry.js";

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

export const LlmRetryPolicySchema = Type.Object({
  max_retries: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
  initial_delay_ms: Type.Optional(Type.Number({ minimum: 0 })),
  backoff_multiplier: Type.Optional(Type.Number({ minimum: 1 })),
  max_delay_ms: Type.Optional(Type.Number({ minimum: 0 })),
  jitter: Type.Optional(Type.Boolean()),
  notify_after_retry: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
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

export const ExternalCliPermissionPresetSchema = Type.Union([
  Type.Literal("follow_host"),
  Type.Literal("auto_safe"),
  Type.Literal("yolo"),
  Type.Literal("read_only"),
  Type.Literal("custom"),
]);

export const HatoConfigSchema = Type.Object({
  paths: Type.Object({
    sqlite: Type.String({ minLength: 1 }),
    workspaces_dir: Type.String({ minLength: 1 }),
    prompts_dir: Type.String({ minLength: 1 }),
    skills_dir: Type.Optional(Type.String({ minLength: 1 })),
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
  llm_retry: Type.Optional(LlmRetryPolicySchema),
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
    clear_mode: Type.Optional(Type.Union([Type.Literal("cache"), Type.Literal("scheduled")])),
    compaction_mode: Type.Optional(
      Type.Union([Type.Literal("curator"), Type.Literal("reuse_conversation")]),
    ),
    scheduled_clear_time: Type.Optional(Type.String()),
    scheduled_defer_minutes: Type.Optional(Type.Number({ minimum: 1 })),
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
          notebook: Type.Optional(Type.String()),
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
          notebook: Type.Optional(Type.String({ minLength: 1 })),
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
      Type.Literal("codex-cli"),
      Type.Literal("antigravity-cli"),
      Type.Literal("opencode-v2"),
      Type.Literal("external-pi"),
      Type.Literal("claude-code"),
    ]),
    routing_mode: Type.Optional(
      Type.Union([Type.Literal("smart"), Type.Literal("always_default")]),
    ),
    execution_mode: Type.Optional(
      Type.Union([Type.Literal("isolated"), Type.Literal("vm_unrestricted")]),
    ),
    vm_workdir: Type.Optional(Type.String()),
    workspace_ttl_days: Type.Number({ minimum: 1 }),
    sandbox: Type.Object({
      image: Type.String({ minLength: 1 }),
      memory_limit: Type.String({ minLength: 1 }),
      cpus: Type.String({ minLength: 1 }),
      pids_limit: Type.Number({ minimum: 1 }),
    }),
    external_cli: Type.Object({
      allowed_repos: Type.Array(Type.String()),
      reuse_host_auth_and_provider: Type.Optional(Type.Boolean()),
      inherit_host_mcp: Type.Optional(Type.Boolean()),
      host_mcp_allowlist: Type.Optional(Type.Array(Type.String())),
      permission_preset: Type.Optional(ExternalCliPermissionPresetSchema),
      timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
      env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
      codex_cli: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          command: Type.Optional(Type.String({ minLength: 1 })),
          sandbox: Type.Optional(Type.String({ minLength: 1 })),
          approval: Type.Optional(Type.String({ minLength: 1 })),
          model: Type.Optional(Type.String({ minLength: 1 })),
        }),
      ),
      antigravity_cli: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          command: Type.Optional(Type.String({ minLength: 1 })),
          mode: Type.Optional(Type.String({ minLength: 1 })),
          skip_permissions: Type.Optional(Type.Boolean()),
          sandbox: Type.Optional(Type.Boolean()),
          model: Type.Optional(Type.String({ minLength: 1 })),
        }),
      ),
      opencode_v2: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          command: Type.Optional(Type.String({ minLength: 1 })),
          permission_mode: Type.Optional(Type.String({ minLength: 1 })),
          auto: Type.Optional(Type.Boolean()),
          agent: Type.Optional(Type.String()),
          model: Type.Optional(Type.String({ minLength: 1 })),
        }),
      ),
      external_pi: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          command: Type.Optional(Type.String({ minLength: 1 })),
          model: Type.Optional(Type.String({ minLength: 1 })),
        }),
      ),
      claude_code: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          command: Type.Optional(Type.String({ minLength: 1 })),
          permission_mode: Type.Optional(Type.String({ minLength: 1 })),
          skip_permissions: Type.Optional(Type.Boolean()),
          model: Type.Optional(Type.String({ minLength: 1 })),
        }),
      ),
    }),
  }),
  updates: Type.Optional(
    Type.Object({
      check_enabled: Type.Optional(Type.Boolean()),
      channel: Type.Optional(Type.Union([Type.Literal("stable"), Type.Literal("nightly")])),
      im_notify_enabled: Type.Optional(Type.Boolean()),
      check_interval_hours: Type.Optional(Type.Number({ minimum: 1, maximum: 168 })),
    }),
  ),
});

export type ExternalCliPermissionPreset = Static<typeof ExternalCliPermissionPresetSchema>;
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

export interface ResolvedUpdatesConfig {
  checkEnabled: boolean;
  channel: "stable" | "nightly";
  imNotifyEnabled: boolean;
  checkIntervalHours: number;
}

/**
 * Resolve version update check and IM notification settings (IM push defaults to off).
 */
export function resolveUpdatesConfig(config: HatoConfig): ResolvedUpdatesConfig {
  const u = config.updates;
  return {
    checkEnabled: u?.check_enabled ?? true,
    channel: u?.channel ?? "stable",
    imNotifyEnabled: u?.im_notify_enabled ?? false,
    checkIntervalHours: u?.check_interval_hours ?? 24,
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

/**
 * Resolve effective LLM call retry & exponential backoff config with safe defaults (5 retries, notify on 3rd).
 */
export function resolveLlmRetryConfig(config: HatoConfig): LlmRetryConfig {
  const retry = config.llm_retry;
  return {
    maxRetries: retry?.max_retries ?? DEFAULT_LLM_RETRY_CONFIG.maxRetries,
    initialDelayMs: retry?.initial_delay_ms ?? DEFAULT_LLM_RETRY_CONFIG.initialDelayMs,
    backoffMultiplier: retry?.backoff_multiplier ?? DEFAULT_LLM_RETRY_CONFIG.backoffMultiplier,
    maxDelayMs: retry?.max_delay_ms ?? DEFAULT_LLM_RETRY_CONFIG.maxDelayMs,
    jitter: retry?.jitter ?? DEFAULT_LLM_RETRY_CONFIG.jitter,
    notifyAfterRetry: retry?.notify_after_retry ?? DEFAULT_LLM_RETRY_CONFIG.notifyAfterRetry,
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
    notebook?: string;
  };
}

export interface ResolvedHindsightConfig {
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  timeoutMs: number;
  embeddingDimensions: number;
  banks: {
    persona: string;
    tech: string;
    notebook?: string;
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
      notebook: me?.vaults?.notebook?.trim() ?? "",
    },
  };
}

/**
 * Resolve effective Hindsight provider config with safe defaults.
 */
export function resolveHindsightConfig(config: HatoConfig): ResolvedHindsightConfig {
  const hs = config.memory.hindsight;
  const provider = resolveMemoryProvider(config);
  return {
    enabled: provider === "hindsight",
    baseUrl: hs?.base_url ?? "http://127.0.0.1:8888",
    apiKeyEnv: "HINDSIGHT_API_KEY",
    timeoutMs: 15_000,
    embeddingDimensions: hs?.embedding_dimensions ?? 1024,
    banks: {
      persona: hs?.banks?.persona?.trim() || "persona",
      tech: hs?.banks?.tech?.trim() || "tech",
      notebook: hs?.banks?.notebook?.trim() || "notebook",
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

export interface ResolvedContextClearConfig {
  clearMode: "cache" | "scheduled";
  scheduledClearTime: string;
  scheduledDeferMinutes: number;
}

/**
 * Resolve effective hot-zone clear timing config ("cache" vs "scheduled").
 */
export function resolveContextClearConfig(config: HatoConfig): ResolvedContextClearConfig {
  const rawTime = config.context.scheduled_clear_time?.trim() ?? "";
  const validTime = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(rawTime) ? rawTime : "01:00";
  const [hh, mm] = validTime.split(":");
  return {
    clearMode: config.context.clear_mode ?? "cache",
    scheduledClearTime: `${hh!.padStart(2, "0")}:${mm!}`,
    scheduledDeferMinutes: Math.max(1, config.context.scheduled_defer_minutes ?? 30),
  };
}

export type ContextCompactionMode = "curator" | "reuse_conversation";

/**
 * Resolve effective context compaction strategy ("curator" vs "reuse_conversation").
 */
export function resolveContextCompactionMode(config: HatoConfig): ContextCompactionMode {
  return config.context.compaction_mode === "reuse_conversation"
    ? "reuse_conversation"
    : "curator";
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

export const DEFAULT_SKILLS_DIR = "./data/skills";

/**
 * Resolve configured skills root directory (containing `personal/` and `worker/` zones).
 */
export function resolveSkillsDir(config: HatoConfig): string {
  return config.paths.skills_dir?.trim() || DEFAULT_SKILLS_DIR;
}

export interface ResolvedWorkerExternalCliConfig {
  allowedRepos: string[];
  reuseHostAuthAndProvider: boolean;
  inheritHostMcp: boolean;
  hostMcpAllowlist: string[];
  permissionPreset: ExternalCliPermissionPreset;
  timeoutMs: number;
}

export type WorkerBackendName = HatoConfig["worker"]["default_backend"];

export const EXTERNAL_CLI_BACKENDS = [
  "codex-cli",
  "antigravity-cli",
  "opencode-v2",
  "external-pi",
  "claude-code",
] as const;

/**
 * Determine whether a worker backend is currently enabled in HatoConfig.
 */
export function isWorkerBackendEnabled(
  config: HatoConfig,
  backend: WorkerBackendName,
): boolean {
  if (backend === "builtin-pi") return true;
  const ext = config.worker.external_cli;
  switch (backend) {
    case "codex-cli":
      return ext.codex_cli?.enabled ?? true;
    case "antigravity-cli":
      return ext.antigravity_cli?.enabled ?? true;
    case "opencode-v2":
      return ext.opencode_v2?.enabled ?? true;
    case "external-pi":
      return ext.external_pi?.enabled ?? false;
    case "claude-code":
      return ext.claude_code?.enabled ?? false;
  }
}

/**
 * List all enabled worker backends, never including disabled external CLIs.
 */
export function listEnabledWorkerBackends(config: HatoConfig): WorkerBackendName[] {
  const enabled: WorkerBackendName[] = EXTERNAL_CLI_BACKENDS.filter((b) =>
    isWorkerBackendEnabled(config, b),
  );
  enabled.push("builtin-pi");
  if (
    isWorkerBackendEnabled(config, config.worker.default_backend) &&
    enabled.includes(config.worker.default_backend)
  ) {
    return [
      config.worker.default_backend,
      ...enabled.filter((b) => b !== config.worker.default_backend),
    ];
  }
  return enabled;
}

/**
 * Resolve the effective default backend; if the configured default backend was disabled,
 * fall back to the first enabled external CLI or `builtin-pi`.
 */
export function resolveEffectiveDefaultBackend(config: HatoConfig): WorkerBackendName {
  if (isWorkerBackendEnabled(config, config.worker.default_backend)) {
    return config.worker.default_backend;
  }
  const firstExternal = EXTERNAL_CLI_BACKENDS.find((b) => isWorkerBackendEnabled(config, b));
  return firstExternal ?? "builtin-pi";
}

/**
 * Resolve custom environment variables configured for external CLI workers.
 */
export function resolveExternalCliCustomEnv(config: HatoConfig): Record<string, string> {
  const raw = config.worker.external_cli.env;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (!key || typeof v !== "string") continue;
    out[key] = v;
  }
  return out;
}

/**
 * Resolve worker execution mode: "isolated" (default per-ticket sandbox) or "vm_unrestricted".
 */
export function resolveWorkerExecutionMode(config: HatoConfig): "isolated" | "vm_unrestricted" {
  return config.worker.execution_mode === "vm_unrestricted" ? "vm_unrestricted" : "isolated";
}

/**
 * Resolve persistent working directory for `vm_unrestricted` mode (defaults to user home).
 */
export function resolveWorkerVmWorkdir(config: HatoConfig): string {
  const raw = config.worker.vm_workdir?.trim();
  if (!raw) return homedir();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return resolve(homedir(), raw.slice(2));
  }
  return resolve(raw);
}

/**
 * Resolve external CLI worker orchestration settings with safe defaults.
 */
export function resolveWorkerExternalCliConfig(
  config: HatoConfig,
): ResolvedWorkerExternalCliConfig {
  const ext = config.worker.external_cli;
  return {
    allowedRepos: [...ext.allowed_repos],
    reuseHostAuthAndProvider: ext.reuse_host_auth_and_provider ?? true,
    inheritHostMcp: ext.inherit_host_mcp ?? false,
    hostMcpAllowlist: [...(ext.host_mcp_allowlist ?? [])],
    permissionPreset: ext.permission_preset ?? "auto_safe",
    timeoutMs: ext.timeout_ms ?? 600_000,
  };
}

/**
 * Validate a parsed TOML object against HatoConfigSchema.
 */
export function validateHatoConfigObject(parsed: unknown, sourceLabel = "hato config"): HatoConfig {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const rawWorker = (parsed as Record<string, unknown>).worker;
    if (rawWorker && typeof rawWorker === "object" && !Array.isArray(rawWorker)) {
      const workerObj = rawWorker as Record<string, unknown>;
      if (workerObj.default_backend === "opencode") {
        throw new Error(
          `Invalid Hato config (${sourceLabel}): bare "opencode" is unsupported; use "opencode-v2" (requires OpenCode V2).`,
        );
      }
      const extCli = workerObj.external_cli;
      if (extCli && typeof extCli === "object" && !Array.isArray(extCli) && "opencode" in extCli) {
        throw new Error(
          `Invalid Hato config (${sourceLabel}): bare [worker.external_cli.opencode] is unsupported; use [worker.external_cli.opencode_v2] (requires OpenCode V2).`,
        );
      }
    }
  }

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
