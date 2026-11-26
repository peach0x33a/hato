import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { WorkerActivityKind, WorkerActivityPatch, WorkerActivityState } from "../activity-stream.js";

export interface MappedAcpUpdate {
  progressNote?: string;
  textDelta?: string;
  activities: WorkerActivityPatch[];
}

function extractContentBlockText(block: ContentBlock | undefined | null): string {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text" && typeof block.text === "string") {
    return block.text;
  }
  if (block.type === "resource" && block.resource && typeof block.resource === "object") {
    const res = block.resource as { text?: unknown; uri?: unknown };
    if (typeof res.text === "string") return res.text;
    if (typeof res.uri === "string") return res.uri;
  }
  if (block.type === "resource_link" && typeof block.uri === "string") {
    return block.name ? `${block.name} (${block.uri})` : block.uri;
  }
  return "";
}

function extractToolCallOutput(
  content: ToolCallContent[] | null | undefined,
  rawOutput: unknown,
): string | undefined {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "content") {
        const text = extractContentBlockText(item.content);
        if (text) parts.push(text);
      } else if (item.type === "diff") {
        const path = typeof item.path === "string" ? item.path : "";
        if (path) parts.push(`diff: ${path}`);
      } else if (item.type === "terminal") {
        parts.push(`terminal: ${item.terminalId}`);
      }
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  if (typeof rawOutput === "string") {
    return rawOutput;
  }
  if (rawOutput && typeof rawOutput === "object") {
    const obj = rawOutput as Record<string, unknown>;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.stdout === "string" || typeof obj.stderr === "string") {
      return [
        typeof obj.stdout === "string" ? obj.stdout : "",
        typeof obj.stderr === "string" && obj.stderr ? `[stderr]\n${obj.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    try {
      return JSON.stringify(rawOutput);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractCommandString(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const obj = rawInput as Record<string, unknown>;
  for (const key of ["command", "CommandLine", "cmd", "input"]) {
    if (typeof obj[key] === "string" && obj[key].trim()) {
      return obj[key];
    }
  }
  return undefined;
}

function mapToolStatus(status: ToolCallStatus | null | undefined): WorkerActivityState {
  if (status === "completed") return "done";
  if (status === "failed") return "error";
  return "running";
}

function mapToolKind(kind: ToolKind | null | undefined): WorkerActivityKind {
  return kind === "execute" ? "command" : "tool";
}

/**
 * Stateful per-turn mapper converting ACP `session/update` notifications
 * into Hato `WorkerActivityPatch` items, progress notes, and streamed text deltas.
 */
export class AcpEventMapper {
  private readonly toolMeta = new Map<string, { kind: WorkerActivityKind; title: string }>();
  private turnSeq = 0;

  resetForNewTurn(): void {
    this.turnSeq += 1;
    this.toolMeta.clear();
  }

  map(update: SessionUpdate): MappedAcpUpdate {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = extractContentBlockText(update.content);
        if (!text) {
          return { activities: [] };
        }
        const stepKey = update.messageId
          ? `acp_msg_${update.messageId}`
          : `acp_msg_turn_${this.turnSeq}`;
        return {
          textDelta: text,
          activities: [
            {
              stepKey,
              kind: "assistant",
              state: "running",
              title: "Worker 输出",
              appendText: text,
            },
          ],
        };
      }

      case "agent_thought_chunk": {
        return {
          progressNote: "正在思考推理...",
          activities: [],
        };
      }

      case "tool_call": {
        const kind = mapToolKind(update.kind);
        const title = update.title?.trim() || update.name?.trim() || "调用工具";
        const command = kind === "command" ? extractCommandString(update.rawInput) : undefined;
        this.toolMeta.set(update.toolCallId, { kind, title });
        const state = mapToolStatus(update.status);
        const output = extractToolCallOutput(update.content, update.rawOutput);
        return {
          progressNote:
            kind === "command" && command
              ? `正在执行: ${command.slice(0, 72)}`
              : `正在调用: ${title.slice(0, 72)}`,
          activities: [
            {
              stepKey: `acp_${update.toolCallId}`,
              kind,
              state,
              title: kind === "command" ? "执行命令" : title,
              ...(command ? { command } : {}),
              ...(output !== undefined ? { output } : {}),
            },
          ],
        };
      }

      case "tool_call_update": {
        const prev = this.toolMeta.get(update.toolCallId);
        const kind = update.kind ? mapToolKind(update.kind) : (prev?.kind ?? "tool");
        const title = update.title?.trim() || prev?.title || update.name?.trim() || "调用工具";
        this.toolMeta.set(update.toolCallId, { kind, title });
        const state = mapToolStatus(update.status);
        const command = kind === "command" ? extractCommandString(update.rawInput) : undefined;
        const output = extractToolCallOutput(update.content, update.rawOutput);
        return {
          ...(state === "done" && kind === "command"
            ? { progressNote: `命令已完成: ${(command ?? title).slice(0, 72)}` }
            : {}),
          activities: [
            {
              stepKey: `acp_${update.toolCallId}`,
              kind,
              state,
              ...(update.title ? { title: kind === "command" ? "执行命令" : update.title } : {}),
              ...(command ? { command } : {}),
              ...(output !== undefined ? { output } : {}),
            },
          ],
        };
      }

      case "plan": {
        const lines = Array.isArray(update.entries)
          ? update.entries.map((entry) => {
              const mark =
                entry.status === "completed"
                  ? "[x]"
                  : entry.status === "in_progress"
                    ? "[-]"
                    : "[ ]";
              return `${mark} ${entry.content}`;
            })
          : [];
        if (lines.length === 0) return { activities: [] };
        return {
          progressNote: "已更新执行计划",
          activities: [
            {
              stepKey: `acp_plan_${this.turnSeq}`,
              kind: "lifecycle",
              state: "done",
              title: "执行计划",
              text: lines.join("\n"),
            },
          ],
        };
      }

      case "current_mode_update": {
        return {
          activities: [
            {
              kind: "lifecycle",
              state: "done",
              title: `切换模式 · ${update.currentModeId}`,
            },
          ],
        };
      }

      default:
        return { activities: [] };
    }
  }
}
