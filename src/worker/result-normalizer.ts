import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { WorkerResultSchema, type WorkerResult } from "../dispatch/schema.js";

export interface NormalizeExternalCliResultParams {
  ticketId: string;
  workspaceDir: string;
  isHostRepo: boolean;
  beforeFilesSnapshot?: ReadonlySet<string>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finalText: string;
  stderrText: string;
  structuredError?: string;
  permissionDeniedReason?: string;
  stopReason?: string;
  timedOut?: boolean;
}

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const IGNORED_ARTIFACT_NAMES = new Set([
  "_hato_result.json",
  "_hato_stream.jsonl",
]);
const IGNORED_ARTIFACT_EXTENSIONS = new Set([".jsonl", ".log", ".tmp", ".bak"]);

/**
 * Snapshot regular files in an isolated workspace before worker execution
 * so newly created/updated artifacts can be detected deterministically afterward.
 */
export function snapshotWorkspaceFiles(workspaceDir: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(workspaceDir)) return out;
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || name === ".agents") continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (st.isFile()) {
          out.add(relative(workspaceDir, full).replace(/\\/g, "/"));
        }
      } catch {
        // ignore transient files
      }
    }
  };
  walk(workspaceDir, 0);
  return out;
}

/**
 * Combine 4 signals (optional `_hato_result.json`, exit code/signal, final text/JSONL status,
 * and workspace file diff) into a uniform Wall-3 `WorkerResult`.
 */
export function normalizeExternalCliResult(
  params: NormalizeExternalCliResultParams,
): WorkerResult {
  const explicit = tryReadExplicitResultFile(params.ticketId, params.workspaceDir);
  if (explicit) {
    return explicit;
  }

  const parsedJsonText = tryParseJsonWorkerResult(
    params.ticketId,
    params.finalText,
    params.workspaceDir,
  );
  if (parsedJsonText) {
    return parsedJsonText;
  }

  const diffStat = params.isHostRepo ? tryReadGitDiffStat(params.workspaceDir) : "";
  const newFiles = collectNewArtifacts(params.workspaceDir, params.beforeFilesSnapshot);

  if (params.timedOut) {
    return {
      ticket_id: params.ticketId,
      status: "failed",
      narration_hint: "后台执行超时中止，请检查任务范围或分步执行。",
      verbatim_blocks: buildDiagnosticBlocks(params.finalText, params.stderrText, diffStat),
      artifacts: newFiles,
      required_secrets: [],
      caveats: ["执行超时被中止"],
    };
  }

  if (params.permissionDeniedReason) {
    return {
      ticket_id: params.ticketId,
      status: "needs_input",
      narration_hint: `后台工具权限受限，需要你的确认或调整：${params.permissionDeniedReason}`,
      verbatim_blocks: [],
      artifacts: [],
      required_secrets: [],
      caveats: [],
      question: params.permissionDeniedReason,
    };
  }

  if ((params.exitCode !== null && params.exitCode !== 0) || params.signal || params.structuredError) {
    const reason =
      params.structuredError ||
      params.stderrText.trim().split(/\r?\n/).slice(-3).join(" | ") ||
      `exitCode=${String(params.exitCode)} signal=${String(params.signal)}`;
    return {
      ticket_id: params.ticketId,
      status: "failed",
      narration_hint: `后台执行失败：${reason.slice(0, 200)}`,
      verbatim_blocks: buildDiagnosticBlocks(params.finalText, params.stderrText, diffStat),
      artifacts: newFiles,
      required_secrets: [],
      caveats: [reason.slice(0, 240)],
    };
  }

  if (params.stopReason === "refusal") {
    return {
      ticket_id: params.ticketId,
      status: "failed",
      narration_hint: "后台执行被代理拒绝。",
      verbatim_blocks: buildDiagnosticBlocks(params.finalText, params.stderrText, diffStat),
      artifacts: newFiles,
      required_secrets: [],
      caveats: ["ACP stopReason=refusal"],
    };
  }

  if (params.stopReason === "cancelled") {
    return {
      ticket_id: params.ticketId,
      status: "failed",
      narration_hint: "后台任务已被取消。",
      verbatim_blocks: buildDiagnosticBlocks(params.finalText, params.stderrText, diffStat),
      artifacts: newFiles,
      required_secrets: [],
      caveats: ["ACP stopReason=cancelled"],
    };
  }

  const trimmedFinal = params.finalText.trim();
  const hasWorkspaceChanges = newFiles.length > 0 || diffStat.length > 0;

  if (!hasWorkspaceChanges && looksLikeNeedsInputQuestion(trimmedFinal)) {
    return {
      ticket_id: params.ticketId,
      status: "needs_input",
      narration_hint: trimmedFinal,
      verbatim_blocks: [],
      artifacts: [],
      required_secrets: [],
      caveats: [],
      question: trimmedFinal,
    };
  }

  const summary =
    summarizeCleanText(trimmedFinal) ||
    (hasWorkspaceChanges ? "已完成后台工作区修改与产物生成。" : "后台任务执行完成。");

  const verbatimBlocks = buildCompletionBlocks(trimmedFinal, diffStat);
  return {
    ticket_id: params.ticketId,
    status: "done",
    narration_hint: summary,
    verbatim_blocks: verbatimBlocks,
    artifacts: newFiles,
    required_secrets: [],
    caveats: [],
  };
}

