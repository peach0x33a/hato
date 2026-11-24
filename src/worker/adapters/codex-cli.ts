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
        return {
          sessionId: obj.thread_id,
          progressNote: "已建立 Codex CLI 会话",
          activities: [
            {
              kind: "lifecycle",
              state: "done",
              title: "已建立 Codex CLI 会话",
            },
          ],
        };
      }

      if (type === "turn.failed") {
        const errObj = obj.error as { message?: string } | undefined;
        const errMsg = errObj?.message || "Codex CLI turn failed";
        return {
          error: errMsg,
          activities: [{ kind: "error", state: "error", title: "执行失败", text: errMsg }],
        };
      }

      if (type === "error" && typeof obj.message === "string") {
        return {
          error: obj.message,
          activities: [{ kind: "error", state: "error", title: "CLI 错误", text: obj.message }],
        };
      }

      if (
        (type === "item.started" || type === "item.updated" || type === "item.completed") &&
        obj.item &&
        typeof obj.item === "object"
      ) {
        const item = obj.item as Record<string, unknown>;
        const itemType = typeof item.type === "string" ? item.type : "";
        const stepKey = typeof item.id === "string" ? `codex_${item.id}` : undefined;
        const isDone = type === "item.completed";

        if (itemType === "command_execution") {
          const fullCmd = typeof item.command === "string" ? item.command : "";
          const shortCmd = fullCmd ? fullCmd.slice(0, 72) : "命令";
          const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
          const output =
            typeof item.aggregated_output === "string"
              ? item.aggregated_output
              : typeof item.output === "string"
                ? item.output
                : [
                    typeof item.stdout === "string" ? item.stdout : "",
                    typeof item.stderr === "string" && item.stderr
                      ? `[stderr]\n${item.stderr}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join("\n") || undefined;

          return {
            progressNote:
              type === "item.started"
                ? `正在执行: ${shortCmd}`
                : isDone
                  ? `命令已完成: ${shortCmd}`
                  : undefined,
            activities: [
              {
                stepKey,
                kind: "command",
                state: isDone ? (exitCode && exitCode !== 0 ? "error" : "done") : "running",
                title: "执行命令",
                ...(fullCmd ? { command: fullCmd } : {}),
                ...(output !== undefined ? { output } : {}),
                ...(exitCode !== undefined ? { exitCode } : {}),
              },
            ],
          };
        }
        if (itemType === "file_change") {
          const changes = Array.isArray(item.changes)
            ? item.changes
                .map((c) => {
                  if (!c || typeof c !== "object") return "";
                  const rec = c as Record<string, unknown>;
                  const kind = typeof rec.kind === "string" ? rec.kind : "edit";
                  const path = typeof rec.path === "string" ? rec.path : "";
                  return path ? `${kind}: ${path}` : "";
                })
                .filter(Boolean)
                .join("\n")
            : undefined;
          return {
            progressNote: "正在修改工作区文件",
            activities: [
              {
                stepKey,
                kind: "tool",
                state: isDone ? "done" : "running",
                title: "修改工作区文件",
                ...(changes ? { output: changes } : {}),
              },
            ],
          };
        }
        if (itemType === "mcp_tool_call") {
          const server = typeof item.server === "string" ? item.server : "";
          const tool = typeof item.tool === "string" ? item.tool : "MCP 工具";
          const label = server ? `${server}.${tool}` : tool;
          return {
            progressNote: `正在调用 ${label}`,
            activities: [
              {
                stepKey,
                kind: "tool",
                state: isDone ? "done" : "running",
                title: `调用 MCP · ${label}`,
              },
            ],
          };
        }
        if (itemType === "agent_message" && typeof item.text === "string") {
          return {
            ...(isDone ? { finalText: item.text } : {}),
            activities: [
              {
                stepKey,
                kind: "assistant",
                state: isDone ? "done" : "running",
                title: "Worker 进展",
                text: item.text,
              },
            ],
          };
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
