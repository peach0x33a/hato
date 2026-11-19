import assert from "node:assert/strict";
import test from "node:test";
import {
  SlashCommandRegistry,
  buildTelegramBotCommands,
  createDefaultSlashCommandRegistry,
  parseRender2ImgArgs,
  tryExecuteSlashCommand,
} from "../src/commands/slash.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import {
  extractTelegramReplyText,
  resolveReplyMessageText,
} from "../src/gateway/reply-context.js";
import { createPersonaReadOnlyTools } from "../src/persona/tools.js";
import {
  ACTIVATE_TOOLS_NAME,
  buildToolIndexBlock,
  createActivateToolsTool,
  selectToolsForTurn,
} from "../src/persona/tool-disclosure.js";
import { buildMarkdownDocumentHtml } from "../src/render/markdown-image.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

function createMinimalSlashDeps(
  repo: HatoRepository,
  renderCalls?: Array<{ markdown: string; theme: "light" | "dark" }>,
) {
  return {
    repo,
    listModelSlots: () => [],
    listAvailableModels: () => [],
    setModelSlot: () => {
      throw new Error("unused");
    },
    reloadAll: async () => ({ slots: [], proxyCount: 0 }),
    forceCompact: async () => false,
    renderMarkdownImage: async (markdown: string, options?: { theme?: "light" | "dark" }) => {
      const theme = options?.theme ?? "light";
      renderCalls?.push({ markdown, theme });
      return Buffer.from(`PNG:${theme}:${markdown}`);
    },
  };
}

test("SlashCommandRegistry supports custom command registration, aliases, and unregister", async () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    const deps = createMinimalSlashDeps(repo);
    const registry = new SlashCommandRegistry();

    registry.register({
      command: "ping",
      aliases: ["p"],
      description: "Test ping",
      helpLine: "- `/ping`：测试",
      async execute(ctx) {
        return `pong:${ctx.rawArgs.trim()}`;
      },
    });

    registry.register({
      command: "hidden_cmd",
      description: "Hidden from platform panel",
      helpLine: "- `/hidden_cmd`：隐藏面板测试",
      syncToPlatformPanel: false,
      async execute() {
        return "ok";
      },
    });

    const panelCommands = buildTelegramBotCommands({}, registry).map((c) => c.command);
    assert.deepEqual(panelCommands, ["ping"]);
    assert.equal(
      registry.listSpecs().some((s) => s.command === "hidden_cmd" && s.syncToPlatformPanel === false),
      true,
    );

    const res1 = await registry.execute({ canonicalUserId: "owner", text: "/ping hello", deps });
    assert.deepEqual(res1, { text: "pong:hello" });

    const res2 = await registry.execute({ canonicalUserId: "owner", text: "/p world", deps });
    assert.deepEqual(res2, { text: "pong:world" });

    assert.equal(registry.unregister("ping"), true);
    assert.equal(
      await registry.execute({ canonicalUserId: "owner", text: "/ping hello", deps }),
      null,
    );
  } finally {
    handle.close();
  }
});

test("parseRender2ImgArgs parses theme flags while preserving multiline Markdown", () => {
  assert.deepEqual(parseRender2ImgArgs(""), { theme: "light", inlineText: "" });
  assert.deepEqual(parseRender2ImgArgs(" --dark "), { theme: "dark", inlineText: "" });
  assert.deepEqual(parseRender2ImgArgs(" -d\n# Title\n\n- item 1\n- item 2"), {
    theme: "dark",
    inlineText: "# Title\n\n- item 1\n- item 2",
  });
  assert.deepEqual(parseRender2ImgArgs(" --dark --light hello"), {
    theme: "light",
    inlineText: "hello",
  });
  assert.deepEqual(parseRender2ImgArgs(" -l **bold**"), {
    theme: "light",
    inlineText: "**bold**",
  });
});

