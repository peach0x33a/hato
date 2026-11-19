import { Check, Copy } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

type BlockNode =
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "blockquote"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "hr" }
  | { type: "paragraph"; lines: string[] };

const SAFE_URL_RE = /^(https?:\/\/|mailto:|\/)/i;

function isSafeHref(raw: string): boolean {
  return SAFE_URL_RE.test(raw.trim());
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownBlocks(raw: string): BlockNode[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = /^```([^\s`]*)\s*$/.exec(trimmed);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1]!.length,
        text: headingMatch[2]!.trim(),
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // GFM Table
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      lines[i + 1]!.includes("|") &&
      isTableSeparator(lines[i + 1]!)
    ) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().includes("|")) {
        rows.push(splitTableRow(lines[i]!));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!.trim())) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    // Unordered or ordered list
    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(cur);
        if (m) {
          const curOrdered = /\d+\./.test(m[2]!);
          if (curOrdered !== ordered && m[1]!.length === 0) break;
          items.push(m[3]!);
          i++;
          continue;
        }
        if (cur.trim() && /^\s{2,}/.test(cur) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]!} ${cur.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph (stop before next block construct)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      const curTrimmed = cur.trim();
      if (!curTrimmed) break;
      if (
        /^```/.test(curTrimmed) ||
        /^#{1,6}\s+/.test(curTrimmed) ||
        /^>\s?/.test(curTrimmed) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(curTrimmed) ||
        /^\s*([-*+]|\d+\.)\s+/.test(cur) ||
        (cur.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
      ) {
        if (paraLines.length > 0) break;
      }
      paraLines.push(cur);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", lines: paraLines });
    }
  }

  return blocks;
}

const INLINE_TOKEN_SOURCE =
  "(`[^`\\n]+`)|(\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\))|(\\*\\*([^*\\n]+)\\*\\*)|(__([^_\\n]+)__)|(~~([^~\\n]+)~~)|(\\*([^*\\n]+)\\*)|((^|[\\s(])_([^_\\n]+)_($|[\\s).,!?;:]))";

function renderInlineMarkdown(text: string, keyPrefix: string, depth = 0): ReactNode[] {
  if (depth > 8) return [text];

  const regex = new RegExp(INLINE_TOKEN_SOURCE, "g");
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    if (match.index > lastIndex) {
      out.push(text.slice(lastIndex, match.index));
    }

    const k = `${keyPrefix}-${tokenIdx++}`;
    if (match[1]) {
      // Inline code
      out.push(<code key={k}>{match[1].slice(1, -1)}</code>);
    } else if (match[2]) {
      // Link
      const label = match[3]!;
      const href = match[4]!;
      if (isSafeHref(href)) {
        out.push(
          <a key={k} href={href} target="_blank" rel="noreferrer noopener">
            {renderInlineMarkdown(label, `${k}-a`, depth + 1)}
          </a>,
        );
      } else {
        out.push(match[0]);
      }
    } else if (match[5]) {
      out.push(<strong key={k}>{renderInlineMarkdown(match[6]!, `${k}-b`, depth + 1)}</strong>);
    } else if (match[7]) {
      out.push(<strong key={k}>{renderInlineMarkdown(match[8]!, `${k}-b2`, depth + 1)}</strong>);
    } else if (match[9]) {
      out.push(<del key={k}>{renderInlineMarkdown(match[10]!, `${k}-s`, depth + 1)}</del>);
    } else if (match[11]) {
      out.push(<em key={k}>{renderInlineMarkdown(match[12]!, `${k}-i`, depth + 1)}</em>);
    } else if (match[13]) {
      const lead = match[14] ?? "";
      const inner = match[15]!;
      const trail = match[16] ?? "";
      if (lead) out.push(lead);
      out.push(<em key={k}>{renderInlineMarkdown(inner, `${k}-i2`, depth + 1)}</em>);
      if (trail) out.push(trail);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    out.push(text.slice(lastIndex));
  }

  return out;
}

const CODE_KEYWORDS = new Set([
  "def", "class", "import", "from", "as", "return", "if", "elif", "else", "for", "while", "try",
  "except", "finally", "with", "yield", "lambda", "pass", "break", "continue", "in", "is", "not",
  "and", "or", "None", "True", "False", "async", "await", "const", "let", "var", "function",
  "export", "default", "interface", "type", "enum", "new", "throw", "catch", "switch", "case",
  "null", "undefined", "true", "false", "typeof", "void", "fn", "pub", "struct", "impl", "match",
  "mut", "use", "mod", "echo", "fi", "then", "do", "done", "esac",
]);

function highlightCodeLine(line: string, keyPrefix: string): ReactNode[] {
  const tokenRe =
    /(#[^\n]*$|\/\/[^\n]*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  const out: ReactNode[] = [];
  let last = 0;
  let idx = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(line)) !== null) {
    if (m.index > last) {
      out.push(line.slice(last, m.index));
    }
    const k = `${keyPrefix}-${idx++}`;
    if (m[1]) {
      out.push(<span key={k} className="text-muted-foreground/75 italic">{m[1]}</span>);
    } else if (m[2]) {
      out.push(<span key={k} className="text-emerald-600 dark:text-emerald-400">{m[2]}</span>);
    } else if (m[3]) {
      out.push(<span key={k} className="text-amber-600 dark:text-amber-400">{m[3]}</span>);
    } else if (m[4] && CODE_KEYWORDS.has(m[4])) {
      out.push(<span key={k} className="text-sky-600 dark:text-sky-400 font-medium">{m[4]}</span>);
    } else {
      out.push(m[0]);
    }
    last = tokenRe.lastIndex;
  }
  if (last < line.length) {
    out.push(line.slice(last));
  }
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const lines = code.split("\n");

  return (
    <div className="my-2 min-w-0 max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/80">
      <div className="flex h-7 items-center justify-between border-b border-border/60 bg-muted/45 px-2.5 text-[11px] text-muted-foreground">
        <span className="font-mono">{lang || "text"}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="复制代码"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="!my-0 max-w-full overflow-x-auto !rounded-none !border-0 !bg-transparent p-3 font-mono text-[12px] leading-relaxed text-foreground">
        <code className="block w-max min-w-full !bg-transparent !p-0">
          {lines.map((ln, i) => (
            <Fragment key={i}>
              {i > 0 && "\n"}
              {highlightCodeLine(ln, `cl-${i}`)}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}

/**
 * Lightweight, XSS-safe Markdown renderer for Web Console assistant bubbles.
 */
export function MarkdownContent({ content, className }: MarkdownContentProps) {
  const blocks = parseMarkdownBlocks(content);
  if (blocks.length === 0) return null;

  return (
    <div className={className ? `min-w-0 max-w-full ${className}` : "min-w-0 max-w-full"}>
      {blocks.map((block, idx) => {
        const key = `md-${idx}`;
        if (block.type === "code") {
          return <CodeBlock key={key} lang={block.lang} code={block.code} />;
        }
        if (block.type === "heading") {
          const sizeCls =
            block.level <= 2
              ? "mt-3 mb-1.5 first:mt-0 text-sm font-semibold text-foreground"
              : "mt-2.5 mb-1 first:mt-0 text-[13px] font-semibold text-foreground";
          return (
            <div key={key} role="heading" aria-level={block.level} className={sizeCls}>
              {renderInlineMarkdown(block.text, key)}
            </div>
          );
        }
        if (block.type === "hr") {
          return <hr key={key} className="my-2.5 border-border/60" />;
        }
        if (block.type === "blockquote") {
          return (
            <blockquote
              key={key}
              className="my-2 border-l-2 border-border pl-3 text-muted-foreground"
            >
              {block.lines.map((ln, lIdx) => (
                <div key={`${key}-q-${lIdx}`}>
                  {renderInlineMarkdown(ln, `${key}-q-${lIdx}`)}
                </div>
              ))}
            </blockquote>
          );
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={key} className="my-1.5 space-y-1">
              {block.items.map((item, iIdx) => (
                <li key={`${key}-li-${iIdx}`} className="leading-relaxed">
                  {renderInlineMarkdown(item, `${key}-li-${iIdx}`)}
                </li>
              ))}
            </ListTag>
          );
        }
        if (block.type === "table") {
          return (
            <div key={key} className="my-2 overflow-x-auto rounded-md border border-border/60">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    {block.headers.map((h, hIdx) => (
                      <th
                        key={`${key}-h-${hIdx}`}
                        className="border-b border-border/60 px-2.5 py-1.5 font-medium"
                      >
                        {renderInlineMarkdown(h, `${key}-h-${hIdx}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {block.rows.map((row, rIdx) => (
                    <tr key={`${key}-r-${rIdx}`}>
                      {block.headers.map((_, cIdx) => (
                        <td key={`${key}-r-${rIdx}-c-${cIdx}`} className="px-2.5 py-1.5 align-top">
                          {renderInlineMarkdown(row[cIdx] ?? "", `${key}-r-${rIdx}-c-${cIdx}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={key} className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">
            {block.lines.map((ln, lIdx) => (
              <Fragment key={`${key}-p-${lIdx}`}>
                {lIdx > 0 && <br />}
                {renderInlineMarkdown(ln, `${key}-p-${lIdx}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
