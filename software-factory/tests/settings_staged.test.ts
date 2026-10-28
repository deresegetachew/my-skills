// #306: `factory settings set --stage`, `diff --staged`, `unstage` and one `pr` for everything staged.
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HOOKS, KIT, type Proc, read, readJson, runBun, SF, sh, tmp, WIKI, write, writeExe } from "./support.ts";

type Env = Record<string, string | undefined>;
const SETTINGS = join(HOOKS, "factory_settings.ts");

function project(cfg?: unknown): string {
  const d = tmp();
  sh(["git", "init", "-q", d]);
  mkdirSync(join(d, ".claude"));
  if (cfg !== undefined) write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  return d;
}

function personEnv(): Env {
  const env: Env = { ...process.env };
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) delete env[name];
  return env;
}

function withEnv(d: string, extra: Env = {}): Env {
  const env = personEnv();
  env.FACTORY_CONFIG_DIR = join(d, "machine-config");
  delete env.FACTORY_AGENTS;
  delete env.FACTORY_REMOTE_CONTROL;
  return { ...env, ...extra };
}

function settings(d: string, args: string[], env?: Env): Proc {
  return runBun(SETTINGS, args, { cwd: d, env: env ?? withEnv(d) });
}

function saved(d: string): Record<string, unknown> {
  return readJson(join(d, ".claude", "factory.json"));
}

const FAKE_GH_PR = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.GH_LOG as string, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "pr" && process.argv[3] === "create") console.log("https://github.com/o/r/pull/7");
`;

function gitProject(cfg: unknown): [string, string, Env] {
  const d = project(cfg);
  const run = (...a: string[]): void => {
    const p = sh(a, { cwd: d });
    if (p.code !== 0) throw new Error(`${a.join(" ")}: ${p.out}`);
  };
  run("git", "checkout", "-q", "-b", "main");
  run("git", "add", "-A");
  run("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  const remote = tmp();
  sh(["git", "init", "-q", "--bare", remote]);
  run("git", "remote", "add", "origin", remote);
  run("git", "push", "-q", "origin", "main");
  const bindir = join(dirname(d), "bin-" + basename(d));
  writeExe(join(bindir, "gh"), FAKE_GH_PR);
  const env = withEnv(d, { GH_LOG: join(dirname(d), "gh-" + basename(d) + ".log"), PATH: `${bindir}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  return [d, remote, env];
}

function remoteBranches(d: string): string[] {
  return sh(["git", "ls-remote", "--heads", "origin", "settings/*"], { cwd: d }).stdout.split("\n").filter(Boolean)
    .map((l) => l.split(/\s+/)[1] as string);
}

function shown(remote: string, ref: string, path: string): string {
  return sh(["git", "--git-dir", remote, "show", `${ref}:${path}`]).stdout;
}

function ghLog(env: Env): string {
  try { return read(env.GH_LOG as string); } catch { return ""; }
}

function status(d: string): string {
  return sh(["git", "status", "--porcelain"], { cwd: d }).stdout.trim();
}

function branch(d: string): string {
  return sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: d }).stdout.trim();
}

function stagingFile(d: string): string {
  const common = sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: d }).stdout.trim();
  return join(common, "factory", "settings-staged.json");
}

function expectError(p: Proc): { code: string; message: string; fix: string } {
  expect(p.code).toBe(1);
  const e = JSON.parse(p.stderr.trim()) as { code: string; message: string; fix: string };
  expect(typeof e.code).toBe("string");
  expect(typeof e.message).toBe("string");
  expect(typeof e.fix).toBe("string");
  return e;
}

