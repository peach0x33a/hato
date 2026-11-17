export interface HealthResponse {
  ok: boolean;
  uptimeSec: number;
  telegramEnabled: boolean;
  pendingTakeover: boolean;
  authRequired: boolean;
  console: {
    host: string;
    port: number;
  };
}

export interface SlotView {
  slot: string;
  target: string;
  api: string;
  baseUrl: string;
}

export interface StoredMessageRecord {
  id: string;
  canonicalUserId: string;
  channel: string;
  role: "user" | "assistant" | "system";
  content: string;
  bubbles?: string[];
  createdAt: number;
}

export interface ChatSessionRecord {
  id: string;
  canonicalUserId: string;
  title: string;
  summaryText: string;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  traceCount: number;
  createdAt: number;
}

export interface ChatHistoryResponse {
  ok: boolean;
  canonicalUserId: string;
  readonly?: boolean;
  session?: ChatSessionRecord | null;
  summaryText: string;
  compactedUntilTs: number;
  pendingTakeover: boolean;
  messages: StoredMessageRecord[];
  slots: SlotView[];
  availableModels: string[];
}

export interface TurnTelemetry {
  latencyMs: number;
  ttftMs?: number;
  cacheHitRate?: number;
  tps?: number;
  toolCalls: string[];
}

export type ChatSseEvent =
  | { type: "slash_reply"; text: string }
  | { type: "early_bubbles"; bubbles: string[] }
  | { type: "photo"; dataUrl: string; caption?: string }
  | { type: "assistant_bubbles"; bubbles: string[]; telemetry: TurnTelemetry }
  | { type: "done"; pendingTakeover: boolean }
  | { type: "error"; message: string };

