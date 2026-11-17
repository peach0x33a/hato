import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { HatoDb } from "../db/client.js";
import { stickers } from "../db/schema.js";

export type StickerSource = "user_send" | "tg_pack" | "auto_save";
export type StickerStatus = "pending" | "ready" | "failed";

export interface StickerRecord {
  id: string;
  canonicalUserId: string;
  source: StickerSource;
  setName: string | null;
  emoji: string | null;
  tgFileId: string | null;
  tgFileUniqueId: string | null;
  localPath: string;
  mimeType: string;
  sha256: string;
  isAnimated: boolean;
  caption: string;
  emotions: string[];
  scenes: string[];
  style: string;
  status: StickerStatus;
  errorMessage: string | null;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((v) => String(v).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function mapRow(row: typeof stickers.$inferSelect): StickerRecord {
  return {
    id: row.id,
    canonicalUserId: row.canonicalUserId,
    source: row.source as StickerSource,
    setName: row.setName ?? null,
    emoji: row.emoji ?? null,
    tgFileId: row.tgFileId ?? null,
    tgFileUniqueId: row.tgFileUniqueId ?? null,
    localPath: row.localPath,
    mimeType: row.mimeType,
    sha256: row.sha256,
    isAnimated: Boolean(row.isAnimated),
    caption: row.caption,
    emotions: parseStringArray(row.emotionsJson),
    scenes: parseStringArray(row.scenesJson),
    style: row.style,
    status: row.status as StickerStatus,
    errorMessage: row.errorMessage ?? null,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class StickerStore {
  constructor(private readonly db: HatoDb) {}

  findBySha256(canonicalUserId: string, sha256: string): StickerRecord | null {
    const rows = this.db
      .select()
      .from(stickers)
      .where(and(eq(stickers.canonicalUserId, canonicalUserId), eq(stickers.sha256, sha256)))
      .limit(1)
      .all();
    return rows[0] ? mapRow(rows[0]) : null;
  }

  findByTgUniqueId(canonicalUserId: string, tgFileUniqueId: string): StickerRecord | null {
    const rows = this.db
      .select()
      .from(stickers)
      .where(
        and(
          eq(stickers.canonicalUserId, canonicalUserId),
          eq(stickers.tgFileUniqueId, tgFileUniqueId),
        ),
      )
      .limit(1)
      .all();
    return rows[0] ? mapRow(rows[0]) : null;
  }

  getById(canonicalUserId: string, id: string): StickerRecord | null {
    const rows = this.db
      .select()
      .from(stickers)
      .where(and(eq(stickers.canonicalUserId, canonicalUserId), eq(stickers.id, id)))
      .limit(1)
      .all();
    return rows[0] ? mapRow(rows[0]) : null;
  }

  create(input: {
    canonicalUserId: string;
    source: StickerSource;
    setName?: string | null;
    emoji?: string | null;
    tgFileId?: string | null;
    tgFileUniqueId?: string | null;
    localPath: string;
    mimeType: string;
    sha256: string;
    isAnimated?: boolean;
    caption?: string;
    emotions?: string[];
    scenes?: string[];
    style?: string;
    status?: StickerStatus;
  }): StickerRecord {
    const now = Date.now();
    const id = `stk_${now.toString(36)}_${randomBytes(3).toString("hex")}`;
    this.db
      .insert(stickers)
      .values({
        id,
        canonicalUserId: input.canonicalUserId,
        source: input.source,
        setName: input.setName ?? null,
        emoji: input.emoji ?? null,
        tgFileId: input.tgFileId ?? null,
        tgFileUniqueId: input.tgFileUniqueId ?? null,
        localPath: input.localPath,
        mimeType: input.mimeType,
        sha256: input.sha256,
        isAnimated: input.isAnimated ? 1 : 0,
        caption: input.caption ?? "",
        emotionsJson: JSON.stringify(input.emotions ?? []),
        scenesJson: JSON.stringify(input.scenes ?? []),
        style: input.style ?? "",
        status: input.status ?? "pending",
        errorMessage: null,
        useCount: 0,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.getById(input.canonicalUserId, id)!;
  }

  updateMetadata(
    canonicalUserId: string,
    id: string,
    patch: {
      caption?: string;
      emotions?: string[];
      scenes?: string[];
      style?: string;
      status?: StickerStatus;
      errorMessage?: string | null;
      tgFileId?: string | null;
    },
  ): StickerRecord | null {
    const existing = this.getById(canonicalUserId, id);
    if (!existing) return null;
    const now = Date.now();
    this.db
      .update(stickers)
      .set({
        ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
        ...(patch.emotions !== undefined ? { emotionsJson: JSON.stringify(patch.emotions) } : {}),
        ...(patch.scenes !== undefined ? { scenesJson: JSON.stringify(patch.scenes) } : {}),
        ...(patch.style !== undefined ? { style: patch.style } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
        ...(patch.tgFileId !== undefined ? { tgFileId: patch.tgFileId } : {}),
        updatedAt: now,
      })
      .where(and(eq(stickers.canonicalUserId, canonicalUserId), eq(stickers.id, id)))
      .run();
    return this.getById(canonicalUserId, id);
  }

  recordUsed(canonicalUserId: string, id: string): void {
    const existing = this.getById(canonicalUserId, id);
    if (!existing) return;
    const now = Date.now();
    this.db
      .update(stickers)
      .set({
        useCount: existing.useCount + 1,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(and(eq(stickers.canonicalUserId, canonicalUserId), eq(stickers.id, id)))
      .run();
  }

  delete(canonicalUserId: string, id: string): boolean {
    const existing = this.getById(canonicalUserId, id);
    if (!existing) return false;
    this.db
      .delete(stickers)
      .where(and(eq(stickers.canonicalUserId, canonicalUserId), eq(stickers.id, id)))
      .run();
    return true;
  }

  list(canonicalUserId: string, opts?: { limit?: number; query?: string }): StickerRecord[] {
    const rows = this.db
      .select()
      .from(stickers)
      .where(eq(stickers.canonicalUserId, canonicalUserId))
      .orderBy(desc(stickers.createdAt))
      .all()
      .map(mapRow);

    const q = opts?.query?.trim().toLowerCase();
    const filtered = q
      ? rows.filter((item) => {
          const haystack = [
            item.id,
            item.caption,
            item.emotions.join(" "),
            item.scenes.join(" "),
            item.style,
            item.emoji ?? "",
            item.setName ?? "",
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(q);
        })
      : rows;

    const limit = opts?.limit && opts.limit > 0 ? opts.limit : filtered.length;
    return filtered.slice(0, limit);
  }

  search(
    canonicalUserId: string,
    query: string,
    opts?: { emotion?: string; limit?: number },
  ): StickerRecord[] {
    const readyRows = this.db
      .select()
      .from(stickers)
      .where(and(eq(stickers.canonicalUserId, canonicalUserId), eq(stickers.status, "ready")))
      .all()
      .map(mapRow);

    if (readyRows.length === 0) return [];

    const tokens = [query, opts?.emotion ?? ""]
      .join(" ")
      .toLowerCase()
      .split(/[\s,，、/|]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const now = Date.now();
    const scored = readyRows.map((item) => {
      let score = 0;
      const emotionsText = item.emotions.join(" ").toLowerCase();
      const scenesText = item.scenes.join(" ").toLowerCase();
      const captionText = item.caption.toLowerCase();
      const metaText = `${item.style} ${item.emoji ?? ""} ${item.setName ?? ""}`.toLowerCase();

      for (const tok of tokens) {
        if (emotionsText.includes(tok)) score += 6;
        if (scenesText.includes(tok)) score += 5;
        if (captionText.includes(tok)) score += 3;
        if (metaText.includes(tok)) score += 2;
      }

      if (opts?.emotion?.trim() && emotionsText.includes(opts.emotion.trim().toLowerCase())) {
        score += 4;
      }

      // Mild cooldown penalty if sent within the last 10 minutes so replies feel varied.
      if (item.lastUsedAt && now - item.lastUsedAt < 10 * 60_000) {
        score -= 2;
      }

      return { item, score };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.item.createdAt - a.item.createdAt;
    });

    const limit = Math.max(1, Math.min(20, opts?.limit ?? 5));
    const matches = scored.filter((s) => s.score > 0).map((s) => s.item);
    if (matches.length > 0) return matches.slice(0, limit);
    return readyRows.slice(0, limit);
  }
}
