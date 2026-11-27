import type { TraceStepRecord } from "../stats/metrics.js";

export type WorkerBackend =
  | "codex-cli"
  | "antigravity-cli"
  | "opencode-v2"
  | "external-pi"
  | "claude-code"
  | "builtin-pi";

export type TicketStatus =
  | "routing"
  | "pending"
  | "running"
  | "needs_input"
  | "awaiting_confirm"
  | "done"
  | "failed"
  | "cancelled";

export interface WorkerMandate {
  workspace_mode: "isolated" | "host_repo";
  workspace_dir: string;
  is_host_repo: boolean;
  network: "none" | "egress";
  timeout_ms: number;
  skills: string[];
  allowed_mcp_servers: string[];
  confirm_before: string[];
  deliver_files?: boolean;
  execution_mode?: "isolated" | "vm_unrestricted";
}

export interface VerbatimBlock {
  title: string;
  format: "code" | "text" | "markdown";
  content: string;
}

export interface ResultArtifact {
  path: string;
  filename: string;
  send_as: "file" | "photo";
}

export interface WorkerExecutionTrace {
  provider: string;
  modelId: string;
  api: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: string[];
  steps: TraceStepRecord[];
}

export interface WorkerResult {
  ticket_id: string;
  status: "done" | "needs_input" | "awaiting_confirm" | "failed";
  narration_hint: string;
  verbatim_blocks: VerbatimBlock[];
  artifacts: ResultArtifact[];
  required_secrets: string[];
  caveats: string[];
  question?: string;
  confirm_action?: string;
  trace?: WorkerExecutionTrace;
}

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
  approvedConfirm?: boolean;
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
  abortAll?(): Promise<void>;
}

export interface WorkerExecutionDispatcher {
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
  abortAll(): Promise<void>;
}

export interface TicketLiveMetaUpdate {
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

export interface TicketActivitySink {
  emitTicketUpdate(ticket: TicketLiveMetaUpdate): void;
}
