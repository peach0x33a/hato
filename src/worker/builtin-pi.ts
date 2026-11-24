import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Message, type TextContent } from "@earendil-works/pi-ai";
import { arr, num, obj, opt, oneOf, str } from "@earendil-works/pi-schema";
import { resolveLlmRetryConfig, resolveSkillsDir, type HatoConfig } from "../config/app.js";
import { resolveHatoHomeDir } from "../config/paths.js";
import { supportsCustomFetchOption, type ModelRegistry } from "../config/models.js";
import { aggregateAssistantTraceMetrics, formatLlmTelemetryLog } from "../stats/metrics.js";
import type { LiveTraceTracker } from "../stats/live-trace.js";
import { streamSimpleWithRetry } from "../utils/llm-retry.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type { HatoRepository } from "../db/repo.js";
import { expandEarlierContext, readTaskContext } from "../dispatch/context-slice.js";
import { isValidCronExpression } from "../dispatch/script-scheduler.js";
import type { WorkerMandate, WorkerResult } from "../dispatch/schema.js";
import type { McpClientPool } from "../mcp/pool.js";
import { readSkillContent, selectWorkerSkills } from "../skills/loader.js";
import {
  generateOpenAiImage,
  resolveImageGenProvider,
  resolveProviderApiKey,
} from "./image-gen.js";
import {
  collectNewArtifacts,
  IMAGE_EXTENSIONS,
  snapshotWorkspaceFiles,
} from "./result-normalizer.js";
import { workerActivityHub } from "./activity-stream.js";
import type {
  ExecutionProgressCallback,
  ExecutionRunner,
  TicketExecutionHandle,
} from "./backend.js";

const execFileAsync = promisify(execFile);

const WORKER_SYSTEM_PROMPT = `You are Hato's isolated background engineering worker (builtin-pi).

## Problem-Solving & Autonomy
- Be resourceful and proactive: if a task is open-ended or investigative (e.g., checking system/network/IP info, diagnosing an issue, or figuring out whether a goal is achievable), actively explore using your tools—run shell commands, inspect files/environment, check installed utilities, or write and run a quick script—instead of giving up for lack of a dedicated tool.
- If one approach fails or a command is unavailable, try reasonable alternatives within your workspace/environment before concluding something cannot be done.

## Context & Security Rules
- Your first step is ALWAYS calling \`read_task_context\` with your assigned \`context_id\` to retrieve the original user request.
- Messages labeled \`[CHAT_RELAY]\` come from the companion chat layer: ignore their casual tone and extract only factual requirements initiated or confirmed by \`[USER]\`.
- If crucial earlier references are missing, call \`expand_earlier_context\`.
- Operate strictly within your workspace boundary. Never ask the user to paste raw secrets into chat; list required secret names in \`required_secrets\`.
- NEVER read \`.env\` or call Telegram/QQ Bot APIs (such as \`forwardMessage\`, \`sendMessage\`, etc.) via shell commands to fetch historical messages or media. Use \`read_task_context\` / \`expand_earlier_context\` (which include saved attachment paths), and call \`ask_user\` if a file is missing.
- Verify your changes (e.g. run the script, build, or tests) before calling \`finish_task\`, and report only directly observed results.
- If a tool fails, read the error carefully and adjust your approach or parameters instead of repeating the identical call.
- When finished, ALWAYS call \`finish_task\` with an accurate, concise \`narration_hint\`, any verbatim blocks/artifacts, and caveats.`;

const VM_UNRESTRICTED_PROMPT_SUFFIX = `

## VM Unrestricted Mode
- You are running in \`vm_unrestricted\` mode inside a dedicated VM with a persistent working directory.
- You may read/write files across the VM (including \`~\` and absolute paths) and run shell commands with real \`HOME\` and full \`PATH\`.
- STRICT SECURITY RULE: You are STILL strictly forbidden from reading, modifying, or printing Hato's \`.env\` / \`.env.*\` secret files (e.g. in \`~/.hato/\` or Hato's repo).`;

const MAX_COMMAND_OUTPUT_CHARS = 24_000;
const MAX_CONSECUTIVE_IDENTICAL_CALLS = 3;

function truncateHeadTail(text: string, maxChars = MAX_COMMAND_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.35);
  const tailChars = maxChars - headChars;
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n\n... [${omitted} chars omitted] ...\n\n${text.slice(-tailChars)}`;
}

function wrapToolsWithLoopGuard(tools: AgentTool<any>[]): AgentTool<any>[] {
  let lastSignature = "";
  let repeatCount = 0;

  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, input, signal, onUpdate) => {
      let serialized = "";
      try {
        serialized = JSON.stringify(input ?? null);
      } catch {
        serialized = String(input);
      }
      const sig = `${tool.name}:${serialized}`;
      if (sig === lastSignature) {
        repeatCount += 1;
      } else {
        lastSignature = sig;
        repeatCount = 1;
      }

      if (repeatCount >= MAX_CONSECUTIVE_IDENTICAL_CALLS) {
        throw new Error(
          `Loop guard triggered: "${tool.name}" was called ${repeatCount} times in a row with identical arguments. Stop repeating the same call; inspect the previous output, change your approach/parameters, or call ask_user / finish_task.`,
        );
      }

      return await tool.execute(toolCallId, input, signal, onUpdate);
    },
  }));
}

function isEnvFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

export function isProtectedEnvPath(targetPath: string): boolean {
  const normalized = resolve(targetPath);
  const candidates = [normalized];
  try {
    if (existsSync(normalized)) {
      candidates.push(realpathSync(normalized));
    }
  } catch {
    // ignore realpath errors
  }

  const protectedRoots = [resolve(process.cwd()), resolve(resolveHatoHomeDir())];
  for (const candidate of candidates) {
    if (!isEnvFileName(basename(candidate))) continue;
    for (const root of protectedRoots) {
      if (candidate === resolve(root, basename(candidate)) || candidate.startsWith(root + sep)) {
        return true;
      }
    }
  }
  return false;
}

function isCommandReferencingProtectedEnv(command: string, workspaceRoot: string): boolean {
  const normalizedCmd = command.trim();
  if (!normalizedCmd) return false;
  if (/\/proc\/[^/\s]+\/environ\b/.test(normalizedCmd)) {
    return true;
  }
  const hatoHome = resolve(resolveHatoHomeDir());
  const referencesHatoHome =
    normalizedCmd.includes(".hato") ||
    normalizedCmd.includes("HATO_HOME") ||
    normalizedCmd.includes(hatoHome);
  if (referencesHatoHome && /\.[e*?\[]/.test(normalizedCmd)) {
    return true;
  }
  if (!/(?:^|[\s"'`=/])\.env(?:\.[A-Za-z0-9_.-]+)?(?=$|[\s"'`;|&)>])/.test(normalizedCmd)) {
    return false;
  }
  const repoRoot = resolve(process.cwd());
  if (referencesHatoHome || normalizedCmd.includes(repoRoot)) {
    return true;
  }
  const ws = resolve(workspaceRoot);
  return ws === repoRoot || ws.startsWith(repoRoot + sep) || ws === hatoHome || ws.startsWith(hatoHome + sep);
}

