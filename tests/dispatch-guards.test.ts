import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { isNoReplyOutput } from "../src/persona/agent.js";
import { splitIntoBubbles } from "../src/persona/bubbles.js";
import { createPersonaReadOnlyTools } from "../src/persona/tools.js";

test("isNoReplyOutput matches [NO_REPLY] variants with whitespace or backticks", () => {
  assert.equal(isNoReplyOutput("[NO_REPLY]"), true);
  assert.equal(isNoReplyOutput("  `[NO_REPLY]`  "), true);
  assert.equal(isNoReplyOutput("NO_REPLY"), true);
  assert.equal(isNoReplyOutput("正常回复 [NO_REPLY]"), false);
  assert.equal(isNoReplyOutput(""), false);
});

test("inspect_tickets respects onBeforeInspectTickets guard (Option A)", async () => {
  let repoQueried = 0;
  const dispatched = new Set<string>();
  let inspectCount = 0;

  const tools = createPersonaReadOnlyTools({
    repo: {
      listTickets: () => {
        repoQueried += 1;
        return [];
      },
      getTicket: () => {
        repoQueried += 1;
        return null;
      },
    } as any,
    canonicalUserId: "owner",
    getTimezone: () => "Asia/Shanghai",
    getHatoConfig: () => createDefaultHatoConfig(),
    proxyRouter: new ScopedProxyRouter([]),
    onDelegate: () => {
      dispatched.add("t_new12345");
      return { ticketId: "t_new12345", status: "routing" };
    },
    onBeforeInspectTickets: (input) => {
      const targetId = input.ticketId?.trim();
      if (dispatched.size > 0 && (!targetId || dispatched.has(targetId))) {
        return "禁止轮询刚刚派出的异步工单";
      }
      inspectCount += 1;
      if (inspectCount > 3) {
        return "本轮查询工单次数已达上限";
      }
      return null;
    },
  });

  const delegateTool = tools.find((t) => t.name === "delegate")!;
  const inspectTool = tools.find((t) => t.name === "inspect_tickets")!;
  assert.ok(delegateTool);
  assert.ok(inspectTool);

  // 1) Existing tickets can be inspected up to 3 times
  for (let i = 0; i < 3; i++) {
    const res = await inspectTool.execute(`c_old_${i}`, {});
    assert.equal((res.details as any).blocked, undefined);
  }
  assert.equal(repoQueried, 3);

  // 4th poll for existing tickets is blocked
  const fourthRes = await inspectTool.execute("c_old_3", {});
  assert.equal((fourthRes.details as any).blocked, true);
  assert.equal(repoQueried, 3);

  // 2) Newly dispatched ticket in the same turn has 0 poll allowance
  const delRes = await delegateTool.execute("c_del", { hint: "check vps" });
  const delText = (delRes.content[0] as { text: string }).text;
  assert.match(delText, /异步/);

  const pollNewRes = await inspectTool.execute("c_poll_new", { ticket_id: "t_new12345" });
  assert.equal((pollNewRes.details as any).blocked, true);
  assert.equal(repoQueried, 3);
});

test("splitIntoBubbles supports maxPerTurn=0 (unlimited), 1 (single), and N (merge tail)", () => {
  const sample = "第一段\n[SPLIT]\n第二段\n[SPLIT]\n第三段\n[SPLIT]\n第四段\n[SPLIT]\n第五段";
  assert.deepEqual(
    splitIntoBubbles(sample, { enabled: true, maxPerTurn: 0, delimiter: "[SPLIT]" }),
    ["第一段", "第二段", "第三段", "第四段", "第五段"],
  );
  assert.deepEqual(
    splitIntoBubbles(sample, { enabled: true, maxPerTurn: 1, delimiter: "[SPLIT]" }),
    ["第一段\n\n第二段\n\n第三段\n\n第四段\n\n第五段"],
  );
  assert.deepEqual(
    splitIntoBubbles(sample, { enabled: true, maxPerTurn: 3, delimiter: "[SPLIT]" }),
    ["第一段", "第二段", "第三段\n\n第四段\n\n第五段"],
  );
});
