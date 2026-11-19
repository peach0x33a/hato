import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { HatoRepository, RawMessageRecord } from "../db/repo.js";
import type { ChannelName } from "../gateway/types.js";
import { formatRecalledMemoriesBlock, type MemoryRecallItem } from "../memory/store.js";
import { formatLocalDateTime } from "../time/clock.js";
import { formatGapMarker, renderTimeCard } from "../time/timecard.js";

export interface HatoUserBatchMessage {
  role: "hato_user_batch";
  id: string;
  channel: ChannelName;
  text: string;
  images: ImageContent[];
  replyToSummary?: string;
  timestamp: number;
}

export interface HatoPersonaTurnMessage {
  role: "hato_persona_turn";
  id: string;
  channel: ChannelName;
  text: string;
  timestamp: number;
}

export interface HatoExecutedEventMessage {
  role: "hato_executed_event";
  id: string;
  text: string;
  timestamp: number;
}

export interface HatoCompactionSummaryMessage {
  role: "hato_compaction_summary";
  text: string;
  compactedUntilTs: number;
  timestamp: number;
}

export interface HatoEphemeralTailMessage {
  role: "hato_ephemeral_tail";
  text: string;
  timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    hato_user_batch: HatoUserBatchMessage;
    hato_persona_turn: HatoPersonaTurnMessage;
    hato_executed_event: HatoExecutedEventMessage;
    hato_compaction_summary: HatoCompactionSummaryMessage;
    hato_ephemeral_tail: HatoEphemeralTailMessage;
  }
}

export interface EphemeralTailBuilderInput {
  nowMs: number;
  repo: HatoRepository;
  canonicalUserId: string;
  baseTimezone: string;
  quietHours: { start: string; end: string };
  recalledMemories?: readonly MemoryRecallItem[];
}

/**
 * Build the immutable runtime-injected suffix appended after the configurable Layer 1 prompt
 * (static relationship facts + Level 1 Personal Skills index).
 */
export function buildSystemInjectedPromptText(
  repo: HatoRepository,
  personalSkillsIndexText = "",
  toolIndexText = "",
): string {
  const parts: string[] = [];
  const facts = repo.listRelationshipFacts();
  if (facts.length > 0) {
    const factLines = facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
    parts.push(`## 关系与约定（固定参考）\n${factLines}`);
  }
  if (personalSkillsIndexText.trim().length > 0) {
    parts.push(personalSkillsIndexText.trim());
  }
  if (toolIndexText.trim().length > 0) {
    parts.push(toolIndexText.trim());
  }
  return parts.join("\n\n");
}

/**
 * Assemble Layer 1 static system prompt from persona markdown, static relationship facts,
 * the deterministic Level 1 Personal Skills index, and the on-demand tool index.
 */
export function buildStaticSystemPrompt(
  basePersonaPrompt: string,
  repo: HatoRepository,
  personalSkillsIndexText = "",
  toolIndexText = "",
): string {
  const injected = buildSystemInjectedPromptText(repo, personalSkillsIndexText, toolIndexText);
  return [basePersonaPrompt.trim(), injected].filter(Boolean).join("\n\n");
}

/**
 * Hydrate persistent AgentMessage[] transcript from SQLite Layer 2 (summary) + Layer 3 (hot messages).
 */
export function hydrateTranscriptFromDb(repo: HatoRepository, canonicalUserId: string): AgentMessage[] {
  const state = repo.getWorkingMemory(canonicalUserId);
  const hot = repo.getHotMessages(canonicalUserId, state.compactedUntilTs);
  const messages: AgentMessage[] = [];

  if (state.summaryText.trim().length > 0) {
    messages.push({
      role: "hato_compaction_summary",
      text: state.summaryText,
      compactedUntilTs: state.compactedUntilTs,
      timestamp: state.compactedUntilTs || Date.now(),
    });
  }

  for (const row of hot) {
    messages.push(rawRecordToAgentMessage(row, repo));
  }
  return messages;
}

