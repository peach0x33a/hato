import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resolveGatewayRetryConfig, type HatoConfig } from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { logError, logInfo, logWarn, summarizeError } from "../utils/logger.js";
import { retryWithBackoff } from "../utils/retry.js";
import { isNoReplyOutput } from "../persona/agent.js";
import { convertBufferToModelImage, detectMediaMimeType, saveInboundMediaBuffer } from "./media.js";
import { formatGatewayMessageLog } from "./msg-log.js";
import {
  QQ_INTENT_GROUP_AND_C2C,
  QQ_MEDIA_TYPE_FILE,
  QQ_MEDIA_TYPE_IMAGE,
  QQ_OP_DISPATCH,
  QQ_OP_HEARTBEAT,
  QQ_OP_HEARTBEAT_ACK,
  QQ_OP_HELLO,
  QQ_OP_IDENTIFY,
  QQ_OP_INVALID_SESSION,
  QQ_OP_RECONNECT,
  QQ_OP_RESUME,
  QqApiError,
  QqOpenApiClient,
  type QqSendMessageRequest,
  type QqSendMessageResponse,
} from "./qq-client.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundAttachment,
  InboundMessage,
  OutboundConfirmAction,
} from "./types.js";

const QQ_MAX_MESSAGE_LENGTH = 2000;
const QQ_PASSIVE_WINDOW_MS = 60 * 60 * 1000;
const QQ_MAX_PASSIVE_SEQ = 4;

export const QQ_CAPABILITIES: ChannelCapabilities = {
  channel: "qq",
  maxBubblesPerTurn: 4,
  supportsInlineConfirm: false,
  supportsDirectFileUpload: true,
  proactiveSupported: true,
};

export interface QqClaimHomeParams {
  channel: "qq";
  platformUserId: string;
  code: string;
}

export interface QqAdapterDeps {
  config: HatoConfig;
  appId: string;
  clientSecret: string;
  proxyRouter: ScopedProxyRouter;
  onInboundMessage: (msg: InboundMessage) => void;
  onClaimHome?: (params: QqClaimHomeParams) => Promise<{ ok: boolean; reply: string }>;
  tokenUrl?: string;
}

interface QqGatewayPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
  id?: string;
}

interface QqC2CAttachment {
  content_type?: string;
  filename?: string;
  url?: string;
  size?: number;
}

interface QqC2CMessageEvent {
  id: string;
  content?: string;
  timestamp?: string;
  message_reference?: {
    message_id?: string;
  };
  ark?: {
    template_id?: number;
    kv?: Array<{
      key?: string;
      value?: string;
      obj?: Array<{
        obj_kv?: Array<{ key?: string; value?: string }>;
      }>;
    }>;
  };
  author?: {
    id?: string;
    user_openid?: string;
    union_openid?: string;
  };
  attachments?: QqC2CAttachment[];
}

const MAX_INBOUND_FILE_BYTES = 25 * 1024 * 1024;

