import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerResult } from "../dispatch/schema.js";
import type { ChannelName, InboundBatch } from "../gateway/types.js";

export type BusEvent =
  | { type: "user_batch"; batch: InboundBatch }
  | {
      type: "executed_event";
      canonicalUserId: string;
      channel: ChannelName;
      summary: string;
      occurredAtMs: number;
      silent?: boolean;
    }
  | {
      type: "open_loop_due";
      canonicalUserId: string;
      loopId: string;
      content: string;
      notifyChannel: ChannelName;
    }
  | {
      type: "job_failed";
      canonicalUserId: string;
      scriptId: string;
      scriptName: string;
      errorSummary: string;
      notifyChannel: ChannelName;
    }
  | {
      type: "ticket_result";
      canonicalUserId: string;
      originChannel: ChannelName;
      briefTitle: string;
      result: WorkerResult;
    }
  | {
      type: "ticket_needs_input";
      canonicalUserId: string;
      originChannel: ChannelName;
      ticketId: string;
      briefTitle: string;
      question: string;
    }
  | {
      type: "ticket_confirm_required";
      canonicalUserId: string;
      originChannel: ChannelName;
      ticketId: string;
      briefTitle: string;
      promptText: string;
    };

export type BusListener<K extends BusEvent["type"] = BusEvent["type"]> = (
  event: Extract<BusEvent, { type: K }>,
) => void | Promise<void>;

/**
 * Serializes asynchronous operations per canonicalUserId so concurrent user turns
 * and background events never interleave or corrupt agent state.
 */
export class ActorLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly als = new AsyncLocalStorage<ReadonlySet<string>>();

  run<T>(actorKey: string, task: () => Promise<T>): Promise<T> {
    const held = this.als.getStore();
    if (held?.has(actorKey)) {
      return task();
    }
    const nextKeys = new Set([...(held ?? []), actorKey]);
    const previous = this.tails.get(actorKey) ?? Promise.resolve();
    const runTask = () => this.als.run(nextKeys, task);
    const next = previous.then(runTask, runTask);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(actorKey, tail);

    // Clean up map entry when this task is still the latest tail.
    void tail.finally(() => {
      if (this.tails.get(actorKey) === tail) {
        this.tails.delete(actorKey);
      }
    });

    return next;
  }

  isBusy(actorKey: string): boolean {
    return this.tails.has(actorKey);
  }
}

export class EventBus {
  private readonly listeners = new Map<BusEvent["type"], Set<(event: BusEvent) => void | Promise<void>>>();

  on<K extends BusEvent["type"]>(type: K, listener: BusListener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const wrapped = listener as (event: BusEvent) => void | Promise<void>;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  async emit(event: BusEvent): Promise<void> {
    const set = this.listeners.get(event.type);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      await listener(event);
    }
  }
}
