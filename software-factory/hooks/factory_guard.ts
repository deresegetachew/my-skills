#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// CI guard for factory pull requests. Runs in CI, where the coding agent can't edit around it.
//
// Checks the PR's commits against the base branch and fails (exit 1) on:
//   - existing tests weakened: a test file deleted, or a line with an assertion or a     } need the
//     test case removed or rewritten (adding new tests and assertions is fine)            } `tests-reviewed`
//   - tests weakened in a commit after implementation started (even tests new in this PR) } label
//   - golden/expected outputs that existed on the base changed or deleted                 }
//   - new .skip / .only / xit / xdescribe / test.todo in test files                        }
//   - new dependencies in a package manifest                         (needs the `deps-reviewed` label)
//   - two decision files with the same number                        (no label overrides this)
//   - a task branch ticking a task other than its own in the plan    (no label overrides this)
//   - a workflow using `pull_request_target`                         (no label overrides this)
// and warns (no failure) when the PR is larger than `prSizeWarn` changed lines.
//
// The dev manager adds the labels after reading the change; the agent's own token shouldn't.
// Usage (CI): bun --no-env-file --config=/dev/null .claude/hooks/factory_guard.ts --base origin/main --branch "$HEAD_REF" --labels "$LABELS_JSON"
import { appendFileSync } from "node:fs";
import { branchTask, load, matches, tasks } from "./factory_config.ts";
import { die, run, runMain, splitLines } from "./factory_lib.ts";

function git(args: string[], check = true): string {
  const p = run(["git", ...args]);
  if (check && p.code !== 0) die(`git ${args.join(" ")} failed: ${p.stderr.trim()}`);
  return p.stdout;
}

function show(rev: string, path: string): string | null {
  const p = run(["git", "show", `${rev}:${path}`]);
  return p.code === 0 ? p.stdout : null;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

const USAGE = "usage: factory_guard.ts [-h] [--base BASE] [--head HEAD] [--branch BRANCH] [--labels LABELS]";

interface Args {
  base: string;
  head: string;
  branch: string;
  labels: string;
}

/** argparse with four optional string flags (`--x v` or `--x=v`, unique prefixes allowed). */
function parse(argv: string[]): Args {
  const a: Args = { base: "origin/main", head: "HEAD", branch: "", labels: "[]" };
  const keys = Object.keys(a) as (keyof Args)[];
  const bad = (msg: string): never => {
    process.stderr.write(`${USAGE}\nfactory_guard.ts: error: ${msg}\n`);
    die(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE + "\n");
      die(0);
    }
    if (!arg.startsWith("--")) bad(`unrecognized arguments: ${argv.slice(i).join(" ")}`);
    const eq = arg.indexOf("=");
    const flag = (eq < 0 ? arg : arg.slice(0, eq)).slice(2);
    const hits = keys.filter((k) => k.startsWith(flag));
    const key = keys.includes(flag as keyof Args) ? (flag as keyof Args) : hits.length === 1 ? hits[0] : undefined;
    if (!key) bad(`unrecognized arguments: ${arg}`);
    if (eq >= 0) a[key as keyof Args] = arg.slice(eq + 1);
    else if (i + 1 < argv.length) a[key as keyof Args] = argv[++i] as string;
    else bad(`argument --${key}: expected one argument`);
  }
  return a;
}

function stringKeys(v: unknown): Set<string> {
  return new Set(v && typeof v === "object" ? Object.keys(v) : []);
}

