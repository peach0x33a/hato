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
      if (type === "tool_execution_start") {
        return {
          sessionId,
          progressNote: `正在调用: ${typeof obj.toolName === "string" ? obj.toolName : "工具"}`,
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
