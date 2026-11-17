import type { WorkerBackend, WorkerMandate, WorkerResult } from "../dispatch/schema.js";

export interface TicketExecutionHandle {
  ticketId: string;
  canonicalUserId: string;
  backend: WorkerBackend;
  briefTitle: string;
  contextId: string;
  externalSessionId: string | null;
}

export interface ExecutionProgressCallback {
  onProgress?: (note: string) => void;
  onSessionId?: (sessionId: string) => void;
}

export interface ExecutionRunner {
  execute(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult>;

  resume(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    userReply: string,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult>;

  abort(ticketId: string): Promise<void>;
}

/**
 * Routes ticket execution and resume requests to `builtin-pi` or `external-cli` runners.
 */
export class WorkerDispatcher {
  constructor(
    private readonly builtinRunner: ExecutionRunner,
    private readonly externalRunner: ExecutionRunner,
  ) {}

  private pickRunner(backend: WorkerBackend): ExecutionRunner {
    return backend === "builtin-pi" ? this.builtinRunner : this.externalRunner;
  }

  execute(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    return this.pickRunner(ticket.backend).execute(ticket, mandate, callbacks);
  }

  resume(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    userReply: string,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    return this.pickRunner(ticket.backend).resume(ticket, mandate, userReply, callbacks);
  }

  async abort(ticketId: string): Promise<void> {
    await Promise.all([
      this.builtinRunner.abort(ticketId),
      this.externalRunner.abort(ticketId),
    ]);
  }
}