export function rawRecordToAgentMessage(row: RawMessageRecord, repo?: HatoRepository): AgentMessage {
  if (row.role === "assistant") {
    return {
      role: "hato_persona_turn",
      id: row.id,
      channel: row.channel,
      text: row.content,
      timestamp: row.createdAt,
    };
  }
  if (row.role === "executed_event") {
    return {
      role: "hato_executed_event",
      id: row.id,
      text: row.content,
      timestamp: row.createdAt,
    };
  }

  let replyToSummary: string | undefined;
  if (row.replyToId && repo) {
    const referenced = repo.findMessageByPlatformId(row.channel, row.replyToId);
    if (referenced) {
      const preview = referenced.content.replace(/\s+/g, " ").slice(0, 140);
      replyToSummary = `[引用 ${referenced.role === "assistant" ? "你的话" : "用户原话"}: "${preview}"]`;
    }
  }

  const attachmentNotes = row.attachments
    .map((att) => (att.summary ? `[附件 ${att.kind}: ${att.summary}]` : `[附件 ${att.kind}${att.filename ? `: ${att.filename}` : ""}]`))
    .join("\n");

  const combinedText = [replyToSummary, row.content, attachmentNotes].filter(Boolean).join("\n");
  return {
    role: "hato_user_batch",
    id: row.id,
    channel: row.channel,
    text: combinedText,
    images: [],
    replyToSummary,
    timestamp: row.createdAt,
  };
}

/**
 * Build Layer 4 ephemeral context block (time card + open loops + ticket board)
 * injected at the tail without mutating persisted history.
 */
export function buildEphemeralContextBlock(input: EphemeralTailBuilderInput): {
  tailText: string;
  timeCardText: string;
} {
  const activeOverride = input.repo.getActiveScheduleOverride(input.canonicalUserId, input.nowMs);
  const lastUserMsg = input.repo.getLastUserMessage(input.canonicalUserId);

  const timeCardText = renderTimeCard({
    nowMs: input.nowMs,
    baseTimezone: input.baseTimezone,
    quietHours: input.quietHours,
    lastUserMessageMs: lastUserMsg?.createdAt ?? null,
    activeOverride: activeOverride
      ? {
          tempTimezone: activeOverride.tempTimezone,
          statusNote: activeOverride.statusNote,
          expiresAt: activeOverride.expiresAt,
        }
      : null,
  });

  const sections: string[] = [];

  if (input.recalledMemories && input.recalledMemories.length > 0) {
    const recalledBlock = formatRecalledMemoriesBlock(input.recalledMemories);
    if (recalledBlock) {
      sections.push(recalledBlock);
    }
  }

  const loops = input.repo
    .listOpenLoops(input.canonicalUserId, 10)
    .filter((l) => l.status === "pending" && l.dueAt <= input.nowMs);
  if (loops.length > 0) {
    sections.push(`<open_loops>\n${loops.map((l) => `- 将跟进: ${l.content}`).join("\n")}\n</open_loops>`);
  }

  const activeTickets = input.repo
    .listTickets(input.canonicalUserId, 8)
    .filter((t) => ["routing", "pending", "running", "needs_input", "awaiting_confirm"].includes(t.status));
  if (activeTickets.length > 0) {
    const board = activeTickets
      .map((t) => `- [${t.id}] (${t.status}) ${t.briefTitle}${t.progressNote ? ` · ${t.progressNote}` : ""}`)
      .join("\n");
    sections.push(`<ticket_board>\n${board}\n</ticket_board>`);
  }

  sections.push(timeCardText);
  return { tailText: sections.join("\n\n"), timeCardText };
}

/**
 * Convert Hato AgentMessages to standard LLM Message[] with:
 * - Immutable absolute timestamps ([MM-DD HH:mm])
 * - Channel switch tags ([TG]/[QQ]) only on channel change
 * - Deterministic gap dividers (—— 2 天 12 小时后 ——)
 * - Ephemeral tail context merged onto the final UserMessage to preserve prefix cache & role alternation
 */
