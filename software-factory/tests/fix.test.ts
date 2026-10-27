// Auto-format and auto-fix the changed files before the checks (#69): `commands.fix` runs on the files this branch
// changed and no others, the agent hears one line, the Stop check and `factory verify` run it first.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOOKS, KIT, runHook, SF, sh, tmp, write, writeExe } from "./support.ts";

const ENV: Record<string, string | undefined> = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDECODE: undefined, CLAUDE_PROJECT_DIR: undefined,
};

// The "formatter": strips trailing spaces from the files it is given, and logs which files it was given.
const FORMATTER = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const names = process.argv.slice(2);
appendFileSync("fixer.log", names.join(" ") + "\\n");
for (const name of names) {
  const text = readFileSync(name, "utf8");
  const lines = text.split("\\n"); if (lines[lines.length - 1] === "") lines.pop();
  writeFileSync(name, lines.map((l) => l.trimEnd() + "\\n").join(""));
}
`;
const FMT = `${JSON.stringify(process.execPath)} fmt.ts`;
const FAKE_GH = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
if (a[0] === "api") { console.log(readFileSync(process.env.MAIN_SETTINGS as string, "utf8")); process.exit(0); }
console.error("fake gh"); process.exit(1);
`;

function git(d: string, ...a: string[]): string {
  const p = sh(["git", ...a], { cwd: d, env: ENV });
  if (p.code !== 0) throw new Error(`git ${a.join(" ")}: ${p.out}`);
  return p.stdout.trim();
}

function put(d: string, rel: string, text: string): void {
  write(join(d, rel), text);
}

/** Main holds untidy.ts (untidy on purpose) and a clean tree; the task branch starts from it. */
function project(fix = `${FMT} {files}`, extra: Record<string, unknown> = {}, commands: Record<string, string> = {}): string {
  const top = tmp();
  const d = join(top, "proj");
  mkdirSync(d);
  git(d, "init", "-q", "-b", "main");
  const cfg = { codePaths: ["src"], commands: { fix, test: "true", ...commands }, ...extra };
  put(d, ".claude/factory.json", JSON.stringify(cfg));
  mkdirSync(join(d, ".claude", "hooks"));
  for (const f of readdirSync(HOOKS)) { // as a project that links the kit has them
    if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  }
  put(d, "fmt.ts", FORMATTER);
  put(d, ".gitignore", "tmp/\nfixer.log\n.claude/hooks/\n");
  put(d, "src/untidy.ts", "unrelated   \n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "start");
  git(d, "checkout", "-q", "-b", "task/1-x");
  return d;
}

function fix(d: string, ...args: string[]) {
  return runHook("factory_fix", args, { cwd: d, env: { ...ENV, CLAUDE_PROJECT_DIR: d } });
}

function fixedFiles(d: string): string[] {
  const p = join(d, "fixer.log");
  return existsSync(p) ? readFileSync(p, "utf8").split(/\s+/).filter(Boolean) : [];
}

const text = (d: string, rel: string): string => readFileSync(join(d, rel), "utf8");

test("only files changed on the branch are touched", () => {
  const d = project();
  put(d, "src/a.ts", "committed   \n");
  git(d, "add", "-A"); git(d, "commit", "-qm", "a"); // committed on the branch
  put(d, "src/b.ts", "new file   \n"); // untracked
  put(d, "src/c.ts", "x\n"); git(d, "add", "-A"); git(d, "commit", "-qm", "c");
  put(d, "src/c.ts", "edited   \n"); // edited after the commit
  const r = fix(d);
  expect(r.code, r.stderr).toBe(0);
  expect(fixedFiles(d).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  expect(text(d, "src/untidy.ts")).toBe("unrelated   \n"); // an unchanged file must not churn
  expect(text(d, "src/a.ts")).toBe("committed\n");
});

test("the agent hears one line and no diff", () => {
  const d = project();
  put(d, "src/a.ts", "one  \n"); put(d, "src/b.ts", "two  \n"); put(d, "src/ok.ts", "fine\n");
  const r = fix(d);
  expect(r.stdout.trim(), r.out).toBe("formatted 2 files");
  expect(r.stderr).toBe("");
  put(d, "src/a.ts", "one  \n");
  expect(fix(d).stdout.trim()).toBe("formatted 1 file");
});

test("nothing changed means nothing runs and nothing is said", () => {
  const d = project();
  const r = fix(d);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.trim()).toBe("nothing to format");
  expect(fixedFiles(d)).toEqual([]);
});

test("without commands fix it does nothing and says how to set it", () => {
  const d = project("");
  put(d, "src/a.ts", "x  \n");
  const r = fix(d);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("commands.fix isn't set");
  expect(r.stdout).toContain("{files}");
  expect(text(d, "src/a.ts")).toBe("x  \n");
});

test("deleted files and fixpaths are respected", () => {
  const d = project(undefined, { fixPaths: ["\\.ts$"] });
  put(d, "src/a.ts", "a  \n"); put(d, "notes.md", "md  \n");
  git(d, "rm", "-q", "src/untidy.ts");
  fix(d);
  expect(fixedFiles(d)).toEqual(["src/a.ts"]);
});

test("file names with spaces are quoted and the list is appended without a placeholder", () => {
  const d = project(FMT);
  put(d, "src/my file.ts", "x  \n");
  const r = fix(d);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.trim()).toBe("formatted 1 file");
  expect(text(d, "src/my file.ts")).toBe("x\n");
});

