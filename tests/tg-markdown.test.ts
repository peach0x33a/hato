import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markdownToTelegramHtml } from "../src/gateway/tg-markdown.js";

describe("markdownToTelegramHtml", () => {
  it("converts bold, inline code, links, and headings into Telegram HTML", () => {
    const input = [
      "# 状态报告",
      "",
      "**错误输出 (stderr)**",
      "现在使用的是 `claudeflare/deepseek-flash`，详情见 [文档](https://example.com/docs?a=1&b=2)。",
    ].join("\n");

    const html = markdownToTelegramHtml(input);
    assert.match(html, /<b>状态报告<\/b>/);
    assert.match(html, /<b>错误输出 \(stderr\)<\/b>/);
    assert.match(html, /<code>claudeflare\/deepseek-flash<\/code>/);
    assert.match(html, /<a href="https:\/\/example\.com\/docs\?a=1&amp;b=2">文档<\/a>/);
  });

  it("preserves snake_case identifiers and escapes raw HTML inside code blocks", () => {
    const input = [
      "文件 `third_party_cli_delegation_proof.txt` 和 codex_models_manager::manager 正常。",
      "",
      "```ts",
      "const x = a < b && c > d;",
      "```",
    ].join("\n");

    const html = markdownToTelegramHtml(input);
    assert.ok(html.includes("<code>third_party_cli_delegation_proof.txt</code>"));
    assert.ok(html.includes("codex_models_manager::manager"));
    assert.ok(!html.includes("<i>models</i>"));
    assert.ok(
      html.includes('<pre><code class="language-ts">const x = a &lt; b &amp;&amp; c &gt; d;</code></pre>'),
    );
  });
});
