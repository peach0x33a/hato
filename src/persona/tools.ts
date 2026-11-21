import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { convertBufferToModelImage } from "../gateway/media.js";
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
import { formatLocalDateTime, parseLocalDateTimeToEpochMs } from "../time/clock.js";
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

const MAX_ARTIFACT_READ_BYTES = 20 * 1024 * 1024;

/**
 * Returns true if the target path (or its resolved symlink target) refers to a `.env` / `.env.*` file.
 */
export function isSensitiveEnvFilePath(filePath: string): boolean {
  const normalized = resolve(filePath);
  const candidates = [normalized];
  try {
    if (existsSync(normalized)) {
      candidates.push(realpathSync(normalized));
    }
  } catch {
    // ignore realpath errors
  }
  return candidates.some((candidate) => {
    const name = basename(candidate).toLowerCase();
    return name === ".env" || name.startsWith(".env.");
  });
}

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
  include_details: opt(
    bool({
      description:
        "Set true when the user explicitly asks to see detailed execution logs, output report, or generated file paths",
    }),
  ),
});

const ListSchedulesParams = obj({});

const ScheduleCareParams = obj({
  content: str({ description: "What to care about, follow up on, or remind the user about" }),
  delay_minutes: opt(num({ description: "Optional minutes from now to follow up (e.g. 30)" })),
  due_at: opt(str({ description: "Optional local time 'YYYY-MM-DD HH:mm' in the user's timezone" })),
});

const SetScheduleOverrideParams = obj({
  action: opt(oneOf(["set", "clear"], { description: "Set (default) or clear active temporary override" })),
  temp_timezone: opt(str({ description: "Optional IANA timezone (e.g. Asia/Tokyo, America/New_York)" })),
  status_note: opt(str({ description: "Optional temporary status note (e.g. 出差中, 倒时差)" })),
  duration_hours: opt(num({ description: "How many hours the override remains active (default 24)" })),
});

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
  deliver_files: opt(
    bool({
      description:
        "Per-task delivery mode for generated files/images: false (default) lets you decide whether, when, and in what message order to send them via send_file/send_message after completion; true makes the system automatically send all generated artifacts right after your completion reply.",
    }),
  ),
});

const SendFileParams = obj({
  path: str({ description: "Local file path to send to the user" }),
  caption: opt(str({ description: "Optional short caption for the file" })),
  channel: opt(
    oneOf(["current", "tg", "qq"], {
      description:
        "Target platform: 'current' (default, reply in current chat), 'tg' (Telegram), or 'qq' (QQ).",
    }),
  ),
});

const ReadArtifactParams = obj({
  path: str({ description: "Artifact file path from ticket output or inspect_tickets" }),
  max_chars: opt(num({ description: "Optional max characters for text artifacts (default 24000)" })),
});

const ImageGenParams = obj({
  prompt: str({ description: "Detailed prompt describing the image to generate or edit" }),
  model: opt(str({ description: "Optional image model ID (e.g. gpt-image-2.5, gpt-image-2, gpt-image-1)" })),
  size: opt(str({ description: "Optional image size, e.g. 1024x1024, 1536x1024, 1024x1536" })),
  quality: opt(str({ description: "Optional image quality, e.g. low, medium, high, auto" })),
  n: opt(num({ description: "Optional number of images (1-4), defaults to 1" })),
  filename: opt(str({ description: "Optional output filename, e.g. drawing.png" })),
  reference_image_paths: opt(
    arr(str({ description: "Optional local reference image path(s) for image editing/reference generation" })),
  ),
  deliver_files: opt(
    bool({
      description:
        "Whether to auto-send generated image(s) right after your completion reply (true), or let you inspect first and send via send_file/send_message (false, default).",
    }),
  ),
});

const SendMessageParams = obj({
  channel: oneOf(["tg", "qq", "web"], {
    description: "Target platform to send the message to: 'tg', 'qq', or 'web'.",
  }),
  text: opt(str({ description: "Optional text message to deliver to the target platform" })),
  file_path: opt(str({ description: "Optional local file or image path to deliver to the target platform" })),
  caption: opt(str({ description: "Optional short caption when sending file_path" })),
});

const RenderMarkdownImageParams = obj({
  markdown: str({ description: "Markdown text to render into a PNG image" }),
  theme: opt(oneOf(["light", "dark"], { description: "Color theme: light (default) or dark" })),
  caption: opt(str({ description: "Optional short caption sent alongside the image" })),
});

