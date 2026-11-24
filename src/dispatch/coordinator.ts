import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { EventBus } from "../bus/actor-bus.js";
import {
  resolveWorkerExecutionMode,
  resolveWorkerExternalCliConfig,
  resolveWorkerVmWorkdir,
  type HatoConfig,
} from "../config/app.js";
import type { ModelRegistry } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type { HatoRepository } from "../db/repo.js";
import type { ChannelName, InboundBatch } from "../gateway/types.js";
import type { LiveTraceTracker } from "../stats/live-trace.js";
import { computeTurnMetrics } from "../stats/metrics.js";
import { logError, logInfo, summarizeError } from "../utils/logger.js";
import { workerActivityHub } from "../worker/activity-stream.js";
import type { WorkerDispatcher } from "../worker/backend.js";
import {
  generateOpenAiImage,
  resolveImageGenProvider,
  resolveProviderApiKey,
} from "../worker/image-gen.js";
import type { NeutralRouter } from "./router.js";
import {
  parseWorkerMandate,
  type RouterDecision,
  type WorkerMandate,
  type WorkerResult,
} from "./schema.js";

import type { SelfConfigInput } from "../persona/self-config.js";

export interface SensitiveFileConfirmPayload {
  kind: "send_env_file";
  channel: ChannelName;
  strictChannel?: boolean;
  path: string;
  caption?: string;
  text?: string;
}

export interface SelfConfigConfirmPayload {
  kind: "self_config";
  action: SelfConfigInput;
  summaryTitle: string;
}

export interface TicketCoordinatorDeps {
  getHatoConfig: () => HatoConfig;
  repo: HatoRepository;
  router: NeutralRouter;
  dispatcher: WorkerDispatcher;
  bus: EventBus;
  getModelRegistry?: () => ModelRegistry;
  proxyRouter?: ScopedProxyRouter;
  liveTraceTracker?: LiveTraceTracker;
  maxConcurrentTickets?: number;
  runDetached?: <T>(fn: () => T) => T;
  executeSensitiveFileConfirm?: (
    canonicalUserId: string,
    payload: SensitiveFileConfirmPayload,
  ) => Promise<{ ok: boolean; message: string }>;
  executeSelfConfigConfirm?: (
    canonicalUserId: string,
    payload: SelfConfigConfirmPayload,
  ) => Promise<{ ok: boolean; message: string }>;
}

const DEFAULT_MAX_CONCURRENT_TICKETS = 5;

/**
 * Coordinates fast `delegate()` queueing, asynchronous Neutral Router boundary setting,
 * Worker execution/resumption, `needs_input` reply classification, and confirmation callbacks.
 */
export class TicketCoordinator {
  private readonly pendingRuns = new Set<Promise<void>>();
  private readonly maxConcurrentTickets: number;

  constructor(private readonly deps: TicketCoordinatorDeps) {
    this.maxConcurrentTickets = Math.max(1, deps.maxConcurrentTickets ?? DEFAULT_MAX_CONCURRENT_TICKETS);
  }

  /**
   * Mark tickets left in `routing`/`running` from a previous crashed/restarted process as failed.
   */
  recoverStaleTickets(): number {
    return this.deps.repo.failStaleInFlightTickets();
  }

  async abortAll(): Promise<void> {
    await this.deps.dispatcher.abortAll();
  }

