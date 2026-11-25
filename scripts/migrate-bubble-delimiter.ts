#!/usr/bin/env bun
/**
 * External sidecar migration script: backfill legacy `---` bubble delimiters
 * (and optional recent unsplit blank-line casual replies) in SQLite `raw_messages`
 * to the configured explicit delimiter (default `[SPLIT]`).
 *
 * Usage:
 *   bun scripts/migrate-bubble-delimiter.ts --db /path/to/hato.db [--to "[SPLIT]"] [--fix-recent-since <unix_ms>]
 */
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { DEFAULT_BUBBLE_DELIMITER, hasStructuredContent } from "../src/persona/bubbles.js";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    db: { type: "string" },
    to: { type: "string", default: DEFAULT_BUBBLE_DELIMITER },
    "fix-recent-since": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.db) {
  console.error(
    "Usage: bun scripts/migrate-bubble-delimiter.ts --db <sqlite-path> [--to \"[SPLIT]\"] [--fix-recent-since <ms>] [--dry-run]",
  );
  process.exit(1);
}

const targetToken = (values.to ?? DEFAULT_BUBBLE_DELIMITER).trim() || DEFAULT_BUBBLE_DELIMITER;
const recentSinceMs = values["fix-recent-since"] ? Number(values["fix-recent-since"]) : null;
const dryRun = Boolean(values["dry-run"]);

const LEGACY_RULE_RE = /\r?\n[ \t]*---[ \t]*\r?\n/g;
const BLANK_LINE_SPLIT_RE = /\r?\n[ \t]*\r?\n+/g;

const db = new Database(values.db);
const rows = db
  .query<{ id: string; content: string; created_at: number }, []>(
    "SELECT id, content, created_at FROM raw_messages WHERE role = 'assistant' ORDER BY created_at ASC",
  )
  .all();

let convertedRuleCount = 0;
let convertedRecentBlankCount = 0;

const updateStmt = db.prepare("UPDATE raw_messages SET content = ? WHERE id = ?");

const tx = db.transaction(() => {
  for (const row of rows) {
    const text = row.content;
    if (!text || text.startsWith("[system_notice:") || hasStructuredContent(text)) {
      continue;
    }

    if (LEGACY_RULE_RE.test(text)) {
      LEGACY_RULE_RE.lastIndex = 0;
      const parts = text
        .split(LEGACY_RULE_RE)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length > 1) {
        const nextContent = parts.join(`\n\n${targetToken}\n\n`);
        if (nextContent !== text) {
          if (!dryRun) updateStmt.run(nextContent, row.id);
          convertedRuleCount++;
          continue;
        }
      }
    }

    if (
      recentSinceMs !== null &&
      Number.isFinite(recentSinceMs) &&
      row.created_at >= recentSinceMs &&
      !text.includes(targetToken) &&
      BLANK_LINE_SPLIT_RE.test(text)
    ) {
      BLANK_LINE_SPLIT_RE.lastIndex = 0;
      const parts = text
        .split(BLANK_LINE_SPLIT_RE)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length > 1 && parts.every((p) => !p.includes("\n") && p.length <= 120)) {
        const nextContent = parts.join(`\n\n${targetToken}\n\n`);
        if (nextContent !== text) {
          if (!dryRun) updateStmt.run(nextContent, row.id);
          convertedRecentBlankCount++;
        }
      }
    }
  }
});

tx();
db.close();

console.log(
  JSON.stringify({
    db: values.db,
    targetToken,
    dryRun,
    scannedAssistantRows: rows.length,
    convertedLegacyRuleRows: convertedRuleCount,
    convertedRecentBlankRows: convertedRecentBlankCount,
  }),
);
