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

/**
 * Evaluate an ACP `session/request_permission` request against Hato's mandate
 * (`confirm_before`, `execution_mode`) and configured `permission_preset`.
 */
export function evaluateAcpPermissionRequest(params: {
  request: RequestPermissionRequest;
  permissionPreset: ExternalCliPermissionPreset;
  executionMode: WorkerExecutionMode;
  confirmBefore: readonly string[];
}): { response: RequestPermissionResponse; deniedReason?: string } {
  const { request, permissionPreset, executionMode, confirmBefore } = params;
  const description = describeToolCall(request);
  const lowerDesc = description.toLowerCase();

  for (const rule of confirmBefore) {
    const trimmed = rule.trim().toLowerCase();
    if (trimmed && lowerDesc.includes(trimmed)) {
      return {
        response: buildDenyResponse(request.options),
        deniedReason: `命中高危确认规则 (${rule}): ${description}`,
      };
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
