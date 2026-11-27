import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { HatoRepository, RawMessageRecord } from "../db/repo.js";
import type { ChannelName } from "../gateway/types.js";
import { formatRecalledMemoriesBlock, type MemoryRecallItem } from "../memory/store.js";
import { formatLocalDateTime } from "../time/clock.js";
import { formatGapMarker, renderTimeCard } from "../time/timecard.js";
import { buildBubbleOutputPromptBlock, type BubbleSplitOptions } from "./bubbles.js";

export interface HatoUserBatchMessage {
  role: "hato_user_batch";
  id: string;
  channel: ChannelName;
  text: string;
  images: ImageContent[];
  replyToSummary?: string;
  ephemeralTail?: string;
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
  anchorMessageId?: string;
  anchorAgentIndex?: number;
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
  bubbles?: BubbleSplitOptions,
): string {
  const parts: string[] = [];
  const facts = repo.listRelationshipFacts();
  if (facts.length > 0) {
    const factLines = facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
    parts.push(`## Relationship & Agreements (Static Reference)\n${factLines}`);
  }
  if (personalSkillsIndexText.trim().length > 0) {
    parts.push(personalSkillsIndexText.trim());
  }
  if (toolIndexText.trim().length > 0) {
    parts.push(toolIndexText.trim());
  }
  if (bubbles) {
    parts.push(buildBubbleOutputPromptBlock(bubbles));
  }
  return parts.join("\n\n");
}

/**
 * Assemble Layer 1 static system prompt from persona markdown, static relationship facts,
 * the deterministic Level 1 Personal Skills index, and active bubble rules.
 * Note: Persona exposes the full canonically-sorted toolset for KV-cache prefix stability.
 */
export function buildStaticSystemPrompt(
  basePersonaPrompt: string,
  repo: HatoRepository,
  personalSkillsIndexText = "",
  toolIndexText = "",
  bubbles?: BubbleSplitOptions,
): string {
  const injected = buildSystemInjectedPromptText(
    repo,
    personalSkillsIndexText,
    toolIndexText,
    bubbles,
  );
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
      const who = referenced.role === "assistant" ? "your message" : "user";
      const preview = referenced.content.replace(/\s+/g, " ").trim().slice(0, 140);
      const refAtts = referenced.attachments
        .map((att) => {
          const pathSuffix = att.localPath ? ` (path: ${att.localPath})` : "";
          if (att.summary) {
            return `[Attachment ${att.kind}: ${att.summary}${pathSuffix}]`;
          }
          return `[Attachment ${att.kind}${att.filename ? `: ${att.filename}` : ""}${pathSuffix}]`;
        })
        .join(" ");
      if (preview && refAtts) {
        replyToSummary = `[Reply to ${who}: "${preview}" ${refAtts}]`;
      } else if (refAtts) {
        replyToSummary = `[Reply to ${who}: ${refAtts}]`;
      } else {
        replyToSummary = `[Reply to ${who}: "${preview}"]`;
      }
    }
  }

  const attachmentNotes = row.attachments
    .map((att) => {
      const pathSuffix = att.localPath ? ` (path: ${att.localPath})` : "";
      if (att.summary) {
        return `[Attachment ${att.kind}: ${att.summary}${pathSuffix}]`;
      }
      return `[Attachment ${att.kind}${att.filename ? `: ${att.filename}` : ""}${pathSuffix}]`;
    })
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
    sections.push(`<open_loops>\n${loops.map((l) => `- Follow up: ${l.content}`).join("\n")}\n</open_loops>`);
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

type UserPartKind = "summary" | "event" | "user" | "ephemeral";

