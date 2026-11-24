import type { ExternalCliAdapter, ExternalCliStreamEvent } from "./types.js";

export const externalPiCliAdapter: ExternalCliAdapter = {
  backend: "external-pi",

  buildStartArgs({ prompt, overlay }) {
    return ["-p", prompt, "--mode", "json", ...overlay.modeArgs, ...overlay.extraArgs];
  },

  buildResumeArgs({ sessionId, reply, overlay }) {
    return [
      "--session",
      sessionId,
      "-p",
      reply,
      "--mode",
      "json",
      ...overlay.modeArgs,
      ...overlay.extraArgs,
    ];
  },

  parseStreamLine(line: string): ExternalCliStreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "";
      const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : undefined;
      if (type === "tool_execution_start" || type === "tool_execution_end") {
        const toolName = typeof obj.toolName === "string" ? obj.toolName : "工具";
        const stepKey =
          typeof obj.toolCallId === "string" ? `pi_${obj.toolCallId}` : undefined;
        const argsObj =
          obj.args && typeof obj.args === "object"
            ? (obj.args as Record<string, unknown>)
            : undefined;
        const isCmd = toolName === "bash" || toolName === "run_command";
        const cmdText = isCmd && typeof argsObj?.command === "string" ? argsObj.command : undefined;
        const outText = typeof obj.result === "string" ? obj.result : undefined;
        const isDone = type === "tool_execution_end";

        return {
          sessionId,
          ...(isDone ? {} : { progressNote: `正在调用: ${toolName}` }),
          activities: [
            isCmd
              ? {
                  stepKey,
                  kind: "command",
                  state: isDone ? (obj.isError ? "error" : "done") : "running",
                  title: "执行命令",
                  ...(cmdText ? { command: cmdText } : {}),
                  ...(outText !== undefined ? { output: outText } : {}),
                }
              : {
                  stepKey,
                  kind: "tool",
                  state: isDone ? (obj.isError ? "error" : "done") : "running",
                  title: `调用工具 · ${toolName}`,
                  ...(outText !== undefined ? { output: outText } : {}),
                },
          ],
        };
      }
      if (type === "agent_end") {
        return {
          sessionId,
          finalText: typeof obj.text === "string" ? obj.text : undefined,
          done: true,
        };
      }
      return sessionId ? { sessionId } : null;
    } catch {
      return null;
    }
  },
};