  private emitTicketLiveMeta(ticketId: string): void {
    const row = this.deps.repo.getTicket(ticketId);
    if (!row) return;
    const mandate = parseWorkerMandate(row.mandateJson);
    workerActivityHub.emitTicketUpdate({
      id: row.id,
      status: row.status,
      backend: row.backend,
      briefTitle: row.briefTitle,
      originChannel: row.originChannel,
      progressNote: row.progressNote,
      ...(mandate?.workspace_dir ? { workspaceDir: mandate.workspace_dir } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async abortTicket(ticketId: string): Promise<string> {
    const row = this.deps.repo.getTicket(ticketId);
    if (!row) {
      return `未找到工单 ${ticketId}`;
    }
    if (row.status === "done" || row.status === "failed" || row.status === "cancelled") {
      return `工单 ${ticketId} 已结束（${row.status}）。`;
    }
    await this.deps.dispatcher.abort(ticketId);
    this.deps.repo.updateTicket(ticketId, {
      status: "cancelled",
      progressNote: "已手动中止任务",
    });
    this.emitTicketLiveMeta(ticketId);
    return `已中止工单 ${ticketId}`;
  }

  enqueueDelegation(params: {
    canonicalUserId: string;
    originChannel: ChannelName;
    hint: string;
    urgency?: "normal" | "high";
    deliverFiles?: boolean;
  }): { ticketId: string; status: "routing" } {
    if (this.pendingRuns.size >= this.maxConcurrentTickets) {
      throw new Error(
        `当前后台并发任务已达上限 (${this.maxConcurrentTickets})，请等待已有任务完成后再派发。`,
      );
    }
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

    const detach = this.deps.runDetached ?? (<T>(fn: () => T) => fn());
    const job = detach(() =>
      this.processDelegation(ticketId, params).catch((err) => {
        logError("DISPATCH", `delegation ${ticketId} crashed`, err);
      }),
    );
    this.trackPending(job);

    return { ticketId, status: "routing" };
  }

  /**
   * Create an `awaiting_confirm` ticket for sending a sensitive `.env` file, emitting
   * a physical confirmation prompt (TG Inline Keyboard / QQ confirm prompt / Web Console).
   */
  async enqueueSensitiveFileConfirm(params: {
    canonicalUserId: string;
    channel: ChannelName;
    strictChannel?: boolean;
    path: string;
    caption?: string;
    text?: string;
  }): Promise<{ ok: boolean; ticketId: string; message: string }> {
    const ticketId = `t_${randomBytes(4).toString("hex")}`;
    const filename = basename(params.path);
    const briefTitle = `确认发送敏感文件: ${filename}`.slice(0, 48);
    const payload: SensitiveFileConfirmPayload = {
      kind: "send_env_file",
      channel: params.channel,
      strictChannel: params.strictChannel,
      path: params.path,
      caption: params.caption,
      text: params.text,
    };
    const promptText = `请求外发敏感凭据文件：${params.path}（目标通道：${params.channel.toUpperCase()}）。请确认是否允许发送该 .env 文件。`;

    this.deps.repo.createTicket({
      id: ticketId,
      canonicalUserId: params.canonicalUserId,
      status: "awaiting_confirm",
      backend: "builtin-pi",
      briefTitle,
      originChannel: params.channel,
      progressNote: "等待主人确认外发敏感 .env 文件",
    });
    this.deps.repo.updateTicket(ticketId, {
      resultJson: JSON.stringify({
        ticket_id: ticketId,
        status: "awaiting_confirm",
        narration_hint: promptText,
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: [],
        confirm_action: promptText,
        sensitive_file_confirm: payload,
      }),
    });

    await this.deps.bus.emit({
      type: "ticket_confirm_required",
      canonicalUserId: params.canonicalUserId,
      originChannel: params.channel,
      ticketId,
      briefTitle,
      promptText,
    });

    return {
      ok: true,
      ticketId,
      message: `目标文件 ${filename} 属于敏感 .env 凭据文件，已发送二次确认请求 (${ticketId})，需主人显式确认后才会发出。`,
    };
  }

  async enqueueSelfConfigConfirm(params: {
    canonicalUserId: string;
    channel: ChannelName;
    action: SelfConfigInput;
    summaryTitle: string;
    promptText: string;
  }): Promise<{ ok: boolean; ticketId: string; message: string }> {
    const ticketId = `t_${randomBytes(4).toString("hex")}`;
    const briefTitle = params.summaryTitle.slice(0, 48);
    const payload: SelfConfigConfirmPayload = {
      kind: "self_config",
      action: params.action,
      summaryTitle: briefTitle,
    };

    this.deps.repo.createTicket({
      id: ticketId,
      canonicalUserId: params.canonicalUserId,
      status: "awaiting_confirm",
      backend: "builtin-pi",
      briefTitle,
      originChannel: params.channel,
      progressNote: "等待主人确认修改设置",
    });
    this.deps.repo.updateTicket(ticketId, {
      resultJson: JSON.stringify({
        ticket_id: ticketId,
        status: "awaiting_confirm",
        narration_hint: params.promptText,
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: [],
        confirm_action: params.promptText,
        self_config_confirm: payload,
      }),
    });

    await this.deps.bus.emit({
      type: "ticket_confirm_required",
      canonicalUserId: params.canonicalUserId,
      originChannel: params.channel,
      ticketId,
      briefTitle,
      promptText: params.promptText,
    });

    return {
      ok: true,
      ticketId,
      message: `已发送设置修改确认请求 (${ticketId})：${briefTitle}，需主人点击确认按钮后才会生效。`,
    };
  }

  /**
   * Parse explicit text confirmation replies (primarily for QQ where inline keyboards are unavailable):
   * e.g. `确认 t_abcd1234`, `取消 t_abcd1234`, or bare `确认`/`取消` when exactly one ticket awaits confirm.
   */
  async tryHandleConfirmText(
    canonicalUserId: string,
    text: string,
  ): Promise<{ handled: boolean; reply?: string }> {
    const trimmed = text.trim();
    const match = /^(确认|同意|批准|取消|拒绝)(?:\s+(t_[a-zA-Z0-9_-]+))?$/i.exec(trimmed);
    if (!match) {
      return { handled: false };
    }
    const approved = ["确认", "同意", "批准"].includes(match[1]!);
    const explicitId = match[2]?.trim();

    const active = this.deps.repo
      .listActiveTickets(canonicalUserId, 10)
      .filter((t) => t.status === "awaiting_confirm");
    if (active.length === 0) {
      return { handled: false };
    }

    let targetId = explicitId;
    if (!targetId) {
      if (active.length > 1) {
        return {
          handled: true,
          reply: `当前有多个待确认工单（${active.map((t) => t.id).join(", ")}），请携带工单号回复，例如：确认 ${active[0]!.id}`,
        };
      }
      targetId = active[0]!.id;
    }

    const existsForUser = active.some((t) => t.id === targetId);
    if (!existsForUser) {
      return { handled: true, reply: `未找到待确认的工单 ${targetId}。` };
    }

    const reply = await this.handleConfirmAction(targetId, approved);
    return { handled: true, reply };
  }

  /**
   * Queues an asynchronous image generation job directly from Persona's `image_gen`
   * tool (bypassing NeutralRouter and worker LLM overhead) and delivers via `ticket_result`.
   */
  enqueueImageGeneration(params: {
    canonicalUserId: string;
    originChannel: ChannelName;
    prompt: string;
    model?: string;
    size?: string;
    quality?: string;
    n?: number;
    filename?: string;
    referenceImagePaths?: string[];
    deliverFiles?: boolean;
  }): { ticketId: string; status: "running" } {
    const cfg = this.deps.getHatoConfig();
    const ticketId = `t_${randomBytes(4).toString("hex")}`;
    const briefTitle = `绘制图片: ${params.prompt.trim().slice(0, 32) || "image"}`;
    const workspaceDir = resolve(cfg.paths.workspaces_dir, ticketId);
    const mandate = buildDefaultMandate(cfg, ticketId);
    mandate.workspace_dir = workspaceDir;
    if (params.deliverFiles) {
      mandate.deliver_files = true;
    }

    this.deps.repo.createTicket({
      id: ticketId,
      canonicalUserId: params.canonicalUserId,
      status: "running",
      backend: "builtin-pi",
      briefTitle,
      originChannel: params.originChannel,
      progressNote: "正在生成图片",
    });
    this.deps.repo.updateTicket(ticketId, {
      mandateJson: JSON.stringify(mandate),
      workspaceExpiresAt: Date.now() + cfg.worker.workspace_ttl_days * 24 * 60 * 60 * 1000,
    });

    const detach = this.deps.runDetached ?? (<T>(fn: () => T) => fn());
    const job = detach(() =>
      this.processImageGeneration(ticketId, briefTitle, workspaceDir, params).catch((err) => {
        logError("DISPATCH", `image_gen ${ticketId} crashed`, err);
      }),
    );
    this.trackPending(job);

    return { ticketId, status: "running" };
  }

  private async processImageGeneration(
    ticketId: string,
    briefTitle: string,
    workspaceDir: string,
    params: {
      canonicalUserId: string;
      originChannel: ChannelName;
      prompt: string;
      model?: string;
      size?: string;
      quality?: string;
      n?: number;
      filename?: string;
      referenceImagePaths?: string[];
    },
  ): Promise<void> {
    const startPerf = performance.now();
    const cfg = this.deps.getHatoConfig();
    const mandate = buildDefaultMandate(cfg, ticketId);
    mandate.workspace_dir = workspaceDir;

    let result: WorkerResult;
    const modelRegistry = this.deps.getModelRegistry?.();
    const proxyRouter = this.deps.proxyRouter;
    const provider = modelRegistry ? resolveImageGenProvider(modelRegistry) : null;
    const liveTraceId = `live_image_gen_${ticketId}`;

    this.deps.liveTraceTracker?.start({
      id: liveTraceId,
      canonicalUserId: params.canonicalUserId,
      slot: "worker",
      provider: provider?.slug ?? "image_gen",
      modelId: params.model ?? "gpt-image-2",
      api: "openai-images",
      userPreview: `[工单 ${ticketId}] ${briefTitle}`,
      startedAt: Date.now(),
      progressNote: "正在生成图片",
      toolCalls: ["image_gen"],
    });

    try {
      if (!provider || !proxyRouter) {
        result = {
          ticket_id: ticketId,
          status: "failed",
          narration_hint: "未找到可用的 OpenAI 兼容图片生成供应商配置。",
          verbatim_blocks: [],
          artifacts: [],
          required_secrets: [],
          caveats: ["image_gen provider unavailable"],
        };
      } else {
        try {
          mkdirSync(workspaceDir, { recursive: true });
          const apiKey = resolveProviderApiKey(provider);
          const gen = await generateOpenAiImage({
            prompt: params.prompt,
            model: params.model,
            size: params.size,
            quality: params.quality,
            n: params.n,
            filename: params.filename,
            referenceImagePaths: params.referenceImagePaths,
            workspaceDir,
            providerSlug: provider.slug,
            baseUrl: provider.baseUrl,
            apiKey,
            proxyRouter,
          });
          if (!gen.ok) {
            result = {
              ticket_id: ticketId,
              status: "failed",
              narration_hint: `图片生成失败 (${gen.model}): ${gen.error ?? "unknown error"}`,
              verbatim_blocks: [],
              artifacts: [],
              required_secrets: [],
              caveats: gen.error ? [gen.error] : [],
              trace: {
                provider: gen.providerSlug,
                modelId: gen.model,
                api: "openai-images",
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                toolCalls: ["image_gen"],
                steps: [
                  {
                    kind: "tool",
                    step: 1,
                    name: "image_gen",
                    args: {
                      prompt: params.prompt,
                      model: gen.model,
                      referenceImagePaths: params.referenceImagePaths,
                    },
                    output: `图片生成失败 (${gen.model}): ${gen.error ?? "unknown error"}`,
                    isError: true,
                  },
                ],
              },
            };
          } else {
            result = {
              ticket_id: ticketId,
              status: "done",
              narration_hint: `已完成图片生成 (${gen.providerSlug}/${gen.model})，共 ${gen.files.length} 张。`,
              verbatim_blocks: [],
              artifacts: gen.files.map((f) => ({
                path: f.path,
                filename: basename(f.path),
                send_as: "photo" as const,
              })),
              required_secrets: [],
              caveats: [],
              trace: {
                provider: gen.providerSlug,
                modelId: gen.model,
                api: "openai-images",
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                toolCalls: ["image_gen"],
                steps: [
                  {
                    kind: "tool",
                    step: 1,
                    name: "image_gen",
                    args: {
                      prompt: params.prompt,
                      model: gen.model,
                      referenceImagePaths: params.referenceImagePaths,
                    },
                    output: `已完成图片生成 (${gen.providerSlug}/${gen.model})，产物: ${gen.files.map((f) => f.path).join(", ")}`,
                  },
                ],
              },
            };
          }
        } catch (err) {
          result = {
            ticket_id: ticketId,
            status: "failed",
            narration_hint: `图片生成异常：${summarizeError(err)}`,
            verbatim_blocks: [],
            artifacts: [],
            required_secrets: [],
            caveats: [summarizeError(err)],
          };
        }
      }
    } finally {
      this.deps.liveTraceTracker?.finish(liveTraceId);
    }

    this.recordWorkerTrace({
      ticketId,
      canonicalUserId: params.canonicalUserId,
      backend: "builtin-pi",
      briefTitle,
      mandate,
      result,
      latencyMs: Math.max(1, Math.round(performance.now() - startPerf)),
    });

    await this.handleWorkerOutcome(
      ticketId,
      params.canonicalUserId,
      params.originChannel,
      briefTitle,
      result,
    );
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

    const detach = this.deps.runDetached ?? (<T>(fn: () => T) => fn());
    const job = detach(() =>
      this.runTicketResume(
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
      }),
    );
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

    const sensitivePayload = parseSensitiveFileConfirmPayload(ticket.resultJson);
    if (sensitivePayload) {
      if (!this.deps.executeSensitiveFileConfirm) {
        this.deps.repo.updateTicket(ticketId, {
          status: "failed",
          progressNote: "缺少敏感文件发送执行器",
        });
        return `工单 ${ticketId} 执行失败：未接入文件发送通道。`;
      }
      this.deps.repo.updateTicket(ticketId, {
        status: "running",
        progressNote: "主人已确认，正在发送敏感文件",
      });
      try {
        const res = await this.deps.executeSensitiveFileConfirm(
          ticket.canonicalUserId,
          sensitivePayload,
        );
        this.deps.repo.updateTicket(ticketId, {
          status: res.ok ? "done" : "failed",
          progressNote: res.message.slice(0, 120),
        });
        return res.ok ? `已确认并执行：${res.message}` : `发送失败：${res.message}`;
      } catch (err) {
        const msg = summarizeError(err);
        this.deps.repo.updateTicket(ticketId, {
          status: "failed",
          progressNote: msg.slice(0, 120),
        });
        return `发送失败：${msg}`;
      }
    }

    const selfConfigPayload = parseSelfConfigConfirmPayload(ticket.resultJson);
    if (selfConfigPayload) {
      if (!this.deps.executeSelfConfigConfirm) {
        this.deps.repo.updateTicket(ticketId, {
          status: "failed",
          progressNote: "缺少设置修改执行器",
        });
        return `工单 ${ticketId} 执行失败：未接入设置修改执行器。`;
      }
      this.deps.repo.updateTicket(ticketId, {
        status: "running",
        progressNote: "主人已确认，正在应用设置修改",
      });
      try {
        const res = await this.deps.executeSelfConfigConfirm(
          ticket.canonicalUserId,
          selfConfigPayload,
        );
        this.deps.repo.updateTicket(ticketId, {
          status: res.ok ? "done" : "failed",
          progressNote: res.message.slice(0, 120),
        });
        return res.ok ? `已确认并执行：${res.message}` : `执行失败：${res.message}`;
      } catch (err) {
        const msg = summarizeError(err);
        this.deps.repo.updateTicket(ticketId, {
          status: "failed",
          progressNote: msg.slice(0, 120),
        });
        return `执行失败：${msg}`;
      }
    }

    const cfg = this.deps.getHatoConfig();
    const mandate =
      parseWorkerMandate(ticket.mandateJson) ?? buildDefaultMandate(cfg, ticket.id);
    this.deps.repo.updateTicket(ticketId, {
      status: "running",
      progressNote: "用户已确认，恢复执行",
    });

    const detach = this.deps.runDetached ?? (<T>(fn: () => T) => fn());
    const job = detach(() =>
      this.runTicketResume(
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
      }),
    );
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
    this.emitTicketLiveMeta(ticketId);

    logInfo("DISPATCH", `ticket=${ticketId} backend=${decision.backend} ctx=${contextId}`);

    const extLiveTraceId =
      decision.backend !== "builtin-pi" ? `live_worker_${ticketId}` : null;
    if (extLiveTraceId) {
      this.deps.liveTraceTracker?.start({
        id: extLiveTraceId,
        canonicalUserId,
        slot: "worker",
        provider: decision.backend,
        modelId: decision.backend,
        api: "worker-cli",
        userPreview: `[工单 ${ticketId}] ${decision.brief_title}`,
        startedAt: Date.now(),
        progressNote: `已派发给 ${decision.backend} 执行`,
      });
    }

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
            this.emitTicketLiveMeta(ticketId);
            if (extLiveTraceId) {
              this.deps.liveTraceTracker?.update(extLiveTraceId, { progressNote: note });
            }
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
    } finally {
      if (extLiveTraceId) {
        this.deps.liveTraceTracker?.finish(extLiveTraceId);
      }
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
    this.emitTicketLiveMeta(ticket.ticketId);
    const extLiveTraceId =
      ticket.backend !== "builtin-pi" ? `live_worker_${ticket.ticketId}` : null;
    if (extLiveTraceId) {
      this.deps.liveTraceTracker?.start({
        id: extLiveTraceId,
        canonicalUserId: ticket.canonicalUserId,
        slot: "worker",
        provider: ticket.backend,
        modelId: ticket.backend,
        api: "worker-cli",
        userPreview: `[工单 ${ticket.ticketId}] ${ticket.briefTitle}`,
        startedAt: Date.now(),
        progressNote: "正在续跑后台任务",
      });
    }

    let result: WorkerResult;
    const workerStartPerf = performance.now();
    try {
      result = await this.deps.dispatcher.resume(ticket, mandate, userReply, {
        onSessionId: (sid) => {
          this.deps.repo.updateTicket(ticket.ticketId, { externalSessionId: sid });
        },
        onProgress: (note) => {
          this.deps.repo.updateTicket(ticket.ticketId, { progressNote: note });
          this.emitTicketLiveMeta(ticket.ticketId);
          if (extLiveTraceId) {
            this.deps.liveTraceTracker?.update(extLiveTraceId, { progressNote: note });
          }
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
    } finally {
      if (extLiveTraceId) {
        this.deps.liveTraceTracker?.finish(extLiveTraceId);
      }
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

    const workerTrace = params.result.trace;
    const steps =
      workerTrace && workerTrace.steps.length > 0
        ? workerTrace.steps
        : [
            {
              step: 1,
              kind: "assistant" as const,
              text: outputText || `status=${params.result.status}`,
              stopReason: params.result.status === "failed" ? "error" : "stop",
              toolCalls: [],
            },
          ];

    const workerMetrics = workerTrace
      ? computeTurnMetrics({
          inputTokens: workerTrace.inputTokens,
          outputTokens: workerTrace.outputTokens,
          cacheReadTokens: workerTrace.cacheReadTokens,
          cacheWriteTokens: workerTrace.cacheWriteTokens,
          latencyMs: params.latencyMs,
        })
      : null;

    this.deps.repo.insertTurnTrace({
      canonicalUserId: params.canonicalUserId,
      slot: "worker",
      provider: workerTrace?.provider ?? params.backend,
      modelId: workerTrace?.modelId ?? params.backend,
      api: workerTrace?.api ?? "worker-cli",
      inputTokens: workerTrace?.inputTokens ?? 0,
      outputTokens: workerTrace?.outputTokens ?? 0,
      cacheReadTokens: workerTrace?.cacheReadTokens ?? 0,
      cacheWriteTokens: workerTrace?.cacheWriteTokens ?? 0,
      cacheHitRate: workerMetrics?.cacheHitRate ?? 0,
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
      toolCalls: workerTrace?.toolCalls ?? [],
      steps,
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
    if (this.deps.repo.getTicket(ticketId)?.status === "cancelled") {
      this.emitTicketLiveMeta(ticketId);
      return;
    }
    const { trace: _trace, ...persistedResult } = result;
    this.deps.repo.updateTicket(ticketId, {
      status: result.status,
      progressNote: result.narration_hint.slice(0, 120),
      resultJson: JSON.stringify(persistedResult),
    });
    this.emitTicketLiveMeta(ticketId);

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
    if (existsSync(candidate)) {
      let realCandidate = candidate;
      try {
        realCandidate = realpathSync(candidate);
      } catch {
        realCandidate = candidate;
      }
      const allowed = extCfg.allowedRepos.some((rawRoot) => {
        const root = resolve(rawRoot);
        let realRoot = root;
        try {
          if (existsSync(root)) realRoot = realpathSync(root);
        } catch {
          realRoot = root;
        }
        return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
      });
      if (allowed) {
        workspaceDir = realCandidate;
        isHostRepo = true;
      }
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

function parseSensitiveFileConfirmPayload(
  resultJson: string | null | undefined,
): SensitiveFileConfirmPayload | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as {
      sensitive_file_confirm?: Partial<SensitiveFileConfirmPayload>;
    };
    const payload = parsed?.sensitive_file_confirm;
    if (
      payload &&
      payload.kind === "send_env_file" &&
      typeof payload.path === "string" &&
      (payload.channel === "tg" || payload.channel === "qq" || payload.channel === "web")
    ) {
      return {
        kind: "send_env_file",
        channel: payload.channel,
        strictChannel: Boolean(payload.strictChannel),
        path: payload.path,
        caption: typeof payload.caption === "string" ? payload.caption : undefined,
        text: typeof payload.text === "string" ? payload.text : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function parseSelfConfigConfirmPayload(
  resultJson: string | null | undefined,
): SelfConfigConfirmPayload | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as {
      self_config_confirm?: Partial<SelfConfigConfirmPayload>;
    };
    const payload = parsed?.self_config_confirm;
    if (
      payload &&
      payload.kind === "self_config" &&
      payload.action &&
      typeof payload.action === "object" &&
      typeof payload.action.action === "string" &&
      typeof payload.summaryTitle === "string"
    ) {
      return {
        kind: "self_config",
        action: payload.action,
        summaryTitle: payload.summaryTitle,
      };
    }
  } catch {
    return null;
  }
  return null;
}
