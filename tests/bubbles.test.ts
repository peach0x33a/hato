import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBubbleOutputPromptBlock,
  DEFAULT_BUBBLE_DELIMITER,
  joinPersistedBubbles,
  splitIntoBubbles,
} from "../src/persona/bubbles.js";

test("splitIntoBubbles splits explicit [SPLIT] delimiter text up to maxPerTurn", () => {
  const input = "刚忙完呀\n[SPLIT]\n今晚吃什么了\n[SPLIT]\n对了明天记得带伞\n[SPLIT]\n还有早点睡";
  const result = splitIntoBubbles(input, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: DEFAULT_BUBBLE_DELIMITER,
  });

  assert.equal(result.length, 3);
  assert.equal(result[0], "刚忙完呀");
  assert.equal(result[1], "今晚吃什么了");
  assert.equal(result[2], "对了明天记得带伞\n\n还有早点睡");
});

test("splitIntoBubbles keeps blank lines and Markdown horizontal rules in a single bubble without [SPLIT]", () => {
  const blankLineInput = [
    "原来是去上学了呀，那还真辛苦，周一从下午上到傍晚。",
    "",
    "我收回刚才那句“忙完了”，改成“放学了”更合适~",
  ].join("\n");

  assert.deepEqual(
    splitIntoBubbles(blankLineInput, {
      enabled: true,
      maxPerTurn: 3,
      delimiter: DEFAULT_BUBBLE_DELIMITER,
    }),
    [blankLineInput],
  );

  const ruleInput = "上半句\n\n---\n\n下半句";
  assert.deepEqual(
    splitIntoBubbles(ruleInput, {
      enabled: true,
      maxPerTurn: 3,
      delimiter: DEFAULT_BUBBLE_DELIMITER,
    }),
    [ruleInput],
  );
});

test("splitIntoBubbles preserves inner blank lines inside one bubble when splitting on [SPLIT]", () => {
  const input = "第一句\n\n同气泡补充\n[SPLIT]\n第二条气泡";
  const result = splitIntoBubbles(input, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: DEFAULT_BUBBLE_DELIMITER,
  });

  assert.deepEqual(result, ["第一句\n\n同气泡补充", "第二条气泡"]);
});

test("splitIntoBubbles handles inline, leading/trailing, consecutive, and pure [SPLIT] tokens", () => {
  assert.deepEqual(
    splitIntoBubbles("第一句[SPLIT]第二句", {
      enabled: true,
      maxPerTurn: 3,
      delimiter: DEFAULT_BUBBLE_DELIMITER,
    }),
    ["第一句", "第二句"],
  );

  assert.deepEqual(
    splitIntoBubbles("[SPLIT]\n第一句\n[SPLIT]\n[SPLIT]\n第二句\n[SPLIT]", {
      enabled: true,
      maxPerTurn: 3,
      delimiter: DEFAULT_BUBBLE_DELIMITER,
    }),
    ["第一句", "第二句"],
  );

  assert.deepEqual(
    splitIntoBubbles("[SPLIT]\n[SPLIT]", {
      enabled: true,
      maxPerTurn: 3,
      delimiter: DEFAULT_BUBBLE_DELIMITER,
    }),
    [],
  );
});

