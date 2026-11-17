import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatSkillsIndexBlock,
  loadZoneSkills,
  parseSkillDocument,
  readSkillContent,
  selectWorkerSkills,
} from "../src/skills/loader.js";

test("parseSkillDocument extracts frontmatter scalars, folded blocks, and markdown body", () => {
  const doc = parseSkillDocument(`---
name: "travel-notes"
description: >-
  Summarize trip itineraries
  and local transit reminders.
---

# Travel Notes
Always check timezone first.
`);

  assert.equal(doc.frontmatter.name, "travel-notes");
  assert.equal(
    doc.frontmatter.description,
    "Summarize trip itineraries and local transit reminders.",
  );
  assert.match(doc.body, /# Travel Notes/);
  assert.match(doc.body, /Always check timezone first\./);
});

test("SkillLoader isolates personal vs worker zones, sorts deterministically, and guards paths", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-skills-"));
  try {
    const personalAlpha = join(tempDir, "personal", "alpha");
    const personalBeta = join(tempDir, "personal", "beta");
    const personalDisabled = join(tempDir, "personal", "hidden");
    const workerDeploy = join(tempDir, "worker", "deploy-check");

    mkdirSync(join(personalAlpha, "references"), { recursive: true });
    mkdirSync(personalBeta, { recursive: true });
    mkdirSync(personalDisabled, { recursive: true });
    mkdirSync(workerDeploy, { recursive: true });

    writeFileSync(
      join(personalBeta, "SKILL.md"),
      `---\nname: beta\ndescription: Beta personal helper\n---\nBeta body`,
      "utf8",
    );
    writeFileSync(
      join(personalAlpha, "SKILL.md"),
      `---\nname: alpha\ndescription: Alpha personal helper\n---\nAlpha body`,
      "utf8",
    );
    writeFileSync(join(personalAlpha, "references", "guide.md"), "Reference details", "utf8");
    writeFileSync(
      join(personalDisabled, "SKILL.md"),
      `---\nname: hidden\ndisable_model_invocation: true\ndescription: Hidden\n---\nSecret`,
      "utf8",
    );
    writeFileSync(
      join(workerDeploy, "SKILL.md"),
      `---\nname: deploy-check\ndescription: Verify production rollout\n---\nWorker instructions`,
      "utf8",
    );

    const personalSkills = loadZoneSkills(tempDir, "personal");
    assert.deepEqual(
      personalSkills.map((s) => s.name),
      ["alpha", "beta"],
    );
    assert.equal(personalSkills[0]?.hasReferences, true);
    assert.equal(personalSkills[1]?.hasReferences, false);

    const indexText = formatSkillsIndexBlock(personalSkills);
    assert.match(indexText, /<available_skills>/);
    assert.match(indexText, /- alpha: Alpha personal helper/);
    assert.match(indexText, /- beta: Beta personal helper/);
    assert.doesNotMatch(indexText, /deploy-check/);

    const readMain = readSkillContent(tempDir, "personal", "alpha");
    assert.equal(readMain.filePath, "SKILL.md");
    assert.match(readMain.content, /Alpha body/);
    assert.deepEqual(readMain.references, ["references/guide.md"]);

    const readRef = readSkillContent(tempDir, "personal", "alpha", "references/guide.md");
    assert.equal(readRef.filePath, "references/guide.md");
    assert.equal(readRef.content, "Reference details");

    // Cross-zone access & traversal must fail
    assert.throws(() => readSkillContent(tempDir, "personal", "deploy-check"), /未找到/);
    assert.throws(() => readSkillContent(tempDir, "personal", "alpha", "../beta/SKILL.md"), /不允许/);
    assert.throws(() => readSkillContent(tempDir, "personal", "../worker/deploy-check"), /非法 Skill 名称/);

    // Worker selection
    const selected = selectWorkerSkills(tempDir, ["deploy-check", "missing-skill"]);
    assert.deepEqual(
      selected.map((s) => s.name),
      ["deploy-check"],
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
