import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, lte, ne, or, type SQL } from "drizzle-orm";
import type { HatoDb } from "./client.js";
import { computeTurnMetrics, type TraceStepRecord } from "../stats/metrics.js";
import {
  chatSessions,
  memorySyncRecords,
  openLoops,
  owners,
  rawMessages,
  relationshipFacts,
  runtimeSettings,
  scheduleOverrides,
  scriptRegistry,
  tickets,
  turnTraces,
  workingMemoryBlocks,
} from "./schema.js";
import type { ChannelName, InboundAttachment } from "../gateway/types.js";

export interface ChatSessionRecord {
  id: string;
  canonicalUserId: string;
  title: string;
  summaryText: string;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  traceCount: number;
  createdAt: number;
}

export interface RawMessageRecord {
  id: string;
  canonicalUserId: string;
  channel: ChannelName;
  platformMsgId: string | null;
  replyToId: string | null;
  role: "user" | "assistant" | "executed_event";
  content: string;
  attachments: InboundAttachment[];
  createdAt: number;
}

export interface WorkingMemoryState {
  canonicalUserId: string;
  summaryText: string;
  compactedUntilMsgId: string | null;
  compactedUntilTs: number;
  draftSummary: string | null;
  draftUntilMsgId: string | null;
  draftUntilTs: number | null;
  retainedUntilMsgId: string | null;
}

export type MemorySyncBank = "persona" | "tech";
export type MemorySyncStatus = "synced" | "degraded" | "denied" | "error" | "erased";

export interface MemorySyncRecordView {
  id: string;
  canonicalUserId: string;
  provider: string;
  bank: MemorySyncBank;
  vaultId: string | null;
  sourceMsgIds: string[];
  content: string;
  externalMemoryId: string | null;
  status: MemorySyncStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySyncStats {
  total: number;
  synced: number;
  degraded: number;
  denied: number;
  error: number;
  erased: number;
  pendingRawMessages: number;
}

export class HatoRepository {
  constructor(private readonly db: HatoDb) {}

  ensureOwner(params: {
    canonicalUserId: string;
    tgUserId?: string | null;
    qqOpenId?: string | null;
    timezone: string;
    proactiveChannel: string;
  }): void {
    const now = Date.now();
    this.db
      .insert(owners)
      .values({
        canonicalUserId: params.canonicalUserId,
        tgUserId: params.tgUserId ?? null,
        qqOpenId: params.qqOpenId ?? null,
        timezone: params.timezone,
        proactiveChannel: params.proactiveChannel,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: owners.canonicalUserId,
        set: {
          tgUserId: params.tgUserId ?? null,
          qqOpenId: params.qqOpenId ?? null,
          timezone: params.timezone,
          proactiveChannel: params.proactiveChannel,
          updatedAt: now,
        },
      })
      .run();
  }

