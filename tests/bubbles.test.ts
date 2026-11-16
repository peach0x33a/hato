import assert from "node:assert/strict";
import test from "node:test";
import { splitIntoBubbles } from "../src/persona/bubbles.js";

test("splitIntoBubbles splits explicit delimiter text up to maxPerTurn", () => {
  const input = "刚忙完呀\n---\n今晚吃什么了\n---\n对了明天记得带伞\n---\n还有早点睡";
  const result = splitIntoBubbles(input, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: "\n---\n",
  });

  assert.equal(result.length, 3);
  assert.equal(result[0], "刚忙完呀");
  assert.equal(result[1], "今晚吃什么了");
  assert.equal(result[2], "对了明天记得带伞\n\n还有早点睡");
});

test("splitIntoBubbles splits multi-paragraph casual replies separated by blank lines", () => {
  const input = [
    "原来是去上学了呀，那还真辛苦，周一从下午上到傍晚。",
    "",
    "我收回刚才那句“忙完了”，改成“放学了”更合适~",
  ].join("\n");

  const result = splitIntoBubbles(input, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: "---",
  });

  assert.deepEqual(result, [
    "原来是去上学了呀，那还真辛苦，周一从下午上到傍晚。",
    "我收回刚才那句“忙完了”，改成“放学了”更合适~",
  ]);
});

test("splitIntoBubbles lets explicit delimiter preserve inner blank lines inside one bubble", () => {
  const input = "第一句\n\n同气泡补充\n---\n第二条气泡";
  const result = splitIntoBubbles(input, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: "---",
  });

  assert.deepEqual(result, ["第一句\n\n同气泡补充", "第二条气泡"]);
});

test("splitIntoBubbles keeps code blocks, headings, and numbered lists intact in a single bubble", () => {
  const codeReply = "给你脚本：\n---\n```python\nprint('hi')\n```";
  const codeResult = splitIntoBubbles(codeReply, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: "\n---\n",
  });
  assert.equal(codeResult.length, 1);
  assert.ok(codeResult[0]!.includes("```python"));
  assert.ok(!codeResult[0]!.includes("\n---\n"));

  const listReply = "排查步骤：\n\n1. 检查配置\n\n2. 重启服务";
  const listResult = splitIntoBubbles(listReply, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: "---",
  });
  assert.equal(listResult.length, 1);

  const headingReply = "## 总结\n\n这里是说明正文";
  const headingResult = splitIntoBubbles(headingReply, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: "---",
  });
  assert.equal(headingResult.length, 1);
});
