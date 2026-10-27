// When `gh pr create` fails (GraphQL blocked, as in a claude.ai cloud session), the next-task skill tells the builder
// to stop and report, keeping its claim (#182). It used to name a REST fallback (`gh api ...`, #159), but the agents'
// settings deny `gh api`: it would merge or post review markers around the PR gate (#260). The skill also stays short.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT } from "./support.ts";

const SKILL = join(KIT, ".claude", "skills", "next-task", "SKILL.md");
const LINE_LIMIT = 130; // 111 lines before #159; the skill is the core file and the rest is split into files beside it

const text = (): string => readFileSync(SKILL, "utf8");
const ship = (): string => {
  const t = text();
  return t.slice(t.indexOf("## 4. Ship it"), t.indexOf("## 5."));
};

test("the ship step says what to do when gh pr create fails: stop and report, keep the claim", () => {
  const s = ship();
  expect(s).toContain("gh pr create` fails");
  expect(s).toContain("Stop and report");
  expect(s).toContain("keep your task claim");
});

test("the ship step names no rest fallback and says why", () => {
  const s = ship();
  expect(s).not.toContain("gh api repos/");
  expect(s).toContain("`gh api` is denied");
});

test("the skill stays under its line limit", () => {
  expect(text().replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(LINE_LIMIT);
});
