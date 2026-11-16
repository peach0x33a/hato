import { colorize, formatLogLine, shouldUseColor } from "../utils/logger.js";
import type { ChannelName, InboundAttachment } from "./types.js";

export interface GatewayMessageLogInput {
  direction: "inbound" | "outbound";
  channel: ChannelName;
  timeZone: string;
  userSlug: string;
  text: string;
  attachments?: readonly InboundAttachment[];
  timestampMs?: number;
  color?: boolean;
}

/**
 * Format gateway inbound/outbound terminal log line:
 * - [MSG] [TG] [YYYY-MM-DD HH:mm:ss] <user_slug> > Bot: <text>
 * - [MSG] [TG] [YYYY-MM-DD HH:mm:ss] Bot > <user_slug>: <text>
 */
export function formatGatewayMessageLog(input: GatewayMessageLogInput): string {
  const useColor = input.color ?? shouldUseColor(process.stdout);
  const rawRoute =
    input.direction === "inbound" ? `${input.userSlug} > Bot` : `Bot > ${input.userSlug}`;
  const styledRoute = colorize(rawRoute, input.direction === "inbound" ? "36" : "32", useColor);

  const cleanText = input.text.replace(/\r?\n/g, "\\n").trim();
  const attachmentTags = (input.attachments ?? []).map((att) => {
    const label = att.summary
      ? `[${att.kind}:${att.summary}]`
      : att.filename
        ? `[${att.kind}:${att.filename}]`
        : `[${att.kind}]`;
    return colorize(label, "33", useColor);
  });
  const body =
    [cleanText, ...attachmentTags].filter(Boolean).join(" ") ||
    colorize("(empty)", "2", useColor);

  return formatLogLine("MSG", input.channel, `${styledRoute}: ${body}`, {
    timeZone: input.timeZone,
    timestampMs: input.timestampMs,
    color: useColor,
  });
}
