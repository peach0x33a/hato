import assert from "node:assert/strict";
import test from "node:test";
import { formatGatewayMessageLog } from "../src/gateway/msg-log.js";

test("formatGatewayMessageLog formats inbound and outbound IM messages with timezone, attachments, and escaped newlines", () => {
  const ts = Date.parse("2026-11-16T07:06:15Z"); // 15:06:15 Asia/Singapore (+8)

  const inbound = formatGatewayMessageLog({
    direction: "inbound",
    channel: "tg",
    timeZone: "Asia/Singapore",
    userSlug: "0x33a",
    text: "第一行\n第二行",
    timestampMs: ts,
    color: false,
  });
  assert.equal(inbound, "[MSG] [TG] [2026-11-16 15:06:15] 0x33a > Bot: 第一行\\n第二行");

  const outbound = formatGatewayMessageLog({
    direction: "outbound",
    channel: "tg",
    timeZone: "Asia/Singapore",
    userSlug: "0x33a",
    text: "收到啦",
    timestampMs: ts + 2000,
    color: false,
  });
  assert.equal(outbound, "[MSG] [TG] [2026-11-16 15:06:17] Bot > 0x33a: 收到啦");

  const attachmentOnly = formatGatewayMessageLog({
    direction: "inbound",
    channel: "tg",
    timeZone: "Asia/Singapore",
    userSlug: "owner",
    text: "",
    attachments: [{ kind: "file", filename: "report.pdf" }],
    timestampMs: ts,
    color: false,
  });
  assert.equal(
    attachmentOnly,
    "[MSG] [TG] [2026-11-16 15:06:15] owner > Bot: [file:report.pdf]",
  );

  const coloredInbound = formatGatewayMessageLog({
    direction: "inbound",
    channel: "tg",
    timeZone: "Asia/Singapore",
    userSlug: "0x33a",
    text: "你好",
    timestampMs: ts,
    color: true,
  });
  assert.ok(coloredInbound.includes("\x1b[1;36m[MSG]\x1b[0m"));
  assert.ok(coloredInbound.includes("\x1b[36m0x33a > Bot\x1b[0m: 你好"));
});
