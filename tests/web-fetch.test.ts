import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { resolveWebFetchConfig } from "../src/config/app.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import {
  extractReadableTextFromHtml,
  runWebFetch,
  validateFetchUrl,
} from "../src/persona/web-fetch.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

test("validateFetchUrl and extractReadableTextFromHtml sanitize HTML cleanly", () => {
  assert.equal(validateFetchUrl("https://example.com/post?a=1").hostname, "example.com");
  assert.throws(() => validateFetchUrl("file:///etc/passwd"), /http/);
  assert.throws(() => validateFetchUrl("http://169.254.169.254/latest/meta-data"), /安全限制/);
  assert.throws(() => validateFetchUrl("http://127.0.0.1:3820/api/config"), /安全限制/);
  assert.throws(() => validateFetchUrl("http://localhost:3820/api/config"), /安全限制/);
  assert.throws(() => validateFetchUrl("http://[::1]:3820/api/config"), /安全限制/);
  assert.throws(() => validateFetchUrl("http://[::ffff:169.254.169.254]/"), /安全限制/);
  assert.throws(() => validateFetchUrl("http://192.168.1.1/admin"), /安全限制/);
  assert.throws(() => validateFetchUrl("http://10.0.0.1/internal"), /安全限制/);

  const html = `
    <!doctype html>
    <html>
      <head>
        <title>Test &amp; Demo Page</title>
        <style>.x { color: red; }</style>
        <script>alert("xss")</script>
      </head>
      <body>
        <h1>Welcome</h1>
        <p>Read <a href="https://example.com/docs">the docs</a> carefully. Invalid entity: &#999999999; &#x110000;</p>
        <ul>
          <li>First item</li>
          <li>Second item</li>
        </ul>
      </body>
    </html>
  `;
  const extracted = extractReadableTextFromHtml(html);
  assert.equal(extracted.title, "Test & Demo Page");
  assert.ok(extracted.text.includes("# Welcome"));
  assert.ok(extracted.text.includes("the docs (https://example.com/docs)"));
  assert.ok(extracted.text.includes("- First item"));
  assert.ok(!extracted.text.includes("alert"));
  assert.ok(!extracted.text.includes("color: red"));
});

test("runWebFetch fetches HTML and JSON via web_access proxy scope and handles errors", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/article") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<html><head><title>News</title></head><body><p>Hello world from Hato!</p></body></html>");
      return;
    }
    if (req.url === "/data.json") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, count: 42 }));
      return;
    }
    if (req.url === "/image.png") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/png");
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (req.url === "/redirect-meta") {
      res.statusCode = 302;
      res.setHeader("Location", "http://169.254.169.254/latest/meta-data");
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end("Not Found");
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const cfg = resolveWebFetchConfig(createDefaultHatoConfig());
    const proxyRouter = new ScopedProxyRouter([]);

    // Default SSRF guard rejects loopback
    const blockedLocal = await runWebFetch({
      config: cfg,
      proxyRouter,
      input: { url: `${baseUrl}/article` },
    });
    assert.equal(blockedLocal.ok, false);
    assert.match(blockedLocal.text, /安全限制/);

    // Redirect to metadata is blocked even with allowPrivateNetworks
    const blockedRedirect = await runWebFetch({
      config: cfg,
      proxyRouter,
      input: { url: `${baseUrl}/redirect-meta` },
      allowPrivateNetworks: true,
    });
    assert.equal(blockedRedirect.ok, false);
    assert.match(blockedRedirect.text, /安全限制/);

    const htmlRes = await runWebFetch({
      config: cfg,
      proxyRouter,
      input: { url: `${baseUrl}/article` },
      allowPrivateNetworks: true,
    });
    assert.equal(htmlRes.ok, true);
    assert.equal(htmlRes.title, "News");
    assert.ok(htmlRes.text.includes("Hello world from Hato!"));

    const jsonRes = await runWebFetch({
      config: cfg,
      proxyRouter,
      input: { url: `${baseUrl}/data.json` },
      allowPrivateNetworks: true,
    });
    assert.equal(jsonRes.ok, true);
    assert.ok(jsonRes.text.includes('"count": 42'));

    const binaryRes = await runWebFetch({
      config: cfg,
      proxyRouter,
      input: { url: `${baseUrl}/image.png` },
      allowPrivateNetworks: true,
    });
    assert.equal(binaryRes.ok, false);
    assert.ok(binaryRes.text.includes("browser_task"));

    const notFoundRes = await runWebFetch({
      config: cfg,
      proxyRouter,
      input: { url: `${baseUrl}/missing` },
      allowPrivateNetworks: true,
    });
    assert.equal(notFoundRes.ok, false);
    assert.ok(notFoundRes.text.includes("HTTP 404"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