  appendRawMessage(params: {
    id?: string;
    canonicalUserId: string;
    channel: ChannelName;
    platformMsgId?: string | null;
    replyToId?: string | null;
    role: "user" | "assistant" | "executed_event";
    content: string;
    attachments?: InboundAttachment[];
    createdAt?: number;
  }): RawMessageRecord {
    const id = params.id ?? `msg_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const createdAt = params.createdAt ?? Date.now();
    const attachments = params.attachments ?? [];

    this.db
      .insert(rawMessages)
      .values({
        id,
        canonicalUserId: params.canonicalUserId,
        channel: params.channel,
        platformMsgId: params.platformMsgId ?? null,
        replyToId: params.replyToId ?? null,
        role: params.role,
        content: params.content,
        attachmentsJson: JSON.stringify(attachments),
        createdAt,
      })
      .run();

    return {
      id,
      canonicalUserId: params.canonicalUserId,
      channel: params.channel,
      platformMsgId: params.platformMsgId ?? null,
      replyToId: params.replyToId ?? null,
      role: params.role,
      content: params.content,
      attachments,
      createdAt,
    };
  }

  findMessageByPlatformId(channel: ChannelName, platformMsgId: string): RawMessageRecord | null {
    const row = this.db
      .select()
      .from(rawMessages)
      .where(and(eq(rawMessages.channel, channel), eq(rawMessages.platformMsgId, platformMsgId)))
      .limit(1)
      .get();

    return row ? toRawMessageRecord(row) : null;
  }

  getWorkingMemory(canonicalUserId: string): WorkingMemoryState {
    const row = this.db
      .select()
      .from(workingMemoryBlocks)
      .where(eq(workingMemoryBlocks.canonicalUserId, canonicalUserId))
      .get();

    if (row) {
      return {
        canonicalUserId: row.canonicalUserId,
        summaryText: row.summaryText,
        compactedUntilMsgId: row.compactedUntilMsgId,
        compactedUntilTs: row.compactedUntilTs,
        draftSummary: row.draftSummary,
        draftUntilMsgId: row.draftUntilMsgId,
        draftUntilTs: row.draftUntilTs,
        retainedUntilMsgId: row.retainedUntilMsgId,
      };
    }

    const now = Date.now();
    this.db
      .insert(workingMemoryBlocks)
      .values({
        canonicalUserId,
        summaryText: "",
        compactedUntilMsgId: null,
        compactedUntilTs: 0,
        draftSummary: null,
        draftUntilMsgId: null,
        draftUntilTs: null,
        retainedUntilMsgId: null,
        updatedAt: now,
      })
      .run();

    return {
      canonicalUserId,
      summaryText: "",
      compactedUntilMsgId: null,
      compactedUntilTs: 0,
      draftSummary: null,
      draftUntilMsgId: null,
      draftUntilTs: null,
      retainedUntilMsgId: null,
    };
  }

  /**
   * Fetch all messages after the compaction watermark in chronological order.
   */
  getHotMessages(canonicalUserId: string, compactedUntilTs: number): RawMessageRecord[] {
    const rows = this.db
      .select()
      .from(rawMessages)
      .where(
        and(
          eq(rawMessages.canonicalUserId, canonicalUserId),
          gt(rawMessages.createdAt, compactedUntilTs),
        ),
      )
      .orderBy(asc(rawMessages.createdAt), asc(rawMessages.id))
      .all();

    return rows.map(toRawMessageRecord);
  }

  getLastUserMessage(canonicalUserId: string): RawMessageRecord | null {
    const resetMeta = this.getRuntimeSetting<{ resetAt?: number }>(
      `session_reset_at:${canonicalUserId}`,
    );
    const conditions: SQL[] = [
      eq(rawMessages.canonicalUserId, canonicalUserId),
      eq(rawMessages.role, "user"),
    ];
    if (typeof resetMeta?.resetAt === "number") {
      conditions.push(gt(rawMessages.createdAt, resetMeta.resetAt));
    }

    const row = this.db
      .select()
      .from(rawMessages)
      .where(and(...conditions))
      .orderBy(desc(rawMessages.createdAt))
      .limit(1)
      .get();
    return row ? toRawMessageRecord(row) : null;
  }

  getLastAnyMessage(canonicalUserId: string): RawMessageRecord | null {
    const row = this.db
      .select()
      .from(rawMessages)
      .where(eq(rawMessages.canonicalUserId, canonicalUserId))
      .orderBy(desc(rawMessages.createdAt))
      .limit(1)
      .get();
    return row ? toRawMessageRecord(row) : null;
  }

  saveDraftCompaction(params: {
    canonicalUserId: string;
    draftSummary: string;
    draftUntilMsgId: string;
    draftUntilTs: number;
  }): void {
    this.getWorkingMemory(params.canonicalUserId);
    this.db
      .update(workingMemoryBlocks)
      .set({
        draftSummary: params.draftSummary,
        draftUntilMsgId: params.draftUntilMsgId,
        draftUntilTs: params.draftUntilTs,
        updatedAt: Date.now(),
      })
      .where(eq(workingMemoryBlocks.canonicalUserId, params.canonicalUserId))
      .run();
  }

  invalidateDraftCompaction(canonicalUserId: string): void {
    this.db
      .update(workingMemoryBlocks)
      .set({
        draftSummary: null,
        draftUntilMsgId: null,
        draftUntilTs: null,
        updatedAt: Date.now(),
      })
      .where(eq(workingMemoryBlocks.canonicalUserId, canonicalUserId))
      .run();
  }

  commitCompaction(params: {
    canonicalUserId: string;
    summaryText: string;
    compactedUntilMsgId: string;
    compactedUntilTs: number;
  }): void {
    this.getWorkingMemory(params.canonicalUserId);
    this.db
      .update(workingMemoryBlocks)
      .set({
        summaryText: params.summaryText,
        compactedUntilMsgId: params.compactedUntilMsgId,
        compactedUntilTs: params.compactedUntilTs,
        draftSummary: null,
        draftUntilMsgId: null,
        draftUntilTs: null,
        updatedAt: Date.now(),
      })
      .where(eq(workingMemoryBlocks.canonicalUserId, params.canonicalUserId))
      .run();
  }

  getSessionResetAt(canonicalUserId: string): number | null {
    const resetMeta = this.getRuntimeSetting<{ resetAt?: number }>(
      `session_reset_at:${canonicalUserId}`,
    );
    return typeof resetMeta?.resetAt === "number" ? resetMeta.resetAt : null;
  }

  /**
   * Clear current working context (/new): archives the finished segment as a read-only
   * session for history lookup, clears rolling summary and drafts, and advances
   * compactedUntilTs past existing messages while preserving audit history.
   */
  resetWorkingContext(
    canonicalUserId: string,
    resetAtMs = Date.now(),
  ): { clearedHotMessages: number; hadSummary: boolean; archivedSessionId: string | null } {
    const state = this.getWorkingMemory(canonicalUserId);
    const hot = this.getHotMessages(canonicalUserId, state.compactedUntilTs);
    const prevResetAt = this.getSessionResetAt(canonicalUserId) ?? 0;
    const lastAny = this.getLastAnyMessage(canonicalUserId);
    const lastTrace = this.getLatestTurnTrace(canonicalUserId);
    const cutoffTs = Math.max(
      resetAtMs,
      lastAny?.createdAt ?? 0,
      lastTrace?.createdAt ?? 0,
      state.compactedUntilTs,
    );

    const sessionMsgs = this.db
      .select()
      .from(rawMessages)
      .where(
        and(
          eq(rawMessages.canonicalUserId, canonicalUserId),
          gt(rawMessages.createdAt, prevResetAt),
          lte(rawMessages.createdAt, cutoffTs),
        ),
      )
      .orderBy(asc(rawMessages.createdAt), asc(rawMessages.id))
      .all();

    const sessionTraces = this.db
      .select()
      .from(turnTraces)
      .where(
        and(
          eq(turnTraces.canonicalUserId, canonicalUserId),
          gt(turnTraces.createdAt, prevResetAt),
          lte(turnTraces.createdAt, cutoffTs),
        ),
      )
      .orderBy(asc(turnTraces.createdAt))
      .all();

    let archivedSessionId: string | null = null;
    if (sessionMsgs.length > 0 || sessionTraces.length > 0 || state.summaryText.trim().length > 0) {
      const firstUserMsg = sessionMsgs.find((m) => m.role === "user" && m.content.trim());
      const rawTitle =
        firstUserMsg?.content ??
        sessionTraces.find((t) => t.userPreview)?.userPreview ??
        state.summaryText ??
        "历史会话";
      const normalizedTitle = rawTitle.replace(/\s+/g, " ").trim().slice(0, 36) || "历史会话";
      const minMsgTs = sessionMsgs[0]?.createdAt ?? Infinity;
      const minTraceTs = sessionTraces[0]?.createdAt ?? Infinity;
      const startedAt = Number.isFinite(Math.min(minMsgTs, minTraceTs))
        ? Math.min(minMsgTs, minTraceTs)
        : cutoffTs;

      archivedSessionId = `sess_${cutoffTs}_${randomUUID().slice(0, 6)}`;
      this.db
        .insert(chatSessions)
        .values({
          id: archivedSessionId,
          canonicalUserId,
          title: normalizedTitle,
          summaryText: state.summaryText.trim(),
          startedAt,
          endedAt: cutoffTs,
          messageCount: sessionMsgs.length,
          traceCount: sessionTraces.length,
          createdAt: Date.now(),
        })
        .run();
    }

    this.db
      .update(workingMemoryBlocks)
      .set({
        summaryText: "",
        compactedUntilMsgId: lastAny?.id ?? state.compactedUntilMsgId,
        compactedUntilTs: cutoffTs,
        draftSummary: null,
        draftUntilMsgId: null,
        draftUntilTs: null,
        updatedAt: Date.now(),
      })
      .where(eq(workingMemoryBlocks.canonicalUserId, canonicalUserId))
      .run();

    this.setRuntimeSetting(`session_reset_at:${canonicalUserId}`, { resetAt: cutoffTs });

    return {
      clearedHotMessages: hot.length,
      hadSummary: state.summaryText.trim().length > 0,
      archivedSessionId,
    };
  }

  listChatSessions(canonicalUserId: string, limit = 40): ChatSessionRecord[] {
    return this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.canonicalUserId, canonicalUserId))
      .orderBy(desc(chatSessions.endedAt), desc(chatSessions.createdAt))
      .limit(limit)
      .all();
  }

  getChatSession(sessionId: string): ChatSessionRecord | null {
    return (
      this.db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get() ?? null
    );
  }

  getSessionMessages(
    canonicalUserId: string,
    sessionId: string,
  ): { session: ChatSessionRecord; messages: RawMessageRecord[] } | null {
    const session = this.getChatSession(sessionId);
    if (!session || session.canonicalUserId !== canonicalUserId) return null;

    const rows = this.db
      .select()
      .from(rawMessages)
      .where(
        and(
          eq(rawMessages.canonicalUserId, canonicalUserId),
          gte(rawMessages.createdAt, session.startedAt),
          lte(rawMessages.createdAt, session.endedAt),
        ),
      )
      .orderBy(asc(rawMessages.createdAt), asc(rawMessages.id))
      .all();

    return {
      session,
      messages: rows.map(toRawMessageRecord),
    };
  }

  searchPastSessions(
    canonicalUserId: string,
    opts?: { query?: string; sessionId?: string; limit?: number },
  ): {
    sessions: ChatSessionRecord[];
    matches: Array<{
      sessionId: string;
      sessionTitle: string;
      messageId: string;
      role: RawMessageRecord["role"];
      channel: ChannelName;
      content: string;
      createdAt: number;
    }>;
  } {
    const limit = Math.min(30, Math.max(1, opts?.limit ?? 10));
    const sessions = this.listChatSessions(canonicalUserId, 50);
    if (sessions.length === 0) {
      return { sessions: [], matches: [] };
    }

    const q = opts?.query?.trim().toLowerCase() ?? "";

    if (opts?.sessionId?.trim()) {
      const target = this.getSessionMessages(canonicalUserId, opts.sessionId.trim());
      if (!target) {
        return { sessions: [], matches: [] };
      }
      const filteredMsgs = (q
        ? target.messages.filter((m) => m.content.toLowerCase().includes(q))
        : target.messages
      ).slice(0, limit);
      return {
        sessions: [target.session],
        matches: filteredMsgs.map((m) => ({
          sessionId: target.session.id,
          sessionTitle: target.session.title,
          messageId: m.id,
          role: m.role,
          channel: m.channel,
          content: m.content,
          createdAt: m.createdAt,
        })),
      };
    }

    if (!q) {
      return { sessions: sessions.slice(0, limit), matches: [] };
    }

    const matchedSessions = sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) || s.summaryText.toLowerCase().includes(q),
    );
    const maxArchivedEnd = Math.max(...sessions.map((s) => s.endedAt));
    const archivedMsgs = this.db
      .select()
      .from(rawMessages)
      .where(
        and(
          eq(rawMessages.canonicalUserId, canonicalUserId),
          lte(rawMessages.createdAt, maxArchivedEnd),
        ),
      )
      .orderBy(desc(rawMessages.createdAt))
      .all();

    const matches: Array<{
      sessionId: string;
      sessionTitle: string;
      messageId: string;
      role: RawMessageRecord["role"];
      channel: ChannelName;
      content: string;
      createdAt: number;
    }> = [];

    for (const row of archivedMsgs) {
      if (!row.content.toLowerCase().includes(q)) continue;
      const owning = sessions.find(
        (s) => row.createdAt >= s.startedAt && row.createdAt <= s.endedAt,
      );
      if (!owning) continue;
      matches.push({
        sessionId: owning.id,
        sessionTitle: owning.title,
        messageId: row.id,
        role: row.role as RawMessageRecord["role"],
        channel: row.channel as ChannelName,
        content: row.content,
        createdAt: row.createdAt,
      });
      if (matches.length >= limit) break;
    }

    return {
      sessions: matchedSessions.slice(0, limit),
      matches,
    };
  }

  getActiveScheduleOverride(canonicalUserId: string, nowMs = Date.now()) {
    return (
      this.db
        .select()
        .from(scheduleOverrides)
        .where(
          and(
            eq(scheduleOverrides.canonicalUserId, canonicalUserId),
            gt(scheduleOverrides.expiresAt, nowMs),
          ),
        )
        .orderBy(desc(scheduleOverrides.createdAt))
        .limit(1)
        .get() ?? null
    );
  }

  listRelationshipFacts(): Array<{ key: string; value: string }> {
    return this.db
      .select({ key: relationshipFacts.key, value: relationshipFacts.value })
      .from(relationshipFacts)
      .orderBy(asc(relationshipFacts.key))
      .all();
  }

  upsertRelationshipFact(key: string, value: string, sourceMsgId?: string | null): void {
    const cleanKey = key.trim();
    const cleanValue = value.trim();
    if (!cleanKey || !cleanValue) {
      throw new Error("relationship_facts key and value cannot be empty");
    }
    this.db
      .insert(relationshipFacts)
      .values({
        key: cleanKey,
        value: cleanValue,
        sourceMsgId: sourceMsgId ?? null,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: relationshipFacts.key,
        set: {
          value: cleanValue,
          sourceMsgId: sourceMsgId ?? null,
          updatedAt: Date.now(),
        },
      })
      .run();
  }

  deleteRelationshipFact(key: string): boolean {
    const cleanKey = key.trim();
    if (!cleanKey) return false;
    const res = this.db
      .delete(relationshipFacts)
      .where(eq(relationshipFacts.key, cleanKey))
      .run();
    return res.changes > 0;
  }

  listOpenLoops(canonicalUserId: string, limit = 20) {
    return this.db
      .select()
      .from(openLoops)
      .where(eq(openLoops.canonicalUserId, canonicalUserId))
      .orderBy(asc(openLoops.dueAt))
      .limit(limit)
      .all();
  }

  listTickets(canonicalUserId: string, limit = 15) {
    return this.db
      .select()
      .from(tickets)
      .where(eq(tickets.canonicalUserId, canonicalUserId))
      .orderBy(desc(tickets.updatedAt))
      .limit(limit)
      .all();
  }

  listScripts(limit = 20) {
    return this.db
      .select()
      .from(scriptRegistry)
      .orderBy(desc(scriptRegistry.updatedAt))
      .limit(limit)
      .all();
  }

  getRuntimeSetting<T>(key: string): T | null {
    const row = this.db.select().from(runtimeSettings).where(eq(runtimeSettings.key, key)).get();
    if (!row) return null;
    try {
      return JSON.parse(row.valueJson) as T;
    } catch {
      return null;
    }
  }

  setRuntimeSetting(key: string, value: unknown): void {
    this.db
      .insert(runtimeSettings)
      .values({
        key,
        valueJson: JSON.stringify(value),
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: runtimeSettings.key,
        set: {
          valueJson: JSON.stringify(value),
          updatedAt: Date.now(),
        },
      })
      .run();
  }

  deleteRuntimeSetting(key: string): void {
    this.db.delete(runtimeSettings).where(eq(runtimeSettings.key, key)).run();
  }

  setHomeChannel(params: {
    canonicalUserId: string;
    channel: ChannelName;
    targetId: string;
  }): void {
    const now = Date.now();
    this.setRuntimeSetting("home_channel", {
      channel: params.channel,
      targetId: params.targetId,
      updatedAt: now,
    });

    const existing = this.db
      .select()
      .from(owners)
      .where(eq(owners.canonicalUserId, params.canonicalUserId))
      .get();

    if (existing) {
      this.db
        .update(owners)
        .set({
          proactiveChannel: params.channel,
          ...(params.channel === "tg" ? { tgUserId: params.targetId } : { qqOpenId: params.targetId }),
          updatedAt: now,
        })
        .where(eq(owners.canonicalUserId, params.canonicalUserId))
        .run();
    } else {
      this.ensureOwner({
        canonicalUserId: params.canonicalUserId,
        tgUserId: params.channel === "tg" ? params.targetId : null,
        qqOpenId: params.channel === "qq" ? params.targetId : null,
        timezone: "Asia/Shanghai",
        proactiveChannel: params.channel,
      });
    }
  }

  getHomeChannel(): { channel: ChannelName; targetId: string; updatedAt: number } | null {
    return this.getRuntimeSetting<{ channel: ChannelName; targetId: string; updatedAt: number }>(
      "home_channel",
    );
  }

  getOrCreateHomePairingCode(): string {
    const existing = this.getRuntimeSetting<{ code?: string }>("home_pairing_code");
    if (existing?.code && typeof existing.code === "string") {
      return existing.code;
    }
    const code = `HATO-${randomBytes(3).toString("hex").toUpperCase()}`;
    this.setRuntimeSetting("home_pairing_code", { code, createdAt: Date.now() });
    return code;
  }

  verifyAndConsumeHomePairingCode(candidate: string): boolean {
    const stored = this.getRuntimeSetting<{ code?: string }>("home_pairing_code");
    if (!stored?.code || typeof stored.code !== "string") return false;
    const expected = Buffer.from(stored.code.trim().toUpperCase(), "utf8");
    const provided = Buffer.from(candidate.trim().toUpperCase(), "utf8");
    if (expected.length === 0 || expected.length !== provided.length) return false;
    if (!timingSafeEqual(expected, provided)) return false;
    this.deleteRuntimeSetting("home_pairing_code");
    return true;
  }

  insertTurnTrace(trace: {
    canonicalUserId: string;
    slot: string;
    provider: string;
    modelId: string;
    api: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheHitRate?: number;
    ttftMs?: number | null;
    tps?: number | null;
    userPreview?: string | null;
    recalledIds: string[];
    timeCardText: string;
    toolCalls: string[];
    steps?: TraceStepRecord[];
    latencyMs: number;
  }): string {
    const id = `tr_${Date.now()}_${randomUUID().slice(0, 6)}`;
    const computed = computeTurnMetrics({
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      cacheReadTokens: trace.cacheReadTokens,
      cacheWriteTokens: trace.cacheWriteTokens,
      latencyMs: trace.latencyMs,
      ttftMs: trace.ttftMs,
    });
    const cacheHitRate = trace.cacheHitRate ?? computed.cacheHitRate;

    this.db
      .insert(turnTraces)
      .values({
        id,
        canonicalUserId: trace.canonicalUserId,
        slot: trace.slot,
        provider: trace.provider,
        modelId: trace.modelId,
        api: trace.api,
        inputTokens: trace.inputTokens,
        outputTokens: trace.outputTokens,
        cacheReadTokens: trace.cacheReadTokens,
        cacheWriteTokens: trace.cacheWriteTokens,
        cacheHitRate,
        ttftMs: trace.ttftMs ?? null,
        tps: trace.tps ?? null,
        userPreview: trace.userPreview ?? null,
        recalledIdsJson: JSON.stringify(trace.recalledIds),
        timeCardText: trace.timeCardText,
        toolCallsJson: JSON.stringify(trace.toolCalls),
        stepsJson: JSON.stringify(trace.steps ?? []),
        latencyMs: trace.latencyMs,
        createdAt: Date.now(),
      })
      .run();
    return id;
  }

  getLatestTurnTrace(canonicalUserId: string) {
    return (
      this.db
        .select()
        .from(turnTraces)
        .where(eq(turnTraces.canonicalUserId, canonicalUserId))
        .orderBy(desc(turnTraces.createdAt))
        .limit(1)
        .get() ?? null
    );
  }

  listTurnTraces(filter?: {
    canonicalUserId?: string;
    slot?: string;
    provider?: string;
    modelId?: string;
    sinceMs?: number;
    afterMs?: number;
    untilMs?: number;
    limit?: number;
  }) {
    const conditions: SQL[] = [];
    if (filter?.canonicalUserId) {
      conditions.push(eq(turnTraces.canonicalUserId, filter.canonicalUserId));
    }
    if (filter?.slot) {
      conditions.push(eq(turnTraces.slot, filter.slot));
    }
    if (filter?.provider) {
      conditions.push(eq(turnTraces.provider, filter.provider));
    }
    if (filter?.modelId) {
      conditions.push(eq(turnTraces.modelId, filter.modelId));
    }
    if (typeof filter?.sinceMs === "number") {
      conditions.push(gte(turnTraces.createdAt, filter.sinceMs));
    }
    if (typeof filter?.afterMs === "number") {
      conditions.push(gt(turnTraces.createdAt, filter.afterMs));
    }
    if (typeof filter?.untilMs === "number") {
      conditions.push(lte(turnTraces.createdAt, filter.untilMs));
    }

    const base = this.db.select().from(turnTraces);
    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    const ordered = filtered.orderBy(desc(turnTraces.createdAt));

    if (typeof filter?.limit === "number" && filter.limit > 0) {
      return ordered.limit(filter.limit).all();
    }
    return ordered.all();
  }

  /**
   * Fetch raw messages not yet retained by the Memory Curator in chronological order.
   */
  listMessagesPendingRetain(canonicalUserId: string, limit = 100): RawMessageRecord[] {
    const state = this.getWorkingMemory(canonicalUserId);
    let watermarkRow: { createdAt: number; id: string } | undefined;
    if (state.retainedUntilMsgId) {
      watermarkRow = this.db
        .select({ createdAt: rawMessages.createdAt, id: rawMessages.id })
        .from(rawMessages)
        .where(
          and(
            eq(rawMessages.canonicalUserId, canonicalUserId),
            eq(rawMessages.id, state.retainedUntilMsgId),
          ),
        )
        .get();
    }

    const conditions: SQL[] = [eq(rawMessages.canonicalUserId, canonicalUserId)];
    if (watermarkRow) {
      conditions.push(
        or(
          gt(rawMessages.createdAt, watermarkRow.createdAt),
          and(eq(rawMessages.createdAt, watermarkRow.createdAt), gt(rawMessages.id, watermarkRow.id)),
        )!,
      );
    }

    const rows = this.db
      .select()
      .from(rawMessages)
      .where(and(...conditions))
      .orderBy(asc(rawMessages.createdAt), asc(rawMessages.id))
      .limit(Math.max(1, limit))
      .all();

    return rows.map(toRawMessageRecord);
  }

  markRetainedUntil(canonicalUserId: string, msgId: string): void {
    this.getWorkingMemory(canonicalUserId);
    this.db
      .update(workingMemoryBlocks)
      .set({
        retainedUntilMsgId: msgId,
        updatedAt: Date.now(),
      })
      .where(eq(workingMemoryBlocks.canonicalUserId, canonicalUserId))
      .run();
  }

  insertMemorySyncRecord(params: {
    canonicalUserId: string;
    provider: string;
    bank: MemorySyncBank;
    vaultId?: string | null;
    sourceMsgIds: string[];
    content: string;
    externalMemoryId?: string | null;
    status: MemorySyncStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): MemorySyncRecordView {
    const now = Date.now();
    const id = `mem_${now}_${randomUUID().slice(0, 8)}`;
    this.db
      .insert(memorySyncRecords)
      .values({
        id,
        canonicalUserId: params.canonicalUserId,
        provider: params.provider,
        bank: params.bank,
        vaultId: params.vaultId ?? null,
        sourceMsgIdsJson: JSON.stringify(params.sourceMsgIds),
        content: params.content,
        externalMemoryId: params.externalMemoryId ?? null,
        status: params.status,
        errorCode: params.errorCode ?? null,
        errorMessage: params.errorMessage ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return {
      id,
      canonicalUserId: params.canonicalUserId,
      provider: params.provider,
      bank: params.bank,
      vaultId: params.vaultId ?? null,
      sourceMsgIds: params.sourceMsgIds,
      content: params.content,
      externalMemoryId: params.externalMemoryId ?? null,
      status: params.status,
      errorCode: params.errorCode ?? null,
      errorMessage: params.errorMessage ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateMemorySyncRecord(
    id: string,
    patch: {
      vaultId?: string | null;
      externalMemoryId?: string | null;
      status: MemorySyncStatus;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): void {
    this.db
      .update(memorySyncRecords)
      .set({
        ...(patch.vaultId !== undefined ? { vaultId: patch.vaultId } : {}),
        ...(patch.externalMemoryId !== undefined ? { externalMemoryId: patch.externalMemoryId } : {}),
        status: patch.status,
        errorCode: patch.errorCode ?? null,
        errorMessage: patch.errorMessage ?? null,
        updatedAt: Date.now(),
      })
      .where(eq(memorySyncRecords.id, id))
      .run();
  }

  listMemorySyncRecords(
    canonicalUserId: string,
    opts?: { bank?: MemorySyncBank; status?: MemorySyncStatus; includeErased?: boolean; limit?: number },
  ): MemorySyncRecordView[] {
    const conditions: SQL[] = [eq(memorySyncRecords.canonicalUserId, canonicalUserId)];
    if (opts?.bank) {
      conditions.push(eq(memorySyncRecords.bank, opts.bank));
    }
    if (opts?.status) {
      conditions.push(eq(memorySyncRecords.status, opts.status));
    } else if (!opts?.includeErased) {
      conditions.push(ne(memorySyncRecords.status, "erased"));
    }

    const rows = this.db
      .select()
      .from(memorySyncRecords)
      .where(and(...conditions))
      .orderBy(desc(memorySyncRecords.createdAt))
      .limit(Math.max(1, Math.min(200, opts?.limit ?? 30)))
      .all();

    return rows.map(toMemorySyncRecordView);
  }

  listRetryableMemorySyncRecords(
    canonicalUserId: string,
    opts?: { includeDenied?: boolean; limit?: number },
  ): MemorySyncRecordView[] {
    const statuses: MemorySyncStatus[] = opts?.includeDenied
      ? ["degraded", "error", "denied"]
      : ["degraded", "error"];
    const rows = this.db
      .select()
      .from(memorySyncRecords)
      .where(
        and(
          eq(memorySyncRecords.canonicalUserId, canonicalUserId),
          inArray(memorySyncRecords.status, statuses),
        ),
      )
      .orderBy(asc(memorySyncRecords.createdAt))
      .limit(Math.max(1, Math.min(100, opts?.limit ?? 40)))
      .all();

    return rows.map(toMemorySyncRecordView);
  }

  searchMemorySyncRecords(
    canonicalUserId: string,
    query: string,
    limit = 30,
  ): MemorySyncRecordView[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const rows = this.db
      .select()
      .from(memorySyncRecords)
      .where(
        and(
          eq(memorySyncRecords.canonicalUserId, canonicalUserId),
          ne(memorySyncRecords.status, "erased"),
        ),
      )
      .orderBy(desc(memorySyncRecords.createdAt))
      .limit(500)
      .all();

    const matched: MemorySyncRecordView[] = [];
    for (const row of rows) {
      const view = toMemorySyncRecordView(row);
      const hitContent = view.content.toLowerCase().includes(needle);
      const hitExtId = (view.externalMemoryId ?? "").toLowerCase().includes(needle);
      const hitSrcId = view.sourceMsgIds.some((id) => id.toLowerCase().includes(needle));
      if (hitContent || hitExtId || hitSrcId) {
        matched.push(view);
        if (matched.length >= limit) break;
      }
    }
    return matched;
  }

  markMemoryRecordsErased(ids: string[]): void {
    if (ids.length === 0) return;
    this.db
      .update(memorySyncRecords)
      .set({
        status: "erased",
        errorCode: null,
        errorMessage: null,
        updatedAt: Date.now(),
      })
      .where(inArray(memorySyncRecords.id, ids))
      .run();
  }

  getMemorySyncStats(canonicalUserId: string): MemorySyncStats {
    const rows = this.db
      .select({ status: memorySyncRecords.status })
      .from(memorySyncRecords)
      .where(eq(memorySyncRecords.canonicalUserId, canonicalUserId))
      .all();

    const stats: MemorySyncStats = {
      total: rows.length,
      synced: 0,
      degraded: 0,
      denied: 0,
      error: 0,
      erased: 0,
      pendingRawMessages: this.listMessagesPendingRetain(canonicalUserId, 500).length,
    };

    for (const row of rows) {
      if (row.status === "synced") stats.synced++;
      else if (row.status === "degraded") stats.degraded++;
      else if (row.status === "denied") stats.denied++;
      else if (row.status === "error") stats.error++;
      else if (row.status === "erased") stats.erased++;
    }
    return stats;
  }
}

function toMemorySyncRecordView(row: typeof memorySyncRecords.$inferSelect): MemorySyncRecordView {
  let sourceMsgIds: string[] = [];
  try {
    const parsed = JSON.parse(row.sourceMsgIdsJson);
    if (Array.isArray(parsed)) sourceMsgIds = parsed.map(String);
  } catch {
    sourceMsgIds = [];
  }
  return {
    id: row.id,
    canonicalUserId: row.canonicalUserId,
    provider: row.provider,
    bank: row.bank as MemorySyncBank,
    vaultId: row.vaultId,
    sourceMsgIds,
    content: row.content,
    externalMemoryId: row.externalMemoryId,
    status: row.status as MemorySyncStatus,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRawMessageRecord(row: typeof rawMessages.$inferSelect): RawMessageRecord {
  let attachments: InboundAttachment[] = [];
  try {
    attachments = JSON.parse(row.attachmentsJson) as InboundAttachment[];
  } catch {
    attachments = [];
  }
  return {
    id: row.id,
    canonicalUserId: row.canonicalUserId,
    channel: row.channel as ChannelName,
    platformMsgId: row.platformMsgId,
    replyToId: row.replyToId,
    role: row.role as RawMessageRecord["role"],
    content: row.content,
    attachments,
    createdAt: row.createdAt,
  };
}
