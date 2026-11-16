import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, gte, type SQL } from "drizzle-orm";
import type { HatoDb } from "./client.js";
import { computeTurnMetrics } from "../stats/metrics.js";
import {
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

  /**
   * Clear current working context (/new): clears rolling summary and drafts and
   * advances compactedUntilTs past existing messages while preserving audit history.
   */
  resetWorkingContext(
    canonicalUserId: string,
    resetAtMs = Date.now(),
  ): { clearedHotMessages: number; hadSummary: boolean } {
    const state = this.getWorkingMemory(canonicalUserId);
    const hot = this.getHotMessages(canonicalUserId, state.compactedUntilTs);
    const lastAny = this.getLastAnyMessage(canonicalUserId);
    const cutoffTs = Math.max(resetAtMs, lastAny?.createdAt ?? 0, state.compactedUntilTs);

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

    const base = this.db.select().from(turnTraces);
    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    const ordered = filtered.orderBy(desc(turnTraces.createdAt));

    if (typeof filter?.limit === "number" && filter.limit > 0) {
      return ordered.limit(filter.limit).all();
    }
    return ordered.all();
  }
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
