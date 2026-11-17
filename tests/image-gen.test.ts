import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { buildImagesGenerationsUrl, generateOpenAiImage } from "../src/worker/image-gen.js";

describe("OpenAI-compatible image_gen", () => {
  it("builds /v1/images/generations URLs cleanly", () => {
    assert.equal(
      buildImagesGenerationsUrl("https://claudeflare.top/v1"),
      "https://claudeflare.top/v1/images/generations",
    );
    assert.equal(
      buildImagesGenerationsUrl("https://api.openai.com"),
      "https://api.openai.com/v1/images/generations",
    );
  });

  it("saves b64_json output inside workspace and supports response_format fallback + url download", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let calls = 0;

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/v1/images/generations") {
          calls += 1;
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if (body.model === "image-2" && body.response_format === "b64_json") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Unknown parameter: response_format" } }));
            return;
          }
          if (body.model === "image-2") {
            const addr = server.address() as AddressInfo;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                data: [{ url: `http://127.0.0.1:${addr.port}/img/1.png` }],
              }),
            );
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: [{ b64_json: pngBytes.toString("base64") }],
            }),
          );
          return;
        }
        if (req.url === "/img/1.png") {
          res.writeHead(200, { "Content-Type": "image/png" });
          res.end(pngBytes);
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const workspaceDir = mkdtempSync(join(tmpdir(), "hato-imggen-"));

    try {
      const proxyRouter = new ScopedProxyRouter([]);

      // 1. image-2.5 via b64_json
      const res25 = await generateOpenAiImage({
        prompt: "cute blue bird",
        model: "image-2.5",
        filename: "bird_25.png",
        workspaceDir,
        providerSlug: "claudeflare",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        proxyRouter,
      });
      assert.equal(res25.ok, true);
      assert.equal(res25.files.length, 1);
      assert.equal(res25.files[0]?.relativePath, "bird_25.png");
      assert.equal(existsSync(res25.files[0]!.path), true);
      assert.deepEqual(readFileSync(res25.files[0]!.path), pngBytes);

      // 2. image-2 via response_format 400 fallback + URL download
      const res2 = await generateOpenAiImage({
        prompt: "cute blue bird",
        model: "image-2",
        filename: "bird_2.png",
        workspaceDir,
        providerSlug: "claudeflare",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        proxyRouter,
      });
      assert.equal(res2.ok, true);
      assert.equal(res2.files[0]?.relativePath, "bird_2.png");
      assert.deepEqual(readFileSync(res2.files[0]!.path), pngBytes);
      assert.equal(calls, 3);
    } finally {
      server.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