test("set --stage and unset --stage leave the file alone and say how to open the pr", () => {
  const d = project({ maxOpenPRs: 4, agents: ["ada"] });
  const before = saved(d);
  let p = settings(d, ["set", "--stage", "maxOpenPRs", "5"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("staged");
  expect(p.stdout).toContain("factory settings pr");
  p = settings(d, ["unset", "--stage", "agents"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("staged");
  expect(saved(d)).toEqual(before);
  const diff = settings(d, ["diff", "--staged"]);
  expect(diff.code).toBe(0);
  expect(diff.stdout).toContain("maxOpenPRs");
  expect(diff.stdout).toContain("5");
  expect(diff.stdout).toContain("agents");
});

test("an invalid value is refused and nothing is staged", () => {
  const d = project({ maxOpenPRs: 4 });
  const p = settings(d, ["set", "--stage", "maxOpenPRs", "notanumber"]);
  expect(p.code).not.toBe(0);
  const diff = settings(d, ["diff", "--staged"]);
  expect(diff.code).toBe(0);
  expect(diff.stdout.toLowerCase()).toContain("nothing");
});

test("diff --staged with nothing staged says so", () => {
  const d = project({ maxOpenPRs: 4 });
  const p = settings(d, ["diff", "--staged"]);
  expect(p.code).toBe(0);
  expect(p.stdout.toLowerCase()).toContain("nothing");
});

test("pr opens one pull request for every staged change and leaves the person's tree alone", () => {
  const [d, remote, env] = gitProject({ maxOpenPRs: 4, testPaths: ["^t/"], agents: ["ada"] });
  expect(settings(d, ["set", "--stage", "maxOpenPRs", "5"], env).code).toBe(0);
  expect(settings(d, ["set", "--stage", "testPaths", '["^t/","^e2e/"]'], env).code).toBe(0);
  expect(settings(d, ["unset", "--stage", "agents"], env).code).toBe(0);
  const mainBefore = shown(remote, "main", ".claude/factory.json");
  const p = settings(d, ["pr"], env);
  expect(p.code).toBe(0);
  const branches = remoteBranches(d);
  expect(branches.length).toBe(1);
  const pushed = JSON.parse(shown(remote, branches[0] as string, ".claude/factory.json"));
  expect(pushed).toEqual({ maxOpenPRs: 5, testPaths: ["^t/", "^e2e/"] });
  expect(shown(remote, "main", ".claude/factory.json")).toBe(mainBefore);
  const log = ghLog(env);
  expect(log.split("\n").filter((l) => l.startsWith("pr create")).length).toBe(1);
  for (const key of ["maxOpenPRs", "testPaths", "agents"]) expect(log).toContain(key);
  expect(status(d)).toBe("");
  expect(branch(d)).toBe("main");
  expect(settings(d, ["diff", "--staged"], env).stdout.toLowerCase()).toContain("nothing");
});

test("pr works from another branch, builds from origin/main and leaves the person there", () => {
  const [d, remote, env] = gitProject({ maxOpenPRs: 4 });
  sh(["git", "checkout", "-q", "-b", "feature"], { cwd: d });
  expect(settings(d, ["set", "--stage", "maxOpenPRs", "5"], env).code).toBe(0);
  const p = settings(d, ["pr"], env);
  expect(p.code).toBe(0);
  const branches = remoteBranches(d);
  expect(branches.length).toBe(1);
  expect(JSON.parse(shown(remote, branches[0] as string, ".claude/factory.json"))).toEqual({ maxOpenPRs: 5 });
  expect(branch(d)).toBe("feature");
  expect(status(d)).toBe("");
});

test("pr is built from the fresh origin/main when main has moved on", () => {
  const [d, remote, env] = gitProject({ maxOpenPRs: 4, testPaths: ["^t/"] });
  expect(settings(d, ["set", "--stage", "maxOpenPRs", "5"], env).code).toBe(0);
  const other = tmp();
  expect(sh(["git", "clone", "-q", "-b", "main", remote, other]).code).toBe(0);
  write(join(other, ".claude", "factory.json"), JSON.stringify({ maxOpenPRs: 4, testPaths: ["^t/", "^x/"] }));
  for (const a of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "other"], ["push", "-q", "origin", "HEAD:main"]]) {
    expect(sh(["git", ...a], { cwd: other }).code).toBe(0);
  }
  const p = settings(d, ["pr"], env);
  expect(p.code).toBe(0);
  const branches = remoteBranches(d);
  expect(branches.length).toBe(1);
  expect(JSON.parse(shown(remote, branches[0] as string, ".claude/factory.json"))).toEqual({ maxOpenPRs: 5, testPaths: ["^t/", "^x/"] });
  const log = ghLog(env);
  expect(log).toContain("maxOpenPRs");
  expect(log).not.toContain("testPaths");
});

test("a staged value that is no longer valid, or a key that is gone, stops the pr and keeps the staging", () => {
  for (const bad of [{ maxOpenPRs: { value: "lots" } }, { noSuchKey: { value: 1 } }]) {
    const [d, remote, env] = gitProject({ maxOpenPRs: 4 });
    const key = Object.keys(bad)[0] as string;
    expect(settings(d, ["set", "--stage", "maxOpenPRs", "5"], env).code).toBe(0);
    write(stagingFile(d), JSON.stringify({ schema: "factory-settings-staged/1", changes: bad }));
    const p = settings(d, ["pr"], env);
    const e = expectError(p);
    expect(e.message).toContain(key);
    expect(e.fix).toContain(`factory settings unstage ${key}`);
    expect(remoteBranches(d)).toEqual([]);
    expect(ghLog(env)).not.toContain("pr create");
    expect(settings(d, ["diff", "--staged"], env).stdout).toContain(key);
    expect(status(d)).toBe("");
    expect(shown(remote, "main", ".claude/factory.json")).toBeTruthy();
  }
});

test("unstage drops one change, or all of them with no key", () => {
  const d = project({ maxOpenPRs: 4, testPaths: ["^t/"] });
  settings(d, ["set", "--stage", "maxOpenPRs", "5"]);
  settings(d, ["set", "--stage", "testPaths", '["^e2e/"]']);
  let p = settings(d, ["unstage", "maxOpenPRs"]);
  expect(p.code).toBe(0);
  let diff = settings(d, ["diff", "--staged"]).stdout;
  expect(diff).not.toContain("maxOpenPRs");
  expect(diff).toContain("testPaths");
  p = settings(d, ["unstage"]);
  expect(p.code).toBe(0);
  diff = settings(d, ["diff", "--staged"]).stdout;
  expect(diff.toLowerCase()).toContain("nothing");
});

test("machine settings are saved at once and never staged", () => {
  const d = project({ agents: ["ada", "grace"] });
  const env = withEnv(d);
  const p = settings(d, ["--local", "set", "--stage", "agents", "ada"], env);
  expect(p.code).toBe(0);
  expect(p.stdout.toLowerCase()).toMatch(/at once|not staged/);
  const dir = env.FACTORY_CONFIG_DIR as string;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  expect(readJson<Record<string, unknown>>(join(dir, files[0] as string)).agents).toEqual(["ada"]);
  expect(saved(d)).toEqual({ agents: ["ada", "grace"] });
  expect(settings(d, ["diff", "--staged"], env).stdout.toLowerCase()).toContain("nothing");
});

test("an agent session cannot stage, unstage or open the pr", () => {
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    const [d, , env0] = gitProject({ maxOpenPRs: 4 });
    const env = { ...env0, [name]: "1" };
    for (const args of [["set", "--stage", "maxOpenPRs", "5"], ["unset", "--stage", "maxOpenPRs"], ["unstage"], ["pr"]]) {
      const p = settings(d, args, env);
      expect(p.code, `${name} ${args.join(" ")}`).not.toBe(0);
      expect(p.out, `${name} ${args.join(" ")}`).toContain("only a person");
    }
    expect(settings(d, ["diff", "--staged"], env0).stdout.toLowerCase()).toContain("nothing");
  }
});

test("pr refuses when there is also an uncommitted edit of the settings file", () => {
  const [d, , env] = gitProject({ maxOpenPRs: 4 });
  expect(settings(d, ["set", "--stage", "maxOpenPRs", "5"], env).code).toBe(0);
  expect(settings(d, ["set", "testPaths", '["^t/"]'], env).code).toBe(0);
  expectError(settings(d, ["pr"], env));
  expect(remoteBranches(d)).toEqual([]);
  expect(ghLog(env)).not.toContain("pr create");
});

test("a failed push leaves no branch or worktree behind and keeps the staging", () => {
  const [d, remote, env] = gitProject({ maxOpenPRs: 4 });
  expect(settings(d, ["set", "--stage", "maxOpenPRs", "5"], env).code).toBe(0);
  sh(["git", "fetch", "-q", "origin"], { cwd: d });
  sh(["git", "config", "remote.origin.pushurl", join(tmp(), "gone")], { cwd: d });
  const e = expectError(settings(d, ["pr"], env));
  expect(e.fix).toContain("factory settings pr");
  expect(sh(["git", "branch", "--list", "settings/*"], { cwd: d }).stdout.trim()).toBe("");
  expect(sh(["git", "worktree", "list"], { cwd: d }).stdout.trim().split("\n").length).toBe(1);
  expect(ghLog(env)).not.toContain("pr create");
  expect(settings(d, ["diff", "--staged"], env).stdout).toContain("maxOpenPRs");
  expect(shown(remote, "main", ".claude/factory.json")).toBe(JSON.stringify({ maxOpenPRs: 4 }));
  expect(status(d)).toBe("");
});

test("the pr gate blocks staging and unstaging but not listing what is staged", () => {
  const gate = (command: string): Proc =>
    runBun(join(HOOKS, "pr-gate.ts"), [], { input: JSON.stringify({ tool_input: { command } }), env: personEnv() });
  for (const command of ["factory settings set --stage maxOpenPRs 5", "./factory settings unset --stage agents",
    "factory settings --stage set maxOpenPRs 5", "factory settings unstage", "factory settings unstage maxOpenPRs",
    "bun --no-env-file .claude/hooks/factory_settings.ts unstage"]) {
    const p = gate(command);
    expect(p.code, command).toBe(2);
    expect(p.stderr, command).toContain("settings");
  }
  for (const command of ["factory settings diff --staged", "./factory settings diff --staged"]) expect(gate(command).code, command).toBe(0);
});

test("a staged name that is only an object property is not a setting", () => {
  const [d, , env] = gitProject({ maxOpenPRs: 4 });
  expect(settings(d, ["set", "--stage", "maxOpenPRs", "5"], env).code).toBe(0);
  write(stagingFile(d), JSON.stringify({ schema: "factory-settings-staged/1", changes: { constructor: { value: 1 } } }));
  const e = expectError(settings(d, ["pr"], env));
  expect(e.fix).toContain("factory settings unstage constructor");
  expect(remoteBranches(d)).toEqual([]);
});

test("factory help prints the staging commands", () => {
  const p = sh(["bash", join(SF, "factory"), "help"], { cwd: project() });
  expect(p.code).toBe(0);
  for (const part of ["settings set --stage", "settings diff --staged", "settings unstage [<key>]"]) expect(p.stdout).toContain(part);
});

test("pr picks a free branch name when origin already has one from another machine", () => {
  const [d, remote, env] = gitProject({ maxOpenPRs: 4 });
  sh(["git", "push", "-q", "origin", "main:settings/maxopenprs"], { cwd: d });
  expect(settings(d, ["set", "--stage", "maxOpenPRs", "5"], env).code).toBe(0);
  const p = settings(d, ["pr"], env);
  expect(p.code, p.out).toBe(0);
  expect(remoteBranches(d).sort()).toEqual(["refs/heads/settings/maxopenprs", "refs/heads/settings/maxopenprs-2"]);
  expect(JSON.parse(shown(remote, "settings/maxopenprs-2", ".claude/factory.json"))).toEqual({ maxOpenPRs: 5 });
});

test("the help and the commands page list the staging commands", () => {
  const help = read(join(SF, "factory"));
  expect(help).toContain("settings set --stage");
  expect(help).toContain("settings unstage");
  const page = read(join(WIKI, "commands.md"));
  expect(page).toContain("--stage");
  expect(page).toContain("unstage");
});
