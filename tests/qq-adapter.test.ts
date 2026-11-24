import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { QqAdapter, cleanQqFaceTags, splitQqText } from "../src/gateway/qq.js";
import { QqOpenApiClient } from "../src/gateway/qq-client.js";

describe("QQ Official Bot adapter", () => {
  it("exchanges and caches App Access Token, and refreshes on 401/11244", async () => {
    let tokenCalls = 0;
    let sendCalls = 0;
    const seenHeaders: Array<{ auth?: string; appid?: string }> = [];
    const seenBodies: Array<Record<string, unknown>> = [];

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        if (req.url === "/app/getAppAccessToken") {
          tokenCalls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: `tok_${tokenCalls}`,
              expires_in: 7200,
            }),
          );
          return;
        }
        if (req.url === "/v2/users/openid_1/messages") {
          sendCalls += 1;
          seenHeaders.push({
            auth: req.headers.authorization,
            appid: String(req.headers["x-union-appid"] ?? ""),
          });
          seenBodies.push(JSON.parse(bodyStr) as Record<string, unknown>);
          if (sendCalls === 1) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ code: 11244, message: "token expired" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "msg_out_1", timestamp: "2026-11-17T10:00:00Z" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const proxyRouter = new ScopedProxyRouter([]);
      const client = new QqOpenApiClient({
        baseUrl,
        appId: "102000001",
        clientSecret: "sec_xyz",
        proxyRouter,
        tokenUrl: `${baseUrl}/app/getAppAccessToken`,
      });

      const out = await client.sendC2CMessage("openid_1", {
        content: "hello qq",
        msg_type: 0,
        msg_id: "in_1",
        msg_seq: 1,
      });

      assert.equal(out.id, "msg_out_1");
      assert.equal(tokenCalls, 2);
      assert.equal(sendCalls, 2);
      assert.equal(seenHeaders[0]?.auth, "QQBot tok_1");
      assert.equal(seenHeaders[0]?.appid, "102000001");
      assert.equal(seenHeaders[1]?.auth, "QQBot tok_2");
      assert.equal(seenBodies[1]?.msg_id, "in_1");
      assert.equal(seenBodies[1]?.msg_seq, 1);
    } finally {
      server.close();
    }
  });

  it("tracks passive msg_id & incremental msg_seq per user and splits long text", async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/app/getAppAccessToken") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ access_token: "tok_ok", expires_in: 7200 }));
          return;
        }
        if (req.url === "/v2/users/owner_qq_1/messages") {
          sentPayloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: `m_${sentPayloads.length}` }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const cfg = createDefaultHatoConfig();
      cfg.gateway.qq.base_url = baseUrl;
      cfg.owner.channels.qq.open_ids = ["owner_qq_1"];

      const inbound: Array<{ text: string; platformUserId: string }> = [];
      const adapter = new QqAdapter({
        config: cfg,
        appId: "102000001",
        clientSecret: "sec_xyz",
        proxyRouter: new ScopedProxyRouter([]),
        tokenUrl: `${baseUrl}/app/getAppAccessToken`,
        onInboundMessage: (msg) => inbound.push({ text: msg.text, platformUserId: msg.platformUserId }),
      });

      // Simulate inbound C2C event
      await (adapter as unknown as { handleC2CMessage: (evt: unknown) => Promise<void> }).handleC2CMessage({
        id: "inbound_msg_99",
        content: "  你好呀  ",
        timestamp: "2026-11-17T10:00:00Z",
        author: { user_openid: "owner_qq_1" },
      });

      assert.equal(inbound.length, 1);
      assert.equal(inbound[0]?.text, "你好呀");

      await adapter.sendBubbles("owner_qq_1", ["第一句", "第二句"], [0, 0]);
      assert.equal(sentPayloads.length, 2);
      assert.equal(sentPayloads[0]?.msg_id, "inbound_msg_99");
      assert.equal(sentPayloads[0]?.msg_seq, 1);
      assert.equal(sentPayloads[1]?.msg_id, "inbound_msg_99");
      assert.equal(sentPayloads[1]?.msg_seq, 2);

      const parts = splitQqText("a".repeat(2500), 2000);
      assert.equal(parts.length, 2);
    } finally {
      server.close();
    }
  });

  it("detects PNG sent as content_type='file' as image and converts it for model vision", async () => {
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const tempDir = mkdtempSync(join(tmpdir(), "hato-qq-att-"));
    const server = createServer((req, res) => {
      if (req.url === "/files/07_ref.png") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(tinyPng);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const cfg = createDefaultHatoConfig();
      cfg.paths.sqlite = join(tempDir, "hato.db");
      cfg.gateway.qq.base_url = baseUrl;
      cfg.owner.channels.qq.open_ids = ["owner_qq_1"];

      const inbound: Array<{
        attachments: Array<{ kind: string; mimeType?: string; localPath?: string }>;
        imagesCount: number;
      }> = [];
      const adapter = new QqAdapter({
        config: cfg,
        appId: "102000001",
        clientSecret: "sec_xyz",
        proxyRouter: new ScopedProxyRouter([]),
        onInboundMessage: (msg) =>
          inbound.push({
            attachments: msg.attachments,
            imagesCount: msg.images?.length ?? 0,
          }),
      });

      await (adapter as unknown as { handleC2CMessage: (evt: unknown) => Promise<void> }).handleC2CMessage({
        id: "inbound_file_img_1",
        content: "你自己看看",
        timestamp: "2026-11-21T08:57:05Z",
        author: { user_openid: "owner_qq_1" },
        attachments: [
          {
            filename: "07_服装02_居家休闲.png",
            content_type: "file",
            url: `${baseUrl}/files/07_ref.png`,
          },
        ],
      });

      assert.equal(inbound.length, 1);
      assert.equal(inbound[0]?.imagesCount, 1);
      assert.equal(inbound[0]?.attachments[0]?.kind, "image");
      assert.equal(inbound[0]?.attachments[0]?.mimeType, "image/png");
      assert.ok(inbound[0]?.attachments[0]?.localPath);
    } finally {
      server.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("shares msg_seq across explicit replyToPlatformMsgId ack and subsequent passive sendBubbles", async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/app/getAppAccessToken") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ access_token: "tok_ok", expires_in: 7200 }));
          return;
        }
        if (req.url === "/v2/users/owner_qq_1/messages") {
          sentPayloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: `m_${sentPayloads.length}` }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const cfg = createDefaultHatoConfig();
      cfg.gateway.qq.base_url = baseUrl;
      cfg.owner.channels.qq.open_ids = ["owner_qq_1"];

      const adapter = new QqAdapter({
        config: cfg,
        appId: "102000001",
        clientSecret: "sec_xyz",
        proxyRouter: new ScopedProxyRouter([]),
        tokenUrl: `${baseUrl}/app/getAppAccessToken`,
        onInboundMessage: () => {},
      });

      await (adapter as unknown as { handleC2CMessage: (evt: unknown) => Promise<void> }).handleC2CMessage({
        id: "inbound_steer_1",
        content: "？？我没给你发链接啊",
        timestamp: "2026-11-21T13:43:00Z",
        author: { user_openid: "owner_qq_1" },
      });

      await adapter.sendText("owner_qq_1", "知道了", "inbound_steer_1");
      await adapter.sendBubbles("owner_qq_1", ["第一句", "第二句"], [0, 0]);
      await adapter.sendText("owner_qq_1", "第四句");
      await adapter.sendText("owner_qq_1", "第五句（超出被动上限转主动）");

      assert.equal(sentPayloads.length, 5);
      assert.equal(sentPayloads[0]?.msg_id, "inbound_steer_1");
      assert.equal(sentPayloads[0]?.msg_seq, 1);
      assert.equal(sentPayloads[1]?.msg_id, "inbound_steer_1");
      assert.equal(sentPayloads[1]?.msg_seq, 2);
      assert.equal(sentPayloads[2]?.msg_id, "inbound_steer_1");
      assert.equal(sentPayloads[2]?.msg_seq, 3);
      assert.equal(sentPayloads[3]?.msg_id, "inbound_steer_1");
      assert.equal(sentPayloads[3]?.msg_seq, 4);
      assert.equal(sentPayloads[4]?.msg_id, undefined);
      assert.equal(sentPayloads[4]?.msg_seq, undefined);
    } finally {
      server.close();
    }
  });
});

test("cleanQqFaceTags decodes base64 ext text and strips raw faceType tags", () => {
  assert.equal(
    cleanQqFaceTags('<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">你想不想看你的图片'),
    "[表情]你想不想看你的图片",
  );
  const namedExt = Buffer.from(JSON.stringify({ text: "/微笑" }), "utf8").toString("base64");
  assert.equal(
    cleanQqFaceTags(`你好<faceType=1,faceId="14",ext="${namedExt}">`),
    "你好[表情:微笑]",
  );
});
