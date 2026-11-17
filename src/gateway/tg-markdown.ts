/**
 * Escape special HTML characters for Telegram HTML parse_mode.
 */
export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeTelegramHtmlAttr(url: string): string {
  return escapeTelegramHtml(url).replace(/"/g, "&quot;");
}

/**
 * Convert common Markdown syntax into Telegram-compatible HTML (`parse_mode: "HTML"`).
 * Uses placeholder extraction for code blocks and inline code so inner characters
 * (like `*`, `_`, `<`, `&`, snake_case identifiers) are never corrupted.
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return "";

  const tokens: string[] = [];
  const pushToken = (html: string): string => {
    const idx = tokens.length;
    tokens.push(html);
    return `\u0000TGHTML_${idx}\u0000`;
  };

  // 1. Extract fenced code blocks first.
  let work = markdown.replace(/```([a-zA-Z0-9_-]+)?[ \t]*\r?\n([\s\S]*?)```/g, (_m, lang: string | undefined, code: string) => {
    const cleanCode = escapeTelegramHtml(code.replace(/\n$/, ""));
    if (lang && lang.trim()) {
      return pushToken(`<pre><code class="language-${escapeTelegramHtmlAttr(lang.trim())}">${cleanCode}</code></pre>`);
    }
    return pushToken(`<pre>${cleanCode}</pre>`);
  });

  // 2. Extract inline code spans.
  work = work.replace(/`([^`\r\n]+)`/g, (_m, code: string) => {
    return pushToken(`<code>${escapeTelegramHtml(code)}</code>`);
  });

  // 3. Extract markdown links [label](url) with safe protocols.
  work = work.replace(/\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+|tg:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
    return pushToken(`<a href="${escapeTelegramHtmlAttr(url)}">${escapeTelegramHtml(label)}</a>`);
  });

  // 4. Escape remaining raw HTML characters.
  work = escapeTelegramHtml(work);

  // 5. Headings (# .. ######) -> bold line.
  work = work.replace(/^#{1,6}[ \t]+(.+)$/gm, (_m, title: string) => `<b>${title.trim()}</b>`);

  // 6. Blockquotes (> line).
  work = work.replace(/(?:^&gt;[ \t]?.*(?:\r?\n|$))+/gm, (block) => {
    const inner = block
      .replace(/\r?\n$/, "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^&gt;[ \t]?/, ""))
      .join("\n");
    return `<blockquote>${inner}</blockquote>\n`;
  });

  // 7. Bold (**text** and __text__).
  work = work.replace(/\*\*([^\r\n*]+(?:\*(?!\*)[^\r\n*]*)*)\*\*/g, "<b>$1</b>");
  work = work.replace(/(^|[\s(>])__([^\r\n_]+)__(?=[\s).,!?:;<]|$)/gm, "$1<b>$2</b>");

  // 8. Strikethrough (~~text~~).
  work = work.replace(/~~([^\r\n~]+)~~/g, "<s>$1</s>");

  // 9. Italic (*text* and boundary-delimited _text_, preserving snake_case).
  work = work.replace(/(^|[^\w*])\*([^\s*\r\n][^\r\n*]*?[^\s*\r\n]|[^\s*\r\n])\*(?=[^\w*]|$)/gm, "$1<i>$2</i>");
  work = work.replace(/(^|[\s(>])_([^\s_\r\n][^_\r\n]*?[^\s_\r\n]|[^\s_\r\n])_(?=[\s).,!?:;<]|$)/gm, "$1<i>$2</i>");

  // 10. Restore protected HTML tokens.
  work = work.replace(/\u0000TGHTML_(\d+)\u0000/g, (_m, idxStr: string) => tokens[Number(idxStr)] ?? "");

  return work;
}