export function main(argv: string[]): number {
  const a = parse(argv);
  const cfg = load();
  const labels = new Set(JSON.parse(a.labels || "[]") as unknown[]);
  const base = git(["merge-base", a.base, a.head]).trim();
  const fails: string[] = [];
  const needsTests: string[] = [];
  const needsDeps: string[] = [];
  const warns: string[] = [];

  const isTest = (p: string): boolean => matches(p, cfg.testPaths);
  const isGolden = (p: string): boolean => matches(p, cfg.goldenPaths);
  const isCode = (p: string): boolean =>
    cfg.codePaths.some((c) => p === c || p.startsWith(c.replace(/\/+$/, "") + "/")) && !isTest(p) && !isGolden(p);

  // A line that asserts or defines a test case. Removing or rewriting one is "weakening"; adding is fine.
  const weak = /\b(expect|assert\w*|should)\b|\b(it|test|describe)\s*\(|\bto(Be|Equal|Match|Throw|Contain|Have)\w*/;

  const weakened = (diffArgs: string[]): string[] => {
    const out: string[] = [];
    for (const ln of splitLines(git(["diff", "-U0", ...diffArgs]))) {
      if (ln.startsWith("-") && !ln.startsWith("---") && weak.test(ln)) out.push(ln.slice(1).trim().slice(0, 70));
    }
    return out;
  };

  // 1. Existing tests weakened; existing golden outputs changed.
  for (const line of splitLines(git(["diff", "--name-status", "--no-renames", `${base}...${a.head}`]))) {
    const tab = line.indexOf("\t");
    const status = tab < 0 ? line : line.slice(0, tab);
    const path = tab < 0 ? "" : line.slice(tab + 1);
    if (!"MD".includes(status[0] as string)) continue;
    if (isGolden(path)) {
      needsTests.push(`${status[0] === "D" ? "deleted" : "changed"} existing expected output \`${path}\``);
    } else if (isTest(path)) {
      if (status[0] === "D") needsTests.push(`deleted existing test \`${path}\``);
      else {
        const gone = weakened([`${base}...${a.head}`, "--", path]);
        if (gone.length) {
          needsTests.push(`removes or rewrites ${gone.length} assertion/test line(s) in \`${path}\`, e.g. \`${gone[0]}\``);
        }
      }
    }
  }

  // 2. Tests weakened after implementation started (catches tests written in this PR and then softened).
  let started = false;
  for (const sha of words(git(["rev-list", "--reverse", "--no-merges", `${base}..${a.head}`]))) {
    const files = words(git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]));
    if (started) {
      for (const f of files.filter(isTest)) {
        const gone = weakened([`${sha}^`, sha, "--", f]);
        if (gone.length) {
          needsTests.push(`commit ${sha.slice(0, 8)} (after implementation started) removes or rewrites ` +
            `assertion/test line(s) in \`${f}\`, e.g. \`${gone[0]}\``);
        }
      }
    }
    if (files.some(isCode)) started = true;
  }

  // 3. Skip / only markers added.
  const marker = /\b(it|test|describe)\.(skip|only|todo)\s*\(|\bx(it|describe|test)\s*\(|\bfit\s*\(|@pytest\.mark\.skip/;
  for (const path of words(git(["diff", "--name-only", `${base}...${a.head}`]))) {
    if (!isTest(path)) continue;
    for (const ln of splitLines(git(["diff", "-U0", `${base}...${a.head}`, "--", path]))) {
      if (ln.startsWith("+") && !ln.startsWith("+++") && marker.test(ln)) {
        needsTests.push(`adds a skip/only/todo in \`${path}\`: \`${ln.slice(1).trim().slice(0, 80)}\``);
      }
    }
  }

  // 4. New dependencies.
  for (const path of words(git(["diff", "--name-only", `${base}...${a.head}`]))) {
    if (!matches(path, cfg.dependencyManifests) || !path.endsWith("package.json")) continue;
    let older: Record<string, unknown>;
    let newer: Record<string, unknown>;
    try {
      older = JSON.parse(show(base, path) || "{}") as Record<string, unknown>;
      newer = JSON.parse(show(a.head, path) || "{}") as Record<string, unknown>;
    } catch {
      fails.push(`\`${path}\` isn't valid JSON`);
      continue;
    }
    for (const sect of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const was = stringKeys(older[sect]);
      const added = [...stringKeys(newer[sect])].filter((d) => !was.has(d)).sort();
      if (added.length) needsDeps.push(`\`${path}\` ${sect}: ` + added.map((d) => `\`${d}\``).join(", "));
    }
  }

  // 5. Decision numbers.
  const ddir = cfg.decisions.replace(/\/+$/, "");
  const names = words(git(["ls-tree", "--name-only", `${a.head}:${ddir}`], false));
  const nums = new Map<string, number>();
  for (const n of names) {
    const m = /^(\d{4})-/.exec(n);
    if (m) nums.set(m[1] as string, (nums.get(m[1] as string) ?? 0) + 1);
  }
  for (const [num, count] of nums) {
    if (count > 1 && num !== "0000") {
      const dup = names.filter((n) => n.startsWith(num + "-")).join(", ");
      fails.push(`decision number ${num} is used ${count} times (${dup}); renumber yours to the next free number`);
    }
  }

  // 6. A task branch may only tick its own task.
  const tid = branchTask(a.branch);
  const planOld = show(base, cfg.plan);
  const planNew = show(a.head, cfg.plan);
  if (planOld !== null && planNew !== null) {
    const before = new Set(tasks(planOld).filter(([, done]) => done).map(([i]) => i));
    const newly = tasks(planNew).filter(([i, done]) => done && !before.has(i)).map(([i]) => i);
    const wrong = newly.filter((i) => i !== tid);
    if (wrong.length) {
      fails.push(`ticks task(s) ${wrong.join(", ")} in \`${cfg.plan}\`, but this branch ` +
        (tid ? `is task ${tid}` : "isn't a task branch"));
    }
  }

  // 7. Workflows with pull_request_target.
  for (const path of words(git(["ls-tree", "-r", "--name-only", a.head, ".github/workflows"], false))) {
    const text = show(a.head, path) || "";
    if (/^\s*pull_request_target\s*:/m.test(text) || /on:\s*\[?[^\]\n]*pull_request_target/.test(text)) {
      fails.push(`\`${path}\` uses \`pull_request_target\`, which runs PR code with repo secrets`);
    }
  }

  // 8. Size.
  let total = 0;
  for (const ln of splitLines(git(["diff", "--numstat", `${base}...${a.head}`]))) {
    const [add, rem, path] = [...ln.split("\t"), "", "", ""] as [string, string, string];
    if (add === "-" || isGolden(path) || /(lock\.(yaml|json)|\.lock|\.lockb)$/.test(path)) continue;
    total += Number.parseInt(add, 10) + Number.parseInt(rem, 10);
  }
  if (total > Math.trunc(Number(cfg.prSizeWarn))) {
    warns.push(`${total} changed lines (over ${cfg.prSizeWarn}): consider splitting; review findings rise with size`);
  }

  if (needsTests.length && !labels.has("tests-reviewed")) {
    fails.push(...needsTests.map((x) => `${x} (needs the \`tests-reviewed\` label from the dev manager)`));
  }
  if (needsDeps.length && !labels.has("deps-reviewed")) {
    fails.push(...needsDeps.map((x) => `new dependency: ${x} (needs the \`deps-reviewed\` label after checking each package ` +
      "exists, is maintained and is the one intended)"));
  }

  const report = ["## Factory guard", ""];
  report.push(...(fails.length ? fails.map((f) => `- ❌ ${f}`) : ["- ✅ no blocking findings"]));
  report.push(...warns.map((w) => `- ⚠️ ${w}`));
  if ((needsTests.length || needsDeps.length) && !fails.length) {
    report.push(...[...needsTests, ...needsDeps].map((x) => `- ✅ reviewed by label: ${x}`));
  }
  const text = report.join("\n");
  process.stdout.write(text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  return fails.length ? 1 : 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