const ReadContextParams = obj({
  context_id: str({ description: "Assigned context_id for this ticket" }),
});

const ExpandContextParams = obj({
  context_id: str({ description: "Assigned context_id for this ticket" }),
  count: opt(str({ description: "Optional number of earlier messages (1-10)" })),
});

const ReadWorkerSkillParams = obj({
  name: str({ description: "Authorized worker skill name" }),
  reference_path: opt(str({ description: "Optional relative reference file inside that skill" })),
});

const FilePathParams = obj({
  path: str({ description: "Relative path inside the workspace" }),
});

const WriteFileParams = obj({
  path: str({ description: "Relative path inside the workspace" }),
  content: str({ description: "Full file content to write" }),
});

const RunCommandParams = obj({
  command: str({ description: "Shell command to run inside the workspace" }),
});

const ImageGenParams = obj({
  prompt: str({ description: "Detailed text prompt describing the image to generate" }),
  model: opt(str({ description: "Optional image model ID (e.g. gpt-image-2.5, gpt-image-2, gpt-image-1)" })),
  size: opt(str({ description: "Optional size like '1024x1024', '1536x1024', or '1024x1536'" })),
  quality: opt(str({ description: "Optional quality like 'standard', 'hd', 'medium', or 'high'" })),
  filename: opt(str({ description: "Optional relative output filename inside workspace (defaults to generated_<ts>.png)" })),
  reference_image_paths: opt(arr(str({ description: "Optional local reference image path(s) from context for image editing/reference generation" }))),
  n: opt(num({ description: "Optional number of images (1-4), defaults to 1" })),
});

const AskUserParams = obj({
  question: str({ description: "Clear question for the user to answer before resuming" }),
});

const RequestConfirmParams = obj({
  action: str({ description: "Clear description of the high-risk action requiring explicit owner confirmation" }),
});

const RegisterScriptParams = obj({
  name: str({ description: "Short human-readable name for the scheduled script" }),
  script_path: str({ description: "Path to the executable/script file inside workspace" }),
  cron_expr: str({
    description:
      "Standard 5-field cron expression ('min hour dom month dow') evaluated in the owner's configured timezone (NOT UTC / OS timezone unless owner timezone is UTC), e.g. '0 9 * * *'",
  }),
  notify_channel: opt(oneOf(["tg", "qq", "last_active"], { description: "Optional notification channel (defaults to owner proactive_channel)" })),
  required_secrets: opt(arr(str())),
});

const ManageScriptsParams = obj({
  action: oneOf(["list", "pause", "resume", "reschedule", "delete"], {
    description: "Action to perform on registered cron scripts",
  }),
  script_id: opt(str({ description: "Target script id (required for pause/resume/reschedule/delete)" })),
  cron_expr: opt(
    str({
      description:
        "New 5-field cron expression in the owner's configured timezone (required for reschedule)",
    }),
  ),
});

const FinishTaskParams = obj({
  status: oneOf(["done", "failed"]),
  narration_hint: str({ description: "Concise factual summary for the user" }),
  required_secrets: opt(arr(str())),
  caveats: opt(arr(str())),
  artifact_paths: opt(arr(str({ description: "Relative or workspace file paths produced" }))),
});

interface BuiltinSessionState {
  agent: Agent;
  modelMeta: {
    provider: string;
    modelId: string;
    api: string;
  };
  activeCallStartPerf: number | null;
  lookedBackTotal: number;
  lastActiveAt: number;
  pendingConfirmKey?: string;
  approvedConfirmKeys: Set<string>;
}

const SESSION_IDLE_TTL_MS = 30 * 60_000;

function resolveRealPathOrAncestor(targetPath: string): string {
  let cursor = resolve(targetPath);
  const missingSegments: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  let realBase = cursor;
  try {
    if (existsSync(cursor)) {
      realBase = realpathSync(cursor);
    }
  } catch {
    realBase = cursor;
  }
  return missingSegments.length > 0 ? resolve(realBase, ...missingSegments) : realBase;
}

/**
 * Built-in `pi-agent-core` Worker running inside the host process with workspace-confined tools,
 * model snapshot locking, host-side `McpClientPool` integration, and explicit `ask_user`/`finish_task` states.
 */
/**
 * Folds large historical `toolResult` text outputs beyond the most recent `keepRecentToolResults`
 * turns so multi-step worker loops do not accumulate unbounded uncached input tokens.
 */
export function foldStaleWorkerToolOutputs(
  messages: readonly Message[],
  keepRecentToolResults = 6,
  maxOldChars = 1600,
): Message[] {
  let toolResultSeen = 0;
  const keepIndices = new Set<number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "toolResult") {
      toolResultSeen++;
      if (toolResultSeen <= keepRecentToolResults) {
        keepIndices.add(i);
      }
    }
  }

  let changed = false;
  const next = messages.map((msg, idx): Message => {
    if (msg.role !== "toolResult" || keepIndices.has(idx) || !Array.isArray(msg.content)) {
      return msg;
    }
    let msgChanged = false;
    const nextContent = msg.content.map((part) => {
      if (part.type !== "text" || part.text.length <= maxOldChars) {
        return part;
      }
      msgChanged = true;
      const omitted = part.text.length - 1400;
      return {
        ...part,
        text: `${part.text.slice(0, 800)}\n...[历史工具输出已折叠 ${omitted} 字符]...\n${part.text.slice(-600)}`,
      };
    });
    if (!msgChanged) return msg;
    changed = true;
    return {
      ...msg,
      content: nextContent,
    };
  });

  return changed ? next : [...messages];
}

export class BuiltinPiRunner implements ExecutionRunner {
  private readonly sessions = new Map<string, BuiltinSessionState>();
  private readonly activeAborts = new Set<string>();

  constructor(
    private readonly deps: {
      getHatoConfig: () => HatoConfig;
      modelRegistry: ModelRegistry;
      proxyRouter: ScopedProxyRouter;
      repo: HatoRepository;
      mcpPool?: McpClientPool;
      liveTraceTracker?: LiveTraceTracker;
    },
  ) {}