test("extractTelegramReplyText and resolveReplyMessageText handle platform text and DB fallback", () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "qq",
      platformMsgId: "qq-msg-42",
      role: "assistant",
      content: "# 来自数据库的历史消息",
      createdAt: Date.now(),
    });

    assert.equal(extractTelegramReplyText({ text: "  hello  " }), "hello");
    assert.equal(extractTelegramReplyText({ caption: "  photo caption  " }), "photo caption");
    assert.equal(extractTelegramReplyText({}), undefined);

    // 1. Platform text wins over DB
    assert.deepEqual(
      resolveReplyMessageText({
        channel: "qq",
        replyToPlatformMsgId: "qq-msg-42",
        replyToText: "实时引用文本",
        repo,
      }),
      { text: "实时引用文本", source: "platform" },
    );

    // 2. Falls back to DB when platform text is absent
    assert.deepEqual(
      resolveReplyMessageText({
        channel: "qq",
        replyToPlatformMsgId: "qq-msg-42",
        repo,
      }),
      { text: "# 来自数据库的历史消息", source: "db" },
    );

    // 3. Returns none when neither platform text nor DB record exists
    assert.deepEqual(
      resolveReplyMessageText({
        channel: "tg",
        replyToPlatformMsgId: "missing-id",
        repo,
      }),
      { text: null, source: "none" },
    );
  } finally {
    handle.close();
  }
});

test("/render2img handles usage, inline markdown, reply fallback, theme flags, and missing reply text", async () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "1001",
      role: "assistant",
      content: "DB fallback markdown",
      createdAt: Date.now(),
    });

    const renderCalls: Array<{ markdown: string; theme: "light" | "dark" }> = [];
    const deps = createMinimalSlashDeps(repo, renderCalls);
    const registry = createDefaultSlashCommandRegistry();

    // 1. No args, no reply -> usage
    const usageOut = await tryExecuteSlashCommand(
      { canonicalUserId: "owner", text: "/render2img", deps },
      registry,
    );
    assert.ok(usageOut?.text?.includes("用法："));
    assert.equal(usageOut?.photo, undefined);

    // 2. Flags only, no reply -> usage
    const flagOnlyOut = await tryExecuteSlashCommand(
      { canonicalUserId: "owner", text: "/render2img --dark", deps },
      registry,
    );
    assert.ok(flagOnlyOut?.text?.includes("用法："));

    // 3. Inline text (default light)
    const inlineLight = await tryExecuteSlashCommand(
      { canonicalUserId: "owner", text: "/render2img # Hello\nWorld", deps },
      registry,
    );
    assert.equal(inlineLight?.photo?.buffer.toString(), "PNG:light:# Hello\nWorld");

    // 4. Inline text with -d
    const inlineDark = await tryExecuteSlashCommand(
      { canonicalUserId: "owner", text: "/render2img -d `code`", deps },
      registry,
    );
    assert.equal(inlineDark?.photo?.buffer.toString(), "PNG:dark:`code`");

    // 5. Reply with platform text + --dark
    const replyPlatform = await tryExecuteSlashCommand(
      {
        canonicalUserId: "owner",
        text: "/render2img --dark",
        channel: "tg",
        replyToPlatformMsgId: "999",
        replyToText: "Quoted TG text",
        deps,
      },
      registry,
    );
    assert.equal(replyPlatform?.photo?.buffer.toString(), "PNG:dark:Quoted TG text");

    // 6. Reply without platform text -> DB fallback
    const replyDb = await tryExecuteSlashCommand(
      {
        canonicalUserId: "owner",
        text: "/render2img -l",
        channel: "tg",
        replyToPlatformMsgId: "1001",
        deps,
      },
      registry,
    );
    assert.equal(replyDb?.photo?.buffer.toString(), "PNG:light:DB fallback markdown");

    // 7. Reply to message with no text anywhere -> error
    const replyMissing = await tryExecuteSlashCommand(
      {
        canonicalUserId: "owner",
        text: "/render2img",
        channel: "tg",
        replyToPlatformMsgId: "404",
        deps,
      },
      registry,
    );
    assert.ok(replyMissing?.text?.includes("无法获取被回复消息的文本内容"));
    assert.equal(replyMissing?.photo, undefined);
  } finally {
    handle.close();
  }
});

