import type {
  ExecutionProgressCallback,
  ExecutionRunner,
  TicketExecutionHandle,
  WorkerBackend,
  WorkerExecutionDispatcher,
  WorkerMandate,
  WorkerResult,
} from "../contracts/worker.js";

export type {
  ExecutionProgressCallback,
  ExecutionRunner,
  TicketExecutionHandle,
};

/**
 * Routes ticket execution and resume requests to `builtin-pi` or `external-cli` runners.
 */
export class WorkerDispatcher implements WorkerExecutionDispatcher {
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

  async abortAll(): Promise<void> {
    await Promise.all([
      this.builtinRunner.abortAll?.(),
      this.externalRunner.abortAll?.(),
    ]);
  }
}
