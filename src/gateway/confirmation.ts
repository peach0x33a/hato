import { randomBytes } from "node:crypto";
import type { EventBus } from "../bus/actor-bus.js";
import type { HatoRepository } from "../db/repo.js";
import { summarizeError } from "../utils/logger.js";
import type { ChannelName } from "./types.js";

export type ConfirmationHandler<TPayload = unknown> = (
  canonicalUserId: string,
  payload: TPayload,
) => Promise<{ ok: boolean; message: string }>;

export interface ConfirmationServiceDeps {
  repo: HatoRepository;
  bus: EventBus;
  /** Fallback handler for worker-originated `awaiting_confirm` tickets (e.g. `TicketCoordinator.handleConfirmAction`). */
  onFallbackConfirm?: (ticketId: string, approved: boolean) => Promise<string>;
}

/**
 * Generic interactive confirmation service (inline buttons / text `确认 <id>`) shared across
 * `persona` (self_config, sensitive file send) and `worker` (elevated action approval)
 * without coupling Persona operations to `TicketCoordinator`.
 */
export class ConfirmationService {
  private readonly handlers = new Map<string, ConfirmationHandler<unknown>>();

  constructor(private readonly deps: ConfirmationServiceDeps) {}

  registerHandler<TPayload>(kind: string, handler: ConfirmationHandler<TPayload>): void {
    this.handlers.set(kind, handler as ConfirmationHandler<unknown>);
  }

  async requestConfirm<TPayload>(params: {
    canonicalUserId: string;
    channel: ChannelName;
    kind: string;
    briefTitle: string;
    progressNote: string;
    promptText: string;
    payload: TPayload;
    returnMessage?: string;
  }): Promise<{ ok: boolean; ticketId: string; message: string }> {
    const ticketId = `t_${randomBytes(4).toString("hex")}`;
    const briefTitle = params.briefTitle.slice(0, 48);

    this.deps.repo.createTicket({
      id: ticketId,
      canonicalUserId: params.canonicalUserId,
      status: "awaiting_confirm",
      backend: "builtin-pi",
      briefTitle,
      originChannel: params.channel,
      progressNote: params.progressNote,
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
        confirm_kind: params.kind,
        confirm_payload: params.payload,
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
      message:
        params.returnMessage ??
        `已发送确认请求 (${ticketId})：${briefTitle}，需主人显式确认后才会执行。`,
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

  async handleConfirmAction(ticketId: string, approved: boolean): Promise<string> {
    const ticket = this.deps.repo.getTicket(ticketId);
    if (!ticket) {
      return `未找到工单 ${ticketId}`;
    }
    if (ticket.status !== "awaiting_confirm") {
      return `工单 ${ticketId} 当前状态为 ${ticket.status}，无需确认。`;
    }

    const parsed = parseGenericConfirmPayload(ticket.resultJson);
    if (!parsed) {
      if (this.deps.onFallbackConfirm) {
        return this.deps.onFallbackConfirm(ticketId, approved);
      }
      if (!approved) {
        this.deps.repo.updateTicket(ticketId, {
          status: "cancelled",
          progressNote: "用户已取消执行",
        });
        return `已取消工单 ${ticketId}`;
      }
      return `工单 ${ticketId} 缺少确认处理器。`;
    }

    if (!approved) {
      this.deps.repo.updateTicket(ticketId, {
        status: "cancelled",
        progressNote: "用户已取消执行",
      });
      return `已取消工单 ${ticketId}`;
    }

    const handler = this.handlers.get(parsed.kind);
    if (!handler) {
      this.deps.repo.updateTicket(ticketId, {
        status: "failed",
        progressNote: `缺少确认执行器 (${parsed.kind})`,
      });
      return `工单 ${ticketId} 执行失败：未接入 ${parsed.kind} 执行器。`;
    }

    this.deps.repo.updateTicket(ticketId, {
      status: "running",
      progressNote: "主人已确认，正在执行",
    });

    try {
      const res = await handler(ticket.canonicalUserId, parsed.payload);
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
}

function parseGenericConfirmPayload(
  resultJson: string | null | undefined,
): { kind: string; payload: unknown } | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    if (typeof parsed.confirm_kind === "string" && parsed.confirm_kind.trim()) {
      return {
        kind: parsed.confirm_kind,
        payload: parsed.confirm_payload,
      };
    }
    if (parsed.sensitive_file_confirm && typeof parsed.sensitive_file_confirm === "object") {
      return { kind: "send_env_file", payload: parsed.sensitive_file_confirm };
    }
    if (parsed.self_config_confirm && typeof parsed.self_config_confirm === "object") {
      return { kind: "self_config", payload: parsed.self_config_confirm };
    }
  } catch {
    return null;
  }
  return null;
}
