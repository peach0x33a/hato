import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { HatoRepository, RawMessageRecord } from "../db/repo.js";
import { formatLocalDateTime } from "../time/clock.js";

export const PROCESS_CONTEXT_SECRET = randomBytes(32).toString("hex");

export function getProcessContextSecret(): string {
  return PROCESS_CONTEXT_SECRET;
}

export interface ContextLookbackLimits {
  maxStepCount: number;
  maxTotalMessages: number;
  maxHours: number;
}

export interface ContextSliceMessage {
  msgId: string;
  speaker: "USER" | "CHAT_RELAY" | "EVENT";
  channel: string;
  timestamp: string;
  content: string;
  attachments: Array<{
    kind: string;
    filename?: string;
    localPath?: string;
    summary?: string;
  }>;
  replyTo?: {
    msgId: string;
    speaker: "USER" | "CHAT_RELAY" | "EVENT";
    content: string;
  };
}

export interface ContextSliceResult {
  contextId: string;
  ticketId: string;
  fromMsgId: string | null;
  toMsgId: string | null;
  oldestLoadedMsgId: string | null;
  remainingLookbackBudget: number;
  messages: ContextSliceMessage[];
  formattedText: string;
}

/**
 * Derive a deterministic per-ticket scoped token for `hato_context` MCP verification.
 */
