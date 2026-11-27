import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { ExternalCliPermissionPreset } from "../../config/app.js";
import type { WorkerExecutionMode } from "./types.js";

const READ_ONLY_TOOL_KINDS = new Set(["read", "search", "think", "fetch"]);
const MUTATING_TOOL_KINDS = new Set(["edit", "delete", "move", "execute"]);

function pickOption(
  options: readonly PermissionOption[],
  preferredKinds: readonly PermissionOptionKind[],
): PermissionOption | undefined {
  for (const kind of preferredKinds) {
    const hit = options.find((opt) => opt.kind === kind);
    if (hit) return hit;
  }
  return undefined;
}

function buildAllowResponse(options: readonly PermissionOption[]): RequestPermissionResponse {
  const chosen = pickOption(options, ["allow_once", "allow_always"]);
  if (chosen) {
    return {
      outcome: {
        outcome: "selected",
        optionId: chosen.optionId,
      },
    };
  }
  return { outcome: { outcome: "cancelled" } };
}

function buildDenyResponse(options: readonly PermissionOption[]): RequestPermissionResponse {
  const chosen = pickOption(options, ["reject_once", "reject_always"]);
  if (chosen) {
    return {
      outcome: {
        outcome: "selected",
        optionId: chosen.optionId,
      },
    };
  }
  return { outcome: { outcome: "cancelled" } };
}

function describeToolCall(request: RequestPermissionRequest): string {
  const tc = request.toolCall;
  const parts: string[] = [];
  if (tc.title) parts.push(tc.title);
  if (tc.name && tc.name !== tc.title) parts.push(tc.name);
  if (tc.kind) parts.push(`[${tc.kind}]`);
  if (tc.rawInput !== undefined && tc.rawInput !== null) {
    try {
      const raw = typeof tc.rawInput === "string" ? tc.rawInput : JSON.stringify(tc.rawInput);
      if (raw && raw !== "{}") {
        parts.push(raw.slice(0, 180));
      }
    } catch {
      // ignore unserializable rawInput
    }
  }
  return parts.join(" ") || "受限工具操作";
}

export interface WorkerMcpPolicy {
  name: string;
  allowedTools: string[];
  deniedTools: string[];
  confirmTools: string[];
}

function matchMcpToolCall(
  request: RequestPermissionRequest,
  policies: readonly WorkerMcpPolicy[],
): { policy: WorkerMcpPolicy; toolName: string } | null {
  const candidates = [request.toolCall.name, request.toolCall.title].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  for (const raw of candidates) {
    const trimmed = raw.trim();
    // Match `mcp__<server>__<tool>` or `<server>:<tool>` or `<server>/<tool>`
    for (const policy of policies) {
      const prefixUnderscore = `mcp__${policy.name}__`;
      if (trimmed.startsWith(prefixUnderscore)) {
        return { policy, toolName: trimmed.slice(prefixUnderscore.length) };
      }
      const prefixColon = `${policy.name}:`;
      if (trimmed.startsWith(prefixColon)) {
        return { policy, toolName: trimmed.slice(prefixColon.length) };
      }
      const prefixSlash = `${policy.name}/`;
      if (trimmed.startsWith(prefixSlash)) {
        return { policy, toolName: trimmed.slice(prefixSlash.length) };
      }
    }
  }
  return null;
}

/**
 * Evaluate an ACP `session/request_permission` request against Hato's mandate
 * (`confirm_before`, `execution_mode`), Worker MCP tool policies, and configured `permission_preset`.
 */
export function evaluateAcpPermissionRequest(params: {
  request: RequestPermissionRequest;
  permissionPreset: ExternalCliPermissionPreset;
  executionMode: WorkerExecutionMode;
  confirmBefore: readonly string[];
  approvedConfirmKeys?: ReadonlySet<string>;
  workerMcpPolicies?: readonly WorkerMcpPolicy[];
}): {
  response: RequestPermissionResponse;
  deniedReason?: string;
  confirmRequired?: { key: string; reason: string };
} {
  const {
    request,
    permissionPreset,
    executionMode,
    confirmBefore,
    approvedConfirmKeys,
    workerMcpPolicies,
  } = params;
  const description = describeToolCall(request);
  const lowerDesc = description.toLowerCase();

  if (workerMcpPolicies && workerMcpPolicies.length > 0) {
    const matchedMcp = matchMcpToolCall(request, workerMcpPolicies);
    if (matchedMcp) {
      const { policy, toolName } = matchedMcp;
      if (policy.deniedTools.includes(toolName)) {
        return {
          response: buildDenyResponse(request.options),
          deniedReason: `MCP 工具 ${policy.name}:${toolName} 已被 denied_tools 策略禁止`,
        };
      }
      if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(toolName)) {
        return {
          response: buildDenyResponse(request.options),
          deniedReason: `MCP 工具 ${policy.name}:${toolName} 不在 allowed_tools 白名单内`,
        };
      }
      if (policy.confirmTools.includes(toolName)) {
        const confirmKey = `mcp:${policy.name}:${toolName}`;
        if (!approvedConfirmKeys?.has(confirmKey)) {
          return {
            response: buildDenyResponse(request.options),
            confirmRequired: {
              key: confirmKey,
              reason: `调用高危 MCP 工具 ${policy.name}:${toolName} (${description})`,
            },
          };
        }
      }
    }
  }

  for (const rule of confirmBefore) {
    const trimmed = rule.trim().toLowerCase();
    if (trimmed && lowerDesc.includes(trimmed)) {
      const confirmKey = `rule:${trimmed}`;
      if (!approvedConfirmKeys?.has(confirmKey) && !approvedConfirmKeys?.has(rule)) {
        return {
          response: buildDenyResponse(request.options),
          confirmRequired: {
            key: confirmKey,
            reason: `命中高危确认规则 (${rule}): ${description}`,
          },
        };
      }
    }
  }

  if (executionMode === "vm_unrestricted" || permissionPreset === "yolo") {
    return {
      response: buildAllowResponse(request.options),
    };
  }

  const kind = request.toolCall.kind ?? "other";
  if (permissionPreset === "read_only") {
    if (READ_ONLY_TOOL_KINDS.has(kind)) {
      return { response: buildAllowResponse(request.options) };
    }
    if (MUTATING_TOOL_KINDS.has(kind) || kind === "other") {
      return {
        response: buildDenyResponse(request.options),
        deniedReason: `read_only 权限模式拒绝执行变更操作: ${description}`,
      };
    }
  }

  // auto_safe / follow_host / custom: allow normal workspace operations when confirm_before did not trigger
  return {
    response: buildAllowResponse(request.options),
  };
}
