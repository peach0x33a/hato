export interface BubbleSplitOptions {
  enabled: boolean;
  maxPerTurn: number;
  delimiter: string;
}

export const DEFAULT_BUBBLE_DELIMITER = "[SPLIT]";

const MARKDOWN_TABLE_LINE = /^\s*\|.+\|\s*$/;
const MARKDOWN_HEADING_LINE = /^\s*#{1,6}\s+\S/;
const ORDERED_LIST_LINE = /^\s*\d+\.\s+\S/;
const UNORDERED_LIST_LINE = /^\s*[-*+]\s+\S/;
const MARKDOWN_RULE_DELIMITER = /^[-_*=]{3,}$/;

/**
 * Check whether content contains structured technical blocks that must remain intact
 * in a single message rather than being split across chat bubbles.
 */
export function hasStructuredContent(text: string): boolean {
  if (text.includes("```")) return true;

  const lines = text.split(/\r?\n/);
  let tableLineCount = 0;
  let orderedListCount = 0;
  let totalListCount = 0;

  for (const line of lines) {
    if (MARKDOWN_HEADING_LINE.test(line)) return true;
    if (MARKDOWN_TABLE_LINE.test(line)) {
      tableLineCount++;
      if (tableLineCount >= 2) return true;
    }
    if (ORDERED_LIST_LINE.test(line)) {
      orderedListCount++;
      totalListCount++;
      if (orderedListCount >= 2 || totalListCount >= 3) return true;
    } else if (UNORDERED_LIST_LINE.test(line)) {
      totalListCount++;
      if (totalListCount >= 3) return true;
    }
  }
  return false;
}

/**
 * Normalize Persona output into clean outbound chat bubbles while preserving intact
 * technical blocks and honoring per-channel bubble limits.
 *
 * Only the configured explicit delimiter (default `[SPLIT]`) splits bubbles; blank lines
 * (`\n\n`) and Markdown rules (`---`) stay intact inside a single bubble.
 */
export function splitIntoBubbles(rawText: string, options: BubbleSplitOptions): string[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  const token = options.delimiter.trim() || DEFAULT_BUBBLE_DELIMITER;
  const splitRegex = buildDelimiterRegex(token);
  const rawParts = trimmed
    .split(splitRegex)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (rawParts.length === 0) return [];

  const cleanText = rawParts.join("\n\n");
  if (!options.enabled || options.maxPerTurn === 1 || hasStructuredContent(trimmed)) {
    return [cleanText];
  }

  if (rawParts.length <= 1) {
    return [cleanText];
  }

  if (options.maxPerTurn <= 0 || rawParts.length <= options.maxPerTurn) {
    return rawParts;
  }

  // Merge excess trailing parts into the final allowed bubble so no content is lost.
  const head = rawParts.slice(0, options.maxPerTurn - 1);
  const tail = rawParts.slice(options.maxPerTurn - 1).join("\n\n");
  return [...head, tail];
}

function buildDelimiterRegex(token: string): RegExp {
  if (MARKDOWN_RULE_DELIMITER.test(token)) {
    return new RegExp(`(?:^|\\r?\\n)[ \\t]*${escapeRegExp(token)}[ \\t]*(?=\\r?\\n|$)`, "g");
  }
  return new RegExp(escapeRegExp(token), "g");
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Join outbound bubbles for DB persistence while preserving explicit bubble
 * boundaries (`delimiter`) so WebUI history reconstructs the exact same bubbles.
 */
export function joinPersistedBubbles(
  bubbles: string[],
  options: Pick<BubbleSplitOptions, "enabled" | "delimiter">,
): string {
  if (bubbles.length === 0) return "";
  if (!options.enabled || bubbles.length === 1) {
    return bubbles.join("\n\n");
  }
  const token = options.delimiter.trim() || DEFAULT_BUBBLE_DELIMITER;
  return bubbles.join(`\n\n${token}\n\n`);
}

/**
 * Render the high-salience output format contract appended at the very end of the
 * static system prompt (after `soul.md`) so Persona reliably uses the active bubble
 * delimiter even at `minimal` thinking levels.
 */
export function buildBubbleOutputPromptBlock(options: BubbleSplitOptions): string {
  const token = options.delimiter.trim() || DEFAULT_BUBBLE_DELIMITER;
  if (!options.enabled || options.maxPerTurn === 1) {
    return [
      "## Output Format — Single-Bubble Mode",
      `- Multi-bubble splitting is **DISABLED**. Reply in one cohesive message and do **NOT** output \`${token}\`.`,
    ].join("\n");
  }

  const limitHint =
    options.maxPerTurn > 1 ? ` (at most ${options.maxPerTurn} bubbles per turn)` : "";

  return [
    `## Output Format — Multi-Bubble IM Delivery (Active Delimiter: \`${token}\`)`,
    `- Multi-bubble chat mode is **ENABLED**${limitHint}.`,
    `- Whenever a casual reply has 2+ short conversational sentences, reactions, or follow-up thoughts, **you MUST put \`${token}\` on its own line between each bubble** instead of separating short chat lines with blank lines (\`\\n\\n\`).`,
    `- Blank lines (\`\\n\\n\`) and \`---\` do **NOT** split bubbles—if you omit \`${token}\`, all lines are sent crammed inside a single bubble.`,
    `- Format contrast (日常多句短消息必须用 \`${token}\` 拆气泡，严禁只敲空行充当分段):`,
    "  ❌ Wrong (blank lines stay inside 1 giant bubble):",
    "  深表赞同，围巾就是冬季性价比最高的萌系装备了",
    "",
    "  尤其把半张脸埋进去只露眼睛那一下，可爱值直接翻倍",
    "  ✅ Correct (delivered sequentially as separate IM bubbles):",
    "  深表赞同，围巾就是冬季性价比最高的萌系装备了",
    `  ${token}`,
    "  尤其把半张脸埋进去只露眼睛那一下，可爱值直接翻倍",
    `- Keep code, commands, configs, tables, lists, or precise technical findings intact in one single bubble (no \`${token}\`).`,
  ].join("\n");
}
