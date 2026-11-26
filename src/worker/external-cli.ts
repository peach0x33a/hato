import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import type { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isWorkerBackendEnabled,
  resolveSkillsDir,
  resolveWorkerExternalCliConfig,
  type HatoConfig,
} from "../config/app.js";
import type { McpConfig } from "../config/mcp.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { computeContextToken, getProcessContextSecret } from "../dispatch/context-slice.js";
import type { WorkerMandate, WorkerResult } from "../dispatch/schema.js";
import { selectWorkerSkills } from "../skills/loader.js";
import { logInfo, logWarn, summarizeError } from "../utils/logger.js";
import { AcpSessionConnection } from "./acp/client.js";
import { evaluateAcpPermissionRequest } from "./acp/permission-policy.js";
import type { WorkerExecutionMode } from "./acp/types.js";
import { workerActivityHub } from "./activity-stream.js";
import { verifyExternalCliBackend, type ExternalCliBackend } from "./cli-probe.js";
import {
  prepareExternalCliOverlay,
  resolveBackendCommand,
  type ContextMcpSpec,
} from "./overlay.js";
import { normalizeExternalCliResult, snapshotWorkspaceFiles } from "./result-normalizer.js";
import type {
  ExecutionProgressCallback,
  ExecutionRunner,
  TicketExecutionHandle,
} from "./backend.js";

export interface ExternalCliRunnerDeps {
  getHatoConfig: () => HatoConfig;
  getMcpConfig: () => McpConfig;
  proxyRouter: ScopedProxyRouter;
  spawnProcess?: typeof spawn;
  verifyBackendCapabilities?: (
    backend: ExternalCliBackend,
    command: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
}

interface PooledAcpSession {
  conn: AcpSessionConnection;
  sessionId: string;
  backend: ExternalCliBackend;
  timer: ReturnType<typeof setTimeout>;
}

const SESSION_POOL_TTL_MS = 15 * 60 * 1000;

/**
 * Unified ACP ExecutionRunner for external coding agents:
 * `codex-cli`, `antigravity-cli`, `opencode-v2`, `external-pi`, and `claude-code`.
 * Uses Agent Client Protocol (JSON-RPC 2.0 over stdio) for session lifecycle,
 * MCP injection, permission mediation, live activity streaming, and cancellation.
 */
export class ExternalCliRunner implements ExecutionRunner {
  private readonly activeConnections = new Map<string, AcpSessionConnection>();
  private readonly pooledSessions = new Map<string, PooledAcpSession>();
  private readonly abortedTickets = new Set<string>();

  constructor(private readonly deps: ExternalCliRunnerDeps) {}

  async execute(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    return this.runAcp({
      mode: "start",
      ticket,
      mandate,
      callbacks,
    });
  }

  async resume(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    userReply: string,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    if (!ticket.externalSessionId && !this.pooledSessions.has(ticket.ticketId)) {
      return this.runAcp({
        mode: "start",
        ticket,
        mandate,
        userReplyFallback: userReply,
        callbacks,
      });
    }
    return this.runAcp({
      mode: "resume",
      ticket,
      mandate,
      userReply,
      callbacks,
    });
  }

  async abort(ticketId: string): Promise<void> {
    this.abortedTickets.add(ticketId);
    const pooled = this.pooledSessions.get(ticketId);
    if (pooled) {
      clearTimeout(pooled.timer);
      this.pooledSessions.delete(ticketId);
      await pooled.conn.close().catch(() => undefined);
    }
    const active = this.activeConnections.get(ticketId);
    if (active) {
      await active.cancel().catch(() => undefined);
      await active.close().catch(() => undefined);
    }
  }

  async abortAll(): Promise<void> {
    const ids = new Set<string>([
      ...this.activeConnections.keys(),
      ...this.pooledSessions.keys(),
    ]);
    await Promise.all([...ids].map((id) => this.abort(id)));
  }

