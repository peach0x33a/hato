import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { HatoConfig } from "../config/app.js";
import type { MemoryStore } from "../memory/store.js";
import { isSensitiveEnvFilePath } from "../persona/tools.js";
import { logWarn, summarizeError } from "../utils/logger.js";
import {
  generateNotebookEntryId,
  NotebookStore,
  type NotebookEntryKind,
  type NotebookEntryRecord,
  type NotebookIndexStatus,
} from "./store.js";

const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DATA_URL_IMAGE_BYTES = 12 * 1024 * 1024;
const SUPPORTED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const NOTEBOOK_ID_RE = /\b(nb_[a-z0-9]+_[0-9a-f]{6})\b/gi;

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function extFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

/**
 * Format a compact, deterministic index card for storing into the `notebook` memory bank.
 */
export function formatNotebookIndexText(entry: NotebookEntryRecord): string {
  const parts: string[] = [`[${entry.id}] (${entry.kind})`];
  if (entry.title.trim()) {
    parts.push(`标题：${entry.title.trim()}`);
  }
  parts.push(`概要：${entry.summary.trim()}`);
  parts.push(`存入原因：${entry.reason.trim()}`);
  if (entry.tags.length > 0) {
    parts.push(`标签：${entry.tags.join(", ")}`);
  }
  const normalizedContent = entry.content.replace(/\s+/g, " ").trim();
  if (normalizedContent && normalizedContent !== entry.summary.trim()) {
    const snippet =
      normalizedContent.length > 160 ? `${normalizedContent.slice(0, 160)}…` : normalizedContent;
    parts.push(`内容摘录：${snippet}`);
  }
  return parts.join(" | ");
}

/**
 * Extract `nb_...` entry IDs embedded in recalled semantic memory text.
 */
export function extractNotebookIdsFromText(text: string): string[] {
  const matches = text.match(NOTEBOOK_ID_RE);
  if (!matches) return [];
  return Array.from(new Set(matches.map((m) => m.toLowerCase())));
}

export interface NotebookSearchResult {
  entries: NotebookEntryRecord[];
  usedSemanticIndex: boolean;
  degraded: boolean;
  errorMessage?: string;
}

export interface NotebookReindexResult {
  ok: boolean;
  total: number;
  synced: number;
  failed: number;
  errorMessage?: string;
}

/**
 * Service coordinating Hato's notebook persistence, managed image copies,
 * and semantic indexing in the `notebook` memory bank.
 */
export class NotebookService {
  private readonly store: NotebookStore;

  constructor(
    private readonly deps: {
      store: NotebookStore;
      getHatoConfig: () => HatoConfig;
      getMemoryStore: () => MemoryStore | null;
    },
  ) {
    this.store = deps.store;
  }

  getStore(): NotebookStore {
    return this.store;
  }

  isMemoryIndexConfigured(): boolean {
    return Boolean(this.deps.getMemoryStore()?.isConfigured());
  }

  private resolveNotebookDir(): string {
    const dataDir = resolve(this.deps.getHatoConfig().paths.sqlite, "..");
    const dir = join(dataDir, "notebook");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private safeRemoveManagedImage(imagePath: string | null | undefined): void {
    if (!imagePath) return;
    try {
      const notebookDir = resolve(this.resolveNotebookDir());
      const resolved = resolve(imagePath);
      if (resolved === notebookDir || !resolved.startsWith(`${notebookDir}${sep}`)) {
        return;
      }
      if (existsSync(resolved)) {
        rmSync(resolved, { force: true });
      }
    } catch {
      // ignore cleanup failures
    }
  }

  private persistImageFromPath(
    sourcePath: string,
    entryId: string,
  ): { localPath: string; mimeType: string; sha256: string } {
    const resolved = resolve(sourcePath.trim());
    if (isSensitiveEnvFilePath(resolved)) {
      throw new Error("禁止读取敏感配置文件作为小本本图片");
    }
    if (!existsSync(resolved)) {
      throw new Error(`图片文件不存在: ${resolved}`);
    }
    let realTarget = resolved;
    try {
      realTarget = realpathSync(resolved);
    } catch {
      realTarget = resolved;
    }
    if (isSensitiveEnvFilePath(realTarget)) {
      throw new Error("禁止读取敏感配置文件作为小本本图片");
    }
    const stat = statSync(realTarget);
    if (!stat.isFile()) {
      throw new Error(`目标路径不是常规文件: ${resolved}`);
    }
    if (stat.size <= 0) {
      throw new Error(`图片文件为空: ${resolved}`);
    }
    if (stat.size > MAX_LOCAL_IMAGE_BYTES) {
      throw new Error(`图片文件过大 (${stat.size} bytes)，超出 ${MAX_LOCAL_IMAGE_BYTES} bytes 上限`);
    }
    const ext = extname(realTarget).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
      throw new Error(`不支持的图片格式 "${ext || "(无扩展名)"}"，仅支持 png/jpg/jpeg/webp/gif`);
    }

    const buffer = readFileSync(realTarget);
    return this.writeManagedImageBuffer(buffer, ext, mimeFromExt(ext), entryId);
  }

