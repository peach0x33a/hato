import { Readable, Writable } from "node:stream";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  agent,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const scenario = process.env.FAKE_ACP_SCENARIO ?? "normal";
const supportsLoadSession = process.env.FAKE_ACP_LOAD_SESSION !== "false";

let activeSessionId = "acp-sess-1";
let turnCount = 0;
let cancelled = false;
let recordedMcpNames: string[] = [];

const writable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const readable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(writable, readable);

const app = agent({ name: "fake-acp-agent" })
  .onRequest(AGENT_METHODS.initialize, async () => {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: supportsLoadSession,
        mcpCapabilities: { http: true, sse: false },
      },
      agentInfo: {
        name: "fake-acp-agent",
        version: "1.0.0",
      },
    };
  })
  .onRequest(AGENT_METHODS.session_new, async (ctx) => {
    activeSessionId = `acp-sess-${process.pid}`;
    recordedMcpNames = Array.isArray(ctx.params.mcpServers)
      ? ctx.params.mcpServers.map((s) => s.name)
      : [];
    return {
      sessionId: activeSessionId,
      modes: {
        currentModeId: "auto",
        availableModes: [
          { id: "auto", name: "Auto" },
          { id: "plan", name: "Plan" },
        ],
      },
      configOptions: [],
    };
  })
  .onRequest(AGENT_METHODS.session_load, async (ctx) => {
    activeSessionId = ctx.params.sessionId;
    recordedMcpNames = Array.isArray(ctx.params.mcpServers)
      ? ctx.params.mcpServers.map((s) => s.name)
      : [];
    return {
      modes: {
        currentModeId: "auto",
        availableModes: [{ id: "auto", name: "Auto" }],
      },
      configOptions: [],
    };
  })
  .onRequest(AGENT_METHODS.session_set_mode, async () => ({}))
  .onRequest(AGENT_METHODS.session_set_config_option, async () => ({ configOptions: [] }))
  .onNotification(AGENT_METHODS.session_cancel, async () => {
    cancelled = true;
  })
  .onRequest(AGENT_METHODS.session_prompt, async (ctx) => {
    turnCount += 1;
    const sessionId = ctx.params.sessionId;
    const promptText = ctx.params.prompt
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");

    if (scenario === "cancel_on_abort") {
      for (let i = 0; i < 100; i += 1) {
        if (cancelled) {
          return { stopReason: "cancelled" };
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      return { stopReason: "end_turn" };
    }

    if (scenario === "mcp_echo") {
      await ctx.client.notify(CLIENT_METHODS.session_update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `MCP_SERVERS:${JSON.stringify(recordedMcpNames)}`,
          },
        },
      });
      return { stopReason: "end_turn" };
    }

    if (scenario === "permission_confirm") {
      const permRes = await ctx.client.request(CLIENT_METHODS.session_request_permission, {
        sessionId,
        toolCall: {
          toolCallId: "tc-rm",
          title: "删除生产表数据 DROP TABLE",
          kind: "execute",
          rawInput: { command: "rm -rf /tmp/prod_db" },
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      if (
        permRes.outcome.outcome === "cancelled" ||
        (permRes.outcome.outcome === "selected" && permRes.outcome.optionId === "reject-once")
      ) {
        return { stopReason: "end_turn" };
      }
    }

    if (scenario === "permission_allow") {
      await ctx.client.request(CLIENT_METHODS.session_request_permission, {
        sessionId,
        toolCall: {
          toolCallId: "tc-read",
          title: "读取配置文件",
          kind: "read",
          rawInput: { path: "package.json" },
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
    }

    if (scenario === "needs_input_then_resume" && turnCount === 1 && !promptText.includes("CONFIRMED_REPLY")) {
      await ctx.client.notify(CLIENT_METHODS.session_update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "请问需要发布到哪个环境？",
          },
        },
      });
      return { stopReason: "end_turn" };
    }

    // Normal / resumed completion flow
    await ctx.client.notify(CLIENT_METHODS.session_update, {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "思考中..." },
      },
    });
    await ctx.client.notify(CLIENT_METHODS.session_update, {
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "检查目录", priority: "high", status: "completed" },
          { content: "执行构建", priority: "medium", status: "in_progress" },
        ],
      },
    });
    await ctx.client.notify(CLIENT_METHODS.session_update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-exec-1",
        title: "运行测试",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "echo hello-acp" },
      },
    });
    await ctx.client.notify(CLIENT_METHODS.session_update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-exec-1",
        status: "completed",
        rawOutput: { stdout: "hello-acp\n" },
      },
    });
    await ctx.client.notify(CLIENT_METHODS.session_update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-final",
        content: {
          type: "text",
          text: `ACP_DONE pid=${process.pid} turn=${turnCount} reply=${promptText.trim().slice(0, 60)}`,
        },
      },
    });

    return { stopReason: "end_turn" };
  });

const conn = app.connect(stream);
await conn.closed;