  private takePooledSession(
    ticketId: string,
    backend: ExternalCliBackend,
  ): PooledAcpSession | null {
    const entry = this.pooledSessions.get(ticketId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.pooledSessions.delete(ticketId);
    if (entry.backend !== backend || !entry.conn.isAlive) {
      void entry.conn.close().catch(() => undefined);
      return null;
    }
    return entry;
  }

  private parkPooledSession(
    ticketId: string,
    backend: ExternalCliBackend,
    conn: AcpSessionConnection,
    sessionId: string,
  ): void {
    const existing = this.pooledSessions.get(ticketId);
    if (existing) {
      clearTimeout(existing.timer);
      void existing.conn.close().catch(() => undefined);
    }
    const timer = setTimeout(() => {
      const cur = this.pooledSessions.get(ticketId);
      if (cur && cur.conn === conn) {
        this.pooledSessions.delete(ticketId);
        void conn.close().catch(() => undefined);
      }
    }, SESSION_POOL_TTL_MS);
    timer.unref();
    this.pooledSessions.set(ticketId, { conn, sessionId, backend, timer });
  }

  private async runAcp(params: {
    mode: "start" | "resume";
    ticket: TicketExecutionHandle;
    mandate: WorkerMandate;
    userReply?: string;
    userReplyFallback?: string;
    callbacks?: ExecutionProgressCallback;
  }): Promise<WorkerResult> {
    const { ticket, mandate, callbacks } = params;
    if (ticket.backend === "builtin-pi") {
      throw new Error("ExternalCliRunner cannot execute builtin-pi backend");
    }

    const backend = ticket.backend as ExternalCliBackend;
    const hatoConfig = this.deps.getHatoConfig();
    if (!isWorkerBackendEnabled(hatoConfig, backend)) {
      return {
        ticket_id: ticket.ticketId,
        status: "failed",
        narration_hint: `外部 CLI 后端 "${backend}" 已在设置中禁用，请改用已启用的后端。`,
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: [`backend "${backend}" is disabled in config`],
      };
    }

    const capCheck = await this.checkBackendCapabilitiesGate(backend, hatoConfig);
    if (!capCheck.ok) {
      const reason =
        capCheck.reason || `外部 CLI 后端 "${backend}" 未通过 ACP 协议握手校验。`;
      return {
        ticket_id: ticket.ticketId,
        status: "failed",
        narration_hint: reason,
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: [reason],
      };
    }

    const executionMode: WorkerExecutionMode =
      mandate.execution_mode === "vm_unrestricted" ? "vm_unrestricted" : "isolated";
    const isVmUnrestricted = executionMode === "vm_unrestricted";
    mkdirSync(mandate.workspace_dir, { recursive: true });
    const beforeSnapshot = isVmUnrestricted
      ? undefined
      : snapshotWorkspaceFiles(mandate.workspace_dir);

    const selectedSkills = selectWorkerSkills(resolveSkillsDir(hatoConfig), mandate.skills);
    const workerProxyEnv =
      mandate.network === "egress"
        ? this.deps.proxyRouter.getWorkerProxyEnv("worker")
        : this.deps.proxyRouter.getWorkerProxyEnv("llm-calling");

    const contextMcp = buildContextMcpSpec({
      hatoConfig,
      ticketId: ticket.ticketId,
      contextId: ticket.contextId,
    });

    const overlay = prepareExternalCliOverlay({
      backend,
      ticketId: ticket.ticketId,
      workspaceDir: mandate.workspace_dir,
      isHostRepo: mandate.is_host_repo,
      executionMode,
      hatoConfig,
      mcpConfig: this.deps.getMcpConfig(),
      allowedMcpServers: mandate.allowed_mcp_servers,
      selectedSkills,
      contextMcp,
      workerProxyEnv,
    });

    const extCfg = resolveWorkerExternalCliConfig(hatoConfig);
    const workerCliRoot = resolve(dirname(hatoConfig.paths.workspaces_dir), "worker-cli");
    const activityPersistDir = join(workerCliRoot, "activity");
    const acpLogPath = join(
      workerCliRoot,
      "logs",
      `${ticket.ticketId.replace(/[^A-Za-z0-9._-]+/g, "_")}.acp.jsonl`,
    );
    mkdirSync(dirname(acpLogPath), { recursive: true });

    const runEpoch = Date.now();
    workerActivityHub.upsert(
      ticket.ticketId,
      {
        kind: "lifecycle",
        state: "done",
        title:
          params.mode === "resume"
            ? `继续执行 ${backend} (ACP)`
            : `已启动 ${backend} Worker (ACP)`,
        text: `工作目录: ${mandate.workspace_dir}`,
      },
      { persistDir: activityPersistDir },
    );

    logInfo(
      "WORKER",
      `starting ACP ${backend} ticket=${ticket.ticketId} cwd=${mandate.workspace_dir} cmd=${overlay.command} args=${overlay.args.join(" ")}`,
    );

    const logStream = createWriteStream(acpLogPath, { flags: "a", encoding: "utf8" });
    logStream.on("error", () => {
      // best-effort protocol trace logging
    });

    const pooled =
      params.mode === "resume" ? this.takePooledSession(ticket.ticketId, backend) : null;

    let conn: AcpSessionConnection;
    let promptText: string;

    if (pooled) {
      conn = pooled.conn;
      promptText = params.userReply ?? "";
      logInfo("WORKER", `reusing pooled ACP session=${pooled.sessionId} ticket=${ticket.ticketId}`);
    } else {
      conn = new AcpSessionConnection({
        command: overlay.command,
        args: overlay.args,
        cwd: mandate.workspace_dir,
        env: overlay.env,
        spawnProcess: this.deps.spawnProcess,
        callbacks: {
          onSessionId: (sessionId) => {
            callbacks?.onSessionId?.(sessionId);
          },
          onProgress: (note) => {
            callbacks?.onProgress?.(note);
          },
          onActivity: (patch) => {
            workerActivityHub.upsert(ticket.ticketId, patch, { persistDir: activityPersistDir });
          },
          onProtocolLog: (direction, line) => {
            logStream.write(`[${direction}] ${line}\n`);
          },
          onStderr: (strChunk) => {
            const filteredLines = strChunk
              .split(/\r?\n/)
              .filter(
                (l) =>
                  l.trim().length > 0 &&
                  !l.includes("UNDICI-EHPA") &&
                  !l.includes("--trace-warnings"),
              )
              .join("\n");
            if (filteredLines) {
              workerActivityHub.upsert(
                ticket.ticketId,
                {
                  stepKey: `stderr_${runEpoch}`,
                  kind: "stderr",
                  state: "done",
                  title: "CLI 诊断输出",
                  appendOutput: `${filteredLines}\n`,
                },
                { persistDir: activityPersistDir },
              );
            }
          },
          onPermissionRequest: (request) => {
            const decision = evaluateAcpPermissionRequest({
              request,
              permissionPreset: extCfg.permissionPreset,
              executionMode,
              confirmBefore: mandate.confirm_before,
            });
            if (decision.deniedReason) {
              conn.recordPermissionDenied(decision.deniedReason);
            }
            return decision.response;
          },
        },
      });
      promptText = "";
    }

    this.activeConnections.set(ticket.ticketId, conn);

    let promptResult: {
      finalText: string;
      stopReason?: string;
      permissionDeniedReason?: string;
      timedOut: boolean;
      structuredError?: string;
    } = {
      finalText: "",
      timedOut: false,
    };

    try {
      if (!pooled) {
        await conn.initialize();

        if (
          params.mode === "resume" &&
          ticket.externalSessionId &&
          conn.capabilities.loadSession
        ) {
          await conn.loadSession({
            sessionId: ticket.externalSessionId,
            cwd: mandate.workspace_dir,
            mcpServers: overlay.mcpServers,
            desiredModel: overlay.desiredModel,
            desiredEffort: overlay.desiredEffort,
            desiredMode: overlay.desiredMode,
          });
          promptText = params.userReply ?? "";
        } else {
          await conn.startSession({
            cwd: mandate.workspace_dir,
            mcpServers: overlay.mcpServers,
            desiredModel: overlay.desiredModel,
            desiredEffort: overlay.desiredEffort,
            desiredMode: overlay.desiredMode,
          });
          promptText = buildWorkerStartPrompt({
            ticket,
            mandate,
            stagedSkillsDir: overlay.stagedSkillsDir,
            skillNames: selectedSkills.map((s) => s.name),
            extraUserNote:
              params.mode === "resume" ? params.userReply : params.userReplyFallback,
          });
        }
      }

      promptResult = await conn.prompt(promptText, mandate.timeout_ms);
    } catch (err) {
      const exitInfo = conn.getExitInfo();
      promptResult.structuredError = exitInfo.spawnError || summarizeError(err);
    } finally {
      this.activeConnections.delete(ticket.ticketId);
      logStream.end();
    }

    const aborted = this.abortedTickets.delete(ticket.ticketId);
    if (aborted && !promptResult.timedOut) {
      await conn.close().catch(() => undefined);
      workerActivityHub.upsert(
        ticket.ticketId,
        {
          kind: "lifecycle",
          state: "error",
          title: "任务已手动中止",
        },
        { persistDir: activityPersistDir, flushImmediate: true },
      );
      return {
        ticket_id: ticket.ticketId,
        status: "failed",
        narration_hint: "后台任务已被手动中止。",
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: ["用户取消或系统中止"],
      };
    }

    const exitInfo = conn.getExitInfo();
    const stderrText = conn.getStderrText();

    if (exitInfo.exitCode !== null && exitInfo.exitCode !== 0 && !promptResult.structuredError) {
      logWarn(
        "WORKER",
        `ACP ${backend} ticket=${ticket.ticketId} exited code=${String(exitInfo.exitCode)} sig=${String(exitInfo.signal)}`,
      );
    }

    const normalized = normalizeExternalCliResult({
      ticketId: ticket.ticketId,
      workspaceDir: mandate.workspace_dir,
      isHostRepo: mandate.is_host_repo,
      beforeFilesSnapshot: beforeSnapshot,
      exitCode: exitInfo.exitCode,
      signal: exitInfo.signal,
      finalText: promptResult.finalText,
      stderrText,
      structuredError: promptResult.structuredError,
      permissionDeniedReason: promptResult.permissionDeniedReason,
      stopReason: promptResult.stopReason,
      timedOut: promptResult.timedOut,
    });

    if (
      (normalized.status === "needs_input" || normalized.status === "awaiting_confirm") &&
      conn.isAlive &&
      conn.sessionId
    ) {
      this.parkPooledSession(ticket.ticketId, backend, conn, conn.sessionId);
    } else {
      await conn.close().catch(() => undefined);
    }

    workerActivityHub.upsert(
      ticket.ticketId,
      {
        kind: "lifecycle",
        state: normalized.status === "failed" ? "error" : "done",
        title:
          normalized.status === "done"
            ? "Worker 执行完成"
            : normalized.status === "needs_input"
              ? "等待补充信息"
              : normalized.status === "awaiting_confirm"
                ? "等待高危操作确认"
                : "Worker 执行失败",
        ...(normalized.narration_hint ? { text: normalized.narration_hint } : {}),
      },
      { persistDir: activityPersistDir, flushImmediate: true },
    );

    return normalized;
  }

  private async checkBackendCapabilitiesGate(
    backend: ExternalCliBackend,
    config: HatoConfig,
  ): Promise<{ ok: boolean; reason?: string }> {
    const command = resolveBackendCommand(backend, config);
    if (this.deps.verifyBackendCapabilities) {
      return this.deps.verifyBackendCapabilities(backend, command);
    }
    if (this.deps.spawnProcess) {
      return { ok: true };
    }
    return verifyExternalCliBackend(backend, config);
  }
}

export function buildContextMcpSpec(params: {
  hatoConfig: HatoConfig;
  ticketId: string;
  contextId: string;
}): ContextMcpSpec {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const jsEntry = resolve(selfDir, "../dispatch/context-server.js");
  const tsEntry = resolve(selfDir, "../dispatch/context-server.ts");
  const isCompiledJs = existsSync(jsEntry) && selfDir.includes(`${join("dist", "worker")}`);

  const contextSecret = getProcessContextSecret();
  const env: Record<string, string> = {
    HATO_DB_PATH: resolve(params.hatoConfig.paths.sqlite),
    HATO_CONTEXT_ID: params.contextId,
    HATO_TIMEZONE: params.hatoConfig.owner.timezone,
    HATO_CTX_SECRET: contextSecret,
    HATO_CTX_TOKEN: computeContextToken(
      contextSecret,
      params.ticketId,
      params.contextId,
    ),
    HATO_LOOKBACK_JSON: JSON.stringify({
      maxStepCount: params.hatoConfig.context.lookback.max_step_count,
      maxTotalMessages: params.hatoConfig.context.lookback.max_total_messages,
      maxHours: params.hatoConfig.context.lookback.max_hours,
    }),
  };

  if (isCompiledJs) {
    return {
      command: process.execPath,
      args: [jsEntry],
      env,
    };
  }

  const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return {
    command: process.execPath,
    args: isBunRuntime ? [tsEntry] : ["--import", "tsx", tsEntry],
    env,
  };
}

function buildWorkerStartPrompt(params: {
  ticket: TicketExecutionHandle;
  mandate: WorkerMandate;
  stagedSkillsDir: string | null;
  skillNames: string[];
  extraUserNote?: string;
}): string {
  const lines = [
    `你是 Hato 后台工程执行 Worker（工单 ${params.ticket.ticketId}）。`,
    `任务目标：${params.ticket.briefTitle}`,
    "",
    "第一步必须先调用 MCP 工具 `hato_context` 的 `read_task_context`（参数 `context_id=\"" +
      params.ticket.contextId +
      "\"`）拉取完整原始需求上下文。",
    "- 上下文中的 `[CHAT_RELAY]` 为前端陪伴助手记录，请忽略其语气措辞，仅提取技术事实与经 `[USER]` 发起或确认的需求约束。",
    "- 如发现上文引用缺失，可调用 `expand_earlier_context` 有限向前补全。",
  ];

  if (params.skillNames.length > 0 && params.stagedSkillsDir) {
    lines.push(
      `- 本工单已加载 Worker Skills（目录：${params.stagedSkillsDir}）：${params.skillNames.join(", ")}。`,
    );
  }
  if (params.mandate.execution_mode === "vm_unrestricted") {
    lines.push(
      "- 当前处于 `vm_unrestricted`（虚拟机全权模式），工作目录为持久目录，可自由读写虚拟机文件与执行命令；但严格禁止读取、修改或泄露 Hato 的 `.env` / `.env.*` 密钥文件（如 `~/.hato/.env` 或 Hato 仓库 `.env`）。",
    );
  }
  if (params.mandate.confirm_before.length > 0) {
    lines.push(
      `- 边界约束：遇到以下高危动作 [${params.mandate.confirm_before.join(", ")}] 时，不要擅自执行，请说明需确认动作后结束等待确认。`,
    );
  }
  lines.push(
    "- 请直接完成任务并在最后输出清晰客观的结果总结（如生成文件或命令结果请给出准确路径与事实）。",
  );
  if (params.extraUserNote?.trim()) {
    lines.push(`\n补充信息：${params.extraUserNote.trim()}`);
  }
  return lines.join("\n");
}
