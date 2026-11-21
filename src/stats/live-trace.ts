import type { TraceStepRecord } from "./metrics.js";

export interface LiveTraceSnapshot {
  id: string;
  canonicalUserId: string;
  slot: string;
  provider: string;
  modelId: string;
  api: string;
  userPreview: string | null;
  startedAt: number;
  updatedAt: number;
  status: "running";
  toolCalls: string[];
  steps: TraceStepRecord[];
  progressNote?: string;
}

export type LiveTraceEvent =
  | { type: "active_update"; active: LiveTraceSnapshot[] }
  | { type: "trace_inserted"; traceId: string; slot: string; createdAt: number };

/**
 * Tracks in-flight Persona/Worker/Router turns in memory so the Web Console
 * Trajectory panel can display running executions and live step progress via SSE.
 */
export class LiveTraceTracker {
  private readonly active = new Map<string, LiveTraceSnapshot>();
  private readonly listeners = new Set<(event: LiveTraceEvent) => void>();

  start(
    entry: Omit<LiveTraceSnapshot, "updatedAt" | "status" | "toolCalls" | "steps"> & {
      toolCalls?: string[];
      steps?: TraceStepRecord[];
    },
  ): void {
    const now = Date.now();
    this.active.set(entry.id, {
      id: entry.id,
      canonicalUserId: entry.canonicalUserId,
      slot: entry.slot,
      provider: entry.provider,
      modelId: entry.modelId,
      api: entry.api,
      userPreview: entry.userPreview,
      startedAt: entry.startedAt,
      updatedAt: now,
      status: "running",
      toolCalls: [...(entry.toolCalls ?? [])],
      steps: [...(entry.steps ?? [])],
      ...(entry.progressNote !== undefined ? { progressNote: entry.progressNote } : {}),
    });
    this.emitActiveUpdate();
  }

  update(
    id: string,
    patch: { progressNote?: string; steps?: TraceStepRecord[]; toolCalls?: string[] },
  ): void {
    const cur = this.active.get(id);
    if (!cur) return;
    this.active.set(id, {
      ...cur,
      updatedAt: Date.now(),
      ...(patch.progressNote !== undefined ? { progressNote: patch.progressNote } : {}),
      ...(patch.steps !== undefined ? { steps: [...patch.steps] } : {}),
      ...(patch.toolCalls !== undefined ? { toolCalls: [...patch.toolCalls] } : {}),
    });
    this.emitActiveUpdate();
  }

  finish(id: string): void {
    if (!this.active.delete(id)) return;
    this.emitActiveUpdate();
  }

  listActive(canonicalUserId?: string): LiveTraceSnapshot[] {
    const list = [...this.active.values()];
    const filtered = canonicalUserId
      ? list.filter((item) => item.canonicalUserId === canonicalUserId)
      : list;
    return filtered.sort((a, b) => b.startedAt - a.startedAt).map((item) => ({ ...item }));
  }

  subscribe(listener: (event: LiveTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyTraceInserted(info: { traceId: string; slot: string; createdAt: number }): void {
    this.emit({
      type: "trace_inserted",
      traceId: info.traceId,
      slot: info.slot,
      createdAt: info.createdAt,
    });
  }

  private emitActiveUpdate(): void {
    this.emit({
      type: "active_update",
      active: this.listActive(),
    });
  }

  private emit(event: LiveTraceEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Ignore broken SSE listeners
      }
    }
  }
}
