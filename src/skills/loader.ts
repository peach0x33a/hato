import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const SKILL_ZONES = ["personal", "worker"] as const;
export type SkillZone = (typeof SKILL_ZONES)[number];

const SAFE_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_READ_CHARS = 32_000;

export interface SkillEntry {
  name: string;
  dirName: string;
  zone: SkillZone;
  description: string;
  dirPath: string;
  skillFilePath: string;
  hasReferences: boolean;
}

export interface ParsedSkillDocument {
  frontmatter: Record<string, string>;
  body: string;
  raw: string;
}

export interface ReadSkillResult {
  name: string;
  zone: SkillZone;
  filePath: string;
  content: string;
  references: string[];
  truncated: boolean;
}

/**
 * Parse optional YAML-style `---` frontmatter and markdown body from a `SKILL.md` file.
 * Supports single-line `key: value`, quoted strings, and folded/literal multiline scalars (`>` / `|`).
 */
export function parseSkillDocument(raw: string): ParsedSkillDocument {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    return { frontmatter: {}, body: normalized.trim(), raw: normalized };
  }

  const lines = normalized.split("\n");
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized.trim(), raw: normalized };
  }

  const fmLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join("\n").trim();
  const frontmatter: Record<string, string> = {};

  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i]!;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1]!.trim();
    const rawValue = match[2]!.trim();

    if (rawValue === ">" || rawValue === ">-" || rawValue === "|" || rawValue === "|-") {
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < fmLines.length) {
        const nextLine = fmLines[j]!;
        if (nextLine.trim() === "" || /^\s+/.test(nextLine)) {
          blockLines.push(nextLine.trim());
          j++;
        } else {
          break;
        }
      }
      const joined = rawValue.startsWith("|")
        ? blockLines.join("\n").trim()
        : blockLines.filter(Boolean).join(" ").trim();
      frontmatter[key] = joined;
      i = j;
      continue;
    }

    frontmatter[key] = stripYamlQuotes(rawValue);
    i++;
  }

  return { frontmatter, body, raw: normalized };
}

