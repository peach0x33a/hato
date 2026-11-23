import type { ActorLock } from "../bus/actor-bus.js";
import type { HatoRepository, RawMessageRecord } from "../db/repo.js";
import { formatLocalDateTime, parseLocalDateTimeToEpochMs } from "../time/clock.js";
import { logError, logInfo } from "../utils/logger.js";

export type HotZoneClearMode = "cache" | "scheduled";

export interface CompactionConfig {
  hotMessagesHighWatermark: number;
  hotMessagesKeepAfterCompact: number;
  minMessagesToCompact: number;
  preCompactAfterMinutes: number;
  idleCommitAfterMinutes: number;
  clearMode?: HotZoneClearMode;
  scheduledClearTime?: string;
  scheduledDeferMinutes?: number;
  timezone?: string;
}

export interface CompactionHooks {
  /** Summarize messages up to cutoff using the curator slot for rolling context compaction. */
  summarizeBlock(params: {
    canonicalUserId: string;
    previousSummary: string;
    messagesToSummarize: RawMessageRecord[];
  }): Promise<string>;
  /** Ensure messages leaving the hot zone have been retained in long-term memory (Phase 4). */
  ensureRetained?(canonicalUserId: string, messages: RawMessageRecord[]): Promise<void>;
  /** Retain pending memories and archive/clear the entire hot zone (used in scheduled mode). */
  clearHotZoneAndArchive?(canonicalUserId: string): Promise<boolean>;
  /** List known user IDs that may have un-cleared working memory at scheduled clear time. */
  listActiveUserIds?(): string[];
}

interface IdleTimers {
  preTimer?: NodeJS.Timeout;
  commitTimer?: NodeJS.Timeout;
}

/**
 * Compute the next UTC epoch ms matching `HH:MM` in `timeZone` strictly after `nowMs`.
 */
export function computeNextScheduledClearMs(
  nowMs: number,
  scheduledClearTime: string,
  timeZone: string,
): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(scheduledClearTime.trim());
  const hh = (m?.[1] ?? "01").padStart(2, "0");
  const mm = m?.[2] ?? "00";

  const nowParts = formatLocalDateTime(nowMs, timeZone);
  const todayTarget =
    parseLocalDateTimeToEpochMs(`${nowParts.isoDate} ${hh}:${mm}:00`, timeZone) ??
    nowMs + 24 * 3600_000;
  if (todayTarget > nowMs) {
    return todayTarget;
  }

  const nextDayParts = formatLocalDateTime(todayTarget + 26 * 3600_000, timeZone);
  return (
    parseLocalDateTimeToEpochMs(`${nextDayParts.isoDate} ${hh}:${mm}:00`, timeZone) ??
    todayTarget + 24 * 3600_000
  );
}

/**
 * Coordinates hot-zone compaction & clearing:
 * - `cache` mode: two-stage idle compaction (pre-summarize while cache is warm, commit after inactivity)
 * - `scheduled` mode: daily scheduled clear & memory archive, deferring when user is actively chatting
 * plus high-watermark safety compaction in both modes.
 */
