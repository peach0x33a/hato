import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { BrowserRuntime } from "../browser/runtime.js";
import { resolveTavilySearchConfig, resolveWebFetchConfig, type HatoConfig } from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type { HatoRepository } from "../db/repo.js";
import {
  evaluateSafeMath,
  runDateMath,
  runInspectTickets,
  runListSchedules,
} from "./microtools-core.js";
import { runWebFetch } from "./web-fetch.js";
import { runTavilySearch } from "./web-search.js";

const CalcParams = obj({
  expression: str({
    description: "Arithmetic expression, e.g. '(356 * 24) / 12' or 'round(sqrt(10), 0)'",
  }),
});

const DateMathParams = obj({
  action: oneOf(["add_days", "diff_days", "weekday", "convert_timezone"]),
  date: opt(str({ description: "Base date YYYY-MM-DD in target timezone" })),
  target_date: opt(str({ description: "Target date YYYY-MM-DD for diff_days" })),
  days: opt(num({ description: "Days delta for add_days (can be negative)" })),
  timezone: opt(str({ description: "IANA timezone, defaults to owner timezone" })),
  target_timezone: opt(str({ description: "Target IANA timezone for convert_timezone" })),
  iso_timestamp: opt(str({ description: "ISO timestamp for convert_timezone" })),
});

const InspectTicketsParams = obj({
  ticket_id: opt(str({ description: "Optional specific ticket ID like t_0042" })),
});

const ListSchedulesParams = obj({});

const WebSearchParams = obj({
  query: str({ description: "Search query keywords or question for Tavily web search" }),
  topic: opt(oneOf(["general", "news", "finance"])),
  search_depth: opt(oneOf(["basic", "advanced"])),
  max_results: opt(num({ description: "Maximum results to return (1-20), defaults to config" })),
  time_range: opt(oneOf(["day", "week", "month", "year"])),
  include_domains: opt(arr(str())),
  exclude_domains: opt(arr(str())),
});

const WebFetchParams = obj({
  url: str({ description: "HTTP/HTTPS URL to fetch readable text from" }),
  max_chars: opt(num({ description: "Optional max text length (500-50000)" })),
});

const BrowserTaskParams = obj({
  goal: str({ description: "Clear task objective for the isolated browser worker to execute" }),
  start_url: opt(str({ description: "Optional initial HTTP/HTTPS URL to open" })),
  resume: opt(bool({ description: "Set true when continuing after user takeover/login/captcha" })),
});

/**
 * Zero-side-effect, read-only micro-tools + isolated web/browser capabilities exposed to Persona.
 */