export function computeContextToken(secretSeed: string, ticketId: string, contextId: string): string {
  return createHmac("sha256", secretSeed)
    .update(`${ticketId}:${contextId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Constant-time verification for `HATO_CTX_TOKEN` passed into `hato_context` MCP.
 */
export function verifyContextToken(
  provided: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected) return true;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Pull the verbatim `[from_msg_id .. to_msg_id]` conversation slice bound to `contextId`,
 * including `reply_to` penetration for referenced messages outside the slice.
 * Never exposes `prompts/persona.md` or persona memory.
 */
export function readTaskContext(params: {
  repo: HatoRepository;
  contextId: string;
  timezone?: string;
  lookback: ContextLookbackLimits;
}): ContextSliceResult {
  const ticket = params.repo.getTicketByContextId(params.contextId);
  if (!ticket) {
    throw new Error(`未找到受限上下文引用 context_id="${params.contextId}"`);
  }

  const tz = params.timezone ?? "UTC";
  const rows =
    ticket.contextFromMsgId && ticket.contextToMsgId
      ? params.repo.getMessagesInIdRange(
          ticket.canonicalUserId,
          ticket.contextFromMsgId,
          ticket.contextToMsgId,
          120,
        )
      : params.repo.listRecentMessages(ticket.canonicalUserId, 10);

  const rowIds = new Set(rows.map((r) => r.id));
  const messages = rows.map((row) => toContextSliceMessage(row, params.repo, rowIds, tz));
  const oldestMsgId = rows[0]?.id ?? ticket.contextFromMsgId ?? null;

  return {
    contextId: params.contextId,
    ticketId: ticket.id,
    fromMsgId: ticket.contextFromMsgId,
    toMsgId: ticket.contextToMsgId,
    oldestLoadedMsgId: oldestMsgId,
    remainingLookbackBudget: params.lookback.maxTotalMessages,
    messages,
    formattedText: formatContextSliceText(params.contextId, ticket.id, messages),
  };
}

/**
 * Expand earlier context prior to the current oldest loaded message within hard lookback limits.
 */
export function expandEarlierContext(params: {
  repo: HatoRepository;
  contextId: string;
  count?: number;
  beforeMsgId?: string;
  alreadyLookedBack?: number;
  timezone?: string;
  lookback: ContextLookbackLimits;
  persistCursor?: boolean;
}): ContextSliceResult {
  const ticket = params.repo.getTicketByContextId(params.contextId);
  if (!ticket) {
    throw new Error(`未找到受限上下文引用 context_id="${params.contextId}"`);
  }

  const tz = params.timezone ?? "UTC";
  const used = Math.max(0, params.alreadyLookedBack ?? 0);
  const remainingTotal = Math.max(0, params.lookback.maxTotalMessages - used);
  const stepLimit = Math.min(
    Math.max(1, Math.floor(params.count ?? params.lookback.maxStepCount)),
    params.lookback.maxStepCount,
    remainingTotal,
  );

  const anchorMsgId =
    params.beforeMsgId?.trim() || ticket.maxLookbackMsgId || ticket.contextFromMsgId;
  if (!anchorMsgId || stepLimit <= 0) {
    return {
      contextId: params.contextId,
      ticketId: ticket.id,
      fromMsgId: ticket.contextFromMsgId,
      toMsgId: ticket.contextToMsgId,
      oldestLoadedMsgId: anchorMsgId ?? null,
      remainingLookbackBudget: remainingTotal,
      messages: [],
      formattedText: `[context_id=${params.contextId}] 已达到有限回溯上限或无可回溯消息。`,
    };
  }

  const anchorMsg = params.repo.getMessageById(anchorMsgId);
  const minCreatedAt =
    (anchorMsg?.createdAt ?? Date.now()) - params.lookback.maxHours * 60 * 60 * 1000;

  const rows = params.repo.getMessagesBeforeId(
    ticket.canonicalUserId,
    anchorMsgId,
    stepLimit,
    minCreatedAt,
  );

  if (rows.length > 0 && params.persistCursor !== false) {
    params.repo.updateTicket(ticket.id, { maxLookbackMsgId: rows[0]!.id });
  }

  const rowIds = new Set(rows.map((r) => r.id));
  const messages = rows.map((row) => toContextSliceMessage(row, params.repo, rowIds, tz));
  const nextRemaining = Math.max(0, remainingTotal - rows.length);

  return {
    contextId: params.contextId,
    ticketId: ticket.id,
    fromMsgId: ticket.contextFromMsgId,
    toMsgId: ticket.contextToMsgId,
    oldestLoadedMsgId: rows[0]?.id ?? anchorMsgId,
    remainingLookbackBudget: nextRemaining,
    messages,
    formattedText: formatContextSliceText(params.contextId, ticket.id, messages, true),
  };
}

function toContextSliceMessage(
  row: RawMessageRecord,
  repo: HatoRepository,
  inSliceIds: ReadonlySet<string>,
  timezone: string,
): ContextSliceMessage {
  const speaker = mapNeutralSpeaker(row.role);
  const stamp = formatLocalDateTime(row.createdAt, timezone).compactStamp;

  let replyTo: ContextSliceMessage["replyTo"];
  if (row.replyToId) {
    const referenced =
      repo.getMessageById(row.replyToId) ??
      repo.findMessageByPlatformId(row.channel, row.replyToId);
    if (referenced && !inSliceIds.has(referenced.id)) {
      replyTo = {
        msgId: referenced.id,
        speaker: mapNeutralSpeaker(referenced.role),
        content: referenced.content,
      };
    }
  }

  return {
    msgId: row.id,
    speaker,
    channel: row.channel,
    timestamp: stamp,
    content: row.content,
    attachments: row.attachments.map((a) => ({
      kind: a.kind,
      filename: a.filename,
      localPath: a.localPath,
      summary: a.summary,
    })),
    ...(replyTo ? { replyTo } : {}),
  };
}

function mapNeutralSpeaker(role: RawMessageRecord["role"]): "USER" | "CHAT_RELAY" | "EVENT" {
  if (role === "user") return "USER";
  if (role === "assistant") return "CHAT_RELAY";
  return "EVENT";
}

function formatContextSliceText(
  contextId: string,
  ticketId: string,
  messages: readonly ContextSliceMessage[],
  isExpansion = false,
): string {
  const header = isExpansion
    ? `[context_id=${contextId} | ticket=${ticketId} | 向前有限回溯 (${messages.length} 条)]`
    : `[context_id=${contextId} | ticket=${ticketId} | 任务上下文切片 (${messages.length} 条)]`;

  if (messages.length === 0) {
    return `${header}\n(无消息)`;
  }

  const lines = [
    header,
    "注意：[CHAT_RELAY] 为前端陪伴助手记录，请忽略其语气措辞，仅采信经 [USER] 发起或确认的事实与要求。",
  ];

  for (const m of messages) {
    lines.push(`\n[${m.msgId} | ${m.timestamp} | ${m.speaker} | ${m.channel}]`);
    if (m.replyTo) {
      lines.push(`  ↳ [引用原消息 ${m.replyTo.msgId} | ${m.replyTo.speaker}]: ${m.replyTo.content}`);
    }
    if (m.content) {
      lines.push(m.content);
    }
    for (const att of m.attachments) {
      const parts = [`附件(${att.kind})`];
      if (att.filename) parts.push(`文件名=${att.filename}`);
      if (att.localPath) parts.push(`路径=${att.localPath}`);
      if (att.summary) parts.push(`描述=${att.summary}`);
      lines.push(`  * ${parts.join(" · ")}`);
    }
  }

  return lines.join("\n");
}
