import type { ExternalCliAdapter, ExternalCliStreamEvent } from "./types.js";

export const openCodeV2CliAdapter: ExternalCliAdapter = {
  backend: "opencode-v2",

  buildStartArgs({ prompt, overlay }) {
    // `--standalone` is included in overlay.modeArgs for OpenCode V2 isolation.
    return ["run", ...overlay.modeArgs, ...overlay.extraArgs, "--format", "json", prompt];
  },

  buildResumeArgs({ sessionId, reply, overlay }) {
    return [
      "run",
      ...overlay.modeArgs,
      ...overlay.extraArgs,
      "--format",
      "json",
      "--session",
      sessionId,
      reply,
    ];
  },

  parseStreamLine(line: string): ExternalCliStreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "";
      const sessionId =
        typeof obj.sessionID === "string"
          ? obj.sessionID
          : typeof obj.session_id === "string"
            ? obj.session_id
            : undefined;

      if (type === "error") {
        const errObj = obj.error as { message?: string } | string | undefined;
        const msg = typeof errObj === "string" ? errObj : errObj?.message || "OpenCode V2 error";
        return {
          sessionId,
          error: msg,
          activities: [{ kind: "error", state: "error", title: "OpenCode 错误", text: msg }],
        };
      }

      if (type === "tool_use" || type === "tool") {
        const part = (obj.part && typeof obj.part === "object" ? obj.part : obj) as Record<
          string,
          unknown
        >;
        const toolName =
          typeof part.tool === "string"
            ? part.tool
            : typeof part.name === "string"
              ? part.name
              : "工具";
        const rawId =
          typeof part.callID === "string"
            ? part.callID
            : typeof part.id === "string"
              ? part.id
              : undefined;
        const stepKey = rawId ? `oc_${rawId}` : undefined;
        const stateObj =
          part.state && typeof part.state === "object"
            ? (part.state as Record<string, unknown>)
            : undefined;
        const statusStr = typeof stateObj?.status === "string" ? stateObj.status : "";
        const inputObj =
          stateObj?.input && typeof stateObj.input === "object"
            ? (stateObj.input as Record<string, unknown>)
            : undefined;
        const outputText = typeof stateObj?.output === "string" ? stateObj.output : undefined;
        const isBash = toolName === "bash" || toolName === "shell";
        const cmdText = isBash && typeof inputObj?.command === "string" ? inputObj.command : undefined;
        const actState =
          statusStr === "error"
            ? "error"
            : statusStr === "completed" || outputText !== undefined
              ? "done"
              : "running";

        return {
          sessionId,
          progressNote:
            isBash && cmdText ? `正在执行: ${cmdText.slice(0, 72)}` : `正在执行: ${toolName}`,
          activities: [
            isBash
              ? {
                  stepKey,
                  kind: "command",
                  state: actState,
                  title: "执行命令",
                  ...(cmdText ? { command: cmdText } : {}),
                  ...(outputText !== undefined ? { output: outputText } : {}),
                }
              : {
                  stepKey,
                  kind: "tool",
                  state: actState,
                  title: `调用工具 · ${toolName}`,
                  ...(outputText !== undefined ? { output: outputText } : {}),
                },
          ],
        };
      }

      if (type === "text" || type === "message") {
        const part = (obj.part && typeof obj.part === "object" ? obj.part : obj) as Record<
          string,
          unknown
        >;
        const text =
          typeof part.text === "string"
            ? part.text
            : typeof obj.content === "string"
              ? obj.content
              : undefined;
        return {
          sessionId,
          finalText: text,
          textDelta: text,
          ...(text
            ? {
                activities: [
                  {
                    stepKey: typeof part.id === "string" ? `oc_txt_${part.id}` : undefined,
                    kind: "assistant",
                    state: "done",
                    title: "Worker 进展",
                    text,
                  },
                ],
              }
            : {}),
        };
      }

      if (type === "step_finish" || type === "done") {
        return { sessionId, done: true };
      }

      return sessionId ? { sessionId } : null;
    } catch {
      return null;
    }
  },
};
