import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import type { ModelRegistry, ResolvedProviderMeta } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { getOptionalSecret } from "../config/secrets.js";

export interface OpenAiImageGenParams {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
  filename?: string;
  referenceImagePaths?: string[];
  workspaceDir: string;
  providerSlug: string;
  baseUrl: string;
  apiKey: string;
  proxyRouter: ScopedProxyRouter;
  timeoutMs?: number;
  maxRetries?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface GeneratedImageFile {
  path: string;
  relativePath: string;
  bytes: number;
  revisedPrompt?: string;
}

export interface OpenAiImageGenResult {
  ok: boolean;
  providerSlug: string;
  model: string;
  files: GeneratedImageFile[];
  error?: string;
}

const DEFAULT_IMAGE_MODEL = "gpt-image-2";
export const DEFAULT_IMAGE_GEN_TIMEOUT_MS = 300_000;
export const DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Pick an OpenAI-compatible provider for image generation, preferring `claudeflare`,
 * then the `worker` slot's provider, then the first OpenAI-compatible provider.
 */
export function resolveImageGenProvider(modelRegistry: ModelRegistry): ResolvedProviderMeta | null {
  const providers = modelRegistry.listProviders();
  const claudeflare = providers.find((p) => p.slug === "claudeflare");
  if (claudeflare) return claudeflare;

  try {
    const workerSlot = modelRegistry.resolveSlot("worker");
    const workerProvider = providers.find((p) => p.slug === workerSlot.providerSlug);
    if (
      workerProvider &&
      (workerProvider.api === "openai-completions" || workerProvider.api === "openai-responses")
    ) {
      return workerProvider;
    }
  } catch {
    // ignore missing slot
  }

  return (
    providers.find(
      (p) => p.api === "openai-completions" || p.api === "openai-responses",
    ) ?? null
  );
}

export function buildImagesGenerationsUrl(baseUrl: string, isEdit = false): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  const suffix = isEdit ? "images/edits" : "images/generations";
  if (clean.endsWith(`/${suffix}`)) return clean;
  if (clean.endsWith("/v1")) return `${clean}/${suffix}`;
  return `${clean}/v1/${suffix}`;
}

function inferImageMimeFromPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

function resolveWorkspaceImagePath(workspaceDir: string, relPath: string): string {
  const root = resolve(workspaceDir);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(`${root}${sep}`)) {
    throw new Error(`Image output path escapes workspace boundary: ${relPath}`);
  }
  return abs;
}

const TRANSIENT_IMAGE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504, 520, 522, 523, 524]);

function isTransientImageNetworkError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  return /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|UND_ERR_|socket|fetch failed|other side closed|timed? out/i.test(
    text,
  );
}

/**
 * Generate one or more images via an OpenAI-compatible `/v1/images/generations` endpoint
 * and save them into `workspaceDir`.
 */
