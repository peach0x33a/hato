import type { ExternalCliAdapter, ExternalCliStreamEvent } from "./types.js";

export const claudeCodeCliAdapter: ExternalCliAdapter = {
  backend: "claude-code",

  buildStartArgs({ prompt, overlay, schemaPath }) {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
    args.push(...overlay.modeArgs, ...overlay.extraArgs);
    if (schemaPath) {
      args.push("--json-schema", schemaPath);
    }
    return args;
  },

  buildResumeArgs({ sessionId, reply, overlay, schemaPath }) {
    const args = [
      "-p",
      reply,
      "--resume",
      sessionId,
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    args.push(...overlay.modeArgs, ...overlay.extraArgs);
    if (schemaPath) {
      args.push("--json-schema", schemaPath);
    }
    return args;
  },

  parseStreamLine(line: string): ExternalCliStreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "";
      const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;

      if (type === "system" && obj.subtype === "init") {
        return {
          sessionId,
          progressNote: "已初始化 Claude Code 会话",
          activities: [
            {
              kind: "lifecycle",
              state: "done",
              title: "已初始化 Claude Code 会话",
            },
          ],
        };
      }

      if (type === "assistant" && obj.message && typeof obj.message === "object") {
        const msg = obj.message as {
          id?: string;
          content?: Array<{
            type?: string;
            id?: string;
            name?: string;
            text?: string;
            input?: Record<string, unknown>;
          }>;
        };
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const activities: NonNullable<ExternalCliStreamEvent["activities"]> = [];
        let progressNote: string | undefined;

        for (const block of blocks) {
          if (block?.type === "tool_use" && block.name) {
            const stepKey = block.id ? `cc_${block.id}` : undefined;
            const isBash = block.name === "Bash" || block.name === "bash";
            const cmd =
              isBash && typeof block.input?.command === "string"
                ? block.input.command
                : undefined;
            const fileTarget =
              typeof block.input?.file_path === "string"
                ? block.input.file_path
                : typeof block.input?.path === "string"
                  ? block.input.path
                  : undefined;
            if (!progressNote) {
              progressNote = isBash && cmd ? `正在执行: ${cmd.slice(0, 72)}` : `正在调用: ${block.name}`;
            }
            activities.push(
              isBash
                ? {
                    stepKey,
                    kind: "command",
                    state: "running",
                    title: "执行命令",
                    ...(cmd ? { command: cmd } : {}),
                  }
                : {
                    stepKey,
                    kind: "tool",
                    state: "running",
                    title: fileTarget ? `${block.name} · ${fileTarget}` : `调用工具 · ${block.name}`,
                  },
            );
          } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            activities.push({
              stepKey: msg.id ? `cc_msg_${msg.id}` : undefined,
              kind: "assistant",
              state: "done",
              title: "Worker 进展",
              text: block.text,
            });
          }
        }

        if (progressNote || activities.length > 0) {
          return {
            sessionId,
            progressNote,
            ...(activities.length > 0 ? { activities } : {}),
          };
        }
      }

      if (type === "user" && obj.message && typeof obj.message === "object") {
        const msg = obj.message as {
          content?: Array<{
            type?: string;
            tool_use_id?: string;
            is_error?: boolean;
            content?: string | Array<{ type?: string; text?: string }>;
          }>;
        };
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const activities: NonNullable<ExternalCliStreamEvent["activities"]> = [];
        for (const block of blocks) {
          if (block?.type === "tool_result" && block.tool_use_id) {
            const outText =
              typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .map((c) => (typeof c?.text === "string" ? c.text : ""))
                      .filter(Boolean)
                      .join("\n")
                  : "";
            activities.push({
              stepKey: `cc_${block.tool_use_id}`,
              kind: "tool",
              state: block.is_error ? "error" : "done",
              output: outText,
            });
          }
        }
        if (activities.length > 0) {
          return { sessionId, activities };
        }
      }

      if (type === "result") {
        const isError = Boolean(obj.is_error);
        const resultText = typeof obj.result === "string" ? obj.result : undefined;
        return {
          sessionId,
          finalText: resultText,
          error: isError ? resultText || "Claude Code execution failed" : undefined,
          done: true,
          ...(isError && resultText
            ? { activities: [{ kind: "error", state: "error", title: "执行失败", text: resultText }] }
            : {}),
        };
      }

      return sessionId ? { sessionId } : null;
    } catch {
      return null;
    }
  },
};