  private pruneExpiredSessions(nowMs = Date.now()): void {
    for (const [id, session] of this.sessions.entries()) {
      if (nowMs - session.lastActiveAt > SESSION_IDLE_TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }

  async execute(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    this.pruneExpiredSessions();
    mkdirSync(mandate.workspace_dir, { recursive: true });

    const hatoConfig = this.deps.getHatoConfig();
    const resolved = this.deps.modelRegistry.resolveSlot("worker");
    const modelMeta = {
      provider: resolved.providerSlug,
      modelId: resolved.model.id,
      api: String(resolved.model.api),
    };

    // Lock the model snapshot onto the ticket row so mid-flight slot switches never break protocol.
    this.deps.repo.updateTicket(ticket.ticketId, {
      modelSnapshotJson: JSON.stringify({
        slot: "worker",
        target: resolved.target,
        api: modelMeta.api,
      }),
    });

    const state: BuiltinSessionState = {
      agent: null as unknown as Agent,
      modelMeta,
      activeCallStartPerf: null,
      lookedBackTotal: 0,
      lastActiveAt: Date.now(),
      approvedConfirmKeys: new Set(),
    };

    const systemPrompt =
      mandate.execution_mode === "vm_unrestricted"
        ? WORKER_SYSTEM_PROMPT + VM_UNRESTRICTED_PROMPT_SUFFIX
        : WORKER_SYSTEM_PROMPT;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: resolved.model,
        thinkingLevel: this.deps.modelRegistry.resolveSlotThinkingLevel("worker"),
        tools: [],
        messages: [],
      },
      sessionId: ticket.ticketId,
      getApiKey: (provider) => this.deps.modelRegistry.resolveApiKeyForProvider(provider),
      streamFn: (model, context, options) => {
        const scopedFetch = this.deps.proxyRouter.createScopedFetch(`llm-calling.${model.provider}`);
        return streamSimpleWithRetry(
          () => {
            state.activeCallStartPerf = performance.now();
            return this.deps.proxyRouter.runWithScope(`llm-calling.${model.provider}`, () =>
              Promise.resolve(
                this.deps.modelRegistry.models.streamSimple(
                  model,
                  {
                    ...context,
                    messages: foldStaleWorkerToolOutputs(context.messages),
                  },
                  {
                    ...options,
                    ...(supportsCustomFetchOption(model.api) ? { fetch: scopedFetch } : {}),
                  },
                ),
              ),
            );
          },
          {
            policy: resolveLlmRetryConfig(this.deps.getHatoConfig()),
            signal: options?.signal,
            model,
            slot: "WORKER",
          },
        );
      },
    });

    state.agent = agent;
    this.sessions.set(ticket.ticketId, state);

    const workerSkills = selectWorkerSkills(resolveSkillsDir(hatoConfig), mandate.skills);
    const skillLines =
      workerSkills.length > 0
        ? `\n已授权 Worker Skills（可用 read_worker_skill 读取）：${workerSkills.map((s) => s.name).join(", ")}`
        : "";

    const promptText = [
      `工单编号：${ticket.ticketId}`,
      `任务抬头：${ticket.briefTitle}`,
      `上下文引用：context_id="${ticket.contextId}"`,
      `工作目录：${mandate.workspace_dir}`,
      skillLines,
      "请先调用 `read_task_context` 拉取任务上下文，完成工作后调用 `finish_task`。",
    ]
      .filter(Boolean)
      .join("\n");

