import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorLock } from "../src/bus/actor-bus.js";
import { createDefaultSlashCommandRegistry } from "../src/commands/slash.js";
import { resolveWebToolLimitsConfig, type HatoConfig } from "../src/config/app.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { MessageDebouncer } from "../src/gateway/debouncer.js";
import { generateOpenAiImage } from "../src/media/image-gen.js";
import { CompactionManager } from "../src/memory/compaction.js";
import { shouldAllowSilentNoReply } from "../src/persona/agent.js";
import { splitIntoBubbles } from "../src/persona/bubbles.js";
import { rawRecordToAgentMessage } from "../src/persona/context.js";
import { ImageGenJobRunner } from "../src/persona/image-gen-runner.js";
import { selectToolsForTurn } from "../src/persona/tool-disclosure.js";
import { createPersonaReadOnlyTools } from "../src/persona/tools.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";

function createTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hato-imp-"));
  const handle = openDatabase(join(dir, "hato.db"));
  const repo = new HatoRepository(handle.db);
  return {
    dir,
    repo,
    cleanup: () => {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeTestConfig(dir: string): HatoConfig {
  const cfg = createDefaultHatoConfig();
  cfg.paths.sqlite = join(dir, "hato.db");
  cfg.paths.workspaces_dir = join(dir, "workspaces");
  cfg.paths.prompts_dir = join(dir, "prompts");
  cfg.paths.skills_dir = join(dir, "skills");
  return cfg;
}

test("/stop and /cancel slash commands delegate to stopTickets", async () => {
  const { dir, repo, cleanup } = createTestRepo();
  try {
    const registry = createDefaultSlashCommandRegistry();
    const calls: Array<{ uid: string; ticketId?: string }> = [];
    const deps: any = {
      repo,
      listModelSlots: () => [],
      listAvailableModels: () => [],
      setModelSlot: () => ({ slot: "persona", target: "x/y", api: "openai", baseUrl: "" }),
      reloadAll: async () => ({ slots: [], proxyCount: 0 }),
      forceCompact: async () => false,
      stopTickets: async (uid: string, ticketId?: string) => {
        calls.push({ uid, ticketId });
        if (ticketId) {
          return { stopped: [{ id: ticketId, briefTitle: "测试任务" }], message: `已中止工单 ${ticketId}` };
        }
        return {
          stopped: [
            { id: "t_1111", briefTitle: "任务一" },
            { id: "t_2222", briefTitle: "任务二" },
          ],
          message: "ok",
        };
      },
    };

    const allRes = await registry.execute({ canonicalUserId: "owner", text: "/stop", deps });
    expect(allRes?.text).toContain("已停止 2 个后台任务");
    expect(allRes?.text).toContain("t_1111");

    const oneRes = await registry.execute({ canonicalUserId: "owner", text: "/cancel t_9999", deps });
    expect(oneRes?.text).toBe("已中止工单 t_9999");
    expect(calls).toEqual([{ uid: "owner", ticketId: undefined }, { uid: "owner", ticketId: "t_9999" }]);
  } finally {
    cleanup();
  }
});

test("cancel_ticket tool is always unlocked and calls onCancelTicket", async () => {
  const { dir, repo, cleanup } = createTestRepo();
  try {
    const cfg = makeTestConfig(dir);
    let cancelledId: string | undefined;
    const tools = createPersonaReadOnlyTools({
      repo,
      canonicalUserId: "owner",
      getTimezone: () => "Asia/Shanghai",
      getHatoConfig: () => cfg,
      proxyRouter: new ScopedProxyRouter([]),
      onCancelTicket: async ({ ticketId }) => {
        cancelledId = ticketId;
        return { stopped: [{ id: "t_abc", briefTitle: "查磁盘" }], message: "已中止工单 t_abc" };
      },
    });

    const selected = selectToolsForTurn({ allTools: tools, userText: "停停停" });
    const cancelTool = selected.find((t) => t.name === "cancel_ticket");
    expect(cancelTool).toBeDefined();

    const out = await cancelTool!.execute("call_1", { ticket_id: "t_abc" }, undefined, undefined);
    expect(cancelledId).toBe("t_abc");
    expect((out.content[0] as any).text).toBe("已中止工单 t_abc");
  } finally {
    cleanup();
  }
});

test("ImageGenJobRunner.abortTicket marks ticket cancelled and aborts active controller", async () => {
  const { dir, repo, cleanup } = createTestRepo();
  try {
    const cfg = makeTestConfig(dir);
    const runner = new ImageGenJobRunner({
      getHatoConfig: () => cfg,
      repo,
      bus: { emit: async () => {} } as any,
      getModelRegistry: () => ({ listProviders: () => [] }) as any,
      proxyRouter: new ScopedProxyRouter([]),
    });

    repo.createTicket({
      id: "t_img1",
      canonicalUserId: "owner",
      status: "running",
      backend: "builtin-pi",
      briefTitle: "绘制图片: test",
      originChannel: "qq",
    });

    const msg = await runner.abortTicket("t_img1");
    expect(msg).toBe("已中止生图工单 t_img1");
    expect(repo.getTicket("t_img1")?.status).toBe("cancelled");
  } finally {
    cleanup();
  }
});

test("shouldAllowSilentNoReply blocks [NO_REPLY] on questions and status checks", () => {
  expect(shouldAllowSilentNoReply("好")).toBe(true);
  expect(shouldAllowSilentNoReply("嗯嗯")).toBe(true);
  expect(shouldAllowSilentNoReply("😡什么进度了")).toBe(false);
  expect(shouldAllowSilentNoReply("好了没")).toBe(false);
  expect(shouldAllowSilentNoReply("真的够用吗")).toBe(false);
  expect(shouldAllowSilentNoReply("hello?")).toBe(false);
  expect(shouldAllowSilentNoReply("这是一段比较长的用户消息，明确需要回复")).toBe(false);
});

test("resolveWebToolLimitsConfig resolves defaults and overrides", () => {
  const { dir, cleanup } = createTestRepo();
  try {
    const cfg = makeTestConfig(dir);
    expect(resolveWebToolLimitsConfig(cfg)).toEqual({
      maxToolCallsPerTurn: 6,
      maxConsecutiveFailures: 2,
    });
    cfg.web = { ...cfg.web, max_tool_calls_per_turn: 4, max_consecutive_failures: 3 };
    expect(resolveWebToolLimitsConfig(cfg)).toEqual({
      maxToolCallsPerTurn: 4,
      maxConsecutiveFailures: 3,
    });
  } finally {
    cleanup();
  }
});

test("splitIntoBubbles supports spaced [ SPLIT ] delimiter variants", () => {
  const text = "第一句\n\n[ SPLIT ]\n\n第二句\n[SPLIT ]\n第三句";
  const bubbles = splitIntoBubbles(text, {
    enabled: true,
    maxPerTurn: 5,
    delimiter: "[SPLIT]",
  });
  expect(bubbles).toEqual(["第一句", "第二句", "第三句"]);
});

test("generateOpenAiImage returns clear error on HTTP 400 Duplicate parameter image", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hato-img-err-"));
  try {
    const ref1 = join(dir, "a.png");
    const ref2 = join(dir, "b.png");
    writeFileSync(ref1, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    writeFileSync(ref2, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const mockRouter = {
      runWithScope: async <T>(_scope: string, fn: () => Promise<T>) => fn(),
      scopedFetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Duplicate parameter: 'image'. You provided multiple values for this parameter",
            },
          }),
          { status: 400 },
        ),
    } as unknown as ScopedProxyRouter;

    const res = await generateOpenAiImage({
      prompt: "two chars",
      model: "gpt-image-2.5-sunburst",
      referenceImagePaths: [ref1, ref2],
      workspaceDir: dir,
      providerSlug: "claudeflare",
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      proxyRouter: mockRouter,
      maxRetries: 0,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("only supports a single reference image");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CompactionManager idle mode clears hotzone silently without summarizeBlock", async () => {
  const { dir, repo, cleanup } = createTestRepo();
  try {
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "qq",
      role: "user",
      content: "测试静默清空",
      createdAt: Date.now() - 10_000,
    });

    let summarizeCalls = 0;
    let clearCalls = 0;
    const manager = new CompactionManager(
      {
        hotMessagesHighWatermark: 60,
        hotMessagesKeepAfterCompact: 10,
        minMessagesToCompact: 10,
        preCompactAfterMinutes: 25,
        idleCommitAfterMinutes: 30,
        clearMode: "idle",
      },
      repo,
      new ActorLock(),
      {
        summarizeBlock: async () => {
          summarizeCalls += 1;
          return "should not be called";
        },
        clearHotZoneAndArchive: async (uid) => {
          clearCalls += 1;
          const res = repo.resetWorkingContext(uid);
          return res.clearedHotMessages > 0 || res.hadSummary;
        },
      },
    );

    const cleared = await manager.runSilentIdleClear("owner");
    expect(cleared).toBe(true);
    expect(clearCalls).toBe(1);
    expect(summarizeCalls).toBe(0);
    expect(repo.getHotMessages("owner", repo.getWorkingMemory("owner").compactedUntilTs)).toHaveLength(0);
    manager.dispose();
  } finally {
    cleanup();
  }
});

