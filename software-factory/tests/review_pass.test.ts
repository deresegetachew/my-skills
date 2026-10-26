// `factory review-pass` (#197): a review agent records its pass with one allowed command, and the review agents'
// documented steps use only commands the kit's allow list covers.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fnmatch } from "../hooks/factory_lib.ts";
import { KIT as KIT_ROOT, readmeAndWiki, runHook, SF, sh, tmp, write } from "./support.ts";

const FACTORY = join(SF, "factory");
const KIT = join(KIT_ROOT, ".claude");
const ENV: Record<string, string | undefined> = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  CLAUDE_PROJECT_DIR: undefined,
};

function git(d: string, ...a: string[]): string {
  const p = sh(["git", ...a], { cwd: d, env: ENV });
  if (p.code !== 0) throw new Error(`git ${a.join(" ")}: ${p.out}`);
  return p.stdout.trim();
}

function project(branch = "task/9-x"): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ reviewMarkers: "tmp/reviews" }));
  write(join(d, "a.txt"), "a\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "one");
  git(d, "checkout", "-q", "-b", branch);
  return d;
}

function run(d: string, ...a: string[]) {
  return runHook("factory_review_pass", a, { cwd: d, env: ENV });
}

test("reviewer marker holds head", () => {
  const d = project();
  const p = run(d, "reviewer");
  expect(p.code, p.stderr).toBe(0);
  expect(readFileSync(join(d, "tmp", "reviews", "task_9-x.ok"), "utf8").trim()).toBe(git(d, "rev-parse", "HEAD"));
});

test("arch marker is separate", () => {
  const d = project();
  expect(run(d, "arch").code).toBe(0);
  expect(statSync(join(d, "tmp", "reviews", "task_9-x.arch.ok")).isFile()).toBe(true);
  expect(existsSync(join(d, "tmp", "reviews", "task_9-x.ok"))).toBe(false);
});

test("marker follows a new commit", () => {
  const d = project();
  run(d, "reviewer");
  write(join(d, "b.txt"), "b\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "two");
  run(d, "reviewer");
  expect(readFileSync(join(d, "tmp", "reviews", "task_9-x.ok"), "utf8").trim()).toBe(git(d, "rev-parse", "HEAD"));
});

test("unknown kind and detached head are refused with a fix", () => {
  const d = project();
  let p = run(d, "nonsense");
  expect(p.code, p.out).toBe(1);
  expect((JSON.parse(p.stderr) as { fix: string }).fix).toBeTruthy();
  git(d, "checkout", "-q", "--detach");
  p = run(d, "reviewer");
  expect(p.code, p.out).toBe(1);
  expect((JSON.parse(p.stderr) as { code: string }).code).toBe("no-branch");
  expect(existsSync(join(d, "tmp"))).toBe(false);
});

test("factory command and help", () => {
  expect(readFileSync(FACTORY, "utf8").split(/\s+/).join(" ")).toContain('review-pass) py factory_review_pass.py "$@"');
  const h = sh(["bash", FACTORY, "help"], { env: ENV }).stdout;
  expect(h).toContain("review-pass");
  expect(readmeAndWiki()).toContain("factory review-pass");
});

interface Settings {
  permissions: { allow: string[] };
}

function allowed(): string[] {
  const s = (JSON.parse(readFileSync(join(KIT, "settings.json"), "utf8")) as Settings).permissions.allow;
  return s.filter((x) => x.startsWith("Bash(")).map((x) => (/^Bash\((.*)\)$/s.exec(x) as RegExpExecArray)[1] as string);
}

/** The commands in an agent file's fenced bash blocks. */
function agentCommands(name: string): string[] {
  const text = readFileSync(join(KIT, "agents", name), "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of (m[1] as string).split("\n")) {
      const cmd = (line.split("   #")[0] as string).trim();
      if (cmd) out.push(cmd);
    }
  }
  return out;
}

test("review agents use only allowed unchained commands", () => {
  const pats = allowed();
  for (const name of readdirSync(join(KIT, "agents")).sort()) {
    for (const cmd of agentCommands(name)) {
      expect(/&&|;|\||\$\(|`|>/.test(cmd), `${name}: chained shell: ${cmd}`).toBe(false);
      expect(pats.some((p) => fnmatch(cmd, p)), `${name}: not on the allow list: ${cmd}`).toBe(true);
    }
  }
});

test("pass commands are documented and pr body dir is allowed", () => {
  for (const [name, kind] of [["reviewer.md", "reviewer"], ["architecture-reviewer.md", "arch"]] as const) {
    expect(agentCommands(name)).toContain(`bun --no-env-file .claude/hooks/factory_review_pass.ts ${kind}`);
  }
  const s = (JSON.parse(readFileSync(join(KIT, "settings.json"), "utf8")) as Settings).permissions.allow;
  expect(s).toContain("Edit(tmp/**)");
});
