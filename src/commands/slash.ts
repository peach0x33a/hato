import type { HatoRepository } from "../db/repo.js";
import { resolveReplyMessageText } from "../gateway/reply-context.js";
import type { ChannelName } from "../gateway/types.js";
import type { ForgetRunSummary, RetainRunSummary } from "../memory/curator.js";
import type { MemoryUsageSummary, MemoryVaultInfo } from "../memory/store.js";
import type { MarkdownRenderTheme } from "../render/markdown-image.js";
import { computeTurnMetrics, formatCacheHitRate } from "../stats/metrics.js";

export interface ModelSlotView {
  slot: string;
  target: string;
  api: string;
  baseUrl: string;
}

export interface SetHomeResult {
  channel: ChannelName;
  targetId: string;
  addedToWhitelist: boolean;
  savedToConfig: boolean;
}

export interface ResetContextResult {
  clearedHotMessages: number;
  hadSummary: boolean;
}

export interface MemoryStatusView {
  provider: string;
  configured: boolean;
  recallMode: string;
  curatorEnabled: boolean;
  vaultIds: { persona: string | null; tech: string | null };
  vaults?: MemoryVaultInfo[];
  usage?: MemoryUsageSummary | null;
}

export interface TelegramBotCommandSpec {
  command: string;
  description: string;
}

export interface SlashCommandSpec {
  command: string;
  description: string;
  helpLine: string;
  requiresMemory?: boolean;
  availableWhenUnbound?: boolean;
  /** Whether to sync this command to platform slash command panels (e.g. Telegram setMyCommands). Defaults to true. */
  syncToPlatformPanel?: boolean;
}

export interface SlashCommandOutput {
  text?: string;
  photo?: {
    buffer: Buffer;
    caption?: string;
  };
}

export interface SlashCommandDeps {
  repo: HatoRepository;
  listModelSlots(): ModelSlotView[];
  listAvailableModels(): string[];
  setModelSlot(slot: string, target: string): ModelSlotView;
  reloadAll(): Promise<{ slots: ModelSlotView[]; proxyCount: number; changes?: string[] }>;
  forceCompact(canonicalUserId: string): Promise<boolean>;
  resetContext?(canonicalUserId: string): Promise<ResetContextResult>;
  setHomeChannel?(): Promise<SetHomeResult>;
  getMemoryStatus?(canonicalUserId: string): Promise<MemoryStatusView>;
  syncMemory?(canonicalUserId: string, opts?: { includeDenied?: boolean }): Promise<RetainRunSummary>;
  forgetMemory?(canonicalUserId: string, query: string): Promise<ForgetRunSummary>;
  renderMarkdownImage?(markdown: string, options?: { theme?: MarkdownRenderTheme }): Promise<Buffer>;
}

export interface SlashCommandInput {
  canonicalUserId: string;
  text: string;
  deps: SlashCommandDeps;
  channel?: ChannelName;
  platformUserId?: string;
  platformMsgId?: string;
  replyToPlatformMsgId?: string;
  replyToText?: string;
}

export interface SlashCommandExecutionContext extends SlashCommandInput {
  command: string;
  rawArgs: string;
  args: string[];
  registry: SlashCommandRegistry;
}

export type SlashCommandHandlerResult = SlashCommandOutput | string | null;

