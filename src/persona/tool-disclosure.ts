import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, obj, str } from "@earendil-works/pi-schema";

export const ACTIVATE_TOOLS_NAME = "activate_tools";

export interface ToolDisclosureContext {
  userText: string;
  hasImages?: boolean;
  hasAttachments?: boolean;
  hasPersonalSkills?: boolean;
}

type ToolPredicate = (ctx: ToolDisclosureContext) => boolean;

const BUILTIN_TOOL_RULES: Record<string, ToolPredicate> = {
  calc: ({ userText }) =>
    /\d+\s*[+\-*/^%()]\s*\d+|计算|算一下|算下|等于几|等于多少|平方|开方|汇率|百分比|乘法|除法|加法|减法|乘以|除以|加上|减去|\bcalc\b/i.test(
      userText,
    ),
  date_math: ({ userText }) =>
    /\b\d{4}-\d{1,2}-\d{1,2}\b|几天|星期|周几|礼拜|时区|几点|日期|明天|后天|大后天|昨天|前天|下周|上周|下个月|上个月|倒计时|\bdate\b|\btimezone\b/i.test(
      userText,
    ),
  web_search: ({ userText }) =>
    /搜|查一下|查询|最新|新闻|天气|价格|官网|怎么|什么是|百科|教程|攻略|\bsearch\b|\blookup\b/i.test(
      userText,
    ),
  web_fetch: ({ userText }) =>
    /https?:\/\/|网页|链接|文章|原文|网址|\bfetch\b|\burl\b/i.test(userText),
  browser_task: ({ userText }) =>
    /https?:\/\/|浏览器|截图|截屏|打开网页|登录|验证码|点击|网页交互|\bbrowser\b|\bscreenshot\b/i.test(
      userText,
    ),
  recall_memory: ({ userText }) =>
    /记得|记忆|回忆|喜好|偏好|以前|之前说过|我喜欢|我不喜欢|我用什么|忌口|习惯|\brecall\b|\bmemory\b/i.test(
      userText,
    ),
  search_past_sessions: ({ userText }) =>
    /上次|上个会话|之前聊|历史对话|聊天记录|前几天|那次|翻一下|会话|\bpast\b|\bsession\b/i.test(
      userText,
    ),
  delegate: ({ userText }) =>
    /写代码|写个|编写|脚本|代码|运行|执行|修改文件|改一下|重构|修\s*bug|部署|定时|提醒|每天|每周|cron|schedule|delegate|python|bash|shell|\.py\b|\.ts\b|\.js\b|\.sh\b/i.test(
      userText,
    ),
  inspect_tickets: ({ userText }) =>
    /工单|任务|进度|状态|日志|后台|执行详情|\bticket\b|\bt_\d+\b/i.test(userText),
  list_schedules: ({ userText }) =>
    /定时|日程|闹钟|提醒|周期|\bschedule\b|\bcron\b/i.test(userText),
  self_config: ({ userText }) =>
    /人设|设定|性格|提示词|配置|模型|切换模型|代理|气泡|安静时间|少用|多用|语气|\bsoul\b|\bconfig\b|\bmodel\b|\bproxy\b/i.test(
      userText,
    ),
  read_skill: ({ userText, hasPersonalSkills }) =>
    Boolean(hasPersonalSkills) || /skill|技能|手册|规范/i.test(userText),
  send_file: ({ userText }) =>
    /发给我|发文件|导出|下载|附件|传给我|\bsend_file\b|\bfile\b/i.test(userText),
  send_message: ({ userText }) =>
    /发到|发给|qq|telegram|tg|转发|通知/i.test(userText),
  sticker_search: ({ userText, hasImages, hasAttachments }) =>
    Boolean(hasImages || hasAttachments) ||
    /表情|贴纸|斗图|梗图|表情包|\bsticker\b|\bemoji\b/i.test(userText),
  send_sticker: ({ userText, hasImages, hasAttachments }) =>
    Boolean(hasImages || hasAttachments) ||
    /表情|贴纸|斗图|梗图|表情包|\bsticker\b|\bemoji\b/i.test(userText),
  sticker_save: ({ userText, hasImages, hasAttachments }) =>
    Boolean(hasImages || hasAttachments) ||
    /保存表情|收图|表情包|贴纸|\bsticker\b/i.test(userText),
  sticker_collect: ({ userText, hasImages, hasAttachments }) =>
    Boolean(hasImages || hasAttachments) ||
    /收图|一堆表情|批量.*表情|表情包|\bsticker\b/i.test(userText),
  bot_profile: ({ userText }) =>
    /头像|昵称|名字|简介|资料|机器人资料|\bbot\b|\bprofile\b|\bavatar\b/i.test(userText),
  render_markdown_image: ({ userText }) =>
    /渲染|生成图片|转图片|长图|卡片|表格|markdown|\brender\b|\bimage\b/i.test(userText),
};

const MCP_ZH_ALIASES: Array<{ en: RegExp; zh: RegExp }> = [
  { en: /note|memo|diary|log/i, zh: /记|笔记|记录|备忘/ },
  { en: /search|find|query/i, zh: /搜|查/ },
  { en: /mail|email/i, zh: /邮件|邮箱/ },
  { en: /calendar|event/i, zh: /日历|日程/ },
  { en: /weather/i, zh: /天气/ },
  { en: /file|doc|read|write/i, zh: /文件|文档/ },
  { en: /github|git|repo|issue|pull/i, zh: /仓库|代码|议题/ },
];

