import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type WorkerActivityKind =
  | "lifecycle"
  | "command"
  | "tool"
  | "assistant"
  | "stderr"
  | "error";

export type WorkerActivityState = "running" | "done" | "error";

export interface WorkerActivityItem {
  id: string;
  stepKey?: string;
  ticketId: string;
  seq: number;
  timestamp: number;
  updatedAt: number;
  kind: WorkerActivityKind;
  state: WorkerActivityState;
  title: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  durationMs?: number;
  text?: string;
}

export interface WorkerActivityPatch {
  stepKey?: string;
  kind: WorkerActivityKind;
  state?: WorkerActivityState;
  title?: string;
  command?: string;
  output?: string;
  appendOutput?: string;
  exitCode?: number | null;
  durationMs?: number;
  text?: string;
  appendText?: string;
}

export interface WorkerTicketMetaUpdate {
  id: string;
  status: string;
  backend: string;
  briefTitle: string;
  originChannel: string;
  progressNote: string | null;
  workspaceDir?: string;
  createdAt: number;
  updatedAt: number;
}

export type WorkerActivityStreamEvent =
  | { type: "item"; ticketId: string; item: WorkerActivityItem }
  | { type: "ticket"; ticketId: string; ticket: WorkerTicketMetaUpdate };

const MAX_CACHED_TICKETS = 40;
const MAX_ITEMS_PER_TICKET = 250;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_TEXT_CHARS = 12_000;

function capStreamText(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw;
  const headChars = Math.floor(maxChars * 0.25);
  const tailChars = maxChars - headChars - 48;
  return `${raw.slice(0, headChars)}\n... [已省略中间 ${raw.length - headChars - tailChars} 字符] ...\n${raw.slice(-tailChars)}`;
}

function sanitizeTicketFileToken(ticketId: string): string {
  return ticketId.trim().replace(/[^A-Za-z0-9._-]+/g, "_") || "ticket";
}

interface TicketActivityBucket {
  seq: number;
  items: WorkerActivityItem[];
  persistDir?: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
}

export class WorkerActivityHub {
  private readonly buckets = new Map<string, TicketActivityBucket>();
  private readonly listeners = new Set<(ev: WorkerActivityStreamEvent) => void>();
  private defaultPersistDir: string | null = null;

  configurePersistDir(dirPath: string): void {
    this.defaultPersistDir = resolve(dirPath);
  }

  private resolvePersistFile(ticketId: string, explicitDir?: string): string | null {
    const dir = explicitDir ?? this.defaultPersistDir;
    if (!dir) return null;
    return join(resolve(dir), `${sanitizeTicketFileToken(ticketId)}.json`);
  }

  private getOrCreateBucket(ticketId: string, persistDir?: string): TicketActivityBucket {
    let bucket = this.buckets.get(ticketId);
    if (bucket) {
      if (persistDir && !bucket.persistDir) {
        bucket.persistDir = resolve(persistDir);
      }
      // Refresh LRU order
      this.buckets.delete(ticketId);
      this.buckets.set(ticketId, bucket);
      return bucket;
    }

    const loaded = this.loadFromDisk(ticketId, persistDir);
    const maxSeq = loaded.reduce((acc, item) => Math.max(acc, item.seq), 0);
    bucket = {
      seq: maxSeq,
      items: loaded,
      persistDir: persistDir ? resolve(persistDir) : undefined,
      flushTimer: null,
      dirty: false,
    };
    this.buckets.set(ticketId, bucket);

    while (this.buckets.size > MAX_CACHED_TICKETS) {
      const oldestKey = this.buckets.keys().next().value;
      if (!oldestKey || oldestKey === ticketId) break;
      const evicted = this.buckets.get(oldestKey);
      if (evicted) {
        this.flushBucketSync(oldestKey, evicted);
      }
      this.buckets.delete(oldestKey);
    }

    return bucket;
  }

  private loadFromDisk(ticketId: string, persistDir?: string): WorkerActivityItem[] {
    const filePath = this.resolvePersistFile(ticketId, persistDir);
    if (!filePath || !existsSync(filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
        items?: WorkerActivityItem[];
      };
      return Array.isArray(parsed.items) ? parsed.items.slice(-MAX_ITEMS_PER_TICKET) : [];
    } catch {
      return [];
    }
  }

  private schedulePersist(ticketId: string, bucket: TicketActivityBucket, immediate = false): void {
    bucket.dirty = true;
    if (immediate) {
      this.flushBucketSync(ticketId, bucket);
      return;
    }
    if (bucket.flushTimer) return;
    bucket.flushTimer = setTimeout(() => {
      bucket.flushTimer = null;
      this.flushBucketSync(ticketId, bucket);
    }, 450);
    bucket.flushTimer.unref();
  }