export interface SlashCommandDefinition extends SlashCommandSpec {
  aliases?: readonly string[];
  execute(ctx: SlashCommandExecutionContext): Promise<SlashCommandHandlerResult>;
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

function normalizeHandlerOutput(result: SlashCommandHandlerResult): SlashCommandOutput | null {
  if (result === null || result === undefined) return null;
  if (typeof result === "string") return { text: result };
  if (result.text === undefined && result.photo === undefined) return null;
  return result;
}

/**
 * Parse `/cmd(@bot)?` and preserve the exact raw argument tail (including newlines/Markdown).
 */
export function parseSlashInvocation(text: string): {
  command: string;
  rawArgs: string;
  args: string[];
} | null {
  const trimmedStart = text.trimStart();
  if (!trimmedStart.startsWith("/")) return null;

  const match = /^\/([^\s@]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(trimmedStart);
  if (!match) return null;

  const command = match[1]!.toLowerCase();
  const rawArgs = match[2] ?? "";
  const trimmedArgs = rawArgs.trim();
  const args = trimmedArgs ? trimmedArgs.split(/\s+/) : [];
  return { command, rawArgs, args };
}

/**
 * Parse `/render2img` theme flags (`--dark` / `-d` / `--light` / `-l`) while preserving
 * the remaining Markdown payload intact.
 */
export function parseRender2ImgArgs(rawArgs: string): {
  theme: MarkdownRenderTheme;
  inlineText: string;
} {
  let theme: MarkdownRenderTheme = "light";
  let rest = rawArgs;

  while (true) {
    const match = /^\s*(--dark|-d|--light|-l)(?=$|\s)([\s\S]*)$/i.exec(rest);
    if (!match) break;
    const flag = match[1]!.toLowerCase();
    theme = flag === "--dark" || flag === "-d" ? "dark" : "light";
    rest = match[2] ?? "";
  }

  return {
    theme,
    inlineText: rest.trim(),
  };
}

/**
 * Registrable slash command registry.
 */
export class SlashCommandRegistry {
  private readonly definitions = new Map<string, SlashCommandDefinition>();
  private readonly lookup = new Map<string, SlashCommandDefinition>();

  register(definition: SlashCommandDefinition): this {
    const command = normalizeCommandName(definition.command);
    if (!command) {
      throw new Error("Slash command name cannot be empty");
    }

    const normalized: SlashCommandDefinition = {
      ...definition,
      command,
      aliases: definition.aliases?.map(normalizeCommandName).filter(Boolean),
    };

    const existing = this.definitions.get(command);
    if (existing) {
      this.removeLookupKeys(existing);
    }

    this.definitions.set(command, normalized);
    this.lookup.set(command, normalized);
    for (const alias of normalized.aliases ?? []) {
      this.lookup.set(alias, normalized);
    }
    return this;
  }

  unregister(command: string): boolean {
    const key = normalizeCommandName(command);
    const existing = this.definitions.get(key);
    if (!existing) return false;
    this.definitions.delete(key);
    this.removeLookupKeys(existing);
    return true;
  }

  get(command: string): SlashCommandDefinition | undefined {
    return this.lookup.get(normalizeCommandName(command));
  }

  listSpecs(): SlashCommandSpec[] {
    return Array.from(this.definitions.values()).map((def) => ({
      command: def.command,
      description: def.description,
      helpLine: def.helpLine,
      requiresMemory: def.requiresMemory,
      availableWhenUnbound: def.availableWhenUnbound,
      syncToPlatformPanel: def.syncToPlatformPanel,
    }));
  }

  async execute(input: SlashCommandInput): Promise<SlashCommandOutput | null> {
    const parsed = parseSlashInvocation(input.text);
    if (!parsed) return null;

    const def = this.lookup.get(parsed.command);
    if (!def) return null;

    const result = await def.execute({
      ...input,
      command: def.command,
      rawArgs: parsed.rawArgs,
      args: parsed.args,
      registry: this,
    });
    return normalizeHandlerOutput(result);
  }

  private removeLookupKeys(def: SlashCommandDefinition): void {
    this.lookup.delete(def.command);
    for (const alias of def.aliases ?? []) {
      if (this.lookup.get(alias) === def) {
        this.lookup.delete(alias);
      }
    }
  }
}

const RENDER2IMG_USAGE = [
  "用法：",
  "- 回复任意消息并发送 `/render2img`（默认亮色）或 `/render2img --dark` / `-d`（暗色）、`--light` / `-l`（亮色），将其渲染为图片",
  "- 直接发送 `/render2img [--dark|-d|--light|-l] <Markdown 文本>`，将文本渲染为图片",
  "（该指令会跳过机器人响应，不进入对话上下文）",
].join("\n");

/**
 * Create a registry pre-populated with Hato's built-in system slash commands.
 */
export function createDefaultSlashCommandRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();

  registry
    .register({
      command: "help",
      description: "查看可用系统指令说明",
      helpLine: "- `/help`：查看可用系统指令说明",
      availableWhenUnbound: true,
      async execute(ctx) {
        return [
          "可用系统指令（不进入对话历史）：",
          ...ctx.registry.listSpecs().map((spec) => spec.helpLine),
        ].join("\n");
      },
    })
    .register({
      command: "new",
      description: "清空当前对话上下文，开启新会话",
      helpLine: "- `/new`：清空当前对话上下文，开启新会话",
      async execute(ctx) {
        if (!ctx.deps.resetContext) {
          return "当前运行时暂未接入 `/new` 清空上下文能力。";
        }
        const res = await ctx.deps.resetContext(ctx.canonicalUserId);
        const parts: string[] = [];
        if (res.clearedHotMessages > 0) parts.push(`${res.clearedHotMessages} 条热区消息`);
        if (res.hadSummary) parts.push("前情摘要");
        const detail = parts.length > 0 ? `（已清理 ${parts.join("与")}）` : "（当前已是空白上下文）";
        return `已开启新对话，当前上下文已清空${detail}。`;
      },
    })
    .register({
      command: "sethome",
      description: "将当前私聊设为 Home Channel",
      helpLine: "- `/sethome`：将当前对话设为 Home Channel（主动关怀与定时通知默认入口）",
      availableWhenUnbound: true,
      async execute(ctx) {
        if (!ctx.deps.setHomeChannel) {
          return "当前渠道暂未接入 `/sethome` 持久化绑定能力。";
        }
        try {
          const res = await ctx.deps.setHomeChannel();
          const channelLabel =
            res.channel === "tg" ? "Telegram" : res.channel === "qq" ? "QQ" : "Web";
          const extras = [
            res.addedToWhitelist ? "已加入主人白名单" : null,
            res.savedToConfig ? "并已持久化到 `config/hato.toml`" : "（已写入数据库运行态）",
          ]
            .filter(Boolean)
            .join("，");
          return `已将当前 ${channelLabel} 私聊（\`${res.targetId}\`）设为 Home Channel（主动消息与定时通知默认投递到这里），${extras}。`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `设置 Home Channel 失败：${msg}`;
        }
      },
    })
    .register({
      command: "trace",
      description: "查看上一轮上下文、时间卡与缓存命中",
      helpLine: "- `/trace`：查看上一轮上下文、时间卡、协议与 Prompt Cache 命中",
      async execute(ctx) {
        const trace = ctx.deps.repo.getLatestTurnTrace(ctx.canonicalUserId);
        if (!trace) return "暂无可查看的 `/trace` 记录。";
        const tools = safeJsonArray(trace.toolCallsJson);
        const recalled = safeJsonArray(trace.recalledIdsJson);
        const computed = computeTurnMetrics({
          inputTokens: trace.inputTokens,
          outputTokens: trace.outputTokens,
          cacheReadTokens: trace.cacheReadTokens,
          cacheWriteTokens: trace.cacheWriteTokens,
          latencyMs: trace.latencyMs,
          ttftMs: trace.ttftMs,
        });
        const hitRate =
          trace.cacheHitRate > 0 || computed.totalPromptTokens === 0
            ? trace.cacheHitRate
            : computed.cacheHitRate;
        const tpsText =
          trace.tps !== null && trace.tps > 0
            ? `${trace.tps.toFixed(1)} tok/s`
            : computed.e2eTps !== null
              ? `${computed.e2eTps.toFixed(1)} tok/s (e2e)`
              : "-";
        return [
          `【最近一轮 Trace: ${trace.id}】`,
          `- 槽位 / 模型: ${trace.slot} -> ${trace.provider}/${trace.modelId} (${trace.api})`,
          `- 缓存命中率: ${formatCacheHitRate(hitRate)} (cache_read=${trace.cacheReadTokens}, cache_write=${trace.cacheWriteTokens}, uncached_in=${trace.inputTokens}, prompt=${computed.totalPromptTokens})`,
          `- 输出与耗时: out=${trace.outputTokens} · 总耗时=${trace.latencyMs}ms · 首字=${trace.ttftMs !== null ? `${trace.ttftMs}ms` : "-"} · TPS=${tpsText}`,
          `- 工具调用: ${tools.length > 0 ? tools.join(", ") : "无"}`,
          `- 召回记忆 ID: ${recalled.length > 0 ? recalled.join(", ") : "无"}`,
          `- 时间卡快照:\n${trace.timeCardText || "(空)"}`,
        ].join("\n");
      },
    })
    .register({
      command: "model",
      description: "查看或热切换 5 个角色槽位模型",
      helpLine: "- `/model list` / `/model set <slot> <provider/model>`：查看或热切换槽位模型",
      async execute(ctx) {
        const sub = (ctx.args[0] ?? "list").toLowerCase();
        if (sub === "list") {
          const slotLines = ctx.deps
            .listModelSlots()
            .map((s) => `- ${s.slot}: ${s.target} [${s.api}] -> ${s.baseUrl}`);
          const avail = ctx.deps.listAvailableModels().map((m) => `  · ${m}`);
          return `【当前槽位绑定】\n${slotLines.join("\n")}\n\n【已配置模型】\n${avail.join("\n")}`;
        }

        if (sub === "set") {
          const slot = ctx.args[1];
          const target = ctx.args[2];
          if (!slot || !target) {
            return "用法: `/model set <slot> <provider/model_id>`（必须带 Provider 前缀）";
          }
          if (!target.includes("/")) {
            const candidates = ctx.deps
              .listAvailableModels()
              .filter((item) => item.slice(item.indexOf("/") + 1) === target);
            const hint =
              candidates.length > 0
                ? `\n匹配的带前缀目标：\n${candidates.map((c) => `  · \`${c}\``).join("\n")}`
                : "\n请执行 `/model list` 查看带 Provider 前缀的完整模型名。";
            return `模型选择必须带 Provider 前缀 \`<provider>/<model_id>\`，不能省略前缀（\`${target}\`）。${hint}`;
          }
          try {
            const updated = ctx.deps.setModelSlot(slot, target);
            return `已热切换槽位 \`${updated.slot}\` -> \`${updated.target}\` (${updated.api})`;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `切换模型失败：${msg}`;
          }
        }

        return "未知 `/model` 子命令，请使用 `/model list` 或 `/model set <slot> <provider/model_id>`。";
      },
    })
    .register({
      command: "reload",
      description: "热重载 hato.toml 与 models.toml",
      helpLine: "- `/reload`：热重载 `config/hato.toml` 与 `config/models.toml`",
      async execute(ctx) {
        try {
          const res = await ctx.deps.reloadAll();
          const lines = res.slots.map((s) => `- ${s.slot}: ${s.target} (${s.api})`);
          const diffSection = res.changes
            ? res.changes.length > 0
              ? `\n\n【本次变更差异 (${res.changes.length} 项)】\n${res.changes.map((c) => `• ${c}`).join("\n")}`
              : "\n\n【本次变更差异】\n• 无变化（当前配置与重载前一致）"
            : "";
          return `配置热重载成功（代理规则 ${res.proxyCount} 条）：\n${lines.join("\n")}${diffSection}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `配置热重载失败：${msg}`;
        }
      },
    })
    .register({
      command: "compact",
      description: "手动触发一次热区上下文压缩",
      helpLine: "- `/compact`：手动触发一次热区上下文压缩",
      async execute(ctx) {
        const didCompact = await ctx.deps.forceCompact(ctx.canonicalUserId);
        return didCompact ? "已完成一次热区上下文压缩。" : "当前热区消息不足，暂无需压缩。";
      },
    })
    .register({
      command: "memory",
      description: "查看长期记忆状态或立即同步",
      helpLine: "- `/memory [sync|retry]`：查看长期记忆状态/配额，或立即提炼同步",
      requiresMemory: true,
      async execute(ctx) {
        const sub = (ctx.args[0] ?? "status").toLowerCase();
        if (sub === "sync" || sub === "retry") {
          if (!ctx.deps.syncMemory) {
            return "当前运行时暂未接入长期记忆同步能力。";
          }
          const res = await ctx.deps.syncMemory(ctx.canonicalUserId, { includeDenied: true });
          const parts = [
            `处理消息 ${res.processedMessages} 条`,
            `提炼 ${res.extractedCount} 条`,
            `重试 ${res.retriedCount} 条`,
            `成功入库 ${res.syncedCount} 条`,
          ];
          if (res.degradedCount > 0) parts.push(`降级待补 ${res.degradedCount} 条`);
          if (res.deniedCount > 0) parts.push(`配额受限 ${res.deniedCount} 条`);
          if (res.errorCount > 0) parts.push(`失败 ${res.errorCount} 条`);
          const errSuffix = res.lastErrorCode
            ? `\n最近错误码: \`${res.lastErrorCode}\`${res.lastErrorMessage ? ` (${res.lastErrorMessage})` : ""}`
            : res.lastErrorMessage
              ? `\n最近错误: ${res.lastErrorMessage}`
              : "";
          return `记忆同步完成：${parts.join(" · ")}。${errSuffix}`;
        }

        const stats = ctx.deps.repo.getMemorySyncStats(ctx.canonicalUserId);
        const recent = ctx.deps.repo.listMemorySyncRecords(ctx.canonicalUserId, { limit: 6 });
        const statusView = ctx.deps.getMemoryStatus
          ? await ctx.deps.getMemoryStatus(ctx.canonicalUserId)
          : null;

        const lines: string[] = ["【长期记忆状态】"];
        if (statusView) {
          lines.push(
            `- 提供商: ${statusView.provider} (${statusView.configured ? "已就绪" : "未就绪/未启用"}) · 召回模式=${statusView.recallMode} · Curator=${statusView.curatorEnabled ? "开启" : "关闭"}`,
          );
          lines.push(
            `- Vaults: persona=${statusView.vaultIds.persona ?? "(未绑定)"} · tech=${statusView.vaultIds.tech ?? "(未绑定)"}`,
          );
          if (statusView.usage) {
            lines.push(
              `- 本月用量: 建库 ${statusView.usage.createCredits.toFixed(1)} (${statusView.usage.createCount} 次) · 管线 ${statusView.usage.queryCredits.toFixed(1)} (${statusView.usage.queryCount} 次) · 余额扣费 ${statusView.usage.userPaidCredits.toFixed(1)}`,
            );
          }
        }
        lines.push(
          `- 同步台账: synced=${stats.synced} · degraded=${stats.degraded} · denied=${stats.denied} · error=${stats.error} · erased=${stats.erased} · 待提炼消息=${stats.pendingRawMessages}`,
        );

        if (recent.length > 0) {
          lines.push("", "【近期提炼记忆】");
          for (const r of recent) {
            const normalized = r.content.replace(/\s+/g, " ").trim();
            const preview = normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized;
            lines.push(`- [${r.bank}/${r.status}] ${preview}`);
          }
        }
        return lines.join("\n");
      },
    })
    .register({
      command: "forget",
      description: "按关键词级联遗忘长期记忆",
      helpLine: "- `/forget <关键词>`：级联删除匹配到的长期记忆",
      requiresMemory: true,
      async execute(ctx) {
        const query = ctx.args.join(" ").trim();
        if (!query) {
          return "用法: `/forget <关键词或记忆ID>`";
        }
        if (!ctx.deps.forgetMemory) {
          return "当前运行时暂未接入 `/forget` 级联遗忘能力。";
        }
        const res = await ctx.deps.forgetMemory(ctx.canonicalUserId, query);
        if (res.matchedCount === 0) {
          return `未在记忆台账中找到包含 "${query}" 的记录。`;
        }
        const detail = [
          `匹配 ${res.matchedCount} 条`,
          `本地清除 ${res.erasedLocalCount} 条`,
          `远程删除 ${res.erasedRemoteCount} 条`,
        ];
        if (res.alreadyErasedCount > 0) detail.push(`远程已删 ${res.alreadyErasedCount} 条`);
        if (res.missingRemoteCount > 0) detail.push(`远程缺失 ${res.missingRemoteCount} 条`);
        if (res.unmappedCount > 0) detail.push(`历史未映射 ${res.unmappedCount} 条`);
        if (res.failedCount > 0) detail.push(`失败 ${res.failedCount} 条`);

        const errSuffix = res.errors.length > 0 ? `\n异常提示: ${res.errors.join("; ")}` : "";
        return `遗忘处理完成：${detail.join(" · ")}。${errSuffix}`;
      },
    })
    .register({
      command: "render2img",
      description: "将消息或 Markdown 文本渲染为图片",
      helpLine: "- `/render2img [--dark|-d|--light|-l] [文本]`：将回复消息或文本渲染为图片",
      async execute(ctx) {
        const { theme, inlineText } = parseRender2ImgArgs(ctx.rawArgs);
        const isReplying = Boolean(ctx.replyToPlatformMsgId || ctx.replyToText?.trim());

        let targetMarkdown = inlineText;
        if (!targetMarkdown) {
          if (!isReplying) {
            return RENDER2IMG_USAGE;
          }
          const resolved = resolveReplyMessageText({
            channel: ctx.channel,
            replyToPlatformMsgId: ctx.replyToPlatformMsgId,
            replyToText: ctx.replyToText,
            repo: ctx.deps.repo,
          });
          if (!resolved.text) {
            return "无法获取被回复消息的文本内容（可能为纯媒体消息，或本地未记录该消息原文）。";
          }
          targetMarkdown = resolved.text;
        }

        if (!ctx.deps.renderMarkdownImage) {
          return "当前运行时暂未接入 Markdown 渲染图片能力。";
        }

        try {
          const buffer = await ctx.deps.renderMarkdownImage(targetMarkdown, { theme });
          return { photo: { buffer } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `渲染图片失败：${msg}`;
        }
      },
    });

  return registry;
}

