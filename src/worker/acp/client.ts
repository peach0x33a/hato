import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  client,
  ndJsonStream,
  type AgentCapabilities,
  type AuthMethod,
  type ClientConnection,
  type Implementation,
  type InitializeResponse,
  type McpServer,
  type NewSessionResponse,
  type ProtocolVersion,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import { logInfo, logWarn, summarizeError } from "../../utils/logger.js";
import { AcpEventMapper } from "./event-mapper.js";
import type { AcpClientCallbacks, AcpHandshakeProbeResult } from "./types.js";

export interface AcpConnectionOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  spawnProcess?: typeof spawn;
  callbacks?: AcpClientCallbacks;
}

const CANCEL_GRACE_MS = 2000;
const KILL_GRACE_MS = 3000;
const MAX_BUFFER_CHARS = 512 * 1024;
const PROGRESS_THROTTLE_MS = 1200;

function createLoggedByteStreams(params: {
  child: ChildProcess;
  onLog?: (direction: "tx" | "rx", line: string) => void;
}): {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
} {
  const { child, onLog } = params;
  if (!child.stdin || !child.stdout) {
    throw new Error("ACP child process must have piped stdin and stdout");
  }

  const rawOut = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const rawIn = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;

  if (!onLog) {
    return { writable: rawOut, readable: rawIn };
  }

  const decoder = new TextDecoder();
  let rxRemainder = "";
  const readable = rawIn.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = rxRemainder + decoder.decode(chunk, { stream: true });
        const lines = text.split("\n");
        rxRemainder = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) onLog("rx", line);
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (rxRemainder.trim()) {
          onLog("rx", rxRemainder);
        }
      },
    }),
  );

  let txRemainder = "";
  const txDecoder = new TextDecoder();
  const writer = rawOut.getWriter();
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      const text = txRemainder + txDecoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      txRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) onLog("tx", line);
      }
      await writer.write(chunk);
    },
    async close() {
      if (txRemainder.trim()) {
        onLog("tx", txRemainder);
      }
      await writer.close().catch(() => undefined);
    },
    async abort(reason) {
      await writer.abort(reason).catch(() => undefined);
    },
  });

  return { writable, readable };
}

/**
 * Manages a single stdio ACP child process and its JSON-RPC 2.0 session lifecycle.
 */
export class AcpSessionConnection {
  private readonly child: ChildProcess;
  private readonly connection: ClientConnection;
  private readonly mapper = new AcpEventMapper();
  private readonly callbacks: AcpClientCallbacks;
  private readonly stderrChunks: string[] = [];
  private stderrChars = 0;
  private exitCode: number | null = null;
  private signal: NodeJS.Signals | null = null;
  private exited = false;
  private closed = false;
  private spawnError: string | undefined;

  private activeSessionId: string | undefined;
  private activeTextDeltas: string[] = [];
  private activeTextChars = 0;
  private activePermissionDenied: string | undefined;
  private lastProgressAt = 0;

  public capabilities: AgentCapabilities = {};
  public agentInfo: Implementation | null | undefined;
  public authMethods: AuthMethod[] = [];
  public protocolVersion: ProtocolVersion = PROTOCOL_VERSION;

