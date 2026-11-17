import type { ExternalCliAdapter, ExternalCliStreamEvent } from "./types.js";

export const codexCliAdapter: ExternalCliAdapter = {
  backend: "codex-cli",

  buildStartArgs({ prompt, workspaceDir, overlay, schemaPath }) {
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", workspaceDir];
    args.push(...overlay.modeArgs, ...overlay.extraArgs);
    if (schemaPath) {
      args.push("--output-schema", schemaPath);
    }
    args.push(prompt);
    return args;
  },

  buildResumeArgs({ sessionId, reply, overlay, schemaPath }) {
    const args = ["exec", "resume", "--json", "--skip-git-repo-check"];
    args.push(...overlay.modeArgs, ...overlay.extraArgs);
    if (schemaPath) {
      args.push("--output-schema", schemaPath);
    }
    args.push(sessionId, reply);
    return args;
  },

  parseStreamLine(line: string): ExternalCliStreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "";

      if (type === "thread.started" && typeof obj.thread_id === "string") {
        return { sessionId: obj.thread_id, progressNote: "已建立 Codex CLI 会话" };
      }

      if (type === "turn.failed") {
        const errObj = obj.error as { message?: string } | undefined;
        return { error: errObj?.message || "Codex CLI turn failed" };
      }

      if (type === "error" && typeof obj.message === "string") {
        return { error: obj.message };
      }

      if ((type === "item.started" || type === "item.completed") && obj.item && typeof obj.item === "object") {
        const item = obj.item as Record<string, unknown>;
        const itemType = typeof item.type === "string" ? item.type : "";

        if (itemType === "command_execution") {
          const cmd = typeof item.command === "string" ? item.command.slice(0, 72) : "命令";
          return {
            progressNote: type === "item.started" ? `正在执行: ${cmd}` : `命令已完成: ${cmd}`,
          };
        }
        if (itemType === "file_change") {
          return { progressNote: "正在修改工作区文件" };
        }
        if (itemType === "mcp_tool_call") {
          const tool = typeof item.tool === "string" ? item.tool : "MCP 工具";
          return { progressNote: `正在调用 ${tool}` };
        }
        if (itemType === "agent_message" && typeof item.text === "string" && type === "item.completed") {
          return { finalText: item.text };
        }
      }

      if (type === "turn.completed") {
        return { done: true };
      }

      return null;
    } catch {
      return null;
    }
  },
};
