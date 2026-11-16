import type { ActorLock } from "../bus/actor-bus.js";
import type { HatoRepository, RawMessageRecord } from "../db/repo.js";
import { logError } from "../utils/logger.js";

export interface CompactionConfig {
  hotMessagesHighWatermark: number;
  hotMessagesKeepAfterCompact: number;
  minMessagesToCompact: number;
  preCompactAfterMinutes: number;
  idleCommitAfterMinutes: number;
}

export interface CompactionHooks {
  /** Summarize messages up to cutoff using the same persona prefix for cache reuse. */
  summarizeBlock(params: {
    canonicalUserId: string;
    previousSummary: string;
    messagesToSummarize: RawMessageRecord[];
  }): Promise<string>;
  /** Ensure messages leaving the hot zone have been retained in long-term memory (Phase 4). */
  ensureRetained?(canonicalUserId: string, messages: RawMessageRecord[]): Promise<void>;
}

interface IdleTimers {
  preTimer?: NodeJS.Timeout;
  commitTimer?: NodeJS.Timeout;
}

/**
 * Coordinates two-stage idle context compaction (pre-summarize while cache is warm,
 * commit after extended inactivity) plus high-watermark safety compaction.
 */
export class CompactionManager {
  private readonly timers = new Map<string, IdleTimers>();

  constructor(
    private config: CompactionConfig,
    private readonly repo: HatoRepository,
    private readonly actorLock: ActorLock,
    private readonly hooks: CompactionHooks,
  ) {}

  updateConfig(next: CompactionConfig): void {
    this.config = next;
  }

  /**
   * Reset idle compaction timers after user/assistant interaction.
   */
  recordInteraction(canonicalUserId: string): void {
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

  dispose(): void {
    for (const key of [...this.timers.keys()]) {
      this.clearUserTimers(key);
    }
  }

  /**
   * Cancel pending idle compaction timers for a user (used by /new session reset).
   */
  resetUser(canonicalUserId: string): void {
    this.clearUserTimers(canonicalUserId);
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
