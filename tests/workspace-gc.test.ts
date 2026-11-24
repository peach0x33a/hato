import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { cleanupExpiredWorkspaces } from "../src/dispatch/workspace-gc.js";

describe("workspace-gc", () => {
  test("cleanupExpiredWorkspaces removes expired isolated workspaces while skipping active and host_repo tickets", () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-wgc-"));
    try {
      const workspacesDir = join(dir, "workspaces");
      mkdirSync(workspacesDir, { recursive: true });
      const dbHandle = openDatabase(join(dir, "test.db"));
      const repo = new HatoRepository(dbHandle.db);

      const now = Date.now();
      const expiredDir = join(workspacesDir, "t_exp");
      const activeDir = join(workspacesDir, "t_act");
      const hostRepoDir = join(dir, "my-repo");
      mkdirSync(expiredDir, { recursive: true });
      mkdirSync(activeDir, { recursive: true });
      mkdirSync(hostRepoDir, { recursive: true });
      writeFileSync(join(expiredDir, "temp.txt"), "old");
      writeFileSync(join(activeDir, "work.txt"), "live");
      writeFileSync(join(hostRepoDir, "README.md"), "repo");

      repo.createTicket({
        id: "t_exp",
        canonicalUserId: "u1",
        status: "done",
        backend: "builtin-pi",
        briefTitle: "expired",
        originChannel: "tg",
      });
      repo.updateTicket("t_exp", {
        workspaceExpiresAt: now - 1000,
        mandateJson: JSON.stringify({
          workspace_mode: "isolated",
          workspace_dir: expiredDir,
          is_host_repo: false,
          network: "egress",
          timeout_ms: 60000,
          skills: [],
          allowed_mcp_servers: [],
          confirm_before: [],
        }),
      });

      repo.createTicket({
        id: "t_act",
        canonicalUserId: "u1",
        status: "running",
        backend: "builtin-pi",
        briefTitle: "active",
        originChannel: "tg",
      });
      repo.updateTicket("t_act", {
        workspaceExpiresAt: now - 1000,
      });

      repo.createTicket({
        id: "t_host",
        canonicalUserId: "u1",
        status: "done",
        backend: "codex-cli",
        briefTitle: "host repo",
        originChannel: "tg",
      });
      repo.updateTicket("t_host", {
        workspaceExpiresAt: now - 1000,
        mandateJson: JSON.stringify({
          workspace_mode: "host_repo",
          workspace_dir: hostRepoDir,
          is_host_repo: true,
          network: "egress",
          timeout_ms: 60000,
          skills: [],
          allowed_mcp_servers: [],
          confirm_before: [],
        }),
      });

      const res = cleanupExpiredWorkspaces({ repo, workspacesDir, nowMs: now });
      expect(res.removedCount).toBe(1);
      expect(res.clearedCount).toBe(2);
      expect(existsSync(expiredDir)).toBe(false);
      expect(existsSync(activeDir)).toBe(true);
      expect(existsSync(hostRepoDir)).toBe(true);
      expect(repo.getTicket("t_exp")?.workspaceExpiresAt).toBeNull();
      expect(repo.getTicket("t_host")?.workspaceExpiresAt).toBeNull();

      dbHandle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleanupExpiredWorkspaces preserves expired isolated workspaces referenced by script_registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-wgc-script-"));
    try {
      const workspacesDir = join(dir, "workspaces");
      mkdirSync(workspacesDir, { recursive: true });
      const dbHandle = openDatabase(join(dir, "test.db"));
      const repo = new HatoRepository(dbHandle.db);

      const now = Date.now();
      const scriptTicketDir = join(workspacesDir, "t_script");
      mkdirSync(scriptTicketDir, { recursive: true });
      const scriptFile = join(scriptTicketDir, "job.sh");
      writeFileSync(scriptFile, "#!/bin/sh\necho ok\n");

      repo.createTicket({
        id: "t_script",
        canonicalUserId: "u1",
        status: "done",
        backend: "builtin-pi",
        briefTitle: "registered script ticket",
        originChannel: "tg",
      });
      repo.updateTicket("t_script", {
        workspaceExpiresAt: now - 1000,
        mandateJson: JSON.stringify({
          workspace_mode: "isolated",
          workspace_dir: scriptTicketDir,
          is_host_repo: false,
          network: "egress",
          timeout_ms: 60000,
          skills: [],
          allowed_mcp_servers: [],
          confirm_before: [],
        }),
      });
      repo.registerScript({
        ticketId: "t_script",
        name: "keep-alive-job",
        scriptPath: scriptFile,
        cronExpr: "0 * * * *",
        notifyChannel: "tg",
      });

      const res = cleanupExpiredWorkspaces({ repo, workspacesDir, nowMs: now });
      expect(res.removedCount).toBe(0);
      expect(res.clearedCount).toBe(0);
      expect(existsSync(scriptTicketDir)).toBe(true);
      expect(existsSync(scriptFile)).toBe(true);

      dbHandle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