  private persistImageFromDataUrl(
    dataUrl: string,
    entryId: string,
  ): { localPath: string; mimeType: string; sha256: string } {
    const match = dataUrl.trim().match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
      throw new Error("图片数据格式无效，仅支持 png/jpeg/webp/gif 的 base64 Data URL");
    }
    const rawMime = match[1]!.toLowerCase();
    const mimeType = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
    const base64Body = match[2]!.replace(/\s+/g, "");
    const buffer = Buffer.from(base64Body, "base64");
    if (buffer.length <= 0) {
      throw new Error("图片内容为空");
    }
    if (buffer.length > MAX_DATA_URL_IMAGE_BYTES) {
      throw new Error(`图片大小超出限制 (${buffer.length} bytes > ${MAX_DATA_URL_IMAGE_BYTES} bytes)`);
    }
    return this.writeManagedImageBuffer(buffer, extFromMime(mimeType), mimeType, entryId);
  }

  private writeManagedImageBuffer(
    buffer: Buffer,
    ext: string,
    mimeType: string,
    entryId: string,
  ): { localPath: string; mimeType: string; sha256: string } {
    const dir = this.resolveNotebookDir();
    const nonce = randomBytes(3).toString("hex");
    const targetPath = join(dir, `${entryId}_${nonce}${ext}`);
    writeFileSync(targetPath, buffer);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    return { localPath: targetPath, mimeType, sha256 };
  }

  private async syncEntryIndex(
    canonicalUserId: string,
    entry: NotebookEntryRecord,
  ): Promise<NotebookEntryRecord> {
    const memoryStore = this.deps.getMemoryStore();
    if (!memoryStore || !memoryStore.isConfigured()) {
      return (
        this.store.updateIndexState(canonicalUserId, entry.id, {
          memoryProvider: null,
          memoryVaultId: null,
          externalMemoryId: null,
          indexStatus: "local_only",
          indexError: null,
        }) ?? entry
      );
    }

    try {
      const res = await memoryStore.retain(canonicalUserId, {
        bank: "notebook",
        role: "assistant",
        content: formatNotebookIndexText(entry),
      });
      const indexStatus: NotebookIndexStatus = res.status;
      return (
        this.store.updateIndexState(canonicalUserId, entry.id, {
          memoryProvider: memoryStore.providerName,
          memoryVaultId: res.vaultId ?? entry.memoryVaultId,
          externalMemoryId: res.externalMemoryId ?? entry.externalMemoryId,
          indexStatus,
          indexError: res.ok ? null : res.errorMessage ?? res.errorCode ?? "索引写入失败",
        }) ?? entry
      );
    } catch (err) {
      const msg = summarizeError(err);
      logWarn("NOTEBOOK", `index retain failed for ${entry.id}: ${msg}`);
      return (
        this.store.updateIndexState(canonicalUserId, entry.id, {
          memoryProvider: memoryStore.providerName,
          indexStatus: "error",
          indexError: msg,
        }) ?? entry
      );
    }
  }

  private async eraseRemoteIndexBestEffort(
    canonicalUserId: string,
    externalMemoryId: string | null,
  ): Promise<void> {
    if (!externalMemoryId) return;
    const memoryStore = this.deps.getMemoryStore();
    if (!memoryStore || !memoryStore.isConfigured()) return;
    try {
      await memoryStore.erase(canonicalUserId, {
        bank: "notebook",
        memoryIds: [externalMemoryId],
      });
    } catch (err) {
      logWarn("NOTEBOOK", `erase remote index (${externalMemoryId}) failed: ${summarizeError(err)}`);
    }
  }

  async saveEntry(
    canonicalUserId: string,
    input: {
      title?: string;
      summary: string;
      reason: string;
      tags?: readonly string[];
      content?: string;
      imagePath?: string;
      imageDataUrl?: string;
    },
  ): Promise<NotebookEntryRecord> {
    const summary = input.summary.trim();
    const reason = input.reason.trim();
    const content = (input.content ?? "").trimEnd();
    const hasText = content.trim().length > 0;
    const hasImagePath = Boolean(input.imagePath?.trim());
    const hasImageDataUrl = Boolean(input.imageDataUrl?.trim());

    if (!summary) {
      throw new Error("概要 (summary) 不能为空");
    }
    if (!reason) {
      throw new Error("存入原因 (reason) 不能为空");
    }
    if (!hasText && !hasImagePath && !hasImageDataUrl) {
      throw new Error("纯文本内容和图片不能同时为空");
    }

    const entryId = generateNotebookEntryId();
    let persistedImage: { localPath: string; mimeType: string; sha256: string } | null = null;
    if (hasImageDataUrl) {
      persistedImage = this.persistImageFromDataUrl(input.imageDataUrl!, entryId);
    } else if (hasImagePath) {
      persistedImage = this.persistImageFromPath(input.imagePath!, entryId);
    }

    let created: NotebookEntryRecord;
    try {
      created = this.store.create({
        id: entryId,
        canonicalUserId,
        title: input.title,
        summary,
        reason,
        tags: input.tags,
        content,
        imagePath: persistedImage?.localPath ?? null,
        imageMimeType: persistedImage?.mimeType ?? null,
        imageSha256: persistedImage?.sha256 ?? null,
      });
    } catch (err) {
      this.safeRemoveManagedImage(persistedImage?.localPath);
      throw err;
    }

    return this.syncEntryIndex(canonicalUserId, created);
  }

  async updateEntry(
    canonicalUserId: string,
    id: string,
    patch: {
      title?: string;
      summary?: string;
      reason?: string;
      tags?: readonly string[];
      content?: string;
      imagePath?: string;
      imageDataUrl?: string;
      removeImage?: boolean;
    },
  ): Promise<NotebookEntryRecord | null> {
    const existing = this.store.getById(canonicalUserId, id);
    if (!existing) return null;

    const nextSummary = patch.summary !== undefined ? patch.summary.trim() : existing.summary;
    const nextReason = patch.reason !== undefined ? patch.reason.trim() : existing.reason;
    const nextContent = patch.content !== undefined ? patch.content.trimEnd() : existing.content;
    if (!nextSummary) {
      throw new Error("概要 (summary) 不能为空");
    }
    if (!nextReason) {
      throw new Error("存入原因 (reason) 不能为空");
    }

    const hasNewImageDataUrl = Boolean(patch.imageDataUrl?.trim());
    const hasNewImagePath = Boolean(patch.imagePath?.trim());
    let nextImage: { localPath: string | null; mimeType: string | null; sha256: string | null } = {
      localPath: existing.imagePath,
      mimeType: existing.imageMimeType,
      sha256: existing.imageSha256,
    };

    if (hasNewImageDataUrl) {
      const saved = this.persistImageFromDataUrl(patch.imageDataUrl!, id);
      nextImage = { localPath: saved.localPath, mimeType: saved.mimeType, sha256: saved.sha256 };
    } else if (hasNewImagePath) {
      const saved = this.persistImageFromPath(patch.imagePath!, id);
      nextImage = { localPath: saved.localPath, mimeType: saved.mimeType, sha256: saved.sha256 };
    } else if (patch.removeImage) {
      nextImage = { localPath: null, mimeType: null, sha256: null };
    }

    if (!nextContent.trim() && !nextImage.localPath) {
      if (hasNewImageDataUrl || hasNewImagePath) {
        this.safeRemoveManagedImage(nextImage.localPath);
      }
      throw new Error("更新后纯文本内容和图片不能同时为空");
    }

    const updated = this.store.update(canonicalUserId, id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: nextSummary } : {}),
      ...(patch.reason !== undefined ? { reason: nextReason } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.content !== undefined ? { content: nextContent } : {}),
      imagePath: nextImage.localPath,
      imageMimeType: nextImage.mimeType,
      imageSha256: nextImage.sha256,
    });

    if (!updated) {
      if (hasNewImageDataUrl || hasNewImagePath) {
        this.safeRemoveManagedImage(nextImage.localPath);
      }
      return null;
    }

    if ((hasNewImageDataUrl || hasNewImagePath || patch.removeImage) && existing.imagePath !== nextImage.localPath) {
      this.safeRemoveManagedImage(existing.imagePath);
    }

    const indexFieldsChanged =
      patch.title !== undefined ||
      patch.summary !== undefined ||
      patch.reason !== undefined ||
      patch.tags !== undefined ||
      patch.content !== undefined ||
      hasNewImageDataUrl ||
      hasNewImagePath ||
      Boolean(patch.removeImage);

    if (indexFieldsChanged && this.isMemoryIndexConfigured()) {
      await this.eraseRemoteIndexBestEffort(canonicalUserId, existing.externalMemoryId);
      const cleared =
        this.store.updateIndexState(canonicalUserId, id, {
          externalMemoryId: null,
          indexStatus: "local_only",
          indexError: null,
        }) ?? updated;
      return this.syncEntryIndex(canonicalUserId, cleared);
    }

    return updated;
  }

  async deleteEntry(canonicalUserId: string, id: string): Promise<boolean> {
    const existing = this.store.getById(canonicalUserId, id);
    if (!existing) return false;
    await this.eraseRemoteIndexBestEffort(canonicalUserId, existing.externalMemoryId);
    const deleted = this.store.delete(canonicalUserId, id);
    if (!deleted) return false;
    this.safeRemoveManagedImage(deleted.imagePath);
    return true;
  }

  readEntry(canonicalUserId: string, id: string): NotebookEntryRecord | null {
    const found = this.store.getById(canonicalUserId, id);
    if (!found) return null;
    this.store.recordAccessed(canonicalUserId, id);
    return this.store.getById(canonicalUserId, id) ?? found;
  }

  async searchEntries(
    canonicalUserId: string,
    params: { query?: string; kind?: NotebookEntryKind | "all"; limit?: number },
  ): Promise<NotebookSearchResult> {
    const limit = Math.max(1, Math.min(100, Math.round(params.limit ?? 20)));
    const kind = params.kind ?? "all";
    const query = params.query?.trim() ?? "";

    if (!query) {
      return {
        entries: this.store.list(canonicalUserId, { kind, limit }),
        usedSemanticIndex: false,
        degraded: false,
      };
    }

    const localHits = this.store.searchLocal(canonicalUserId, query, { kind, limit });
    const memoryStore = this.deps.getMemoryStore();
    if (!memoryStore || !memoryStore.isConfigured()) {
      return {
        entries: localHits,
        usedSemanticIndex: false,
        degraded: false,
      };
    }

    try {
      const recallRes = await memoryStore.recall(canonicalUserId, {
        bank: "notebook",
        query,
        limit,
      });

      const semanticEntries: NotebookEntryRecord[] = [];
      const seenIds = new Set<string>();

      for (const item of recallRes.items) {
        const matched: NotebookEntryRecord[] = [];
        const byExt = this.store.findByExternalMemoryId(canonicalUserId, item.id);
        if (byExt) {
          matched.push(byExt);
        } else {
          for (const nbId of extractNotebookIdsFromText(item.content)) {
            const byNbId = this.store.getById(canonicalUserId, nbId);
            if (byNbId) matched.push(byNbId);
          }
        }
        for (const entry of matched) {
          if (seenIds.has(entry.id)) continue;
          if (kind !== "all" && entry.kind !== kind) continue;
          seenIds.add(entry.id);
          semanticEntries.push(entry);
        }
      }

      const merged = [...semanticEntries];
      for (const local of localHits) {
        if (seenIds.has(local.id)) continue;
        seenIds.add(local.id);
        merged.push(local);
      }

      return {
        entries: merged.slice(0, limit),
        usedSemanticIndex: recallRes.ok || semanticEntries.length > 0,
        degraded: recallRes.degraded,
        ...(recallRes.errorMessage ? { errorMessage: recallRes.errorMessage } : {}),
      };
    } catch (err) {
      const msg = summarizeError(err);
      logWarn("NOTEBOOK", `semantic search failed, falling back to local: ${msg}`);
      return {
        entries: localHits,
        usedSemanticIndex: false,
        degraded: true,
        errorMessage: msg,
      };
    }
  }

  async reindexAll(
    canonicalUserId: string,
    opts?: { force?: boolean },
  ): Promise<NotebookReindexResult> {
    if (!this.isMemoryIndexConfigured()) {
      return {
        ok: false,
        total: 0,
        synced: 0,
        failed: 0,
        errorMessage: "长期记忆服务当前未启用或未配置密钥",
      };
    }

    const all = this.store.list(canonicalUserId, { limit: 10_000 });
    const targets = opts?.force ? all : all.filter((e) => e.indexStatus !== "synced");
    let synced = 0;
    let failed = 0;

    for (const entry of targets) {
      if (opts?.force && entry.externalMemoryId) {
        await this.eraseRemoteIndexBestEffort(canonicalUserId, entry.externalMemoryId);
        this.store.updateIndexState(canonicalUserId, entry.id, {
          externalMemoryId: null,
          indexStatus: "local_only",
          indexError: null,
        });
      }
      const updated = await this.syncEntryIndex(canonicalUserId, entry);
      if (updated.indexStatus === "synced") synced += 1;
      else failed += 1;
    }

    return {
      ok: failed === 0,
      total: targets.length,
      synced,
      failed,
    };
  }
}
