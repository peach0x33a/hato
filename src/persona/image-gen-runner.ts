import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { EventBus } from "../bus/actor-bus.js";
import { resolveWorkerExternalCliConfig, type HatoConfig } from "../config/app.js";
import type { ModelRegistry } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type { TicketActivitySink, WorkerMandate, WorkerResult } from "../contracts/worker.js";
import type { HatoRepository } from "../db/repo.js";
import type { ChannelName } from "../gateway/types.js";
import {
  generateOpenAiImage,
  resolveImageGenProvider,
  resolveProviderApiKey,
} from "../media/image-gen.js";
import type { LiveTraceTracker } from "../stats/live-trace.js";
import { computeTurnMetrics } from "../stats/metrics.js";
import { logError, summarizeError } from "../utils/logger.js";

export interface ImageGenJobRunnerDeps {
  getHatoConfig: () => HatoConfig;
  repo: HatoRepository;
  bus: EventBus;
  getModelRegistry: () => ModelRegistry;
  proxyRouter: ScopedProxyRouter;
  liveTraceTracker?: LiveTraceTracker;
  activitySink?: TicketActivitySink;
  runDetached?: <T>(fn: () => T) => T;
}

export interface ImageGenJobInput {
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
}

/**
 * Executes Persona's asynchronous `image_gen` jobs outside `TicketCoordinator`,
 * keeping creative media generation decoupled from engineering ticket routing.
 */
export class ImageGenJobRunner {
  private readonly pendingRuns = new Set<Promise<void>>();
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(private readonly deps: ImageGenJobRunnerDeps) {}

  async drainPending(): Promise<void> {
    if (this.pendingRuns.size === 0) return;
    await Promise.allSettled([...this.pendingRuns]);
  }

  async abortTicket(ticketId: string): Promise<string> {
    const row = this.deps.repo.getTicket(ticketId);
    if (!row) {
      return `未找到生图工单 ${ticketId}`;
    }
    if (row.status === "done" || row.status === "failed" || row.status === "cancelled") {
      return `生图工单 ${ticketId} 已结束（${row.status}）。`;
    }
    const controller = this.activeControllers.get(ticketId);
    if (controller) {
      controller.abort(new Error("Image generation cancelled by user"));
    }
    this.deps.repo.updateTicket(ticketId, {
      status: "cancelled",
      progressNote: "已手动中止生图任务",
    });
    this.emitLiveMeta(ticketId);
    return `已中止生图工单 ${ticketId}`;
  }

  async abortActiveForUser(
    canonicalUserId: string,
  ): Promise<Array<{ id: string; briefTitle: string }>> {
    const activeIds = [...this.activeControllers.keys()];
    const stopped: Array<{ id: string; briefTitle: string }> = [];
    for (const ticketId of activeIds) {
      const row = this.deps.repo.getTicket(ticketId);
      if (!row || row.canonicalUserId !== canonicalUserId) continue;
      if (row.status === "done" || row.status === "failed" || row.status === "cancelled") continue;
      await this.abortTicket(ticketId);
      stopped.push({ id: row.id, briefTitle: row.briefTitle });
    }
    return stopped;
  }

  enqueue(params: ImageGenJobInput): { ticketId: string; status: "running" } {
    const cfg = this.deps.getHatoConfig();
    const ticketId = `t_${randomBytes(4).toString("hex")}`;
    const briefTitle = `绘制图片: ${params.prompt.trim().slice(0, 32) || "image"}`;
    const workspaceDir = resolve(cfg.paths.workspaces_dir, ticketId);
    const extCfg = resolveWorkerExternalCliConfig(cfg);
    const mandate: WorkerMandate = {
      workspace_mode: "isolated",
      workspace_dir: workspaceDir,
      is_host_repo: false,
      network: "egress",
      timeout_ms: extCfg.timeoutMs,
      skills: [],
      allowed_mcp_servers: [],
      confirm_before: [],
      ...(params.deliverFiles ? { deliver_files: true } : {}),
    };

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
      this.processImageGeneration(ticketId, briefTitle, workspaceDir, mandate, params).catch((err) => {
        logError("IMAGE_GEN", `image_gen ${ticketId} crashed`, err);
      }),
    );
    this.pendingRuns.add(job);
    void job.finally(() => {
      this.pendingRuns.delete(job);
    });

    return { ticketId, status: "running" };
  }

  private emitLiveMeta(ticketId: string, workspaceDir?: string): void {
    const row = this.deps.repo.getTicket(ticketId);
    if (!row) return;
    this.deps.activitySink?.emitTicketUpdate({
      id: row.id,
      status: row.status,
      backend: row.backend,
      briefTitle: row.briefTitle,
      originChannel: row.originChannel,
      progressNote: row.progressNote,
      ...(workspaceDir ? { workspaceDir } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private async processImageGeneration(
    ticketId: string,
    briefTitle: string,
    workspaceDir: string,
    mandate: WorkerMandate,
    params: ImageGenJobInput,
  ): Promise<void> {
    const startPerf = performance.now();
    const modelRegistry = this.deps.getModelRegistry();
    const proxyRouter = this.deps.proxyRouter;
    const provider = resolveImageGenProvider(modelRegistry);
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

    const controller = new AbortController();
    this.activeControllers.set(ticketId, controller);

    let result: WorkerResult;
    try {
      if (!provider) {
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
            signal: controller.signal,
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
      this.activeControllers.delete(ticketId);
      this.deps.liveTraceTracker?.finish(liveTraceId);
    }

    const latencyMs = Math.max(1, Math.round(performance.now() - startPerf));
    if (result.trace) {
      const metrics = computeTurnMetrics({
        inputTokens: result.trace.inputTokens,
        outputTokens: result.trace.outputTokens,
        cacheReadTokens: result.trace.cacheReadTokens,
        cacheWriteTokens: result.trace.cacheWriteTokens,
        latencyMs,
      });
      this.deps.repo.insertTurnTrace({
        canonicalUserId: params.canonicalUserId,
        slot: "worker",
        provider: result.trace.provider,
        modelId: result.trace.modelId,
        api: result.trace.api,
        userPreview: `[工单 ${ticketId}] ${briefTitle}`,
        inputTokens: result.trace.inputTokens,
        outputTokens: result.trace.outputTokens,
        cacheReadTokens: result.trace.cacheReadTokens,
        cacheWriteTokens: result.trace.cacheWriteTokens,
        cacheHitRate: metrics.cacheHitRate,
        latencyMs,
        toolCalls: result.trace.toolCalls,
        recalledIds: [],
        timeCardText: "",
        steps: result.trace.steps,
      });
    }

    if (this.deps.repo.getTicket(ticketId)?.status === "cancelled") {
      this.emitLiveMeta(ticketId, mandate.workspace_dir);
      return;
    }

    const { trace: _trace, ...persistedResult } = result;
    this.deps.repo.updateTicket(ticketId, {
      status: result.status,
      progressNote: result.narration_hint.slice(0, 120),
      resultJson: JSON.stringify(persistedResult),
    });
    this.emitLiveMeta(ticketId, mandate.workspace_dir);

    await this.deps.bus.emit({
      type: "ticket_result",
      canonicalUserId: params.canonicalUserId,
      originChannel: params.originChannel,
      briefTitle,
      result,
    });
  }
}
