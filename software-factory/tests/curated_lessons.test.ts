// The curated lessons file (#72): a short list of one-line rules the builder and the reviewers read first, fed by
// must-fix comments, reviewer findings and CI failures, kept under a cap and pruned when something enforces a rule.
// Runs `factory lessons ...` in a scratch project with a fake `gh`.
// (The `factory settings show lessons` check and DEV-MANAGER's mention stay in test_curated_lessons.py until
// factory_settings is ported.)
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, KIT, SF, sh, tmp, write, writeExe } from "./support.ts";

const FAKE_GH = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.LESSONS_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
const out = (x: unknown) => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] !== "api" || a.includes("-X") || a.includes("--input")) { console.error("fake gh: suggest must only read"); process.exit(1); }
const u = new URL((a[1] as string).replace("repos/{owner}/{repo}/", ""), "http://x/");
const path = u.pathname.slice(1); const q = u.searchParams;
if (path === "pulls") out((q.get("page") ?? "1") === "1" ? s.pulls : []);
if (path === "actions/runs") out({ workflow_runs: s.runs[q.get("branch") as string] ?? [] });
if (path.startsWith("actions/runs/") && path.endsWith("/jobs")) out({ jobs: s.jobs[path.split("/")[2] as string] ?? [] });
if (path.startsWith("issues/") && path.endsWith("/comments")) out(s.comments[path.split("/")[1] as string] ?? []);
console.error("fake gh: no answer for " + a[1]); process.exit(1);
`;

const LESSONS = `# Lessons

Short rules, one line each. Read before you build.

- packages/validators: annotate recursive helpers' return types (e.g. TS7022 in \`schema.ts\`)
- Run \`pnpm lint --fix\` before every push (https://example.com/why)
`;

type Row = Record<string, unknown>;

function pr(n: number, branch: string): Row {
  return { number: n, head: { ref: branch }, created_at: "2026-10-20T10:00:00Z", state: "closed",
    merged_at: "2026-10-21T10:00:00Z" };
}

function mf(text: string): Row {
  return { body: "<!-- factory-mustfix sha=abc1234 -->\n" + text, created_at: "2026-10-20T12:00:00Z" };
}

type Env = Record<string, string | undefined>;

function project(lessons: string | null = LESSONS, cfg: Row = {}, scenario: Row = {}, files: string[] = []): [string, Env] {
  const d = tmp();
  sh(["git", "init", "-q", "-b", "main", d]);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(d, ".claude", "factory"), { recursive: true });
  for (const f of readdirSync(HOOKS)) {
    if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  }
  write(join(d, ".claude", "factory.json"), JSON.stringify({ reviewMarkers: "tmp/reviews", ...cfg }));
  if (lessons !== null) write(join(d, ".claude", "factory", "lessons.md"), lessons);
  for (const f of files) write(join(d, f), "x");
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, "scenario.json"), JSON.stringify(scenario));
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH ?? ""}`, LESSONS_SCENARIO: join(d, "scenario.json"),
    CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDECODE: undefined };
  return [d, env];
}

function run(d: string, env: Env, args: string[], extraEnv: Env = {}) {
  return sh(["bash", join(SF, "factory"), "lessons", ...args], { cwd: d, env: { ...env, ...extraEnv }, timeoutMs: 60_000 });
}

function lines(d: string): string[] {
  return readFileSync(join(d, ".claude", "factory", "lessons.md"), "utf8").split("\n").filter((x) => x.startsWith("- "));
}

const SCENARIO: Row = {
  pulls: [pr(40, "task/30-a"), pr(41, "task/31-b"), pr(42, "task/32-c"), pr(43, "chore/not-a-task")],
  comments: {
    "40": [mf("- Annotate the recursive helper's return type (TS7022) in packages/validators\n- Missing test for the empty cart")],
    "41": [mf("1. packages/validators: recursive helper needs an explicit return type, TS7022")],
    "42": [mf("Run `pnpm lint --fix` before pushing; lint failed on formatting."),
      { body: "<!-- factory-approved sha=abc -->", created_at: "2026-10-20T13:00:00Z" }],
    "43": [mf("- not a task pull request, never counted")],
  },
  runs: { "task/30-a": [{ id: 1, conclusion: "failure" }, { id: 2, conclusion: "failure" }],
    "task/31-b": [{ id: 3, conclusion: "failure" }],
    "task/32-c": [{ id: 4, conclusion: "success" }] },
  jobs: { "1": [{ name: "Typecheck, lint, test, build", conclusion: "failure",
    steps: [{ name: "pnpm install", conclusion: "success" }, { name: "pnpm typecheck", conclusion: "failure" }] }],
  "2": [{ name: "Typecheck, lint, test, build", conclusion: "failure",
    steps: [{ name: "pnpm typecheck", conclusion: "failure" }] }],
  "3": [{ name: "Typecheck, lint, test, build", conclusion: "failure",
    steps: [{ name: "pnpm typecheck", conclusion: "failure" }] }] },
};
const EMPTY: Row = { pulls: [], runs: {}, comments: {}, jobs: {} };

interface Cand {
  source: string;
  text: string;
  refs: string[];
  count: number;
  line: string;
}

function cands(stdout: string): { pulls: number; candidates: Cand[] } {
  return JSON.parse(stdout) as { pulls: number; candidates: Cand[] };
}

test("show prints only the lessons and nothing when there is no file", () => {
  let [d, env] = project();
  let p = run(d, env, ["show"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split("\n").length - 1).toBe(2);
  expect(p.stdout).toContain("TS7022");
  expect(p.stdout).not.toContain("# Lessons");
  [d, env] = project(null);
  p = run(d, env, ["show"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.trim()).toBe("");
});

test("check passes a short file and a missing one", () => {
  let [d, env] = project();
  const p = run(d, env, ["check"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("2 of 40");
  [d, env] = project(null);
  expect(run(d, env, ["check"]).code).toBe(0);
});

test("check fails over the cap and the cap is a setting", () => {
  const many = "# Lessons\n" + Array.from({ length: 41 }, (_, i) => `- rule ${i}, e.g. \`x${i}\`\n`).join("");
  let [d, env] = project(many);
  const p = run(d, env, ["check"]);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("41 lessons");
  expect(p.stderr).toContain("40");
  expect(p.stderr).toContain("prune");
  [d, env] = project(many, { lessonsCap: 50 });
  expect(run(d, env, ["check"]).code).toBe(0);
  [d, env] = project(LESSONS, { lessonsCap: 1 });
  expect(run(d, env, ["check"]).code).toBe(1);
});