export function createPersonaReadOnlyTools(params: {
  repo: HatoRepository;
  canonicalUserId: string;
  getTimezone: () => string;
  getHatoConfig: () => HatoConfig;
  proxyRouter: ScopedProxyRouter;
  browserRuntime?: BrowserRuntime;
}): AgentTool<any>[] {
  const calcTool: AgentTool<typeof CalcParams> = {
    name: "calc",
    label: "数学计算",
    description: "安全计算四则运算、幂运算与基础数学函数，避免口算误差。",
    parameters: CalcParams,
    async execute(_toolCallId, input) {
      const value = evaluateSafeMath(input.expression);
      return {
        content: [{ type: "text", text: `${input.expression} = ${value}` }],
        details: { value },
      };
    },
  };

  const dateMathTool: AgentTool<typeof DateMathParams> = {
    name: "date_math",
    label: "日期时间换算",
    description: "精准计算星期几、日期加减、相差天数及跨时区时间转换。",
    parameters: DateMathParams,
    async execute(_toolCallId, input) {
      const text = runDateMath(input, Date.now(), params.getTimezone());
      return {
        content: [{ type: "text", text }],
        details: { text },
      };
    },
  };

  const inspectTicketsTool: AgentTool<typeof InspectTicketsParams> = {
    name: "inspect_tickets",
    label: "查看工单状态",
    description:
      "只读查询当前或历史后台工单详情。仅在用户主动问及工单/任务进展时调用；日常闲聊不要主动提及或推荐此工具。",
    parameters: InspectTicketsParams,
    async execute(_toolCallId, input) {
      const text = runInspectTickets(params.repo, params.canonicalUserId, input.ticket_id);
      return {
        content: [{ type: "text", text }],
        details: { text },
      };
    },
  };

  const listSchedulesTool: AgentTool<typeof ListSchedulesParams> = {
    name: "list_schedules",
    label: "查看定时任务",
    description:
      "只读列出已登记的定时任务与提醒事项。仅在用户主动问及日程/定时/提醒时调用；日常闲聊不要主动提及或推荐此工具。",
    parameters: ListSchedulesParams,
    async execute() {
      const text = runListSchedules(params.repo, params.canonicalUserId, params.getTimezone());
      return {
        content: [{ type: "text", text }],
        details: { text },
      };
    },
  };

  const webSearchTool: AgentTool<typeof WebSearchParams> = {
    name: "web_search",
    label: "联网搜索",
    description:
      "使用 Tavily 进行实时联网搜索，查找最新消息、事实资料、技术文档或即时信息。仅当需要外部/实时事实或核对资料时调用；日常闲聊不要主动推销此工具。",
    parameters: WebSearchParams,
    async execute(_toolCallId, input, signal) {
      const searchConfig = resolveTavilySearchConfig(params.getHatoConfig());
      const out = await runTavilySearch({
        config: searchConfig,
        proxyRouter: params.proxyRouter,
        input: {
          query: input.query,
          topic: input.topic,
          searchDepth: input.search_depth,
          maxResults: input.max_results,
          timeRange: input.time_range,
          includeDomains: input.include_domains,
          excludeDomains: input.exclude_domains,
        },
        signal,
      });
      return {
        content: [{ type: "text", text: out.formattedText }],
        details: {
          ok: out.ok,
          resultCount: out.results.length,
          error: out.error,
        },
      };
    },
  };

  const webFetchTool: AgentTool<typeof WebFetchParams> = {
    name: "web_fetch",
    label: "抓取网页正文",
    description:
      "轻量直读指定 HTTP/HTTPS 网址的文本或正文内容（不启动浏览器）。读取文章/文档链接时优先使用；若页面依赖 JS 渲染、需要登录或点击交互，再改用 browser_task。",
    parameters: WebFetchParams,
    async execute(_toolCallId, input, signal) {
      const fetchConfig = resolveWebFetchConfig(params.getHatoConfig());
      const out = await runWebFetch({
        config: fetchConfig,
        proxyRouter: params.proxyRouter,
        input: {
          url: input.url,
          maxChars: input.max_chars,
        },
        signal,
      });
      return {
        content: [{ type: "text", text: out.text }],
        details: {
          ok: out.ok,
          finalUrl: out.finalUrl,
          error: out.error,
        },
      };
    },
  };

  const tools: AgentTool<any>[] = [
    calcTool,
    dateMathTool,
    inspectTicketsTool,
    listSchedulesTool,
    webSearchTool,
    webFetchTool,
  ];

  if (params.browserRuntime) {
    const runtime = params.browserRuntime;
    const browserTaskTool: AgentTool<typeof BrowserTaskParams> = {
      name: "browser_task",
      label: "浏览器任务",
      description:
        "派发独立隔离的浏览器执行器打开有头浏览器完成 JS 页面阅读、点击输入交互、截图或人工接管流程。当返回 status=needs_takeover 时，说明截图已发给用户等待操作；用户完成后再用 resume=true 继续。",
      parameters: BrowserTaskParams,
      async execute(_toolCallId, input) {
        const out = await runtime.runTask({
          goal: input.goal,
          startUrl: input.start_url,
          resume: input.resume,
        });
        return {
          content: [{ type: "text", text: out.formattedText }],
          details: {
            status: out.status,
            currentUrl: out.currentUrl,
            sentScreenshot: out.sentScreenshot,
          },
        };
      },
    };
    tools.push(browserTaskTool);
  }

  return tools;
}
