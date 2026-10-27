// The dev manager closes a superseded or obsolete pull request that a factory agent opened, and asks the owner about one
// anyone else opened (#203). The real manager_gate.ts and the real profile run against the exact commands; a fake gh
// answers for the pull request. A merge is still never allowed by this path.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { allowedByProfile, gate as runGate, HEAD, SKILL, world, type Row } from "./manager_support.ts";

const CLOSE = "gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f state=closed";
const SKILL_TEXT = readFileSync(SKILL, "utf8");

function gate(pr?: Row, command = CLOSE): [number, string] {
  const [d, env] = world({ pr });
  return runGate(d, env, command);
}

test("closing a pull request from a factory agents task branch is allowed by the profile and the gate", () => {
  expect(allowedByProfile(CLOSE)).toBe(true);
  const [code, msg] = gate({ head: { sha: HEAD, ref: "task/12-guard-rails" } });
  expect(code, msg).toBe(0);
});

test("closing works with the field flag spelling and a state in any order", () => {
  for (const cmd of ["gh api -X PATCH repos/{owner}/{repo}/pulls/7 -F state=closed",
    "gh api repos/{owner}/{repo}/pulls/7 --method PATCH --raw-field state=closed -f base=main"]) {
    const [code, msg] = gate(undefined, cmd);
    expect(code, `${cmd} ${msg}`).toBe(0);
  }
});

test("a pull request from anyone elses branch is refused with an owner queue ask", () => {
  for (const ref of ["feature/login", "owner-fix", "docs/readme"]) {
    const [code, msg] = gate({ head: { sha: HEAD, ref } });
    expect(code, `${ref} ${msg}`).toBe(2);
    expect(msg).toContain("owner");
    expect(msg).toContain("factory-owner-ask");
  }
});

test("a pull request from a fork is refused even on a task branch", () => {
  const [code, msg] = gate({ head: { sha: HEAD, ref: "task/12-x", repo: { full_name: "someone/fork" } }, base: { repo: { full_name: "me/repo" } } });
  expect(code, msg).toBe(2);
  expect(msg).toContain("owner");
});

test("the managers own pull request may be closed", () => {
  const [code, msg] = gate({ head: { sha: HEAD, ref: "manager/notes" } });
  expect(code, msg).toBe(0);
});

test("a closed or missing pull request is left to github", () => {
  const [code, msg] = gate({ state: "closed", head: { sha: HEAD, ref: "feature/x" } });
  expect(code, msg).toBe(0);
});

test("retargeting and other edits to a pull request are not closing and are untouched", () => {
  for (const cmd of ["gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f base=main", "gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f state=open"]) {
    const [code, msg] = gate({ head: { sha: HEAD, ref: "feature/x" } }, cmd);
    expect(code, `${cmd} ${msg}`).toBe(0);
  }
});

test("a close the gate cannot read is refused", () => {
  for (const cmd of ["gh api -X PATCH repos/{owner}/{repo}/pulls/7 --input body.json", "gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f state=$S"]) {
    const [code, msg] = gate({ head: { sha: HEAD, ref: "task/12-x" } }, cmd);
    expect(code, `${cmd} ${msg}`).toBe(2);
  }
});

test("merging and gh pr close stay unavailable", () => {
  expect(allowedByProfile("gh pr close 7")).toBe(false);
  expect(allowedByProfile("gh pr merge 7")).toBe(false);
});

test("the skill states both rules and the exact commands", () => {
  expect(SKILL_TEXT).toContain("state=closed");
  expect(SKILL_TEXT).toContain("gh api -X PATCH repos/{owner}/{repo}/pulls/<n>");
  expect(/superseded/.test(SKILL_TEXT) && /task\//.test(SKILL_TEXT), "which pull requests it may close").toBe(true);
  expect(/owner-queue ask/.test(SKILL_TEXT) && /opened by (the owner|a person|anyone else)/i.test(SKILL_TEXT)).toBe(true);
  expect(/comment.*(why|reason).*(commit|sha)/is.test(SKILL_TEXT), "the comment says why and which commit supersedes it").toBe(true);
});