export async function generateOpenAiImage(
  params: OpenAiImageGenParams,
): Promise<OpenAiImageGenResult> {
  const model = params.model?.trim() || DEFAULT_IMAGE_MODEL;
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    return {
      ok: false,
      providerSlug: params.providerSlug,
      model,
      files: [],
      error: `Missing API key for image generation provider "${params.providerSlug}"`,
    };
  }

  const refPaths = (params.referenceImagePaths ?? []).map((p) => p.trim()).filter(Boolean);
  const isEdit = refPaths.length > 0;
  const endpoint = buildImagesGenerationsUrl(params.baseUrl, isEdit);
  const scope = `llm-calling.${params.providerSlug}`;
  const count = Math.max(1, Math.min(4, Math.floor(params.n ?? 1)));
  const timeoutMs = params.timeoutMs ?? DEFAULT_IMAGE_GEN_TIMEOUT_MS;

  const callApi = async (includeResponseFormat: boolean) => {
    let headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    let reqBody: string | Buffer;

    if (isEdit) {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", params.prompt);
      form.append("n", String(count));
      form.append("size", params.size?.trim() || "1024x1024");
      if (params.quality?.trim()) form.append("quality", params.quality.trim());
      if (includeResponseFormat) form.append("response_format", "b64_json");

      const imageField = refPaths.length > 1 ? "image[]" : "image";
      for (const ref of refPaths) {
        const absRef = resolve(params.workspaceDir, ref);
        const targetPath = existsSync(absRef) ? absRef : resolve(ref);
        if (!existsSync(targetPath)) {
          throw new Error(`Reference image not found: ${ref}`);
        }
        const bytes = readFileSync(targetPath);
        const mime = inferImageMimeFromPath(targetPath);
        form.append(imageField, new Blob([bytes], { type: mime }), basename(targetPath));
      }
      const tempReq = new Request("http://localhost", { method: "POST", body: form });
      headers["Content-Type"] = tempReq.headers.get("content-type") || "multipart/form-data";
      reqBody = Buffer.from(await tempReq.arrayBuffer());
    } else {
      headers["Content-Type"] = "application/json";
      reqBody = JSON.stringify({
        model,
        prompt: params.prompt,
        n: count,
        size: params.size?.trim() || "1024x1024",
        ...(params.quality?.trim() ? { quality: params.quality.trim() } : {}),
        ...(includeResponseFormat ? { response_format: "b64_json" } : {}),
      });
    }

    const res = await params.proxyRouter.runWithScope(scope, () =>
      params.proxyRouter.scopedFetch(
        endpoint,
        {
          method: "POST",
          headers,
          body: reqBody,
          signal: AbortSignal.timeout(timeoutMs),
        },
        scope,
      ),
    );
    const raw = await res.text();
    return { res, raw };
  };

  const maxRetries = Math.max(0, Math.floor(params.maxRetries ?? 2));
  const sleep = params.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  try {
    let res!: Response;
    let raw = "";
    for (let attempt = 0; ; attempt++) {
      try {
        ({ res, raw } = await callApi(true));
        if (!res.ok && res.status === 400 && /response_format/i.test(raw)) {
          ({ res, raw } = await callApi(false));
        }
        if (res.ok || !TRANSIENT_IMAGE_HTTP_STATUSES.has(res.status) || attempt >= maxRetries) {
          break;
        }
      } catch (err) {
        if (!isTransientImageNetworkError(err) || attempt >= maxRetries) {
          throw err;
        }
      }
      await sleep(1500 * (attempt + 1));
    }

    if (!res.ok) {
      return {
        ok: false,
        providerSlug: params.providerSlug,
        model,
        files: [],
        error: `Image API HTTP ${res.status}: ${raw.slice(0, 300)}`,
      };
    }

    const parsed = JSON.parse(raw) as {
      data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
    };
    const items = Array.isArray(parsed.data) ? parsed.data : [];
    if (items.length === 0) {
      return {
        ok: false,
        providerSlug: params.providerSlug,
        model,
        files: [],
        error: "Image API returned empty data array",
      };
    }

    mkdirSync(params.workspaceDir, { recursive: true });
    const baseRel = params.filename?.trim() || `generated_${Date.now()}.png`;
    const files: GeneratedImageFile[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      let buf: Buffer;
      if (item.b64_json) {
        buf = Buffer.from(item.b64_json, "base64");
      } else if (item.url) {
        const imgRes = await params.proxyRouter.runWithScope(scope, () =>
          params.proxyRouter.scopedFetch(
            item.url!,
            { method: "GET", signal: AbortSignal.timeout(DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS) },
            scope,
          ),
        );
        if (!imgRes.ok) {
          throw new Error(`Failed to download generated image URL: HTTP ${imgRes.status}`);
        }
        buf = Buffer.from(await imgRes.arrayBuffer());
      } else {
        throw new Error(`Image item #${i + 1} missing both b64_json and url`);
      }

      const relName =
        items.length === 1
          ? baseRel
          : baseRel.replace(/(\.[a-zA-Z0-9]+)?$/, (_m, ext) => `_${i + 1}${ext || ".png"}`);
      const absPath = resolveWorkspaceImagePath(params.workspaceDir, relName);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, buf);

      files.push({
        path: absPath,
        relativePath: relative(resolve(params.workspaceDir), absPath).replace(/\\/g, "/"),
        bytes: buf.byteLength,
        revisedPrompt: item.revised_prompt,
      });
    }

    return {
      ok: true,
      providerSlug: params.providerSlug,
      model,
      files,
    };
  } catch (err) {
    return {
      ok: false,
      providerSlug: params.providerSlug,
      model,
      files: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Convenience helper resolving API key from environment for image generation
 * (prefers `CLAUDEFLARE_IMAGE_API_KEY` when using claudeflare, falling back to provider's apiKeyEnv).
 */
export function resolveProviderApiKey(provider: ResolvedProviderMeta): string {
  if (provider.slug === "claudeflare") {
    const dedicated = getOptionalSecret("CLAUDEFLARE_IMAGE_API_KEY")?.trim();
    if (dedicated) return dedicated;
  }
  return getOptionalSecret(provider.apiKeyEnv) ?? "";
}
