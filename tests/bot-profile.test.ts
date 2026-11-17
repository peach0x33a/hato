import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { updateTelegramBotProfile } from "../src/setup/probe.js";

describe("updateTelegramBotProfile", () => {
  it("calls setMyName, setMyDescription, setMyShortDescription, and multipart setMyProfilePhoto", async () => {
    const calls: Array<{ url: string; contentType: string; body: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        calls.push({
          url: req.url ?? "",
          contentType: String(req.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: true }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const tmpDir = mkdtempSync(join(tmpdir(), "hato-botprof-"));
    const avatarFile = join(tmpDir, "avatar.jpg");
    writeFileSync(avatarFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

    try {
      const res = await updateTelegramBotProfile({
        baseUrl: `http://127.0.0.1:${port}`,
        botToken: "123:ABC",
        proxyRouter: new ScopedProxyRouter([]),
        name: "八千代",
        description: "个人助手",
        shortDescription: "Hato Bot",
        avatarPath: avatarFile,
      });

      assert.equal(res.ok, true);
      assert.deepEqual(res.updated, ["name", "description", "short_description", "avatar"]);
      assert.equal(calls.length, 4);
      assert.equal(calls[0]?.url, "/bot123:ABC/setMyName");
      assert.equal(JSON.parse(calls[0]!.body).name, "八千代");
      assert.equal(calls[1]?.url, "/bot123:ABC/setMyDescription");
      assert.equal(calls[2]?.url, "/bot123:ABC/setMyShortDescription");
      assert.equal(calls[3]?.url, "/bot123:ABC/setMyProfilePhoto");
      assert.match(calls[3]!.contentType, /^multipart\/form-data/);
      assert.ok(calls[3]!.body.includes('"type":"static"'));
      assert.ok(calls[3]!.body.includes("attach://avatar"));
    } finally {
      server.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