function inferExtensionFromContentType(mime?: string, filename?: string): string {
  if (filename && /\.[A-Za-z0-9]{1,8}$/.test(filename)) {
    return filename;
  }
  const lower = (mime ?? "").toLowerCase();
  if (lower.includes("pdf")) return ".pdf";
  if (lower.includes("json")) return ".json";
  if (lower.includes("xml")) return ".xml";
  if (lower.includes("zip")) return ".zip";
  if (lower.includes("plain")) return ".txt";
  if (lower.includes("png")) return ".png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("gif")) return ".gif";
  return ".bin";
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

/**
 * Extracts readable chat-forward entries from QQ JSON (`com.tencent.multimsg` / `messages`)
 * or XML (`serviceID="35"` / `<msg>`) forward cards.
 */
export function parseQqForwardPayload(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const lines: string[] = [];

      const meta = (parsed.meta as Record<string, unknown> | undefined)?.detail as
        | Record<string, unknown>
        | undefined;
      const news = Array.isArray(meta?.news) ? meta.news : undefined;
      if (news && news.length > 0) {
        const source = typeof meta?.source === "string" ? meta.source : "合并转发聊天记录";
        lines.push(`[${source}]`);
        for (const entry of news.slice(0, 30)) {
          if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
            lines.push(`- ${(entry as { text: string }).text.trim()}`);
          }
        }
      }

      const records =
        (Array.isArray(parsed.messages) ? parsed.messages : null) ??
        (Array.isArray(parsed.records) ? parsed.records : null) ??
        (Array.isArray(parsed) ? parsed : null);

      if (records && records.length > 0) {
        if (lines.length === 0) lines.push("[合并转发聊天记录]");
        for (const item of records.slice(0, 50)) {
          if (!item || typeof item !== "object") continue;
          const rec = item as Record<string, unknown>;
          const sender =
            (typeof rec.sender === "string" && rec.sender) ||
            (typeof rec.nickname === "string" && rec.nickname) ||
            (typeof rec.author === "string" && rec.author) ||
            "未知发送者";
          const body =
            (typeof rec.content === "string" && rec.content) ||
            (typeof rec.text === "string" && rec.text) ||
            (typeof rec.message === "string" && rec.message) ||
            "";
          if (body.trim()) {
            lines.push(`${sender}: ${body.trim()}`);
          }
        }
      }

      if (lines.length > 0) {
        return lines.join("\n");
      }
    } catch {
      // fall through to XML/plain checks
    }
  }

  if (/<msg[\s>]/i.test(trimmed) && /(multimsg|serviceID=["']35["']|<title[^>]*>|<summary[^>]*>)/i.test(trimmed)) {
    const titles = [...trimmed.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)]
      .map((m) => decodeXmlEntities(m[1] ?? ""))
      .filter(Boolean);
    const summaries = [...trimmed.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/gi)]
      .map((m) => decodeXmlEntities(m[1] ?? ""))
      .filter(Boolean);
    const lines = [...new Set([...titles, ...summaries])];
    if (lines.length > 0) {
      return `[合并转发聊天记录]\n${lines.map((l) => `- ${l}`).join("\n")}`;
    }
  }

  return null;
}

function formatQqArkSummary(ark: QqC2CMessageEvent["ark"]): string | null {
  if (!ark?.kv?.length) return null;
  const parts: string[] = [];
  for (const item of ark.kv) {
    if (item.value?.trim()) {
      parts.push(item.value.trim());
    }
    for (const obj of item.obj ?? []) {
      const kvs = (obj.obj_kv ?? [])
        .map((kv) => kv.value?.trim())
        .filter((v): v is string => Boolean(v));
      if (kvs.length > 0) parts.push(kvs.join(" · "));
    }
  }
  return parts.length > 0 ? `[卡片消息]\n${parts.join("\n")}` : null;
}

interface PassiveReplyState {
  msgId: string;
  receivedAtMs: number;
}

/**
 * QQ Official Bot C2C adapter using OpenAPI v2 + WebSocket Gateway.
 */
export function containsQqMarkdownSyntax(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)/.test(
    text,
  );
}

export class QqAdapter implements ChannelAdapter {
  readonly capabilities = QQ_CAPABILITIES;

  private config: HatoConfig;
  private readonly client: QqOpenApiClient;
  private readonly proxyRouter: ScopedProxyRouter;
  private readonly deps: QqAdapterDeps;
  private readonly passiveState = new Map<string, PassiveReplyState>();
  private readonly msgSeqByMsgId = new Map<string, number>();

  private stopped = true;
  private ws: WebSocket | null = null;
  private loopPromise: Promise<void> | null = null;
  private reconnectAbort: AbortController | null = null;
  private sessionId = "";
  private seq = 0;
  private markdownSupported: boolean | null = null;

  constructor(deps: QqAdapterDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.proxyRouter = deps.proxyRouter;
    this.client = new QqOpenApiClient({
      baseUrl: deps.config.gateway.qq.base_url,
      appId: deps.appId,
      clientSecret: deps.clientSecret,
      proxyRouter: deps.proxyRouter,
      tokenUrl: deps.tokenUrl,
    });
  }

