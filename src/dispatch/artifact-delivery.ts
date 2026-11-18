import { resolve } from "node:path";
import type { ResultArtifact } from "./schema.js";

export interface ArtifactDeliveryPartition {
  autoDelivered: ResultArtifact[];
  onDemand: ResultArtifact[];
}

/**
 * Splits ticket artifacts according to the per-task delivery mode (`deliver_files`):
 * - `deliverFiles === true` (and outbound supports `sendFile`): system auto-delivers
 *   all artifacts after narration, and Persona is instructed not to duplicate them.
 * - `deliverFiles === false` (default): Persona decides whether, when, and in what
 *   message order to send any artifact (including photos) via `send_file` / `send_message`.
 */
export function partitionTicketArtifacts(params: {
  artifacts: readonly ResultArtifact[];
  canAutoSend: boolean;
  deliverFiles: boolean;
}): ArtifactDeliveryPartition {
  if (params.canAutoSend && params.deliverFiles) {
    return {
      autoDelivered: [...params.artifacts],
      onDemand: [],
    };
  }
  return {
    autoDelivered: [],
    onDemand: [...params.artifacts],
  };
}

/**
 * Builds the artifact hint appended to the background narration prompt so
 * Persona knows whether the system will auto-deliver the files or whether
 * Persona should control sending them via `send_file` / `send_message`.
 */
export function formatTicketArtifactPromptHint(partition: ArtifactDeliveryPartition): string {
  const parts: string[] = [];

  if (partition.autoDelivered.length > 0) {
    const list = partition.autoDelivered.map((a) => `${a.filename} (${a.path})`).join(", ");
    parts.push(
      `\n生成文件（系统将在本轮回复后自动发送给用户，请勿调用 send_file 或 send_message 重复发送）：${list}`,
    );
  }

  if (partition.onDemand.length > 0) {
    const list = partition.onDemand.map((a) => `${a.filename} (${a.path})`).join(", ");
    parts.push(
      `\n生成文件（如需发给用户，请自行调用 send_file 或 send_message 控制发送时机与顺序）：${list}`,
    );
  }

  return parts.join("");
}

/**
 * Filters out auto-delivered artifacts that Persona already sent via
 * `send_file` / `send_message` during `narrateBackgroundEvent`.
 */
export function filterPendingAutoArtifacts(params: {
  autoDelivered: readonly ResultArtifact[];
  sentPaths: ReadonlySet<string>;
}): ResultArtifact[] {
  if (params.sentPaths.size === 0) {
    return [...params.autoDelivered];
  }
  return params.autoDelivered.filter((artifact) => !params.sentPaths.has(resolve(artifact.path)));
}
