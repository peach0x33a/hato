import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import {
  buildImagesGenerationsUrl,
  DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_IMAGE_GEN_TIMEOUT_MS,
  generateOpenAiImage,
} from "../src/worker/image-gen.js";

describe("OpenAI-compatible image_gen", () => {
  it("uses relaxed default generation and download timeouts", () => {
    assert.equal(DEFAULT_IMAGE_GEN_TIMEOUT_MS, 300_000);
    assert.equal(DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS, 60_000);
  });
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

  it("uses 'image' for single reference image and 'image[]' for multiple reference images", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const capturedBodies: string[] = [];

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/v1/images/edits") {
          capturedBodies.push(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const workspaceDir = mkdtempSync(join(tmpdir(), "hato-imggen-edit-"));

    try {
      const ref1 = join(workspaceDir, "ref1.png");
      const ref2 = join(workspaceDir, "ref2.png");
      writeFileSync(ref1, pngBytes);
      writeFileSync(ref2, pngBytes);

      const proxyRouter = new ScopedProxyRouter([]);

      const single = await generateOpenAiImage({
        prompt: "edit single",
        model: "gpt-image-2.5",
        referenceImagePaths: [ref1],
        workspaceDir,
        providerSlug: "claudeflare",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        proxyRouter,
      });
      assert.equal(single.ok, true);
      assert.match(capturedBodies[0]!, /name="image"; filename="ref1\.png"/);
      assert.doesNotMatch(capturedBodies[0]!, /name="image\[\]"/);

      const multi = await generateOpenAiImage({
        prompt: "edit multi",
        model: "gpt-image-2.5",
        referenceImagePaths: [ref1, ref2],
        workspaceDir,
        providerSlug: "claudeflare",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        proxyRouter,
      });
      assert.equal(multi.ok, true);
      assert.match(capturedBodies[1]!, /name="image\[\]"; filename="ref1\.png"/);
      assert.match(capturedBodies[1]!, /name="image\[\]"; filename="ref2\.png"/);
    } finally {
      server.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
