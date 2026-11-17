import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { EventBus } from "../bus/actor-bus.js";
import {
  resolveWorkerExecutionMode,
  resolveWorkerExternalCliConfig,
  resolveWorkerVmWorkdir,
  type HatoConfig,
} from "../config/app.js";
import type { HatoRepository } from "../db/repo.js";
import type { ChannelName, InboundBatch } from "../gateway/types.js";
import { logError, logInfo, summarizeError } from "../utils/logger.js";
import type { WorkerDispatcher } from "../worker/backend.js";
import type { NeutralRouter } from "./router.js";
import {
  parseWorkerMandate,
  type RouterDecision,
  type WorkerMandate,
  type WorkerResult,
} from "./schema.js";

export interface TicketCoordinatorDeps {
  getHatoConfig: () => HatoConfig;
  repo: HatoRepository;
  router: NeutralRouter;
  dispatcher: WorkerDispatcher;
  bus: EventBus;
}

/**
 * Coordinates fast `delegate()` queueing, asynchronous Neutral Router boundary setting,
 * Worker execution/resumption, `needs_input` reply classification, and confirmation callbacks.
 */
export class TicketCoordinator {
  private readonly pendingRuns = new Set<Promise<void>>();

  constructor(private readonly deps: TicketCoordinatorDeps) {}

  enqueueDelegation(params: {
    canonicalUserId: string;
    originChannel: ChannelName;
    hint: string;
    urgency?: "normal" | "high";
    deliverFiles?: boolean;
  }): { ticketId: string; status: "routing" } {
    const cfg = this.deps.getHatoConfig();
    const ticketId = `t_${randomBytes(4).toString("hex")}`;
    const briefTitle = params.hint.trim().slice(0, 48) || "后台任务";

    this.deps.repo.createTicket({
      id: ticketId,
      canonicalUserId: params.canonicalUserId,
      status: "routing",
      backend: cfg.worker.default_backend,
      briefTitle,
      originChannel: params.originChannel,
      progressNote: "正在分析任务上下文与边界",
    });

    const job = this.processDelegation(ticketId, params).catch((err) => {
      logError("DISPATCH", `delegation ${ticketId} crashed`, err);
    });
    this.trackPending(job);

    return { ticketId, status: "routing" };
  }

  /**
   * Check whether an incoming user batch answers an active `needs_input` ticket.
   */
  async tryRouteInboundToTicket(batch: InboundBatch): Promise<{
    handledByTicket: boolean;
    ticketId?: string;
  }> {
    const active = this.deps.repo.listActiveTickets(batch.canonicalUserId, 10);
    const waitingTickets = active.filter((t) => t.status === "needs_input");
    if (waitingTickets.length === 0) {
      return { handledByTicket: false };
    }

    const parsedQuestions = waitingTickets.map((t) => {
      let question: string | undefined;
      if (t.resultJson) {
        try {
          const parsed = JSON.parse(t.resultJson) as { question?: string };
          question = parsed.question;
        } catch {
          question = undefined;
        }
      }
      return { id: t.id, briefTitle: t.briefTitle, question };
    });

    const decision = await this.deps.router.classifyNeedsInputReply({
      canonicalUserId: batch.canonicalUserId,
      latestUserText: batch.combinedText,
      needsInputTickets: parsedQuestions,
    });

    if (decision.route !== "reply_ticket" || !decision.ticket_id) {
      return { handledByTicket: false };
    }

    const target = waitingTickets.find((t) => t.id === decision.ticket_id);
    if (!target) {
      return { handledByTicket: false };
    }

    this.deps.repo.appendRawMessage({
      canonicalUserId: batch.canonicalUserId,
      channel: batch.originChannel,
      platformMsgId: batch.latestPlatformMsgId,
      replyToId: batch.replyToPlatformMsgId ?? null,
      role: "user",
      content: batch.combinedText,
      attachments: batch.attachments,
      createdAt: batch.lastTimestampMs,
    });

    const cfg = this.deps.getHatoConfig();
    const mandate =
      parseWorkerMandate(target.mandateJson) ??
      buildDefaultMandate(cfg, target.id);
    const replyText = decision.objective_reply?.trim() || batch.combinedText;

    this.deps.repo.updateTicket(target.id, {
      status: "running",
      progressNote: "收到补充回复，继续执行中",
    });

    const job = this.runTicketResume(
      {
        ticketId: target.id,
        canonicalUserId: target.canonicalUserId,
        backend: target.backend as WorkerMandate extends never ? never : any,
        briefTitle: target.briefTitle,
        contextId: target.contextId || `ctx_${target.id}`,
        externalSessionId: target.externalSessionId,
      },
      mandate,
      target.originChannel as ChannelName,
      replyText,
    ).catch((err) => {
      logError("DISPATCH", `resume ${target.id} failed`, err);
    });
    this.trackPending(job);

    return { handledByTicket: true, ticketId: target.id };
  }