  private flushBucketSync(ticketId: string, bucket: TicketActivityBucket): void {
    if (bucket.flushTimer) {
      clearTimeout(bucket.flushTimer);
      bucket.flushTimer = null;
    }
    if (!bucket.dirty) return;
    const filePath = this.resolvePersistFile(ticketId, bucket.persistDir);
    if (!filePath) return;
    try {
      mkdirSync(resolve(filePath, ".."), { recursive: true });
      writeFileSync(
        filePath,
        `${JSON.stringify({ ticketId, updatedAt: Date.now(), items: bucket.items })}\n`,
        "utf8",
      );
      bucket.dirty = false;
    } catch {
      // Best-effort snapshot persistence
    }
  }

  upsert(
    ticketId: string,
    patch: WorkerActivityPatch,
    options?: { persistDir?: string; flushImmediate?: boolean },
  ): WorkerActivityItem {
    const now = Date.now();
    const bucket = this.getOrCreateBucket(ticketId, options?.persistDir);

    let existing: WorkerActivityItem | undefined;
    if (patch.stepKey) {
      for (let i = bucket.items.length - 1; i >= 0; i--) {
        if (bucket.items[i]!.stepKey === patch.stepKey) {
          existing = bucket.items[i]!;
          break;
        }
      }
    }

    let target: WorkerActivityItem;
    if (existing) {
      const nextOutput =
        patch.output !== undefined
          ? capStreamText(patch.output, MAX_OUTPUT_CHARS)
          : patch.appendOutput
            ? capStreamText(`${existing.output ?? ""}${patch.appendOutput}`, MAX_OUTPUT_CHARS)
            : existing.output;
      const nextText =
        patch.text !== undefined
          ? capStreamText(patch.text, MAX_TEXT_CHARS)
          : patch.appendText
            ? capStreamText(`${existing.text ?? ""}${patch.appendText}`, MAX_TEXT_CHARS)
            : existing.text;

      existing.updatedAt = now;
      if (patch.state) existing.state = patch.state;
      if (patch.title) existing.title = patch.title;
      if (patch.command !== undefined) existing.command = patch.command;
      if (nextOutput !== undefined) existing.output = nextOutput;
      if (patch.exitCode !== undefined) existing.exitCode = patch.exitCode;
      if (patch.durationMs !== undefined) existing.durationMs = patch.durationMs;
      if (nextText !== undefined) existing.text = nextText;
      target = { ...existing };
    } else {
      bucket.seq += 1;
      const rawOut = patch.output ?? patch.appendOutput;
      const rawTxt = patch.text ?? patch.appendText;
      const created: WorkerActivityItem = {
        id: `${ticketId}_${bucket.seq}`,
        ...(patch.stepKey ? { stepKey: patch.stepKey } : {}),
        ticketId,
        seq: bucket.seq,
        timestamp: now,
        updatedAt: now,
        kind: patch.kind,
        state: patch.state ?? "done",
        title: patch.title ?? "执行步骤",
        ...(patch.command !== undefined ? { command: patch.command } : {}),
        ...(rawOut !== undefined ? { output: capStreamText(rawOut, MAX_OUTPUT_CHARS) } : {}),
        ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
        ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
        ...(rawTxt !== undefined ? { text: capStreamText(rawTxt, MAX_TEXT_CHARS) } : {}),
      };
      bucket.items.push(created);
      if (bucket.items.length > MAX_ITEMS_PER_TICKET) {
        bucket.items.splice(0, bucket.items.length - MAX_ITEMS_PER_TICKET);
      }
      target = { ...created };
    }

    this.schedulePersist(
      ticketId,
      bucket,
      Boolean(options?.flushImmediate || patch.kind === "lifecycle" || patch.kind === "error"),
    );
    this.emit({ type: "item", ticketId, item: target });
    return target;
  }

  emitTicketUpdate(ticket: WorkerTicketMetaUpdate): void {
    this.emit({ type: "ticket", ticketId: ticket.id, ticket });
  }

  flush(ticketId: string): void {
    const bucket = this.buckets.get(ticketId);
    if (bucket) {
      this.flushBucketSync(ticketId, bucket);
    }
  }

  getItems(ticketId: string, persistDir?: string): WorkerActivityItem[] {
    const bucket = this.buckets.get(ticketId);
    if (bucket) {
      return bucket.items.map((item) => ({ ...item }));
    }
    const diskItems = this.loadFromDisk(ticketId, persistDir);
    if (diskItems.length > 0) {
      const maxSeq = diskItems.reduce((acc, item) => Math.max(acc, item.seq), 0);
      this.buckets.set(ticketId, {
        seq: maxSeq,
        items: diskItems,
        persistDir: persistDir ? resolve(persistDir) : undefined,
        flushTimer: null,
        dirty: false,
      });
    }
    return diskItems.map((item) => ({ ...item }));
  }

  subscribe(listener: (ev: WorkerActivityStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(ev: WorkerActivityStreamEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(ev);
      } catch {
        // Ignore disconnected SSE listeners
      }
    }
  }
}

export const workerActivityHub = new WorkerActivityHub();