test("a long list runs in chunks", () => {
  const d = project();
  for (let i = 0; i < 250; i++) put(d, `src/f${i}.ts`, "x  \n");
  const r = fix(d);
  expect(r.stdout.trim(), r.out).toBe("formatted 250 files");
  expect(text(d, "fixer.log").split("\n").filter(Boolean).length).toBe(3);
});

test("a failing fixer shows the capped findings and the log path", () => {
  const noisy = "for i in $(seq 1 300); do echo \"noise $i\"; done; echo 'src/a.ts:3:1 error unfixable rule'; exit 1";
  const d = project(noisy, { checkOutputLines: 10 });
  put(d, "src/a.ts", "x\n");
  const r = fix(d);
  expect(r.code).toBe(1);
  expect(r.stderr.trim().split("\n").length).toBeLessThanOrEqual(14);
  expect(r.stderr).toContain("src/a.ts:3:1 error unfixable rule");
  expect(r.stderr).toContain("tmp/checks/fix.log");
});

/** The Stop check at the end of an agent's turn, in a factory run (FACTORY_LOOP=1, #256). */
function stop(d: string) {
  return runHook("check", [], { cwd: d, input: "{}", env: { ...ENV, CLAUDE_PROJECT_DIR: d, FACTORY_LOOP: "1" } });
}

test("the stop check formats before the tests run and says so", () => {
  // the test command fails on any trailing space, so it passes only if the fixer ran first
  const d = project(undefined, {}, { test: "! grep -rn ' $' src/a.ts" });
  put(d, "src/a.ts", "sloppy  \n");
  const r = stop(d);
  expect(r.code, r.out).toBe(0);
  expect((JSON.parse(r.stdout) as { systemMessage: string }).systemMessage).toBe("factory: formatted 1 file.");
  expect(text(d, "src/a.ts")).toBe("sloppy\n");
});

test("the stop check carries the note into a test failure", () => {
  const d = project(undefined, {}, { test: "echo 'FAIL src/a.ts:1:1 expected 1'; exit 1" });
  put(d, "src/a.ts", "sloppy  \n");
  const r = stop(d);
  expect(r.code, r.out).toBe(2);
  expect(r.stderr).toContain("(formatted 1 file.)");
  expect(r.stderr).toContain("FAIL src/a.ts:1:1");
});

test("the stop check sends unfixable findings back as a failure", () => {
  const d = project("echo 'src/a.ts:1:1 no-undef'; exit 1");
  put(d, "src/a.ts", "x\n");
  const r = stop(d);
  expect(r.code, r.out).toBe(2);
  expect(r.stderr).toContain("no-undef");
});

test("the stop check is quiet when there is nothing to format", () => {
  const d = project();
  put(d, "src/a.ts", "tidy\n");
  const r = stop(d);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("");
});

function verify(d: string, ci = "true") {
  const top = dirname(d);
  writeExe(join(top, "bin", "gh"), FAKE_GH);
  const main = join(top, "main.json");
  write(main, JSON.stringify({ commands: { ci, fix: `${FMT} {files}` }, reviewMarkers: "tmp/reviews" }));
  const env = { ...ENV, PATH: `${join(top, "bin")}:${ENV.PATH ?? ""}`, MAIN_SETTINGS: main };
  return sh(["bash", join(SF, "factory"), "verify"], { cwd: d, env, timeoutMs: 60_000 });
}

test("verify refuses when the fixer changed files then passes once they are committed", () => {
  const d = project();
  put(d, "src/a.ts", "sloppy  \n");
  git(d, "add", "-A"); git(d, "commit", "-qm", "work");
  let p = verify(d);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("formatted 1 file");
  expect(p.stderr).toContain("Commit them");
  expect(existsSync(join(d, "tmp/reviews/task_1-x.ci.ok"))).toBe(false);
  git(d, "add", "-A"); git(d, "commit", "-qm", "format");
  p = verify(d);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("passed");
});

test("the factory command runs it", () => {
  const d = project();
  put(d, "src/a.ts", "x  \n");
  const p = sh(["bash", join(SF, "factory"), "fix"], { cwd: d, env: ENV });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.trim()).toBe("formatted 1 file");
});

test("reviewers are told not to comment on what the fixer handles", () => {
  for (const name of ["reviewer", "architecture-reviewer"]) {
    const t = readFileSync(join(KIT, ".claude", "agents", name + ".md"), "utf8");
    expect(t, name).toContain("Formatting is not your job");
    expect(t, name).toContain("commands.fix");
  }
});

test("the fix settings are listed in the template and the registry", () => {
  const tpl = JSON.parse(readFileSync(join(KIT, ".claude", "factory.json"), "utf8")) as { commands: { fix: string }; fixPaths: unknown[] };
  expect(tpl.commands.fix).toBe("");
  expect(tpl.fixPaths).toEqual([]);
  const out = runHook("factory_settings", [], { cwd: tmp(), env: ENV }).stdout;
  expect(out).toContain("commands.fix");
  expect(out).toContain("fixPaths");
});
