// Incremental re-review (#70): a reviewer's second round reads only what changed since its last pass, with its own
// earlier findings and the author's reply; a big or wide change, or a rewritten history, goes back to a full review.
// The PR gate's marker is untouched.
// (Two checks stay in test_rereview.py until pr-gate and factory_settings are ported: the gate's `passed` on a final
// pass, and the reReviewPercent setting in the registry.)
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT, runHook, SF, sh, tmp, write as put } from "./support.ts";

const ENV: Record<string, string | undefined> = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  CLAUDE_PROJECT_DIR: undefined,
};

const BIG = Array.from({ length: 100 }, (_, i) => `line ${i} of the first file\n`).join("");

function git(d: string, ...a: string[]): string {
  const p = sh(["git", ...a], { cwd: d, env: ENV });
  if (p.code !== 0) throw new Error(`git ${a.join(" ")}: ${p.out}`);
  return p.stdout.trim();
}

function write(d: string, name: string, text: string): void {
  put(join(d, name), text);
}

function commit(d: string, msg: string): string {
  git(d, "add", "-A");
  git(d, "commit", "-qm", msg);
  return git(d, "rev-parse", "HEAD");
}

/** main with two files, then a task branch with a 100-line change in a.py and a small one in b.py. */
function project(settings: Record<string, unknown> = {}): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  write(d, ".claude/factory.json", JSON.stringify({ reviewMarkers: "tmp/reviews", ...settings }));
  write(d, ".gitignore", "tmp/\n__pycache__/\n");
  write(d, "src/a.py", "print('a')\n");
  write(d, "src/b.py", "print('b')\n");
  commit(d, "start");
  git(d, "checkout", "-qb", "task/70-x");
  write(d, "src/a.py", BIG);
  write(d, "src/b.py", "print('b')\nprint('more b')\n");
  commit(d, "the task");
  return d;
}

function run(d: string, ...args: string[]): [number, string, string] {
  const p = runHook("factory_rereview", ["--base", "main", ...args], { cwd: d, env: ENV });
  return [p.code, p.stdout, p.stderr];
}

interface PlanOut {
  mode: string;
  reason: string;
  head: string;
  delta: { files: string[]; percent: number } | null;
}

function plan(d: string, kind = "reviewer"): PlanOut {
  const [rc, out, err] = run(d, "plan", "--kind", kind);
  expect(rc, err).toBe(0);
  return JSON.parse(out) as PlanOut;
}

function record(d: string, result = "fail", findings = "must-fix: src/b.py line 2 prints the wrong text", kind = "reviewer"): void {
  const [rc, , err] = run(d, "record", "--kind", kind, "--result", result, "--findings", findings);
  expect(rc, err).toBe(0);
}

test("the first review is a full one", () => {
  const d = project();
  const p = plan(d);
  expect(p.mode).toBe("full");
  expect(p.reason).toContain("first");
  const [rc, out] = run(d, "prompt", "--kind", "reviewer");
  expect(rc).toBe(0);
  expect(out).toContain("Full review");
  expect(out).not.toContain("BEGIN DELTA");
});

test("a small fix after a failed pass is reviewed as a delta", () => {
  const d = project();
  record(d);
  write(d, "src/b.py", "print('b')\nprint('right text')\n");
  const head = commit(d, "fix");
  const p = plan(d);
  expect(p.mode).toBe("delta");
  expect(p.head).toBe(head);
  expect(p.delta?.files).toEqual(["src/b.py"]);
  expect(p.delta?.percent).toBeLessThan(30);
});

test("the re review prompt has the delta and the earlier findings but not the whole diff", () => {
  const d = project();
  record(d);
  let [rc, out, err] = run(d, "reply", "--kind", "reviewer", "--text", "Fixed the text in b.py; kept a.py as is.");
  expect(rc, err).toBe(0);
  write(d, "src/b.py", "print('b')\nprint('right text')\n");
  commit(d, "fix");
  [rc, out, err] = run(d, "prompt", "--kind", "reviewer");
  expect(rc, err).toBe(0);
  expect(out).toContain("Re-review");
  expect(out).toContain("BEGIN DELTA");
  expect(out).toContain("+print('right text')"); // the delta
  expect(out).toContain("-print('more b')");
  expect(out).toContain("must-fix: src/b.py line 2 prints the wrong text"); // its own earlier finding
  expect(out).toContain("Fixed the text in b.py"); // the author's reply
  expect(out).not.toContain("line 57 of the first file"); // the 100-line file it already read is not in the prompt
  expect(out).not.toContain("git diff main...HEAD");
});

test("a large delta goes back to a full review", () => {
  const d = project();
  record(d);
  write(d, "src/a.py", BIG + Array.from({ length: 60 }, (_, i) => `extra ${i}\n`).join(""));
  commit(d, "big fix");
  const p = plan(d);
  expect(p.mode).toBe("full");
  expect(p.reason).toContain("%");
  const [, out] = run(d, "prompt", "--kind", "reviewer");
  expect(out).toContain("Full review");
  expect(out).not.toContain("BEGIN DELTA");
  expect(out).toContain("must-fix: src/b.py line 2"); // earlier findings still shown
});

