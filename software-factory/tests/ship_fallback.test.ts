// The next-task skill names a REST fallback for `gh pr create` and `gh pr comment` (#159): where GraphQL is blocked
// (the dev manager's cloud workspace) those fail, and the builder would otherwise improvise. The skill also stays short.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT } from "./support.ts";

const SKILL = join(KIT, ".claude", "skills", "next-task", "SKILL.md");
const LINE_LIMIT = 130; // 111 lines before #159; the skill is the core file and the rest is split into files beside it

const text = (): string => readFileSync(SKILL, "utf8");

test("ship step names the rest call to open a pr", () => {
  const t = text();
  expect(t).toContain("gh pr create` fails");
  expect(t).toContain("gh api repos/{owner}/{repo}/pulls -f title=");
  expect(t.includes("-f head=<branch> -f base=<main>") && t.includes("-F body=@file")).toBe(true);
});

test("ship step names the rest call to comment", () => {
  expect(text()).toContain("gh api repos/{owner}/{repo}/issues/<n>/comments -F body=@file");
});

test("the fallback sits in the ship step", () => {
  const t = text();
  const ship = t.slice(t.indexOf("## 4. Ship it"), t.indexOf("## 5."));
  expect(ship.includes("gh api repos/{owner}/{repo}/pulls") && ship.includes("issues/<n>/comments")).toBe(true);
});

test("the skill stays under its line limit", () => {
  expect(text().replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(LINE_LIMIT);
});