export function convertHatoMessagesToLlm(
  messages: AgentMessage[],
  opts: {
    getTimezone: () => string;
    gapMarkerThresholdMinutes: number;
  },
): Message[] {
  const tz = opts.getTimezone();
  let ephemeralTail: string | null = null;

  const filtered: AgentMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "hato_ephemeral_tail") {
      ephemeralTail = msg.text;
    } else {
      filtered.push(msg);
    }
  }

  const out: Message[] = [];
  let prevConvTimestamp: number | null = null;
  let prevChannel: ChannelName | null = null;

  for (const msg of filtered) {
    if (msg.role === "hato_compaction_summary") {
      pushOrMergeUserMessage(out, {
        role: "user",
        content: `[前情对话滚动摘要（截至 ${formatLocalDateTime(msg.compactedUntilTs, tz).compactStamp}）]\n${msg.text}`,
        timestamp: msg.timestamp,
      });
      continue;
    }

    if (msg.role === "hato_executed_event") {
      const gap =
        prevConvTimestamp !== null
          ? formatGapMarker(prevConvTimestamp, msg.timestamp, opts.gapMarkerThresholdMinutes)
          : null;
      const stamp = formatLocalDateTime(msg.timestamp, tz).compactStamp;
      const prefix = gap ? `${gap}\n` : "";
      pushOrMergeUserMessage(out, {
        role: "user",
        content: `${prefix}[事件 ${stamp} 已执行] ${msg.text}`,
        timestamp: msg.timestamp,
      });
      prevConvTimestamp = msg.timestamp;
      continue;
    }

    if (msg.role === "hato_user_batch") {
      const gap =
        prevConvTimestamp !== null
          ? formatGapMarker(prevConvTimestamp, msg.timestamp, opts.gapMarkerThresholdMinutes)
          : null;
      const stamp = formatLocalDateTime(msg.timestamp, tz).compactStamp;
      const channelTag = prevChannel && prevChannel !== msg.channel ? ` [来自 ${msg.channel.toUpperCase()}]` : "";
      const prefix = gap ? `${gap}\n[${stamp}]${channelTag} ` : `[${stamp}]${channelTag} `;

      if (msg.images.length > 0) {
        const blocks: (TextContent | ImageContent)[] = [
          { type: "text", text: `${prefix}${msg.text}` },
          ...msg.images,
        ];
        pushOrMergeUserMessage(out, { role: "user", content: blocks, timestamp: msg.timestamp });
      } else {
        pushOrMergeUserMessage(out, { role: "user", content: `${prefix}${msg.text}`, timestamp: msg.timestamp });
      }
      prevConvTimestamp = msg.timestamp;
      prevChannel = msg.channel;
      continue;
    }

    if (msg.role === "hato_persona_turn") {
      // Keep assistant turns clean without synthetic "[MM-DD HH:mm]" prefixes so the
      // model does not mimic timestamps in its own output; user/event messages carry timestamps.
      out.push({
        role: "assistant",
        content: [{ type: "text", text: msg.text }],
        api: "openai-completions",
        provider: "hato-history",
        model: "hato-history",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: msg.timestamp,
      });
      prevConvTimestamp = msg.timestamp;
      prevChannel = msg.channel;
      continue;
    }

    // Pass through standard pi-agent-core runtime messages (system prompt/tool declarations, assistant toolCalls, toolResults)
    if (msg.role === "system") {
      out.push(msg);
    } else if (msg.role === "user") {
      pushOrMergeUserMessage(out, msg);
      prevConvTimestamp = msg.timestamp;
    } else if (msg.role === "assistant" || msg.role === "toolResult") {
      out.push(msg);
      if (msg.role === "assistant") {
        prevConvTimestamp = msg.timestamp;
      }
    }
  }

  if (ephemeralTail) {
    attachEphemeralTailToLastUserMessage(out, ephemeralTail);
  }

  return out;
}

function pushOrMergeUserMessage(out: Message[], next: UserMessage): void {
  const prev = out[out.length - 1];
  if (!prev || prev.role !== "user") {
    out.push(next);
    return;
  }

  if (typeof prev.content === "string" && typeof next.content === "string") {
    out[out.length - 1] = {
      role: "user",
      content: `${prev.content}\n\n${next.content}`,
      timestamp: next.timestamp,
    };
    return;
  }

  const prevBlocks: (TextContent | ImageContent)[] =
    typeof prev.content === "string" ? [{ type: "text", text: prev.content }] : prev.content;
  const nextBlocks: (TextContent | ImageContent)[] =
    typeof next.content === "string" ? [{ type: "text", text: next.content }] : next.content;

  out[out.length - 1] = {
    role: "user",
    content: [...prevBlocks, ...nextBlocks],
    timestamp: next.timestamp,
  };
}

function attachEphemeralTailToLastUserMessage(messages: Message[], tailText: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;

    if (typeof m.content === "string") {
      messages[i] = { ...m, content: `${m.content}\n\n${tailText}` };
    } else {
      const nextContent = [...m.content, { type: "text" as const, text: `\n\n${tailText}` }];
      messages[i] = { ...m, content: nextContent };
    }
    return;
  }

  const userMsg: UserMessage = {
    role: "user",
    content: tailText,
    timestamp: Date.now(),
  };
  messages.push(userMsg);
}
