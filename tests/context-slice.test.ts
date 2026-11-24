import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { expandEarlierContext, readTaskContext } from "../src/dispatch/context-slice.js";
import { createScopedContextMcpServer } from "../src/mcp/context-server.js";

test("context-slice pulls verbatim interval with reply_to penetration and enforces lookback limits", () => {
  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    repo.ensureOwner({
      canonicalUserId: "owner",
      timezone: "Asia/Shanghai",
      proactiveChannel: "tg",
    });

    const m1 = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "tg_1",
      role: "user",
      content: "旧配置端口是 9090",
      createdAt: 1_000,
    });
    const m2 = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "tg_2",
      role: "assistant",
      content: "好的我记下啦",
      createdAt: 2_000,
    });
    const m3 = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "tg_3",
      replyToId: "tg_1",
      role: "user",
      content: "按我之前引用那条的端口写个健康检查脚本",
      attachments: [{ kind: "file", filename: "hosts.txt", localPath: "/tmp/hosts.txt" }],
      createdAt: 3_000,
    });
    const m4 = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "tg_4",
      role: "assistant",
      content: "没问题呀，我这就去安排~",
      createdAt: 4_000,
    });

    repo.createTicket({
      id: "t_ctx1",
      canonicalUserId: "owner",
      status: "running",
      backend: "codex-cli",
      briefTitle: "健康检查脚本",
      originChannel: "tg",
      contextId: "ctx_t_ctx1",
      contextFromMsgId: m3.id,
      contextToMsgId: m4.id,
    });

    const slice = readTaskContext({
      repo,
      contextId: "ctx_t_ctx1",
      timezone: "Asia/Shanghai",
      lookback: { maxStepCount: 1, maxTotalMessages: 2, maxHours: 24 },
    });

    assert.equal(slice.messages.length, 2);
    assert.equal(slice.messages[0]?.speaker, "USER");
    assert.equal(slice.messages[1]?.speaker, "CHAT_RELAY");
    // reply_to penetration pulled m1 from outside [m3..m4]
    assert.equal(slice.messages[0]?.replyTo?.msgId, m1.id);
    assert.match(slice.messages[0]?.replyTo?.content ?? "", /9090/);
    assert.match(slice.formattedText, /路径=\/tmp\/hosts\.txt/);

    const expanded = expandEarlierContext({
      repo,
      contextId: "ctx_t_ctx1",
      count: 5, // capped to maxStepCount=1
      alreadyLookedBack: 0,
      lookback: { maxStepCount: 1, maxTotalMessages: 2, maxHours: 24 },
    });
    assert.equal(expanded.messages.length, 1);
    assert.equal(expanded.messages[0]?.msgId, m2.id);
  } finally {
    dbHandle.close();
  }
});

test("createScopedContextMcpServer locks access strictly to allowedContextId", async () => {
  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    repo.ensureOwner({
      canonicalUserId: "owner",
      timezone: "UTC",
      proactiveChannel: "tg",
    });
    const msg = repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "user",
      content: "写一个统计磁盘空间的 bash 脚本",
      createdAt: 10_000,
    });
    repo.createTicket({
      id: "t_mcp_1",
      canonicalUserId: "owner",
      status: "running",
      backend: "codex-cli",
      briefTitle: "磁盘统计",
      originChannel: "tg",
      contextId: "ctx_t_mcp_1",
      contextFromMsgId: msg.id,
      contextToMsgId: msg.id,
    });

    const server = createScopedContextMcpServer({
      repo,
      allowedContextId: "ctx_t_mcp_1",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listRes = await client.listTools();
    assert.deepEqual(
      listRes.tools.map((t) => t.name),
      ["read_task_context", "expand_earlier_context"],
    );

    const denied = await client.callTool({
      name: "read_task_context",
      arguments: { context_id: "ctx_other" },
    });
    assert.equal(denied.isError, true);

    const okRes = await client.callTool({
      name: "read_task_context",
      arguments: { context_id: "ctx_t_mcp_1" },
    });
    assert.notEqual(okRes.isError, true);
    assert.match((okRes.content as Array<{ text: string }>)[0]!.text, /统计磁盘空间/);

    await client.close();
    await server.close();
  } finally {
    dbHandle.close();
  }
});

test("createScopedContextMcpServer supports read_task_context and progressive expand_earlier_context on readonly DB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hato-ctx-ro-"));
  const dbPath = join(dir, "hato.db");
  try {
    const rwHandle = openDatabase(dbPath);
    const rwRepo = new HatoRepository(rwHandle.db);
    rwRepo.ensureOwner({
      canonicalUserId: "owner",
      timezone: "UTC",
      proactiveChannel: "tg",
    });
    const baseTs = 1_700_000_000_000;
    const m1 = rwRepo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "m1",
      role: "user",
      content: "first-msg",
      createdAt: baseTs,
    });
    const m2 = rwRepo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "m2",
      role: "user",
      content: "second-msg",
      createdAt: baseTs + 1000,
    });
    const m3 = rwRepo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "m3",
      role: "user",
      content: "third-msg",
      createdAt: baseTs + 2000,
    });
    const m4 = rwRepo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      platformMsgId: "m4",
      role: "user",
      content: "fourth-msg",
      createdAt: baseTs + 3000,
    });
    rwRepo.createTicket({
      id: "t_ro_1",
      canonicalUserId: "owner",
      status: "running",
      backend: "builtin-pi",
      briefTitle: "readonly test",
      originChannel: "tg",
      contextId: "ctx_ro_1",
      contextFromMsgId: m4.id,
      contextToMsgId: m4.id,
    });
    rwHandle.close();

    const roHandle = openDatabase(dbPath, { readonly: true });
    try {
      const roRepo = new HatoRepository(roHandle.db);
      const server = createScopedContextMcpServer({
        repo: roRepo,
        allowedContextId: "ctx_ro_1",
      });
      const client = new Client({ name: "test-ro-client", version: "1.0.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const readRes = await client.callTool({
        name: "read_task_context",
        arguments: { context_id: "ctx_ro_1" },
      });
      assert.notEqual(readRes.isError, true);
      assert.match((readRes.content as Array<{ text: string }>)[0]!.text, /fourth-msg/);

      const exp1 = await client.callTool({
        name: "expand_earlier_context",
        arguments: { context_id: "ctx_ro_1", count: 1 },
      });
      assert.notEqual(exp1.isError, true);
      const exp1Text = (exp1.content as Array<{ text: string }>)[0]!.text;
      assert.match(exp1Text, /third-msg/);
      assert.doesNotMatch(exp1Text, /second-msg/);

      const exp2 = await client.callTool({
        name: "expand_earlier_context",
        arguments: { context_id: "ctx_ro_1", count: 1 },
      });
      assert.notEqual(exp2.isError, true);
      const exp2Text = (exp2.content as Array<{ text: string }>)[0]!.text;
      assert.match(exp2Text, /second-msg/);
      assert.doesNotMatch(exp2Text, /third-msg/);

      await client.close();
      await server.close();
    } finally {
      roHandle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
