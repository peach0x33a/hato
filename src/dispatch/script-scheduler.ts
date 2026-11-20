import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname } from "node:path";
import { promisify } from "node:util";
import type { HatoConfig } from "../config/app.js";
import type { HatoRepository } from "../db/repo.js";
import { formatLocalDateTime } from "../time/clock.js";
import { logWarn, summarizeError } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const WEEKDAY_INDEX: Record<string, number> = {
  周日: 0,
  周一: 1,
  周二: 2,
  周三: 3,
  周四: 4,
  周五: 5,
  周六: 6,
};

function matchCronField(field: string, value: number, min: number, max: number): boolean {
  const parts = field.split(",");
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    const [rangePart, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step <= 0) continue;

    if (rangePart === "*") {
      if ((value - min) % step === 0) return true;
      continue;
    }

    if (rangePart!.includes("-")) {
      const [startStr, endStr] = rangePart!.split("-");
      const start = Number(startStr);
      const end = Number(endStr);
      if (Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end) {
        if ((value - start) % step === 0) return true;
      }
      continue;
    }

    const exact = Number(rangePart);
    if (Number.isInteger(exact)) {
      const normalizedExact = max === 7 && exact === 7 ? 0 : exact;
      if (value === normalizedExact) return true;
    }
  }
  return false;
}

/**
 * Evaluates a standard 5-field cron expression (`min hour dom month dow`)
 * in the target IANA timezone.
 */
export function matchesCronExpression(expr: string, epochMs: number, timeZone: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];

  const local = formatLocalDateTime(epochMs, timeZone);
  const dow = WEEKDAY_INDEX[local.weekdayZh] ?? 0;

  return (
    matchCronField(minF, local.minute, 0, 59) &&
    matchCronField(hourF, local.hour, 0, 23) &&
    matchCronField(domF, local.day, 1, 31) &&
    matchCronField(monF, local.month, 1, 12) &&
    matchCronField(dowF, dow, 0, 7)
  );
}

export interface ScriptExecutionResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface ScriptSchedulerDeps {
  getHatoConfig: () => HatoConfig;
  repo: HatoRepository;
  runScript?: (scriptPath: string) => Promise<ScriptExecutionResult>;
  onScriptOutput?: (params: {
    scriptId: string;
    name: string;
    notifyChannel: string;
    exitCode: number;
    stdoutTail: string;
    stderrTail: string;
  }) => Promise<void>;
}

/**
 * Periodically evaluates enabled entries in `script_registry`, executes due scripts,
 * records `job_runs`, and emits notifications on output or failure.
 */
export class ScriptScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly lastMinuteByScript = new Map<string, string>();

  constructor(private readonly deps: ScriptSchedulerDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        logWarn("SCRIPT", `tick failed: ${summarizeError(err)}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(nowMs = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cfg = this.deps.getHatoConfig();
      const tz = cfg.owner.timezone;
      const local = formatLocalDateTime(nowMs, tz);
      const minuteKey = `${local.isoDate} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;

      const scripts = this.deps.repo.listEnabledScripts(50);
      for (const script of scripts) {
        if (this.lastMinuteByScript.get(script.id) === minuteKey) continue;
        if (!matchesCronExpression(script.cronExpr, nowMs, tz)) continue;

        this.lastMinuteByScript.set(script.id, minuteKey);

        const execResult = this.deps.runScript
          ? await this.deps.runScript(script.scriptPath)
          : await defaultExecuteScript(script.scriptPath);

        this.deps.repo.recordScriptRun({
          scriptId: script.id,
          exitCode: execResult.exitCode,
          stdoutTail: execResult.stdoutTail,
          stderrTail: execResult.stderrTail,
          ranAt: nowMs,
        });

        if (this.deps.onScriptOutput && (execResult.exitCode !== 0 || execResult.stdoutTail.trim())) {
          await this.deps.onScriptOutput({
            scriptId: script.id,
            name: script.name,
            notifyChannel: script.notifyChannel,
            exitCode: execResult.exitCode,
            stdoutTail: execResult.stdoutTail,
            stderrTail: execResult.stderrTail,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}

async function defaultExecuteScript(scriptPath: string): Promise<ScriptExecutionResult> {
  if (!existsSync(scriptPath)) {
    return {
      exitCode: 127,
      stdoutTail: "",
      stderrTail: `Script not found: ${scriptPath}`,
    };
  }
  const ext = extname(scriptPath).toLowerCase();
  let cmd = scriptPath;
  let args: string[] = [];
  if (ext === ".py") {
    cmd = "python3";
    args = [scriptPath];
  } else if (ext === ".sh") {
    cmd = "bash";
    args = [scriptPath];
  } else if (ext === ".ts" || ext === ".js" || ext === ".mjs") {
    cmd = "bun";
    args = [scriptPath];
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: dirname(scriptPath),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdoutTail: String(stdout ?? "").slice(-2000),
      stderrTail: String(stderr ?? "").slice(-2000),
    };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdoutTail: String(e.stdout ?? "").slice(-2000),
      stderrTail: (String(e.stderr ?? "") || e.message || "execution failed").slice(-2000),
    };
  }
}