export function looksLikeNeedsInputQuestion(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  const lastLines = clean.split(/\r?\n/).slice(-4).join("\n");
  if (!/[？?]\s*$/.test(lastLines) && !/(请确认|请提供|请问|告诉我|需要你|which option|please provide|please confirm|clarify)/i.test(lastLines)) {
    return false;
  }
  if (clean.length > 1200) return false;
  return true;
}

function tryReadExplicitResultFile(ticketId: string, workspaceDir: string): WorkerResult | null {
  const path = join(workspaceDir, "_hato_result.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return coerceWorkerResult(ticketId, parsed, workspaceDir);
  } catch {
    return null;
  }
}

function tryParseJsonWorkerResult(
  ticketId: string,
  finalText: string,
  workspaceDir?: string,
): WorkerResult | null {
  const trimmed = finalText.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return coerceWorkerResult(ticketId, parsed, workspaceDir);
  } catch {
    return null;
  }
}

function coerceWorkerResult(
  ticketId: string,
  raw: Record<string, unknown>,
  workspaceDir?: string,
): WorkerResult | null {
  const rawArtifacts = Array.isArray(raw.artifacts) ? raw.artifacts : [];
  const normalizedArtifacts = rawArtifacts.map((item) => {
    if (!item || typeof item !== "object") return item;
    const rec = item as Record<string, unknown>;
    const rawPath = typeof rec.path === "string" ? rec.path.trim() : "";
    const resolvedPath =
      rawPath && workspaceDir ? resolve(workspaceDir, rawPath) : rawPath;
    const filename =
      typeof rec.filename === "string" && rec.filename
        ? rec.filename
        : resolvedPath.split("/").pop() ?? rawPath;
    const ext = filename.includes(".") ? `.${filename.split(".").pop()!.toLowerCase()}` : "";
    const sendAs =
      rec.send_as === "photo" || IMAGE_EXTENSIONS.has(ext) ? "photo" : "file";
    return {
      ...rec,
      path: resolvedPath,
      filename,
      send_as: sendAs,
    };
  });
  const candidate: Record<string, unknown> = {
    ticket_id: typeof raw.ticket_id === "string" && raw.ticket_id ? raw.ticket_id : ticketId,
    status: raw.status ?? "done",
    narration_hint: typeof raw.narration_hint === "string" ? raw.narration_hint : "",
    verbatim_blocks: Array.isArray(raw.verbatim_blocks) ? raw.verbatim_blocks : [],
    artifacts: normalizedArtifacts,
    required_secrets: Array.isArray(raw.required_secrets) ? raw.required_secrets : [],
    caveats: Array.isArray(raw.caveats) ? raw.caveats : [],
    ...(typeof raw.question === "string" ? { question: raw.question } : {}),
    ...(typeof raw.confirm_action === "string" ? { confirm_action: raw.confirm_action } : {}),
  };
  return Value.Check(WorkerResultSchema, candidate) ? (candidate as WorkerResult) : null;
}

export function collectNewArtifacts(
  workspaceDir: string,
  beforeSnapshot?: ReadonlySet<string>,
): WorkerResult["artifacts"] {
  if (!beforeSnapshot || !existsSync(workspaceDir)) return [];
  const after = snapshotWorkspaceFiles(workspaceDir);
  const artifacts: WorkerResult["artifacts"] = [];
  for (const rel of [...after].sort()) {
    if (beforeSnapshot.has(rel)) continue;
    const baseName = rel.split("/").pop() ?? rel;
    if (IGNORED_ARTIFACT_NAMES.has(baseName)) continue;
    const ext = baseName.includes(".") ? `.${baseName.split(".").pop()!.toLowerCase()}` : "";
    if (IGNORED_ARTIFACT_EXTENSIONS.has(ext)) continue;
    artifacts.push({
      path: resolve(workspaceDir, rel),
      filename: baseName,
      send_as: IMAGE_EXTENSIONS.has(ext) ? "photo" : "file",
    });
    if (artifacts.length >= 6) break;
  }
  return artifacts;
}

function tryReadGitDiffStat(workspaceDir: string): string {
  try {
    const out = execFileSync("git", ["diff", "--stat"], {
      cwd: workspaceDir,
      timeout: 3000,
      encoding: "utf8",
    });
    return out.trim();
  } catch {
    return "";
  }
}

function summarizeCleanText(text: string): string {
  if (!text) return "";
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 280 ? `${singleLine.slice(0, 277)}...` : singleLine;
}

function buildCompletionBlocks(
  finalText: string,
  diffStat: string,
): WorkerResult["verbatim_blocks"] {
  const blocks: WorkerResult["verbatim_blocks"] = [];
  if (diffStat) {
    blocks.push({ title: "工作区变更摘要 (git diff --stat)", format: "text", content: diffStat });
  }
  if (finalText && (finalText.includes("```") || finalText.length > 280)) {
    blocks.push({
      title: "执行输出详情",
      format: "markdown",
      content: finalText.slice(0, 3500),
    });
  }
  return blocks;
}

function buildDiagnosticBlocks(
  finalText: string,
  stderrText: string,
  diffStat: string,
): WorkerResult["verbatim_blocks"] {
  const blocks: WorkerResult["verbatim_blocks"] = [];
  if (stderrText.trim()) {
    blocks.push({
      title: "错误输出 (stderr)",
      format: "text",
      content: stderrText.trim().slice(-2000),
    });
  }
  if (finalText.trim()) {
    blocks.push({
      title: "末轮输出",
      format: "markdown",
      content: finalText.trim().slice(-2000),
    });
  }
  if (diffStat) {
    blocks.push({ title: "工作区变更 (git diff --stat)", format: "text", content: diffStat });
  }
  return blocks;
}