/**
 * Convert Hato AgentMessages to standard LLM Message[] with:
 * - Immutable absolute timestamps ([MM-DD HH:mm])
 * - Channel switch tags ([TG]/[QQ]) only on channel change
 * - Deterministic gap dividers (—— 2 天 12 小时后 ——)
 * - Consecutive same-kind user blocks merged into one TextContent part; cross-kind blocks split into separate parts
 * - Ephemeral tail context anchored to the triggering UserMessage (independent final part) to preserve prefix cache
 * - Plain-string folding for text-only user messages on `openai-completions`
 */
export function convertHatoMessagesToLlm(
  messages: AgentMessage[],
  opts: {
    getTimezone: () => string;
    gapMarkerThresholdMinutes: number;
    modelApi?: string;
  },
): Message[] {
  const tz = opts.getTimezone();
  let ephemeralTail: {
    text: string;
    anchorMessageId?: string;
    anchorAgentIndex?: number;
  } | null = null;

  const filtered: AgentMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "hato_ephemeral_tail") {
      ephemeralTail = {
        text: msg.text,
        anchorMessageId: msg.anchorMessageId,
        anchorAgentIndex: msg.anchorAgentIndex,
      };
    } else {
      filtered.push(msg);
    }
  }

  const out: Message[] = [];
  const userLastPartKind: Array<UserPartKind | null> = [];
  let anchoredUserOutIndex: number | null = null;
  let prevConvTimestamp: number | null = null;
  let prevChannel: ChannelName | null = null;

  const trackAnchor = (msg: AgentMessage, idx: number): void => {
    const msgId = "id" in msg && typeof msg.id === "string" ? msg.id : undefined;
    if (ephemeralTail?.anchorMessageId && msgId === ephemeralTail.anchorMessageId) {
      anchoredUserOutIndex = out.length - 1;
    } else if (ephemeralTail?.anchorAgentIndex !== undefined && idx === ephemeralTail.anchorAgentIndex) {
      anchoredUserOutIndex = out.length - 1;
    }
  };

  for (let idx = 0; idx < filtered.length; idx++) {
    const msg = filtered[idx]!;

    if (msg.role === "hato_compaction_summary") {
      pushOrMergeUserPart(
        out,
        userLastPartKind,
        {
          type: "text",
          text: `[Rolling Summary (through ${formatLocalDateTime(msg.compactedUntilTs, tz).compactStamp})]\n${msg.text}`,
        },
        "summary",
        msg.timestamp,
      );
      trackAnchor(msg, idx);
      continue;
    }

    if (msg.role === "hato_executed_event") {
      const gap =
        prevConvTimestamp !== null
          ? formatGapMarker(prevConvTimestamp, msg.timestamp, opts.gapMarkerThresholdMinutes)
          : null;
      const stamp = formatLocalDateTime(msg.timestamp, tz).compactStamp;
      const prefix = gap ? `${gap}\n` : "";
      pushOrMergeUserPart(
        out,
        userLastPartKind,
        {
          type: "text",
          text: `${prefix}[Executed Event ${stamp}] ${msg.text}`,
        },
        "event",
        msg.timestamp,
      );
      trackAnchor(msg, idx);
      prevConvTimestamp = msg.timestamp;
      continue;
    }

    if (msg.role === "hato_user_batch") {
      const gap =
        prevConvTimestamp !== null
          ? formatGapMarker(prevConvTimestamp, msg.timestamp, opts.gapMarkerThresholdMinutes)
          : null;
      const stamp = formatLocalDateTime(msg.timestamp, tz).compactStamp;
      const channelTag = prevChannel && prevChannel !== msg.channel ? ` [via ${msg.channel.toUpperCase()}]` : "";
      const prefix = gap ? `${gap}\n[${stamp}]${channelTag} ` : `[${stamp}]${channelTag} `;

      pushOrMergeUserPart(
        out,
        userLastPartKind,
        { type: "text", text: `${prefix}${msg.text}` },
        "user",
        msg.timestamp,
      );
      for (const img of msg.images) {
        pushOrMergeUserPart(out, userLastPartKind, img, "user", msg.timestamp);
      }
      if (msg.ephemeralTail) {
        pushOrMergeUserPart(
          out,
          userLastPartKind,
          { type: "text", text: msg.ephemeralTail },
          "ephemeral",
          msg.timestamp,
        );
      }
      trackAnchor(msg, idx);
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
      userLastPartKind.push(null);
      prevConvTimestamp = msg.timestamp;
      prevChannel = msg.channel;
      continue;
    }

    // Pass through standard pi-agent-core runtime messages (system prompt/tool declarations, assistant toolCalls, toolResults)
    if (msg.role === "system") {
      out.push(msg);
      userLastPartKind.push(null);
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        pushOrMergeUserPart(
          out,
          userLastPartKind,
          { type: "text", text: msg.content },
          "user",
          msg.timestamp,
        );
      } else {
        for (const block of msg.content) {
          pushOrMergeUserPart(out, userLastPartKind, block, "user", msg.timestamp);
        }
      }
      trackAnchor(msg, idx);
      prevConvTimestamp = msg.timestamp;
    } else if (msg.role === "assistant" || msg.role === "toolResult") {
      out.push(msg);
      userLastPartKind.push(null);
      if (msg.role === "assistant") {
        prevConvTimestamp = msg.timestamp;
      }
    }
  }

  if (ephemeralTail) {
    attachEphemeralTailToUserMessage(out, ephemeralTail.text, anchoredUserOutIndex);
  }

  if (opts.modelApi === "openai-completions") {
    for (let i = 0; i < out.length; i++) {
      const m = out[i]!;
      if (m.role !== "user" || typeof m.content === "string") continue;
      if (m.content.every((block) => block.type === "text")) {
        out[i] = {
          ...m,
          content: m.content.map((block) => block.text).join("\n\n"),
        };
      }
    }
  }

  return out;
}

