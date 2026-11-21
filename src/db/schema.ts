import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const owners = sqliteTable("owners", {
  canonicalUserId: text("canonical_user_id").primaryKey(),
  tgUserId: text("tg_user_id"),
  qqOpenId: text("qq_open_id"),
  timezone: text("timezone").notNull(),
  proactiveChannel: text("proactive_channel").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const rawMessages = sqliteTable("raw_messages", {
  id: text("id").primaryKey(),
  canonicalUserId: text("canonical_user_id").notNull(),
  channel: text("channel").notNull(),
  platformMsgId: text("platform_msg_id"),
  replyToId: text("reply_to_id"),
  role: text("role").notNull(), // "user" | "assistant" | "executed_event"
  content: text("content").notNull(),
  attachmentsJson: text("attachments_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
});

export const workingMemoryBlocks = sqliteTable("working_memory_blocks", {
  canonicalUserId: text("canonical_user_id").primaryKey(),
  summaryText: text("summary_text").notNull().default(""),
  compactedUntilMsgId: text("compacted_until_msg_id"),
  compactedUntilTs: integer("compacted_until_ts").notNull().default(0),
  draftSummary: text("draft_summary"),
  draftUntilMsgId: text("draft_until_msg_id"),
  draftUntilTs: integer("draft_until_ts"),
  retainedUntilMsgId: text("retained_until_msg_id"),
  updatedAt: integer("updated_at").notNull(),
});

export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey(),
  canonicalUserId: text("canonical_user_id").notNull(),
  status: text("status").notNull(),
  backend: text("backend").notNull(),
  briefTitle: text("brief_title").notNull(),
  contextId: text("context_id"),
  contextFromMsgId: text("context_from_msg_id"),
  contextToMsgId: text("context_to_msg_id"),
  maxLookbackMsgId: text("max_lookback_msg_id"),
  externalSessionId: text("external_session_id"),
  progressNote: text("progress_note"),
  originChannel: text("origin_channel").notNull(),
  mandateJson: text("mandate_json"),
  modelSnapshotJson: text("model_snapshot_json"),
  resultJson: text("result_json"),
  workspaceExpiresAt: integer("workspace_expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const scriptRegistry = sqliteTable("script_registry", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull(),
  name: text("name").notNull(),
  scriptPath: text("script_path").notNull(),
  cronExpr: text("cron_expr").notNull(),
  notifyChannel: text("notify_channel").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  requiredSecretsJson: text("required_secrets_json").notNull().default("[]"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const jobRuns = sqliteTable("job_runs", {
  id: text("id").primaryKey(),
  scriptId: text("script_id").notNull(),
  exitCode: integer("exit_code").notNull(),
  stdoutTail: text("stdout_tail").notNull().default(""),
  stderrTail: text("stderr_tail").notNull().default(""),
  ranAt: integer("ran_at").notNull(),
});

export const openLoops = sqliteTable("open_loops", {
  id: text("id").primaryKey(),
  canonicalUserId: text("canonical_user_id").notNull(),
  content: text("content").notNull(),
  dueAt: integer("due_at").notNull(),
  notifyChannel: text("notify_channel").notNull(),
  status: text("status").notNull(),
  unansweredStreak: integer("unanswered_streak").notNull().default(0),
  sourceMsgId: text("source_msg_id"),
  createdAt: integer("created_at").notNull(),
});

export const scheduleOverrides = sqliteTable("schedule_overrides", {
  id: text("id").primaryKey(),
  canonicalUserId: text("canonical_user_id").notNull(),
  tempTimezone: text("temp_timezone"),
  statusNote: text("status_note"),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const relationshipFacts = sqliteTable("relationship_facts", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  sourceMsgId: text("source_msg_id"),
  updatedAt: integer("updated_at").notNull(),
});

export const runtimeSettings = sqliteTable("runtime_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const turnTraces = sqliteTable("turn_traces", {
  id: text("id").primaryKey(),
  canonicalUserId: text("canonical_user_id").notNull(),
  slot: text("slot").notNull(),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull(),
  api: text("api").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  cacheHitRate: real("cache_hit_rate").notNull().default(0),
  ttftMs: integer("ttft_ms"),
  tps: real("tps"),
  userPreview: text("user_preview"),
  recalledIdsJson: text("recalled_ids_json").notNull().default("[]"),
  timeCardText: text("time_card_text").notNull().default(""),
  toolCallsJson: text("tool_calls_json").notNull().default("[]"),
  stepsJson: text("steps_json").notNull().default("[]"),
  latencyMs: integer("latency_ms").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  canonicalUserId: text("canonical_user_id").notNull(),
  title: text("title").notNull(),
  summaryText: text("summary_text").notNull().default(""),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at").notNull(),
  messageCount: integer("message_count").notNull().default(0),
  traceCount: integer("trace_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const memorySyncRecords = sqliteTable("memory_sync_records", {
  id: text("id").primaryKey(),
  canonicalUserId: text("canonical_user_id").notNull(),
  provider: text("provider").notNull(),
  bank: text("bank").notNull(), // "persona" | "tech" | "notebook"
  vaultId: text("vault_id"),
  sourceMsgIdsJson: text("source_msg_ids_json").notNull().default("[]"),
  content: text("content").notNull(),
  externalMemoryId: text("external_memory_id"),
  status: text("status").notNull(), // "synced" | "degraded" | "denied" | "error" | "erased"
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const stickers = sqliteTable("stickers", {
  id: text("id").primaryKey(),
  canonicalUserId: text("canonical_user_id").notNull(),
  source: text("source").notNull(), // "user_send" | "tg_pack" | "auto_save"
  setName: text("set_name"),
  emoji: text("emoji"),
  tgFileId: text("tg_file_id"),
  tgFileUniqueId: text("tg_file_unique_id"),
  localPath: text("local_path").notNull(),
  mimeType: text("mime_type").notNull().default("image/webp"),
  sha256: text("sha256").notNull(),
  isAnimated: integer("is_animated").notNull().default(0),
  caption: text("caption").notNull().default(""),
  emotionsJson: text("emotions_json").notNull().default("[]"),
  scenesJson: text("scenes_json").notNull().default("[]"),
  style: text("style").notNull().default(""),
  status: text("status").notNull().default("pending"), // "pending" | "ready" | "failed"
  errorMessage: text("error_message"),
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: integer("last_used_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const notebookEntries = sqliteTable("notebook_entries", {
  id: text("id").primaryKey(),
  canonicalUserId: text("canonical_user_id").notNull(),
  title: text("title").notNull().default(""),
  summary: text("summary").notNull(),
  reason: text("reason").notNull(),
  tagsJson: text("tags_json").notNull().default("[]"),
  content: text("content").notNull().default(""),
  imagePath: text("image_path"),
  imageMimeType: text("image_mime_type"),
  imageSha256: text("image_sha256"),
  memoryProvider: text("memory_provider"),
  memoryVaultId: text("memory_vault_id"),
  externalMemoryId: text("external_memory_id"),
  indexStatus: text("index_status").notNull().default("local_only"), // "synced" | "degraded" | "denied" | "error" | "local_only"
  indexError: text("index_error"),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: integer("last_accessed_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
