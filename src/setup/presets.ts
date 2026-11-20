import type { KnownApi } from "@earendil-works/pi-ai";
import type { HatoConfig } from "../config/app.js";
import { getSystemTimezone } from "./timezone.js";

export interface ProviderPreset {
  id: string;
  label: string;
  hint: string;
  defaultName: string;
  defaultSlug: string;
  defaultApi?: KnownApi;
  defaultBaseUrl: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "custom",
    label: "自定义 Provider",
    hint: "自由填写名称、Slug、协议与端点 URL",
    defaultName: "",
    defaultSlug: "",
    defaultBaseUrl: "",
  },
  {
    id: "openai",
    label: "OpenAI（openai · OPENAI_API_KEY）",
    hint: "OpenAI 官方 Responses API",
    defaultName: "OpenAI",
    defaultSlug: "openai",
    defaultApi: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic（anthropic · ANTHROPIC_API_KEY）",
    hint: "Anthropic 官方 Messages API",
    defaultName: "Anthropic",
    defaultSlug: "anthropic",
    defaultApi: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  {
    id: "google",
    label: "Google Gemini（google · GOOGLE_API_KEY）",
    hint: "Google Gemini 原生接口",
    defaultName: "Google",
    defaultSlug: "google",
    defaultApi: "google-generative-ai",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  {
    id: "deepseek",
    label: "DeepSeek（deepseek · DEEPSEEK_API_KEY）",
    hint: "DeepSeek 官方兼容接口",
    defaultName: "DeepSeek",
    defaultSlug: "deepseek",
    defaultApi: "openai-completions",
    defaultBaseUrl: "https://api.deepseek.com/v1",
  },
];

export const API_PROTOCOL_DESCRIPTIONS: Record<KnownApi, string> = {
  "openai-completions": "OpenAI Chat Completions 兼容接口（vLLM / OpenRouter / NewAPI 等）",
  "openai-responses": "OpenAI Responses API",
  "anthropic-messages": "Anthropic Messages API",
  "google-generative-ai": "Google Gemini 原生 generateContent 接口",
  "google-vertex": "Google Cloud Vertex AI",
  "openai-codex-responses": "OpenAI Codex Responses API",
  "azure-openai-responses": "Azure OpenAI Responses API",
  "mistral-conversations": "Mistral Conversations API",
  "bedrock-converse-stream": "AWS Bedrock Converse Stream",
  "pi-messages": "Pi Messages 协议",
};

export function createDefaultHatoConfig(): HatoConfig {
  return {
    paths: {
      sqlite: "./data/hato.db",
      workspaces_dir: "./data/workspaces",
      prompts_dir: "./prompts",
    },
    prompts: {
      order: ["blocks", "system", "soul"],
    },
    owner: {
      canonical_user_id: "owner",
      timezone: getSystemTimezone(),
      proactive_channel: "tg",
      quiet_hours: {
        start: "00:00",
        end: "00:00",
      },
      channels: {
        tg: {
          user_ids: [],
        },
        qq: {
          open_ids: [],
        },
      },
    },
    network: {
      proxies: [],
    },
    web: {
      search: {
        provider: "tavily",
        enabled: true,
        api_key_env: "TAVILY_API_KEY",
        base_url: "https://api.tavily.com",
        max_results: 5,
        search_depth: "basic",
      },
      fetch: {
        enabled: true,
        timeout_ms: 15_000,
        max_chars: 12_000,
      },
      browser: {
        enabled: true,
        headless: "auto",
        channel: "chrome",
        profile_dir: "./data/browser-profile",
        max_steps: 15,
        action_timeout_ms: 15_000,
        idle_timeout_minutes: 5,
        xvfb: "auto",
        model_slot: "persona",
      },
      console: {
        enabled: true,
        host: "127.0.0.1",
        port: 3820,
      },
    },
    gateway: {
      debounce_ms: 3000,
      retry: {
        max_retries: 3,
        initial_delay_ms: 500,
        backoff_multiplier: 2,
        max_delay_ms: 8000,
        jitter: true,
      },
      bubbles: {
        enabled: true,
        max_per_turn: 3,
        delay_ms_range: [500, 1500],
        delimiter: "---",
      },
      telegram: {
        enabled: true,
        base_url: "https://api.telegram.org",
        bot_token_env: "TG_BOT_TOKEN",
        mode: "polling",
      },
      qq: {
        enabled: false,
        base_url: "https://api.sgroup.qq.com",
        app_id: "",
        client_secret_env: "QQ_BOT_SECRET",
        fallback_channel: "tg",
      },
    },
    context: {
      hot_messages_high_watermark: 60,
      hot_messages_keep_after_compact: 10,
      min_messages_to_compact: 10,
      pre_compact_after_minutes: 50,
      idle_commit_after_minutes: 60,
      clear_mode: "cache",
      scheduled_clear_time: "01:00",
      scheduled_defer_minutes: 30,
      gap_marker_threshold_minutes: 30,
      lookback: {
        max_step_count: 10,
        max_total_messages: 20,
        max_hours: 24,
      },
    },
    memory: {
      provider: "none",
      recall: {
        mode: "hybrid",
        max_results: 6,
        min_query_chars: 4,
      },
      curator: {
        enabled: true,
        idle_retain_after_minutes: 10,
        batch_message_threshold: 12,
        max_batch_messages: 24,
      },
      memoryecho: {
        enabled: false,
        base_url: "https://api.artific.social",
        api_key_env: "MEMORYECHO_API_KEY",
        timeout_ms: 15_000,
        auto_create_vaults: true,
        vaults: {
          persona: "",
          tech: "",
        },
      },
      hindsight: {
        base_url: "http://127.0.0.1:8888",
        embedding_dimensions: 1024,
        banks: {
          persona: "persona",
          tech: "tech",
        },
      },
      open_loops: {
        defer_after_chat_minutes: 5,
        max_unanswered_streak: 2,
      },
    },
    worker: {
      default_backend: "builtin-pi",
      workspace_ttl_days: 14,
      sandbox: {
        image: "hato-sandbox:latest",
        memory_limit: "512m",
        cpus: "1",
        pids_limit: 256,
      },
      external_cli: {
        allowed_repos: [],
      },
    },
  };
}