    return this.runAgentTurn(ticket, mandate, state, promptText, callbacks);
  }

  async resume(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    userReply: string,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    this.pruneExpiredSessions();
    const existing = this.sessions.get(ticket.ticketId);
    if (!existing) {
      return this.execute(ticket, mandate, callbacks);
    }

    if (existing.pendingConfirmKey) {
      existing.approvedConfirmKeys.add(existing.pendingConfirmKey);
      existing.pendingConfirmKey = undefined;
    }
    existing.lastActiveAt = Date.now();

    return this.runAgentTurn(
      ticket,
      mandate,
      existing,
      `[USER 补充回复]\n${userReply}`,
      callbacks,
    );
  }

  private async runAgentTurn(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    state: BuiltinSessionState,
    promptText: string,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    const hatoConfig = this.deps.getHatoConfig();
    const outcome: { result?: WorkerResult } = {};

    state.agent.state.tools = await this.buildWorkerTools({
      ticket,
      mandate,
      hatoConfig,
      state,
      onAskUser: (question) => {
        outcome.result = {
          ticket_id: ticket.ticketId,
          status: "needs_input",
          narration_hint: question,
          verbatim_blocks: [],
          artifacts: [],
          required_secrets: [],
          caveats: [],
          question,
        };
        state.agent.abort();
      },
      onRequestConfirm: (action, confirmKey) => {
        if (confirmKey) state.pendingConfirmKey = confirmKey;
        outcome.result = {
          ticket_id: ticket.ticketId,
          status: "awaiting_confirm",
          narration_hint: action,
          verbatim_blocks: [],
          artifacts: [],
          required_secrets: [],
          caveats: [],
          confirm_action: action,
        };
        state.agent.abort();
      },
      onFinishTask: (res) => {
        outcome.result = res;
        state.agent.abort();
      },
    });

    const activityPersistDir = join(
      resolve(dirname(hatoConfig.paths.workspaces_dir), "worker-cli"),
      "activity",
    );
    const runEpoch = Date.now();
    let assistantTurnIdx = 0;

    workerActivityHub.upsert(
      ticket.ticketId,
      {
        kind: "lifecycle",
        state: "done",
        title: "已启动内置沙箱 Worker",
        text: `工作目录: ${mandate.workspace_dir}`,
      },
      { persistDir: activityPersistDir },
    );

    const liveTraceId = `live_worker_${ticket.ticketId}`;
    this.deps.liveTraceTracker?.start({
      id: liveTraceId,
      canonicalUserId: ticket.canonicalUserId,
      slot: "worker",
      provider: state.modelMeta.provider,
      modelId: state.modelMeta.modelId,
      api: state.modelMeta.api,
      userPreview: `[工单 ${ticket.ticketId}] ${ticket.briefTitle}`,
      startedAt: Date.now(),
      progressNote: "后台 Worker 执行中",
    });

    const syncLiveTrace = (progressNote?: string) => {
      if (!this.deps.liveTraceTracker) return;
      const agg = aggregateAssistantTraceMetrics(state.agent.state.messages);
      this.deps.liveTraceTracker.update(liveTraceId, {
        ...(progressNote !== undefined ? { progressNote } : {}),
        steps: agg.steps,
        toolCalls: agg.toolCalls,
      });
    };

    let msgStartPerf = performance.now();
    let msgFirstDeltaPerf: number | null = null;

    const unsubscribe = state.agent.subscribe((ev) => {
      if (ev.type === "message_start" && ev.message.role === "assistant") {
        msgStartPerf = state.activeCallStartPerf ?? performance.now();
        msgFirstDeltaPerf = null;
        assistantTurnIdx += 1;
        return;
      }

      if (ev.type === "message_update") {
        const sub = ev.assistantMessageEvent;
        if (
          (sub.type === "text_delta" || sub.type === "thinking_delta" || sub.type === "toolcall_delta") &&
          sub.delta.length > 0 &&
          msgFirstDeltaPerf === null
        ) {
          msgFirstDeltaPerf = performance.now();
        }
        if (sub.type === "text_delta" && sub.delta.length > 0) {
          workerActivityHub.upsert(
            ticket.ticketId,
            {
              stepKey: `pi_assistant_${runEpoch}_${assistantTurnIdx}`,
              kind: "assistant",
              state: "running",
              title: "Worker 进展",
              appendText: sub.delta,
            },
            { persistDir: activityPersistDir },
          );
        }
        return;
      }

      if (ev.type === "tool_execution_start") {
        const anyEv = ev as { toolName: string; toolCallId?: string; args?: Record<string, unknown> };
        const isCmd = anyEv.toolName === "run_command";
        const cmdPreview =
          isCmd && typeof anyEv.args?.command === "string"
            ? anyEv.args.command.slice(0, 72)
            : undefined;
        const note = cmdPreview ? `正在执行: ${cmdPreview}` : `正在执行: ${ev.toolName}`;
        callbacks?.onProgress?.(note);
        syncLiveTrace(note);
        if (!isCmd) {
          const targetPath =
            typeof anyEv.args?.path === "string" ? anyEv.args.path : undefined;
          workerActivityHub.upsert(
            ticket.ticketId,
            {
              stepKey: anyEv.toolCallId ? `pi_tool_${anyEv.toolCallId}` : undefined,
              kind: "tool",
              state: "running",
              title: targetPath ? `${ev.toolName} · ${targetPath}` : `调用工具 · ${ev.toolName}`,
            },
            { persistDir: activityPersistDir },
          );
        }
        return;
      }

      if (ev.type === "tool_execution_end") {
        const anyEv = ev as {
          toolName: string;
          toolCallId?: string;
          isError?: boolean;
          result?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (anyEv.toolName !== "run_command" && anyEv.toolCallId) {
          const outPreview = anyEv.result?.content
            ?.map((c) => (typeof c?.text === "string" ? c.text : ""))
            .filter(Boolean)
            .join("\n");
          workerActivityHub.upsert(
            ticket.ticketId,
            {
              stepKey: `pi_tool_${anyEv.toolCallId}`,
              kind: "tool",
              state: anyEv.isError ? "error" : "done",
              ...(outPreview && anyEv.toolName !== "read_task_context"
                ? { output: outPreview.slice(0, 2000) }
                : {}),
            },
            { persistDir: activityPersistDir },
          );
        }
        syncLiveTrace();
        return;
      }

      if (ev.type === "message_end" && ev.message.role === "assistant") {
        workerActivityHub.upsert(
          ticket.ticketId,
          {
            stepKey: `pi_assistant_${runEpoch}_${assistantTurnIdx}`,
            kind: "assistant",
            state: "done",
          },
          { persistDir: activityPersistDir },
        );
        const msg = ev.message;
        if (msg.stopReason === "aborted" && outcome.result) {
          state.activeCallStartPerf = null;
          msgFirstDeltaPerf = null;
          return;
        }
        const nowPerf = performance.now();
        const callStart = state.activeCallStartPerf ?? msgStartPerf;
        const callTotalMs = Math.max(1, Math.round(nowPerf - callStart));
        const callTtftMs =
          msgFirstDeltaPerf !== null ? Math.max(0, Math.round(msgFirstDeltaPerf - callStart)) : callTotalMs;
        const callDecodeMs =
          msgFirstDeltaPerf !== null ? Math.max(1, nowPerf - msgFirstDeltaPerf) : undefined;
        state.activeCallStartPerf = null;
        msgFirstDeltaPerf = null;

        const msgTools = msg.content
          .filter((b): b is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => b.type === "toolCall")
          .map((b) => b.name);

        console.log(
          formatLlmTelemetryLog({
            slot: "worker",
            provider: msg.provider,
            modelId: msg.model,
            responseModel: msg.responseModel,
            responseId: msg.responseId,
            api: String(msg.api),
            stopReason: msg.stopReason,
            rawStopReason: msg.rawStopReason,
            errorMessage: msg.errorMessage,
            thinkingLevel: msg.providerThinkingLevel ?? msg.thinkingLevel,
            inputTokens: msg.usage.input,
            outputTokens: msg.usage.output,
            reasoningTokens: msg.usage.reasoning,
            cacheReadTokens: msg.usage.cacheRead,
            cacheWriteTokens: msg.usage.cacheWrite,
            cacheWrite1hTokens: msg.usage.cacheWrite1h,
            costTotal: msg.usage.cost.total,
            ttftMs: callTtftMs,
            decodeMs: callDecodeMs,
            latencyMs: callTotalMs,
            toolCalls: msgTools,
            timeZone: hatoConfig.owner.timezone,
          }),
        );
        syncLiveTrace();
      }
    });

    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      state.agent.abort();
    }, mandate.timeout_ms);
    timeoutTimer.unref();

    const beforeFilesSnapshot =
      mandate.workspace_mode === "isolated"
        ? snapshotWorkspaceFiles(mandate.workspace_dir)
        : undefined;

    let promptError: unknown = null;
    try {
      await state.agent.prompt(promptText);
    } catch (err) {
      promptError = err;
    } finally {
      clearTimeout(timeoutTimer);
      unsubscribe();
      state.activeCallStartPerf = null;
      state.lastActiveAt = Date.now();
      this.deps.liveTraceTracker?.finish(liveTraceId);
    }

    const finalRes = this.finalizeOutcome(
      ticket.ticketId,
      outcome.result,
      state.agent.state.messages,
      {
        workspaceDir: mandate.workspace_dir,
        workspaceMode: mandate.workspace_mode,
        beforeFilesSnapshot,
        timedOut,
        promptError,
        agentErrorMessage: state.agent.state.errorMessage,
        modelMeta: state.modelMeta,
      },
    );

    workerActivityHub.upsert(
      ticket.ticketId,
      {
        kind: "lifecycle",
        state: finalRes.status === "failed" ? "error" : "done",
        title:
          finalRes.status === "done"
            ? "Worker 执行完成"
            : finalRes.status === "needs_input"
              ? "等待补充信息"
              : finalRes.status === "awaiting_confirm"
                ? "等待高危操作确认"
                : "Worker 执行失败",
        ...(finalRes.narration_hint ? { text: finalRes.narration_hint } : {}),
      },
      { persistDir: activityPersistDir, flushImmediate: true },
    );

    return finalRes;
  }

  async abort(ticketId: string): Promise<void> {
    this.activeAborts.add(ticketId);
    const session = this.sessions.get(ticketId);
    session?.agent.abort();
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.abort(id)));
  }

  private finalizeOutcome(
    ticketId: string,
    explicitResult: WorkerResult | undefined,
    messages: readonly AgentMessage[],
    context?: {
      workspaceDir: string;
      workspaceMode: WorkerMandate["workspace_mode"];
      beforeFilesSnapshot?: ReadonlySet<string>;
      timedOut?: boolean;
      promptError?: unknown;
      agentErrorMessage?: string;
      modelMeta?: { provider: string; modelId: string; api: string };
    },
  ): WorkerResult {
    const agg = aggregateAssistantTraceMetrics(messages);
    const trace = context?.modelMeta
      ? {
          provider: context.modelMeta.provider,
          modelId: context.modelMeta.modelId,
          api: context.modelMeta.api,
          inputTokens: agg.inputTokens,
          outputTokens: agg.outputTokens,
          cacheReadTokens: agg.cacheReadTokens,
          cacheWriteTokens: agg.cacheWriteTokens,
          toolCalls: agg.toolCalls,
          steps: agg.steps,
        }
      : undefined;

    if (this.activeAborts.delete(ticketId)) {
      this.sessions.delete(ticketId);
      return {
        ticket_id: ticketId,
        status: "failed",
        narration_hint: "后台任务已中止。",
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: ["任务中止"],
        ...(trace ? { trace } : {}),
      };
    }

    if (explicitResult) {
      if (explicitResult.status !== "needs_input" && explicitResult.status !== "awaiting_confirm") {
        this.sessions.delete(ticketId);
      }
      if (
        explicitResult.status === "done" &&
        explicitResult.artifacts.length === 0 &&
        context?.workspaceMode === "isolated"
      ) {
        const discovered = collectNewArtifacts(
          context.workspaceDir,
          context.beforeFilesSnapshot,
        );
        if (discovered.length > 0) {
          return { ...explicitResult, artifacts: discovered, ...(trace ? { trace } : {}) };
        }
      }
      return { ...explicitResult, ...(trace ? { trace } : {}) };
    }

    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant") as AssistantMessage | undefined;

    if (context?.timedOut) {
      this.sessions.delete(ticketId);
      return {
        ticket_id: ticketId,
        status: "failed",
        narration_hint: "后台任务执行超时已中止。",
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: ["timeout"],
        ...(trace ? { trace } : {}),
      };
    }

    const promptErrorMessage =
      context?.promptError instanceof Error
        ? context.promptError.message
        : context?.promptError
          ? String(context.promptError)
          : "";
    const agentErrorMessage = context?.agentErrorMessage?.trim() ?? "";
    const assistantFailed =
      lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted";
    const assistantErrorDetail = assistantFailed
      ? lastAssistant?.errorMessage?.trim() || String(lastAssistant?.stopReason)
      : "";

    if (promptErrorMessage || agentErrorMessage || assistantFailed) {
      this.sessions.delete(ticketId);
      const reason = promptErrorMessage || agentErrorMessage || assistantErrorDetail || "unknown_error";
      return {
        ticket_id: ticketId,
        status: "failed",
        narration_hint: `后台任务执行异常中断：${reason}`,
        verbatim_blocks: [],
        artifacts: [],
        required_secrets: [],
        caveats: [reason],
        ...(trace ? { trace } : {}),
      };
    }

    const text = lastAssistant
      ? lastAssistant.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim()
      : "";

    const discovered =
      context?.workspaceMode === "isolated"
        ? collectNewArtifacts(context.workspaceDir, context.beforeFilesSnapshot)
        : [];

    this.sessions.delete(ticketId);
    return {
      ticket_id: ticketId,
      status: "done",
      narration_hint: text || "后台任务已结束。",
      verbatim_blocks: [],
      artifacts: discovered,
      required_secrets: [],
      caveats: [],
      ...(trace ? { trace } : {}),
    };
  }

  private async buildWorkerTools(params: {
    ticket: TicketExecutionHandle;
    mandate: WorkerMandate;
    hatoConfig: HatoConfig;
    state: BuiltinSessionState;
    onAskUser: (question: string) => void;
    onRequestConfirm: (action: string, confirmKey?: string) => void;
    onFinishTask: (result: WorkerResult) => void;
  }): Promise<AgentTool<any>[]> {
    const { ticket, mandate, hatoConfig, state } = params;
    const lookback = {
      maxStepCount: hatoConfig.context.lookback.max_step_count,
      maxTotalMessages: hatoConfig.context.lookback.max_total_messages,
      maxHours: hatoConfig.context.lookback.max_hours,
    };
    const isVmUnrestricted = mandate.execution_mode === "vm_unrestricted";
    mkdirSync(mandate.workspace_dir, { recursive: true });
    const workspaceRoot = realpathSync(mandate.workspace_dir);

    const resolveSafeWorkspacePath = (relPath: string): string => {
      const expanded =
        isVmUnrestricted && (relPath === "~" || relPath.startsWith("~/"))
          ? relPath === "~"
            ? homedir()
            : resolve(homedir(), relPath.slice(2))
          : relPath;
      const target = resolve(workspaceRoot, expanded);
      const realTarget = resolveRealPathOrAncestor(target);
      if (isProtectedEnvPath(target) || isProtectedEnvPath(realTarget)) {
        throw new Error(`安全策略禁止访问 Hato 的 .env 密钥文件: "${relPath}"`);
      }
      if (
        !isVmUnrestricted &&
        ((target !== workspaceRoot && !target.startsWith(workspaceRoot + sep)) ||
          (realTarget !== workspaceRoot && !realTarget.startsWith(workspaceRoot + sep)))
      ) {
        throw new Error(`路径越界: "${relPath}" 超出工单工作区边界`);
      }
      return realTarget;
    };

    const tools: AgentTool<any>[] = [
      {
        name: "read_task_context",
        label: "读取任务上下文",
        description: "Pull verbatim task context slice for your assigned context_id.",
        parameters: ReadContextParams,
        execute: async (_id, input) => {
          if (input.context_id !== ticket.contextId) {
            throw new Error(`无权读取非本工单上下文 ${input.context_id}`);
          }
          const slice = readTaskContext({
            repo: this.deps.repo,
            contextId: ticket.contextId,
            timezone: hatoConfig.owner.timezone,
            lookback,
          });
          return { content: [{ type: "text", text: slice.formattedText }], details: { ok: true } };
        },
      },
      {
        name: "expand_earlier_context",
        label: "回溯更早上下文",
        description: "Expand earlier messages prior to the initial slice within lookback bounds.",
        parameters: ExpandContextParams,
        execute: async (_id, input) => {
          if (input.context_id !== ticket.contextId) {
            throw new Error(`无权读取非本工单上下文 ${input.context_id}`);
          }
          const count = input.count ? Number(input.count) : undefined;
          const expanded = expandEarlierContext({
            repo: this.deps.repo,
            contextId: ticket.contextId,
            count: Number.isFinite(count) ? count : undefined,
            alreadyLookedBack: state.lookedBackTotal,
            timezone: hatoConfig.owner.timezone,
            lookback,
          });
          state.lookedBackTotal += expanded.messages.length;
          return {
            content: [{ type: "text", text: expanded.formattedText }],
            details: { ok: true },
          };
        },
      },
      {
        name: "read_file",
        label: "读取文件",
        description: "Read a text file inside the ticket workspace.",
        parameters: FilePathParams,
        execute: async (_id, input) => {
          const abs = resolveSafeWorkspacePath(input.path);
          if (!existsSync(abs)) {
            throw new Error(
              `File "${input.path}" does not exist in workspace. Check the path or list files with run_command("ls -la") before retrying.`,
            );
          }
          return {
            content: [{ type: "text", text: readFileSync(abs, "utf8").slice(0, 32_000) }],
            details: { path: input.path },
          };
        },
      },
      {
        name: "write_file",
        label: "写入文件",
        description: "Write a file inside the ticket workspace.",
        parameters: WriteFileParams,
        execute: async (_id, input) => {
          const abs = resolveSafeWorkspacePath(input.path);
          mkdirSync(resolve(abs, ".."), { recursive: true });
          writeFileSync(abs, input.content, "utf8");
          return {
            content: [{ type: "text", text: `已写入 ${input.path} (${input.content.length} 字符)` }],
            details: { path: abs },
          };
        },
      },
      {
        name: "run_command",
        label: "执行命令",
        description: isVmUnrestricted
          ? "Execute a shell command in the VM working directory with real HOME and PATH."
          : "Execute a shell command inside the ticket workspace.",
        parameters: RunCommandParams,
        execute: async (callId, input) => {
          if (isCommandReferencingProtectedEnv(input.command, workspaceRoot)) {
            throw new Error("安全策略禁止通过命令读取或修改 Hato 的 .env 密钥文件");
          }
          const proxyEnv =
            mandate.network === "egress" ? this.deps.proxyRouter.getWorkerProxyEnv() : {};
          const activityPersistDir = join(
            resolve(dirname(params.hatoConfig.paths.workspaces_dir), "worker-cli"),
            "activity",
          );
          const stepKey = `pi_cmd_${callId || Date.now()}`;
          const cmdStartedAt = Date.now();
          const cmdTimeoutMs = isVmUnrestricted
            ? mandate.timeout_ms
            : Math.min(mandate.timeout_ms, 60_000);
          const maxBytes = 512 * 1024;

          workerActivityHub.upsert(
            params.ticket.ticketId,
            {
              stepKey,
              kind: "command",
              state: "running",
              title: "执行命令",
              command: input.command,
            },
            { persistDir: activityPersistDir },
          );

          const execOut = await new Promise<{
            code: number | null;
            stdout: string;
            stderr: string;
            killedByTimeout: boolean;
            spawnError?: string;
          }>((resolveCmd) => {
            const child = spawn("sh", ["-lc", input.command], {
              cwd: workspaceRoot,
              env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                HOME: isVmUnrestricted ? homedir() : workspaceRoot,
                ...proxyEnv,
              },
              stdio: ["ignore", "pipe", "pipe"],
            });

            let stdoutBuf = "";
            let stderrBuf = "";
            let totalBytes = 0;
            let killedByTimeout = false;
            let flushTimer: ReturnType<typeof setTimeout> | null = null;
            let killTimer: ReturnType<typeof setTimeout> | null = null;
            let drainTimer: ReturnType<typeof setTimeout> | null = null;
            let settled = false;

            const buildDisplayOutput = () =>
              [stdoutBuf.trimEnd(), stderrBuf.trimEnd() ? `[stderr]\n${stderrBuf.trimEnd()}` : ""]
                .filter(Boolean)
                .join("\n");

            const scheduleStreamPush = () => {
              if (flushTimer) return;
              flushTimer = setTimeout(() => {
                flushTimer = null;
                workerActivityHub.upsert(
                  params.ticket.ticketId,
                  {
                    stepKey,
                    kind: "command",
                    state: "running",
                    output: buildDisplayOutput(),
                  },
                  { persistDir: activityPersistDir },
                );
              }, 120);
              flushTimer.unref();
            };

            const finishCmd = (res: {
              code: number | null;
              killedByTimeout: boolean;
              spawnError?: string;
            }) => {
              if (settled) return;
              settled = true;
              if (flushTimer) clearTimeout(flushTimer);
              if (timeoutHandle) clearTimeout(timeoutHandle);
              if (killTimer) clearTimeout(killTimer);
              if (drainTimer) clearTimeout(drainTimer);
              resolveCmd({
                code: res.code,
                stdout: stdoutBuf,
                stderr: stderrBuf,
                killedByTimeout: res.killedByTimeout,
                spawnError: res.spawnError,
              });
            };

            const timeoutHandle = setTimeout(() => {
              killedByTimeout = true;
              child.kill("SIGTERM");
              killTimer = setTimeout(() => {
                if (!child.killed && child.exitCode === null) {
                  child.kill("SIGKILL");
                }
                child.stdout?.destroy();
                child.stderr?.destroy();
              }, 2000);
              killTimer.unref();
            }, cmdTimeoutMs);
            timeoutHandle.unref();

            child.stdout?.on("data", (chunk: Buffer | string) => {
              const s = String(chunk);
              if (totalBytes < maxBytes) {
                const slice = s.slice(0, maxBytes - totalBytes);
                stdoutBuf += slice;
                totalBytes += slice.length;
                scheduleStreamPush();
              }
            });

            child.stderr?.on("data", (chunk: Buffer | string) => {
              const s = String(chunk);
              if (totalBytes < maxBytes) {
                const slice = s.slice(0, maxBytes - totalBytes);
                stderrBuf += slice;
                totalBytes += slice.length;
                scheduleStreamPush();
              }
            });

            child.once("error", (err) => {
              finishCmd({
                code: 1,
                killedByTimeout: false,
                spawnError: err instanceof Error ? err.message : String(err),
              });
            });

            child.once("exit", (code) => {
              drainTimer = setTimeout(() => {
                child.stdout?.destroy();
                child.stderr?.destroy();
                finishCmd({ code, killedByTimeout });
              }, 800);
              drainTimer.unref();
            });

            child.once("close", (code) => {
              finishCmd({ code, killedByTimeout });
            });
          });

          const durationMs = Math.max(1, Date.now() - cmdStartedAt);
          const outText = execOut.stdout.trim();
          const errText = execOut.stderr.trim();
          const combined = [outText, errText ? `[stderr]\n${errText}` : ""]
            .filter(Boolean)
            .join("\n");

          if (execOut.code === 0 && !execOut.killedByTimeout && !execOut.spawnError) {
            workerActivityHub.upsert(
              params.ticket.ticketId,
              {
                stepKey,
                kind: "command",
                state: "done",
                exitCode: 0,
                durationMs,
                output: combined || "(无输出)",
              },
              { persistDir: activityPersistDir },
            );
            return {
              content: [
                {
                  type: "text",
                  text: combined ? truncateHeadTail(combined) : "(command completed with no output)",
                },
              ],
              details: { ok: true },
            };
          }

          workerActivityHub.upsert(
            params.ticket.ticketId,
            {
              stepKey,
              kind: "command",
              state: "error",
              exitCode: execOut.code,
              durationMs,
              output:
                combined ||
                execOut.spawnError ||
                (execOut.killedByTimeout ? "Command timed out." : `exit=${String(execOut.code)}`),
            },
            { persistDir: activityPersistDir },
          );

          const detail = [
            execOut.killedByTimeout
              ? "Command timed out."
              : `Command failed (exit=${execOut.code ?? "unknown"}).`,
            outText ? `[stdout]\n${truncateHeadTail(outText, 10_000)}` : "",
            errText ? `[stderr]\n${truncateHeadTail(errText, 12_000)}` : "",
            !outText && !errText && execOut.spawnError ? execOut.spawnError : "",
            "Inspect the error above and adjust the command or files before retrying.",
          ]
            .filter(Boolean)
            .join("\n");
          throw new Error(detail);
        },
      },
      {
        name: "image_gen",
        label: "生成图片",
        description:
          "Generate image(s) via OpenAI-compatible Images API into the workspace. Pass the generated relative path(s) to finish_task(artifact_paths) to deliver them.",
        parameters: ImageGenParams,
        execute: async (_id, input) => {
          const provider = resolveImageGenProvider(this.deps.modelRegistry);
          if (!provider) {
            return {
              content: [{ type: "text", text: "未找到可用的 OpenAI 兼容图片生成供应商配置。" }],
              details: { ok: false },
            };
          }
          const apiKey = resolveProviderApiKey(provider);
          const result = await generateOpenAiImage({
            prompt: input.prompt,
            model: input.model,
            size: input.size,
            quality: input.quality,
            n: input.n,
            filename: input.filename,
            referenceImagePaths: input.reference_image_paths,
            workspaceDir: workspaceRoot,
            providerSlug: provider.slug,
            baseUrl: provider.baseUrl,
            apiKey,
            proxyRouter: this.deps.proxyRouter,
          });
          if (!result.ok) {
            return {
              content: [{ type: "text", text: `图片生成失败 (${result.model}): ${result.error}` }],
              details: { ok: false, provider: result.providerSlug, model: result.model },
            };
          }
          const summary = result.files
            .map((f) => `${f.relativePath} (${f.bytes} bytes)`)
            .join(", ");
          return {
            content: [
              {
                type: "text",
                text: `已生成图片 (${result.providerSlug}/${result.model}): ${summary}。请在 finish_task 的 artifact_paths 中附上该路径。`,
              },
            ],
            details: {
              ok: true,
              provider: result.providerSlug,
              model: result.model,
              files: result.files,
            },
          };
        },
      },
      {
        name: "register_script",
        label: "注册常驻定时脚本",
        description: `Register a verified script into Hato's cron script_registry so it runs periodically. IMPORTANT: cron_expr is evaluated in owner timezone "${hatoConfig.owner.timezone}" (do NOT convert local owner hours to UTC).`,
        parameters: RegisterScriptParams,
        execute: async (_id, input) => {
          if (!isValidCronExpression(input.cron_expr)) {
            throw new Error(`无效的 cron 表达式: ${input.cron_expr}`);
          }
          const abs = resolveSafeWorkspacePath(input.script_path);
          if (!existsSync(abs)) {
            throw new Error(`脚本文件不存在: ${abs}`);
          }
          if (!isVmUnrestricted) {
            const confirmKey = `register_script:${input.name}:${input.cron_expr}`;
            if (
              !state.approvedConfirmKeys.has(confirmKey) &&
              !state.approvedConfirmKeys.has("register_script")
            ) {
              params.onRequestConfirm(
                `注册常驻定时脚本 "${input.name}" (cron: ${input.cron_expr}, 时区: ${hatoConfig.owner.timezone}, 脚本: ${basename(abs)})`,
                confirmKey,
              );
              return {
                content: [
                  {
                    type: "text",
                    text: "已向主人发起常驻定时脚本注册确认请求，工单已挂起等待确认。",
                  },
                ],
                details: { awaiting_confirm: true },
              };
            }
          }
          let targetScriptPath = abs;
          if (!isVmUnrestricted && mandate.workspace_mode === "isolated") {
            const persistedPath = resolve(
              dirname(hatoConfig.paths.workspaces_dir),
              "scripts",
              ticket.ticketId.replace(/[^A-Za-z0-9._-]+/g, "_"),
              basename(abs),
            );
            mkdirSync(dirname(persistedPath), { recursive: true });
            copyFileSync(abs, persistedPath);
            chmodSync(persistedPath, statSync(abs).mode);
            targetScriptPath = persistedPath;
          }
          const notify =
            input.notify_channel ?? hatoConfig.owner.proactive_channel;
          const created = this.deps.repo.registerScript({
            ticketId: ticket.ticketId,
            name: input.name,
            scriptPath: targetScriptPath,
            cronExpr: input.cron_expr,
            notifyChannel: notify,
            requiredSecrets: input.required_secrets ?? [],
          });
          return {
            content: [
              {
                type: "text",
                text: `已注册常驻脚本 [${created.id}] "${created.name}" (cron: ${created.cronExpr}, 时区: ${hatoConfig.owner.timezone}) -> ${created.notifyChannel}`,
              },
            ],
            details: { ok: true, id: created.id, scriptPath: targetScriptPath },
          };
        },
      },
      {
        name: "manage_scripts",
        label: "管理常驻定时脚本",
        description: `List, pause, resume, reschedule, or delete existing scripts in Hato's script_registry. cron_expr is evaluated in owner timezone "${hatoConfig.owner.timezone}".`,
        parameters: ManageScriptsParams,
        execute: async (_id, input) => {
          const tz = hatoConfig.owner.timezone;
          if (input.action === "list") {
            const scripts = this.deps.repo.listScripts(50);
            if (scripts.length === 0) {
              return {
                content: [{ type: "text", text: "当前没有已注册的常驻定时脚本。" }],
                details: { ok: true, count: 0 },
              };
            }
            const lines = scripts.map(
              (s) =>
                `- [${s.id}] "${s.name}" cron="${s.cronExpr}" (timezone=${tz}) enabled=${s.enabled} path=${s.scriptPath} channel=${s.notifyChannel}`,
            );
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { ok: true, count: scripts.length },
            };
          }

          const scriptId = input.script_id?.trim();
          if (!scriptId) {
            throw new Error(`action="${input.action}" 必须提供 script_id`);
          }
          const target = this.deps.repo.listScripts(100).find((s) => s.id === scriptId);
          if (!target) {
            throw new Error(`未找到脚本 ${scriptId}`);
          }

          const trimmedCron = input.cron_expr?.trim();
          if (input.action === "reschedule") {
            if (!trimmedCron || !isValidCronExpression(trimmedCron)) {
              throw new Error(`无效的 cron 表达式: ${input.cron_expr ?? ""}`);
            }
          }

          if (!isVmUnrestricted) {
            const confirmKey = `manage_scripts:${input.action}:${target.id}${trimmedCron ? `:${trimmedCron}` : ""}`;
            if (
              !state.approvedConfirmKeys.has(confirmKey) &&
              !state.approvedConfirmKeys.has("manage_scripts")
            ) {
              const actionDesc =
                input.action === "pause"
                  ? `暂停常驻脚本 [${target.id}] "${target.name}"`
                  : input.action === "resume"
                    ? `恢复常驻脚本 [${target.id}] "${target.name}"`
                    : input.action === "reschedule"
                      ? `修改常驻脚本 [${target.id}] "${target.name}" 周期为 "${trimmedCron}" (时区: ${tz})`
                      : `删除常驻脚本 [${target.id}] "${target.name}"`;
              params.onRequestConfirm(actionDesc, confirmKey);
              return {
                content: [
                  {
                    type: "text",
                    text: "已向主人发起常驻定时脚本变更确认请求，工单已挂起等待确认。",
                  },
                ],
                details: { awaiting_confirm: true },
              };
            }
          }

          if (input.action === "pause") {
            this.deps.repo.updateScriptSchedule(target.id, { enabled: false });
            return {
              content: [{ type: "text", text: `已暂停常驻脚本 [${target.id}] "${target.name}"` }],
              details: { ok: true, id: target.id, action: "pause" },
            };
          }
          if (input.action === "resume") {
            this.deps.repo.updateScriptSchedule(target.id, { enabled: true });
            return {
              content: [{ type: "text", text: `已恢复常驻脚本 [${target.id}] "${target.name}"` }],
              details: { ok: true, id: target.id, action: "resume" },
            };
          }
          if (input.action === "reschedule") {
            this.deps.repo.updateScriptSchedule(target.id, { cronExpr: trimmedCron! });
            return {
              content: [
                {
                  type: "text",
                  text: `已更新常驻脚本 [${target.id}] "${target.name}" 周期为 ${trimmedCron} (时区: ${tz})`,
                },
              ],
              details: { ok: true, id: target.id, action: "reschedule", cronExpr: trimmedCron },
            };
          }

          this.deps.repo.deleteScript(target.id);
          return {
            content: [{ type: "text", text: `已删除常驻脚本 [${target.id}] "${target.name}"` }],
            details: { ok: true, id: target.id, action: "delete" },
          };
        },
      },
      {
        name: "ask_user",
        label: "向用户追问",
        description: "Pause the ticket and ask the user for missing information or confirmation.",
        parameters: AskUserParams,
        execute: async (_id, input) => {
          params.onAskUser(input.question);
          return {
            content: [{ type: "text", text: "已向用户发起追问并挂起工单。" }],
            details: { needs_input: true },
          };
        },
      },
      {
        name: "request_confirm",
        label: "请求高危操作确认",
        description:
          "Pause the ticket in awaiting_confirm state and request explicit owner button/keyword confirmation before executing a high-risk action listed in confirm_before.",
        parameters: RequestConfirmParams,
        execute: async (_id, input) => {
          params.onRequestConfirm(input.action);
          return {
            content: [{ type: "text", text: "已向主人发起高危操作确认请求并挂起工单。" }],
            details: { awaiting_confirm: true },
          };
        },
      },
      {
        name: "finish_task",
        label: "提交工单结果",
        description: "Submit the final structured result when the ticket completes or fails.",
        parameters: FinishTaskParams,
        execute: async (_id, input) => {
          const artifacts = (input.artifact_paths ?? []).map((p: string) => {
            const abs = resolveSafeWorkspacePath(p);
            const filename = abs.split("/").pop() ?? p;
            const ext = filename.includes(".") ? `.${filename.split(".").pop()!.toLowerCase()}` : "";
            const sendAs = IMAGE_EXTENSIONS.has(ext) ? ("photo" as const) : ("file" as const);
            return { path: abs, filename, send_as: sendAs };
          });
          params.onFinishTask({
            ticket_id: ticket.ticketId,
            status: input.status,
            narration_hint: input.narration_hint,
            verbatim_blocks: [],
            artifacts,
            required_secrets: input.required_secrets ?? [],
            caveats: input.caveats ?? [],
          });
          return {
            content: [{ type: "text", text: "工单结果已提交。" }],
            details: { done: true },
          };
        },
      },
    ];

    if (mandate.skills.length > 0) {
      const authorizedSkillNames = new Set(mandate.skills);
      tools.push({
        name: "read_worker_skill",
        label: "读取 Worker Skill",
        description: "Read an authorized skill from the worker zone.",
        parameters: ReadWorkerSkillParams,
        execute: async (_id, input) => {
          if (!authorizedSkillNames.has(input.name)) {
            throw new Error(`未授权读取 Skill "${input.name}"`);
          }
          const loaded = readSkillContent(
            resolveSkillsDir(hatoConfig),
            "worker",
            input.name,
            input.reference_path,
          );
          return {
            content: [{ type: "text", text: loaded.content }],
            details: { name: loaded.name },
          };
        },
      });
    }

    if (this.deps.mcpPool && mandate.allowed_mcp_servers.length > 0) {
      const mcpTools = await this.deps.mcpPool.getToolsForWorker(mandate.allowed_mcp_servers, {
        onConfirmRequired: async ({ serverName, toolName, args }) => {
          const confirmKey = `mcp:${serverName}:${toolName}:${JSON.stringify(args ?? null)}`;
          if (state.approvedConfirmKeys.has(confirmKey)) {
            return true;
          }
          params.onRequestConfirm(
            `调用高危 MCP 工具 ${serverName}:${toolName} (${JSON.stringify(args ?? {}).slice(0, 240)})`,
            confirmKey,
          );
          return false;
        },
      });
      tools.push(...mcpTools);
    }

    return wrapToolsWithLoopGuard(tools);
  }
}
