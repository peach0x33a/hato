import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DEFAULT_PROMPT_ORDER } from "../config/app.js";

export interface PromptBlockEntry {
  name: string;
  path: string;
  content: string;
  /** Root-level `.md` files outside `blocks/` default to disabled unless explicitly enabled in `order`. */
  defaultDisabled?: boolean;
}

export interface LoadedLayeredPrompts {
  promptsDir: string;
  blocksDir: string;
  blocks: PromptBlockEntry[];
  systemPath: string;
  systemText: string;
  soulPath: string;
  soulText: string;
  order: string[];
  disabled: string[];
  mode: "layered";
  combinedText: string;
}

const SAFE_BLOCK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

/**
 * Normalize and validate a user prompt block filename inside `prompts_dir/blocks/`.
 * Rejects path separators, parent traversal, and non-markdown suffixes.
 */
export function normalizePromptBlockFilename(rawName: string): string {
  const trimmed = rawName.trim();
  const base = trimmed.endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
  if (
    !base ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    !SAFE_BLOCK_NAME_RE.test(base)
  ) {
    throw new Error(
      `非法提示词块名称 "${rawName}"：仅允许字母、数字、点、短横线或下划线（不含路径分隔符或 ..）`,
    );
  }
  return `${base}.md`;
}

/**
 * Load and assemble Layer 1 static prompts in configurable order:
 * e.g. `["blocks", "system", "soul"]` or custom `["block:01-user.md", "system", "soul"]`.
 */
export function loadLayeredPrompts(
  promptsDir: string,
  order: readonly string[] = DEFAULT_PROMPT_ORDER,
  disabled: readonly string[] = [],
): LoadedLayeredPrompts {
  const absPromptsDir = resolve(promptsDir);
  const blocksDir = resolve(absPromptsDir, "blocks");
  const systemPath = resolve(absPromptsDir, "system.md");
  const soulPath = resolve(absPromptsDir, "soul.md");

  const blocks = loadPromptBlocks(absPromptsDir, blocksDir);
  const hasSystem = existsSync(systemPath);
  const hasSoul = existsSync(soulPath);
  const effectiveDisabled = disabled.map((d) => d.trim()).filter(Boolean);

  const systemText = hasSystem ? readFileSync(systemPath, "utf8").trim() : "";
  const soulText = hasSoul ? readFileSync(soulPath, "utf8").trim() : "";

  const effectiveOrder = order.length > 0 ? [...order] : [...DEFAULT_PROMPT_ORDER];
  const combinedText = assembleLayeredPromptText({
    blocks,
    systemText,
    soulText,
    order: effectiveOrder,
    disabled: effectiveDisabled,
  });

  return {
    promptsDir: absPromptsDir,
    blocksDir,
    blocks,
    systemPath,
    systemText,
    soulPath,
    soulText,
    order: effectiveOrder,
    disabled: effectiveDisabled,
    mode: "layered",
    combinedText,
  };
}

