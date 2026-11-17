import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type AssistantMessage, type TextContent } from "@earendil-works/pi-ai";
import { arr, num, obj, opt, oneOf, str } from "@earendil-works/pi-schema";
import { resolveSkillsDir, type HatoConfig } from "../config/app.js";
import { resolveHatoHomeDir } from "../config/paths.js";
import { supportsCustomFetchOption, type ModelRegistry } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type { HatoRepository } from "../db/repo.js";
import { expandEarlierContext, readTaskContext } from "../dispatch/context-slice.js";
import type { WorkerMandate, WorkerResult } from "../dispatch/schema.js";
import type { McpClientPool } from "../mcp/pool.js";
import { readSkillContent, selectWorkerSkills } from "../skills/loader.js";
import {
  generateOpenAiImage,
  resolveImageGenProvider,
  resolveProviderApiKey,
} from "./image-gen.js";
import type {
  ExecutionProgressCallback,
  ExecutionRunner,
  TicketExecutionHandle,
} from "./backend.js";

const execFileAsync = promisify(execFile);

const WORKER_SYSTEM_PROMPT = `You are Hato's isolated background engineering worker (builtin-pi).

## Context & Security Rules
- Your first step is ALWAYS calling \`read_task_context\` with your assigned \`context_id\` to retrieve the original user request.
- Messages labeled \`[CHAT_RELAY]\` come from the companion chat layer: ignore their casual tone and extract only factual requirements initiated or confirmed by \`[USER]\`.
- If crucial earlier references are missing, call \`expand_earlier_context\`.
- Operate strictly within your workspace boundary. Never ask the user to paste raw secrets into chat; list required secret names in \`required_secrets\`.
- NEVER read \`.env\` or call Telegram/QQ Bot APIs (such as \`forwardMessage\`, \`sendMessage\`, etc.) via shell commands to fetch historical messages or media. Use \`read_task_context\` / \`expand_earlier_context\` (which include saved attachment \`路径=...\` paths), and call \`ask_user\` if a file is missing.
- When finished, ALWAYS call \`finish_task\` with an accurate, concise \`narration_hint\`, any verbatim blocks/artifacts, and caveats.`;

