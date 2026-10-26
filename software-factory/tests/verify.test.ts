// `factory verify` runs what CI runs (`commands.ci`) for the current commit and records a pass the PR gate needs
// for `gh pr create` and `gh pr ready` (#58).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOOKS, SF, sh, tmp, write, writeExe } from "./support.ts";

const ENV: Record<string, string | undefined> = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

function git(d: string, ...a: string[]): string {
  const p = sh(["git", ...a], { cwd: d, env: ENV });
  if (p.code !== 0) throw new Error(`git ${a.join(" ")}: ${p.out}`);
  return p.stdout.trim();
}

// GitHub's copy of main's settings, which verify uses (#83 review). Without one, gh can't reach GitHub.
const FAKE_GH = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const main = process.env.MAIN_SETTINGS;
const a = process.argv.slice(2);
if (!main) { console.error("gh: could not connect to api.github.com"); process.exit(1); }
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
if (a[0] === "api" && a.join(" ").includes("/contents/.claude/factory.json")) { console.log(readFileSync(main, "utf8")); process.exit(0); }
console.error("fake gh: no answer for " + a.join(" ")); process.exit(1);
`;

/** A task branch whose factory.json sets commands.ci to `ci`; `main`: the settings GitHub has on main. */
function project(ci: string, main: unknown = null): string {
  const top = tmp();
  const d = join(top, "proj");
  writeExe(join(top, "bin", "gh"), FAKE_GH);
  if (main !== null) write(join(top, "main.json"), JSON.stringify(main));
  mkdirSync(d);
  git(d, "init", "-q", "-b", "main");
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) {
    if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  }
  write(join(d, ".claude", "factory.json"), JSON.stringify({ commands: { ci }, reviewMarkers: "tmp/reviews" }));
  write(join(d, ".gitignore"), "tmp/\n__pycache__/\nran\n"); // as install.sh writes it
  git(d, "add", "-A");
  git(d, "commit", "-qm", "start");
  git(d, "checkout", "-q", "-b", "task/1-x");
  return d;
}

function verify(d: string) {
  const top = dirname(d);
  const main = join(top, "main.json");
  const env = { ...ENV, PATH: `${join(top, "bin")}:${ENV.PATH ?? ""}`, MAIN_SETTINGS: existsSync(main) ? main : "",
    CLAUDE_PROJECT_DIR: undefined };
  return sh(["bash", join(SF, "factory"), "verify"], { cwd: d, env, timeoutMs: 60_000 });
}

function mark(d: string): string | null {
  const p = join(d, "tmp", "reviews", "task_1-x.ci.ok");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}

const ran = (d: string): string => readFileSync(join(d, "ran"), "utf8").trim();

test("a passing run records this commit", () => {
  const d = project("echo {base} > ran");
  const p = verify(d);
  expect(p.code, p.out).toBe(0);
  expect(mark(d)).toBe(git(d, "rev-parse", "HEAD"));
  expect(ran(d)).toBe("origin/main"); // {base} is origin/<main>
});

test("a failing run records nothing and shows the end of the output", () => {
  const d = project("echo 'src/a.ts(9,1): error TS7022'; exit 1");
  const p = verify(d);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("error TS7022");
  expect(mark(d)).toBeNull();
});

test("uncommitted changes are refused", () => {
  const d = project("true");
  write(join(d, ".gitignore"), readFileSync(join(d, ".gitignore"), "utf8") + "more\n");
  const p = verify(d);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("commit your changes first");
  expect(mark(d)).toBeNull();
});

test("without commands ci there is nothing to run", () => {
  const d = project("");
  const p = verify(d);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("commands.ci");
  expect(mark(d)).toBeNull();
});

test("an untracked file is refused", () => {
  // The pass would be for a commit that doesn't have the file that made it pass (#83 review).
  const d = project("test -f src/new.ts");
  write(join(d, "src", "new.ts"), "x\n");
  const p = verify(d);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("commit your changes first");
  expect(p.stderr).toContain("src/new.ts");
  expect(mark(d)).toBeNull();
});

test("it runs mains command not the branchs", () => {
  // A branch cut before main set commands.ci (or one that changed it) still runs what the gate requires.
  const main = { commands: { ci: "echo main > ran" }, reviewMarkers: "tmp/reviews" };
  let d = project("", main);
  const p = verify(d);
  expect(p.code, p.out).toBe(0);
  expect(ran(d)).toBe("main");
  expect(mark(d)).toBe(git(d, "rev-parse", "HEAD"));
  d = project("echo branch > ran", main);
  expect(verify(d).code).toBe(0);
  expect(ran(d)).toBe("main");
});

test("without github it falls back to the worktrees settings and says so", () => {
  const d = project("echo local > ran");
  const p = verify(d);
  expect(p.code, p.out).toBe(0);
  expect(ran(d)).toBe("local");
  expect(p.stderr).toContain("can't read main's settings");
});
