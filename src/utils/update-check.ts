import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHatoHomeDir } from "../config/paths.js";
import { summarizeError } from "./logger.js";

export const HATO_GITHUB_OWNER = "peach0x33a";
export const HATO_GITHUB_REPO = "hato";
export const HATO_GITHUB_URL = `https://github.com/${HATO_GITHUB_OWNER}/${HATO_GITHUB_REPO}`;
export const HATO_GITHUB_API_BASE = `https://api.github.com/repos/${HATO_GITHUB_OWNER}/${HATO_GITHUB_REPO}`;

export type ReleaseChannel = "stable" | "nightly";

export interface UpdateCheckResult {
  currentVersion: string;
  channel: ReleaseChannel;
  latestTag: string | null;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string;
  publishedAt: string | null;
  notesPreview: string | null;
  checkedAtMs: number;
  fromCache: boolean;
  error?: string;
}

export interface CheckForUpdatesOptions {
  channel?: ReleaseChannel;
  enabled?: boolean;
  force?: boolean;
  ttlHours?: number;
  timeoutMs?: number;
  cacheFilePath?: string;
  packageRoot?: string;
  fetchFn?: typeof fetch;
  nowMs?: number;
}

const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Read Hato's version string from `package.json`.
 */
export function readCurrentHatoVersion(packageRoot: string = DEFAULT_PACKAGE_ROOT): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version?.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Detect default release channel from a version string.
 */
export function detectDefaultReleaseChannel(version: string): ReleaseChannel {
  return version.toLowerCase().includes("nightly") ? "nightly" : "stable";
}

function parseSemverTuple(raw: string): [number, number, number, boolean] | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(cleaned);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Boolean(match[4]),
  ];
}

/**
 * Compare two semver strings (`v0.1.2` vs `0.1.1`). Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverTuple(a);
  const pb = parseSemverTuple(b);
  if (!pa || !pb) return 0;

  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] as number) - (pb[i] as number);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // Stable release > pre-release with same major.minor.patch
  if (pa[3] !== pb[3]) return pa[3] ? -1 : 1;
  return 0;
}

export function resolveDefaultUpdateCachePath(): string {
  return join(resolveHatoHomeDir(), "update-cache.json");
}

function readCachedResult(cachePath: string): UpdateCheckResult | null {
  try {
    if (!existsSync(cachePath)) return null;
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<UpdateCheckResult>;
    if (!raw || typeof raw.checkedAtMs !== "number" || typeof raw.channel !== "string") {
      return null;
    }
    return {
      currentVersion: String(raw.currentVersion ?? "0.0.0"),
      channel: raw.channel === "nightly" ? "nightly" : "stable",
      latestTag: raw.latestTag ?? null,
      latestVersion: raw.latestVersion ?? null,
      hasUpdate: Boolean(raw.hasUpdate),
      releaseUrl: raw.releaseUrl ?? `${HATO_GITHUB_URL}/releases`,
      publishedAt: raw.publishedAt ?? null,
      notesPreview: raw.notesPreview ?? null,
      checkedAtMs: raw.checkedAtMs,
      fromCache: true,
      ...(raw.error ? { error: raw.error } : {}),
    };
  } catch {
    return null;
  }
}

function writeCachedResult(cachePath: string, result: UpdateCheckResult): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort cache write
  }
}

/**
 * Read cached update check result synchronously without making any network calls.
 */
export function getCachedUpdateStatus(options?: {
  channel?: ReleaseChannel;
  cacheFilePath?: string;
  packageRoot?: string;
}): UpdateCheckResult | null {
  const currentVersion = readCurrentHatoVersion(options?.packageRoot);
  const channel = options?.channel ?? detectDefaultReleaseChannel(currentVersion);
  const cachePath = options?.cacheFilePath ?? resolveDefaultUpdateCachePath();
  const cached = readCachedResult(cachePath);
  if (!cached || cached.channel !== channel) return null;
  const hasUpdate =
    channel === "stable" && cached.latestVersion
      ? compareSemver(cached.latestVersion, currentVersion) > 0
      : cached.hasUpdate;
  return {
    ...cached,
    currentVersion,
    hasUpdate,
    fromCache: true,
  };
}

interface GitHubReleaseApiPayload {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
  prerelease?: boolean;
}

