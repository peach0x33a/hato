import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { BrowserRuntime } from "../browser/runtime.js";
import {
  resolveMemoryRecallConfig,
  resolveSkillsDir,
  resolveTavilySearchConfig,
  resolveWebFetchConfig,
  type HatoConfig,
} from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type { HatoRepository } from "../db/repo.js";
import type { MemoryRecallItem, MemoryStore } from "../memory/store.js";
import { loadZoneSkills, readSkillContent } from "../skills/loader.js";
import { formatLocalDateTime } from "../time/clock.js";
import {
  evaluateSafeMath,
  runDateMath,
  runInspectTickets,
  runListSchedules,
} from "./microtools-core.js";
import {
  runSelfConfigAction,
  type SelfConfigAction,
  type SelfConfigDeps,
} from "./self-config.js";
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

const SearchPastSessionsParams = obj({
  query: opt(str({ description: "Optional keyword to match in archived session titles, summaries, or messages" })),
  session_id: opt(str({ description: "Optional archived session ID to read messages from" })),
  limit: opt(num({ description: "Maximum number of sessions or matching messages to return (1-30)" })),
});

const RecallMemoryParams = obj({
  query: str({ description: "Semantic query or question to recall from long-term memory" }),
  bank: opt(
    oneOf(["persona", "tech", "all"], {
      description: "Which memory bank to search: persona (life/preferences), tech (dev/env), or all",
    }),
  ),
  limit: opt(num({ description: "Maximum number of memories per bank (1-20)" })),
});

const SelfConfigParams = obj({
  action: oneOf([
    "inspect",
    "patch_hato",
    "set_model_slot",
    "edit_soul",
    "upsert_prompt_block",
    "delete_prompt_block",
    "set_relationship_fact",
    "delete_relationship_fact",
  ]),
  config_patch_json: opt(
    str({
      description:
        "JSON object string for patch_hato, e.g. '{\"gateway\":{\"debounce_ms\":2500}}' or '{\"prompts\":{\"order\":[\"soul\",\"system\",\"blocks\"]}}'",
    }),
  ),
  slot: opt(str({ description: "Model slot name for set_model_slot (persona/router/curator/worker/hindsight_llm)" })),
  target: opt(str({ description: "Qualified model target <provider>/<model_id> for set_model_slot" })),
  content: opt(str({ description: "Full text content for edit_soul or upsert_prompt_block" })),
  append_note: opt(str({ description: "Single new rule/note line to append to soul.md in edit_soul" })),
  block_name: opt(str({ description: "Block filename under blocks/ for upsert_prompt_block or delete_prompt_block (e.g. 02-rules.md)" })),
  fact_key: opt(str({ description: "Key name for set_relationship_fact or delete_relationship_fact" })),
  fact_value: opt(str({ description: "Value text for set_relationship_fact" })),
});

const ReadSkillParams = obj({
  name: str({ description: "Skill name from <available_skills> in the personal zone" }),
  reference_path: opt(
    str({ description: "Optional relative file inside that skill directory (e.g. references/guide.md)" }),
  ),
});

const DelegateParams = obj({
  hint: str({ description: "Brief anchor phrase describing what background engineering/script task is requested" }),
  urgency: opt(oneOf(["normal", "high"])),
});

/**
 * Zero-side-effect, read-only micro-tools + isolated web/browser + personal skills/MCP + guarded self-config + fast delegate() exposed to Persona.
 */