test("updateLatestAssistantPlatformMsgId + findMessageByPlatformId resolve multi-bubble replies after hotzone clear", () => {
  const { dir, repo, cleanup } = createTestRepo();
  try {
    const t0 = Date.now() - 60_000;
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "qq",
      role: "assistant",
      content: "第一段话\n\n[SPLIT]\n\n第二段话",
      createdAt: t0,
    });
    repo.updateLatestAssistantPlatformMsgId("owner", "qq", ["qq_msg_1", "qq_msg_2"]);

    // Clear hotzone
    repo.resetWorkingContext("owner");
    expect(repo.getHotMessages("owner", repo.getWorkingMemory("owner").compactedUntilTs)).toHaveLength(0);

    // Replying to the 2nd bubble still resolves the full prior assistant message
    const found = repo.findMessageByPlatformId("qq", "qq_msg_2");
    expect(found).not.toBeNull();
    expect(found!.content).toContain("第二段话");

    const replyRow = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "qq",
      platformMsgId: "qq_user_99",
      replyToId: "qq_msg_2",
      role: "user",
      content: "再说说第二段",
      createdAt: Date.now(),
    });
    const agentMsg = rawRecordToAgentMessage(replyRow, repo);
    expect(agentMsg.role).toBe("hato_user_batch");
    if (agentMsg.role === "hato_user_batch") {
      expect(agentMsg.text).toContain('[Reply to your message:');
      expect(agentMsg.text).toContain("第二段话");
    }
  } finally {
    cleanup();
  }
});

