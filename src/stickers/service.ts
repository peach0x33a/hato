import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { type AssistantMessage, type TextContent } from "@earendil-works/pi-ai";
import type { HatoConfig } from "../config/app.js";
import type { ModelRegistry } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { completeSimpleWithRetry } from "../utils/llm-retry.js";
import {
  convertBufferToModelImage,
  selectTelegramStickerDownloadCandidates,
} from "../gateway/media.js";
import type { TelegramAdapter } from "../gateway/tg.js";
import { logInfo, logWarn, summarizeError } from "../utils/logger.js";
import { StickerStore, type StickerRecord, type StickerSource } from "./store.js";

export interface VisionTaggingResult {
  caption: string;
  emotions: string[];
  scenes: string[];
  style: string;
}

const VISION_TAGGER_SYSTEM_PROMPT = `You are a sticker/meme semantic tagging assistant. Inspect the sticker image together with any provided note, emoji, or pack name, and extract structured Simplified Chinese metadata for chat retrieval.
Output ONLY a single valid JSON object with no Markdown code fences and no extra commentary:
{
  "caption": "Accurate Chinese description of the subject, pose/expression, and any text in the image (max 60 Chinese chars)",
  "emotions": ["Chinese emotion tag 1", "Chinese emotion tag 2", "Chinese emotion tag 3"],
  "scenes": ["Chinese chat context 1", "Chinese chat context 2"],
  "style": "Chinese art style or character type (e.g., 二次元萌系 / 熊猫头沙雕 / 猫咪表情 / Q版贴纸)"
}`;

export function extractStickerSetName(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/addstickers\/([A-Za-z0-9_]+)/i);
  if (urlMatch?.[1]) return urlMatch[1];
  return trimmed.replace(/^@/, "");
}

function parseVisionJson(rawText: string): VisionTaggingResult | null {
  const trimmed = rawText.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
    const emotions = Array.isArray(parsed.emotions)
      ? parsed.emotions.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const scenes = Array.isArray(parsed.scenes)
      ? parsed.scenes.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const style = typeof parsed.style === "string" ? parsed.style.trim() : "";
    if (!caption && emotions.length === 0 && scenes.length === 0) return null;
    return {
      caption: caption || "表情包",
      emotions,
      scenes,
      style,
    };
  } catch {
    return null;
  }
}

function inferMimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    default:
      return "image/webp";
  }
}

export class StickerService {
  private readonly store: StickerStore;
  private readonly collectUsers = new Set<string>();
  private readonly tagQueue: Array<() => Promise<void>> = [];
  private activeWorkers = 0;
  private readonly concurrency = 3;

  constructor(
    private readonly deps: {
      store: StickerStore;
      getHatoConfig: () => HatoConfig;
      getModelRegistry: () => ModelRegistry;
      getProxyRouter: () => ScopedProxyRouter;
      getTelegramAdapter: () => TelegramAdapter | null;
    },
  ) {
    this.store = deps.store;
  }

  getStore(): StickerStore {
    return this.store;
  }

  setCollectMode(canonicalUserId: string, active: boolean): void {
    if (active) this.collectUsers.add(canonicalUserId);
    else this.collectUsers.delete(canonicalUserId);
  }

  isCollectMode(canonicalUserId: string): boolean {
    return this.collectUsers.has(canonicalUserId);
  }

