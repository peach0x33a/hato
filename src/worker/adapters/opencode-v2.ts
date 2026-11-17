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
        return { sessionId, error: msg };
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
        return { sessionId, progressNote: `正在执行: ${toolName}` };
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
        return { sessionId, finalText: text, textDelta: text };
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
