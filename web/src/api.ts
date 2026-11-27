export interface RuntimeLogEntry {
  id: number;
  timestampMs: number;
  timeText: string;
  category: string;
  scope: string;
  message: string;
}

export type LogStreamEvent =
  | { type: "snapshot"; logs: RuntimeLogEntry[] }
  | { type: "log"; entry: RuntimeLogEntry };

export interface HealthResponse {
  ok: boolean;
  version?: string;
  githubUrl?: string;
  update?: {
    channel: "stable" | "nightly";
    hasUpdate: boolean;
    latestTag: string | null;
    releaseUrl: string;
  };
  uptimeSec: number;
  telegramEnabled: boolean;
  pendingTakeover: boolean;
  authRequired: boolean;
  runtime?: {
    isRoot: boolean;
    inDocker: boolean;
    showRootWarning: boolean;
  };
  console: {
    host: string;
    port: number;
  };
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SlotThinkingMap = Partial<Record<keyof ModelsFileConfig["slots"], ThinkingLevel>>;

export interface SlotView {
  slot: string;
  target: string;
  api: string;
  baseUrl: string;
  thinkingLevel?: ThinkingLevel;
  supportedThinkingLevels?: ThinkingLevel[];
  reasoning?: boolean;
}

export interface StoredMessageRecord {
  id: string;
  canonicalUserId: string;
  channel: string;
  role: "user" | "assistant" | "system" | "executed_event";
  content: string;
  bubbles?: string[];
  createdAt: number;
}

export interface TicketSummary {
  id: string;
  status: string;
  backend: string;
  briefTitle: string;
  originChannel: string;
  progressNote: string | null;
  workspaceDir?: string;
  createdAt: number;
  updatedAt: number;
}

export type WorkerActivityKind =
  | "lifecycle"
  | "command"
  | "tool"
  | "assistant"
  | "stderr"
  | "error";

export interface WorkerActivityItem {
  id: string;
  stepKey?: string;
  ticketId: string;
  seq: number;
  timestamp: number;
  updatedAt: number;
  kind: WorkerActivityKind;
  state: "running" | "done" | "error";
  title: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  durationMs?: number;
  text?: string;
}

export type TicketStreamEvent =
  | { type: "snapshot"; ticket: TicketSummary; items: WorkerActivityItem[] }
  | { type: "item"; item: WorkerActivityItem }
  | { type: "ticket"; ticket: TicketSummary };

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
    max_tool_calls_per_turn?: number;
    max_consecutive_failures?: number;
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
    clear_mode?: "cache" | "scheduled" | "idle";
    compaction_mode?: "curator" | "reuse_conversation";
    scheduled_clear_time?: string;
    scheduled_defer_minutes?: number;
    gap_marker_threshold_minutes: number;
    lookback: {
      max_step_count: number;
      max_total_messages: number;
      max_hours: number;
    };
  };
  memory: {
    provider?: "none" | "memoryecho" | "hindsight";
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
      | "codex-cli"
      | "antigravity-cli"
      | "opencode-v2"
      | "external-pi"
      | "claude-code";
    routing_mode?: "smart" | "always_default";
    execution_mode?: "isolated" | "vm_unrestricted";
    vm_workdir?: string;
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
      env?: Record<string, string>;
      codex_cli?: {
        enabled?: boolean;
        command?: string;
        sandbox?: string;
        approval?: string;
        effort?: string;
        model?: string;
      };
      antigravity_cli?: {
        enabled?: boolean;
        command?: string;
        mode?: string;
        skip_permissions?: boolean;
        sandbox?: boolean;
        effort?: string;
        model?: string;
      };
      opencode_v2?: {
        enabled?: boolean;
        command?: string;
        permission_mode?: string;
        auto?: boolean;
        agent?: string;
        effort?: string;
        model?: string;
      };
      external_pi?: {
        enabled?: boolean;
        command?: string;
        effort?: string;
        model?: string;
      };
      claude_code?: {
        enabled?: boolean;
        command?: string;
        permission_mode?: string;
        skip_permissions?: boolean;
        effort?: string;
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

export interface ExternalCliModelOption {
  id: string;
  label?: string;
}

export interface ExternalCliProbeEntry {
  backend: "codex-cli" | "antigravity-cli" | "opencode-v2" | "external-pi" | "claude-code";
  enabled: boolean;
  command: string;
  commandSource?: "default" | "configured";
  resolvedPath?: string;
  installed: boolean;
  available: boolean;
  version?: string;
  v2Verified?: boolean;
  reason?: string;
  hostConfigPath?: string;
  hostSummary: Record<string, string | boolean | string[]>;
  options: CliOptionChoice[];
  models?: ExternalCliModelOption[];
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
  models_dev?: {
    enabled: boolean;
    model_ref: string;
  };
}

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

export interface UpstreamModelEntry {
  id: string;
  name?: string;
  ownedBy?: string;
  created?: number;
  group: string;
  modelsDev?: ModelsDevMappedMetadata;
}

export type MemorySyncBank = "persona" | "tech" | "notebook";
export type MemorySyncStatus = "synced" | "degraded" | "denied" | "error" | "erased";

export interface MemorySyncRecord {
  id: string;
  canonicalUserId: string;
  provider: string;
  bank: MemorySyncBank;
  vaultId: string | null;
  sourceMsgIds: string[];
  content: string;
  externalMemoryId: string | null;
  status: MemorySyncStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySyncStats {
  total: number;
  synced: number;
  degraded: number;
  denied: number;
  error: number;
  erased: number;
  pendingRawMessages: number;
}

export interface MemoryVaultInfo {
  id: string;
  name: string;
  description: string | null;
  vaultType: string;
  memoryCount: number;
  storageBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryUsageSummary {
  vaultCount: number;
  periodKind: string;
  periodStart: string;
  periodEnd: string;
  unitsPerCredit: number;
  createCredits: number;
  createCount: number;
  queryCredits: number;
  queryCount: number;
  userPaidCredits: number;
}

export interface WorkingMemoryState {
  canonicalUserId: string;
  userProfile: string;
  summary: string;
  openLoops: string[];
  updatedAt: number;
}

export interface MemoryRecallItem {
  id: string;
  bank: MemorySyncBank;
  content: string;
  role?: string;
  score?: number;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryRecallResult {
  ok: boolean;
  bank: MemorySyncBank;
  items: MemoryRecallItem[];
  degraded: boolean;
  fallbackMessages?: MemoryRecallItem[];
  errorCode?: string;
  errorMessage?: string;
}

export interface MemoryOverviewResponse {
  ok: boolean;
  provider: "memoryecho" | "hindsight" | "none";
  configured: boolean;
  stats: MemorySyncStats;
  vaults: MemoryVaultInfo[];
  usage: MemoryUsageSummary | null;
  workingMemory: WorkingMemoryState;
}

export interface MemoryRetainSummary {
  processedMessages: number;
  extractedCount: number;
  syncedCount: number;
  degradedCount: number;
  deniedCount: number;
  errorCount: number;
  retriedCount: number;
}

export interface MemoryForgetSummary {
  matchedCount: number;
  erasedLocalCount: number;
  erasedRemoteCount: number;
  alreadyErasedCount: number;
  missingRemoteCount: number;
  unmappedCount: number;
  failedCount: number;
  errors: string[];
  matchedContents: string[];
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
    vision?: string;
  };
  slot_thinking?: SlotThinkingMap;
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
  defaultDisabled?: boolean;
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
  systemInjectedText?: string;
}

export interface TelegramUserProfile {
  id: string;
  ok: boolean;
  firstName?: string;
  lastName?: string;
  username?: string;
  displayName?: string;
  avatarDataUrl?: string;
  error?: string;
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

export type HomeChannelPlatform = "tg" | "qq";
export type ProactiveChannelOption = "tg" | "qq" | "last_active";

export interface PlatformHomeBinding {
  bound: boolean;
  channel: HomeChannelPlatform;
  targetId: string | null;
  source: "runtime" | "config" | null;
}

export interface PlatformHomeEntry extends PlatformHomeBinding {
  enabled: boolean;
  whitelistCount: number;
  pairing: {
    code: string;
    command: string;
    expiresAt: number;
  } | null;
}

export interface HomeBindingsResponse {
  ok: boolean;
  proactiveChannel: ProactiveChannelOption;
  lastActiveChannel: HomeChannelPlatform | null;
  platforms: {
    tg: PlatformHomeEntry;
    qq: PlatformHomeEntry;
  };
}

export interface OverviewResponse {
  ok: boolean;
  version?: string;
  githubUrl?: string;
  update?: {
    channel: "stable" | "nightly";
    hasUpdate: boolean;
    latestTag: string | null;
    releaseUrl: string;
  };
  uptimeSec: number;
  homes?: {
    tg: PlatformHomeBinding;
    qq: PlatformHomeBinding;
    proactiveChannel: ProactiveChannelOption;
    lastActiveChannel: HomeChannelPlatform | null;
  };
  gateways: {
    telegram: {
      enabled: boolean;
      running: boolean;
      online: boolean;
      username?: string;
      displayName?: string;
      botId?: string;
      avatarUrl?: string;
      whitelistCount: number;
    };
    qq: {
      enabled: boolean;
      running: boolean;
      online: boolean;
      sessionId?: string;
      username?: string;
      botId?: string;
      avatarUrl?: string;
      whitelistCount: number;
    };
  };
  messages: {
    total: number;
    inbound: number;
    outbound: number;
    last24h: number;
    hotCount: number;
    byChannel: { tg: number; qq: number; web: number };
  };
  tickets: {
    total: number;
    active: number;
    done: number;
    failed: number;
  };
  turns: {
    total: number;
    last24h: number;
    avgLatencyMs: number | null;
    avgCacheHitRate: number | null;
  };
  runtime: {
    personaModel: string;
    routerModel: string;
    workerBackend: string;
    workerRoutingMode: string;
    memoryProvider: string;
    pendingTakeover: boolean;
  };
}

export interface ProbeItemResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  skipped?: boolean;
  testedAtMs?: number;
  modelCount?: number;
  providerCount?: number;
}

export interface ProbeResponse {
  ok: boolean;
  results: {
    telegram?: ProbeItemResult;
    qq?: ProbeItemResult;
    tavily?: ProbeItemResult;
    memory?: ProbeItemResult;
    models_dev?: ProbeItemResult;
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
      errorMessage?: string;
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
  costUsd?: number | null;
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
  totalCostUsd?: number;
  totalSavedUsd?: number;
  pricedTurns?: number;
}

export interface StaticsResponse {
  ok: boolean;
  summary: StaticsSummary;
  traces: TurnTraceRecord[];
}

export interface LiveTraceSnapshot {
  id: string;
  canonicalUserId: string;
  slot: string;
  provider: string;
  modelId: string;
  api: string;
  userPreview: string | null;
  startedAt: number;
  updatedAt: number;
  status: "running";
  toolCalls: string[];
  steps: TraceStepRecord[];
  progressNote?: string;
}

export type TraceStreamEvent =
  | { type: "snapshot"; active: LiveTraceSnapshot[] }
  | { type: "active_update"; active: LiveTraceSnapshot[] }
  | { type: "trace_inserted"; traceId: string; slot: string; createdAt: number };

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

export interface StickerRecord {
  id: string;
  canonicalUserId: string;
  source: "user_send" | "tg_pack" | "auto_save";
  setName: string | null;
  emoji: string | null;
  tgFileId: string | null;
  localPath: string;
  mimeType: string;
  isAnimated: boolean;
  caption: string;
  emotions: string[];
  scenes: string[];
  style: string;
  status: "pending" | "ready" | "failed";
  errorMessage: string | null;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type NotebookEntryKind = "text" | "image" | "mixed";
export type NotebookIndexStatus = "synced" | "degraded" | "denied" | "error" | "local_only";

export interface NotebookEntryRecord {
  id: string;
  canonicalUserId: string;
  title: string;
  summary: string;
  reason: string;
  tags: string[];
  content: string;
  imagePath: string | null;
  imageMimeType: string | null;
  imageSha256: string | null;
  kind: NotebookEntryKind;
  hasText: boolean;
  hasImage: boolean;
  memoryProvider: string | null;
  memoryVaultId: string | null;
  externalMemoryId: string | null;
  indexStatus: NotebookIndexStatus;
  indexError: string | null;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface NotebookStats {
  total: number;
  textCount: number;
  imageCount: number;
  mixedCount: number;
  syncedCount: number;
}

export interface NotebookListResponse {
  ok: boolean;
  entries: NotebookEntryRecord[];
  usedSemanticIndex: boolean;
  degraded: boolean;
  errorMessage?: string;
  memoryConfigured: boolean;
  stats: NotebookStats;
}

export interface NotebookReindexResponse {
  ok: boolean;
  total: number;
  synced: number;
  failed: number;
  errorMessage?: string;
}

export const api = {
  getHealth: () => fetch("/api/health").then((r) => r.json() as Promise<HealthResponse>),
  getOverview: () => requestJson<OverviewResponse>("/api/overview"),
  listStickers: (q?: string) =>
    requestJson<{ ok: boolean; stickers: StickerRecord[] }>(
      q?.trim() ? `/api/stickers?q=${encodeURIComponent(q.trim())}` : "/api/stickers",
    ),
  stickerImageUrl: (id: string) => {
    const token = getStoredToken();
    const base = `/api/stickers/${encodeURIComponent(id)}/image`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  },
  updateSticker: (
    id: string,
    patch: { caption?: string; emotions?: string[]; scenes?: string[]; style?: string },
  ) =>
    requestJson<{ ok: boolean; sticker: StickerRecord }>(`/api/stickers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteSticker: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/stickers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  listNotebook: (params?: { q?: string; kind?: NotebookEntryKind | "all" }) => {
    const search = new URLSearchParams();
    if (params?.q?.trim()) search.set("q", params.q.trim());
    if (params?.kind && params.kind !== "all") search.set("kind", params.kind);
    const qs = search.toString();
    return requestJson<NotebookListResponse>(qs ? `/api/notebook?${qs}` : "/api/notebook");
  },
  notebookImageUrl: (id: string, version?: number) => {
    const token = getStoredToken();
    const base = `/api/notebook/${encodeURIComponent(id)}/image`;
    const search = new URLSearchParams();
    if (token) search.set("token", token);
    if (version !== undefined) search.set("v", String(version));
    const qs = search.toString();
    return qs ? `${base}?${qs}` : base;
  },
  createNotebookEntry: (payload: {
    title?: string;
    summary: string;
    reason: string;
    content?: string;
    tags?: string[];
    imageDataUrl?: string;
  }) =>
    requestJson<{ ok: boolean; entry: NotebookEntryRecord }>("/api/notebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  updateNotebookEntry: (
    id: string,
    payload: {
      title?: string;
      summary?: string;
      reason?: string;
      content?: string;
      tags?: string[];
      imageDataUrl?: string;
      removeImage?: boolean;
    },
  ) =>
    requestJson<{ ok: boolean; entry: NotebookEntryRecord }>(
      `/api/notebook/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
  deleteNotebookEntry: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/notebook/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  reindexNotebook: (force = false) =>
    requestJson<NotebookReindexResponse>("/api/notebook/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    }),
  getPairingCode: (opts?: { refresh?: boolean; channel?: HomeChannelPlatform }) => {
    const params = new URLSearchParams();
    if (opts?.refresh) params.set("refresh", "1");
    if (opts?.channel) params.set("channel", opts.channel);
    const qs = params.toString();
    return requestJson<HomeBindingsResponse>(qs ? `/api/pairing-code?${qs}` : "/api/pairing-code");
  },
  unbindHome: (channel: HomeChannelPlatform, clearChannelWhitelist = false) =>
    requestJson<
      HomeBindingsResponse & {
        channel: HomeChannelPlatform;
        previousHome: PlatformHomeBinding;
        clearedWhitelist: boolean;
      }
    >("/api/home/unbind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, clearChannelWhitelist }),
    }),
  setProactiveChannel: (proactiveChannel: ProactiveChannelOption) =>
    requestJson<HomeBindingsResponse>("/api/home/proactive-channel", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proactiveChannel }),
    }),
  toggleGateway: (channel: "tg" | "qq", enabled: boolean) =>
    requestJson<{ ok: boolean; channel: "tg" | "qq"; enabled: boolean }>("/api/gateway/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, enabled }),
    }),
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
  setSlotThinking: (slot: string, level: ThinkingLevel | "auto" | null) =>
    requestJson<{
      ok: boolean;
      slot: string;
      requested: ThinkingLevel | null;
      effective: ThinkingLevel;
      reasoningSupported: boolean;
      slots: SlotView[];
    }>("/api/config/thinking", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot, level }),
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
  saveSecrets: (updates: Record<string, string | null>) =>
    requestJson<{ ok: boolean; writtenKeys: string[]; deletedKeys?: string[]; secretStates: SecretState[]; changes?: string[] }>(
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
  probe: (target: "all" | "telegram" | "qq" | "tavily" | "memory" | "models_dev") =>
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
    providerCompat?: Record<string, unknown>;
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
  lookupModelsDev: (ref: string, refresh = false) => {
    const q = new URLSearchParams({ ref });
    if (refresh) q.set("refresh", "1");
    return requestJson<{ ok: boolean; metadata: ModelsDevMappedMetadata }>(
      `/api/models-dev/lookup?${q.toString()}`,
    );
  },
  searchModelsDev: (q: string, limit = 15) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return requestJson<{ ok: boolean; items: ModelsDevSearchItem[] }>(
      `/api/models-dev/search?${params.toString()}`,
    );
  },
  fetchUpstreamModels: (input: {
    providerSlug: string;
    api: string;
    baseUrl: string;
    apiKeyEnv?: string;
    apiKeyOverride?: string;
    providerHeaders?: Record<string, string>;
  }) =>
    requestJson<{
      ok: boolean;
      models: UpstreamModelEntry[];
      fetchedFrom: string;
      latencyMs: number;
    }>("/api/config/models/upstream", {
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
  fetchTelegramUsers: (userIds: Array<string | number>, refresh = false) =>
    requestJson<{ ok: boolean; profiles: TelegramUserProfile[] }>("/api/gateway/telegram/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds, refresh }),
    }),
  getWorkerCliModels: (
    backend: "codex-cli" | "antigravity-cli" | "opencode-v2" | "external-pi" | "claude-code",
  ) =>
    requestJson<{ ok: boolean; backend: string; models: ExternalCliModelOption[] }>(
      `/api/worker/cli-models?backend=${encodeURIComponent(backend)}`,
    ),
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
  getTickets: () =>
    requestJson<{ ok: boolean; tickets: TicketSummary[] }>("/api/tickets"),
  confirmTicket: (ticketId: string, approved: boolean) =>
    requestJson<{ ok: boolean; message: string }>("/api/tickets/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, approved }),
    }),
  abortTicket: (ticketId: string) =>
    requestJson<{ ok: boolean; message: string }>("/api/tickets/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId }),
    }),
  subscribeTicketStream(
    ticketId: string,
    onEvent: (event: TicketStreamEvent) => void,
    onError?: (err: Error) => void,
  ): () => void {
    let closed = false;
    let controller: AbortController | null = null;
    let reconnectTimer: number | null = null;

    const connect = async (attempt = 0) => {
      if (closed) return;
      controller = new AbortController();
      try {
        await consumeSseStream<TicketStreamEvent>(
          `/api/tickets/stream?ticketId=${encodeURIComponent(ticketId)}`,
          {
            method: "GET",
            headers: authHeaders(),
            signal: controller.signal,
          },
          (ev) => {
            attempt = 0;
            onEvent(ev);
          },
        );
        if (!closed) {
          const delay = Math.min(8_000, 1200 * Math.pow(1.5, attempt));
          reconnectTimer = window.setTimeout(() => void connect(attempt + 1), delay);
        }
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
        if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
          return;
        }
        const delay = Math.min(10_000, 1800 * Math.pow(1.5, attempt));
        reconnectTimer = window.setTimeout(() => void connect(attempt + 1), delay);
      }
    };

    void connect(0);

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      controller?.abort();
    };
  },
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
  subscribeTraceStream(
    onEvent: (event: TraceStreamEvent) => void,
    onError?: (err: Error) => void,
  ): () => void {
    let closed = false;
    let controller: AbortController | null = null;
    let reconnectTimer: number | null = null;

    const connect = async (attempt = 0) => {
      if (closed) return;
      controller = new AbortController();
      try {
        await consumeSseStream<TraceStreamEvent>(
          "/api/traces/stream",
          {
            method: "GET",
            headers: authHeaders(),
            signal: controller.signal,
          },
          (ev) => {
            attempt = 0;
            onEvent(ev);
          },
        );
        if (!closed) {
          const delay = Math.min(10_000, 1500 * Math.pow(1.5, attempt));
          reconnectTimer = window.setTimeout(() => void connect(attempt + 1), delay);
        }
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return;
        }
        const delay = Math.min(15_000, 2000 * Math.pow(1.5, attempt));
        reconnectTimer = window.setTimeout(() => void connect(attempt + 1), delay);
      }
    };

    void connect(0);

    return () => {
      closed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      controller?.abort();
    };
  },
  async getLogs(params?: {
    limit?: number;
    category?: string;
    scope?: string;
    q?: string;
  }): Promise<{ ok: boolean; logs: RuntimeLogEntry[] }> {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.category && params.category !== "ALL") search.set("category", params.category);
    if (params?.scope) search.set("scope", params.scope);
    if (params?.q) search.set("q", params.q);
    const qs = search.toString();
    return requestJson<{ ok: boolean; logs: RuntimeLogEntry[] }>(`/api/logs${qs ? `?${qs}` : ""}`);
  },
  subscribeLogStream(
    onEvent: (event: LogStreamEvent) => void,
    onError?: (err: Error) => void,
  ): () => void {
    let closed = false;
    let controller: AbortController | null = null;
    let reconnectTimer: number | null = null;

    const connect = async (attempt = 0) => {
      if (closed) return;
      controller = new AbortController();
      try {
        await consumeSseStream<LogStreamEvent>(
          "/api/logs/stream",
          {
            method: "GET",
            headers: authHeaders(),
            signal: controller.signal,
          },
          (ev) => {
            attempt = 0;
            onEvent(ev);
          },
        );
        if (!closed) {
          const delay = Math.min(10_000, 1500 * Math.pow(1.5, attempt));
          reconnectTimer = window.setTimeout(() => void connect(attempt + 1), delay);
        }
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return;
        }
        const delay = Math.min(15_000, 2000 * Math.pow(1.5, attempt));
        reconnectTimer = window.setTimeout(() => void connect(attempt + 1), delay);
      }
    };

    void connect(0);

    return () => {
      closed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      controller?.abort();
    };
  },
  getMemoryOverview: () => requestJson<MemoryOverviewResponse>("/api/memory/overview"),
  listMemoryRecords: (params?: {
    bank?: MemorySyncBank;
    status?: MemorySyncStatus;
    includeErased?: boolean;
    q?: string;
    limit?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.bank) q.set("bank", params.bank);
    if (params?.status) q.set("status", params.status);
    if (params?.includeErased) q.set("includeErased", "1");
    if (params?.q?.trim()) q.set("q", params.q.trim());
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return requestJson<{ ok: boolean; records: MemorySyncRecord[] }>(
      `/api/memory/records${qs ? `?${qs}` : ""}`,
    );
  },
  recallMemory: (input: { query: string; bank?: MemorySyncBank; limit?: number }) =>
    requestJson<{ ok: boolean; result: MemoryRecallResult }>("/api/memory/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  syncMemory: (input?: { includeDenied?: boolean }) =>
    requestJson<{ ok: boolean; summary: MemoryRetainSummary }>("/api/memory/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
    }),
  forgetMemory: (input: { recordIds?: string[]; query?: string }) =>
    requestJson<{ ok: boolean; summary: MemoryForgetSummary }>("/api/memory/forget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
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
