import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { matchesCronExpression, ScriptScheduler } from "../src/dispatch/script-scheduler.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { parseLocalDateTimeToEpochMs } from "../src/time/clock.js";

describe("script-scheduler", () => {
  test("matchesCronExpression evaluates 5-field cron expressions in target timezone", () => {
    // 2026-11-21 09:30 Asia/Singapore (Saturday = 6)
    const ts = parseLocalDateTimeToEpochMs("2026-11-21 09:30", "Asia/Singapore")!;
    expect(matchesCronExpression("30 9 * * *", ts, "Asia/Singapore")).toBe(true);
    expect(matchesCronExpression("*/15 9 * * 6", ts, "Asia/Singapore")).toBe(true);
    expect(matchesCronExpression("0 9 * * *", ts, "Asia/Singapore")).toBe(false);
    expect(matchesCronExpression("30 9 * * 1-5", ts, "Asia/Singapore")).toBe(false);
  });

  test("ScriptScheduler executes due scripts, records job_runs, and auto-disables after 5 failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-script-"));
    try {
      const dbHandle = openDatabase(join(dir, "test.db"));
      const repo = new HatoRepository(dbHandle.db);
      const cfg = createDefaultHatoConfig();
      cfg.owner.timezone = "Asia/Singapore";

      const registered = repo.registerScript({
        ticketId: "t_1",
        name: "daily-check",
        scriptPath: "/tmp/check.sh",
        cronExpr: "30 9 * * *",
        notifyChannel: "tg",
      });

      const notices: string[] = [];
      let nextExit = 0;
      const scheduler = new ScriptScheduler({
        getHatoConfig: () => cfg,
        repo,
        runScript: async () => ({
          exitCode: nextExit,
          stdoutTail: nextExit === 0 ? "all good" : "",
          stderrTail: nextExit === 0 ? "" : "boom",
        }),
        onScriptOutput: async ({ name, exitCode, stdoutTail }) => {
          notices.push(`${name}:${exitCode}:${stdoutTail}`);
        },
      });

      const ts = parseLocalDateTimeToEpochMs("2026-11-21 09:30", "Asia/Singapore")!;
      await scheduler.tick(ts);
      // Same minute deduplicated
      await scheduler.tick(ts + 10_000);

      expect(notices).toEqual(["daily-check:0:all good"]);
      expect(repo.listJobRuns(registered.id)).toHaveLength(1);

      // 5 consecutive failures auto-disable script
      nextExit = 1;
      for (let i = 1; i <= 5; i++) {
        await scheduler.tick(ts + i * 24 * 3600 * 1000);
      }
      const afterFail = repo.listScripts(10).find((s) => s.id === registered.id)!;
      expect(afterFail.consecutiveFailures).toBe(5);
      expect(afterFail.enabled).toBe(false);

      dbHandle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
