import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSafeMath, runDateMath } from "../src/persona/microtools-core.js";

test("evaluateSafeMath computes expressions safely without eval", () => {
  assert.equal(evaluateSafeMath("356 * 24"), 8544);
  assert.equal(evaluateSafeMath("(10 + 2.5) * 2 ^ 3 - 5"), 95);
  assert.equal(evaluateSafeMath("round(sqrt(10), 0)"), 3);
  assert.throws(() => evaluateSafeMath("process.exit(1)"));
  assert.throws(() => evaluateSafeMath("1 / 0"));
});

test("runDateMath computes deterministic weekdays and day diffs", () => {
  const now = Date.parse("2026-11-16T04:00:00Z");
  assert.equal(runDateMath({ action: "weekday", date: "2026-11-25" }, now, "Asia/Shanghai"), "2026-11-25 是 周三");
  assert.equal(runDateMath({ action: "add_days", date: "2026-11-16", days: 9 }, now, "Asia/Shanghai"), "2026-11-16 + (9) 天 = 2026-11-25 (周三)");
  assert.equal(runDateMath({ action: "diff_days", date: "2026-11-16", target_date: "2026-11-28" }, now, "Asia/Shanghai"), "相距 12 天（目标 2026-11-28）");
});