export function createPersonaReadOnlyTools(params: {
  repo: HatoRepository;
  canonicalUserId: string;
  getTimezone: () => string;
  getHatoConfig: () => HatoConfig;
  proxyRouter: ScopedProxyRouter;
  browserRuntime?: BrowserRuntime;
  getMemoryStore?: () => MemoryStore | null;
  selfConfigDeps?: SelfConfigDeps;
  enableReadSkillTool?: boolean;
  extraTools?: readonly AgentTool<any>[];
  onDelegate?: (input: { hint: string; urgency?: "normal" | "high" }) => {
    ticketId: string;
    status: string;
  };
  onMemoryRecalled?: (ids: string[]) => void;
  onBeforeToolExecute?: (toolName: string, input: unknown) => Promise<void>;
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

  const searchPastSessionsTool: AgentTool<typeof SearchPastSessionsParams> = {
    name: "search_past_sessions",
    label: "检索历史会话",
    description:
      "只读检索或查看已经被 /new 清空归档的历史会话（Session）及其对话内容。当用户提及之前清空前的讨论、往日聊天信息或要求翻看旧会话时调用；日常闲聊不要主动推销此工具。",
    parameters: SearchPastSessionsParams,
    async execute(_toolCallId, input) {
      const tz = params.getTimezone();
      const result = params.repo.searchPastSessions(params.canonicalUserId, {
        query: input.query,
        sessionId: input.session_id,
        limit: input.limit,
      });

      if (result.sessions.length === 0 && result.matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: input.session_id
                ? `未找到 ID 为 ${input.session_id} 的已归档历史会话或匹配消息。`
                : input.query
                  ? `未在已归档历史会话中找到包含 "${input.query}" 的消息或会话。`
                  : "目前尚无通过 /new 归档的历史会话记录。",
            },
          ],
          details: { sessionCount: 0, matchCount: 0 },
        };
      }

      const lines: string[] = [];
      if (result.sessions.length > 0) {
        lines.push(`【历史会话列表 (${result.sessions.length})】`);
        for (const s of result.sessions) {
          const startStr = formatLocalDateTime(s.startedAt, tz).compactStamp;
          const endStr = formatLocalDateTime(s.endedAt, tz).compactStamp;
          const summarySuffix = s.summaryText ? ` | 摘要: ${s.summaryText.slice(0, 140)}` : "";
          lines.push(
            `- [${s.id}] ${s.title} (${startStr} ~ ${endStr}, 消息 ${s.messageCount} 条)${summarySuffix}`,
          );
        }
      }

      if (result.matches.length > 0) {
        lines.push(`【匹配历史消息 (${result.matches.length})】`);
        for (const m of result.matches) {
          const stamp = formatLocalDateTime(m.createdAt, tz).compactStamp;
          const roleLabel =
            m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "事件";
          const clipped = m.content.replace(/\s+/g, " ").trim().slice(0, 260);
          lines.push(`- [${m.sessionId} · ${stamp}] ${roleLabel}: ${clipped}`);
        }
      }

      const text = lines.join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          sessionCount: result.sessions.length,
          matchCount: result.matches.length,
        },
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
    searchPastSessionsTool,
    webSearchTool,
    webFetchTool,
  ];

  if (params.getMemoryStore) {
    const getStore = params.getMemoryStore;
    const recallMemoryTool: AgentTool<typeof RecallMemoryParams> = {
      name: "recall_memory",
      label: "检索长期记忆",
      description:
        "只读检索用户的长期记忆（支持 persona 生活偏好记忆与 tech 技术环境记忆）。当需要回忆往事、个人习惯、历史约定或过往技术背景时主动调用；日常普通闲聊无需强行调用。",
      parameters: RecallMemoryParams,
      async execute(_toolCallId, input) {
        const recallCfg = resolveMemoryRecallConfig(params.getHatoConfig());
        if (recallCfg.mode === "off") {
          return {
            content: [{ type: "text", text: "长期记忆召回当前已在配置中关闭（memory.recall.mode = off）。" }],
            details: { ok: false, count: 0 },
          };
        }

        const store = getStore();
        if (!store || !store.isConfigured()) {
          return {
            content: [{ type: "text", text: "长期记忆服务当前未配置或未启用。" }],
            details: { ok: false, count: 0 },
          };
        }

        const query = input.query.trim();
        if (!query) {
          return {
            content: [{ type: "text", text: "检索问题不能为空。" }],
            details: { ok: false, count: 0 },
          };
        }

        const limit = Math.max(1, Math.min(20, Math.round(input.limit ?? recallCfg.maxResults)));
        const bankChoice = input.bank ?? "persona";
        const banks = bankChoice === "all" ? (["persona", "tech"] as const) : ([bankChoice] as const);

        const responses = await Promise.all(
          banks.map((bank) => store.recall(params.canonicalUserId, { bank, query, limit })),
        );

        const errorNotices: string[] = [];
        const recalledItems: MemoryRecallItem[] = [];
        const fallbackItems: MemoryRecallItem[] = [];
        let degraded = false;

        for (const res of responses) {
          if (res.degraded) degraded = true;
          if (!res.ok && res.errorCode) {
            errorNotices.push(`[${res.bank}] 配额受限 (${res.errorCode}): ${res.errorMessage ?? "请检查余额或地区配置"}`);
          } else if (!res.ok && res.errorMessage) {
            errorNotices.push(`[${res.bank}] 召回异常: ${res.errorMessage}`);
          }
          recalledItems.push(...res.items);
          if (res.fallbackMessages) {
            fallbackItems.push(...res.fallbackMessages);
          }
        }

        const deduped = dedupeMemoryItems(recalledItems).slice(0, limit * banks.length);
        if (deduped.length > 0) {
          params.onMemoryRecalled?.(deduped.map((i) => `${i.bank}:${i.id}`));
        }

        const lines: string[] = [];
        if (errorNotices.length > 0) {
          lines.push(`【记忆服务状态提示】\n${errorNotices.join("\n")}`);
        }
        if (deduped.length > 0) {
          lines.push(`【召回记忆 (${deduped.length})】`);
          for (const item of deduped) {
            const stamp = item.createdAt ? ` · ${item.createdAt.slice(0, 10)}` : "";
            lines.push(`- [${item.bank}:${item.id}${stamp}] ${item.content}`);
          }
        } else if (degraded && fallbackItems.length > 0) {
          lines.push("【记忆引擎处于降级模式，返回近期原始消息兜底】");
          for (const item of dedupeMemoryItems(fallbackItems).slice(0, limit)) {
            lines.push(`- [${item.bank}:fallback] ${item.content}`);
          }
        } else if (errorNotices.length === 0) {
          lines.push(`未在 ${bankChoice} 记忆库中检索到与 "${query}" 相关的长期记忆。`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            ok: errorNotices.length === 0,
            degraded,
            count: deduped.length,
            recalledIds: deduped.map((i) => `${i.bank}:${i.id}`),
          },
        };
      },
    };
    tools.push(recallMemoryTool);
  }

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

  if (params.selfConfigDeps) {
    const scDeps = params.selfConfigDeps;
    const selfConfigTool: AgentTool<typeof SelfConfigParams> = {
      name: "self_config",
      label: "自我配置管理",
      description:
        "安全查看或修改 Hato 自身的运行配置（hato.toml 白名单项、prompts.order 提示词顺序、模型槽位、人设 soul.md、自定义提示词块 blocks/*.md 与固定关系约定）。仅在用户明确要求调整配置或你的设定时调用。",
      parameters: SelfConfigParams,
      async execute(_toolCallId, input) {
        let parsedPatch: Record<string, unknown> | undefined;
        if (input.config_patch_json !== undefined) {
          try {
            const raw = JSON.parse(input.config_patch_json) as unknown;
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              return {
                content: [{ type: "text", text: "config_patch_json 必须是合法的 JSON 对象。" }],
                details: { ok: false },
              };
            }
            parsedPatch = raw as Record<string, unknown>;
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `config_patch_json JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              details: { ok: false },
            };
          }
        }

        try {
          const out = await runSelfConfigAction(scDeps, {
            action: input.action as SelfConfigAction,
            config_patch: parsedPatch,
            slot: input.slot,
            target: input.target,
            content: input.content,
            append_note: input.append_note,
            block_name: input.block_name,
            fact_key: input.fact_key,
            fact_value: input.fact_value,
          });
          return {
            content: [{ type: "text", text: out.summary }],
            details: out.details,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `自我配置执行失败: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: { ok: false },
          };
        }
      },
    };
    tools.push(selfConfigTool);
  }

  const skillsDir = resolveSkillsDir(params.getHatoConfig());
  const shouldExposeReadSkill =
    params.enableReadSkillTool ?? loadZoneSkills(skillsDir, "personal").length > 0;
  if (shouldExposeReadSkill) {
    const readSkillTool: AgentTool<typeof ReadSkillParams> = {
      name: "read_skill",
      label: "读取个人技能",
      description:
        "只读读取 personal 区某个 Skill 的完整 SKILL.md 指引或同目录下的参考文档（仅在 <available_skills> 匹配当前任务时调用）。",
      parameters: ReadSkillParams,
      async execute(_toolCallId, input) {
        try {
          const activeSkillsDir = resolveSkillsDir(params.getHatoConfig());
          const loaded = readSkillContent(
            activeSkillsDir,
            "personal",
            input.name,
            input.reference_path,
          );
          const refFooter =
            loaded.references.length > 0
              ? `\n\n[同目录参考文件]: ${loaded.references.join(", ")}`
              : "";
          return {
            content: [
              {
                type: "text",
                text: `[skill: ${loaded.name} (${loaded.filePath})]\n${loaded.content}${refFooter}`,
              },
            ],
            details: {
              ok: true,
              name: loaded.name,
              filePath: loaded.filePath,
              references: loaded.references,
              truncated: loaded.truncated,
            },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `读取 Skill 失败: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: { ok: false },
          };
        }
      },
    };
    tools.push(readSkillTool);
  }

  if (params.onDelegate) {
    const delegateFn = params.onDelegate;
    const delegateTool: AgentTool<typeof DelegateParams> = {
      name: "delegate",
      label: "派发后台任务",
      description:
        "快速将写代码、改仓库、跑脚本、修改定时任务或需要使用 Worker 工具的请求异步入队给后台路由器与 Worker，立即返回工单号，绝不阻塞当前对话。",
      parameters: DelegateParams,
      async execute(_toolCallId, input) {
        const accepted = delegateFn({
          hint: input.hint,
          urgency: input.urgency,
        });
        return {
          content: [
            {
              type: "text",
              text: `已异步入队后台工单 ${accepted.ticketId} (status=${accepted.status})，可自然告知用户正在处理。`,
            },
          ],
          details: accepted,
        };
      },
    };
    tools.push(delegateTool);
  }

  if (params.extraTools && params.extraTools.length > 0) {
    const existingNames = new Set(tools.map((t) => t.name));
    for (const extra of params.extraTools) {
      if (existingNames.has(extra.name)) continue;
      existingNames.add(extra.name);
      tools.push(extra);
    }
  }

  if (!params.onBeforeToolExecute) {
    return tools;
  }

  const hook = params.onBeforeToolExecute;
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, input, signal, onUpdate) => {
      await hook(tool.name, input);
      return tool.execute(toolCallId, input, signal, onUpdate);
    },
  }));
}

function dedupeMemoryItems(items: readonly MemoryRecallItem[]): MemoryRecallItem[] {
  const seen = new Set<string>();
  const out: MemoryRecallItem[] = [];
  for (const item of items) {
    const key = `${item.bank}:${item.id}:${item.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
