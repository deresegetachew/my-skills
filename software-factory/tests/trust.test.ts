// `factory_trust.ts check`: is a folder trusted by Claude Code? (#180, #193, #246, #248). A fake ~/.claude.json stands
// in for the user's; it is only read. The doctor's trust lines (tests/test_trust.py) are the doctor family's to port.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inheritedFrom, state } from "../hooks/factory_trust.ts";
import { gitRepo, runHook, tmp, git, type Proc } from "./support.ts";

function claudeJson(home: string, trusted: string[] = [], untrusted: string[] = []): string {
  const projects: Record<string, unknown> = {};
  for (const p of trusted) projects[realpathSync(p)] = { hasTrustDialogAccepted: true };
  for (const p of untrusted) projects[realpathSync(p)] = { hasTrustDialogAccepted: false, allowedTools: ["secret-token-xyz"] };
  const path = join(home, ".claude.json");
  writeFileSync(path, JSON.stringify({ projects, oauthAccount: { emailAddress: "secret@example.com" } }));
  return path;
}

/** A git project and, beside it, `<project>-agents/taytu`: a real git worktree (worktree) or a plain folder. */
function layout(kind: "worktree" | "folder" | "none" = "none"): [string, string, string] {
  const base = realpathSync(tmp());
  mkdirSync(join(base, "project"));
  const d = gitRepo(join(base, "project"));
  const wt = d + "-agents/taytu";
  if (kind === "worktree") git(d, "worktree", "add", "-q", "--detach", wt);
  if (kind === "folder") mkdirSync(wt, { recursive: true });
  const home = join(base, "home");
  mkdirSync(home);
  return [d, wt, home];
}

function check(path: string, home: string): Proc {
  return runHook("factory_trust", ["check", path], { env: { ...process.env, HOME: home } });
}

test("a trusted project folder passes", () => {
  const [d, , home] = layout();
  claudeJson(home, [d]);
  const p = check(d, home);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toBe("");
});

test("an untrusted folder is a code message fix line with the exact step and never prints the config", () => {
  const [d, , home] = layout();
  const path = claudeJson(home, [], [d]);
  const before = readFileSync(path, "utf8");
  const p = check(d, home);
  expect(p.code, p.out).toBe(1);
  const err = JSON.parse(p.stdout) as Record<string, string>;
  expect(Object.keys(err).sort()).toEqual(["code", "fix", "message"]);
  expect(err.code).toBe("folder_not_trusted");
  expect(err.fix).toContain(`cd ${d} && claude`);
  expect(p.out).not.toContain("secret");
  expect(readFileSync(path, "utf8"), "the check never writes the config").toBe(before);
});

test("an agent folder that is not a git worktree needs its own trust", () => {
  const [d, wt, home] = layout("folder");
  claudeJson(home, [d]);
  const p = check(wt, home);
  expect(p.code === 1 && p.stdout.includes(`cd ${wt} && claude`), p.out).toBe(true);
  claudeJson(home, [d, wt]);
  expect(check(wt, home).code).toBe(0);
});

test("a folder inside a trusted folder is trusted", () => {
  const [d, , home] = layout();
  claudeJson(home, [join(d, "..")]);
  expect(check(d, home).code).toBe(0);
});

test("no claude json means it cannot judge and the run goes ahead", () => {
  const [d, , home] = layout();
  const p = check(d, home);
  expect(p.code === 0 && p.stdout === "", p.out).toBe(true);
  writeFileSync(join(home, ".claude.json"), "not json");
  expect(check(d, home).code).toBe(0);
});

// #246, #248: the agent worktrees sit beside the project, not under it, and Claude Code writes no trust entry for them
// (and shows no trust question there): a git worktree whose main working tree is trusted is trusted.
test("a git worktree of a trusted main repo is trusted", () => {
  const [d, wt, home] = layout("worktree");
  const path = claudeJson(home, [d]);
  const before = readFileSync(path, "utf8");
  const p = check(wt, home);
  expect(p.code, p.out).toBe(0);
  expect(readFileSync(path, "utf8"), "read only").toBe(before);
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(state(wt)).toBe("trusted");
    expect(inheritedFrom(wt), "so the doctor can say which tree it inherits from").toBe(d);
    expect(inheritedFrom(d), "trusted on its own account").toBeNull();
    mkdirSync(join(wt, "src"));
    expect(state(join(wt, "src"))).toBe("trusted"); // a folder inside the worktree
  } finally {
    process.env.HOME = prev;
  }
});

test("a git worktree of an untrusted main repo is not trusted", () => {
  const [d, wt, home] = layout("worktree");
  claudeJson(home, [], [d]);
  const p = check(wt, home);
  expect(p.code === 1 && p.stdout.includes(`cd ${wt} && claude`), p.out).toBe(true);
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(inheritedFrom(wt)).toBeNull();
  } finally {
    process.env.HOME = prev;
  }
});

test("a plain folder beside a trusted project is still untrusted", () => {
  const [d, wt, home] = layout("folder");
  claudeJson(home, [d]);
  expect(check(wt, home).code).toBe(1);
});

test("without check it prints its usage and fails", () => {
  const p = runHook("factory_trust", []);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("factory_trust.ts check");
});