function matchesMcpTool(tool: AgentTool<any>, userText: string): boolean {
  const lowerText = userText.toLowerCase();
  const hay = `${tool.name} ${tool.label ?? ""} ${tool.description ?? ""}`.toLowerCase();
  const tokens = hay
    .replace(/^mcp__/, "")
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length >= 3);

  for (const token of tokens) {
    if (lowerText.includes(token)) return true;
  }
  for (const alias of MCP_ZH_ALIASES) {
    if (alias.en.test(hay) && alias.zh.test(userText)) return true;
  }
  return false;
}

/**
 * Sort tools in canonical order (`activate_tools` first, then alphabetical by name)
 * to preserve KV-cache coherency across turns.
 */
export function sortToolsCanonically(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
  return [...tools].sort((a, b) => {
    if (a.name === ACTIVATE_TOOLS_NAME && b.name !== ACTIVATE_TOOLS_NAME) return -1;
    if (b.name === ACTIVATE_TOOLS_NAME && a.name !== ACTIVATE_TOOLS_NAME) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Select the subset of tools relevant to the current turn, always keeping `activate_tools`.
 */
export function selectToolsForTurn(params: {
  allTools: readonly AgentTool<any>[];
  userText: string;
  hasImages?: boolean;
  hasAttachments?: boolean;
  hasPersonalSkills?: boolean;
  previouslyActivated?: ReadonlySet<string>;
}): AgentTool<any>[] {
  const ctx: ToolDisclosureContext = {
    userText: params.userText,
    hasImages: params.hasImages,
    hasAttachments: params.hasAttachments,
    hasPersonalSkills: params.hasPersonalSkills,
  };

  const selected: AgentTool<any>[] = [];
  for (const tool of params.allTools) {
    if (tool.name === ACTIVATE_TOOLS_NAME || params.previouslyActivated?.has(tool.name)) {
      selected.push(tool);
      continue;
    }

    const rule = BUILTIN_TOOL_RULES[tool.name];
    if (rule) {
      if (rule(ctx)) selected.push(tool);
      continue;
    }

    if (tool.name.startsWith("mcp__") && matchesMcpTool(tool, params.userText)) {
      selected.push(tool);
    }
  }

  return sortToolsCanonically(selected);
}

const ActivateToolsParams = obj({
  tools: arr(str({ description: "Tool names from <available_tools> to activate for this turn" })),
});

/**
 * Create the always-available `activate_tools` meta-tool for progressive on-demand tool disclosure.
 */
export function createActivateToolsTool(params: {
  getAllTools: () => readonly AgentTool<any>[];
  getActiveTools: () => readonly AgentTool<any>[];
  setActiveTools: (nextTools: AgentTool<any>[]) => void;
  onActivated?: (names: string[]) => void;
}): AgentTool<typeof ActivateToolsParams> {
  return {
    name: ACTIVATE_TOOLS_NAME,
    label: "Activate Tools",
    description:
      "Activate one or more tools listed in `<available_tools>` when needed for the current turn so they become immediately callable on the next step.",
    parameters: ActivateToolsParams,
    async execute(_toolCallId, input) {
      const requested = Array.from(
        new Set((input.tools ?? []).map((n) => n.trim()).filter(Boolean)),
      );
      if (requested.length === 0) {
        return {
          content: [{ type: "text", text: "请提供至少一个需要激活的工具名称。" }],
          details: { activated: [], notFound: [] },
        };
      }

      const catalog = new Map(params.getAllTools().map((t) => [t.name, t]));
      const active = [...params.getActiveTools()];
      const activeNames = new Set(active.map((t) => t.name));

      const activated: string[] = [];
      const alreadyActive: string[] = [];
      const notFound: string[] = [];

      for (const name of requested) {
        const found = catalog.get(name);
        if (!found) {
          notFound.push(name);
          continue;
        }
        if (activeNames.has(name)) {
          alreadyActive.push(name);
          continue;
        }
        activeNames.add(name);
        active.push(found);
        activated.push(name);
      }

      if (activated.length > 0) {
        params.setActiveTools(sortToolsCanonically(active));
        params.onActivated?.(activated);
      }

      const parts: string[] = [];
      if (activated.length > 0) parts.push(`Activated: ${activated.join(", ")}`);
      if (alreadyActive.length > 0) parts.push(`Already active: ${alreadyActive.join(", ")}`);
      if (notFound.length > 0) {
        parts.push(
          `Unknown tool(s): ${notFound.join(", ")}. Check <available_tools> in the system prompt for exact tool names.`,
        );
      }

      return {
        content: [{ type: "text", text: parts.join("; ") || "No changes." }],
        details: { activated, alreadyActive, notFound },
      };
    },
  };
}

/**
 * Format a compact Level 1 index of all tools for Layer 1 static system prompt injection.
 */
export function buildToolIndexBlock(tools: readonly AgentTool<any>[]): string {
  const indexable = sortToolsCanonically(tools).filter((t) => t.name !== ACTIVATE_TOOLS_NAME);
  if (indexable.length === 0) return "";

  const lines = indexable.map((t) => {
    const summary = (t.description || t.label || "").replace(/\s+/g, " ").trim();
    const short = summary.length > 72 ? `${summary.slice(0, 72)}…` : summary;
    return `- ${t.name}: ${short}`;
  });

  return [
    "<available_tools>",
    "Tools are disclosed on demand. Invoke only when needed; if a required tool is not yet loaded, call `activate_tools({ tools: [\"name\"] })` first:",
    ...lines,
    "</available_tools>",
  ].join("\n");
}
