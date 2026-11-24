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
          activities: [
            {
              kind: "lifecycle",
              state: "done",
              title: "已初始化 Antigravity CLI 会话",
            },
          ],
        };
      }

      if (event === "step_update" && obj.step_update && typeof obj.step_update === "object") {
        const su = obj.step_update as Record<string, unknown>;
        const stepType = typeof su.step_type === "string" ? su.step_type : "";
        const state = typeof su.state === "string" ? su.state : "";
        const stepKey =
          typeof su.step_index === "number" ? `agy_step_${su.step_index}` : undefined;
        const durationMs =
          typeof su.duration_seconds === "number"
            ? Math.max(1, Math.round(su.duration_seconds * 1000))
            : undefined;
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

        let permissionDenied: string | undefined;
        let toolErrorMessage: string | undefined;
        if (toolInfo?.error && typeof toolInfo.error === "object") {
          const errObj = toolInfo.error as Record<string, unknown>;
          const errType = typeof errObj.type === "string" ? errObj.type : "";
          const errMessage = typeof errObj.message === "string" ? errObj.message : "";
          toolErrorMessage = errMessage || errType || undefined;
          if (/permission|approval|not trusted/i.test(`${errType} ${errMessage}`)) {
            permissionDenied = errMessage || errType;
          }
        }

        const activities: NonNullable<ExternalCliStreamEvent["activities"]> = [];
        let progressNote: string | undefined;

        if (stepType === "tool" || stepType === "tool_call" || stepType === "tool_use" || toolName) {
          const params =
            toolInfo?.parameters && typeof toolInfo.parameters === "object"
              ? (toolInfo.parameters as Record<string, unknown>)
              : undefined;
          const isCmd =
            toolName === "run_command" ||
            toolName === "send_command_input" ||
            toolName === "command_status";
          const cmdText =
            typeof params?.CommandLine === "string"
              ? params.CommandLine
              : typeof params?.Input === "string"
                ? params.Input
                : undefined;
          const rawOut = typeof toolInfo?.output === "string" ? toolInfo.output : undefined;
          const combinedOut =
            toolErrorMessage && rawOut
              ? `${rawOut}\n[error] ${toolErrorMessage}`
              : toolErrorMessage ?? rawOut;
          const actState =
            state === "ERROR" || Boolean(toolErrorMessage)
              ? "error"
              : state === "DONE"
                ? "done"
                : "running";

          if (state !== "DONE") {
            progressNote =
              isCmd && cmdText
                ? `正在执行: ${cmdText.slice(0, 72)}`
                : `正在调用工具: ${toolName || stepType}`;
          }

          if (isCmd) {
            activities.push({
              stepKey,
              kind: "command",
              state: actState,
              title: toolName === "send_command_input" ? "向任务发送输入" : "执行命令",
              ...(cmdText ? { command: cmdText } : {}),
              ...(combinedOut !== undefined ? { output: combinedOut } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            });
          } else {
            const targetHint =
              typeof params?.Path === "string"
                ? params.Path
                : typeof params?.TargetFile === "string"
                  ? params.TargetFile
                  : typeof params?.ServerName === "string" && typeof params?.ToolName === "string"
                    ? `${params.ServerName}.${params.ToolName}`
                    : typeof params?.ToolName === "string"
                      ? params.ToolName
                      : typeof params?.Query === "string"
                        ? params.Query
                        : undefined;
            activities.push({
              stepKey,
              kind: "tool",
              state: actState,
              title: targetHint
                ? `${toolName || "工具"} · ${targetHint}`
                : `调用工具 · ${toolName || stepType}`,
              ...(combinedOut !== undefined ? { output: combinedOut } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            });
          }
        } else if (subagentInfo) {
          if (state !== "DONE") {
            progressNote = "正在调度子代理";
          }
          activities.push({
            stepKey,
            kind: "tool",
            state: state === "DONE" ? "done" : "running",
            title: "调度子代理",
            ...(durationMs !== undefined ? { durationMs } : {}),
          });
        } else if (stepType === "agent_response") {
          if (state === "ACTIVE") {
            progressNote = "正在生成响应";
          }
          if (textDelta || state === "DONE") {
            activities.push({
              stepKey,
              kind: "assistant",
              state: state === "DONE" ? "done" : "running",
              title: "Worker 输出",
              ...(textDelta ? { appendText: textDelta } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            });
          }
        }

        return {
          sessionId: typeof su.conversation_id === "string" ? su.conversation_id : sessionId,
          progressNote,
          textDelta,
          ...(permissionDenied ? { permissionDenied } : {}),
          ...(activities.length > 0 ? { activities } : {}),
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