export const defaultSlashCommandRegistry = createDefaultSlashCommandRegistry();
export const SLASH_COMMAND_SPECS: readonly SlashCommandSpec[] =
  defaultSlashCommandRegistry.listSpecs();

/**
 * Build Telegram Bot API `setMyCommands` payload dynamically from runtime capabilities.
 */
export function buildTelegramBotCommands(
  options?: {
    memoryEnabled?: boolean;
    unboundOnly?: boolean;
  },
  registry: SlashCommandRegistry = defaultSlashCommandRegistry,
): TelegramBotCommandSpec[] {
  const memoryEnabled = options?.memoryEnabled ?? false;
  const unboundOnly = options?.unboundOnly ?? false;
  return registry
    .listSpecs()
    .filter((spec) => {
      if (spec.syncToPlatformPanel === false) return false;
      if (unboundOnly && !spec.availableWhenUnbound) return false;
      if (spec.requiresMemory && !memoryEnabled) return false;
      return true;
    })
    .map((spec) => ({
      command: spec.command,
      description: spec.description,
    }));
}

/**
 * Execute owner-only diagnostic/control slash commands outside the conversation history,
 * returning structured text and/or media output.
 */
export async function tryExecuteSlashCommand(
  input: SlashCommandInput,
  registry: SlashCommandRegistry = defaultSlashCommandRegistry,
): Promise<SlashCommandOutput | null> {
  return await registry.execute(input);
}

/**
 * Execute owner-only diagnostic/control slash commands outside the conversation history.
 * Returns null if the message is not a recognized system slash command.
 */
export async function tryHandleSlashCommand(
  canonicalUserId: string,
  text: string,
  deps: SlashCommandDeps,
  registry: SlashCommandRegistry = defaultSlashCommandRegistry,
): Promise<string | null> {
  const out = await registry.execute({ canonicalUserId, text, deps });
  if (!out) return null;
  if (out.text !== undefined) return out.text;
  if (out.photo) return "[已生成渲染图片]";
  return null;
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