test("check wants one line with an example or a link", () => {
  let [d, env] = project("- Be careful with types\n- A rule\n  that wraps, e.g. `x`\n- ok, see #12\n");
  const p = run(d, env, ["check"]);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("line 1");
  expect(p.stderr).toContain("example");
  expect(p.stderr.includes("line 2") || p.stderr.includes("line 3"), p.stderr).toBe(true); // the wrapped continuation line
  expect(p.stderr).not.toContain("line 4");
  [d, env] = project("- " + "long ".repeat(80) + "e.g. `x`\n");
  expect(run(d, env, ["check"]).code).toBe(1);
});

test("add appends a valid lesson and refuses bad ones with a fix", () => {
  let [d, env] = project();
  let p = run(d, env, ["add", "Pin the Node version in `.nvmrc` (e.g. #7)"]);
  expect(p.code, p.out).toBe(0);
  expect(lines(d).length).toBe(3);
  expect(lines(d).at(-1)?.endsWith("(e.g. #7)")).toBe(true);
  p = run(d, env, ["add", "pin the node version in `.nvmrc` (e.g. #7)"]); // the same lesson again
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("already");
  expect(lines(d).length).toBe(3);
  p = run(d, env, ["add", "Be careful"]);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("example");
  expect(lines(d).length).toBe(3);
  [d, env] = project(LESSONS, { lessonsCap: 2 });
  p = run(d, env, ["add", "A third rule, e.g. `x`"]);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("2 lessons");
  expect(p.stderr).toContain("prune");
  expect(lines(d).length).toBe(2);
});

test("add creates the file and agents cannot change it", () => {
  const [d, env] = project(null);
  expect(run(d, env, ["add", "First rule, e.g. `x`"]).code).toBe(0);
  expect(lines(d).length).toBe(1);
  for (const v of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    const p = run(d, env, ["add", "Another rule, e.g. `y`"], { [v]: "1" });
    expect(p.code, v).toBe(1);
    expect(p.stderr, v).toContain("dev manager");
    expect(lines(d).length).toBe(1);
  }
  const p = run(d, env, ["show"], { FACTORY_AGENT: "taytu" }); // reading is for everyone
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("First rule");
});

