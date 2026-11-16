import { diffCalendarDays, formatLocalDateTime } from "../time/clock.js";
import type { HatoRepository } from "../db/repo.js";

const MATH_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  sqrt: Math.sqrt,
  min: Math.min,
  max: Math.max,
};

type Token =
  | { type: "num"; value: number }
  | { type: "ident"; value: string }
  | { type: "op"; value: string }
  | { type: "paren"; value: "(" | ")" }
  | { type: "comma" };

function tokenizeMath(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let end = i;
      while (end < expr.length && /[0-9._]/.test(expr[end]!)) end++;
      const num = Number(expr.slice(i, end).replaceAll("_", ""));
      if (!Number.isFinite(num)) throw new Error(`Invalid number literal near "${expr.slice(i, end)}"`);
      tokens.push({ type: "num", value: num });
      i = end;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let end = i;
      while (end < expr.length && /[a-zA-Z0-9_]/.test(expr[end]!)) end++;
      tokens.push({ type: "ident", value: expr.slice(i, end).toLowerCase() });
      i = end;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma" });
      i++;
      continue;
    }
    if ("+-*/%^".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    throw new Error(`Unsupported character in expression: "${ch}"`);
  }
  return tokens;
}

/**
 * Evaluate a pure arithmetic expression safely without eval/Function.
 * Supports +, -, *, /, %, ^, parentheses, pi/e, and basic Math functions.
 */
