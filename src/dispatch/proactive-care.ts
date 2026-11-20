import type { ActorLock } from "../bus/actor-bus.js";
import type { HatoConfig } from "../config/app.js";
import type { HatoRepository } from "../db/repo.js";
import { isWithinQuietHours } from "../time/clock.js";
import { logWarn, summarizeError } from "../utils/logger.js";

export type ProactiveDeliveryOutcome = "sent" | "no_reply" | "no_outbound";

export interface ProactiveCareSchedulerDeps {
  getHatoConfig: () => HatoConfig;
  repo: HatoRepository;
  actorLock: ActorLock;
  deliverOpenLoop: (params: {
    canonicalUserId: string;
    notifyChannel: string;
    loopId: string;
    content: string;
  }) => Promise<ProactiveDeliveryOutcome>;
}

/**
 * Periodically polls due `open_loops` and triggers proactive care messages
 * while respecting quiet hours, post-chat deferrals, and unanswered streak limits.
 */
export class ProactiveCareScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: ProactiveCareSchedulerDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        logWarn("PROACTIVE", `tick failed: ${summarizeError(err)}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(nowMs = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cfg = this.deps.getHatoConfig();
      const dueLoops = this.deps.repo.listDueOpenLoops(nowMs, 10);
      if (dueLoops.length === 0) return;

      const deferMs = Math.max(0, cfg.memory.open_loops.defer_after_chat_minutes) * 60_000;
      const maxStreak = Math.max(1, cfg.memory.open_loops.max_unanswered_streak);
      const retryDelayMs = Math.max(60, cfg.memory.open_loops.defer_after_chat_minutes * 12) * 60_000;
      const snoozeDelayMs = Math.max(30, cfg.memory.open_loops.defer_after_chat_minutes * 6) * 60_000;

      for (const loop of dueLoops) {
        const override = this.deps.repo.getActiveScheduleOverride(loop.canonicalUserId, nowMs);
        const tz = override?.tempTimezone || cfg.owner.timezone;

        if (isWithinQuietHours(nowMs, tz, cfg.owner.quiet_hours.start, cfg.owner.quiet_hours.end)) {
          continue;
        }

        const lastUserTs = this.deps.repo.getLastUserMessageTimestamp(loop.canonicalUserId);
        if (lastUserTs !== null && deferMs > 0 && nowMs - lastUserTs < deferMs) {
          continue;
        }

        if (loop.unansweredStreak >= maxStreak) {
          this.deps.repo.updateOpenLoop(loop.id, { status: "paused" });
          continue;
        }

        await this.deps.actorLock.run(loop.canonicalUserId, async () => {
          const latest = this.deps.repo.getOpenLoop(loop.id);
          if (!latest || latest.status !== "pending" || latest.dueAt > nowMs) {
            return;
          }

          const outcome = await this.deps.deliverOpenLoop({
            canonicalUserId: latest.canonicalUserId,
            notifyChannel: latest.notifyChannel,
            loopId: latest.id,
            content: latest.content,
          });

          if (outcome === "no_outbound") {
            return;
          }

          if (outcome === "no_reply") {
            this.deps.repo.updateOpenLoop(latest.id, {
              dueAt: nowMs + snoozeDelayMs,
            });
            return;
          }

          const nextStreak = latest.unansweredStreak + 1;
          if (nextStreak >= maxStreak) {
            this.deps.repo.updateOpenLoop(latest.id, {
              status: "paused",
              unansweredStreak: nextStreak,
            });
          } else {
            this.deps.repo.updateOpenLoop(latest.id, {
              status: "pending",
              unansweredStreak: nextStreak,
              dueAt: nowMs + retryDelayMs,
            });
          }
        });
      }
    } finally {
      this.running = false;
    }
  }
}