  async handleConfirmAction(
    ticketId: string,
    approved: boolean,
  ): Promise<string> {
    const ticket = this.deps.repo.getTicket(ticketId);
    if (!ticket) {
      return `未找到工单 ${ticketId}`;
    }
    if (ticket.status !== "awaiting_confirm") {
      return `工单 ${ticketId} 当前状态为 ${ticket.status}，无需确认。`;
    }

    if (!approved) {
      this.deps.repo.updateTicket(ticketId, {
        status: "cancelled",
        progressNote: "用户已取消执行",
      });
      return `已取消工单 ${ticketId}`;
    }

    const cfg = this.deps.getHatoConfig();
    const mandate =
      parseWorkerMandate(ticket.mandateJson) ?? buildDefaultMandate(cfg, ticket.id);
    this.deps.repo.updateTicket(ticketId, {
      status: "running",
      progressNote: "用户已确认，恢复执行",
    });

    const job = this.runTicketResume(
      {
        ticketId: ticket.id,
        canonicalUserId: ticket.canonicalUserId,
        backend: ticket.backend as any,
        briefTitle: ticket.briefTitle,
        contextId: ticket.contextId || `ctx_${ticket.id}`,
        externalSessionId: ticket.externalSessionId,
      },
      mandate,
      ticket.originChannel as ChannelName,
      "用户已确认批准该高危操作，请继续完成任务。",
    ).catch((err) => {
      logError("DISPATCH", `confirmed resume ${ticketId} failed`, err);
    });
    this.trackPending(job);

    return `已确认执行工单 ${ticketId}`;
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingRuns.size > 0) {
      await Promise.all([...this.pendingRuns]);
    }
  }

  private trackPending(p: Promise<void>): void {
    this.pendingRuns.add(p);
    void p.finally(() => {
      this.pendingRuns.delete(p);
    });
  }

  private async processDelegation(
    ticketId: string,
    params: {
      canonicalUserId: string;
      originChannel: ChannelName;
      hint: string;
      urgency?: "normal" | "high";
      deliverFiles?: boolean;
    },
  ): Promise<void> {
    const decision = await this.deps.router.routeDelegation({
      canonicalUserId: params.canonicalUserId,
      hint: params.hint,
      urgency: params.urgency,
    });

    await this.applyRouterDecision(
      ticketId,
      params.canonicalUserId,
      params.originChannel,
      decision,
      params.deliverFiles,
    );
  }

  private async applyRouterDecision(
    ticketId: string,
    canonicalUserId: string,
    originChannel: ChannelName,
    decision: RouterDecision,
    deliverFiles?: boolean,
  ): Promise<void> {
    if (decision.decision === "schedule_op") {
      let applied = false;
      if (decision.target_type === "script") {
        if (decision.action === "delete") {
          applied = this.deps.repo.deleteScript(decision.target_id);
        } else if (decision.action === "pause" || decision.action === "resume") {
          applied = this.deps.repo.updateScriptSchedule(decision.target_id, {
            enabled: decision.action === "resume",
          });
        } else if (decision.action === "reschedule" && decision.cron_expr) {
          applied = this.deps.repo.updateScriptSchedule(decision.target_id, {
            cronExpr: decision.cron_expr,
          });
        }
      } else if (decision.target_type === "open_loop") {
        const nextStatus =
          decision.action === "delete"
            ? "cancelled"
            : decision.action === "pause"
              ? "paused"
              : "pending";
        applied = this.deps.repo.updateOpenLoopStatus(decision.target_id, nextStatus);
      }

      const summary = applied
        ? `已执行调度修改: ${decision.summary}`
        : `未找到目标调度项 (${decision.target_id})，未作变更`;

      this.deps.repo.updateTicket(ticketId, {
        status: applied ? "done" : "failed",
        briefTitle: decision.summary.slice(0, 48),
        progressNote: summary,
      });

      await this.deps.bus.emit({
        type: "executed_event",
        canonicalUserId,
        channel: originChannel,
        summary,
        occurredAtMs: Date.now(),
      });
      return;
    }

    if (decision.decision === "needs_input") {
      this.deps.repo.updateTicket(ticketId, {
        status: "needs_input",
        briefTitle: decision.brief_title,
        progressNote: "等待补充信息",
        resultJson: JSON.stringify({
          ticket_id: ticketId,
          status: "needs_input",
          narration_hint: decision.question,
          verbatim_blocks: [],
          artifacts: [],
          required_secrets: [],
          caveats: [],
          question: decision.question,
        } satisfies WorkerResult),
      });
      await this.deps.bus.emit({
        type: "ticket_needs_input",
        canonicalUserId,
        originChannel,
        ticketId,
        briefTitle: decision.brief_title,
        question: decision.question,
      });
      return;
    }

    const cfg = this.deps.getHatoConfig();
    const contextId = `ctx_${ticketId}`;
    const mandate = buildMandateFromRouterDecision(cfg, ticketId, decision);
    if (deliverFiles) {
      mandate.deliver_files = true;
    }

    this.deps.repo.updateTicket(ticketId, {
      status: "running",
      backend: decision.backend,
      briefTitle: decision.brief_title,
      contextId,
      contextFromMsgId: decision.context_range.from_msg_id,
      contextToMsgId: decision.context_range.to_msg_id,
      progressNote: `已派发给 ${decision.backend} 执行`,
      mandateJson: JSON.stringify(mandate),
      workspaceExpiresAt: Date.now() + cfg.worker.workspace_ttl_days * 24 * 60 * 60 * 1000,
    });

    logInfo("DISPATCH", `ticket=${ticketId} backend=${decision.backend} ctx=${contextId}`);

    let result: WorkerResult;
    const workerStartPerf = performance.now();
    try {
      result = await this.deps.dispatcher.execute(
        {
          ticketId,
          canonicalUserId,
          backend: decision.backend,
          briefTitle: decision.brief_title,
          contextId,
          externalSessionId: null,
        },
        mandate,
        {
          onSessionId: (sid) => {
            this.deps.repo.updateTicket(ticketId, { externalSessionId: sid });
          },
          onProgress: (note) => {
            this.deps.repo.updateTicket(ticketId, { progressNote: note });
          },
        },
      );
    } catch (err) {
      result = {
        ticket_id: ticketId,
        status: "failed",
        narration_hint: `后台执行异常：${summarizeError(err)}`,
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: [summarizeError(err)],
      };
    }

    this.recordWorkerTrace({
      ticketId,
      canonicalUserId,
      backend: decision.backend,
      briefTitle: decision.brief_title,
      mandate,
      contextRange: decision.context_range,
      result,
      latencyMs: Math.max(1, Math.round(performance.now() - workerStartPerf)),
    });

    await this.handleWorkerOutcome(ticketId, canonicalUserId, originChannel, decision.brief_title, result);
  }

  private async runTicketResume(
    ticket: Parameters<WorkerDispatcher["resume"]>[0],
    mandate: WorkerMandate,
    originChannel: ChannelName,
    userReply: string,
  ): Promise<void> {
    let result: WorkerResult;
    const workerStartPerf = performance.now();
    try {
      result = await this.deps.dispatcher.resume(ticket, mandate, userReply, {
        onSessionId: (sid) => {
          this.deps.repo.updateTicket(ticket.ticketId, { externalSessionId: sid });
        },
        onProgress: (note) => {
          this.deps.repo.updateTicket(ticket.ticketId, { progressNote: note });
        },
      });
    } catch (err) {
      result = {
        ticket_id: ticket.ticketId,
        status: "failed",
        narration_hint: `工单续跑失败：${summarizeError(err)}`,
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: [summarizeError(err)],
      };
    }

    this.recordWorkerTrace({
      ticketId: ticket.ticketId,
      canonicalUserId: ticket.canonicalUserId,
      backend: ticket.backend,
      briefTitle: ticket.briefTitle,
      mandate,
      userReply,
      result,
      latencyMs: Math.max(1, Math.round(performance.now() - workerStartPerf)),
    });

    await this.handleWorkerOutcome(
      ticket.ticketId,
      ticket.canonicalUserId,
      originChannel,
      ticket.briefTitle,
      result,
    );
  }

  private recordWorkerTrace(params: {
    ticketId: string;
    canonicalUserId: string;
    backend: string;
    briefTitle: string;
    mandate: WorkerMandate;
    contextRange?: { from_msg_id: string; to_msg_id: string };
    userReply?: string;
    result: WorkerResult;
    latencyMs: number;
  }): void {
    const outputParts = [params.result.narration_hint];
    for (const block of params.result.verbatim_blocks) {
      outputParts.push(`**${block.title}**\n${block.content}`);
    }
    if (params.result.artifacts.length > 0) {
      outputParts.push(
        `产物: ${params.result.artifacts.map((a) => `${a.filename} (${a.path})`).join(", ")}`,
      );
    }
    if (params.result.caveats.length > 0) {
      outputParts.push(`注意: ${params.result.caveats.join("；")}`);
    }
    const outputText = outputParts.filter(Boolean).join("\n\n").trim();

    this.deps.repo.insertTurnTrace({
      canonicalUserId: params.canonicalUserId,
      slot: "worker",
      provider: params.backend,
      modelId: params.ticketId,
      api: "worker-cli",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRate: 0,
      ttftMs: null,
      tps: null,
      userPreview: `[工单 ${params.ticketId}] ${params.briefTitle}`,
      recalledIds: [],
      timeCardText: [
        `ticket_id: ${params.ticketId}`,
        `backend: ${params.backend}`,
        `status: ${params.result.status}`,
        `workspace_mode: ${params.mandate.workspace_mode}`,
        `workspace_dir: ${params.mandate.workspace_dir}`,
        params.contextRange
          ? `context_range: ${params.contextRange.from_msg_id} .. ${params.contextRange.to_msg_id}`
          : "",
        params.userReply ? `user_reply: ${params.userReply}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      toolCalls: [],
      steps: [
        {
          step: 1,
          kind: "assistant",
          text: outputText || `status=${params.result.status}`,
          stopReason: params.result.status === "failed" ? "error" : "stop",
          toolCalls: [],
        },
      ],
      latencyMs: params.latencyMs,
    });
  }

  private async handleWorkerOutcome(
    ticketId: string,
    canonicalUserId: string,
    originChannel: ChannelName,
    briefTitle: string,
    result: WorkerResult,
  ): Promise<void> {
    this.deps.repo.updateTicket(ticketId, {
      status: result.status,
      progressNote: result.narration_hint.slice(0, 120),
      resultJson: JSON.stringify(result),
    });

    if (result.status === "needs_input") {
      await this.deps.bus.emit({
        type: "ticket_needs_input",
        canonicalUserId,
        originChannel,
        ticketId,
        briefTitle,
        question: result.question || result.narration_hint,
      });
      return;
    }

    if (result.status === "awaiting_confirm") {
      await this.deps.bus.emit({
        type: "ticket_confirm_required",
        canonicalUserId,
        originChannel,
        ticketId,
        briefTitle,
        promptText: result.confirm_action || result.narration_hint,
      });
      return;
    }

    await this.deps.bus.emit({
      type: "ticket_result",
      canonicalUserId,
      originChannel,
      briefTitle,
      result,
    });
  }
}

function buildDefaultMandate(cfg: HatoConfig, ticketId: string): WorkerMandate {
  const extCfg = resolveWorkerExternalCliConfig(cfg);
  return {
    workspace_mode: "isolated",
    workspace_dir: resolve(cfg.paths.workspaces_dir, ticketId),
    is_host_repo: false,
    network: "egress",
    timeout_ms: extCfg.timeoutMs,
    skills: [],
    allowed_mcp_servers: [],
    confirm_before: [],
  };
}

function buildMandateFromRouterDecision(
  cfg: HatoConfig,
  ticketId: string,
  decision: Extract<RouterDecision, { decision: "ticket" }>,
): WorkerMandate {
  const extCfg = resolveWorkerExternalCliConfig(cfg);
  const executionMode = resolveWorkerExecutionMode(cfg);

  if (executionMode === "vm_unrestricted") {
    const vmWorkdir = resolveWorkerVmWorkdir(cfg);
    return {
      workspace_mode: "host_repo",
      workspace_dir: vmWorkdir,
      is_host_repo: false,
      network: "egress",
      timeout_ms: extCfg.timeoutMs,
      skills: decision.skills ?? [],
      allowed_mcp_servers: decision.allowed_mcp_servers ?? [],
      confirm_before: decision.confirm_before ?? [],
      execution_mode: "vm_unrestricted",
    };
  }

  let workspaceDir = resolve(cfg.paths.workspaces_dir, ticketId);
  let isHostRepo = false;

  if (decision.workspace_mode === "host_repo" && decision.repo_path?.trim()) {
    const candidate = resolve(decision.repo_path.trim());
    const allowed = extCfg.allowedRepos.some((rawRoot) => {
      const root = resolve(rawRoot);
      return candidate === root || candidate.startsWith(root + sep);
    });
    if (allowed && existsSync(candidate)) {
      workspaceDir = candidate;
      isHostRepo = true;
    }
  }

  return {
    workspace_mode: isHostRepo ? "host_repo" : "isolated",
    workspace_dir: workspaceDir,
    is_host_repo: isHostRepo,
    network: decision.network ?? "egress",
    timeout_ms: extCfg.timeoutMs,
    skills: decision.skills ?? [],
    allowed_mcp_servers: decision.allowed_mcp_servers ?? [],
    confirm_before: decision.confirm_before ?? [],
  };
}
