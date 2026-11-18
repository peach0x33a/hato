import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  convertBufferToModelImage,
  detectMediaMimeType,
  formatTelegramStickerSummary,
  selectTelegramStickerDownloadCandidates,
} from "../src/gateway/media.js";

test("selectTelegramStickerDownloadCandidates and formatTelegramStickerSummary handle static, video, and animated stickers", () => {
  const staticSticker = {
    file_id: "static_1",
    is_animated: false,
    is_video: false,
    emoji: "🐱",
    set_name: "CatPack",
    thumbnail: { file_id: "thumb_1" },
  };
  assert.equal(formatTelegramStickerSummary(staticSticker), "贴纸 🐱 (贴纸包: CatPack)");
  assert.deepEqual(selectTelegramStickerDownloadCandidates(staticSticker), [
    { fileId: "static_1", fallbackExt: ".webp", sourceKind: "sticker_webp" },
    { fileId: "thumb_1", fallbackExt: ".webp", sourceKind: "sticker_thumb" },
  ]);

  const videoSticker = {
    file_id: "video_1",
    is_animated: false,
    is_video: true,
    emoji: "✨",
    thumbnail: { file_id: "video_thumb" },
  };
  assert.equal(formatTelegramStickerSummary(videoSticker), "视频贴纸 ✨");
  assert.deepEqual(selectTelegramStickerDownloadCandidates(videoSticker), [
    { fileId: "video_thumb", fallbackExt: ".webp", sourceKind: "sticker_thumb" },
    { fileId: "video_1", fallbackExt: ".webm", sourceKind: "sticker_video" },
  ]);

  const animatedSticker = {
    file_id: "tgs_1",
    is_animated: true,
    is_video: false,
    thumbnail: { file_id: "tgs_thumb" },
  };
  assert.equal(formatTelegramStickerSummary(animatedSticker), "动态贴纸");
  assert.deepEqual(selectTelegramStickerDownloadCandidates(animatedSticker), [
    { fileId: "tgs_thumb", fallbackExt: ".webp", sourceKind: "sticker_thumb" },
  ]);

  assert.deepEqual(
    selectTelegramStickerDownloadCandidates({ file_id: "tgs_no_thumb", is_animated: true }),
    [],
  );
});

test("detectMediaMimeType and convertBufferToModelImage normalize JPEG, WebP, and ignore TGS", async () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(detectMediaMimeType(jpegBytes), "image/jpeg");
  const jpegResult = await convertBufferToModelImage({ buffer: jpegBytes, filePath: "photos/file_1.jpg" });
  assert.equal(jpegResult?.mimeType, "image/jpeg");
  assert.equal(jpegResult?.data, jpegBytes.toString("base64"));

  const tgsBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
  assert.equal(detectMediaMimeType(tgsBytes), "application/x-tgsticker");
  assert.equal(await convertBufferToModelImage({ buffer: tgsBytes, filePath: "stickers/a.tgs" }), null);

  const hasFfmpeg = (() => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  // Standard 1x1 lossless WebP (RIFF....WEBPVP8L) to verify real ffmpeg WebP -> PNG decoding.
  const webpBytes = Buffer.from(
    "UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",
    "base64",
  );
  assert.equal(detectMediaMimeType(webpBytes), "image/webp");

  const convertedWebp = await convertBufferToModelImage({
    buffer: webpBytes,
    filePath: "stickers/s1.webp",
  });
  assert.ok(convertedWebp);
  if (hasFfmpeg) {
    assert.equal(convertedWebp.mimeType, "image/png");
    assert.equal(detectMediaMimeType(Buffer.from(convertedWebp.data, "base64")), "image/png");
  } else {
    assert.equal(convertedWebp.mimeType, "image/webp");
  }

  if (!hasFfmpeg) return;

  // Also test real GIF frame extraction via ffmpeg -> PNG.
  const dir = mkdtempSync(join(tmpdir(), "hato-gif-test-"));
  try {
    const gifPath = join(dir, "sample.gif");
    execFileSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=pink:s=64x64:d=0.1",
      gifPath,
    ]);
    const gifBytes = readFileSync(gifPath);
    assert.equal(detectMediaMimeType(gifBytes), "image/gif");

    const convertedGif = await convertBufferToModelImage({ buffer: gifBytes, filePath: "stickers/s2.gif" });
    assert.ok(convertedGif);
    assert.equal(convertedGif.mimeType, "image/png");
    assert.equal(detectMediaMimeType(Buffer.from(convertedGif.data, "base64")), "image/png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
