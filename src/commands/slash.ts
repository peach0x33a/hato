import type { HatoRepository } from "../db/repo.js";
import type { ChannelName } from "../gateway/types.js";
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

export interface SlashCommandDeps {
  repo: HatoRepository;
  listModelSlots(): ModelSlotView[];
  listAvailableModels(): string[];
  setModelSlot(slot: string, target: string): ModelSlotView;
  reloadAll(): Promise<{ slots: ModelSlotView[]; proxyCount: number; changes?: string[] }>;
  forceCompact(canonicalUserId: string): Promise<boolean>;
  resetContext?(canonicalUserId: string): Promise<ResetContextResult>;
  setHomeChannel?(): Promise<SetHomeResult>;
}

/**
 * Execute owner-only diagnostic/control slash commands outside the conversation history.
 * Returns null if the message is not a recognized system slash command.
 */
export async function tryHandleSlashCommand(
  canonicalUserId: string,
  text: string,
  deps: SlashCommandDeps,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const [cmdRaw, ...args] = trimmed.split(/\s+/);
  const cmd = cmdRaw!.split("@")[0]!.toLowerCase();

  if (cmd === "/help") {
    return [
      "可用系统指令（不进入对话历史）：",
      "- `/new`：清空当前对话上下文，开启新会话",
      "- `/sethome`：将当前对话设为 Home Channel（主动关怀与定时通知默认入口）",
      "- `/trace`：查看上一轮上下文、时间卡、协议与 Prompt Cache 命中",
      "- `/model list`：查看当前 5 个槽位与可用模型",
      "- `/model set <slot> <provider/model>`：热切换槽位模型",
      "- `/reload`：热重载 `config/hato.toml` 与 `config/models.toml`",
      "- `/compact`：手动触发一次热区上下文压缩",
    ].join("\n");
  }

  if (cmd === "/trace") {
    const trace = deps.repo.getLatestTurnTrace(canonicalUserId);
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
  }

  if (cmd === "/model") {
    const sub = (args[0] ?? "list").toLowerCase();
    if (sub === "list") {
      const slotLines = deps
        .listModelSlots()
        .map((s) => `- ${s.slot}: ${s.target} [${s.api}] -> ${s.baseUrl}`);
      const avail = deps.listAvailableModels().map((m) => `  · ${m}`);
      return `【当前槽位绑定】\n${slotLines.join("\n")}\n\n【已配置模型】\n${avail.join("\n")}`;
    }

    if (sub === "set") {
      const slot = args[1];
      const target = args[2];
      if (!slot || !target) {
        return "用法: `/model set <slot> <provider/model_id>`（必须带 Provider 前缀）";
      }
      if (!target.includes("/")) {
        const candidates = deps
          .listAvailableModels()
          .filter((item) => item.slice(item.indexOf("/") + 1) === target);
        const hint =
          candidates.length > 0
            ? `\n匹配的带前缀目标：\n${candidates.map((c) => `  · \`${c}\``).join("\n")}`
            : "\n请执行 `/model list` 查看带 Provider 前缀的完整模型名。";
        return `模型选择必须带 Provider 前缀 \`<provider>/<model_id>\`，不能省略前缀（\`${target}\`）。${hint}`;
      }
      try {
        const updated = deps.setModelSlot(slot, target);
        return `已热切换槽位 \`${updated.slot}\` -> \`${updated.target}\` (${updated.api})`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `切换模型失败：${msg}`;
      }
    }

    return "未知 `/model` 子命令，请使用 `/model list` 或 `/model set <slot> <provider/model_id>`。";
  }

  if (cmd === "/reload") {
    try {
      const res = await deps.reloadAll();
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
  }

  if (cmd === "/compact") {
    const didCompact = await deps.forceCompact(canonicalUserId);
    return didCompact ? "已完成一次热区上下文压缩。" : "当前热区消息不足，暂无需压缩。";
  }

  if (cmd === "/new") {
    if (!deps.resetContext) {
      return "当前运行时暂未接入 `/new` 清空上下文能力。";
    }
    const res = await deps.resetContext(canonicalUserId);
    const parts: string[] = [];
    if (res.clearedHotMessages > 0) parts.push(`${res.clearedHotMessages} 条热区消息`);
    if (res.hadSummary) parts.push("前情摘要");
    const detail = parts.length > 0 ? `（已清理 ${parts.join("与")}）` : "（当前已是空白上下文）";
    return `已开启新对话，当前上下文已清空${detail}。`;
  }

  if (cmd === "/sethome") {
    if (!deps.setHomeChannel) {
      return "当前渠道暂未接入 `/sethome` 持久化绑定能力。";
    }
    try {
      const res = await deps.setHomeChannel();
      const channelLabel = res.channel === "tg" ? "Telegram" : "QQ";
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
  }

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