  constructor(options: AcpConnectionOptions) {
    this.callbacks = options.callbacks ?? {};
    const spawnFn = options.spawnProcess ?? spawn;

    this.child = spawnFn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.once("error", (err) => {
      this.spawnError = summarizeError(err);
      this.exited = true;
      try {
        this.connection.close();
      } catch {
        // ignore
      }
    });
    this.child.once("exit", (code, sig) => {
      this.exitCode = code;
      this.signal = sig;
      this.exited = true;
    });

    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const str = String(chunk);
      if (this.stderrChars < MAX_BUFFER_CHARS) {
        const piece = str.slice(0, MAX_BUFFER_CHARS - this.stderrChars);
        this.stderrChunks.push(piece);
        this.stderrChars += piece.length;
      }
      this.callbacks.onStderr?.(str);
    });

    const { writable, readable } = createLoggedByteStreams({
      child: this.child,
      onLog: this.callbacks.onProtocolLog,
    });
    const stream = ndJsonStream(writable, readable);

    const app = client({ name: "hato" })
      .onNotification(CLIENT_METHODS.session_update, (ctx) => {
        const mapped = this.mapper.map(ctx.params.update);
        for (const act of mapped.activities) {
          this.callbacks.onActivity?.(act);
        }
        if (mapped.progressNote) {
          const now = Date.now();
          if (now - this.lastProgressAt >= PROGRESS_THROTTLE_MS) {
            this.lastProgressAt = now;
            this.callbacks.onProgress?.(mapped.progressNote);
          }
        }
        if (mapped.textDelta && this.activeTextChars < MAX_BUFFER_CHARS) {
          const remaining = MAX_BUFFER_CHARS - this.activeTextChars;
          const piece = mapped.textDelta.slice(0, remaining);
          this.activeTextDeltas.push(piece);
          this.activeTextChars += piece.length;
        }
      })
      .onRequest(CLIENT_METHODS.session_request_permission, async (ctx) => {
        if (!this.callbacks.onPermissionRequest) {
          const allow = ctx.params.options.find(
            (o) => o.kind === "allow_once" || o.kind === "allow_always",
          );
          if (allow) {
            return { outcome: { outcome: "selected", optionId: allow.optionId } };
          }
          return { outcome: { outcome: "cancelled" } };
        }
        return this.callbacks.onPermissionRequest(ctx.params);
      });

    this.connection = app.connect(stream);
    // Prevent unhandled rejection if connection closes unexpectedly
    this.connection.closed.catch(() => undefined);
  }

  get isAlive(): boolean {
    return !this.closed && !this.exited && this.child.exitCode === null && !this.child.killed;
  }

  get sessionId(): string | undefined {
    return this.activeSessionId;
  }

  getExitInfo(): { exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: string } {
    return { exitCode: this.exitCode, signal: this.signal, spawnError: this.spawnError };
  }

  getStderrText(): string {
    return this.stderrChunks.join("");
  }

  recordPermissionDenied(reason: string): void {
    this.activePermissionDenied = reason;
  }

  async initialize(timeoutMs = 10_000): Promise<InitializeResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const res = await this.connection.agent.request(
        AGENT_METHODS.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "hato", version: "0.1.8" },
          clientCapabilities: {},
        },
        { cancellationSignal: controller.signal, stopWaitingOnCancel: true },
      );
      this.protocolVersion = res.protocolVersion;
      this.capabilities = res.agentCapabilities ?? {};
      this.agentInfo = res.agentInfo;
      this.authMethods = res.authMethods ?? [];
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async startSession(params: {
    cwd: string;
    mcpServers: McpServer[];
    desiredModel?: string;
    desiredEffort?: string;
    desiredMode?: string;
  }): Promise<NewSessionResponse> {
    const res = await this.connection.agent.request(AGENT_METHODS.session_new, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
    });
    this.activeSessionId = res.sessionId;
    this.callbacks.onSessionId?.(res.sessionId);

    await this.applySessionPreferences({
      sessionId: res.sessionId,
      modes: res.modes ?? undefined,
      configOptions: res.configOptions ?? undefined,
      desiredMode: params.desiredMode,
      desiredModel: params.desiredModel,
      desiredEffort: params.desiredEffort,
    });

    return res;
  }

  async loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers: McpServer[];
    desiredModel?: string;
    desiredEffort?: string;
    desiredMode?: string;
  }): Promise<void> {
    const res = await this.connection.agent.request(AGENT_METHODS.session_load, {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
    });
    this.activeSessionId = params.sessionId;
    this.callbacks.onSessionId?.(params.sessionId);

    await this.applySessionPreferences({
      sessionId: params.sessionId,
      modes: res.modes ?? undefined,
      configOptions: res.configOptions ?? undefined,
      desiredMode: params.desiredMode,
      desiredModel: params.desiredModel,
      desiredEffort: params.desiredEffort,
    });
  }

  private async applySessionPreferences(params: {
    sessionId: string;
    modes?: SessionModeState;
    configOptions?: SessionConfigOption[];
    desiredMode?: string;
    desiredModel?: string;
    desiredEffort?: string;
  }): Promise<void> {
    if (params.desiredMode && params.modes?.availableModes?.some((m) => m.id === params.desiredMode)) {
      try {
        await this.connection.agent.request(AGENT_METHODS.session_set_mode, {
          sessionId: params.sessionId,
          modeId: params.desiredMode,
        });
      } catch (err) {
        logWarn("WORKER", `ACP session/set_mode failed: ${summarizeError(err)}`);
      }
    }

    const configOpts = params.configOptions ?? [];
    if (params.desiredModel) {
      const modelOpt = configOpts.find(
        (opt) => opt.category === "model" || opt.id.toLowerCase().includes("model"),
      );
      if (modelOpt && modelOpt.type === "select") {
        try {
          await this.connection.agent.request(AGENT_METHODS.session_set_config_option, {
            sessionId: params.sessionId,
            configId: modelOpt.id,
            value: params.desiredModel,
          });
        } catch (err) {
          logWarn("WORKER", `ACP set model config option failed: ${summarizeError(err)}`);
        }
      }
    }

    if (params.desiredEffort) {
      const effortOpt = configOpts.find(
        (opt) =>
          opt.category === "thought_level" ||
          opt.id.toLowerCase().includes("effort") ||
          opt.id.toLowerCase().includes("thought"),
      );
      if (effortOpt && effortOpt.type === "select") {
        try {
          await this.connection.agent.request(AGENT_METHODS.session_set_config_option, {
            sessionId: params.sessionId,
            configId: effortOpt.id,
            value: params.desiredEffort,
          });
        } catch (err) {
          logWarn("WORKER", `ACP set effort config option failed: ${summarizeError(err)}`);
        }
      }
    }
  }

  async prompt(
    text: string,
    timeoutMs: number,
  ): Promise<{
    finalText: string;
    stopReason?: string;
    permissionDeniedReason?: string;
    timedOut: boolean;
    structuredError?: string;
  }> {
    if (!this.activeSessionId) {
      throw new Error("ACP session not initialized before prompt()");
    }

    this.mapper.resetForNewTurn();
    this.activeTextDeltas = [];
    this.activeTextChars = 0;
    this.activePermissionDenied = undefined;

    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      void this.cancel();
      controller.abort();
    }, timeoutMs);
    timer.unref();

    try {
      const res = await this.connection.agent.request(
        AGENT_METHODS.session_prompt,
        {
          sessionId: this.activeSessionId,
          prompt: [{ type: "text", text }],
        },
        { cancellationSignal: controller.signal, stopWaitingOnCancel: true },
      );

      return {
        finalText: this.activeTextDeltas.join(""),
        stopReason: res.stopReason,
        permissionDeniedReason: this.activePermissionDenied,
        timedOut,
      };
    } catch (err) {
      const errMsg = this.spawnError || summarizeError(err);
      logInfo("WORKER", `ACP prompt ended with error: ${errMsg}`);
      return {
        finalText: this.activeTextDeltas.join(""),
        permissionDeniedReason: this.activePermissionDenied,
        timedOut,
        structuredError: timedOut ? undefined : errMsg,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async cancel(): Promise<void> {
    if (this.activeSessionId && this.isAlive) {
      try {
        await this.connection.agent.notify(AGENT_METHODS.session_cancel, {
          sessionId: this.activeSessionId,
        });
      } catch {
        // ignore if stream already closed
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.isAlive) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        void this.close();
        resolve();
      }, CANCEL_GRACE_MS);
      t.unref();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      this.connection.close();
    } catch {
      // ignore
    }

    if (!this.exited && this.child.exitCode === null) {
      try {
        this.child.stdin?.end();
      } catch {
        // ignore
      }
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }

      await new Promise<void>((resolve) => {
        if (this.exited || this.child.exitCode !== null) {
          resolve();
          return;
        }
        const onExit = () => {
          clearTimeout(killTimer);
          clearTimeout(doneTimer);
          resolve();
        };
        this.child.once("exit", onExit);

        const killTimer = setTimeout(() => {
          if (!this.exited && this.child.exitCode === null) {
            try {
              this.child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, KILL_GRACE_MS);
        killTimer.unref();

        const doneTimer = setTimeout(() => {
          this.child.removeListener("exit", onExit);
          resolve();
        }, KILL_GRACE_MS + 500);
        doneTimer.unref();
      });
    }
  }
}

export async function probeAcpHandshake(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
}): Promise<AcpHandshakeProbeResult> {
  if (!params.spawnProcess) {
    const bunWhich = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which;
    if (typeof bunWhich === "function" && !bunWhich(params.command)) {
      return {
        ok: false,
        installed: false,
        error: `command not found: ${params.command}`,
      };
    }
  }
  let conn: AcpSessionConnection | null = null;
  try {
    conn = new AcpSessionConnection({
      command: params.command,
      args: params.args,
      cwd: params.cwd ?? process.cwd(),
      env: params.env ?? (process.env as Record<string, string>),
      spawnProcess: params.spawnProcess,
    });
    const init = await conn.initialize(params.timeoutMs ?? 5000);
    return {
      ok: true,
      installed: true,
      protocolVersion: init.protocolVersion,
      agentInfo: init.agentInfo,
      agentCapabilities: init.agentCapabilities,
      authMethods: init.authMethods,
    };
  } catch (err) {
    const exitInfo = conn?.getExitInfo();
    const rawMsg = exitInfo?.spawnError || summarizeError(err);
    const isNotFound = /ENOENT|command not found|not found|Executable not found/i.test(rawMsg);
    return {
      ok: false,
      installed: !isNotFound,
      error: rawMsg,
    };
  } finally {
    if (conn) {
      await conn.close().catch(() => undefined);
    }
  }
}
