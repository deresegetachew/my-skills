// A headless sub-manager can post its verdict and read what a review needs (#202). The exact commands the sandbox
// sub-managers tried are run against the real manager profile (Claude Code's allow/deny matching, replayed) and the real
// manager_gate.ts; the skill gives the verdict command; and a review that ends with no verdict does not restart for ever.
// (`factory doctor` replaying the skill's commands against the profile stays in test_manager_verdict.py until
// factory_doctor is ported.)
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fnmatch } from "../hooks/factory_lib.ts";
import { allowedByProfile, gate, PROFILE, SKILL, world as gateWorld } from "./manager_support.ts";
import { cycle, dbOf, H, H2, iso, okRun, posted, pr, prompts, put, runSub, skipComments, world } from "./orchestrator_support.ts";
import type { Row } from "./roles_support.ts";

const PERMS = (JSON.parse(readFileSync(PROFILE, "utf8")) as { permissions: { allow: string[]; deny: string[] } }).permissions;
const SKILL_TEXT = readFileSync(SKILL, "utf8");

function ruleMatches(rule: string, kind: string, subject: string): boolean {
  const m = new RegExp(`^${kind}\\((.*)\\)$`, "s").exec(rule);
  return Boolean(m) && fnmatch(subject, m?.[1] as string);
}

function editAllowed(path: string): boolean {
  return PERMS.allow.some((r) => ruleMatches(r, "Edit", path)) && !PERMS.deny.some((r) => ruleMatches(r, "Edit", path));
}

function gatePasses(command: string): [boolean, string] {
  const [d, env] = gateWorld();
  const [code, msg] = gate(d, env, command);
  return [code === 0, msg];
}

// --- 1. the verdict command ---------------------------------------------------------------------------------------------

const VERDICT_ONE_LINE = `gh api -X POST repos/{owner}/{repo}/issues/15/comments -f body="<!-- factory-mustfix sha=${"a".repeat(40)} -->  Must-fix: tests fail."`;
const VERDICT_FILE = "gh api -X POST repos/{owner}/{repo}/issues/15/comments -F body=@tmp/manager-15.md";
const CLOSE_5 = `gh api -X POST repos/{owner}/{repo}/issues/5/comments -f body="<!-- pr-watch sha=${"a".repeat(40)} -->  Superseded by main."`;

test("a verdict comment through gh api is allowed by the profile and the gate", () => {
  for (const cmd of [VERDICT_ONE_LINE, VERDICT_FILE, CLOSE_5]) {
    expect(allowedByProfile(cmd), cmd).toBe(true);
    const [ok, msg] = gatePasses(cmd);
    expect(ok, `${cmd} ${msg}`).toBe(true);
  }
});

test("the body file can be written under tmp manager and nowhere else", () => {
  expect(editAllowed("tmp/manager-15.md")).toBe(true);
  for (const path of ["tmp/other.md", "src/x.py", ".claude/settings.json", "docs/PRD.md", "/etc/passwd"]) {
    expect(editAllowed(path), path).toBe(false);
  }
});

test("pr comment review and merge stay unavailable so the gh api form is the only one", () => {
  for (const cmd of ["gh pr comment 15 --body x", "gh pr review 5 --request-changes --body x", "gh pr merge 5 --squash"]) {
    expect(allowedByProfile(cmd), cmd).toBe(false);
  }
});

test("a heredoc is still refused by the gate so the skill must not suggest one", () => {
  expect(/<<\s*'?EOF/.test(SKILL_TEXT), "the skill must not tell sub-managers to use a heredoc").toBe(false);
});

test("the skill gives the exact verdict command and the one command per call rule", () => {
  expect(SKILL_TEXT, "step 5 names the verdict command").toContain("gh api -X POST repos/{owner}/{repo}/issues/<n>/comments");
  expect(SKILL_TEXT, "a multi-line body goes through a file").toContain("-F body=@tmp/manager-");
  expect(/never `gh pr comment`/i.test(SKILL_TEXT)).toBe(true);
  expect(SKILL_TEXT).toContain("gh pr review");
  expect(/one command per (Bash|shell) call/i.test(SKILL_TEXT)).toBe(true);
  expect(SKILL_TEXT).toContain("$(");
});

// --- 3. the read commands a review needs -------------------------------------------------------------------------------

test("the reads a review needs are allowed one per call", () => {
  for (const cmd of ["gh run view 123 --log-failed", "git merge-tree origin/main origin/task/5-x", "git ls-tree -r origin/main --name-only",
    "git cat-file -p origin/main:README.md", "git merge-base origin/main origin/task/5-x"]) {
    expect(allowedByProfile(cmd), cmd).toBe(true);
    const [ok, msg] = gatePasses(cmd);
    expect(ok, `${cmd} ${msg}`).toBe(true);
  }
});

test("chained and substituted commands still need every part allowed", () => {
  expect(allowedByProfile("git merge-base a b; rm -rf x")).toBe(false);
  expect(allowedByProfile("git rev-parse HEAD | sh")).toBe(false);
  expect(allowedByProfile("git log $(git rev-parse HEAD)")).toBe(false);
});

// --- 4. a review that ends with no verdict does not restart for ever ---------------------------------------------------

function greenWorld() {
  return world({ db: { pulls: [pr(5)], commits: { [H]: iso(60) }, checks: { [H]: [okRun()] } } });
}

test("a session that ends with no review marks the head failed and asks the owner once", () => {
  const [d, work, env] = greenWorld();
  runSub(work, env);
  const skips = skipComments(d, 5);
  expect(skips.length, posted(d, 5).join("\n---\n")).toBe(1);
  expect(skips[0]).toContain(`<!-- factory-review-failed sha=${H} -->`);
  runSub(work, env);
  const asks = (dbOf(d).issues as Row[]).flatMap((i) => posted(d, i.number as number))
    .filter((b) => b.includes("factory-owner-ask id=review-failed-5"));
  expect(asks.length).toBe(1);
});

test("the next pass does not restart a head marked failed but does for a new commit", () => {
  const [d, work, env] = greenWorld();
  runSub(work, env);
  cycle(work, env, "--wait");
  const callsAfterFirst = prompts(env).length;
  cycle(work, env, "--wait");
  expect(prompts(env).length, "a head marked failed is not started again").toBe(callsAfterFirst);
  put(d, { pulls: [pr(5, { sha: H2 })], commits: { [H2]: iso(60) }, checks: { [H2]: [okRun()] } });
  cycle(work, env, "--wait");
  expect(prompts(env).length, "a new head is reviewed").toBe(callsAfterFirst + 1);
});

test("a conflict or unfinished ci is not marked failed because it can change by itself", () => {
  const [d, work, env] = world({ db: { pulls: [pr(5, { mergeable_state: "dirty" })], commits: { [H]: iso(60) } } });
  runSub(work, env);
  expect(posted(d, 5).filter((b) => b.includes("factory-review-failed"))).toEqual([]);
});

test("a green task pr is started before a pr without green ci", () => {
  const [, work, env] = world({ db: { pulls: [pr(1, { sha: "1".repeat(40), ref: "docs/1" }), pr(2, { sha: "2".repeat(40) })],
    commits: { ["1".repeat(40)]: iso(60), ["2".repeat(40)]: iso(50) }, checks: { ["2".repeat(40)]: [okRun()] } },
  cfg: { manager: { maxSubManagers: 1 } } });
  const p = cycle(work, env, "--dry-run");
  const lines = p.stdout.split("\n").filter((l) => l.includes("would start a sub-manager"));
  expect(lines.length, p.stdout).toBeGreaterThan(0);
  expect(lines[0]).toContain("pr-2");
});
