import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  filterPendingAutoArtifacts,
  formatTicketArtifactPromptHint,
  partitionTicketArtifacts,
} from "../src/dispatch/artifact-delivery.js";
import type { ResultArtifact } from "../src/dispatch/schema.js";

describe("artifact-delivery", () => {
  const photoArtifact: ResultArtifact = {
    path: "/tmp/hato/work/skirt.png",
    filename: "skirt.png",
    send_as: "photo",
  };
  const docArtifact: ResultArtifact = {
    path: "/tmp/hato/work/report.pdf",
    filename: "report.pdf",
    send_as: "file",
  };

  test("deliverFiles=false (persona-controlled mode) leaves all artifacts including photos for Persona to send", () => {
    const partition = partitionTicketArtifacts({
      artifacts: [photoArtifact, docArtifact],
      canAutoSend: true,
      deliverFiles: false,
    });

    expect(partition.autoDelivered).toEqual([]);
    expect(partition.onDemand).toEqual([photoArtifact, docArtifact]);

    const hint = formatTicketArtifactPromptHint(partition);
    expect(hint).toContain("自行调用 send_file 或 send_message 控制发送时机与顺序");
    expect(hint).toContain("skirt.png (/tmp/hato/work/skirt.png)");
    expect(hint).toContain("report.pdf (/tmp/hato/work/report.pdf)");
    expect(hint).not.toContain("系统将在本轮回复后自动发送");
  });

  test("deliverFiles=true (auto-deliver mode) marks all artifacts for system delivery and warns Persona not to duplicate", () => {
    const partition = partitionTicketArtifacts({
      artifacts: [photoArtifact, docArtifact],
      canAutoSend: true,
      deliverFiles: true,
    });

    expect(partition.autoDelivered).toEqual([photoArtifact, docArtifact]);
    expect(partition.onDemand).toEqual([]);

    const hint = formatTicketArtifactPromptHint(partition);
    expect(hint).toContain("系统将在本轮回复后自动发送给用户，请勿调用 send_file 或 send_message 重复发送");
    expect(hint).toContain("skirt.png (/tmp/hato/work/skirt.png)");
    expect(hint).not.toContain("如需发给用户");
  });

  test("canAutoSend=false falls back to onDemand even when deliverFiles=true", () => {
    const partition = partitionTicketArtifacts({
      artifacts: [photoArtifact],
      canAutoSend: false,
      deliverFiles: true,
    });

    expect(partition.autoDelivered).toEqual([]);
    expect(partition.onDemand).toEqual([photoArtifact]);
  });

  test("filterPendingAutoArtifacts skips files already sent during narration", () => {
    const sentPaths = new Set<string>([resolve("/tmp/hato/work/../work/skirt.png")]);
    const pending = filterPendingAutoArtifacts({
      autoDelivered: [photoArtifact, docArtifact],
      sentPaths,
    });

    expect(pending).toEqual([docArtifact]);
  });
});
