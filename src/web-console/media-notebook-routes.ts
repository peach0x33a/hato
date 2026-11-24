import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HatoConfig } from "../config/app.js";
import type { NotebookService } from "../notebook/service.js";
import type { NotebookEntryKind } from "../notebook/store.js";
import type { StickerService } from "../stickers/service.js";
import { summarizeError } from "../utils/logger.js";
import { readJsonBody, sendJson } from "./http-utils.js";

export interface MediaNotebookRoutesDeps {
  getConfig(): HatoConfig;
  getStickerService?(): StickerService | null;
  getNotebookService?(): NotebookService | null;
}

export async function tryHandleMediaNotebookRoute(
  deps: MediaNotebookRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  parsedUrl: URL,
): Promise<boolean> {
  if (pathname === "/api/stickers" && method === "GET") {
    const svc = deps.getStickerService?.();
    if (!svc) {
      sendJson(res, 200, { ok: true, stickers: [] });
      return true;
    }
    const uid = deps.getConfig().owner.canonical_user_id;
    const q = parsedUrl.searchParams.get("q") ?? undefined;
    const list = svc.getStore().list(uid, { query: q });
    sendJson(res, 200, { ok: true, stickers: list });
    return true;
  }

  const stickerImageMatch = pathname.match(/^\/api\/stickers\/([^/]+)\/image$/);
  if (stickerImageMatch && method === "GET") {
    const svc = deps.getStickerService?.();
    const uid = deps.getConfig().owner.canonical_user_id;
    const id = decodeURIComponent(stickerImageMatch[1]!);
    const rec = svc?.getStore().getById(uid, id);
    if (!rec || !existsSync(rec.localPath)) {
      sendJson(res, 404, { ok: false, error: "Sticker not found" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": rec.mimeType || "image/webp",
      "Cache-Control": "private, max-age=300",
    });
    res.end(readFileSync(rec.localPath));
    return true;
  }

  const stickerItemMatch = pathname.match(/^\/api\/stickers\/([^/]+)$/);
  if (stickerItemMatch && method === "PATCH") {
    const svc = deps.getStickerService?.();
    if (!svc) {
      sendJson(res, 503, { ok: false, error: "Sticker service unavailable" });
      return true;
    }
    const uid = deps.getConfig().owner.canonical_user_id;
    const id = decodeURIComponent(stickerItemMatch[1]!);
    const body = (await readJsonBody(req)) as {
      caption?: string;
      emotions?: string[];
      scenes?: string[];
      style?: string;
    };
    const updated = svc.getStore().updateMetadata(uid, id, {
      ...(typeof body.caption === "string" ? { caption: body.caption.trim() } : {}),
      ...(Array.isArray(body.emotions) ? { emotions: body.emotions.map((x) => String(x).trim()).filter(Boolean) } : {}),
      ...(Array.isArray(body.scenes) ? { scenes: body.scenes.map((x) => String(x).trim()).filter(Boolean) } : {}),
      ...(typeof body.style === "string" ? { style: body.style.trim() } : {}),
      status: "ready",
      errorMessage: null,
    });
    if (!updated) {
      sendJson(res, 404, { ok: false, error: "Sticker not found" });
      return true;
    }
    sendJson(res, 200, { ok: true, sticker: updated });
    return true;
  }

  if (stickerItemMatch && method === "DELETE") {
    const svc = deps.getStickerService?.();
    if (!svc) {
      sendJson(res, 503, { ok: false, error: "Sticker service unavailable" });
      return true;
    }
    const uid = deps.getConfig().owner.canonical_user_id;
    const id = decodeURIComponent(stickerItemMatch[1]!);
    const deleted = svc.deleteSticker(uid, id);
    if (!deleted) {
      sendJson(res, 404, { ok: false, error: "Sticker not found" });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/api/notebook" && method === "GET") {
    const svc = deps.getNotebookService?.();
    if (!svc) {
      sendJson(res, 200, {
        ok: true,
        entries: [],
        usedSemanticIndex: false,
        degraded: false,
        memoryConfigured: false,
        stats: { total: 0, textCount: 0, imageCount: 0, mixedCount: 0, syncedCount: 0 },
      });
      return true;
    }
    const uid = deps.getConfig().owner.canonical_user_id;
    const q = parsedUrl.searchParams.get("q") ?? undefined;
    const rawKind = parsedUrl.searchParams.get("kind") ?? "all";
    const kind: NotebookEntryKind | "all" =
      rawKind === "text" || rawKind === "image" || rawKind === "mixed" ? rawKind : "all";
    const result = await svc.searchEntries(uid, { query: q, kind, limit: 100 });
    const stats = svc.getStore().getStats(uid);
    sendJson(res, 200, {
      ok: true,
      entries: result.entries,
      usedSemanticIndex: result.usedSemanticIndex,
      degraded: result.degraded,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      memoryConfigured: svc.isMemoryIndexConfigured(),
      stats,
    });
    return true;
  }

  if (pathname === "/api/notebook" && method === "POST") {
    const svc = deps.getNotebookService?.();
    if (!svc) {
      sendJson(res, 503, { ok: false, error: "Notebook service unavailable" });
      return true;
    }
    const uid = deps.getConfig().owner.canonical_user_id;
    const body = (await readJsonBody(req)) as {
      title?: unknown;
      summary?: unknown;
      reason?: unknown;
      content?: unknown;
      tags?: unknown;
      imageDataUrl?: unknown;
    };
    try {
      const entry = await svc.saveEntry(uid, {
        title: typeof body.title === "string" ? body.title : undefined,
        summary: typeof body.summary === "string" ? body.summary : "",
        reason: typeof body.reason === "string" ? body.reason : "",
        content: typeof body.content === "string" ? body.content : undefined,
        tags: Array.isArray(body.tags)
          ? body.tags.map((x) => String(x).trim()).filter(Boolean)
          : undefined,
        imageDataUrl: typeof body.imageDataUrl === "string" ? body.imageDataUrl : undefined,
      });
      sendJson(res, 201, { ok: true, entry });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: summarizeError(err) });
    }
    return true;
  }

  if (pathname === "/api/notebook/reindex" && method === "POST") {
    const svc = deps.getNotebookService?.();
    if (!svc) {
      sendJson(res, 503, { ok: false, error: "Notebook service unavailable" });
      return true;
    }
    const uid = deps.getConfig().owner.canonical_user_id;
    const body = (await readJsonBody(req).catch(() => ({}))) as { force?: unknown };
    const result = await svc.reindexAll(uid, { force: body.force === true });
    sendJson(res, 200, { ...result, ok: result.ok });
    return true;
  }

  const notebookImageMatch = pathname.match(/^\/api\/notebook\/([^/]+)\/image$/);
  if (notebookImageMatch && method === "GET") {
    const svc = deps.getNotebookService?.();
    const uid = deps.getConfig().owner.canonical_user_id;
    const id = decodeURIComponent(notebookImageMatch[1]!);
    const entry = svc?.getStore().getById(uid, id);
    if (!entry || !entry.imagePath || !existsSync(entry.imagePath)) {
      sendJson(res, 404, { ok: false, error: "Notebook image not found" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": entry.imageMimeType || "image/png",
      "Cache-Control": "private, max-age=300",
    });
    res.end(readFileSync(entry.imagePath));
    return true;
  }

  const notebookItemMatch = pathname.match(/^\/api\/notebook\/([^/]+)$/);
  if (notebookItemMatch && method === "GET") {
    const svc = deps.getNotebookService?.();
    if (!svc) {
      sendJson(res, 503, { ok: false, error: "Notebook service unavailable" });
      return true;
    }
    const uid = deps.getConfig().owner.canonical_user_id;
    const id = decodeURIComponent(notebookItemMatch[1]!);
    const entry = svc.getStore().getById(uid, id);
    if (!entry) {
      sendJson(res, 404, { ok: false, error: "Notebook entry not found" });
      return true;
    }
    sendJson(res, 200, { ok: true, entry });
    return true;
  }

  if (notebookItemMatch && method === "PATCH") {
    const svc = deps.getNotebookService?.();
    if (!svc) {
      sendJson(res, 503, { ok: false, error: "Notebook service unavailable" });
      return true;
    }
    const uid = deps.getConfig().owner.canonical_user_id;
    const id = decodeURIComponent(notebookItemMatch[1]!);
    const body = (await readJsonBody(req)) as {
      title?: unknown;
      summary?: unknown;
      reason?: unknown;
      content?: unknown;
      tags?: unknown;
      imageDataUrl?: unknown;
      removeImage?: unknown;
    };
    try {
      const updated = await svc.updateEntry(uid, id, {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(Array.isArray(body.tags)
          ? { tags: body.tags.map((x) => String(x).trim()).filter(Boolean) }
          : {}),
        ...(typeof body.imageDataUrl === "string" ? { imageDataUrl: body.imageDataUrl } : {}),
        ...(body.removeImage === true ? { removeImage: true } : {}),
      });
      if (!updated) {
        sendJson(res, 404, { ok: false, error: "Notebook entry not found" });
        return true;
      }
      sendJson(res, 200, { ok: true, entry: updated });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: summarizeError(err) });
    }
    return true;
  }

  if (notebookItemMatch && method === "DELETE") {
    const svc = deps.getNotebookService?.();
    if (!svc) {
      sendJson(res, 503, { ok: false, error: "Notebook service unavailable" });
      return true;
    }
    const uid = deps.getConfig().owner.canonical_user_id;
    const id = decodeURIComponent(notebookItemMatch[1]!);
    const deleted = await svc.deleteEntry(uid, id);
    if (!deleted) {
      sendJson(res, 404, { ok: false, error: "Notebook entry not found" });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