function stripYamlQuotes(value: string): string {
  if (value.length >= 2) {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Validate a skill identifier or directory name to reject traversal and invalid characters.
 */
export function normalizeSkillName(rawName: string): string {
  const trimmed = rawName.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    !SAFE_SKILL_NAME_RE.test(trimmed)
  ) {
    throw new Error(
      `非法 Skill 名称 "${rawName}"：仅允许字母、数字、点、短横线或下划线（不含路径分隔符或 ..）`,
    );
  }
  return trimmed;
}

/**
 * Scan `<skillsDir>/<zone>/*\/SKILL.md` and return deterministically sorted skill metadata.
 * Returns an empty array when the directory does not exist yet.
 */
export function loadZoneSkills(skillsDir: string, zone: SkillZone): SkillEntry[] {
  const zoneDir = resolve(skillsDir, zone);
  if (!existsSync(zoneDir)) {
    return [];
  }

  let dirEntries: string[];
  try {
    dirEntries = readdirSync(zoneDir).sort();
  } catch {
    return [];
  }

  const entries: SkillEntry[] = [];
  for (const dirName of dirEntries) {
    if (!SAFE_SKILL_NAME_RE.test(dirName)) continue;
    const skillDir = resolve(zoneDir, dirName);
    if (!isDirectorySafe(skillDir)) continue;

    const skillFilePath = resolve(skillDir, "SKILL.md");
    if (!existsSync(skillFilePath) || !isFileSafe(skillFilePath)) continue;

    const raw = readFileSync(skillFilePath, "utf8");
    const parsed = parseSkillDocument(raw);
    if (parsed.frontmatter.disable_model_invocation === "true") continue;

    const name = parsed.frontmatter.name?.trim() || dirName;
    if (!SAFE_SKILL_NAME_RE.test(name)) continue;

    const description =
      parsed.frontmatter.description?.trim() ||
      extractFallbackDescription(parsed.body) ||
      `Skill ${name}`;

    const refsDir = resolve(skillDir, "references");
    const hasReferences = isDirectorySafe(refsDir) && listRelativeFiles(skillDir, refsDir).length > 0;

    entries.push({
      name,
      dirName,
      zone,
      description,
      dirPath: skillDir,
      skillFilePath,
      hasReferences,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Format Level 1 static skill index block for Layer 1 prompt injection without body bloat.
 */
export function formatSkillsIndexBlock(skills: readonly SkillEntry[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "<available_skills>",
    "以下为可用个人技能索引（日常无需提及；仅在任务明显匹配时静默调用 `read_skill` 读取完整指引）：",
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description}`);
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/**
 * Read Level 2 full `SKILL.md` content (or an optional safe relative file inside that skill directory).
 */
export function readSkillContent(
  skillsDir: string,
  zone: SkillZone,
  skillName: string,
  referencePath?: string,
): ReadSkillResult {
  const safeName = normalizeSkillName(skillName);
  const skills = loadZoneSkills(skillsDir, zone);
  const matched =
    skills.find((s) => s.name === safeName) ?? skills.find((s) => s.dirName === safeName);

  if (!matched) {
    throw new Error(`在 ${zone} 区未找到名为 "${safeName}" 的 Skill。`);
  }

  const realSkillDir = realpathSync(matched.dirPath);
  const references = listSkillSupportingFiles(realSkillDir);

  let targetPath = realpathSync(matched.skillFilePath);
  if (referencePath?.trim()) {
    const rel = referencePath.trim().replace(/\\/g, "/");
    if (rel.startsWith("/") || rel.includes("..")) {
      throw new Error(`非法 Skill 引用路径 "${referencePath}"：不允许绝对路径或 ..`);
    }
    const candidate = resolve(realSkillDir, rel);
    if (!existsSync(candidate) || !isFileSafe(candidate)) {
      throw new Error(`Skill "${matched.name}" 中不存在文件 "${rel}"。`);
    }
    const realCandidate = realpathSync(candidate);
    if (realCandidate !== realSkillDir && !realCandidate.startsWith(realSkillDir + sep)) {
      throw new Error(`非法 Skill 引用路径 "${referencePath}"：超出 Skill 目录边界`);
    }
    targetPath = realCandidate;
  }

  const raw = readFileSync(targetPath, "utf8");
  const truncated = raw.length > MAX_READ_CHARS;
  const content = truncated ? `${raw.slice(0, MAX_READ_CHARS)}\n\n...[内容过长已截断]` : raw;

  return {
    name: matched.name,
    zone,
    filePath: relative(realSkillDir, targetPath) || "SKILL.md",
    content,
    references,
    truncated,
  };
}

/**
 * Resolve requested worker skills by name for Router/Worker `Mandate` injection.
 */
export function selectWorkerSkills(skillsDir: string, names: readonly string[]): SkillEntry[] {
  const all = loadZoneSkills(skillsDir, "worker");
  const byKey = new Map<string, SkillEntry>();
  for (const skill of all) {
    byKey.set(skill.name, skill);
    byKey.set(skill.dirName, skill);
  }

  const selected: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const entry = byKey.get(rawName.trim());
    if (!entry || seen.has(entry.dirPath)) continue;
    seen.add(entry.dirPath);
    selected.push(entry);
  }
  return selected;
}

function extractFallbackDescription(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.slice(0, 140);
  }
  return "";
}

function isDirectorySafe(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFileSafe(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function listRelativeFiles(baseDir: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = resolve(current, name);
      if (isDirectorySafe(full)) {
        walk(full);
      } else if (isFileSafe(full)) {
        out.push(relative(baseDir, full).replace(/\\/g, "/"));
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return [];
  }
  return out;
}

function listSkillSupportingFiles(skillDir: string): string[] {
  const subdirs = ["references", "examples", "resources", "scripts"];
  const files: string[] = [];
  for (const sub of subdirs) {
    const full = resolve(skillDir, sub);
    if (isDirectorySafe(full)) {
      files.push(...listRelativeFiles(skillDir, full));
    }
  }
  return files;
}