  updateConfig(nextConfig: HatoConfig): void {
    this.config = nextConfig;
    this.client.updateBaseUrl(nextConfig.gateway.qq.base_url);
  }

  getStatus(): { running: boolean; online: boolean; sessionId?: string } {
    return {
      running: !this.stopped,
      online: !this.stopped && this.ws !== null && Boolean(this.sessionId),
      sessionId: this.sessionId || undefined,
    };
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAbort = new AbortController();
    logInfo("QQ", `starting QQ Official Bot gateway (appId=${this.deps.appId})...`);
    this.loopPromise = this.runGatewayLoop().catch((err) => {
      if (!this.stopped) {
        logError("QQ", "gateway loop crashed", err);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.reconnectAbort?.abort();
    this.reconnectAbort = null;
    try {
      this.ws?.close(1000, "shutdown");
    } catch {
      // ignore close errors
    }
    this.ws = null;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
    logInfo("QQ", "QQ Official Bot gateway stopped");
  }

  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    return retryWithBackoff(fn, {
      policy: resolveGatewayRetryConfig(this.config),
    });
  }

  private allocateMsgSeq(msgId: string): number | undefined {
    const seq = this.msgSeqByMsgId.get(msgId) ?? 1;
    if (seq > QQ_MAX_PASSIVE_SEQ) {
      return undefined;
    }
    this.msgSeqByMsgId.set(msgId, seq + 1);
    if (this.msgSeqByMsgId.size > 200) {
      const firstKey = this.msgSeqByMsgId.keys().next().value;
      if (firstKey) this.msgSeqByMsgId.delete(firstKey);
    }
    return seq;
  }

  private resolvePassiveReply(
    platformUserId: string,
    explicitMsgId?: string,
  ): { msg_id: string; msg_seq: number } | undefined {
    if (explicitMsgId) {
      const seq = this.allocateMsgSeq(explicitMsgId);
      return seq !== undefined ? { msg_id: explicitMsgId, msg_seq: seq } : undefined;
    }

    const state = this.passiveState.get(platformUserId);
    if (!state) return undefined;
    if (Date.now() - state.receivedAtMs > QQ_PASSIVE_WINDOW_MS) {
      this.passiveState.delete(platformUserId);
      return undefined;
    }
    const seq = this.allocateMsgSeq(state.msgId);
    return seq !== undefined ? { msg_id: state.msgId, msg_seq: seq } : undefined;
  }

  async sendText(
    platformUserId: string,
    text: string,
    replyToPlatformMsgId?: string,
  ): Promise<string | undefined> {
    const chunks = splitQqText(text, QQ_MAX_MESSAGE_LENGTH);
    let lastMsgId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const passiveId = i === 0 ? replyToPlatformMsgId : undefined;
      let sent: QqSendMessageResponse | undefined;

      if (this.markdownSupported !== false && containsQqMarkdownSyntax(chunk)) {
        const mdPassive = this.resolvePassiveReply(platformUserId, passiveId);
        const mdReq: QqSendMessageRequest = {
          msg_type: 2,
          markdown: { content: chunk },
          ...(mdPassive ? mdPassive : {}),
        };
        try {
          sent = await this.client.sendC2CMessage(platformUserId, mdReq);
          this.markdownSupported = true;
        } catch (err) {
          if (err instanceof QqApiError) {
            if (this.markdownSupported === null) {
              logWarn(
                "QQ",
                `native markdown (msg_type=2) rejected (${summarizeError(err)}); falling back to plain text`,
              );
            }
            this.markdownSupported = false;
          } else {
            throw err;
          }
        }
      }

      if (!sent) {
        const passive = this.resolvePassiveReply(platformUserId, passiveId);
        const req: QqSendMessageRequest = {
          content: chunk,
          msg_type: 0,
          ...(passive ? passive : {}),
        };
        sent = await this.runWithRetry(() => this.client.sendC2CMessage(platformUserId, req));
      }
      lastMsgId = sent.id;
    }
    console.log(
      formatGatewayMessageLog({
        direction: "outbound",
        channel: "qq",
        timeZone: this.config.owner.timezone,
        userSlug: this.config.owner.canonical_user_id,
        text,
      }),
    );
    return lastMsgId;
  }

  async sendBubbles(
    platformUserId: string,
    bubbles: string[],
    delayRangeMs: [number, number],
    replyToPlatformMsgId?: string,
  ): Promise<void> {
    const filtered = bubbles.filter((b) => b.trim() && !isNoReplyOutput(b));
    for (let i = 0; i < filtered.length; i++) {
      if (i > 0) {
        const [minMs, maxMs] = delayRangeMs;
        const delayMs =
          maxMs > minMs ? minMs + Math.floor(Math.random() * (maxMs - minMs + 1)) : minMs;
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      await this.sendText(platformUserId, filtered[i]!, i === 0 ? replyToPlatformMsgId : undefined);
    }
  }

  async sendPhoto(platformUserId: string, photo: Buffer | string, caption?: string): Promise<void> {
    const buf = typeof photo === "string" ? readFileSync(photo) : photo;
    const uploaded = await this.runWithRetry(() =>
      this.client.uploadC2CMediaChunked(platformUserId, buf, "image.png", QQ_MEDIA_TYPE_IMAGE),
    );
    const passive = this.resolvePassiveReply(platformUserId);
    await this.runWithRetry(() =>
      this.client.sendC2CMessage(platformUserId, {
        content: caption ?? "",
        msg_type: 7,
        media: {
          file_type: QQ_MEDIA_TYPE_IMAGE,
          file_info: uploaded.file_info,
        },
        ...(passive ? passive : {}),
      }),
    );
    console.log(
      formatGatewayMessageLog({
        direction: "outbound",
        channel: "qq",
        timeZone: this.config.owner.timezone,
        userSlug: this.config.owner.canonical_user_id,
        text: caption ?? "",
        attachments: [{ kind: "image", filename: "image.png" }],
      }),
    );
  }

  async sendSticker(
    platformUserId: string,
    opts: { fileId?: string; localPath?: string; caption?: string },
  ): Promise<void> {
    if (!opts.localPath) {
      throw new Error("QQ 无法仅通过 TG file_id 发送贴纸，缺少本地图片文件");
    }
    await this.sendFile(platformUserId, opts.localPath, basename(opts.localPath), opts.caption);
  }

  async sendFile(
    platformUserId: string,
    localPath: string,
    filename: string,
    caption?: string,
  ): Promise<void> {
    const buf = readFileSync(localPath);
    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(filename);
    const fileType = isImage ? QQ_MEDIA_TYPE_IMAGE : QQ_MEDIA_TYPE_FILE;
    const uploaded = await this.runWithRetry(() =>
      this.client.uploadC2CMediaChunked(platformUserId, buf, filename, fileType),
    );
    const passive = this.resolvePassiveReply(platformUserId);
    await this.runWithRetry(() =>
      this.client.sendC2CMessage(platformUserId, {
        content: caption ?? "",
        msg_type: 7,
        media: {
          file_type: fileType,
          file_info: uploaded.file_info,
        },
        ...(passive ? passive : {}),
      }),
    );
    console.log(
      formatGatewayMessageLog({
        direction: "outbound",
        channel: "qq",
        timeZone: this.config.owner.timezone,
        userSlug: this.config.owner.canonical_user_id,
        text: caption ?? "",
        attachments: [{ kind: isImage ? "image" : "file", filename }],
      }),
    );
  }

  async sendConfirm(platformUserId: string, confirm: OutboundConfirmAction): Promise<void> {
    await this.sendText(
      platformUserId,
      `${confirm.promptText}\n请回复「确认」或「取消」以继续处理 (${confirm.ticketId})。`,
    );
  }

  private isAllowedOwner(userOpenId: string): boolean {
    return this.config.owner.channels.qq.open_ids.includes(userOpenId);
  }

  private async runGatewayLoop(): Promise<void> {
    let backoffMs = 1000;
    while (!this.stopped) {
      let becameReady = false;
      try {
        becameReady = await this.connectOnce();
      } catch (err) {
        if (this.stopped) break;
        logWarn("QQ", `gateway disconnected: ${summarizeError(err)}`);
      }
      if (this.stopped) break;
      if (becameReady) {
        backoffMs = 1000;
      }
      await sleepAbortable(backoffMs, this.reconnectAbort?.signal);
      backoffMs = Math.min(30_000, backoffMs * 2);
    }
  }

  private async connectOnce(): Promise<boolean> {
    const gatewayUrl = await this.client.getGatewayUrl();
    const token = await this.client.getToken();
    const proxyRes = this.proxyRouter.resolveScope("gateway.qq");
    const proxyUrl =
      proxyRes.mode === "proxy" && /^https?:\/\//i.test(proxyRes.url)
        ? proxyRes.url
        : undefined;

    return await new Promise<boolean>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(gatewayUrl, (proxyUrl ? { proxy: proxyUrl } : undefined) as any);
      this.ws = ws;

      let ready = false;
      let settled = false;
      let hbTimer: ReturnType<typeof setInterval> | null = null;
      let hbAcked = true;

      const cleanup = () => {
        if (hbTimer) {
          clearInterval(hbTimer);
          hbTimer = null;
        }
        if (this.ws === ws) {
          this.ws = null;
        }
      };

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) rejectPromise(err);
        else resolvePromise(ready);
      };

      const sendPayload = (payload: QqGatewayPayload) => {
        ws.send(JSON.stringify(payload));
      };

      ws.addEventListener("message", (event) => {
        let payload: QqGatewayPayload;
        try {
          payload = JSON.parse(String(event.data)) as QqGatewayPayload;
        } catch {
          return;
        }

        if (payload.op === QQ_OP_HELLO) {
          const d = (payload.d ?? {}) as { heartbeat_interval?: number };
          const intervalMs = d.heartbeat_interval && d.heartbeat_interval > 0 ? d.heartbeat_interval : 41_250;

          if (this.sessionId) {
            logInfo("QQ", `resuming gateway session ${this.sessionId} (seq=${this.seq})`);
            sendPayload({
              op: QQ_OP_RESUME,
              d: {
                token: `QQBot ${token}`,
                session_id: this.sessionId,
                seq: this.seq,
              },
            });
          } else {
            logInfo("QQ", "identifying QQ gateway session");
            sendPayload({
              op: QQ_OP_IDENTIFY,
              d: {
                token: `QQBot ${token}`,
                intents: QQ_INTENT_GROUP_AND_C2C,
                shard: [0, 1],
              },
            });
          }

          if (hbTimer) {
            clearInterval(hbTimer);
            hbTimer = null;
          }
          hbAcked = true;
          hbTimer = setInterval(() => {
            if (!hbAcked) {
              logWarn("QQ", "heartbeat ACK timeout, closing WebSocket to reconnect");
              ws.close(4000, "heartbeat timeout");
              return;
            }
            hbAcked = false;
            sendPayload({
              op: QQ_OP_HEARTBEAT,
              d: this.seq > 0 ? this.seq : null,
            });
          }, intervalMs);
          hbTimer.unref?.();
          return;
        }

        if (payload.op === QQ_OP_HEARTBEAT_ACK) {
          hbAcked = true;
          return;
        }

        if (payload.op === QQ_OP_RECONNECT) {
          logWarn("QQ", "server requested reconnect (op=7)");
          ws.close(4000, "server reconnect");
          return;
        }

        if (payload.op === QQ_OP_INVALID_SESSION) {
          logWarn("QQ", "invalid session (op=9), resetting session state");
          this.sessionId = "";
          this.seq = 0;
          ws.close(4000, "invalid session");
          return;
        }

        if (payload.op === QQ_OP_DISPATCH) {
          if (typeof payload.s === "number" && payload.s > 0) {
            this.seq = payload.s;
          }
          if (payload.t === "READY") {
            const d = (payload.d ?? {}) as { session_id?: string };
            this.sessionId = d.session_id ?? "";
            ready = true;
            logInfo("QQ", `gateway READY (session_id=${this.sessionId})`);
            return;
          }
          if (payload.t === "RESUMED") {
            ready = true;
            logInfo("QQ", "gateway RESUMED");
            return;
          }
          if (payload.t === "C2C_MESSAGE_CREATE") {
            void this.handleC2CMessage(payload.d as QqC2CMessageEvent).catch((err) => {
              logError("QQ", "failed to handle C2C_MESSAGE_CREATE", err);
            });
          }
        }
      });

      ws.addEventListener("close", (event) => {
        const code = event.code;
        if (code > 4000 && code !== 4008 && code !== 4009) {
          this.sessionId = "";
          this.seq = 0;
        }
        if (this.stopped) {
          finish();
        } else {
          finish(new Error(`WebSocket closed (code=${code} reason=${event.reason || "none"})`));
        }
      });

      ws.addEventListener("error", () => {
        finish(new Error("WebSocket error"));
      });
    });
  }

  private async handleC2CMessage(evt: QqC2CMessageEvent): Promise<void> {
    const userOpenId =
      evt.author?.user_openid || evt.author?.union_openid || evt.author?.id || "";
    if (!userOpenId || !evt.id) return;

    this.passiveState.set(userOpenId, {
      msgId: evt.id,
      receivedAtMs: Date.now(),
    });

    const text = (evt.content ?? "").trim();

    if (!this.isAllowedOwner(userOpenId)) {
      if (this.config.owner.channels.qq.open_ids.length === 0 && this.deps.onClaimHome) {
        const claimMatch = /^\/sethome(?:@\S+)?(?:\s+([A-Za-z0-9_-]+))?\s*$/i.exec(text);
        if (claimMatch) {
          if (!claimMatch[1]) {
            await this.sendText(
              userOpenId,
              "当前 QQ 机器人尚未绑定主人账号，请带上控制台或启动终端中显示的配对码发送：/sethome <配对码>",
              evt.id,
            );
            return;
          }
          const result = await this.deps.onClaimHome({
            channel: "qq",
            platformUserId: userOpenId,
            code: claimMatch[1],
          });
          await this.sendText(userOpenId, result.reply, evt.id);
          return;
        }
      }
      logWarn("QQ", `rejected message from unbound open_id=${userOpenId}`);
      return;
    }

    const attachments: InboundAttachment[] = [];
    const images: ImageContent[] = [];
    const forwardNotes: string[] = [];

    const parsedContentForward = parseQqForwardPayload(text);
    if (parsedContentForward) {
      forwardNotes.push(parsedContentForward);
    }
    const arkSummary = formatQqArkSummary(evt.ark);
    if (arkSummary) {
      forwardNotes.push(arkSummary);
    }

    for (const att of evt.attachments ?? []) {
      const isImageByMeta =
        Boolean(att.content_type?.startsWith("image/")) ||
        /\.(png|jpe?g|webp|gif|bmp)$/i.test(att.filename ?? "");
      const item: InboundAttachment = {
        kind: isImageByMeta ? "image" : "file",
        filename: att.filename,
        mimeType: att.content_type,
      };
      attachments.push(item);
      if (!att.url) continue;
      if (typeof att.size === "number" && att.size > MAX_INBOUND_FILE_BYTES) {
        logWarn("QQ", `skipped oversized inbound attachment ${att.filename ?? ""} (${att.size} bytes)`);
        continue;
      }

      try {
        const parsedAttUrl = new URL(att.url);
        if (parsedAttUrl.protocol !== "https:" && parsedAttUrl.protocol !== "http:") {
          logWarn("QQ", `skipped attachment with unsupported URL scheme: ${parsedAttUrl.protocol}`);
          continue;
        }
        const buf = await this.proxyRouter.runWithScope("gateway.qq", async () => {
          const resp = await fetch(parsedAttUrl.toString(), { signal: AbortSignal.timeout(25_000) });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const contentLen = Number(resp.headers.get("content-length") ?? "");
          if (Number.isFinite(contentLen) && contentLen > MAX_INBOUND_FILE_BYTES) {
            throw new Error(`attachment exceeds ${MAX_INBOUND_FILE_BYTES} bytes limit`);
          }
          const data = Buffer.from(await resp.arrayBuffer());
          if (data.byteLength > MAX_INBOUND_FILE_BYTES) {
            throw new Error(`attachment exceeds ${MAX_INBOUND_FILE_BYTES} bytes limit`);
          }
          return data;
        });

        const dataDir = dirname(this.config.paths.sqlite);
        const filenameHint = inferExtensionFromContentType(att.content_type, att.filename);
        item.localPath = saveInboundMediaBuffer(dataDir, buf, filenameHint);

        const detectedMime = detectMediaMimeType(buf, filenameHint);
        const isImage = isImageByMeta || Boolean(detectedMime?.startsWith("image/"));
        if (isImage) {
          item.kind = "image";
          if (detectedMime) {
            item.mimeType = detectedMime;
          }
          const converted = await convertBufferToModelImage({
            buffer: buf,
            filePath: filenameHint,
          });
          if (converted) {
            images.push(converted);
          }
        } else if (buf.length <= 512 * 1024) {
          const lowerMime = (att.content_type ?? "").toLowerCase();
          const lowerName = (att.filename ?? "").toLowerCase();
          if (
            lowerMime.includes("json") ||
            lowerMime.includes("xml") ||
            lowerName.endsWith(".json") ||
            lowerName.endsWith(".xml") ||
            lowerName.includes("multimsg")
          ) {
            const parsedAtt = parseQqForwardPayload(buf.toString("utf8"));
            if (parsedAtt) {
              forwardNotes.push(parsedAtt);
            }
          }
        }
      } catch (err) {
        logWarn(
          "QQ",
          `failed to download inbound ${isImageByMeta ? "image" : "file"} ${att.filename ?? ""}: ${summarizeError(err)}`,
        );
      }
    }

    const effectiveTextParts: string[] = [];
    if (evt.message_reference?.message_id) {
      effectiveTextParts.push(`[引用消息: ${evt.message_reference.message_id}]`);
    }
    if (text && !parsedContentForward) {
      const cleaned = cleanQqFaceTags(text).trim();
      if (cleaned) {
        effectiveTextParts.push(cleaned);
      }
    }
    if (forwardNotes.length > 0) {
      effectiveTextParts.push(...forwardNotes);
    }
    const effectiveText = effectiveTextParts.join("\n").trim();

    if (!effectiveText && attachments.length === 0) return;

    console.log(
      formatGatewayMessageLog({
        direction: "inbound",
        channel: "qq",
        timeZone: this.config.owner.timezone,
        userSlug: this.config.owner.canonical_user_id,
        text: effectiveText,
        attachments,
      }),
    );

    const tsMs = evt.timestamp ? Date.parse(evt.timestamp) || Date.now() : Date.now();
    this.deps.onInboundMessage({
      channel: "qq",
      platformUserId: userOpenId,
      platformMsgId: evt.id,
      canonicalUserId: this.config.owner.canonical_user_id,
      text: effectiveText,
      attachments,
      images: images.length > 0 ? images : undefined,
      timestampMs: tsMs,
    });
  }
}

export function splitQqText(text: string, maxLen = QQ_MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.4) {
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function cleanQqFaceTags(text: string): string {
  return text.replace(
    /<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g,
    (_match, rawExt: string) => {
      try {
        const decoded = Buffer.from(rawExt, "base64").toString("utf8");
        const parsed = JSON.parse(decoded) as { text?: unknown };
        if (typeof parsed.text === "string" && parsed.text.trim()) {
          return `[表情:${parsed.text.trim().replace(/^\//, "")}]`;
        }
      } catch {
        // ignore malformed ext payload
      }
      return "[表情]";
    },
  );
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
