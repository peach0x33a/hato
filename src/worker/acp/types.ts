import type {
  AgentCapabilities,
  AuthMethod,
  Implementation,
  McpServer,
  ProtocolVersion,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { WorkerActivityPatch } from "../activity-stream.js";
import type { ExternalCliBackend } from "../cli-probe.js";
import type { HatoConfig } from "../../config/app.js";

export type WorkerExecutionMode = "isolated" | "vm_unrestricted";

export interface AcpBackendProfile {
  readonly backend: ExternalCliBackend;
  readonly defaultCommand: string;
  readonly baseArgs: readonly string[];
  readonly installHint: string;
  buildLaunchArgs(config: HatoConfig, executionMode: WorkerExecutionMode): string[];
  desiredModel(config: HatoConfig): string | undefined;
  desiredEffort(config: HatoConfig): string | undefined;
  desiredMode(config: HatoConfig, executionMode: WorkerExecutionMode): string | undefined;
}

export interface AcpLaunchSpec {
  backend: ExternalCliBackend;
  command: string;
  args: string[];
  installHint: string;
  desiredModel?: string;
  desiredEffort?: string;
  desiredMode?: string;
}

export interface AcpClientCallbacks {
  onSessionId?: (sessionId: string) => void;
  onProgress?: (note: string) => void;
  onActivity?: (patch: WorkerActivityPatch) => void;
  onStderr?: (chunk: string) => void;
  onProtocolLog?: (direction: "tx" | "rx", line: string) => void;
  onPermissionRequest?: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
}

export interface AcpTurnResult {
  sessionId?: string;
  finalText: string;
  stopReason?: string;
  structuredError?: string;
  permissionDeniedReason?: string;
  stderrText: string;
  timedOut: boolean;
  aborted: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface AcpHandshakeProbeResult {
  ok: boolean;
  installed: boolean;
  protocolVersion?: ProtocolVersion;
  agentInfo?: Implementation | null;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  error?: string;
}

export type AcpMcpServer = McpServer;