test("buildMarkdownDocumentHtml renders light and dark themes with GFM", () => {
  const lightHtml = buildMarkdownDocumentHtml("# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |", "light");
  assert.ok(lightHtml.includes('data-theme="light"'));
  assert.ok(lightHtml.includes("<h1>Title</h1>"));
  assert.ok(lightHtml.includes("<table>"));

  const darkHtml = buildMarkdownDocumentHtml("```ts\nconst x = 1;\n```", "dark");
  assert.ok(darkHtml.includes('data-theme="dark"'));
  assert.ok(darkHtml.includes("language-ts"));
});

test("createPersonaReadOnlyTools exposes render_markdown_image for bot invocation", async () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    const config = createDefaultHatoConfig();
    let calledWith: { markdown: string; theme?: "light" | "dark"; caption?: string } | null = null;

    const tools = createPersonaReadOnlyTools({
      repo,
      canonicalUserId: "owner",
      getTimezone: () => config.owner.timezone,
      getHatoConfig: () => config,
      proxyRouter: new ScopedProxyRouter([]),
      onRenderMarkdownImage: async (input) => {
        calledWith = input;
        return { ok: true, message: "ok", bytes: 123 };
      },
    });

    const tool = tools.find((t) => t.name === "render_markdown_image");
    assert.ok(tool, "render_markdown_image tool should be registered");
    const result = await tool.execute("call_1", {
      markdown: "# Bot Card",
      theme: "dark",
      caption: "card",
    });
    assert.deepEqual(calledWith, {
      markdown: "# Bot Card",
      theme: "dark",
      caption: "card",
    });
    assert.deepEqual(result.details, { ok: true, bytes: 123 });
  } finally {
    handle.close();
  }
});

test("on-demand tool disclosure selects relevant tools, builds index, and activates dynamically", async () => {
  const handle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(handle.db);
    const config = createDefaultHatoConfig();
    let allTools: any[] = [];
    let activeTools: any[] = [];

    const activateTool = createActivateToolsTool({
      getAllTools: () => allTools,
      getActiveTools: () => activeTools,
      setActiveTools: (next) => {
        activeTools = next;
      },
    });

    allTools = createPersonaReadOnlyTools({
      repo,
      canonicalUserId: "owner",
      getTimezone: () => config.owner.timezone,
      getHatoConfig: () => config,
      proxyRouter: new ScopedProxyRouter([]),
      extraTools: [activateTool],
      onRenderMarkdownImage: async () => ({ ok: true, message: "ok" }),
    });

    const indexText = buildToolIndexBlock(allTools);
    assert.ok(indexText.includes("<available_tools>"));
    assert.ok(indexText.includes("render_markdown_image"));
    assert.equal(indexText.includes(`- ${ACTIVATE_TOOLS_NAME}:`), false);

    // Casual chat only discloses activate_tools
    const casual = selectToolsForTurn({ allTools, userText: "早安呀" });
    assert.deepEqual(
      casual.map((t) => t.name),
      [ACTIVATE_TOOLS_NAME],
    );

    // Render request discloses render_markdown_image + activate_tools
    const renderTurn = selectToolsForTurn({ allTools, userText: "帮我把这段渲染成图片" });
    assert.ok(renderTurn.some((t) => t.name === "render_markdown_image"));
    assert.equal(renderTurn.some((t) => t.name === "calc"), false);

    // Meta-tool dynamically activates calc into activeTools
    activeTools = casual;
    const actRes = await activateTool.execute("call_act", { tools: ["calc", "unknown_tool"] });
    assert.deepEqual(actRes.details, {
      activated: ["calc"],
      alreadyActive: [],
      notFound: ["unknown_tool"],
    });
    assert.ok(activeTools.some((t) => t.name === "calc"));
  } finally {
    handle.close();
  }
});