function pushOrMergeUserPart(
  out: Message[],
  userLastPartKind: Array<UserPartKind | null>,
  block: TextContent | ImageContent,
  kind: UserPartKind,
  timestamp: number,
): void {
  const prev = out[out.length - 1];
  if (!prev || prev.role !== "user") {
    out.push({
      role: "user",
      content: [block],
      timestamp,
    });
    userLastPartKind.push(block.type === "text" ? kind : null);
    return;
  }

  const prevBlocks: (TextContent | ImageContent)[] =
    typeof prev.content === "string" ? [{ type: "text", text: prev.content }] : [...prev.content];
  const lastKind = userLastPartKind[out.length - 1] ?? null;

  if (block.type === "text") {
    const lastBlock = prevBlocks[prevBlocks.length - 1];
    if (lastKind === kind && lastBlock && lastBlock.type === "text") {
      prevBlocks[prevBlocks.length - 1] = {
        type: "text",
        text: `${lastBlock.text}\n\n${block.text}`,
      };
    } else {
      prevBlocks.push(block);
    }
    userLastPartKind[out.length - 1] = kind;
  } else {
    prevBlocks.push(block);
    userLastPartKind[out.length - 1] = null;
  }

  out[out.length - 1] = {
    role: "user",
    content: prevBlocks,
    timestamp,
  };
}

function attachEphemeralTailToUserMessage(
  messages: Message[],
  tailText: string,
  anchoredUserOutIndex: number | null,
): void {
  const appendPart = (idx: number): void => {
    const m = messages[idx] as UserMessage;
    const prevBlocks: (TextContent | ImageContent)[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content];
    messages[idx] = {
      ...m,
      content: [...prevBlocks, { type: "text", text: tailText }],
    };
  };

  if (anchoredUserOutIndex !== null && messages[anchoredUserOutIndex]?.role === "user") {
    appendPart(anchoredUserOutIndex);
    return;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      appendPart(i);
      return;
    }
  }

  const userMsg: UserMessage = {
    role: "user",
    content: [{ type: "text", text: tailText }],
    timestamp: Date.now(),
  };
  messages.push(userMsg);
}
