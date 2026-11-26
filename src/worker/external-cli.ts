import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isWorkerBackendEnabled, resolveSkillsDir, type HatoConfig } from "../config/app.js";
import type { McpConfig } from "../config/mcp.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { computeContextToken, getProcessContextSecret } from "../dispatch/context-slice.js";
import type { WorkerMandate, WorkerResult } from "../dispatch/schema.js";
import { selectWorkerSkills } from "../skills/loader.js";
import { logInfo, logWarn, summarizeError } from "../utils/logger.js";
import { antigravityCliAdapter } from "./adapters/antigravity-cli.js";
import { claudeCodeCliAdapter } from "./adapters/claude-code.js";
import { codexCliAdapter } from "./adapters/codex-cli.js";
import { externalPiCliAdapter } from "./adapters/external-pi.js";
import { openCodeV2CliAdapter } from "./adapters/opencode-v2.js";
import type { ExternalCliAdapter } from "./adapters/types.js";
import { workerActivityHub } from "./activity-stream.js";
import {
  verifyExternalCliBackend,
  type ExternalCliBackend,
} from "./cli-probe.js";
import {
  prepareExternalCliOverlay,
  resolveBackendCommand,
  type ContextMcpSpec,
} from "./overlay.js";
import {
  normalizeExternalCliResult,
  snapshotWorkspaceFiles,
} from "./result-normalizer.js";
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
  verifyOpenCodeV2?: (command: string) => Promise<{ ok: boolean; reason?: string }>;
  verifyBackendCapabilities?: (
    backend: ExternalCliBackend,
    command: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
}

const ADAPTERS: Record<ExternalCliBackend, ExternalCliAdapter> = {
  "codex-cli": codexCliAdapter,
  "antigravity-cli": antigravityCliAdapter,
  "opencode-v2": openCodeV2CliAdapter,
  "external-pi": externalPiCliAdapter,
  "claude-code": claudeCodeCliAdapter,
};

const WORKER_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["done", "needs_input", "awaiting_confirm", "failed"] },
    narration_hint: { type: "string" },
    verbatim_blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          format: { type: "string", enum: ["code", "text", "markdown"] },
          content: { type: "string" },
        },
        required: ["title", "format", "content"],
      },
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          filename: { type: "string" },
          send_as: { type: "string", enum: ["file", "photo"] },
        },
        required: ["path", "filename", "send_as"],
      },
    },
    required_secrets: { type: "array", items: { type: "string" } },
    caveats: { type: "array", items: { type: "string" } },
    question: { type: ["string", "null"] },
    confirm_action: { type: ["string", "null"] },
  },
  required: [
    "status",
    "narration_hint",
    "verbatim_blocks",
    "artifacts",
    "required_secrets",
    "caveats",
    "question",
  ],
};

const PROGRESS_THROTTLE_MS = 1200;
const MAX_BUFFER_CHARS = 512 * 1024;

/**
 * Unified ExecutionRunner for `codex`, `agy`, `opencode-v2`, `external-pi`, and `claude-code`.
 * Handles OpenCode V2 gating, host config overlay, scoped `hato_context` MCP injection,
 * live NDJSON progress streaming, and 4-signal result normalization.
 */
export class ExternalCliRunner implements ExecutionRunner {
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly abortedTickets = new Set<string>();

  constructor(private readonly deps: ExternalCliRunnerDeps) {}

