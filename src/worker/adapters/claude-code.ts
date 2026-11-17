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
        return { sessionId, progressNote: "已初始化 Claude Code 会话" };
      }

      if (type === "assistant" && obj.message && typeof obj.message === "object") {
        const msg = obj.message as { content?: Array<{ type?: string; name?: string }> };
        const toolUse = msg.content?.find((c) => c?.type === "tool_use");
        if (toolUse?.name) {
          return { sessionId, progressNote: `正在调用: ${toolUse.name}` };
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
        };
      }

      return sessionId ? { sessionId } : null;
    } catch {
      return null;
    }
  },
};
