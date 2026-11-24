import type { WorkerActivityPatch } from "../activity-stream.js";
import type { ExternalCliBackend } from "../cli-probe.js";
import type { PreparedExternalCliOverlay } from "../overlay.js";

export interface ExternalCliStreamEvent {
  sessionId?: string;
  progressNote?: string;
  textDelta?: string;
  finalText?: string;
  error?: string;
  permissionDenied?: string;
  done?: boolean;
  activities?: WorkerActivityPatch[];
}

export interface ExternalCliAdapter {
  readonly backend: ExternalCliBackend;
  buildStartArgs(params: {
    prompt: string;
    workspaceDir: string;
    overlay: PreparedExternalCliOverlay;
    schemaPath?: string;
  }): string[];
  buildResumeArgs(params: {
    sessionId: string;
    reply: string;
    workspaceDir: string;
    overlay: PreparedExternalCliOverlay;
    schemaPath?: string;
  }): string[];
  parseStreamLine(line: string): ExternalCliStreamEvent | null;
}