test("a new file goes back to a full review", () => {
  const d = project();
  record(d);
  write(d, "src/new.py", "x = 1\n");
  commit(d, "add a file");
  const p = plan(d);
  expect(p.mode).toBe("full");
  expect(p.reason).toContain("src/new.py");
});

test("the percent setting moves the limit and zero turns it off", () => {
  let d = project({ reReviewPercent: 1 });
  record(d);
  write(d, "src/b.py", "print('b')\nprint('right text')\n");
  commit(d, "fix");
  expect(plan(d).mode).toBe("full");
  d = project({ reReviewPercent: 0 });
  record(d);
  write(d, "src/b.py", "print('b')\nprint('right text')\n");
  commit(d, "fix");
  const p = plan(d);
  expect(p.mode).toBe("full");
  expect(p.reason).toContain("off");
});

test("a rewritten history goes back to a full review", () => {
  const d = project();
  record(d);
  git(d, "reset", "-q", "--hard", "HEAD~1");
  write(d, "src/a.py", BIG);
  commit(d, "the task again");
  const p = plan(d);
  expect(p.mode).toBe("full");
  expect(p.reason).toContain("history");
});

test("a branch whose base moved goes back to a full review", () => {
  const d = project();
  record(d);
  git(d, "checkout", "-q", "main");
  write(d, "other.txt", "x\n");
  commit(d, "main moves");
  git(d, "checkout", "-q", "task/70-x");
  git(d, "merge", "-q", "--no-edit", "main");
  const p = plan(d);
  expect(p.mode).toBe("full");
  expect(p.reason).toContain("base");
});

test("nothing new since the last pass says so", () => {
  const d = project();
  record(d, "pass", "no must-fix");
  expect(plan(d).mode).toBe("unchanged");
});

test("each reviewer kind has its own history", () => {
  const d = project();
  record(d, undefined, undefined, "reviewer");
  write(d, "src/b.py", "print('b')\nprint('right text')\n");
  commit(d, "fix");
  expect(plan(d, "reviewer").mode).toBe("delta");
  expect(plan(d, "arch").mode).toBe("full");
});

test("the summary is kept and the pass marker is not touched", () => {
  const d = project();
  record(d, "pass", "no must-fix; checked the gate");
  const state = JSON.parse(readFileSync(join(d, "tmp", "reviews", "task_70-x.reviews.json"), "utf8")) as
    Record<string, { result: string; findings: string; sha: string }[]>;
  const last = (state.reviewer ?? []).at(-1);
  expect(last?.result).toBe("pass");
  expect(last?.findings.startsWith("no must-fix")).toBe(true);
  expect(last?.sha.length).toBe(40);
  expect(existsSync(join(d, "tmp", "reviews", "task_70-x.ok"))).toBe(false); // only the reviewer writes that
});

test("a final pass on head after a delta review leaves the marker to the reviewer", () => {
  // The gate's side (`passed` on that marker) is checked in test_rereview.py until pr-gate is ported.
  const d = project();
  record(d);
  write(d, "src/b.py", "print('b')\nprint('right text')\n");
  commit(d, "fix");
  expect(plan(d).mode).toBe("delta");
  record(d, "pass", "no must-fix");
  const marker = join(d, "tmp", "reviews", "task_70-x.ok");
  writeFileSync(marker, git(d, "rev-parse", "HEAD") + "\n"); // what the reviewer's snippet writes
  record(d, "pass", "no must-fix");
  expect(readFileSync(marker, "utf8").trim()).toBe(git(d, "rev-parse", "HEAD")); // record never rewrites it
});

test("the agents and the next task skill tell the reviewers to use it", () => {
  for (const agent of ["reviewer", "architecture-reviewer", "safety-auditor", "security-reviewer"]) {
    const text = readFileSync(join(KIT, ".claude", "agents", agent + ".md"), "utf8");
    expect(text, agent).toContain("factory_rereview.ts prompt");
    expect(text, agent).toContain("factory_rereview.ts record");
  }
  const skill = readFileSync(join(KIT, ".claude", "skills", "next-task", "SKILL.md"), "utf8");
  const rework = readFileSync(join(KIT, ".claude", "skills", "next-task", "rework.md"), "utf8");
  expect(skill).toContain("factory_rereview.ts reply");
  expect(rework).toContain("factory_rereview.ts reply");
});

test("the factory command runs it and no forwarder is left for it", () => {
  // #252: a .ts gets no forwarder in kit/.claude/hooks; projects link hooks/ directly.
  expect(existsSync(join(SF, "hooks", "factory_rereview.ts"))).toBe(true);
  expect(existsSync(join(KIT, ".claude", "hooks", "factory_rereview.py"))).toBe(false);
  expect(readFileSync(join(SF, "factory"), "utf8")).toContain("factory_rereview");
});