  private resolveStickersDir(): string {
    const dataDir = resolve(this.deps.getHatoConfig().paths.sqlite, "..");
    const dir = join(dataDir, "stickers");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async saveFromLocalFile(input: {
    canonicalUserId: string;
    localPath: string;
    source: StickerSource;
    setName?: string;
    emoji?: string;
    tgFileId?: string;
    tgFileUniqueId?: string;
    isAnimated?: boolean;
    note?: string;
    awaitTag?: boolean;
  }): Promise<{ record: StickerRecord; deduplicated: boolean }> {
    const srcAbs = resolve(input.localPath);
    if (!existsSync(srcAbs)) {
      throw new Error(`表情包文件不存在: ${srcAbs}`);
    }
    const buf = readFileSync(srcAbs);
    const sha256 = createHash("sha256").update(buf).digest("hex");

    if (input.tgFileUniqueId) {
      const existingByTg = this.store.findByTgUniqueId(input.canonicalUserId, input.tgFileUniqueId);
      if (existingByTg) {
        if (input.tgFileId && existingByTg.tgFileId !== input.tgFileId) {
          this.store.updateMetadata(input.canonicalUserId, existingByTg.id, {
            tgFileId: input.tgFileId,
          });
        }
        return { record: existingByTg, deduplicated: true };
      }
    }

    const existingByHash = this.store.findBySha256(input.canonicalUserId, sha256);
    if (existingByHash) {
      if (input.tgFileId && !existingByHash.tgFileId) {
        this.store.updateMetadata(input.canonicalUserId, existingByHash.id, {
          tgFileId: input.tgFileId,
        });
      }
      return { record: existingByHash, deduplicated: true };
    }

    const stickersDir = this.resolveStickersDir();
    const ext = extname(srcAbs).toLowerCase() || ".webp";
    const destName = `${sha256.slice(0, 16)}${ext}`;
    const destPath = join(stickersDir, destName);
    if (!existsSync(destPath)) {
      copyFileSync(srcAbs, destPath);
    }

    const record = this.store.create({
      canonicalUserId: input.canonicalUserId,
      source: input.source,
      setName: input.setName ?? null,
      emoji: input.emoji ?? null,
      tgFileId: input.tgFileId ?? null,
      tgFileUniqueId: input.tgFileUniqueId ?? null,
      localPath: destPath,
      mimeType: inferMimeFromExt(ext),
      sha256,
      isAnimated: input.isAnimated ?? false,
      status: "pending",
    });

    const runTag = async () => {
      await this.tagAndSaveRecord(record, input.note);
    };

    if (input.awaitTag) {
      await runTag();
      return {
        record: this.store.getById(input.canonicalUserId, record.id) ?? record,
        deduplicated: false,
      };
    }

    this.enqueueTagJob(runTag);
    return { record, deduplicated: false };
  }

  async importTelegramPack(params: {
    canonicalUserId: string;
    setNameOrUrl: string;
    onComplete?: (summary: {
      setName: string;
      title: string;
      total: number;
      imported: number;
      skipped: number;
      failed: number;
    }) => void;
  }): Promise<{
    setName: string;
    title: string;
    total: number;
    queued: number;
    skipped: number;
  }> {
    const tg = this.deps.getTelegramAdapter();
    if (!tg) {
      throw new Error("Telegram 网关未启动，无法拉取 Sticker Pack");
    }
    const setName = extractStickerSetName(params.setNameOrUrl);
    if (!setName) {
      throw new Error("无效的 Sticker Pack 名称或链接");
    }

    const setInfo = await tg.getStickerSet(setName);
    const stickersDir = join(this.resolveStickersDir(), "packs", setName);
    mkdirSync(stickersDir, { recursive: true });

    let skipped = 0;
    const toProcess: typeof setInfo.stickers = [];
    for (const s of setInfo.stickers) {
      if (this.store.findByTgUniqueId(params.canonicalUserId, s.file_unique_id)) {
        skipped++;
        continue;
      }
      toProcess.push(s);
    }

    const queued = toProcess.length;
    logInfo("STICKER", `importing TG pack "${setName}" (${setInfo.title}): total=${setInfo.stickers.length}, queued=${queued}, skipped=${skipped}`);

    // Run downloads + vision tagging asynchronously in background so chat does not block.
    void (async () => {
      let imported = 0;
      let failed = 0;
      const pendingTasks: Array<Promise<void>> = [];

      for (const s of toProcess) {
        const task = new Promise<void>((resolveTask) => {
          this.enqueueTagJob(async () => {
            try {
              const candidates = selectTelegramStickerDownloadCandidates(s);
              let savedBuf: Buffer | null = null;
              let ext = ".webp";
              for (const cand of candidates) {
                const downloaded = await tg.downloadFileById(cand.fileId);
                if (downloaded?.buffer?.length) {
                  savedBuf = downloaded.buffer;
                  ext = extname(downloaded.filePath || cand.fallbackExt).toLowerCase() || ".webp";
                  break;
                }
              }
              if (!savedBuf) {
                failed++;
                resolveTask();
                return;
              }
              const sha256 = createHash("sha256").update(savedBuf).digest("hex");
              const localFile = join(stickersDir, `${s.file_unique_id}${ext}`);
              if (!existsSync(localFile)) {
                const { writeFileSync } = await import("node:fs");
                writeFileSync(localFile, savedBuf);
              }
              const existingHash = this.store.findBySha256(params.canonicalUserId, sha256);
              if (existingHash) {
                skipped++;
                resolveTask();
                return;
              }

              const rec = this.store.create({
                canonicalUserId: params.canonicalUserId,
                source: "tg_pack",
                setName,
                emoji: s.emoji ?? null,
                tgFileId: s.file_id,
                tgFileUniqueId: s.file_unique_id,
                localPath: localFile,
                mimeType: inferMimeFromExt(ext),
                sha256,
                isAnimated: Boolean(s.is_animated || s.is_video),
                status: "pending",
              });

              await this.tagAndSaveRecord(rec, `贴纸包名称: ${setInfo.title}`);
              imported++;
            } catch (err) {
              failed++;
              logWarn("STICKER", `failed pack item ${s.file_unique_id}: ${summarizeError(err)}`);
            } finally {
              resolveTask();
            }
          });
        });
        pendingTasks.push(task);
      }

      await Promise.all(pendingTasks);
      logInfo("STICKER", `finished TG pack "${setName}": imported=${imported}, skipped=${skipped}, failed=${failed}`);
      params.onComplete?.({
        setName,
        title: setInfo.title,
        total: setInfo.stickers.length,
        imported,
        skipped,
        failed,
      });
    })();

    return {
      setName,
      title: setInfo.title,
      total: setInfo.stickers.length,
      queued,
      skipped,
    };
  }

  deleteSticker(canonicalUserId: string, id: string): boolean {
    const rec = this.store.getById(canonicalUserId, id);
    if (!rec) return false;
    const deleted = this.store.delete(canonicalUserId, id);
    if (deleted && rec.localPath && existsSync(rec.localPath)) {
      try {
        rmSync(rec.localPath, { force: true });
      } catch {
        // ignore cleanup error
      }
    }
    return deleted;
  }

  private enqueueTagJob(job: () => Promise<void>): void {
    this.tagQueue.push(job);
    this.pumpQueue();
  }

  private pumpQueue(): void {
    while (this.activeWorkers < this.concurrency && this.tagQueue.length > 0) {
      const next = this.tagQueue.shift()!;
      this.activeWorkers++;
      void next().finally(() => {
        this.activeWorkers--;
        this.pumpQueue();
      });
    }
  }

  private async tagAndSaveRecord(record: StickerRecord, note?: string): Promise<void> {
    try {
      const tagged = await this.describeImageWithVision(record.localPath, {
        emoji: record.emoji,
        setName: record.setName,
        note,
      });
      this.store.updateMetadata(record.canonicalUserId, record.id, {
        caption: tagged.caption,
        emotions: tagged.emotions,
        scenes: tagged.scenes,
        style: tagged.style,
        status: "ready",
        errorMessage: null,
      });
    } catch (err) {
      const msg = summarizeError(err);
      logWarn("STICKER", `vision tagging failed for ${record.id}: ${msg}`);
      // Fallback to metadata-only caption if vision failed so it remains searchable if emoji/note exists.
      const fallbackCaption = [note, record.emoji, record.setName].filter(Boolean).join(" ").trim();
      this.store.updateMetadata(record.canonicalUserId, record.id, {
        caption: fallbackCaption || basename(record.localPath),
        emotions: record.emoji ? [record.emoji] : [],
        scenes: [],
        style: "",
        status: fallbackCaption ? "ready" : "failed",
        errorMessage: msg,
      });
    }
  }

  private async describeImageWithVision(
    localPath: string,
    hints: { emoji?: string | null; setName?: string | null; note?: string },
  ): Promise<VisionTaggingResult> {
    const registry = this.deps.getModelRegistry();
    const resolved = registry.resolveSlot("vision");
    const apiKey = registry.resolveApiKeyForProvider(resolved.providerSlug);
    const buf = readFileSync(localPath);
    const imgContent = await convertBufferToModelImage({
      buffer: buf,
      filePath: localPath,
    });
    if (!imgContent) {
      throw new Error(`无法将图片转换为模型可读格式: ${localPath}`);
    }

    const hintLines = [
      hints.emoji ? `原生 emoji: ${hints.emoji}` : "",
      hints.setName ? `贴纸包: ${hints.setName}` : "",
      hints.note ? `补充说明: ${hints.note}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const proxyRouter = this.deps.getProxyRouter();
    const message: AssistantMessage = await proxyRouter.runWithScope(
      `llm-calling.${resolved.providerSlug}`,
      () =>
        completeSimpleWithRetry(
          () =>
            registry.models.completeSimple(
              resolved.model,
              {
                systemPrompt: VISION_TAGGER_SYSTEM_PROMPT,
                messages: [
                  {
                    role: "user",
                    timestamp: Date.now(),
                    content: [
                      {
                        type: "text",
                        text: hintLines
                          ? `请标注这张表情包：\n${hintLines}`
                          : "请标注这张表情包。",
                      },
                      imgContent,
                    ],
                  },
                ],
              },
              { apiKey },
            ),
          { slot: "STICKER" },
        ),
    );

    const text = message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    const parsed = parseVisionJson(text);
    if (!parsed) {
      throw new Error(`视觉模型返回格式无效: ${text.slice(0, 120)}`);
    }
    return parsed;
  }
}
