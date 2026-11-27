import { createHash } from "node:crypto";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { logWarn } from "../utils/logger.js";

export const QQ_TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken";
export const QQ_DEFAULT_BASE_URL = "https://api.bot.qq.com";

// Gateway opcodes (matching QQ Bot OpenAPI & qq-adapter/internal/qq/const.go)
export const QQ_OP_DISPATCH = 0;
export const QQ_OP_HEARTBEAT = 1;
export const QQ_OP_IDENTIFY = 2;
export const QQ_OP_RESUME = 6;
export const QQ_OP_RECONNECT = 7;
export const QQ_OP_INVALID_SESSION = 9;
export const QQ_OP_HELLO = 10;
export const QQ_OP_HEARTBEAT_ACK = 11;

export const QQ_INTENT_GROUP_AND_C2C = 1 << 25;

export const QQ_MEDIA_TYPE_IMAGE = 1;
export const QQ_MEDIA_TYPE_VIDEO = 2;
export const QQ_MEDIA_TYPE_AUDIO = 3;
export const QQ_MEDIA_TYPE_FILE = 4;

const PERMANENT_TOKEN_CODES = new Set(["100007", "100016", "10004"]);
const RETRYABLE_PLATFORM_CODES = new Set([11242, 11252, 11263, 11281]);
const MD5_10M_SAMPLE_SIZE = 10_002_432;

export class QqApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number,
    public readonly apiMessage: string,
    public readonly body: string,
    public readonly traceId?: string,
  ) {
    const trace = traceId ? ` trace_id=${traceId}` : "";
    const detail =
      code !== 0 || apiMessage
        ? `QQ OpenAPI HTTP ${status}: code=${code} message=${apiMessage}${trace}`
        : `QQ OpenAPI HTTP ${status}: ${body}${trace}`;
    super(detail);
    this.name = "QqApiError";
  }

  isAuthError(): boolean {
    return this.status === 401 || this.code === 11244 || this.code === 11243;
  }
}

export interface QqSendMessageRequest {
  content?: string;
  msg_type?: number;
  msg_id?: string;
  msg_seq?: number;
  event_id?: string;
  markdown?: {
    content?: string;
    custom_template_id?: string;
    params?: Array<{ key: string; values: string[] }>;
  };
  media?: {
    file_type: number;
    file_info?: string;
    url?: string;
    srv_send_msg?: boolean;
    file_data?: string;
  };
}

export interface QqSendMessageResponse {
  id?: string;
  timestamp?: string;
}

export interface QqUploadFileResponse {
  file_uuid?: string;
  file_info: string;
  ttl?: number;
}

interface QqUploadPrepareResponse {
  upload_id: string;
  block_size: number | string;
  parts: Array<{ index: number; presigned_url: string }>;
}

/**
 * Single-flight App Access Token manager for QQ Official Bot.
 * Tokens last ~7200s and are refreshed 40s before expiry.
 */