export function evaluateSafeMath(expression: string): number {
  const tokens = tokenizeMath(expression);
  if (tokens.length === 0) {
    throw new Error("Expression is empty");
  }

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const consume = (): Token => {
    const tok = tokens[pos];
    if (!tok) throw new Error("Unexpected end of expression");
    pos++;
    return tok;
  };

  function parseAddSub(): number {
    let left = parseMulDiv();
    while (peek()?.type === "op" && (peek() as { value: string }).value.match(/^[+-]$/)) {
      const op = (consume() as { value: string }).value;
      const right = parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseMulDiv(): number {
    let left = parsePower();
    while (peek()?.type === "op" && (peek() as { value: string }).value.match(/^[*/%]$/)) {
      const op = (consume() as { value: string }).value;
      const right = parsePower();
      if ((op === "/" || op === "%") && right === 0) {
        throw new Error("Division by zero");
      }
      if (op === "*") left *= right;
      else if (op === "/") left /= right;
      else left %= right;
    }
    return left;
  }

  function parsePower(): number {
    const base = parseUnary();
    if (peek()?.type === "op" && (peek() as { value: string }).value === "^") {
      consume();
      const exp = parsePower();
      return base ** exp;
    }
    return base;
  }

  function parseUnary(): number {
    if (peek()?.type === "op") {
      const op = (peek() as { value: string }).value;
      if (op === "+") {
        consume();
        return parseUnary();
      }
      if (op === "-") {
        consume();
        return -parseUnary();
      }
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const tok = consume();
    if (tok.type === "num") return tok.value;

    if (tok.type === "paren" && tok.value === "(") {
      const val = parseAddSub();
      const close = consume();
      if (close.type !== "paren" || close.value !== ")") {
        throw new Error("Expected closing parenthesis");
      }
      return val;
    }

    if (tok.type === "ident") {
      if (tok.value === "pi") return Math.PI;
      if (tok.value === "e") return Math.E;

      const fn = MATH_FUNCTIONS[tok.value];
      if (!fn) {
        throw new Error(`Unknown identifier: "${tok.value}"`);
      }
      const open = consume();
      if (open.type !== "paren" || open.value !== "(") {
        throw new Error(`Expected "(" after function "${tok.value}"`);
      }
      const args: number[] = [];
      if (!(peek()?.type === "paren" && (peek() as { value: string }).value === ")")) {
        while (true) {
          args.push(parseAddSub());
          if (peek()?.type === "comma") {
            consume();
            continue;
          }
          break;
        }
      }
      const close = consume();
      if (close.type !== "paren" || close.value !== ")") {
        throw new Error(`Expected ")" after arguments to "${tok.value}"`);
      }
      const res = fn(...args);
      if (!Number.isFinite(res)) {
        throw new Error(`Function "${tok.value}" produced non-finite value`);
      }
      return res;
    }

    throw new Error("Unexpected token in expression");
  }

  const result = parseAddSub();
  if (pos !== tokens.length) {
    throw new Error("Unexpected trailing tokens in expression");
  }
  if (!Number.isFinite(result)) {
    throw new Error("Result is not finite");
  }
  return result;
}

export interface DateMathQuery {
  action: "add_days" | "diff_days" | "weekday" | "convert_timezone";
  date?: string;
  target_date?: string;
  days?: number;
  timezone?: string;
  target_timezone?: string;
  iso_timestamp?: string;
}

export function runDateMath(query: DateMathQuery, nowMs: number, defaultTimezone: string): string {
  const tz = query.timezone || defaultTimezone;

  if (query.action === "add_days") {
    const baseDate = query.date || formatLocalDateTime(nowMs, tz).isoDate;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(baseDate);
    if (!match) throw new Error(`Invalid date: ${baseDate}`);
    const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + (query.days ?? 0)));
    const resultIso = dt.toISOString().slice(0, 10);
    const weekday = formatLocalDateTime(Date.parse(`${resultIso}T12:00:00Z`), tz).weekdayZh;
    return `${baseDate} + (${query.days ?? 0}) 天 = ${resultIso} (${weekday})`;
  }

  if (query.action === "diff_days") {
    if (!query.target_date) throw new Error("target_date is required for diff_days");
    const refMs = query.date ? Date.parse(`${query.date}T12:00:00Z`) : nowMs;
    if (Number.isNaN(refMs)) throw new Error(`Invalid date: ${query.date}`);
    const delta = diffCalendarDays(refMs, query.target_date, tz);
    return `相距 ${delta} 天（目标 ${query.target_date}）`;
  }

  if (query.action === "weekday") {
    const target = query.date || formatLocalDateTime(nowMs, tz).isoDate;
    const refMs = Date.parse(`${target}T12:00:00Z`);
    if (Number.isNaN(refMs)) throw new Error(`Invalid date: ${target}`);
    const parts = formatLocalDateTime(refMs, tz);
    return `${parts.isoDate} 是 ${parts.weekdayZh}`;
  }

  const instant = query.iso_timestamp ? Date.parse(query.iso_timestamp) : nowMs;
  if (Number.isNaN(instant)) throw new Error(`Invalid iso_timestamp: ${query.iso_timestamp}`);
  const targetTz = query.target_timezone || tz;
  const formatted = formatLocalDateTime(instant, targetTz);
  return `${formatted.fullStamp} (${targetTz} · ${formatted.periodZh})`;
}

export function runInspectTickets(repo: HatoRepository, canonicalUserId: string, ticketId?: string): string {
  const rows = repo.listTickets(canonicalUserId, 20);
  const filtered = ticketId ? rows.filter((t) => t.id === ticketId) : rows.slice(0, 10);
  if (filtered.length === 0) {
    return ticketId ? `未找到工单 ${ticketId}。` : "当前没有任何工单记录。";
  }
  return filtered
    .map((t) => {
      const note = t.progressNote ? ` | 进度: ${t.progressNote}` : "";
      return `- [${t.id}] (${t.status} · ${t.backend}) ${t.briefTitle}${note}`;
    })
    .join("\n");
}

export function runListSchedules(repo: HatoRepository, canonicalUserId: string, timeZone: string): string {
  const scripts = repo.listScripts(20);
  const loops = repo.listOpenLoops(canonicalUserId, 20);

  const scriptLines =
    scripts.length === 0
      ? ["暂无常驻定时脚本。"]
      : scripts.map(
          (s) =>
            `- [${s.id}] ${s.name} (${s.enabled ? "启用" : "停用"}) cron="${s.cronExpr}" -> ${s.notifyChannel}`,
        );

  const loopLines =
    loops.length === 0
      ? ["暂无待办/主动关怀事项。"]
      : loops.map((l) => {
          const due = formatLocalDateTime(l.dueAt, timeZone).fullStamp;
          return `- [${l.id}] (${l.status}) ${l.content} | 到期: ${due} (${l.notifyChannel})`;
        });

  return `【常驻脚本】\n${scriptLines.join("\n")}\n\n【Open Loops】\n${loopLines.join("\n")}`;
}