test("MessageDebouncer preserves replyToText alongside replyToPlatformMsgId", async () => {
  let flushed: any = null;
  const debouncer = new MessageDebouncer(5, (batch) => {
    flushed = batch;
  });
  debouncer.enqueue({
    channel: "tg",
    platformUserId: "1001",
    platformMsgId: "m1",
    canonicalUserId: "owner",
    replyToPlatformMsgId: "tg_old_1",
    replyToText: "早报：昨日流量 12G",
    text: "这是啥",
    attachments: [],
    timestampMs: 1000,
  });
  debouncer.enqueue({
    channel: "tg",
    platformUserId: "1001",
    platformMsgId: "m2",
    canonicalUserId: "owner",
    text: "够用吗",
    attachments: [],
    timestampMs: 2000,
  });

  await new Promise((r) => setTimeout(r, 30));
  expect(flushed).not.toBeNull();
  expect(flushed.replyToPlatformMsgId).toBe("tg_old_1");
  expect(flushed.replyToText).toBe("早报：昨日流量 12G");
  expect(flushed.combinedText).toBe("这是啥\n够用吗");
  debouncer.dispose();
});

test("CompactionManager idle mode hydrates and clears expired hotzone on startup", async () => {
  const { dir, repo, cleanup } = createTestRepo();
  try {
    repo.getWorkingMemory("owner");
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "qq",
      role: "user",
      content: "旧会话残留消息",
      createdAt: Date.now() - 40 * 60_000,
    });

    let clearCalls = 0;
    const manager = new CompactionManager(
      {
        hotMessagesHighWatermark: 60,
        hotMessagesKeepAfterCompact: 10,
        minMessagesToCompact: 10,
        preCompactAfterMinutes: 25,
        idleCommitAfterMinutes: 30,
        clearMode: "idle",
      },
      repo,
      new ActorLock(),
      {
        summarizeBlock: async () => "",
        clearHotZoneAndArchive: async (uid) => {
          clearCalls += 1;
          const res = repo.resetWorkingContext(uid);
          return res.clearedHotMessages > 0 || res.hadSummary;
        },
        listActiveUserIds: () => repo.listWorkingMemoryUserIds(),
      },
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(clearCalls).toBe(1);
    expect(repo.getHotMessages("owner", repo.getWorkingMemory("owner").compactedUntilTs)).toHaveLength(0);
    manager.dispose();
  } finally {
    cleanup();
  }
});

test("rawRecordToAgentMessage preserves attachment path when quoting a pure-image past message", () => {
  const { dir, repo, cleanup } = createTestRepo();
  try {
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "qq",
      platformMsgId: "qq_img_1",
      role: "user",
      content: "",
      attachments: [
        {
          kind: "image",
          filename: "ref.png",
          mimeType: "image/png",
          localPath: "/tmp/hato/ref.png",
        },
      ],
      createdAt: Date.now() - 60_000,
    });

    const replyRow = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "qq",
      platformMsgId: "qq_reply_2",
      replyToId: "qq_img_1",
      role: "user",
      content: "按这张图画",
      createdAt: Date.now(),
    });

    const agentMsg = rawRecordToAgentMessage(replyRow, repo);
    expect(agentMsg.role).toBe("hato_user_batch");
    if (agentMsg.role === "hato_user_batch") {
      expect(agentMsg.text).toContain("[Reply to user: [Attachment image: ref.png (path: /tmp/hato/ref.png)]]");
    }
  } finally {
    cleanup();
  }
});