const VM_UNRESTRICTED_PROMPT_SUFFIX = `

## VM Unrestricted Mode
- You are running in \`vm_unrestricted\` mode inside a dedicated VM with a persistent working directory.
- You may read/write files across the VM (including \`~\` and absolute paths) and run shell commands with real \`HOME\` and full \`PATH\`.
- STRICT SECURITY RULE: You are STILL strictly forbidden from reading, modifying, or printing Hato's \`.env\` / \`.env.*\` secret files (e.g. in \`~/.hato/\` or Hato's repo).`;

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
  if (!/(?:^|[\s"'`=/])\.env(?:\.[A-Za-z0-9_.-]+)?(?=$|[\s"'`;|&)>])/.test(normalizedCmd)) {
    return false;
  }
  const hatoHome = resolve(resolveHatoHomeDir());
  const repoRoot = resolve(process.cwd());
  if (
    normalizedCmd.includes(".hato") ||
    normalizedCmd.includes("HATO_HOME") ||
    normalizedCmd.includes(hatoHome) ||
    normalizedCmd.includes(repoRoot)
  ) {
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
  reference_image_paths: opt(arr(str({ description: "Optional local reference image path(s) (e.g. from attachment 路径=...) for image editing/reference generation" }))),
  n: opt(num({ description: "Optional number of images (1-4), defaults to 1" })),
});

const AskUserParams = obj({
  question: str({ description: "Clear question for the user to answer before resuming" }),
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
  lookedBackTotal: number;
}

/**
 * Built-in `pi-agent-core` Worker running inside the host process with workspace-confined tools,
 * model snapshot locking, host-side `McpClientPool` integration, and explicit `ask_user`/`finish_task` states.
 */
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
    },
  ) {}

  async execute(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    mkdirSync(mandate.workspace_dir, { recursive: true });

    const hatoConfig = this.deps.getHatoConfig();
    const resolved = this.deps.modelRegistry.resolveSlot("worker");

    // Lock the model snapshot onto the ticket row so mid-flight slot switches never break protocol.
    this.deps.repo.updateTicket(ticket.ticketId, {
      modelSnapshotJson: JSON.stringify({
        slot: "worker",
        target: resolved.target,
        api: String(resolved.model.api),
      }),
    });

    const outcome: { result?: WorkerResult } = {};
    const state: BuiltinSessionState = {
      agent: null as unknown as Agent,
      lookedBackTotal: 0,
    };

    const tools = await this.buildWorkerTools({
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
      onFinishTask: (res) => {
        outcome.result = res;
        state.agent.abort();
      },
    });

    const systemPrompt =
      mandate.execution_mode === "vm_unrestricted"
        ? WORKER_SYSTEM_PROMPT + VM_UNRESTRICTED_PROMPT_SUFFIX
        : WORKER_SYSTEM_PROMPT;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: resolved.model,
        thinkingLevel: clampThinkingLevel(resolved.model, resolved.model.reasoning ? "medium" : "off"),
        tools,
        messages: [],
      },
      sessionId: ticket.ticketId,
      getApiKey: (provider) => this.deps.modelRegistry.resolveApiKeyForProvider(provider),
      streamFn: (model, context, options) => {
        const scopedFetch: typeof globalThis.fetch = (input, init) =>
          this.deps.proxyRouter.scopedFetch(input, init, `llm-calling.${model.provider}`);
        return this.deps.proxyRouter.runWithScope(`llm-calling.${model.provider}`, () =>
          Promise.resolve(
            this.deps.modelRegistry.models.streamSimple(model, context, {
              ...options,
              ...(supportsCustomFetchOption(model.api) ? { fetch: scopedFetch } : {}),
            }),
          ),
        );
      },
    });

    state.agent = agent;
    this.sessions.set(ticket.ticketId, state);

    const unsubscribe = agent.subscribe((ev) => {
      if (ev.type === "tool_execution_start") {
        callbacks?.onProgress?.(`正在执行: ${ev.toolName}`);
      }
    });

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

    const timeoutTimer = setTimeout(() => {
      agent.abort();
    }, mandate.timeout_ms);
    timeoutTimer.unref();

    try {
      await agent.prompt(promptText);
    } catch (err) {
      if (!outcome.result) {
        return {
          ticket_id: ticket.ticketId,
          status: "failed",
          narration_hint: err instanceof Error ? err.message : String(err),
          verbatim_blocks: [],
          artifacts: [],
          required_secrets: [],
          caveats: [],
        };
      }
    } finally {
      clearTimeout(timeoutTimer);
      unsubscribe();
    }

    return this.finalizeOutcome(ticket.ticketId, outcome.result, agent.state.messages);
  }

  async resume(
    ticket: TicketExecutionHandle,
    mandate: WorkerMandate,
    userReply: string,
    callbacks?: ExecutionProgressCallback,
  ): Promise<WorkerResult> {
    const existing = this.sessions.get(ticket.ticketId);
    if (!existing) {
      return this.execute(ticket, mandate, callbacks);
    }

    const outcome: { result?: WorkerResult } = {};
    const hatoConfig = this.deps.getHatoConfig();
    existing.agent.state.tools = await this.buildWorkerTools({
      ticket,
      mandate,
      hatoConfig,
      state: existing,
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
        existing.agent.abort();
      },
      onFinishTask: (res) => {
        outcome.result = res;
        existing.agent.abort();
      },
    });

    const unsubscribe = existing.agent.subscribe((ev) => {
      if (ev.type === "tool_execution_start") {
        callbacks?.onProgress?.(`正在执行: ${ev.toolName}`);
      }
    });

    try {
      await existing.agent.prompt(`[USER 补充回复]\n${userReply}`);
    } finally {
      unsubscribe();
    }

    return this.finalizeOutcome(ticket.ticketId, outcome.result, existing.agent.state.messages);
  }

  async abort(ticketId: string): Promise<void> {
    this.activeAborts.add(ticketId);
    const session = this.sessions.get(ticketId);
    session?.agent.abort();
  }

  private finalizeOutcome(
    ticketId: string,
    explicitResult: WorkerResult | undefined,
    messages: readonly AgentMessage[],
  ): WorkerResult {
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
      };
    }

    if (explicitResult) {
      if (explicitResult.status !== "needs_input") {
        this.sessions.delete(ticketId);
      }
      return explicitResult;
    }

    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant") as AssistantMessage | undefined;
    const text = lastAssistant
      ? lastAssistant.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim()
      : "";

    this.sessions.delete(ticketId);
    return {
      ticket_id: ticketId,
      status: "done",
      narration_hint: text || "后台任务已结束。",
      verbatim_blocks: [],
      artifacts: [],
      required_secrets: [],
      caveats: [],
    };
  }

  private async buildWorkerTools(params: {
    ticket: TicketExecutionHandle;
    mandate: WorkerMandate;
    hatoConfig: HatoConfig;
    state: BuiltinSessionState;
    onAskUser: (question: string) => void;
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
      if (isProtectedEnvPath(target)) {
        throw new Error(`安全策略禁止访问 Hato 的 .env 密钥文件: "${relPath}"`);
      }
      if (!isVmUnrestricted && target !== workspaceRoot && !target.startsWith(workspaceRoot + sep)) {
        throw new Error(`路径越界: "${relPath}" 超出工单工作区边界`);
      }
      return target;
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
            throw new Error(`文件不存在: ${input.path}`);
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
        execute: async (_id, input) => {
          if (isCommandReferencingProtectedEnv(input.command, workspaceRoot)) {
            throw new Error("安全策略禁止通过命令读取或修改 Hato 的 .env 密钥文件");
          }
          const proxyEnv =
            mandate.network === "egress" ? this.deps.proxyRouter.getWorkerProxyEnv() : {};
          const { stdout, stderr } = await execFileAsync("sh", ["-lc", input.command], {
            cwd: workspaceRoot,
            timeout: isVmUnrestricted ? mandate.timeout_ms : Math.min(mandate.timeout_ms, 60_000),
            maxBuffer: 512 * 1024,
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: isVmUnrestricted ? homedir() : workspaceRoot,
              ...proxyEnv,
            },
          });
          const combined = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ""]
            .filter(Boolean)
            .join("\n");
          return {
            content: [{ type: "text", text: combined || "(命令完成，无输出)" }],
            details: { ok: true },
          };
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
        name: "finish_task",
        label: "提交工单结果",
        description: "Submit the final structured result when the ticket completes or fails.",
        parameters: FinishTaskParams,
        execute: async (_id, input) => {
          const artifacts = (input.artifact_paths ?? []).map((p: string) => {
            const abs = resolveSafeWorkspacePath(p);
            const filename = abs.split("/").pop() ?? p;
            return { path: abs, filename, send_as: "file" as const };
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
      const mcpTools = await this.deps.mcpPool.getToolsForWorker(mandate.allowed_mcp_servers);
      tools.push(...mcpTools);
    }

    return tools;
  }
}