export function assembleLayeredPromptText(params: {
  blocks: readonly PromptBlockEntry[];
  systemText: string;
  soulText: string;
  order: readonly string[];
  disabled?: readonly string[];
}): string {
  const byName = new Map<string, PromptBlockEntry>();
  for (const b of params.blocks) {
    byName.set(b.name, b);
    if (b.name.endsWith(".md")) {
      byName.set(b.name.slice(0, -3), b);
    }
  }

  const disabledSet = new Set((params.disabled ?? []).map((item) => item.trim()).filter(Boolean));
  const isBlockDisabled = (blockName: string): boolean => {
    const bare = blockName.endsWith(".md") ? blockName.slice(0, -3) : blockName;
    return (
      disabledSet.has(`block:${blockName}`) ||
      disabledSet.has(`block:${bare}`) ||
      disabledSet.has(blockName) ||
      disabledSet.has(bare)
    );
  };

  // Track which blocks were explicitly placed by `block:<name>` so a subsequent `"blocks"`
  // token expands only the remaining blocks without duplicating explicitly ordered ones.
  const explicitlyNamed = new Set<string>();
  for (const token of params.order) {
    const t = token.trim();
    if (t.startsWith("block:")) {
      const ref = t.slice("block:".length).trim();
      const matched = byName.get(ref) ?? byName.get(ref.endsWith(".md") ? ref : `${ref}.md`);
      if (matched) explicitlyNamed.add(matched.name);
    }
  }

  const sections: string[] = [];
  const emittedBlocks = new Set<string>();
  let emittedSystem = false;
  let emittedSoul = false;

  for (const rawToken of params.order) {
    const token = rawToken.trim();
    if (!token) continue;

    if (token === "blocks") {
      if (disabledSet.has("blocks")) continue;
      for (const b of params.blocks) {
        if (
          b.defaultDisabled ||
          explicitlyNamed.has(b.name) ||
          emittedBlocks.has(b.name) ||
          isBlockDisabled(b.name)
        ) {
          continue;
        }
        emittedBlocks.add(b.name);
        if (b.content.trim()) sections.push(b.content.trim());
      }
      continue;
    }

    if (token.startsWith("block:")) {
      const ref = token.slice("block:".length).trim();
      const matched = byName.get(ref) ?? byName.get(ref.endsWith(".md") ? ref : `${ref}.md`);
      if (matched && !emittedBlocks.has(matched.name) && !isBlockDisabled(matched.name)) {
        emittedBlocks.add(matched.name);
        if (matched.content.trim()) sections.push(matched.content.trim());
      }
      continue;
    }

    if (token === "system") {
      if (!disabledSet.has("system") && !emittedSystem && params.systemText.trim()) {
        emittedSystem = true;
        sections.push(params.systemText.trim());
      }
      continue;
    }

    if (token === "soul") {
      if (!disabledSet.has("soul") && !emittedSoul && params.soulText.trim()) {
        emittedSoul = true;
        sections.push(params.soulText.trim());
      }
    }
  }

  return sections.join("\n\n");
}

export function writeFileWithBackup(absPath: string, content: string): { path: string; backupPath?: string } {
  mkdirSync(dirname(absPath), { recursive: true });
  let backupPath: string | undefined;
  if (existsSync(absPath)) {
    backupPath = `${absPath}.bak`;
    copyFileSync(absPath, backupPath);
  }
  writeFileSync(absPath, content, "utf8");
  return { path: absPath, backupPath };
}

export function upsertPromptBlock(
  promptsDir: string,
  name: string,
  content: string,
): { name: string; path: string; backupPath?: string } {
  const filename = normalizePromptBlockFilename(name);
  const blocksPath = resolve(promptsDir, "blocks", filename);
  const rootPath = resolve(promptsDir, filename);
  const targetPath =
    !existsSync(blocksPath) && filename !== "system.md" && filename !== "soul.md" && existsSync(rootPath)
      ? rootPath
      : blocksPath;
  const res = writeFileWithBackup(targetPath, content.endsWith("\n") ? content : `${content}\n`);
  return { name: filename, ...res };
}

export function deletePromptBlock(
  promptsDir: string,
  name: string,
): { name: string; path: string; deleted: boolean; backupPath?: string } {
  const filename = normalizePromptBlockFilename(name);
  const blocksPath = resolve(promptsDir, "blocks", filename);
  const rootPath = resolve(promptsDir, filename);
  const absPath =
    !existsSync(blocksPath) && filename !== "system.md" && filename !== "soul.md" && existsSync(rootPath)
      ? rootPath
      : blocksPath;
  if (!existsSync(absPath)) {
    return { name: filename, path: absPath, deleted: false };
  }
  const backupPath = `${absPath}.bak`;
  copyFileSync(absPath, backupPath);
  unlinkSync(absPath);
  return { name: filename, path: absPath, deleted: true, backupPath };
}

function readMarkdownDir(dir: string, excludeNames?: ReadonlySet<string>): PromptBlockEntry[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        !entry.name.startsWith(".") &&
        !(excludeNames?.has(entry.name) ?? false),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return files.map((file) => {
    const absPath = resolve(dir, file);
    return {
      name: basename(file),
      path: absPath,
      content: readFileSync(absPath, "utf8").trim(),
    };
  });
}

function loadPromptBlocks(promptsDir: string, blocksDir: string): PromptBlockEntry[] {
  const blockEntries = readMarkdownDir(blocksDir).map((entry) => ({
    ...entry,
    defaultDisabled: false,
  }));
  const seen = new Set<string>(["system.md", "soul.md", ...blockEntries.map((b) => b.name)]);
  const rootEntries = readMarkdownDir(promptsDir, seen).map((entry) => ({
    ...entry,
    defaultDisabled: true,
  }));
  return [...blockEntries, ...rootEntries];
}