const StickerSearchParams = obj({
  query: str({ description: "Keywords describing desired mood, scene, text, or visual content" }),
  emotion: opt(str({ description: "Optional emotion filter (e.g. 开心, 委屈, 吐槽, 贴贴)" })),
  limit: opt(num({ description: "Max results to return (1-10, default 5)" })),
});

const SendStickerParams = obj({
  sticker_id: str({ description: "Sticker ID returned by sticker_search (e.g. stk_...)" }),
  channel: opt(
    oneOf(["current", "tg", "qq"], {
      description: "Target platform: 'current' (default), 'tg' (native sendSticker), or 'qq'",
    }),
  ),
});

const StickerSaveParams = obj({
  path: opt(str({ description: "Local image/sticker file path from context to save and tag" })),
  pack_url: opt(
    str({
      description:
        "Telegram Sticker Pack URL (https://t.me/addstickers/...) or set_name to batch import",
    }),
  ),
  note: opt(str({ description: "Optional context note / user description to aid vision tagging" })),
  source: opt(oneOf(["user_send", "auto_save"])),
});

const StickerCollectParams = obj({
  action: oneOf(["start", "stop", "status"], {
    description: "Start, stop, or inspect batch sticker collection mode for incoming images/stickers",
  }),
});

const BotProfileParams = obj({
  platform: oneOf(["tg", "qq"], { description: "Target bot platform: 'tg' or 'qq'" }),
  action: oneOf(["inspect", "update", "remove_avatar"], {
    description: "'inspect' to view current bot profile, 'update' to change name/description/avatar, 'remove_avatar' to clear avatar",
  }),
  name: opt(str({ description: "New bot display name (up to 64 chars)" })),
  description: opt(str({ description: "New bot description (about/intro text)" })),
  short_description: opt(str({ description: "New short description shown on profile page" })),
  avatar_path: opt(str({ description: "Local image file path (.jpg/.png/.webp) to set as bot avatar" })),
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
  onDelegate?: (input: { hint: string; urgency?: "normal" | "high"; deliverFiles?: boolean }) => {
    ticketId: string;
    status: string;
  };
  onImageGen?: (input: {
    prompt: string;
    model?: string;
    size?: string;
    quality?: string;
    n?: number;
    filename?: string;
    referenceImagePaths?: string[];
    deliverFiles?: boolean;
  }) => {
    ticketId: string;
    status: string;
  };
  onSendFile?: (input: {
    path: string;
    caption?: string;
    channel?: "current" | "tg" | "qq";
  }) => Promise<{
    ok: boolean;
    message: string;
  }>;
  onSendMessage?: (input: {
    channel: "tg" | "qq" | "web";
    text?: string;
    filePath?: string;
    caption?: string;
  }) => Promise<{
    ok: boolean;
    message: string;
  }>;
  onRequestSensitiveFileConfirm?: (input: {
    channel: "current" | "tg" | "qq" | "web";
    path: string;
    caption?: string;
    text?: string;
  }) => Promise<{
    ok: boolean;
    ticketId?: string;
    message: string;
  }>;
  onStickerSearch?: (input: {
    query: string;
    emotion?: string;
    limit?: number;
  }) => Promise<string>;
  onSendSticker?: (input: {
    stickerId: string;
    channel?: "current" | "tg" | "qq";
  }) => Promise<{ ok: boolean; message: string }>;
  onStickerSave?: (input: {
    path?: string;
    packUrl?: string;
    note?: string;
    source?: "user_send" | "auto_save";
  }) => Promise<{ ok: boolean; message: string }>;
  onStickerCollect?: (input: {
    action: "start" | "stop" | "status";
  }) => Promise<{ ok: boolean; message: string }>;
  onBotProfile?: (input: {
    platform: "tg" | "qq";
    action: "inspect" | "update" | "remove_avatar";
    name?: string;
    description?: string;
    shortDescription?: string;
    avatarPath?: string;
  }) => Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }>;
  onRenderMarkdownImage?: (input: {
    markdown: string;
    theme?: "light" | "dark";
    caption?: string;
  }) => Promise<{ ok: boolean; message: string; bytes?: number }>;
  onMemoryRecalled?: (ids: string[]) => void;
  onBeforeToolExecute?: (toolName: string, input: unknown) => Promise<void>;
}): AgentTool<any>[] {
  const calcTool: AgentTool<typeof CalcParams> = {
    name: "calc",
    label: "Calculator",
    description: "Safely evaluate arithmetic, powers, and basic math functions.",
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
    label: "Date & Time Math",
    description: "Compute weekdays, date offsets, day differences, and timezone conversions.",
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
    label: "Inspect Background Tickets",
    description:
      "Read-only lookup of background ticket status and execution details. Call only when the user asks about task progress, reports, logs, or generated artifacts (set include_details: true when details are requested).",
    parameters: InspectTicketsParams,
    async execute(_toolCallId, input) {
      const text = runInspectTickets(
        params.repo,
        params.canonicalUserId,
        input.ticket_id,
        Boolean(input.include_details),
      );
      return {
        content: [{ type: "text", text }],
        details: { text },
      };
    },
  };

  const listSchedulesTool: AgentTool<typeof ListSchedulesParams> = {
    name: "list_schedules",
    label: "List Schedules",
    description:
      "Read-only list of registered scheduled jobs and reminders. Call only when the user asks about schedules, cron jobs, or reminders.",
    parameters: ListSchedulesParams,
    async execute() {
      const text = runListSchedules(params.repo, params.canonicalUserId, params.getTimezone());
      return {
        content: [{ type: "text", text }],
        details: { text },
      };
    },
  };

  const scheduleCareTool: AgentTool<typeof ScheduleCareParams> = {
    name: "schedule_care",
    label: "Schedule Proactive Care",
    description:
      "Record a lightweight proactive-care follow-up or reminder (open loop) for the user at a future time (via delay_minutes or due_at 'YYYY-MM-DD HH:mm').",
    parameters: ScheduleCareParams,
    async execute(_toolCallId, input) {
      const tz = params.getTimezone();
      let dueAt: number | null = null;
      if (typeof input.delay_minutes === "number" && Number.isFinite(input.delay_minutes) && input.delay_minutes > 0) {
        dueAt = Date.now() + input.delay_minutes * 60_000;
      } else if (input.due_at?.trim()) {
        dueAt = parseLocalDateTimeToEpochMs(input.due_at, tz, 9, 30);
      }
      if (dueAt === null) {
        return {
          content: [{ type: "text", text: "请提供有效的 delay_minutes 或 due_at（格式 YYYY-MM-DD HH:mm）。" }],
          details: { ok: false },
        };
      }
      const cfg = params.getHatoConfig();
      const created = params.repo.createOpenLoop({
        canonicalUserId: params.canonicalUserId,
        content: input.content,
        dueAt,
        notifyChannel: cfg.owner.proactive_channel,
      });
      const dueStr = formatLocalDateTime(created.dueAt, tz).fullStamp;
      return {
        content: [{ type: "text", text: `已记录主动关怀提醒 [${created.id}]：${created.content}（预计 ${dueStr} 跟进）。` }],
        details: { ok: true, id: created.id, dueAt: created.dueAt },
      };
    },
  };

  const setScheduleOverrideTool: AgentTool<typeof SetScheduleOverrideParams> = {
    name: "set_schedule_override",
    label: "Set Schedule Override",
    description:
      "Temporarily override the user's timezone (e.g. traveling) and/or status note for a duration, or clear active overrides.",
    parameters: SetScheduleOverrideParams,
    async execute(_toolCallId, input) {
      if (input.action === "clear") {
        const cleared = params.repo.clearScheduleOverrides(params.canonicalUserId);
        return {
          content: [{ type: "text", text: cleared > 0 ? "已清除临时时区/状态覆盖。" : "当前没有生效的临时覆盖。" }],
          details: { ok: true, cleared },
        };
      }
      const tz = input.temp_timezone?.trim();
      const note = input.status_note?.trim();
      if (!tz && !note) {
        return {
          content: [{ type: "text", text: "请至少提供 temp_timezone 或 status_note。" }],
          details: { ok: false },
        };
      }
      if (tz) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
        } catch {
          return {
            content: [{ type: "text", text: `无效的 IANA 时区: ${tz}` }],
            details: { ok: false },
          };
        }
      }
      const hours = Math.min(Math.max(Number(input.duration_hours) || 24, 1), 24 * 30);
      const expiresAt = Date.now() + hours * 3600 * 1000;
      const created = params.repo.createScheduleOverride({
        canonicalUserId: params.canonicalUserId,
        tempTimezone: tz ?? null,
        statusNote: note ?? null,
        expiresAt,
      });
      return {
        content: [
          {
            type: "text",
            text: `已设置临时覆盖 [${created.id}]：${tz ? `时区=${tz} ` : ""}${note ? `状态=${note} ` : ""}（有效期 ${hours} 小时）。`,
          },
        ],
        details: { ok: true, id: created.id, expiresAt: created.expiresAt },
      };
    },
  };

  const searchPastSessionsTool: AgentTool<typeof SearchPastSessionsParams> = {
    name: "search_past_sessions",
    label: "Search Past Sessions",
    description:
      "Read-only search of archived chat sessions cleared by /new. Call only when the user refers to earlier conversations or asks to look up past chats.",
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
    label: "Web Search",
    description:
      "Real-time web search via Tavily for news, facts, documentation, or current info. Call only when external or up-to-date facts are needed.",
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
    label: "Web Fetch",
    description:
      "Lightweight HTTP/HTTPS text fetch without launching a browser. Prefer this for static articles/docs; use browser_task only for JS-rendered, authenticated, or interactive pages.",
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

  const readArtifactTool: AgentTool<typeof ReadArtifactParams> = {
    name: "read_artifact",
    label: "Read Worker Artifact",
    description:
      "Read a worker-delivered text/code/report artifact or inspect a generated image artifact by path.",
    parameters: ReadArtifactParams,
    async execute(_toolCallId, input) {
      const resolved = resolve(input.path.trim());
      if (isSensitiveEnvFilePath(resolved)) {
        return {
          content: [{ type: "text", text: `禁止读取敏感配置文件: ${resolved}` }],
          details: { ok: false, path: resolved },
        };
      }
      if (!existsSync(resolved)) {
        return {
          content: [{ type: "text", text: `产物文件不存在: ${resolved}` }],
          details: { ok: false, path: resolved },
        };
      }
      let realTarget = resolved;
      try {
        realTarget = realpathSync(resolved);
      } catch {
        realTarget = resolved;
      }
      if (isSensitiveEnvFilePath(realTarget)) {
        return {
          content: [{ type: "text", text: `禁止读取敏感配置文件: ${resolved}` }],
          details: { ok: false, path: resolved },
        };
      }
      const rawWorkspacesRoot = resolve(params.getHatoConfig().paths.workspaces_dir);
      const workspacesRoot = existsSync(rawWorkspacesRoot)
        ? realpathSync(rawWorkspacesRoot)
        : rawWorkspacesRoot;
      const inWorkspace =
        realTarget === workspacesRoot || realTarget.startsWith(`${workspacesRoot}${sep}`);
      const knownArtifact = params.repo.listTickets(params.canonicalUserId, 50).some((t) => {
        if (!t.resultJson) return false;
        try {
          const parsed = JSON.parse(t.resultJson) as {
            artifacts?: Array<{ path?: string }>;
          };
          return (parsed.artifacts ?? []).some((a) => {
            if (!a.path) return false;
            const artAbs = resolve(a.path);
            if (artAbs === resolved || artAbs === realTarget) return true;
            try {
              return existsSync(artAbs) && realpathSync(artAbs) === realTarget;
            } catch {
              return false;
            }
          });
        } catch {
          return false;
        }
      });
      if (!inWorkspace && !knownArtifact) {
        return {
          content: [{ type: "text", text: `路径不在工单产物或工作区范围内: ${resolved}` }],
          details: { ok: false, path: resolved },
        };
      }
      const stat = statSync(realTarget);
      if (!stat.isFile()) {
        return {
          content: [{ type: "text", text: `产物文件不存在: ${resolved}` }],
          details: { ok: false, path: resolved },
        };
      }
      if (stat.size > MAX_ARTIFACT_READ_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `产物文件过大 (${stat.size} bytes)，超出安全读取上限 (${MAX_ARTIFACT_READ_BYTES} bytes): ${resolved}`,
            },
          ],
          details: { ok: false, path: resolved, bytes: stat.size },
        };
      }
      const buffer = readFileSync(realTarget);
      const ext = extname(resolved).toLowerCase();
      if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
        const image = await convertBufferToModelImage({ buffer, filePath: resolved });
        if (image) {
          const content: (TextContent | ImageContent)[] = [
            { type: "text", text: `已读取图片产物: ${basename(resolved)} (${resolved}, ${buffer.length} bytes)` },
            image,
          ];
          return {
            content,
            details: { ok: true, path: resolved, kind: "image", bytes: buffer.length },
          };
        }
      }
      if (buffer.subarray(0, 4096).includes(0)) {
        return {
          content: [
            {
              type: "text",
              text: `二进制产物文件: ${basename(resolved)} (${resolved}, ${buffer.length} bytes)，无法以纯文本展开。`,
            },
          ],
          details: { ok: true, path: resolved, kind: "binary", bytes: buffer.length },
        };
      }
      const maxChars = Math.min(Math.max(Number(input.max_chars) || 24_000, 500), 60_000);
      const rawText = buffer.toString("utf8");
      const text =
        rawText.length > maxChars
          ? `${rawText.slice(0, maxChars)}\n\n... [已截断，共 ${rawText.length} 字符]`
          : rawText;
      return {
        content: [{ type: "text", text: `[产物: ${basename(resolved)} (${resolved})]\n${text}` }],
        details: { ok: true, path: resolved, kind: "text", chars: rawText.length },
      };
    },
  };

  const tools: AgentTool<any>[] = [
    calcTool,
    dateMathTool,
    inspectTicketsTool,
    readArtifactTool,
    listSchedulesTool,
    scheduleCareTool,
    setScheduleOverrideTool,
    searchPastSessionsTool,
    webSearchTool,
    webFetchTool,
  ];

  if (params.getMemoryStore) {
    const getStore = params.getMemoryStore;
    const recallMemoryTool: AgentTool<typeof RecallMemoryParams> = {
      name: "recall_memory",
      label: "Recall Long-Term Memory",
      description:
        "Read-only semantic search of long-term memory (persona preferences/life and tech environment/habits). Call when recalling past facts, preferences, or technical context.",
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
      label: "Browser Task",
      description:
        "Run an isolated headless/headed browser worker for JS-rendered pages, UI interaction, screenshots, or manual takeover. When status=needs_takeover is returned, tell the user a screenshot was sent and resume with resume=true after they finish.",
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
      label: "Self Config",
      description:
        "Safely inspect or update Hato runtime config (hato.toml allowlisted keys, read-only worker backends/CLI status, prompts.order, model slots, soul.md, blocks/*.md, and static relationship facts). Call when the user asks about or wants to change settings.",
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
      label: "Read Personal Skill",
      description:
        "Read-only loader for a personal skill's full SKILL.md instructions or its reference files (call only when <available_skills> matches the current task).",
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
      label: "Delegate Background Task",
      description:
        "Delegate local execution, system/env checks, scripts, coding, or investigative tasks to a background worker (shell/files/worker skills/MCP) to figure out and complete. Never use for math (calc), online lookups (web_search/web_fetch), or standalone image_gen.",
      parameters: DelegateParams,
      async execute(_toolCallId, input) {
        const accepted = delegateFn({
          hint: input.hint,
          urgency: input.urgency,
          deliverFiles: input.deliver_files,
        });
        return {
          content: [
            {
              type: "text",
              text: `已转交后台处理 (internal_id=${accepted.ticketId}, status=${accepted.status})。请用自然日常口吻简短回应“这就去弄，好了告诉你”，除非用户主动问，否则不要报出工单号或说“派出工单”。`,
            },
          ],
          details: accepted,
        };
      },
    };
    tools.push(delegateTool);
  }

  if (params.onImageGen) {
    const imageGenFn = params.onImageGen;
    const imageGenTool: AgentTool<typeof ImageGenParams> = {
      name: "image_gen",
      label: "Generate Image (Async)",
      description:
        "Generate or edit image(s) asynchronously in the background via OpenAI-compatible Images API. Returns immediately without blocking chat; once finished, you will receive the generated image(s) to inspect and deliver.",
      parameters: ImageGenParams,
      async execute(_toolCallId, input) {
        const accepted = imageGenFn({
          prompt: input.prompt,
          model: input.model,
          size: input.size,
          quality: input.quality,
          n: input.n,
          filename: input.filename,
          referenceImagePaths: input.reference_image_paths,
          deliverFiles: input.deliver_files,
        });
        return {
          content: [
            {
              type: "text",
              text: `已开始后台生图 (internal_id=${accepted.ticketId}, status=${accepted.status})。请用自然日常口吻简短回应（例如“这就去画，画好了马上发给你”），不要报出内部工单号。`,
            },
          ],
          details: accepted,
        };
      },
    };
    tools.push(imageGenTool);
  }

  if (params.onSendFile) {
    const sendFileFn = params.onSendFile;
    const sendFileTool: AgentTool<typeof SendFileParams> = {
      name: "send_file",
      label: "Send File",
      description:
        "Send a local file to the current chat or a target channel (tg / qq). Call when the user requests a file or when delivering a generated artifact.",
      parameters: SendFileParams,
      async execute(_toolCallId, input) {
        const resolved = resolve(input.path.trim());
        if (!existsSync(resolved)) {
          return {
            content: [{ type: "text", text: `文件不存在: ${resolved}` }],
            details: { ok: false, path: resolved },
          };
        }
        try {
          if (!statSync(resolved).isFile()) {
            return {
              content: [{ type: "text", text: `目标路径不是常规文件: ${resolved}` }],
              details: { ok: false, path: resolved },
            };
          }
          if (isSensitiveEnvFilePath(resolved)) {
            if (!params.onRequestSensitiveFileConfirm) {
              return {
                content: [
                  {
                    type: "text",
                    text: `目标文件 "${basename(resolved)}" 为敏感 .env 凭据文件，当前未接入主人二次确认通道，已拒绝直接发送。`,
                  },
                ],
                details: { ok: false, requiresConfirm: true, path: resolved },
              };
            }
            const confirmRes = await params.onRequestSensitiveFileConfirm({
              channel: input.channel ?? "current",
              path: resolved,
              caption: input.caption,
            });
            return {
              content: [{ type: "text", text: confirmRes.message }],
              details: {
                ok: confirmRes.ok,
                requiresConfirm: true,
                ticketId: confirmRes.ticketId,
                path: resolved,
                channel: input.channel ?? "current",
              },
            };
          }
          const res = await sendFileFn({
            path: resolved,
            caption: input.caption,
            channel: input.channel,
          });
          return {
            content: [{ type: "text", text: res.message }],
            details: { ok: res.ok, path: resolved, channel: input.channel ?? "current" },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `发送文件失败: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: { ok: false, path: resolved },
          };
        }
      },
    };
    tools.push(sendFileTool);
  }

  if (params.onSendMessage) {
    const sendMessageFn = params.onSendMessage;
    const sendMessageTool: AgentTool<typeof SendMessageParams> = {
      name: "send_message",
      label: "Send Cross-Channel Message",
      description:
        "Send a text message and/or local file (image, attachment) to a target channel (tg, qq, or web), useful for cross-platform delivery.",
      parameters: SendMessageParams,
      async execute(_toolCallId, input) {
        const text = input.text?.trim() || undefined;
        const rawFile = input.file_path?.trim();
        let resolvedFile: string | undefined;
        if (rawFile) {
          resolvedFile = resolve(rawFile);
          if (!existsSync(resolvedFile)) {
            return {
              content: [{ type: "text", text: `文件不存在: ${resolvedFile}` }],
              details: { ok: false, channel: input.channel, path: resolvedFile },
            };
          }
          if (!statSync(resolvedFile).isFile()) {
            return {
              content: [{ type: "text", text: `目标路径不是常规文件: ${resolvedFile}` }],
              details: { ok: false, channel: input.channel, path: resolvedFile },
            };
          }
          if (isSensitiveEnvFilePath(resolvedFile)) {
            if (!params.onRequestSensitiveFileConfirm) {
              return {
                content: [
                  {
                    type: "text",
                    text: `目标文件 "${basename(resolvedFile)}" 为敏感 .env 凭据文件，当前未接入主人二次确认通道，已拒绝直接发送。`,
                  },
                ],
                details: { ok: false, requiresConfirm: true, channel: input.channel, path: resolvedFile },
              };
            }
            const confirmRes = await params.onRequestSensitiveFileConfirm({
              channel: input.channel,
              path: resolvedFile,
              caption: input.caption?.trim() || undefined,
              text,
            });
            return {
              content: [{ type: "text", text: confirmRes.message }],
              details: {
                ok: confirmRes.ok,
                requiresConfirm: true,
                ticketId: confirmRes.ticketId,
                channel: input.channel,
                path: resolvedFile,
              },
            };
          }
        }
        if (!text && !resolvedFile) {
          return {
            content: [{ type: "text", text: "请至少提供 text 或 file_path 中的一项。" }],
            details: { ok: false, channel: input.channel },
          };
        }
        try {
          const res = await sendMessageFn({
            channel: input.channel,
            text,
            filePath: resolvedFile,
            caption: input.caption?.trim() || undefined,
          });
          return {
            content: [{ type: "text", text: res.message }],
            details: { ok: res.ok, channel: input.channel, path: resolvedFile },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `跨平台发送失败: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: { ok: false, channel: input.channel, path: resolvedFile },
          };
        }
      },
    };
    tools.push(sendMessageTool);
  }

  if (params.onStickerSearch) {
    const searchFn = params.onStickerSearch;
    tools.push({
      name: "sticker_search",
      label: "Search Stickers",
      description:
        "Search the saved sticker library by emotion, context, or visual description, returning matching sticker_ids.",
      parameters: StickerSearchParams,
      async execute(_toolCallId, input) {
        const text = await searchFn({
          query: input.query,
          emotion: input.emotion,
          limit: input.limit,
        });
        return { content: [{ type: "text", text }], details: { ok: true } };
      },
    });
  }

  if (params.onSendSticker) {
    const sendStickerFn = params.onSendSticker;
    tools.push({
      name: "send_sticker",
      label: "Send Sticker",
      description:
        "Send a sticker by sticker_id (native sendSticker on TG, image on QQ). Call sticker_search first to get a sticker_id.",
      parameters: SendStickerParams,
      async execute(_toolCallId, input) {
        const res = await sendStickerFn({
          stickerId: input.sticker_id.trim(),
          channel: input.channel,
        });
        return {
          content: [{ type: "text", text: res.message }],
          details: { ok: res.ok, stickerId: input.sticker_id },
        };
      },
    });
  }

  if (params.onStickerSave) {
    const saveFn = params.onStickerSave;
    tools.push({
      name: "sticker_save",
      label: "Save Sticker",
      description:
        "Save a local image/sticker path or batch-import a Telegram sticker pack (pack_url or set_name) with automatic vision tagging.",
      parameters: StickerSaveParams,
      async execute(_toolCallId, input) {
        const res = await saveFn({
          path: input.path?.trim() || undefined,
          packUrl: input.pack_url?.trim() || undefined,
          note: input.note?.trim() || undefined,
          source: input.source,
        });
        return { content: [{ type: "text", text: res.message }], details: { ok: res.ok } };
      },
    });
  }

  if (params.onStickerCollect) {
    const collectFn = params.onStickerCollect;
    tools.push({
      name: "sticker_collect",
      label: "Sticker Batch Collect",
      description:
        "Start, stop, or inspect batch sticker collection mode when the user wants to send multiple stickers/images to save.",
      parameters: StickerCollectParams,
      async execute(_toolCallId, input) {
        const res = await collectFn({ action: input.action });
        return { content: [{ type: "text", text: res.message }], details: { ok: res.ok } };
      },
    });
  }

  if (params.onBotProfile) {
    const botProfileFn = params.onBotProfile;
    const botProfileTool: AgentTool<typeof BotProfileParams> = {
      name: "bot_profile",
      label: "Bot Profile",
      description:
        "Inspect or update the Telegram / QQ bot profile (name, description, short description, avatar). Confirm intent before modifying.",
      parameters: BotProfileParams,
      async execute(_toolCallId, input) {
        const res = await botProfileFn({
          platform: input.platform,
          action: input.action,
          name: input.name,
          description: input.description,
          shortDescription: input.short_description,
          avatarPath: input.avatar_path,
        });
        return {
          content: [{ type: "text", text: res.message }],
          details: { ok: res.ok, ...(res.details ?? {}) },
        };
      },
    };
    tools.push(botProfileTool);
  }

  if (params.onRenderMarkdownImage) {
    const renderFn = params.onRenderMarkdownImage;
    const renderTool: AgentTool<typeof RenderMarkdownImageParams> = {
      name: "render_markdown_image",
      label: "Render Markdown Image",
      description:
        "Render Markdown (headings, lists, tables, code blocks, quotes) into a PNG image and send it to the user. Use only when the user asks for an image or when a complex table/code card is clearer visually; do not resend the full Markdown text after sending the image.",
      parameters: RenderMarkdownImageParams,
      async execute(_toolCallId, input) {
        const res = await renderFn({
          markdown: input.markdown,
          theme: input.theme,
          caption: input.caption,
        });
        return {
          content: [{ type: "text", text: res.message }],
          details: { ok: res.ok, ...(res.bytes !== undefined ? { bytes: res.bytes } : {}) },
        };
      },
    };
    tools.push(renderTool);
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
