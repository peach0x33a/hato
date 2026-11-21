import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.js";

export type HatoDb = BunSQLiteDatabase<typeof schema>;

export interface DbHandle {
  sqlite: Database;
  db: HatoDb;
  close(): void;
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS owners (
  canonical_user_id TEXT PRIMARY KEY,
  tg_user_id TEXT,
  qq_open_id TEXT,
  timezone TEXT NOT NULL,
  proactive_channel TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_messages (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  platform_msg_id TEXT,
  reply_to_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_messages_user_time ON raw_messages (canonical_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_raw_messages_platform_msg ON raw_messages (channel, platform_msg_id);

CREATE TABLE IF NOT EXISTS working_memory_blocks (
  canonical_user_id TEXT PRIMARY KEY,
  summary_text TEXT NOT NULL DEFAULT '',
  compacted_until_msg_id TEXT,
  compacted_until_ts INTEGER NOT NULL DEFAULT 0,
  draft_summary TEXT,
  draft_until_msg_id TEXT,
  draft_until_ts INTEGER,
  retained_until_msg_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  backend TEXT NOT NULL,
  brief_title TEXT NOT NULL,
  context_id TEXT,
  context_from_msg_id TEXT,
  context_to_msg_id TEXT,
  max_lookback_msg_id TEXT,
  external_session_id TEXT,
  progress_note TEXT,
  origin_channel TEXT NOT NULL,
  mandate_json TEXT,
  model_snapshot_json TEXT,
  result_json TEXT,
  workspace_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets (canonical_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_context_id ON tickets (context_id);

CREATE TABLE IF NOT EXISTS script_registry (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  name TEXT NOT NULL,
  script_path TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  notify_channel TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  required_secrets_json TEXT NOT NULL DEFAULT '[]',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  stdout_tail TEXT NOT NULL DEFAULT '',
  stderr_tail TEXT NOT NULL DEFAULT '',
  ran_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_runs_script_time ON job_runs (script_id, ran_at);

CREATE TABLE IF NOT EXISTS open_loops (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  notify_channel TEXT NOT NULL,
  status TEXT NOT NULL,
  unanswered_streak INTEGER NOT NULL DEFAULT 0,
  source_msg_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_open_loops_user_status_due ON open_loops (canonical_user_id, status, due_at);

CREATE TABLE IF NOT EXISTS schedule_overrides (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  temp_timezone TEXT,
  status_note TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_overrides_user_exp ON schedule_overrides (canonical_user_id, expires_at);

CREATE TABLE IF NOT EXISTS relationship_facts (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  source_msg_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_traces (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  api TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_rate REAL NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  tps REAL,
  user_preview TEXT,
  recalled_ids_json TEXT NOT NULL DEFAULT '[]',
  time_card_text TEXT NOT NULL DEFAULT '',
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '[]',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_traces_user_time ON turn_traces (canonical_user_id, created_at);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary_text TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  trace_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_time ON chat_sessions (canonical_user_id, ended_at);

CREATE TABLE IF NOT EXISTS memory_sync_records (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  bank TEXT NOT NULL,
  vault_id TEXT,
  source_msg_ids_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  external_memory_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_sync_user_bank ON memory_sync_records (canonical_user_id, bank, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_sync_status ON memory_sync_records (canonical_user_id, status, updated_at);

CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  set_name TEXT,
  emoji TEXT,
  tg_file_id TEXT,
  tg_file_unique_id TEXT,
  local_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/webp',
  sha256 TEXT NOT NULL,
  is_animated INTEGER NOT NULL DEFAULT 0,
  caption TEXT NOT NULL DEFAULT '',
  emotions_json TEXT NOT NULL DEFAULT '[]',
  scenes_json TEXT NOT NULL DEFAULT '[]',
  style TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stickers_user_status ON stickers (canonical_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_stickers_sha256 ON stickers (canonical_user_id, sha256);
CREATE INDEX IF NOT EXISTS idx_stickers_tg_unique ON stickers (canonical_user_id, tg_file_unique_id);

CREATE TABLE IF NOT EXISTS notebook_entries (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  image_mime_type TEXT,
  image_sha256 TEXT,
  memory_provider TEXT,
  memory_vault_id TEXT,
  external_memory_id TEXT,
  index_status TEXT NOT NULL DEFAULT 'local_only',
  index_error TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notebook_user_updated ON notebook_entries (canonical_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notebook_ext_mem ON notebook_entries (canonical_user_id, external_memory_id);
`;

export interface OpenDatabaseOptions {
  readonly?: boolean;
}

export function openDatabase(sqlitePath: string, options?: OpenDatabaseOptions): DbHandle {
  const isReadonly = Boolean(options?.readonly);
  if (sqlitePath !== ":memory:" && !isReadonly) {
    mkdirSync(dirname(resolve(sqlitePath)), { recursive: true });
  }
  const sqlite = isReadonly
    ? new Database(sqlitePath, { readonly: true })
    : new Database(sqlitePath);
  if (isReadonly) {
    sqlite.exec("PRAGMA busy_timeout = 5000;");
  } else {
    sqlite.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
    );
    sqlite.exec(INIT_SQL);
  }

  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    close() {
      sqlite.close();
    },
  };
}
