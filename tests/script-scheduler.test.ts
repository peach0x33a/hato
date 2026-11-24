import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import {
  buildSanitizedScriptEnv,
  isValidCronExpression,
  matchesCronExpression,
  ScriptScheduler,
} from "../src/dispatch/script-scheduler.js";
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

  test("isValidCronExpression validates 5-field cron syntax and bounds", () => {
    expect(isValidCronExpression("*/5 * * * *")).toBe(true);
    expect(isValidCronExpression("0 9 * * 1-5")).toBe(true);
    expect(isValidCronExpression("1,15,30 0-23/2 1-31 1-12 0-7")).toBe(true);

    expect(isValidCronExpression("* * * *")).toBe(false);
    expect(isValidCronExpression("60 * * * *")).toBe(false);
    expect(isValidCronExpression("* 24 * * *")).toBe(false);
    expect(isValidCronExpression("* * 0 * *")).toBe(false);
    expect(isValidCronExpression("* * * 13 *")).toBe(false);
    expect(isValidCronExpression("5-2 * * * *")).toBe(false);
    expect(isValidCronExpression("*/0 * * * *")).toBe(false);
  });

  test("buildSanitizedScriptEnv blocks dangerous loader keys and blockedSecrets", () => {
    const env = buildSanitizedScriptEnv(
      ["RSS_API_KEY", "TG_BOT_TOKEN", "LD_PRELOAD", "NODE_OPTIONS", "HATO_HOME"],
      {
        PATH: "/usr/bin",
        RSS_API_KEY: "rss-secret",
        TG_BOT_TOKEN: "tg-secret",
        LD_PRELOAD: "/tmp/evil.so",
        NODE_OPTIONS: "--require /tmp/evil.js",
        HATO_HOME: "/tmp/hato",
      },
      new Set(["TG_BOT_TOKEN"]),
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.RSS_API_KEY).toBe("rss-secret");
    expect(env.TG_BOT_TOKEN).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.HATO_HOME).toBeUndefined();
  });

  test("ScriptScheduler catches up missed minutes and deduplicates same-minute restarts via job_runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-sched-catchup-"));
    try {
      const dbHandle = openDatabase(join(dir, "test.db"));
      const repo = new HatoRepository(dbHandle.db);
      const cfg = createDefaultHatoConfig(dir);
      cfg.owner.timezone = "Asia/Singapore";

      const registered = repo.registerScript({
        ticketId: "t_catchup",
        name: "catchup-job",
        scriptPath: join(dir, "job.sh"),
        cronExpr: "*/1 * * * *",
        notifyChannel: "tg",
      });

      const scheduler1 = new ScriptScheduler({
        getHatoConfig: () => cfg,
        repo,
        runScript: async () => ({ exitCode: 0, stdoutTail: "", stderrTail: "" }),
      });

      const t0 = parseLocalDateTimeToEpochMs("2026-11-21 10:00", "Asia/Singapore")!;
      await scheduler1.tick(t0);
      expect(repo.listJobRuns(registered.id, 10)).toHaveLength(1);

      // Jump forward 3 minutes: should catch up 10:01, 10:02, and 10:03
      await scheduler1.tick(t0 + 3 * 60_000);
      expect(repo.listJobRuns(registered.id, 10)).toHaveLength(4);

      // Simulate process restart in the same minute (10:03): should not re-run
      const scheduler2 = new ScriptScheduler({
        getHatoConfig: () => cfg,
        repo,
        runScript: async () => ({ exitCode: 0, stdoutTail: "", stderrTail: "" }),
      });
      await scheduler2.tick(t0 + 3 * 60_000 + 20_000);
      expect(repo.listJobRuns(registered.id, 10)).toHaveLength(4);

      dbHandle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