function summarizeReleaseBody(body: string | undefined): string | null {
  if (!body) return null;
  const cleaned = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 4)
    .join("\n");
  if (!cleaned) return null;
  return cleaned.length > 280 ? `${cleaned.slice(0, 280)}…` : cleaned;
}

function resolveLocalInstallTimestampMs(packageRoot: string): number {
  try {
    return statSync(resolve(packageRoot, "package.json")).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Check GitHub Releases for updates on the configured channel (`stable` or `nightly`).
 * Uses a local TTL cache and short timeout; never throws on network failures.
 */
export async function checkForUpdates(
  options?: CheckForUpdatesOptions,
): Promise<UpdateCheckResult> {
  const packageRoot = options?.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const currentVersion = readCurrentHatoVersion(packageRoot);
  const channel = options?.channel ?? detectDefaultReleaseChannel(currentVersion);
  const nowMs = options?.nowMs ?? Date.now();
  const ttlMs = (options?.ttlHours ?? 24) * 3600 * 1000;
  const cachePath = options?.cacheFilePath ?? resolveDefaultUpdateCachePath();

  if (options?.enabled === false || process.env.HATO_NO_UPDATE_CHECK === "1") {
    return {
      currentVersion,
      channel,
      latestTag: null,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: `${HATO_GITHUB_URL}/releases`,
      publishedAt: null,
      notesPreview: null,
      checkedAtMs: nowMs,
      fromCache: false,
    };
  }

  const cached = readCachedResult(cachePath);
  if (
    !options?.force &&
    cached &&
    cached.channel === channel &&
    nowMs - cached.checkedAtMs < ttlMs &&
    !cached.error
  ) {
    const hasUpdate =
      channel === "stable" && cached.latestVersion
        ? compareSemver(cached.latestVersion, currentVersion) > 0
        : cached.hasUpdate;
    return {
      ...cached,
      currentVersion,
      hasUpdate,
      fromCache: true,
    };
  }

  const fetchImpl = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 3000;
  const endpoint =
    channel === "nightly"
      ? `${HATO_GITHUB_API_BASE}/releases/tags/nightly`
      : `${HATO_GITHUB_API_BASE}/releases/latest`;

  try {
    const res = await fetchImpl(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `hato/${currentVersion}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`GitHub API HTTP ${res.status}`);
    }
    const payload = (await res.json()) as GitHubReleaseApiPayload;
    const latestTag = payload.tag_name?.trim() || null;
    const latestVersion = latestTag ? latestTag.replace(/^v/i, "") : null;
    const publishedAt = payload.published_at?.trim() || null;
    const releaseUrl = payload.html_url?.trim() || `${HATO_GITHUB_URL}/releases`;
    const notesPreview = summarizeReleaseBody(payload.body);

    let hasUpdate = false;
    if (channel === "stable" && latestVersion) {
      hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
    } else if (channel === "nightly" && publishedAt) {
      const remoteTs = Date.parse(publishedAt);
      const localTs = resolveLocalInstallTimestampMs(packageRoot);
      hasUpdate = Number.isFinite(remoteTs) && remoteTs > localTs + 60_000;
    }

    const result: UpdateCheckResult = {
      currentVersion,
      channel,
      latestTag,
      latestVersion,
      hasUpdate,
      releaseUrl,
      publishedAt,
      notesPreview,
      checkedAtMs: nowMs,
      fromCache: false,
    };
    writeCachedResult(cachePath, result);
    return result;
  } catch (err) {
    return {
      currentVersion,
      channel,
      latestTag: cached?.latestTag ?? null,
      latestVersion: cached?.latestVersion ?? null,
      hasUpdate: false,
      releaseUrl: cached?.releaseUrl ?? `${HATO_GITHUB_URL}/releases`,
      publishedAt: cached?.publishedAt ?? null,
      notesPreview: null,
      checkedAtMs: nowMs,
      fromCache: false,
      error: summarizeError(err),
    };
  }
}

/**
 * Build a stable deduplication key for a release notification (by channel + tag/timestamp).
 */
export function buildUpdateNotificationKey(result: UpdateCheckResult): string | null {
  if (!result.hasUpdate || !result.latestTag) return null;
  if (result.channel === "nightly") {
    return `nightly:${result.latestTag}:${result.publishedAt ?? ""}`;
  }
  return `stable:${result.latestTag}`;
}
