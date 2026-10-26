// Who merges a green task PR is said in one plain place, and an agent that does not merge points at the dev manager (#201).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT, readmeAndWiki } from "./support.ts";

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next !== -1 ? next : text.length);
}

test("the readme states who merges a green task pr", () => {
  const s = section(readmeAndWiki("reviews-and-gates.md"), "## Reviews and gates");
  expect(s, "no plain statement under Reviews and gates").toContain("Who merges a green task pull request");
  for (const need of ["builder merges its own task pull request", "protected", "the owner", "factory dev-manager loop",
    "task pull requests with green CI"]) expect(s).toContain(need);
});

test("the skill ends an unmerged task with a pointer to the dev manager loop", () => {
  const text = readFileSync(join(KIT, ".claude", "skills", "next-task", "SKILL.md"), "utf8");
  expect(text.includes("not merged") && text.includes("factory dev-manager loop"), "the final message must point at the dev manager").toBe(true);
});