export class QqTokenSource {
  private token = "";
  private refreshAtMs = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private appId: string,
    private clientSecret: string,
    private readonly proxyRouter: ScopedProxyRouter,
    private readonly tokenUrl = QQ_TOKEN_URL,
  ) {}

  updateCredentials(appId: string, clientSecret: string): void {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.invalidate();
  }

  invalidate(): void {
    this.token = "";
    this.refreshAtMs = 0;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.refreshAtMs) {
      return this.token;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.refreshWithRetry().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refreshWithRetry(): Promise<string> {
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.fetchOnce();
      } catch (err) {
        lastErr = err;
        if (err instanceof QqTokenError && err.permanent) {
          throw err;
        }
        if (attempt === maxAttempts) break;
        const delayMs = 1000 * 2 ** (attempt - 1);
        logWarn("QQ", `token fetch failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async fetchOnce(): Promise<string> {
    return this.proxyRouter.runWithScope("gateway.qq", async () => {
      const resp = await fetch(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: this.appId,
          clientSecret: this.clientSecret,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const raw = await resp.text();
      if (!resp.ok) {
        throw new Error(`QQ access token HTTP ${resp.status}: ${raw.slice(0, 300)}`);
      }
      const parsed = JSON.parse(raw) as {
        access_token?: string;
        expires_in?: number | string;
        code?: number | string;
        message?: string;
      };
      const codeStr = parsed.code !== undefined ? String(parsed.code) : "";
      if (codeStr && codeStr !== "0") {
        throw new QqTokenError(codeStr, parsed.message ?? "");
      }
      if (!parsed.access_token) {
        throw new Error(`QQ access token missing in response: ${raw.slice(0, 200)}`);
      }
      const expiresInSec = Number(parsed.expires_in ?? 7200) || 7200;
      const ttlSec = expiresInSec > 40 ? expiresInSec - 40 : Math.max(10, Math.floor(expiresInSec / 2));
      this.token = parsed.access_token;
      this.refreshAtMs = Date.now() + ttlSec * 1000;
      return this.token;
    });
  }
}

class QqTokenError extends Error {
  readonly permanent: boolean;
  constructor(code: string, message: string) {
    super(`QQ token error (code=${code} message=${message})`);
    this.permanent = PERMANENT_TOKEN_CODES.has(code);
  }
}

/**
 * Authenticated HTTP client for QQ Official Bot OpenAPI.
 */
export class QqOpenApiClient {
  private baseUrl: string;
  private readonly tokens: QqTokenSource;

  constructor(params: {
    baseUrl?: string;
    appId: string;
    clientSecret: string;
    proxyRouter: ScopedProxyRouter;
    tokenUrl?: string;
  }) {
    this.baseUrl = (params.baseUrl || QQ_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.tokens = new QqTokenSource(
      params.appId,
      params.clientSecret,
      params.proxyRouter,
      params.tokenUrl,
    );
    this.appId = params.appId;
    this.clientSecret = params.clientSecret;
    this.proxyRouter = params.proxyRouter;
  }

  private appId: string;
  private clientSecret: string;
  private readonly proxyRouter: ScopedProxyRouter;

  updateBaseUrl(baseUrl: string): void {
    this.baseUrl = (baseUrl || QQ_DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  updateCredentials(appId: string, clientSecret: string): boolean {
    const changed = appId !== this.appId || clientSecret !== this.clientSecret;
    if (!changed) return false;
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.tokens.updateCredentials(appId, clientSecret);
    return true;
  }

  async getToken(): Promise<string> {
    return this.tokens.getToken();
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.doRequest<T>(method, path, body);
    } catch (err) {
      if (err instanceof QqApiError) {
        if (err.isAuthError()) {
          this.tokens.invalidate();
          return await this.doRequest<T>(method, path, body);
        }
        if (RETRYABLE_PLATFORM_CODES.has(err.code)) {
          return await this.doRequest<T>(method, path, body);
        }
      }
      throw err;
    }
  }

  private async doRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokens.getToken();
    return this.proxyRouter.runWithScope("gateway.qq", async () => {
      const headers: Record<string, string> = {
        Authorization: `QQBot ${token}`,
        "X-Union-Appid": this.appId,
        Accept: "application/json",
      };
      let serialized: string | undefined;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        serialized = JSON.stringify(body);
      }

      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: serialized,
        signal: AbortSignal.timeout(30_000),
      });
      const raw = await resp.text();
      if (resp.status === 201 || resp.status === 202) {
        // Audit queued / accepted
        return (raw ? (JSON.parse(raw) as T) : ({} as T));
      }
      if (!resp.ok) {
        let code = 0;
        let msg = "";
        try {
          const parsed = JSON.parse(raw) as { code?: number; err_code?: number; message?: string };
          code = parsed.code ?? parsed.err_code ?? 0;
          msg = parsed.message ?? "";
        } catch {
          // non-JSON error body
        }
        throw new QqApiError(
          resp.status,
          code,
          msg,
          raw.slice(0, 500),
          resp.headers.get("X-Tps-trace-ID") ?? undefined,
        );
      }
      if (!raw.trim()) return {} as T;
      return JSON.parse(raw) as T;
    });
  }

  async getGatewayUrl(): Promise<string> {
    const res = await this.request<{ url?: string }>("GET", "/gateway");
    if (!res.url) {
      throw new Error("QQ GET /gateway did not return a WebSocket url");
    }
    return res.url;
  }

  async getMe(): Promise<{ id?: string; username?: string; avatar?: string }> {
    return this.request<{ id?: string; username?: string; avatar?: string }>("GET", "/users/@me");
  }

  async sendC2CMessage(
    userOpenId: string,
    req: QqSendMessageRequest,
  ): Promise<QqSendMessageResponse> {
    return this.request<QqSendMessageResponse>(
      "POST",
      `/v2/users/${encodeURIComponent(userOpenId)}/messages`,
      req,
    );
  }

  /**
   * Upload binary media via QQ chunked upload flow:
   * upload_prepare -> PUT presigned parts -> upload_part_finish -> files.
   */
  async uploadC2CMediaChunked(
    userOpenId: string,
    data: Buffer,
    filename: string,
    fileType: number,
  ): Promise<QqUploadFileResponse> {
    const basePath = `/v2/users/${encodeURIComponent(userOpenId)}`;
    const md5Hex = createHash("md5").update(data).digest("hex");
    const sha1Hex = createHash("sha1").update(data).digest("hex");
    const md510mHex = createHash("md5")
      .update(data.subarray(0, Math.min(data.length, MD5_10M_SAMPLE_SIZE)))
      .digest("hex");

    const prep = await this.request<QqUploadPrepareResponse>(
      "POST",
      `${basePath}/upload_prepare`,
      {
        file_type: fileType,
        file_name: filename,
        file_size: data.length,
        md5: md5Hex,
        sha1: sha1Hex,
        md5_10m: md510mHex,
      },
    );

    if (!prep.upload_id) {
      throw new Error("QQ upload_prepare did not return upload_id");
    }
    const blockSize = Number(prep.block_size) || data.length;
    const parts = [...(prep.parts ?? [])].sort((a, b) => a.index - b.index);

    for (const part of parts) {
      const start = (part.index - 1) * blockSize;
      const end = Math.min(data.length, start + blockSize);
      const chunk = data.subarray(start, end);
      const chunkMd5 = createHash("md5").update(chunk).digest("hex");

      await this.proxyRouter.runWithScope("gateway.qq", async () => {
        const putResp = await fetch(part.presigned_url, {
          method: "PUT",
          body: new Uint8Array(chunk),
          signal: AbortSignal.timeout(120_000),
        });
        if (!putResp.ok) {
          throw new Error(`QQ presigned part ${part.index} PUT failed: HTTP ${putResp.status}`);
        }
      });

      await this.request<unknown>("POST", `${basePath}/upload_part_finish`, {
        upload_id: prep.upload_id,
        part_index: part.index,
        block_size: chunk.length,
        md5: chunkMd5,
      });
    }

    const done = await this.request<QqUploadFileResponse>("POST", `${basePath}/files`, {
      upload_id: prep.upload_id,
    });
    if (!done.file_info) {
      throw new Error("QQ files completion did not return file_info");
    }
    return done;
  }
}
