import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ProxyAgent as UndiciProxyAgent, WebSocket as UndiciWebSocket } from "undici";
import { resolveGatewayRetryConfig, type HatoConfig } from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { logError, logInfo, logWarn, summarizeError } from "../utils/logger.js";
import { retryWithBackoff } from "../utils/retry.js";
import { convertBufferToModelImage, saveInboundMediaBuffer } from "./media.js";
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
  QqOpenApiClient,
  type QqSendMessageRequest,
} from "./qq-client.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundAttachment,
  InboundMessage,
  OutboundConfirmAction,
} from "./types.js";

const QQ_MAX_MESSAGE_LENGTH = 2000;
const QQ_PASSIVE_WINDOW_MS = 5 * 60 * 1000;
const QQ_MAX_PASSIVE_SEQ = 4;

export const QQ_CAPABILITIES: ChannelCapabilities = {
  channel: "qq",
  maxBubblesPerTurn: 3,
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
}

interface QqC2CMessageEvent {
  id: string;
  content?: string;
  timestamp?: string;
  author?: {
    id?: string;
    user_openid?: string;
    union_openid?: string;
  };
  attachments?: QqC2CAttachment[];
}

interface PassiveReplyState {
  msgId: string;
  receivedAtMs: number;
  nextSeq: number;
}

/**
 * QQ Official Bot C2C adapter using OpenAPI v2 + WebSocket Gateway.
 */
export class QqAdapter implements ChannelAdapter {
  readonly capabilities = QQ_CAPABILITIES;

  private config: HatoConfig;
  private readonly client: QqOpenApiClient;
  private readonly proxyRouter: ScopedProxyRouter;
  private readonly deps: QqAdapterDeps;
  private readonly passiveState = new Map<string, PassiveReplyState>();
  private readonly explicitSeq = new Map<string, number>();

  private stopped = true;
  private ws: UndiciWebSocket | null = null;
  private loopPromise: Promise<void> | null = null;
  private sessionId = "";
  private seq = 0;

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
    logInfo("QQ", `starting QQ Official Bot gateway (appId=${this.deps.appId})...`);
    this.loopPromise = this.runGatewayLoop().catch((err) => {
      if (!this.stopped) {
        logError("QQ", "gateway loop crashed", err);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
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

  private resolvePassiveReply(
    platformUserId: string,
    explicitMsgId?: string,
  ): { msg_id: string; msg_seq: number } | undefined {
    if (explicitMsgId) {
      const seq = this.explicitSeq.get(explicitMsgId) ?? 1;
      this.explicitSeq.set(explicitMsgId, seq + 1);
      if (this.explicitSeq.size > 200) {
        const firstKey = this.explicitSeq.keys().next().value;
        if (firstKey) this.explicitSeq.delete(firstKey);
      }
      if (seq <= QQ_MAX_PASSIVE_SEQ) {
        return { msg_id: explicitMsgId, msg_seq: seq };
      }
    }

    const state = this.passiveState.get(platformUserId);
    if (!state) return undefined;
    if (Date.now() - state.receivedAtMs > QQ_PASSIVE_WINDOW_MS) {
      this.passiveState.delete(platformUserId);
      return undefined;
    }
    if (state.nextSeq > QQ_MAX_PASSIVE_SEQ) {
      return undefined;
    }
    const seq = state.nextSeq;
    state.nextSeq += 1;
    return { msg_id: state.msgId, msg_seq: seq };
  }

  async sendText(
    platformUserId: string,
    text: string,
    replyToPlatformMsgId?: string,
  ): Promise<string | undefined> {
    const chunks = splitQqText(text, QQ_MAX_MESSAGE_LENGTH);
    let lastMsgId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const passive = this.resolvePassiveReply(
        platformUserId,
        i === 0 ? replyToPlatformMsgId : undefined,
      );
      const req: QqSendMessageRequest = {
        content: chunks[i]!,
        msg_type: 0,
        ...(passive ? passive : {}),
      };
      const sent = await this.runWithRetry(() => this.client.sendC2CMessage(platformUserId, req));
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
    const capped = bubbles.slice(0, this.capabilities.maxBubblesPerTurn);
    for (let i = 0; i < capped.length; i++) {
      if (i > 0) {
        const [minMs, maxMs] = delayRangeMs;
        const delayMs =
          maxMs > minMs ? minMs + Math.floor(Math.random() * (maxMs - minMs + 1)) : minMs;
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      await this.sendText(platformUserId, capped[i]!, i === 0 ? replyToPlatformMsgId : undefined);
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
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(30_000, backoffMs * 2);
    }
  }

  private async connectOnce(): Promise<boolean> {
    const gatewayUrl = await this.client.getGatewayUrl();
    const token = await this.client.getToken();
    const proxyRes = this.proxyRouter.resolveScope("gateway.qq");
    const dispatcher =
      proxyRes.mode === "proxy" && /^https?:\/\//i.test(proxyRes.url)
        ? new UndiciProxyAgent(proxyRes.url)
        : undefined;

    return await new Promise<boolean>((resolvePromise, rejectPromise) => {
      const ws = new UndiciWebSocket(gatewayUrl, dispatcher ? { dispatcher } : undefined);
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
      nextSeq: 1,
    });

    const text = (evt.content ?? "").trim();

    if (!this.isAllowedOwner(userOpenId)) {
      const claimMatch = /^\/sethome(?:@\S+)?\s+([A-Za-z0-9_-]+)\s*$/i.exec(text);
      if (claimMatch && this.deps.onClaimHome) {
        const result = await this.deps.onClaimHome({
          channel: "qq",
          platformUserId: userOpenId,
          code: claimMatch[1]!,
        });
        await this.sendText(userOpenId, result.reply, evt.id);
      } else {
        logWarn("QQ", `rejected message from unbound open_id=${userOpenId}`);
      }
      return;
    }

    const attachments: InboundAttachment[] = [];
    const images: ImageContent[] = [];

    for (const att of evt.attachments ?? []) {
      const isImage = Boolean(att.content_type?.startsWith("image/"));
      const item: InboundAttachment = {
        kind: isImage ? "image" : "file",
        filename: att.filename,
        mimeType: att.content_type,
      };
      attachments.push(item);
      if (isImage && att.url) {
        try {
          const buf = await this.proxyRouter.runWithScope("gateway.qq", async () => {
            const resp = await fetch(att.url!, { signal: AbortSignal.timeout(20_000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return Buffer.from(await resp.arrayBuffer());
          });
          const converted = await convertBufferToModelImage({
            buffer: buf,
            filePath: att.filename || ".png",
          });
          if (converted) {
            images.push(converted);
            item.localPath = saveInboundMediaBuffer(
              dirname(this.config.paths.sqlite),
              buf,
              att.filename || ".png",
            );
          }
        } catch (err) {
          logWarn("QQ", `failed to download inbound image ${att.filename ?? ""}: ${summarizeError(err)}`);
        }
      }
    }

    if (!text && attachments.length === 0) return;

    console.log(
      formatGatewayMessageLog({
        direction: "inbound",
        channel: "qq",
        timeZone: this.config.owner.timezone,
        userSlug: this.config.owner.canonical_user_id,
        text,
        attachments,
      }),
    );

    const tsMs = evt.timestamp ? Date.parse(evt.timestamp) || Date.now() : Date.now();
    this.deps.onInboundMessage({
      channel: "qq",
      platformUserId: userOpenId,
      platformMsgId: evt.id,
      canonicalUserId: this.config.owner.canonical_user_id,
      text,
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
