import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { HatoDb } from "../db/client.js";
import { notebookEntries } from "../db/schema.js";

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

/**
 * Derive the entry kind from whether text content and/or an image path is present.
 */
export function deriveNotebookKind(content: string, imagePath: string | null): NotebookEntryKind {
  const hasText = content.trim().length > 0;
  const hasImage = Boolean(imagePath && imagePath.trim().length > 0);
  if (hasText && hasImage) return "mixed";
  if (hasImage) return "image";
  return "text";
}

/**
 * Generate a unique notebook entry ID (`nb_<base36_ts>_<6hex>`).
 */
export function generateNotebookEntryId(nowMs = Date.now()): string {
  return `nb_${nowMs.toString(36)}_${randomBytes(3).toString("hex")}`;
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed.map((v) => String(v).trim()).filter(Boolean)))
      : [];
  } catch {
    return [];
  }
}

function normalizeTags(tags?: readonly string[]): string[] {
  if (!tags) return [];
  return Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
}

function mapRow(row: typeof notebookEntries.$inferSelect): NotebookEntryRecord {
  const hasText = row.content.trim().length > 0;
  const imagePath = row.imagePath ?? null;
  const hasImage = Boolean(imagePath && imagePath.trim().length > 0);
  return {
    id: row.id,
    canonicalUserId: row.canonicalUserId,
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    tags: parseTags(row.tagsJson),
    content: row.content,
    imagePath,
    imageMimeType: row.imageMimeType ?? null,
    imageSha256: row.imageSha256 ?? null,
    kind: deriveNotebookKind(row.content, imagePath),
    hasText,
    hasImage,
    memoryProvider: row.memoryProvider ?? null,
    memoryVaultId: row.memoryVaultId ?? null,
    externalMemoryId: row.externalMemoryId ?? null,
    indexStatus: row.indexStatus as NotebookIndexStatus,
    indexError: row.indexError ?? null,
    accessCount: row.accessCount,
    lastAccessedAt: row.lastAccessedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function tokenizeSearchQuery(query: string): string[] {
  const cleaned = query.trim().toLowerCase();
  if (!cleaned) return [];
  const baseTokens = cleaned.split(/[\s,，、/|;；]+/).filter(Boolean);
  const tokens = new Set<string>(baseTokens);
  // Add 2-char CJK bigrams when query has unspaced Chinese/Japanese text so partial matches work.
  for (const tok of baseTokens) {
    if (/[\u4e00-\u9fff]/.test(tok) && tok.length >= 3) {
      for (let i = 0; i <= tok.length - 2; i += 1) {
        tokens.add(tok.slice(i, i + 2));
      }
    }
  }
  return Array.from(tokens);
}

/**
 * SQLite-backed store for Hato's notebook entries (`notebook_entries`).
 */
export class NotebookStore {
  constructor(private readonly db: HatoDb) {}

  create(input: {
    id?: string;
    canonicalUserId: string;
    title?: string;
    summary: string;
    reason: string;
    tags?: readonly string[];
    content?: string;
    imagePath?: string | null;
    imageMimeType?: string | null;
    imageSha256?: string | null;
    memoryProvider?: string | null;
    memoryVaultId?: string | null;
    externalMemoryId?: string | null;
    indexStatus?: NotebookIndexStatus;
    indexError?: string | null;
  }): NotebookEntryRecord {
    const now = Date.now();
    const id = input.id?.trim() || generateNotebookEntryId(now);
    this.db
      .insert(notebookEntries)
      .values({
        id,
        canonicalUserId: input.canonicalUserId,
        title: (input.title ?? "").trim(),
        summary: input.summary.trim(),
        reason: input.reason.trim(),
        tagsJson: JSON.stringify(normalizeTags(input.tags)),
        content: input.content ?? "",
        imagePath: input.imagePath ?? null,
        imageMimeType: input.imageMimeType ?? null,
        imageSha256: input.imageSha256 ?? null,
        memoryProvider: input.memoryProvider ?? null,
        memoryVaultId: input.memoryVaultId ?? null,
        externalMemoryId: input.externalMemoryId ?? null,
        indexStatus: input.indexStatus ?? "local_only",
        indexError: input.indexError ?? null,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.getById(input.canonicalUserId, id)!;
  }

  getById(canonicalUserId: string, id: string): NotebookEntryRecord | null {
    const rows = this.db
      .select()
      .from(notebookEntries)
      .where(and(eq(notebookEntries.canonicalUserId, canonicalUserId), eq(notebookEntries.id, id)))
      .limit(1)
      .all();
    return rows[0] ? mapRow(rows[0]) : null;
  }

  findByExternalMemoryId(canonicalUserId: string, externalMemoryId: string): NotebookEntryRecord | null {
    const cleaned = externalMemoryId.trim();
    if (!cleaned) return null;
    const rows = this.db
      .select()
      .from(notebookEntries)
      .where(
        and(
          eq(notebookEntries.canonicalUserId, canonicalUserId),
          eq(notebookEntries.externalMemoryId, cleaned),
        ),
      )
      .limit(1)
      .all();
    return rows[0] ? mapRow(rows[0]) : null;
  }

  list(
    canonicalUserId: string,
    opts?: { kind?: NotebookEntryKind | "all"; limit?: number },
  ): NotebookEntryRecord[] {
    const rows = this.db
      .select()
      .from(notebookEntries)
      .where(eq(notebookEntries.canonicalUserId, canonicalUserId))
      .orderBy(desc(notebookEntries.updatedAt))
      .all();
    let mapped = rows.map(mapRow);
    if (opts?.kind && opts.kind !== "all") {
      mapped = mapped.filter((entry) => entry.kind === opts.kind);
    }
    const limit = opts?.limit ?? 100;
    return mapped.slice(0, Math.max(1, limit));
  }

  searchLocal(
    canonicalUserId: string,
    query: string,
    opts?: { kind?: NotebookEntryKind | "all"; limit?: number },
  ): NotebookEntryRecord[] {
    const limit = Math.max(1, opts?.limit ?? 20);
    const cleaned = query.trim().toLowerCase();
    if (!cleaned) {
      return this.list(canonicalUserId, { kind: opts?.kind, limit });
    }

    const all = this.list(canonicalUserId, { kind: opts?.kind, limit: 1000 });
    const tokens = tokenizeSearchQuery(cleaned);

    const scored = all
      .map((entry) => {
        const idLower = entry.id.toLowerCase();
        const titleLower = entry.title.toLowerCase();
        const summaryLower = entry.summary.toLowerCase();
        const reasonLower = entry.reason.toLowerCase();
        const tagsLower = entry.tags.join(" ").toLowerCase();
        const contentLower = entry.content.toLowerCase();

        let score = 0;
        if (idLower === cleaned) score += 20;
        else if (idLower.includes(cleaned)) score += 10;

        if (titleLower.includes(cleaned)) score += 6;
        if (summaryLower.includes(cleaned)) score += 5;
        if (reasonLower.includes(cleaned)) score += 4;
        if (tagsLower.includes(cleaned)) score += 4;
        if (contentLower.includes(cleaned)) score += 2;

        for (const tok of tokens) {
          if (titleLower.includes(tok)) score += 2.5;
          if (summaryLower.includes(tok)) score += 2;
          if (reasonLower.includes(tok)) score += 1.5;
          if (tagsLower.includes(tok)) score += 1.5;
          if (contentLower.includes(tok)) score += 1;
        }
        return { entry, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
      .slice(0, limit);

    return scored.map((x) => x.entry);
  }

  update(
    canonicalUserId: string,
    id: string,
    patch: {
      title?: string;
      summary?: string;
      reason?: string;
      tags?: readonly string[];
      content?: string;
      imagePath?: string | null;
      imageMimeType?: string | null;
      imageSha256?: string | null;
    },
  ): NotebookEntryRecord | null {
    const existing = this.getById(canonicalUserId, id);
    if (!existing) return null;

    this.db
      .update(notebookEntries)
      .set({
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason.trim() } : {}),
        ...(patch.tags !== undefined ? { tagsJson: JSON.stringify(normalizeTags(patch.tags)) } : {}),
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.imagePath !== undefined ? { imagePath: patch.imagePath } : {}),
        ...(patch.imageMimeType !== undefined ? { imageMimeType: patch.imageMimeType } : {}),
        ...(patch.imageSha256 !== undefined ? { imageSha256: patch.imageSha256 } : {}),
        updatedAt: Date.now(),
      })
      .where(and(eq(notebookEntries.canonicalUserId, canonicalUserId), eq(notebookEntries.id, id)))
      .run();

    return this.getById(canonicalUserId, id);
  }

  updateIndexState(
    canonicalUserId: string,
    id: string,
    state: {
      memoryProvider?: string | null;
      memoryVaultId?: string | null;
      externalMemoryId?: string | null;
      indexStatus: NotebookIndexStatus;
      indexError?: string | null;
    },
  ): NotebookEntryRecord | null {
    const existing = this.getById(canonicalUserId, id);
    if (!existing) return null;

    this.db
      .update(notebookEntries)
      .set({
        ...(state.memoryProvider !== undefined ? { memoryProvider: state.memoryProvider } : {}),
        ...(state.memoryVaultId !== undefined ? { memoryVaultId: state.memoryVaultId } : {}),
        ...(state.externalMemoryId !== undefined ? { externalMemoryId: state.externalMemoryId } : {}),
        indexStatus: state.indexStatus,
        indexError: state.indexError ?? null,
      })
      .where(and(eq(notebookEntries.canonicalUserId, canonicalUserId), eq(notebookEntries.id, id)))
      .run();

    return this.getById(canonicalUserId, id);
  }

  recordAccessed(canonicalUserId: string, id: string): void {
    const existing = this.getById(canonicalUserId, id);
    if (!existing) return;
    this.db
      .update(notebookEntries)
      .set({
        accessCount: existing.accessCount + 1,
        lastAccessedAt: Date.now(),
      })
      .where(and(eq(notebookEntries.canonicalUserId, canonicalUserId), eq(notebookEntries.id, id)))
      .run();
  }

  delete(canonicalUserId: string, id: string): NotebookEntryRecord | null {
    const existing = this.getById(canonicalUserId, id);
    if (!existing) return null;
    this.db
      .delete(notebookEntries)
      .where(and(eq(notebookEntries.canonicalUserId, canonicalUserId), eq(notebookEntries.id, id)))
      .run();
    return existing;
  }

  getStats(canonicalUserId: string): NotebookStats {
    const rows = this.list(canonicalUserId, { limit: 10_000 });
    let textCount = 0;
    let imageCount = 0;
    let mixedCount = 0;
    let syncedCount = 0;
    for (const row of rows) {
      if (row.kind === "text") textCount += 1;
      else if (row.kind === "image") imageCount += 1;
      else mixedCount += 1;
      if (row.indexStatus === "synced") syncedCount += 1;
    }
    return {
      total: rows.length,
      textCount,
      imageCount,
      mixedCount,
      syncedCount,
    };
  }
}
