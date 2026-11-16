import type { ChannelAdapter, ChannelCapabilities, OutboundConfirmAction } from "./types.js";

/**
 * Planned QQ Official Bot C2C adapter (Phase 6).
 *
 * Integration notes (reference Hermes / OpenClaw adapters when implementing):
 * - C2C passive replies require the inbound msg_id within the platform validity window
 *   and incremental msg_seq (capped at 4 messages per msg_id; keep bubble maxPerTurn <= 3).
 * - Proactive / scheduled care messages use is_wakeup / periodic recall limits and should
 *   fall back to Telegram (or queue in pending_deliveries) when rejected by quota/permissions.
 * - Rich media / artifacts require uploading via /v2/users/{openid}/files to acquire file_info
 *   before sending msg_type = 7.
 * - Base URL override comes from config/hato.toml [gateway.qq].base_url and outbound HTTP/WS
 *   calls run under proxy scope "gateway.qq".
 */
export const QQ_PLANNED_CAPABILITIES: ChannelCapabilities = {
  channel: "qq",
  maxBubblesPerTurn: 3,
  supportsInlineConfirm: false,
  supportsDirectFileUpload: true,
  proactiveSupported: false,
};

export class PlannedQqAdapter implements ChannelAdapter {
  readonly capabilities = QQ_PLANNED_CAPABILITIES;

  async start(): Promise<void> {
    throw new Error("QQ Official Bot adapter is planned for Phase 6 and not yet enabled.");
  }

  async stop(): Promise<void> {
    // No-op while disabled.
  }

  async sendText(_platformUserId: string, _text: string): Promise<string | undefined> {
    throw new Error("QQ Official Bot adapter is planned for Phase 6.");
  }

  async sendBubbles(): Promise<void> {
    throw new Error("QQ Official Bot adapter is planned for Phase 6.");
  }

  async sendConfirm(_platformUserId: string, _confirm: OutboundConfirmAction): Promise<void> {
    throw new Error("QQ Official Bot adapter is planned for Phase 6.");
  }
}
