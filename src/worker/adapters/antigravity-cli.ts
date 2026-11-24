import type { ExternalCliAdapter, ExternalCliStreamEvent } from "./types.js";

export const antigravityCliAdapter: ExternalCliAdapter = {
  backend: "antigravity-cli",

  buildStartArgs({ prompt, overlay, schemaPath }) {
    const args = [`-p=${prompt}`, "--output-format", "stream-json"];
    args.push(...overlay.modeArgs, ...overlay.extraArgs);
    if (schemaPath) {
      args.push("--json-schema", schemaPath);
    }
    return args;
  },

  buildResumeArgs({ sessionId, reply, overlay, schemaPath }) {
    const args = ["--conversation", sessionId, `-p=${reply}`, "--output-format", "stream-json"];
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
      const event = typeof obj.event === "string" ? obj.event : "";
      const sessionId =
        typeof obj.conversation_id === "string" ? obj.conversation_id : undefined;

      if (event === "init") {
        return {
          sessionId,
          progressNote: "已初始化 Antigravity CLI 会话",
        };
      }

      if (event === "step_update" && obj.step_update && typeof obj.step_update === "object") {
        const su = obj.step_update as Record<string, unknown>;
        const stepType = typeof su.step_type === "string" ? su.step_type : "";
        const state = typeof su.state === "string" ? su.state : "";
        const textDelta = typeof su.text_delta === "string" ? su.text_delta : undefined;
        const toolInfo =
          su.tool_info && typeof su.tool_info === "object"
            ? (su.tool_info as Record<string, unknown>)
            : undefined;
        const subagentInfo =
          su.subagent_info && typeof su.subagent_info === "object"
            ? (su.subagent_info as Record<string, unknown>)
            : undefined;
        const toolName =
          typeof su.tool_name === "string"
            ? su.tool_name
            : typeof toolInfo?.name === "string"
              ? toolInfo.name
              : typeof su.name === "string"
                ? su.name
                : undefined;

        let progressNote: string | undefined;
        if (stepType === "tool" || stepType === "tool_call" || stepType === "tool_use" || toolName) {
          if (state !== "DONE") {
            progressNote = `正在调用工具: ${toolName || stepType}`;
          }
        } else if (subagentInfo && state !== "DONE") {
          progressNote = "正在调度子代理";
        } else if (stepType === "agent_response" && state === "ACTIVE") {
          progressNote = "正在生成响应";
        }

        let permissionDenied: string | undefined;
        if (toolInfo?.error && typeof toolInfo.error === "object") {
          const errObj = toolInfo.error as Record<string, unknown>;
          const errType = typeof errObj.type === "string" ? errObj.type : "";
          const errMessage = typeof errObj.message === "string" ? errObj.message : "";
          if (/permission|approval|not trusted/i.test(`${errType} ${errMessage}`)) {
            permissionDenied = errMessage || errType;
          }
        }

        return {
          sessionId: typeof su.conversation_id === "string" ? su.conversation_id : sessionId,
          progressNote,
          textDelta,
          ...(permissionDenied ? { permissionDenied } : {}),
        };
      }

      if (event === "result" && obj.result && typeof obj.result === "object") {
        const res = obj.result as Record<string, unknown>;
        const status = typeof res.status === "string" ? res.status : "";
        const response = typeof res.response === "string" ? res.response : undefined;
        const structuredOutput = res.structured_output;
        const finalText =
          structuredOutput !== undefined && structuredOutput !== null
            ? typeof structuredOutput === "string"
              ? structuredOutput
              : JSON.stringify(structuredOutput)
            : response;
        const errMsg = typeof res.error === "string" ? res.error : undefined;
        const isPermDenied =
          status === "PERMISSION_DENIED" ||
          Boolean(errMsg && /permission denied|requires approval|not trusted/i.test(errMsg));

        return {
          sessionId: typeof res.conversation_id === "string" ? res.conversation_id : sessionId,
          finalText,
          ...(isPermDenied
            ? { permissionDenied: errMsg || "Antigravity CLI 权限请求被拒绝" }
            : {
                error:
                  status && status !== "SUCCESS"
                    ? errMsg || `antigravity-cli status=${status}`
                    : errMsg,
              }),
          done: true,
        };
      }

      return null;
    } catch {
      return null;
    }
  },
};