  async execute(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    return this.runCli({
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
    if (!ticket.externalSessionId) {
      return this.runCli({
        mode: "start",
        ticket,
        mandate,
        userReplyFallback: userReply,
        callbacks,
      });
    }
    return this.runCli({
      mode: "resume",
      ticket,
      mandate,
      userReply,
      callbacks,
    });
  }

  async abort(ticketId: string): Promise<void> {
    this.abortedTickets.add(ticketId);
    const child = this.activeProcesses.get(ticketId);
    if (!child) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 3000).unref();
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.activeProcesses.keys()].map((id) => this.abort(id)));
  }

  private async runCli(params: {
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
    const adapter = ADAPTERS[backend];
    if (!adapter) {
      throw new Error(`Unsupported external CLI backend: ${ticket.backend}`);
    }

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
        capCheck.reason || `外部 CLI 后端 "${backend}" 未通过基础能力或版本兼容性校验。`;
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

    const isVmUnrestricted = mandate.execution_mode === "vm_unrestricted";
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
      hatoConfig,
      mcpConfig: this.deps.getMcpConfig(),
      allowedMcpServers: mandate.allowed_mcp_servers,
      selectedSkills,
      contextMcp,
      workerProxyEnv,
    });

    let schemaPath: string | undefined;
    if (backend === "codex-cli" || backend === "antigravity-cli" || backend === "claude-code") {
      const runtimeDir = resolve(
        dirname(hatoConfig.paths.workspaces_dir),
        "worker-cli",
        backend,
        ticket.ticketId.replace(/[^A-Za-z0-9._-]+/g, "_"),
      );
      mkdirSync(runtimeDir, { recursive: true });
      schemaPath = join(runtimeDir, "_hato_result_schema.json");
      writeFileSync(schemaPath, `${JSON.stringify(WORKER_RESULT_JSON_SCHEMA, null, 2)}\n`, "utf8");
    }

    const args =
      params.mode === "resume" && ticket.externalSessionId
        ? adapter.buildResumeArgs({
            sessionId: ticket.externalSessionId,
            reply: params.userReply ?? "",
            workspaceDir: mandate.workspace_dir,
            overlay,
            schemaPath,
          })
        : adapter.buildStartArgs({
            prompt: buildWorkerStartPrompt({
              ticket,
              mandate,
              stagedSkillsDir: overlay.stagedSkillsDir,
              skillNames: selectedSkills.map((s) => s.name),
              extraUserNote: params.userReplyFallback,
            }),
            workspaceDir: mandate.workspace_dir,
            overlay,
            schemaPath,
          });

    const spawnFn = this.deps.spawnProcess ?? spawn;
    const workerCliRoot = resolve(dirname(hatoConfig.paths.workspaces_dir), "worker-cli");
    const activityPersistDir = join(workerCliRoot, "activity");
    const streamLogPath = join(
      workerCliRoot,
      "logs",
      `${ticket.ticketId.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl`,
    );
    mkdirSync(dirname(streamLogPath), { recursive: true });

    const runEpoch = Date.now();
    workerActivityHub.upsert(
      ticket.ticketId,
      {
        kind: "lifecycle",
        state: "done",
        title:
          params.mode === "resume"
            ? `继续执行 ${backend} 会话`
            : `已启动 ${backend} Worker`,
        text: `工作目录: ${mandate.workspace_dir}`,
      },
      { persistDir: activityPersistDir },
    );

    logInfo(
      "WORKER",
      `starting ${backend} ticket=${ticket.ticketId} cwd=${mandate.workspace_dir} modeArgs=${overlay.modeArgs.join(" ")}`,
    );

    const child = spawnFn(overlay.command, args, {
      cwd: mandate.workspace_dir,
      env: overlay.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeProcesses.set(ticket.ticketId, child);

    let lastProgressAt = 0;
    let recordedSessionId = ticket.externalSessionId;
    let finalText = "";
    const textDeltas: string[] = [];
    let textDeltaChars = 0;
    let structuredError: string | undefined;
    let permissionDeniedReason: string | undefined;
    const stderrChunks: string[] = [];
    let stderrChars = 0;
    let timedOut = false;

    const logStream = createWriteStream(streamLogPath, { flags: "a", encoding: "utf8" });
    logStream.on("error", () => {
      // best-effort trace logging
    });

    let killFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killFallbackTimer = setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          child.kill("SIGKILL");
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 3000);
      killFallbackTimer.unref();
    }, mandate.timeout_ms);
    timeoutTimer.unref();

    const rl = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Infinity })
      : null;

    rl?.on("line", (line) => {
      logStream.write(`${line}\n`);
      const ev = adapter.parseStreamLine(line);
      if (!ev) return;

      if (ev.sessionId && ev.sessionId !== recordedSessionId) {
        recordedSessionId = ev.sessionId;
        callbacks?.onSessionId?.(ev.sessionId);
      }

      if (ev.activities) {
        for (const act of ev.activities) {
          workerActivityHub.upsert(ticket.ticketId, act, { persistDir: activityPersistDir });
        }
      }

      if (ev.progressNote) {
        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
          lastProgressAt = now;
          callbacks?.onProgress?.(ev.progressNote);
        }
      }

      if (ev.textDelta && textDeltaChars < MAX_BUFFER_CHARS) {
        const remaining = MAX_BUFFER_CHARS - textDeltaChars;
        const piece = ev.textDelta.slice(0, remaining);
        textDeltas.push(piece);
        textDeltaChars += piece.length;
      }
      if (ev.finalText !== undefined) finalText = ev.finalText.slice(0, MAX_BUFFER_CHARS);
      if (ev.error) structuredError = ev.error;
      if (ev.permissionDenied) permissionDeniedReason = ev.permissionDenied;
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderrChars >= MAX_BUFFER_CHARS) return;
      const strChunk = String(chunk).slice(0, MAX_BUFFER_CHARS - stderrChars);
      stderrChunks.push(strChunk);
      stderrChars += strChunk.length;

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
    });

    let closeDrainTimer: ReturnType<typeof setTimeout> | null = null;
    const { exitCode, signal } = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) => {
      let settled = false;
      const finish = (res: { exitCode: number | null; signal: NodeJS.Signals | null }) => {
        if (settled) return;
        settled = true;
        if (closeDrainTimer) clearTimeout(closeDrainTimer);
        resolveExit(res);
      };
      child.once("error", (err) => {
        structuredError = summarizeError(err);
        finish({ exitCode: 1, signal: null });
      });
      child.once("exit", (code, sig) => {
        closeDrainTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ exitCode: code, signal: sig });
        }, 1500);
        closeDrainTimer.unref();
      });
      child.once("close", (code, sig) => {
        finish({ exitCode: code, signal: sig });
      });
    });

    clearTimeout(timeoutTimer);
    if (killFallbackTimer) clearTimeout(killFallbackTimer);
    rl?.close();
    logStream.end();
    this.activeProcesses.delete(ticket.ticketId);

    const aborted = this.abortedTickets.delete(ticket.ticketId);
    if (aborted && !timedOut) {
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

    const effectiveFinalText = finalText || textDeltas.join("");
    const stderrText = stderrChunks.join("");

    if (exitCode !== 0 && !structuredError) {
      logWarn(
        "WORKER",
        `${backend} ticket=${ticket.ticketId} exited code=${String(exitCode)} sig=${String(signal)}`,
      );
    }

    const normalized = normalizeExternalCliResult({
      ticketId: ticket.ticketId,
      workspaceDir: mandate.workspace_dir,
      isHostRepo: mandate.is_host_repo,
      beforeFilesSnapshot: beforeSnapshot,
      exitCode,
      signal,
      finalText: effectiveFinalText,
      stderrText,
      structuredError,
      permissionDeniedReason,
      timedOut,
    });

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
    if (backend === "opencode-v2" && this.deps.verifyOpenCodeV2) {
      return this.deps.verifyOpenCodeV2(command);
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
