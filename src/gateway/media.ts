import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { ImageContent } from "@earendil-works/pi-ai";

const execFileAsync = promisify(execFile);

export interface TelegramStickerLike {
  file_id: string;
  is_animated?: boolean;
  is_video?: boolean;
  emoji?: string;
  set_name?: string;
  thumbnail?: {
    file_id: string;
  };
}

export interface StickerDownloadCandidate {
  fileId: string;
  fallbackExt: string;
  sourceKind: "sticker_webp" | "sticker_video" | "sticker_thumb";
}

/**
 * Formats a concise human-readable summary for a Telegram sticker so text logs
 * and future compaction history keep sticker context without storing base64 blobs.
 */
export function formatTelegramStickerSummary(sticker: TelegramStickerLike): string {
  const kindLabel = sticker.is_animated
    ? "动态贴纸"
    : sticker.is_video
      ? "视频贴纸"
      : "贴纸";
  const parts = [kindLabel];
  if (sticker.emoji) {
    parts.push(sticker.emoji);
  }
  if (sticker.set_name) {
    parts.push(`(贴纸包: ${sticker.set_name})`);
  }
  return parts.join(" ");
}

/**
 * Selects ordered download candidates for a Telegram sticker so static `.webp`,
 * `.webm` video stickers, and `.tgs` animated sticker thumbnails all resolve to renderable pixels.
 */
export function selectTelegramStickerDownloadCandidates(
  sticker: TelegramStickerLike,
): StickerDownloadCandidate[] {
  if (sticker.is_animated) {
    // `.tgs` files are gzipped Lottie vector JSON; use the raster thumbnail instead.
    return sticker.thumbnail?.file_id
      ? [{ fileId: sticker.thumbnail.file_id, fallbackExt: ".webp", sourceKind: "sticker_thumb" }]
      : [];
  }

  if (sticker.is_video) {
    const out: StickerDownloadCandidate[] = [];
    if (sticker.thumbnail?.file_id) {
      out.push({ fileId: sticker.thumbnail.file_id, fallbackExt: ".webp", sourceKind: "sticker_thumb" });
    }
    out.push({ fileId: sticker.file_id, fallbackExt: ".webm", sourceKind: "sticker_video" });
    return out;
  }

  const out: StickerDownloadCandidate[] = [
    { fileId: sticker.file_id, fallbackExt: ".webp", sourceKind: "sticker_webp" },
  ];
  if (sticker.thumbnail?.file_id) {
    out.push({ fileId: sticker.thumbnail.file_id, fallbackExt: ".webp", sourceKind: "sticker_thumb" });
  }
  return out;
}

/**
 * Infers an image/video mime type from buffer magic bytes first, then path extension.
 */
export function detectMediaMimeType(buffer: Buffer, filePath?: string): string | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "video/webm";
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return "application/x-tgsticker";
  }

  const ext = extname(filePath ?? "").toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".webm":
      return "video/webm";
    case ".tgs":
      return "application/x-tgsticker";
    default:
      return null;
  }
}

/**
 * Normalizes downloaded Telegram image/sticker/video-frame bytes into an `ImageContent`
 * block (`image/png` or `image/jpeg`) compatible with all multimodal LLM endpoints.
 */
export async function convertBufferToModelImage(params: {
  buffer: Buffer;
  filePath?: string;
}): Promise<ImageContent | null> {
  const { buffer, filePath } = params;
  if (buffer.length === 0) return null;

  const detectedMime = detectMediaMimeType(buffer, filePath);
  if (!detectedMime || detectedMime === "application/x-tgsticker") {
    return null;
  }

  if (detectedMime === "image/jpeg" || detectedMime === "image/png") {
    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType: detectedMime,
    };
  }

  const inputExt = mimeToExtension(detectedMime, filePath);
  const pngBuffer = await transcodeToPng(buffer, inputExt);
  if (pngBuffer) {
    return {
      type: "image",
      data: pngBuffer.toString("base64"),
      mimeType: "image/png",
    };
  }

  if (detectedMime === "image/webp" || detectedMime === "image/gif") {
    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType: detectedMime,
    };
  }
  return null;
}

function mimeToExtension(mimeType: string, filePath?: string): string {
  switch (mimeType) {
    case "image/webp":
      return ".webp";
    case "video/webm":
      return ".webm";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    default:
      return extname(filePath ?? "") || ".bin";
  }
}

async function transcodeToPng(buffer: Buffer, inputExt: string): Promise<Buffer | null> {
  const workDir = mkdtempSync(join(tmpdir(), "hato-media-"));
  const inputPath = join(workDir, `input${inputExt}`);
  const outputPath = join(workDir, "output.png");

  try {
    writeFileSync(inputPath, buffer);
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease",
        outputPath,
      ],
      { timeout: 8_000 },
    );
    const pngBytes = readFileSync(outputPath);
    return pngBytes.length > 0 ? pngBytes : null;
  } catch {
    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
