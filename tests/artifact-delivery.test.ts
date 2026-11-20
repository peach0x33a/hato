import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  filterPendingAutoArtifacts,
  formatTicketArtifactPromptHint,
  loadArtifactImagesForModel,
  partitionTicketArtifacts,
} from "../src/dispatch/artifact-delivery.js";
import type { ResultArtifact } from "../src/dispatch/schema.js";
import { normalizeExternalCliResult } from "../src/worker/result-normalizer.js";

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

  test("loadArtifactImagesForModel loads image artifacts and skips missing or non-image files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-artifact-img-"));
    try {
      // 1x1 transparent PNG
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64",
      );
      const imgPath = join(dir, "generated.png");
      const txtPath = join(dir, "notes.txt");
      writeFileSync(imgPath, pngBytes);
      writeFileSync(txtPath, "hello");

      const images = await loadArtifactImagesForModel([
        { path: txtPath, filename: "notes.txt", send_as: "file" },
        { path: join(dir, "missing.png"), filename: "missing.png", send_as: "photo" },
        { path: imgPath, filename: "generated.png", send_as: "file" },
      ]);

      expect(images).toHaveLength(1);
      expect(images[0]?.type).toBe("image");
      expect(images[0]?.mimeType).toBe("image/png");
      expect(images[0]?.data.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("normalizeExternalCliResult resolves relative artifact paths in _hato_result.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-norm-rel-"));
    try {
      writeFileSync(
        join(dir, "_hato_result.json"),
        JSON.stringify({
          status: "done",
          narration_hint: "ok",
          verbatim_blocks: [],
          artifacts: [{ path: "out/pic.png", filename: "pic.png", send_as: "file" }],
          required_secrets: [],
          caveats: [],
          question: null,
        }),
      );
      const result = normalizeExternalCliResult({
        ticketId: "t_rel_1",
        workspaceDir: dir,
        isHostRepo: false,
        exitCode: 0,
        signal: null,
        finalText: "",
        stderrText: "",
      });
      expect(result.artifacts).toEqual([
        {
          path: resolve(dir, "out/pic.png"),
          filename: "pic.png",
          send_as: "photo",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
