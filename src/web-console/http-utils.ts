import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

export class HttpStatusError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MAX_CACHE_ENTRIES = 200;
const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function timingSafeTokenEqual(provided: string, expected: string): boolean {
  if (provided.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function extractHostnameFromHostHeader(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    return closeIdx > 0 ? trimmed.slice(0, closeIdx + 1) : trimmed;
  }
  const colonIdx = trimmed.lastIndexOf(":");
  return colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed;
}

export function validateRequestOriginAndHost(
  req: IncomingMessage,
  method: string,
  consoleHost: string,
): { ok: true } | { ok: false; error: string } {
  const hostHeader = typeof req.headers.host === "string" ? req.headers.host.trim() : "";

  // DNS rebinding defense when bound to loopback: reject unexpected Host headers.
  if (hostHeader && isLoopbackHost(consoleHost)) {
    const reqHost = extractHostnameFromHostHeader(hostHeader);
    if (!isLoopbackHost(reqHost)) {
      return { ok: false, error: `Forbidden Host header "${hostHeader}"` };
    }
  }

  const secFetchSite =
    typeof req.headers["sec-fetch-site"] === "string"
      ? req.headers["sec-fetch-site"].trim().toLowerCase()
      : "";
  if (secFetchSite === "cross-site") {
    return { ok: false, error: "Forbidden cross-site API request" };
  }

  const originHeader = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  if (originHeader) {
    try {
      const originUrl = new URL(originHeader);
      const sameHost = hostHeader && originUrl.host.toLowerCase() === hostHeader.toLowerCase();
      const isViteDevSameOrigin =
        secFetchSite === "same-origin" &&
        isLoopbackHost(consoleHost) &&
        isLoopbackHost(originUrl.hostname);
      if (!sameHost && !isViteDevSameOrigin) {
        return { ok: false, error: `Forbidden cross-origin request from "${originHeader}"` };
      }
    } catch {
      return { ok: false, error: "Malformed Origin header" };
    }
  }

  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    const contentType =
      typeof req.headers["content-type"] === "string"
        ? req.headers["content-type"].trim().toLowerCase()
        : "";
    const contentLength = Number(req.headers["content-length"] ?? "0");
    const hasBody =
      (Number.isFinite(contentLength) && contentLength > 0) ||
      Boolean(req.headers["transfer-encoding"]);
    if (hasBody && !contentType.startsWith("application/json")) {
      return {
        ok: false,
        error: "Unsupported Content-Type: JSON endpoints require application/json",
      };
    }
  }

  return { ok: true };
}

export function pruneCache<T extends { expiresAt: number }>(
  cache: Map<string, T>,
  nowMs = Date.now(),
): void {
  for (const [k, v] of cache.entries()) {
    if (v.expiresAt <= nowMs) {
      cache.delete(k);
    }
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function serveStaticAsset(
  staticDir: string,
  pathname: string,
  res: ServerResponse,
  headOnly: boolean,
): void {
  const indexPath = resolve(staticDir, "index.html");
  if (!existsSync(indexPath)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (!headOnly) {
      res.end(
        `<!doctype html><html><body style="font-family:sans-serif;padding:32px;line-height:1.6">` +
          `<h2>Hato Web 控制台后端已运行</h2>` +
          `<p>前端静态产物尚未构建，请运行 <code>bun run build:web</code> 后刷新页面。</p>` +
          `</body></html>`,
      );
    } else {
      res.end();
    }
    return;
  }

  const cleanRel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(staticDir, cleanRel);
  const safeCandidate =
    candidate === staticDir || candidate.startsWith(`${staticDir}${sep}`)
      ? candidate
      : indexPath;

  const targetPath =
    existsSync(safeCandidate) && statSync(safeCandidate).isFile() ? safeCandidate : indexPath;

  const ext = extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const bytes = readFileSync(targetPath);
  const cacheControl =
    ext === ".html"
      ? "no-store, no-cache, must-revalidate"
      : cleanRel.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": bytes.byteLength,
    "Cache-Control": cacheControl,
  });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(bytes);
}

export function maskSecretPreview(secret: string): string {
  const clean = secret.trim();
  if (clean.length <= 8) return "***";
  return `${clean.slice(0, 4)}***${clean.slice(-4)}`;
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new HttpStatusError(413, "Request body exceeds 16MB limit");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpStatusError(400, "Invalid JSON request body");
  }
}

export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}
