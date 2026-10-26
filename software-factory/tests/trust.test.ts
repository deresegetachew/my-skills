// `factory_trust.ts check`: is a folder trusted by Claude Code? (#180, #193, #246, #248). A fake ~/.claude.json stands
// in for the user's; it is only read. Below: `factory doctor` says `fix` for the project folder and each agent worktree
// before tokens are spent (the doctor's trust lines).
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inheritedFrom, state } from "../hooks/factory_trust.ts";
import { doctor as runDoctor, machine, project } from "./doctor_support.ts";
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

// --- factory doctor ---------------------------------------------------------------------------------------------------

function doctor(o: { trusted?: string[]; untrusted?: string[]; worktree?: boolean; write?: boolean } = {}): [Proc, string, string, { HOME: string; [k: string]: string }] {
  const d = realpathSync(project({}, { agents: ["taytu"] }));
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  const wt = d + "-agents/taytu";
  if (o.worktree) mkdirSync(wt, { recursive: true });
  if (o.write ?? true) {
    claudeJson(env.HOME as string, (o.trusted ?? []).map((t) => (t === "project" ? d : t === "worktree" ? wt : t)), o.untrusted ?? []);
  }
  return [runDoctor(d, env), d, wt, env];
}

function trustLines(p: Proc): string[] {
  return p.stdout.split("\n").filter((l) => l.toLowerCase().includes("trust") && ["ok", "fix", "note"].includes(l.split(/\s+/)[0] as string));
}

/** `d` gets a commit and a real git worktree at `wt`. */
function gitWorktree(d: string, wt: string): void {
  git(d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
  git(d, "worktree", "add", "-q", "--detach", wt);
}

test("doctor says ok for a trusted project folder", () => {
  const [p] = doctor({ trusted: ["project"] });
  expect(trustLines(p).filter((l) => l.startsWith("ok")).length, p.stdout).toBeGreaterThan(0);
  expect(trustLines(p).filter((l) => l.startsWith("fix")), p.stdout).toEqual([]);
});

test("doctor says fix with the exact step for an untrusted project folder and never prints the config", () => {
  const [p, d, , env] = doctor({ trusted: [] });
  const fixes = trustLines(p).filter((l) => l.startsWith("fix"));
  expect(fixes.length > 0 && fixes[0]!.includes(`cd ${d} && claude`), p.stdout).toBe(true);
  expect(p.code).toBe(1);
  expect(p.stdout + p.stderr).not.toContain("secret");
  const before = readFileSync(join(env.HOME as string, ".claude.json"), "utf8");
  runDoctor(d, env);
  expect(readFileSync(join(env.HOME as string, ".claude.json"), "utf8"), "doctor never writes the config").toBe(before);
});

test("doctor checks each agent worktree that exists", () => {
  let [p, , wt] = doctor({ trusted: ["project"], worktree: true });
  const fixes = trustLines(p).filter((l) => l.startsWith("fix"));
  expect(fixes.length === 1 && fixes[0]!.includes(`cd ${wt} && claude`), p.stdout).toBe(true);
  [p] = doctor({ trusted: ["project", "worktree"], worktree: true });
  expect(trustLines(p).filter((l) => l.startsWith("fix")), p.stdout).toEqual([]);
});

test("doctor says a folder inside a trusted folder is trusted", () => {
  const [p] = doctor({ trusted: [join(realpathSync(project()), "..")] });
  expect(trustLines(p).filter((l) => l.startsWith("fix")), p.stdout).toEqual([]);
});

test("doctor with no claude json gives only a note", () => {
  const [p] = doctor({ write: false });
  expect(trustLines(p).filter((l) => l.startsWith("fix")).length === 0 && p.code === 0, p.stdout).toBe(true);
  expect(trustLines(p).filter((l) => l.startsWith("note")).length, p.stdout).toBeGreaterThan(0);
});

test("doctor says a git worktree of a trusted main repo is trusted and the check says so", () => {
  // #246: the agent folders sit beside the project, not under it, and Claude Code wrote no trust entry for them.
  const d = realpathSync(project({}, { agents: ["taytu"] }));
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  const wt = d + "-agents/taytu";
  gitWorktree(d, wt);
  const path = claudeJson(env.HOME as string, [d]);
  const before = readFileSync(path, "utf8");
  const p = runDoctor(d, env);
  const ls = trustLines(p);
  expect(ls.filter((l) => l.startsWith("fix")), p.stdout).toEqual([]);
  expect(ls.some((l) => l.startsWith("ok") && l.includes(wt) && l.includes("worktree") && l.includes(d)), p.stdout).toBe(true);
  expect(ls.some((l) => l.includes(`(a git worktree of ${d}, which is trusted; Claude Code writes no entry for a worktree)`)), p.stdout).toBe(true);
  expect(readFileSync(path, "utf8"), "read only").toBe(before);
});

test("doctor says a git worktree of an untrusted main repo is not trusted", () => {
  const d = realpathSync(project({}, { agents: ["taytu"] }));
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  gitWorktree(d, d + "-agents/taytu");
  claudeJson(env.HOME as string, []);
  const p = runDoctor(d, env);
  expect(trustLines(p).filter((l) => l.startsWith("fix")).length, p.stdout).toBe(2); // the project and its worktree
});

test("doctor says a plain folder beside a trusted project is still untrusted", () => {
  const [p, , wt] = doctor({ trusted: ["project"], worktree: true }); // worktree: true makes a plain folder, not a git worktree
  expect(trustLines(p).some((l) => l.startsWith("fix") && l.includes(wt)), p.stdout).toBe(true);
});