test("splitIntoBubbles keeps disabled, maxPerTurn=1, and structured content intact while stripping [SPLIT]", () => {
  const codeReply = "给你脚本：\n[SPLIT]\n```python\nprint('hi')\n```";
  const codeResult = splitIntoBubbles(codeReply, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: DEFAULT_BUBBLE_DELIMITER,
  });
  assert.equal(codeResult.length, 1);
  assert.ok(codeResult[0]!.includes("```python"));
  assert.ok(!codeResult[0]!.includes("[SPLIT]"));

  const listReply = "排查步骤：\n[SPLIT]\n1. 检查配置\n\n2. 重启服务";
  const listResult = splitIntoBubbles(listReply, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: DEFAULT_BUBBLE_DELIMITER,
  });
  assert.equal(listResult.length, 1);
  assert.ok(!listResult[0]!.includes("[SPLIT]"));

  const headingReply = "## 总结\n[SPLIT]\n这里是说明正文";
  assert.equal(
    splitIntoBubbles(headingReply, {
      enabled: true,
      maxPerTurn: 3,
      delimiter: DEFAULT_BUBBLE_DELIMITER,
    }).length,
    1,
  );

  const nonFirstLineHeadingReply = "先看结果：\n[SPLIT]\n## 总结\n这里是说明正文";
  const nonFirstLineHeadingResult = splitIntoBubbles(nonFirstLineHeadingReply, {
    enabled: true,
    maxPerTurn: 3,
    delimiter: DEFAULT_BUBBLE_DELIMITER,
  });
  assert.equal(nonFirstLineHeadingResult.length, 1);
  assert.ok(!nonFirstLineHeadingResult[0]!.includes("[SPLIT]"));

  const disabledResult = splitIntoBubbles("第一句\n[SPLIT]\n第二句", {
    enabled: false,
    maxPerTurn: 3,
    delimiter: DEFAULT_BUBBLE_DELIMITER,
  });
  assert.deepEqual(disabledResult, ["第一句\n\n第二句"]);
});

test("joinPersistedBubbles and splitIntoBubbles round-trip bubbles with inner blank lines", () => {
  const bubbles = ["第一句\n\n同气泡补充", "第二条气泡"];
  const persisted = joinPersistedBubbles(bubbles, {
    enabled: true,
    delimiter: DEFAULT_BUBBLE_DELIMITER,
  });
  assert.equal(persisted, "第一句\n\n同气泡补充\n\n[SPLIT]\n\n第二条气泡");
  assert.deepEqual(
    splitIntoBubbles(persisted, {
      enabled: true,
      maxPerTurn: 3,
      delimiter: DEFAULT_BUBBLE_DELIMITER,
    }),
    bubbles,
  );
});

test("splitIntoBubbles supports custom --- delimiter on standalone lines without breaking tables", () => {
  assert.deepEqual(
    splitIntoBubbles("第一条\n---\n第二条", {
      enabled: true,
      maxPerTurn: 3,
      delimiter: "---",
    }),
    ["第一条", "第二条"],
  );

  const inlineHyphens = "foo---bar";
  assert.deepEqual(
    splitIntoBubbles(inlineHyphens, {
      enabled: true,
      maxPerTurn: 3,
      delimiter: "---",
    }),
    [inlineHyphens],
  );
});

test("buildBubbleOutputPromptBlock renders active delimiter examples or single-bubble guidance", () => {
  const multiBlock = buildBubbleOutputPromptBlock({
    enabled: true,
    maxPerTurn: 3,
    delimiter: "[SPLIT]",
  });
  assert.ok(multiBlock.includes("Active Delimiter: `[SPLIT]`"));
  assert.ok(multiBlock.includes("at most 3 bubbles per turn"));
  assert.ok(multiBlock.includes("深表赞同，围巾就是冬季性价比最高的萌系装备了\n  [SPLIT]\n  尤其把半张脸埋进去只露眼睛那一下"));

  const customBlock = buildBubbleOutputPromptBlock({
    enabled: true,
    maxPerTurn: 0,
    delimiter: "[BUBBLE]",
  });
  assert.ok(customBlock.includes("Active Delimiter: `[BUBBLE]`"));
  assert.ok(!customBlock.includes("at most"));

  const disabledBlock = buildBubbleOutputPromptBlock({
    enabled: false,
    maxPerTurn: 3,
    delimiter: "[SPLIT]",
  });
  assert.ok(disabledBlock.includes("Single-Bubble Mode"));
  assert.ok(disabledBlock.includes("do **NOT** output `[SPLIT]`"));

  const singleTurnBlock = buildBubbleOutputPromptBlock({
    enabled: true,
    maxPerTurn: 1,
    delimiter: "[SPLIT]",
  });
  assert.ok(singleTurnBlock.includes("Single-Bubble Mode"));
});
