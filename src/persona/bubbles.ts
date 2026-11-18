export interface BubbleSplitOptions {
  enabled: boolean;
  maxPerTurn: number;
  delimiter: string;
}

const MARKDOWN_TABLE_LINE = /^\s*\|.+\|\s*$/;
const MARKDOWN_HEADING_LINE = /^\s*#{1,6}\s+\S/;
const ORDERED_LIST_LINE = /^\s*\d+\.\s+\S/;
const UNORDERED_LIST_LINE = /^\s*[-*+]\s+\S/;

/**
 * Check whether content contains structured technical blocks that must remain intact
 * in a single message rather than being split across chat bubbles.
 */
export function hasStructuredContent(text: string): boolean {
  if (text.includes("```")) return true;
  if (MARKDOWN_HEADING_LINE.test(text)) return true;

  const lines = text.split(/\r?\n/);
  let tableLineCount = 0;
  let orderedListCount = 0;
  let totalListCount = 0;

  for (const line of lines) {
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
 * Explicit delimiter lines (e.g. `\n---\n`) take precedence when present so the model
 * can keep blank lines inside a single bubble; otherwise, casual multi-paragraph
 * replies separated by blank lines (`\n\n`) are split into separate bubbles.
 */
export function splitIntoBubbles(rawText: string, options: BubbleSplitOptions): string[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  const delimiterPattern = buildDelimiterPattern(options.delimiter);
  const cleanText = stripDelimiterArtifacts(trimmed, delimiterPattern);
  if (!options.enabled || options.maxPerTurn <= 1 || hasStructuredContent(trimmed)) {
    return [cleanText];
  }

  const hasExplicitDelimiter = new RegExp(delimiterPattern).test(trimmed);
  const splitRegex = hasExplicitDelimiter
    ? new RegExp(delimiterPattern, "g")
    : /\r?\n\s*\r?\n+/g;

  const rawParts = trimmed
    .split(splitRegex)
    .map((part) => (hasExplicitDelimiter ? part.trim() : stripDelimiterArtifacts(part, delimiterPattern)))
    .filter((part) => part.length > 0);

  if (rawParts.length <= 1) {
    return [cleanText];
  }

  if (rawParts.length <= options.maxPerTurn) {
    return rawParts;
  }

  // Merge excess trailing parts into the final allowed bubble so no content is lost.
  const head = rawParts.slice(0, options.maxPerTurn - 1);
  const tail = rawParts.slice(options.maxPerTurn - 1).join("\n\n");
  return [...head, tail];
}

function buildDelimiterPattern(delimiter: string): string {
  const token = delimiter.trim() || "---";
  return `(?:\\r?\\n)\\s*${escapeRegExp(token)}\\s*(?:\\r?\\n)`;
}

function stripDelimiterArtifacts(text: string, delimiterPattern: string): string {
  const regex = new RegExp(delimiterPattern, "g");
  return text.replace(regex, "\n\n").trim();
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
  const token = options.delimiter.trim() || "---";
  return bubbles.join(`\n\n${token}\n\n`);
}
