import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, obj, str } from "@earendil-works/pi-schema";

export const ACTIVATE_TOOLS_NAME = "activate_tools";

export type ToolDomainId = "memory" | "math_time" | "web" | "media" | "ops";

export interface ToolDisclosureContext {
  userText: string;
  hasImages?: boolean;
  hasAttachments?: boolean;
  hasPersonalSkills?: boolean;
}

export interface ToolDomainPack {
  id: ToolDomainId;
  tools: readonly string[];
  matches: (ctx: ToolDisclosureContext) => boolean;
}

export const TOOL_DOMAIN_PACKS: readonly ToolDomainPack[] = [
  {
    id: "memory",
    tools: ["recall_memory", "search_past_sessions"],
    matches: ({ userText }) =>
      /记得|记忆|回忆|喜好|偏好|以前|之前说过|我喜欢|我不喜欢|我用什么|忌口|习惯|上次|上个会话|之前聊|历史对话|聊天记录|前几天|那次|翻一下|会话|\brecall\b|\bmemory\b|\bpast\b|\bsession\b/i.test(
        userText,
      ),
  },
  {
    id: "math_time",
    tools: ["calc", "date_math"],
    matches: ({ userText }) =>
      /\d+\s*[+\-*/^%()]\s*\d+|计算|算一下|算下|等于几|等于多少|平方|开方|汇率|百分比|乘法|除法|加法|减法|乘以|除以|加上|减去|\bcalc\b|\b\d{4}-\d{1,2}-\d{1,2}\b|几天|星期|周几|礼拜|时区|几点|日期|明天|后天|大后天|昨天|前天|下周|上周|下个月|上个月|倒计时|\bdate\b|\btimezone\b/i.test(
        userText,
      ),
  },
  {
    id: "web",
    tools: ["web_search", "web_fetch", "browser_task"],
    matches: ({ userText }) =>
      /https?:\/\/|搜|查一下|查询|最新|新闻|天气|价格|官网|怎么|什么是|百科|教程|攻略|网页|链接|文章|原文|网址|浏览器|截图|截屏|打开网页|登录|验证码|点击|网页交互|\bsearch\b|\blookup\b|\bfetch\b|\burl\b|\bbrowser\b|\bscreenshot\b/i.test(
        userText,
      ),
  },
  {
    id: "media",
    tools: [
      "image_gen",
      "render_markdown_image",
      "sticker_search",
      "send_sticker",
      "sticker_save",
      "sticker_collect",
      "send_file",
      "send_message",
    ],
    matches: ({ userText, hasImages, hasAttachments }) =>
      Boolean(hasImages || hasAttachments) ||
      /画|画画|画一|画张|绘制|绘图|生图|出图|配图|插画|自拍|照片|改图|图生图|\bdraw\b|\bpaint\b|渲染|生成图片|转图片|长图|卡片|表格|markdown|\brender\b|\bimage\b|表情|贴纸|斗图|梗图|表情包|保存表情|收图|批量.*表情|\bsticker\b|\bemoji\b|发给我|发文件|导出|下载|附件|传给我|发到|发给|qq|telegram|tg|转发|通知|\bsend_file\b|\bfile\b/i.test(
        userText,
      ),
  },
  {
    id: "ops",
    tools: [
      "delegate",
      "inspect_tickets",
      "read_artifact",
      "list_schedules",
      "schedule_care",
      "set_schedule_override",
      "self_config",
      "bot_profile",
    ],
    matches: ({ userText }) =>
      /写代码|写个|编写|脚本|代码|运行|执行|修改文件|改一下|重构|修\s*bug|部署|定时|提醒|每天|每周|cron|schedule|delegate|python|bash|shell|\.py\b|\.ts\b|\.js\b|\.sh\b|ip地址|\bip\b|本机|服务器|主机|端口|进程|磁盘|内存|\bcpu\b|内置\s*pi|builtin-pi|命令行|终端|\bcli\b|\bssh\b|工单|任务|进度|状态|日志|后台|执行详情|\bticket\b|\bt_\d+\b|日程|闹钟|周期|人设|设定|性格|提示词|配置|模型|切换模型|代理|气泡|安静时间|少用|多用|语气|\bsoul\b|\bconfig\b|\bmodel\b|\bproxy\b|头像|昵称|名字|简介|资料|机器人资料|\bbot\b|\bprofile\b|\bavatar\b/i.test(
        userText,
      ),
  },
];

const DOMAIN_PACK_BY_ID = new Map<string, readonly string[]>(
  TOOL_DOMAIN_PACKS.map((pack) => [pack.id, pack.tools]),
);

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
 * Select domain-grouped tools relevant to the current turn, always keeping `activate_tools`.
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

  const unlockedToolNames = new Set<string>([ACTIVATE_TOOLS_NAME]);
  if (params.previouslyActivated) {
    for (const name of params.previouslyActivated) {
      unlockedToolNames.add(name);
    }
  }

  for (const pack of TOOL_DOMAIN_PACKS) {
    if (pack.matches(ctx)) {
      for (const toolName of pack.tools) {
        unlockedToolNames.add(toolName);
      }
    }
  }

  if (ctx.hasPersonalSkills || /skill|技能|手册|规范/i.test(ctx.userText)) {
    unlockedToolNames.add("read_skill");
  }

  const selected: AgentTool<any>[] = [];
  for (const tool of params.allTools) {
    if (unlockedToolNames.has(tool.name)) {
      selected.push(tool);
      continue;
    }
    if (tool.name.startsWith("mcp__") && matchesMcpTool(tool, ctx.userText)) {
      selected.push(tool);
    }
  }

  return sortToolsCanonically(selected);
}

const ActivateToolsParams = obj({
  tools: arr(
    str({
      description:
        "Tool names from <available_tools> (or domain pack ids: memory, math_time, web, media, ops) to activate",
    }),
  ),
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
      "Activate one or more tools listed in `<available_tools>` (or a domain pack id) when needed for the current turn so they become immediately callable on the next step.",
    parameters: ActivateToolsParams,
    async execute(_toolCallId, input) {
      const rawRequested = Array.from(
        new Set((input.tools ?? []).map((n) => n.trim()).filter(Boolean)),
      );
      if (rawRequested.length === 0) {
        return {
          content: [{ type: "text", text: "Provide at least one tool name or domain pack id to activate." }],
          details: { activated: [], notFound: [] },
        };
      }

      const expandedNames: string[] = [];
      for (const item of rawRequested) {
        const packTools = DOMAIN_PACK_BY_ID.get(item);
        if (packTools) {
          expandedNames.push(...packTools);
        } else {
          expandedNames.push(item);
        }
      }

      const catalog = new Map(params.getAllTools().map((t) => [t.name, t]));
      const active = [...params.getActiveTools()];
      const activeNames = new Set(active.map((t) => t.name));

      const activated: string[] = [];
      const alreadyActive: string[] = [];
      const notFound: string[] = [];

      for (const name of Array.from(new Set(expandedNames))) {
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
    "Tools are disclosed on demand by domain pack. Invoke only when needed; if a required tool is not yet loaded, call `activate_tools({ tools: [\"name\"] })` first:",
    ...lines,
    "</available_tools>",
  ].join("\n");
}