test("prune lists lessons that something enforces now and removes them on request", () => {
  const text = "- Annotate recursive helpers, e.g. `x.ts` [enforced: tools/lint-rule.js]\n" +
    "- Run the formatter first, e.g. `pnpm fmt` [enforced: tools/gone.js]\n" +
    "- Keep tests small, e.g. #3\n";
  const [d, env] = project(text, {}, {}, ["tools/lint-rule.js"]);
  let p = run(d, env, ["prune"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Annotate recursive helpers");
  expect(p.stdout).not.toContain("Keep tests small");
  expect(p.stdout).not.toContain("Run the formatter first");
  expect(lines(d).length).toBe(3);
  p = run(d, env, ["check"]); // an enforcement that no longer exists is worth a look, not a failure
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("tools/gone.js");
  expect(p.stdout).toContain("tools/lint-rule.js");
  p = run(d, env, ["prune", "--apply"]);
  expect(p.code, p.out).toBe(0);
  expect(lines(d).length).toBe(2);
  expect(lines(d).join("")).not.toContain("Annotate");
});

test("suggest lists repeated causes from mustfix comments and ci and skips known lessons", () => {
  const [d, env] = project(LESSONS, {}, SCENARIO);
  const p = run(d, env, ["suggest", "--json"]);
  expect(p.code, p.out).toBe(0);
  const out = cands(p.stdout);
  const texts = out.candidates.map((c) => c.text);
  // the recursive-helper must-fix came twice (PRs 40 and 41) but is already a lesson: not suggested again
  expect(texts.some((t) => t.includes("TS7022")), texts.join("|")).toBe(false);
  // `pnpm lint --fix` is already a lesson too; the single empty-cart must-fix is below --min 2
  expect(texts.some((t) => t.includes("empty cart"))).toBe(false);
  const ci = out.candidates.filter((c) => c.source === "ci");
  expect(ci.length).toBe(1);
  expect(ci[0]?.count).toBe(2);
  expect(ci[0]?.refs).toEqual(["#40", "#41"]); // once per PR, not per run
  expect(ci[0]?.text).toContain("Typecheck, lint, test, build / pnpm typecheck");
  expect(ci[0]?.line.startsWith("- ")).toBe(true);
  expect(ci[0]?.line).toContain("#40");
  expect(out.pulls).toBe(3); // the chore branch is not a task PR
});

test("suggest with no lessons yet proposes the repeats with the prs and a command to approve", () => {
  const [d, env] = project(null, {}, SCENARIO);
  let p = run(d, env, ["suggest"]);
  expect(p.code, p.out).toBe(0);
  for (const s of ["TS7022", "#40", "#41", "factory lessons add"]) expect(p.stdout).toContain(s);
  expect(p.stdout).not.toContain("empty cart");
  expect(p.stdout).not.toContain("not a task pull request");
  p = run(d, env, ["suggest", "--min", "1", "--json"]);
  expect(cands(p.stdout).candidates.some((c) => c.text.includes("empty cart")), p.stdout).toBe(true);
  p = run(d, env, ["suggest", "--last", "1", "--min", "1", "--json"]); // only the first task PR GitHub lists, #40
  expect(new Set(cands(p.stdout).candidates.flatMap((c) => c.refs))).toEqual(new Set(["#40"]));
});

test("suggest adds reviewer findings kept on this machine", () => {
  const [d, env] = project(null, {}, EMPTY);
  for (const branch of ["task_5-a", "task_6-b"]) {
    write(join(d, "tmp", "reviews", branch + ".reviews.json"), JSON.stringify({ reviewer: [
      { sha: "a".repeat(40), result: "fail", findings: "must-fix: `api/users.ts` logs the raw email\n" },
      { sha: "b".repeat(40), result: "pass", findings: "no must-fix" }] }));
  }
  const p = run(d, env, ["suggest", "--json"]);
  const c = cands(p.stdout).candidates;
  expect(c.length, p.out).toBe(1);
  expect(c[0]?.source).toBe("reviewer");
  expect(c[0]?.count).toBe(2);
  expect(c[0]?.text).toContain("raw email");
});

test("suggest is read only and says so when there is nothing", () => {
  const [d, env] = project(LESSONS, {}, EMPTY);
  const file = join(d, ".claude", "factory", "lessons.md");
  const before = readFileSync(file, "utf8");
  const p = run(d, env, ["suggest"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.toLowerCase()).toContain("no repeated");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("the lessons file is a setting", () => {
  const [d, env] = project(null, { lessons: "docs/lessons.md" });
  write(join(d, "docs", "lessons.md"), "- Elsewhere, e.g. `x`\n");
  expect(run(d, env, ["show"]).stdout).toContain("Elsewhere");
});

test("the builder and every reviewer read the lessons first", () => {
  for (const rel of ["agents/reviewer.md", "agents/architecture-reviewer.md", "agents/safety-auditor.md",
    "agents/security-reviewer.md", "skills/next-task/SKILL.md"]) {
    expect(readFileSync(join(KIT, ".claude", rel), "utf8"), rel).toContain("factory_lessons.ts show");
  }
  expect(readFileSync(join(KIT, ".claude", "agents", "reviewer.md"), "utf8").toLowerCase()).toContain("lesson");
  expect(readFileSync(join(SF, "DEV-MANAGER.md"), "utf8")).toContain("factory_lessons.ts suggest");
});

test("agents may read lessons but settings deny changing them", () => {
  const deny = (JSON.parse(readFileSync(join(KIT, ".claude", "settings.json"), "utf8")) as { permissions: { deny: string[] } })
    .permissions.deny;
  const joined = deny.join(" ");
  for (const sub of ["add", "prune"]) {
    expect(joined, sub).toContain(`factory_lessons.ts ${sub}`);
    expect(joined, sub).toContain(`factory lessons ${sub}`);
  }
});

test("the kit ships a valid empty lessons file and ci checks it", () => {
  const template = join(KIT, ".claude", "factory", "lessons.md");
  const [d, env] = project(readFileSync(template, "utf8"));
  const p = run(d, env, ["check"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("0 of 40");
  expect(readFileSync(join(KIT, ".github", "workflows", "ci.yml"), "utf8")).toContain("factory_lessons.ts check");
});