export interface BrowserTabInfo {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserStatus {
  open: boolean;
  busy: boolean;
  pendingTakeover: boolean;
  takeoverReason: string | null;
  displayMode: "xvfb" | "headed" | "headless" | "closed";
  xvfbDisplay: string | null;
  proxyKey: string | null;
  url: string | null;
  title: string | null;
  viewport: { width: number; height: number };
  tabs: BrowserTabInfo[];
}

export type BrowserStreamEvent =
  | { type: "status"; status: BrowserStatus }
  | { type: "frame"; dataUrl: string; width: number; height: number };

export interface ProxyRuleConfig {
  name: string;
  url: string;
  scope: string[];
}

export interface RetryPolicyTomlConfig {
  max_retries: number;
  initial_delay_ms: number;
  backoff_multiplier: number;
  max_delay_ms: number;
  jitter: boolean;
}

export type ExternalCliPermissionPreset =
  | "follow_host"
  | "auto_safe"
  | "yolo"
  | "read_only"
  | "custom";

export interface HatoConfig {
  paths: {
    sqlite: string;
    workspaces_dir: string;
    prompts_dir: string;
    skills_dir?: string;
  };
  prompts?: {
    order?: string[];
    disabled?: string[];
  };
  owner: {
    canonical_user_id: string;
    timezone: string;
    proactive_channel: "tg" | "qq" | "last_active";
    quiet_hours: { start: string; end: string };
    channels: {
      tg: { user_ids: Array<number | string> };
      qq: { open_ids: string[] };
    };
  };
  network?: {
    proxies?: ProxyRuleConfig[];
  };
  web?: {
    search?: {
      enabled: boolean;
      provider: "tavily";
      api_key_env: string;
      base_url?: string;
      timeout_ms?: number;
      max_results?: number;
      search_depth?: "basic" | "advanced";
    };
    fetch?: {
      enabled: boolean;
      timeout_ms?: number;
      max_chars?: number;
    };
    browser?: {
      enabled: boolean;
      channel?: "chrome" | "chromium" | "msedge";
      executable_path?: string;
      profile_dir?: string;
      headless?: boolean | "auto";
      max_steps?: number;
      action_timeout_ms?: number;
      idle_timeout_minutes?: number;
      xvfb?: "auto" | boolean;
      display?: string;
      model_slot?: "persona" | "worker" | "router" | "curator";
      novnc_hint?: string;
    };
    console?: {
      enabled: boolean;
      host: string;
      port: number;
      auth_token_env?: string;
    };
  };
  gateway: {
    debounce_ms: number;
    retry?: RetryPolicyTomlConfig;
    bubbles: {
      enabled: boolean;
      max_per_turn: number;
      delay_ms_range: [number, number];
      delimiter: string;
    };
    telegram: {
      enabled: boolean;
      base_url: string;
      bot_token_env: string;
      mode: "polling" | "webhook";
    };
    qq: {
      enabled: boolean;
      base_url: string;
      app_id: string;
      client_secret_env: string;
      fallback_channel: "tg" | "none";
    };
  };
  context: {
    hot_messages_high_watermark: number;
    hot_messages_keep_after_compact: number;
    min_messages_to_compact: number;
    pre_compact_after_minutes: number;
    idle_commit_after_minutes: number;
    gap_marker_threshold_minutes: number;
    lookback: {
      max_step_count: number;
      max_total_messages: number;
      max_hours: number;
    };
  };
  memory: {
    hindsight: {
      base_url: string;
      embedding_dimensions: number;
      banks: {
        persona: string;
        tech: string;
      };
    };
    open_loops: {
      defer_after_chat_minutes: number;
      max_unanswered_streak: number;
    };
  };
  worker: {
    default_backend:
      | "builtin-pi"
      | "codex"
      | "agy"
      | "opencode-v2"
      | "external-pi"
      | "claude-code";
    workspace_ttl_days: number;
    sandbox: {
      image: string;
      memory_limit: string;
      cpus: string;
      pids_limit: number;
    };
    external_cli: {
      allowed_repos: string[];
      reuse_host_auth_and_provider?: boolean;
      inherit_host_mcp?: boolean;
      host_mcp_allowlist?: string[];
      permission_preset?: ExternalCliPermissionPreset;
      timeout_ms?: number;
      codex?: {
        enabled?: boolean;
        command?: string;
        sandbox?: string;
        approval?: string;
        model?: string;
      };
      agy?: {
        enabled?: boolean;
        command?: string;
        mode?: string;
        skip_permissions?: boolean;
        sandbox?: boolean;
        model?: string;
      };
      opencode_v2?: {
        enabled?: boolean;
        command?: string;
        auto?: boolean;
        agent?: string;
        model?: string;
      };
      external_pi?: {
        enabled?: boolean;
        command?: string;
        model?: string;
      };
      claude_code?: {
        enabled?: boolean;
        command?: string;
        permission_mode?: string;
        skip_permissions?: boolean;
        model?: string;
      };
    };
  };
}

export interface CliOptionChoice {
  key: string;
  label: string;
  kind: "enum" | "boolean";
  choices?: string[];
  hostDefault?: string | boolean;
  effectiveHatoValue?: string | boolean;
}

export interface ExternalCliProbeEntry {
  backend: "codex" | "agy" | "opencode-v2" | "external-pi" | "claude-code";
  tier: 1 | 2 | 3;
  enabled: boolean;
  command: string;
  installed: boolean;
  available: boolean;
  version?: string;
  v2Verified?: boolean;
  reason?: string;
  hostConfigPath?: string;
  hostSummary: Record<string, string | boolean | string[]>;
  options: CliOptionChoice[];
  effectiveArgsPreview: string[];
  probedAtMs: number;
}

export interface WorkerCliProbeResponse {
  ok: boolean;
  hatoOnlyScope: boolean;
  permissionPreset: ExternalCliPermissionPreset;
  probes: ExternalCliProbeEntry[];
}

export interface ModelDefinitionConfig {
  id: string;
  name?: string;
  api?: string;
  base_url?: string;
  headers?: Record<string, string>;
  cache_ttl_minutes?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  context_window?: number;
  max_tokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  thinking_level_map?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

export interface ProviderConfig {
  name?: string;
  slug?: string;
  api: string;
  base_url: string;
  api_key_env?: string;
  cache_ttl_minutes?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: ModelDefinitionConfig[];
}

export interface ModelsFileConfig {
  slots: {
    persona: string;
    router: string;
    curator: string;
    worker: string;
    hindsight_llm: string;
  };
  providers: Record<string, ProviderConfig>;
}

export interface SecretState {
  key: string;
  configured: boolean;
  masked: string;
}

export interface PromptBlockRecord {
  name: string;
  path: string;
  content: string;
}

export interface PromptLayersSnapshot {
  mode: "layered" | "legacy";
  order: string[];
  disabled: string[];
  blocks: PromptBlockRecord[];
  systemPath: string;
  systemText: string;
  soulPath: string;
  soulText: string;
  combinedText: string;
}

export interface ConfigSnapshotResponse {
  ok: boolean;
  hatoConfig: HatoConfig;
  modelsConfig: ModelsFileConfig;
  promptPath: string;
  promptText: string;
  promptLayers: PromptLayersSnapshot;
  secretStates: SecretState[];
}

export interface SaveConfigResponse {
  ok: boolean;
  path?: string;
  backupPath?: string;
  slots: SlotView[];
  proxyCount: number;
  changes?: string[];
  hatoConfig?: HatoConfig;
  promptPath?: string;
  promptText?: string;
  promptLayers?: PromptLayersSnapshot;
  error?: string;
}

export interface ProbeResponse {
  ok: boolean;
  results: {
    telegram?: { ok: boolean; latencyMs: number; message: string };
    persona?: { ok: boolean; latencyMs: number; message: string };
    tavily?: { ok: boolean; latencyMs: number; message: string };
  };
}

export type TraceStepRecord =
  | {
      kind: "assistant";
      step: number;
      text: string;
      thinking?: string;
      toolCalls: Array<{ id: string; name: string; args: unknown }>;
      stopReason?: string;
      tokens?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      };
    }
  | {
      kind: "tool";
      step: number;
      toolCallId?: string;
      name: string;
      args?: unknown;
      output: string;
      isError?: boolean;
    };

export interface TurnTraceRecord {
  id: string;
  canonicalUserId: string;
  slot: string;
  provider: string;
  modelId: string;
  api: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  ttftMs: number | null;
  tps: number | null;
  latencyMs: number;
  userPreview: string | null;
  recalledIdsJson: string;
  timeCardText: string;
  toolCallsJson: string;
  stepsJson?: string;
  createdAt: number;
}

export interface StaticsSummary {
  turns: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalPromptTokens: number;
  totalOutputTokens: number;
  weightedCacheHitRate: number;
  warmCacheHitRate: number | null;
  warmTurns: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  measuredTtftCount: number;
  avgDecodeTps: number | null;
  avgE2eTps: number | null;
  measuredTpsCount: number;
}

export interface StaticsResponse {
  ok: boolean;
  summary: StaticsSummary;
  traces: TurnTraceRecord[];
}

const TOKEN_STORAGE_KEY = "hato_console_token";

export function getStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setStoredToken(token: string): void {
  try {
    if (token.trim()) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getStoredToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}`, "X-Hato-Token": token } : {}),
    ...extra,
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: authHeaders(init?.headers as Record<string, string> | undefined),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { error: text || `HTTP ${res.status}` };
  }
  if (!res.ok || parsed.ok === false) {
    throw new ApiError(res.status, String(parsed.error || `请求失败 (HTTP ${res.status})`));
  }
  return parsed as T;
}

export const api = {
  getHealth: () => fetch("/api/health").then((r) => r.json() as Promise<HealthResponse>),
  getSessions: () => requestJson<{ ok: boolean; sessions: ChatSessionRecord[] }>("/api/sessions"),
  getChatHistory: (sessionId?: string | null) =>
    requestJson<ChatHistoryResponse>(
      sessionId ? `/api/chat/history?sessionId=${encodeURIComponent(sessionId)}` : "/api/chat/history",
    ),
  getConfig: () => requestJson<ConfigSnapshotResponse>("/api/config"),
  saveHatoConfig: (config: HatoConfig) =>
    requestJson<SaveConfigResponse>("/api/config/hato", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    }),
  saveModelsConfig: (config: ModelsFileConfig) =>
    requestJson<SaveConfigResponse>("/api/config/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    }),
  savePrompt: (promptText: string) =>
    requestJson<SaveConfigResponse>("/api/config/prompt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptText }),
    }),
  savePromptOrder: (order: string[], disabled: string[]) =>
    requestJson<SaveConfigResponse>("/api/config/prompts/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, disabled }),
    }),
  upsertPromptBlock: (name: string, content: string, enabled?: boolean) =>
    requestJson<SaveConfigResponse & { block?: { name: string; path: string } }>(
      "/api/config/prompts/block",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content, enabled }),
      },
    ),
  deletePromptBlock: (name: string) =>
    requestJson<SaveConfigResponse>(
      `/api/config/prompts/block?name=${encodeURIComponent(name)}`,
      {
        method: "DELETE",
      },
    ),
  saveSecrets: (updates: Record<string, string>) =>
    requestJson<{ ok: boolean; writtenKeys: string[]; secretStates: SecretState[]; changes?: string[] }>(
      "/api/config/secrets",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      },
    ),
  reloadConfig: () =>
    requestJson<SaveConfigResponse>("/api/config/reload", {
      method: "POST",
    }),
  probe: (target: "all" | "telegram" | "persona" | "tavily") =>
    requestJson<ProbeResponse>("/api/config/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    }),
  probeWorkerClis: (refresh = false) =>
    requestJson<WorkerCliProbeResponse>("/api/worker/cli-probe", {
      method: refresh ? "POST" : "GET",
    }),
  testModel: (input: {
    providerSlug: string;
    api: string;
    baseUrl: string;
    apiKeyEnv?: string;
    apiKeyOverride?: string;
    providerHeaders?: Record<string, string>;
    model: ModelDefinitionConfig;
  }) =>
    requestJson<{
      ok: boolean;
      result: {
        ok: boolean;
        target: string;
        providerSlug: string;
        api: string;
        baseUrl: string;
        apiKeyEnv: string;
        latencyMs: number;
        replyPreview?: string;
        inputTokens?: number;
        outputTokens?: number;
        error?: string;
      };
    }>("/api/config/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  getStatics: (params: { limit?: number; slot?: string; since?: string; sessionId?: string | null }) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.slot) q.set("slot", params.slot);
    if (params.since) q.set("since", params.since);
    if (params.sessionId) q.set("sessionId", params.sessionId);
    return requestJson<StaticsResponse>(`/api/statics?${q.toString()}`);
  },
  getBrowserStatus: () => requestJson<{ ok: boolean; status: BrowserStatus }>("/api/browser/status"),
  browserAction: (payload: {
    action:
      | "open"
      | "close"
      | "navigate"
      | "back"
      | "forward"
      | "reload"
      | "new_tab"
      | "switch_tab"
      | "close_tab"
      | "resize"
      | "takeover"
      | "release_takeover"
      | "resume_takeover";
    url?: string;
    index?: number;
    width?: number;
    height?: number;
  }) =>
    requestJson<{ ok: boolean; status: BrowserStatus }>("/api/browser/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  browserInput: (
    payload:
      | {
          kind: "mouse";
          action: "move" | "down" | "up" | "click" | "dblclick" | "wheel";
          x?: number;
          y?: number;
          button?: "left" | "right" | "middle";
          deltaX?: number;
          deltaY?: number;
        }
      | {
          kind: "keyboard";
          action: "press" | "down" | "up" | "insertText";
          key?: string;
          text?: string;
        },
  ) =>
    requestJson<{ ok: boolean }>("/api/browser/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  async sendChatStream(
    payload: { text: string; images?: Array<{ data: string; mimeType: string }> },
    onEvent: (event: ChatSseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await consumeSseStream(
      "/api/chat/send",
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
        signal,
      },
      onEvent,
    );
  },
  subscribeBrowserStream(
    onEvent: (event: BrowserStreamEvent) => void,
    onError?: (err: Error) => void,
  ): () => void {
    const controller = new AbortController();
    void consumeSseStream<BrowserStreamEvent>(
      "/api/browser/stream",
      {
        method: "GET",
        headers: authHeaders(),
        signal: controller.signal,
      },
      onEvent,
    ).catch((err) => {
      if (!controller.signal.aborted && onError) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return () => controller.abort();
  },
};

async function consumeSseStream<T>(
  url: string,
  init: RequestInit,
  onEvent: (event: T) => void,
): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    try {
      const json = JSON.parse(text) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      if (text) message = text;
    }
    throw new ApiError(res.status, message);
  }
  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;
        try {
          onEvent(JSON.parse(jsonStr) as T);
        } catch {
          // ignore malformed event chunk
        }
      }
    }
  }
}
