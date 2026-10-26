// Every subagent in the kit names its model (#54). Only the `reviewer` starts on Sonnet (the owner's decision,
// 24 Oct); the safety and security reviews stay on Opus. The next-task skill re-reviews on Opus only a commit that fixes
// the Sonnet pass's must-fixes, or an item marked unsure, so an Opus pass can't wave a must-fix through unfixed.
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { KIT, read } from "./support.ts";

const CLAUDE_DIR = join(KIT, ".claude");
const AGENTS = join(CLAUDE_DIR, "agents");

function frontmatter(name: string): [Record<string, string>, string] {
  const text = read(join(AGENTS, `${name}.md`));
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`${name}.md has no frontmatter`);
  const meta: Record<string, string> = {};
  for (const l of (m[1] as string).split("\n")) {
    const i = l.indexOf(":");
    if (i >= 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return [meta, text];
}

test("every subagent names its model", () => {
  for (const f of readdirSync(AGENTS).sort()) {
    if (!f.endsWith(".md")) continue;
    const [meta] = frontmatter(f.slice(0, -3));
    expect(["sonnet", "opus", "haiku", "inherit"], f).toContain(meta.model as string);
  }
});

test("only the reviewer starts on sonnet and the safety and security reviews stay on opus", () => {
  expect(frontmatter("reviewer")[0].model).toBe("sonnet");
  for (const name of ["safety-auditor", "security-reviewer"]) expect(frontmatter(name)[0].model, name).toBe("opus");
});

test("the reviewer can say unsure and checks earlier must-fixes before its pass", () => {
  const [, text] = frontmatter("reviewer");
  expect(text).toContain("**unsure**");
  expect(text).toContain("earlier must-fix");
  expect(text).toContain("before you record the pass");
});

test("next-task reviews the fixed commit on opus never the unfixed one", () => {
  const skill = read(join(CLAUDE_DIR, "skills", "next-task", "SKILL.md"));
  const from = skill.indexOf("**The reviewer starts on Sonnet");
  expect(from).toBeGreaterThanOrEqual(0);
  const step = (skill.slice(from).split("\n## ")[0] as string).split(/\s+/).filter(Boolean).join(" ");
  expect(step).toContain('model: "opus"');
  expect(step).toContain("fix it");
  expect(step).toContain("fixed commit");
  expect(step).toContain("only for items it marked **unsure**");
  expect(step).toContain("`safety-auditor` and `security-reviewer` run on Opus");
});