export class CompactionManager {
  private readonly timers = new Map<string, IdleTimers>();
  private readonly lastInteractionAt = new Map<string, number>();
  private readonly scheduledDeferTimers = new Map<string, NodeJS.Timeout>();
  private dailyScheduleTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private config: CompactionConfig,
    private readonly repo: HatoRepository,
    private readonly actorLock: ActorLock,
    private readonly hooks: CompactionHooks,
  ) {
    this.syncScheduleMode();
  }

  updateConfig(next: CompactionConfig): void {
    this.config = next;
    this.syncScheduleMode();
  }

  /**
   * Reset idle compaction timers (or extend scheduled-mode chat deferral) after interaction.
   */
  recordInteraction(canonicalUserId: string, nowMs = Date.now()): void {
    this.lastInteractionAt.set(canonicalUserId, nowMs);

    if ((this.config.clearMode ?? "cache") === "scheduled") {
      if (this.scheduledDeferTimers.has(canonicalUserId)) {
        const deferMs = Math.max(1, this.config.scheduledDeferMinutes ?? 30) * 60_000;
        this.scheduleDeferredClear(canonicalUserId, deferMs);
      }
      return;
    }

    this.clearUserTimers(canonicalUserId);
    this.repo.invalidateDraftCompaction(canonicalUserId);

    const preMs = Math.max(1, this.config.preCompactAfterMinutes) * 60_000;
    const commitMs = Math.max(preMs, this.config.idleCommitAfterMinutes * 60_000);

    const preTimer = setTimeout(() => {
      void this.runPreCompactDraft(canonicalUserId).catch((err) => {
        logError("COMPACTION", `pre-compact draft failed for ${canonicalUserId}`, err);
      });
    }, preMs);
    preTimer.unref();

    const commitTimer = setTimeout(() => {
      void this.runIdleCommit(canonicalUserId).catch((err) => {
        logError("COMPACTION", `idle commit failed for ${canonicalUserId}`, err);
      });
    }, commitMs);
    commitTimer.unref();

    this.timers.set(canonicalUserId, { preTimer, commitTimer });
  }

  /**
   * Stage 1: While prompt cache is still warm, generate a draft summary without
   * mutating the live hot prefix.
   */
  async runPreCompactDraft(canonicalUserId: string): Promise<boolean> {
    return this.actorLock.run(canonicalUserId, async () => {
      const state = this.repo.getWorkingMemory(canonicalUserId);
      const hot = this.repo.getHotMessages(canonicalUserId, state.compactedUntilTs);
      if (hot.length < this.config.minMessagesToCompact) return false;

      const keepCount = Math.min(this.config.hotMessagesKeepAfterCompact, Math.max(1, hot.length - 1));
      const sliceToCompact = hot.slice(0, hot.length - keepCount);
      if (sliceToCompact.length === 0) return false;

      const lastCompactMsg = sliceToCompact[sliceToCompact.length - 1]!;
      if (state.draftUntilMsgId === lastCompactMsg.id && state.draftSummary) {
        return false;
      }

      const draftSummary = await this.hooks.summarizeBlock({
        canonicalUserId,
        previousSummary: state.summaryText,
        messagesToSummarize: sliceToCompact,
      });

      this.repo.saveDraftCompaction({
        canonicalUserId,
        draftSummary,
        draftUntilMsgId: lastCompactMsg.id,
        draftUntilTs: lastCompactMsg.createdAt,
      });
      return true;
    });
  }

  /**
   * Stage 2: After extended inactivity, promote the cached draft (or generate once)
   * after guaranteeing retain completion.
   */
  async runIdleCommit(canonicalUserId: string): Promise<boolean> {
    return this.commitSlice(canonicalUserId, this.config.minMessagesToCompact);
  }

  /**
   * Active-chat safety valve: compact in chunks once hot messages reach high watermark.
   */
  async checkHighWatermark(canonicalUserId: string): Promise<boolean> {
    return this.commitSlice(canonicalUserId, this.config.hotMessagesHighWatermark);
  }

  /**
   * Run a scheduled daily clear sweep across all known users.
   * Users who chatted within `scheduledDeferMinutes` are deferred until their quiet window elapses.
   */
  async runScheduledSweep(nowMs = Date.now()): Promise<number> {
    const userIds = new Set<string>(this.lastInteractionAt.keys());
    for (const uid of this.hooks.listActiveUserIds?.() ?? []) {
      if (uid) userIds.add(uid);
    }

    let clearedCount = 0;
    for (const uid of userIds) {
      try {
        const cleared = await this.evaluateScheduledClearForUser(uid, nowMs);
        if (cleared) clearedCount += 1;
      } catch (err) {
        logError("COMPACTION", `scheduled hot-zone clear failed for ${uid}`, err);
      }
    }
    return clearedCount;
  }

  /**
   * Evaluate whether a single user's hot zone should be cleared now or deferred due to active chat.
   */
  async evaluateScheduledClearForUser(
    canonicalUserId: string,
    nowMs = Date.now(),
  ): Promise<boolean> {
    const state = this.repo.getWorkingMemory(canonicalUserId);
    const hot = this.repo.getHotMessages(canonicalUserId, state.compactedUntilTs);
    if (hot.length === 0 && !state.summaryText.trim()) {
      this.clearDeferredClear(canonicalUserId);
      return false;
    }

    const lastAt =
      this.lastInteractionAt.get(canonicalUserId) ??
      this.repo.getLastAnyMessage(canonicalUserId)?.createdAt ??
      0;
    const deferMs = Math.max(1, this.config.scheduledDeferMinutes ?? 30) * 60_000;
    const elapsed = nowMs - lastAt;

    if (lastAt > 0 && elapsed < deferMs) {
      this.scheduleDeferredClear(canonicalUserId, Math.max(1_000, deferMs - elapsed));
      return false;
    }

    this.clearDeferredClear(canonicalUserId);
    if (this.hooks.clearHotZoneAndArchive) {
      const ok = await this.hooks.clearHotZoneAndArchive(canonicalUserId);
      if (ok) {
        logInfo("COMPACTION", `scheduled clear & archive completed for ${canonicalUserId}`);
      }
      return ok;
    }

    return this.commitSlice(canonicalUserId, 1);
  }

  dispose(): void {
    this.disposed = true;
    if (this.dailyScheduleTimer) {
      clearTimeout(this.dailyScheduleTimer);
      this.dailyScheduleTimer = undefined;
    }
    for (const key of [...this.timers.keys()]) {
      this.clearUserTimers(key);
    }
    for (const key of [...this.scheduledDeferTimers.keys()]) {
      this.clearDeferredClear(key);
    }
  }

  /**
   * Cancel pending idle compaction & scheduled defer timers for a user (used by /new session reset).
   */
  resetUser(canonicalUserId: string): void {
    this.clearUserTimers(canonicalUserId);
    this.clearDeferredClear(canonicalUserId);
  }

  private syncScheduleMode(): void {
    if (this.dailyScheduleTimer) {
      clearTimeout(this.dailyScheduleTimer);
      this.dailyScheduleTimer = undefined;
    }

    if ((this.config.clearMode ?? "cache") === "scheduled") {
      for (const key of [...this.timers.keys()]) {
        this.clearUserTimers(key);
      }
      this.scheduleNextDailyClear();
    } else {
      for (const key of [...this.scheduledDeferTimers.keys()]) {
        this.clearDeferredClear(key);
      }
    }
  }

  private scheduleNextDailyClear(nowMs = Date.now()): void {
    if (this.disposed) return;
    if ((this.config.clearMode ?? "cache") !== "scheduled") return;
    if (this.dailyScheduleTimer) {
      clearTimeout(this.dailyScheduleTimer);
      this.dailyScheduleTimer = undefined;
    }

    const clearTime = this.config.scheduledClearTime ?? "01:00";
    const timeZone = this.config.timezone ?? "Asia/Shanghai";
    const nextMs = computeNextScheduledClearMs(nowMs, clearTime, timeZone);
    const delayMs = Math.max(1_000, nextMs - nowMs);

    this.dailyScheduleTimer = setTimeout(() => {
      this.dailyScheduleTimer = undefined;
      void this.runScheduledSweep()
        .catch((err) => {
          logError("COMPACTION", "daily scheduled hot-zone sweep failed", err);
        })
        .finally(() => {
          this.scheduleNextDailyClear();
        });
    }, delayMs);
    this.dailyScheduleTimer.unref();
  }

  private scheduleDeferredClear(canonicalUserId: string, delayMs: number): void {
    this.clearDeferredClear(canonicalUserId);
    const timer = setTimeout(() => {
      this.scheduledDeferTimers.delete(canonicalUserId);
      void this.evaluateScheduledClearForUser(canonicalUserId).catch((err) => {
        logError("COMPACTION", `deferred scheduled clear failed for ${canonicalUserId}`, err);
      });
    }, Math.max(1_000, delayMs));
    timer.unref();
    this.scheduledDeferTimers.set(canonicalUserId, timer);
  }

  private clearDeferredClear(canonicalUserId: string): void {
    const existing = this.scheduledDeferTimers.get(canonicalUserId);
    if (!existing) return;
    clearTimeout(existing);
    this.scheduledDeferTimers.delete(canonicalUserId);
  }

  private async commitSlice(canonicalUserId: string, minTriggerLength: number): Promise<boolean> {
    return this.actorLock.run(canonicalUserId, async () => {
      const state = this.repo.getWorkingMemory(canonicalUserId);
      const hot = this.repo.getHotMessages(canonicalUserId, state.compactedUntilTs);
      if (hot.length < minTriggerLength) return false;

      const keepCount = Math.min(this.config.hotMessagesKeepAfterCompact, Math.max(1, hot.length - 1));
      const sliceToCompact = hot.slice(0, hot.length - keepCount);
      if (sliceToCompact.length === 0) return false;

      const lastCompactMsg = sliceToCompact[sliceToCompact.length - 1]!;
      if (this.hooks.ensureRetained) {
        await this.hooks.ensureRetained(canonicalUserId, sliceToCompact);
      }

      let summaryText: string;
      if (state.draftSummary && state.draftUntilMsgId === lastCompactMsg.id) {
        summaryText = state.draftSummary;
      } else {
        summaryText = await this.hooks.summarizeBlock({
          canonicalUserId,
          previousSummary: state.summaryText,
          messagesToSummarize: sliceToCompact,
        });
      }

      this.repo.commitCompaction({
        canonicalUserId,
        summaryText,
        compactedUntilMsgId: lastCompactMsg.id,
        compactedUntilTs: lastCompactMsg.createdAt,
      });
      return true;
    });
  }

  private clearUserTimers(canonicalUserId: string): void {
    const existing = this.timers.get(canonicalUserId);
    if (!existing) return;
    if (existing.preTimer) clearTimeout(existing.preTimer);
    if (existing.commitTimer) clearTimeout(existing.commitTimer);
    this.timers.delete(canonicalUserId);
  }
}
