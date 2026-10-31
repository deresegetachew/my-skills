// The cockpit's views on Ink (#367, decision 0002): the Pull requests and Needs you views drawn with ink-testing-library
// from fixed data, at a narrow and a wide size, with and without colour, and their keys (j k, r, q, and m for a merge).
// Off a terminal a view prints one frame within a time limit even when its read hangs (bug 3 in #362).
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drawNeeds, drawPrs, type NeedsProps, type PrsProps } from "../cockpit/testing.tsx";
import { CI, envWith, gitRepo, HOOKS, SF, sh, tmp, write } from "./support.ts";

type Row = Record<string, unknown>;
const A = "a".repeat(40);
const B = "b".repeat(40);
const NOW = Date.parse("2026-10-31T12:00:00Z");
const ESC = /\x1b\[/;

function pr(number: number, title: string, sha: string, extra: Row = {}): Row {
  return { number, title, url: `https://github.com/o/r/pull/${number}`, branch: `task/${number}-x`, head: { sha, ageMinutes: 30 },
    ci: { state: "green", jobs: 2, notGreen: [] }, next: { action: "review", text: "review" }, ...extra };
}

/** #12 protected and approved, for the owner; #13 red with a must-fix and an open question, the agent's to fix. */
const PRS: Row = {
  generatedAt: "2026-10-31T11:59:20Z",
  pulls: [
    pr(12, "Task 7: the importer", A, { agent: "menelik", gate: "approved", protected: true,
      next: { action: "owner-merges", text: "owner merges", reason: "protected" } }),
    pr(13, "Task 8: the exporter", B, { agent: "taytu", gate: "must-fix", ci: { state: "red", jobs: 2,
      notGreen: [{ name: "unit shard 2", state: "red" }] }, next: { action: "waiting-for-agent", text: "waiting for agent" } }),
  ],
  questions: [{ kind: "pr", number: 13 }],
};

const SNAP: Row = {
  generatedAt: "2026-10-31T11:57:00Z",
  needsYou: [
    { kind: "owner-ask", id: "ship-it", issue: 77, url: "https://github.com/o/r/issues/77#c1", ageMinutes: 8, state: "owner" },
    { kind: "owner-merges", number: 9, title: "Update the factory", url: "https://github.com/o/r/pull/9" },
  ],
};

function prsProps(o: Partial<PrsProps> = {}): PrsProps {
  return { repo: "work", select: null, changes: "GitHub: it merges the pull request", cols: 140, rows: 30, color: false,
    limitSeconds: 20, load: () => Promise.resolve(PRS), act: () => Promise.resolve("merged"), refuse: () => {},
    now: () => NOW, ...o };
}

function needsProps(o: Partial<NeedsProps> = {}): NeedsProps {
  return { repo: "work", snapshot: SNAP, cols: 140, rows: 30, color: false, load: () => Promise.resolve(SNAP),
    now: () => NOW, ...o };
}

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function linesOf(frame: string): string[] {
  return frame.split("\n");
}

function fits(frame: string, cols: number, rows: number): void {
  const all = linesOf(strip(frame));
  expect(all.length, frame).toBeLessThanOrEqual(rows);
  for (const l of all) expect([...l].length, l).toBeLessThanOrEqual(cols);
}

// --- the Pull requests view --------------------------------------------------------------------------------------------

test("prs, wide and plain: the table under its heads, the first PR's detail, the keys last, no escape sequence", async () => {
  const v = drawPrs(prsProps());
  await v.settle();
  const f = v.frame();
  v.unmount();
  fits(f, 140, 30);
  expect(f).not.toMatch(ESC);
  expect(linesOf(f)[0]).toMatch(/^factory {2}work · Pull requests\s+factory prs · CI judged by the manager's rule · 40 s ago$/);
  expect(f).toMatch(/PR\s+title\s+by\s+CI\s+reviews\s+who acts\s+next/);
  const row12 = linesOf(f).find((l) => /^› #12\s/.test(l)) ?? "";
  expect(row12).toContain("Task 7: the importer · protected");
  expect(row12).toMatch(/menelik\s+green\s+✓ approved\s+you\s+owner merges/);
  expect(linesOf(f).find((l) => /^ {2}#13\s/.test(l))).toMatch(/taytu\s+red\s+✕ must-fix\s+taytu\s+waiting for agent/);
  expect(f).toMatch(/^#12 · Task 7: the importer\s+task\/12-x · menelik$/m);
  expect(f).toContain(`head ${A.slice(0, 7)} · 30 min old`);
  expect(f).toContain("protected paths yes, a person merges it");
  expect(f).toContain("https://github.com/o/r/pull/12");
  expect(linesOf(f).at(-1)).toBe("j k move · m merge · r read again · q close");
});

test("prs, narrow: no line wider than the terminal, and the number, title and CI still there", async () => {
  const v = drawPrs(prsProps({ cols: 60, rows: 20 }));
  await v.settle();
  const f = v.frame();
  v.unmount();
  fits(f, 60, 20);
  const row13 = linesOf(f).find((l) => /^ {2}#13\s/.test(l)) ?? "";
  expect(row13).toContain("Task 8");
  expect(row13).toContain("red");
  expect(f).not.toMatch(/reviews/); // the narrow table drops the reviews column first
});

test("prs, short: no more lines than the terminal has, the keys still last", async () => {
  const v = drawPrs(prsProps({ cols: 100, rows: 8 }));
  await v.settle();
  const f = v.frame();
  v.unmount();
  fits(f, 100, 8);
  expect(linesOf(f).at(-1)).toContain("q close");
});

test("prs, in colour: the same text, with CI and the word on the head in colour", async () => {
  const plain = drawPrs(prsProps());
  await plain.settle();
  const coloured = drawPrs(prsProps({ color: true }));
  await coloured.settle();
  const [p, c] = [plain.frame(), coloured.frame()];
  plain.unmount();
  coloured.unmount();
  expect(c).toMatch(ESC);
  expect(c).toContain("\x1b[32mgreen");
  expect(c).toContain("\x1b[31mred");
  expect(strip(c).replace(/\x1b\[[0-9;]*m/g, "")).toBe(p);
});

test("prs: j and the down arrow move to the next PR, k back, and the selection stops at the ends", async () => {
  const v = drawPrs(prsProps());
  await v.settle();
  await v.press("j");
  expect(v.frame()).toMatch(/^#13 · Task 8: the exporter/m);
  expect(v.frame()).toContain("unit shard 2 ✕");
  expect(v.frame()).toMatch(/questions 1 open/);
  await v.press("j");
  expect(v.frame()).toMatch(/^#13 · /m);
  await v.press("k");
  expect(v.frame()).toMatch(/^#12 · /m);
  await v.press("k");
  expect(v.frame()).toMatch(/^#12 · /m);
  await v.press("\x1b[B");
  expect(v.frame()).toMatch(/^#13 · /m);
  v.unmount();
});

test("prs: r reads again from GitHub (fresh) and shows what it read", async () => {
  const asked: boolean[] = [];
  const later = { ...PRS, pulls: [pr(20, "Task 9: a new one", A)] };
  const v = drawPrs(prsProps({ load: (fresh) => {
    asked.push(fresh);
    return Promise.resolve(fresh ? later : PRS);
  } }));
  await v.settle();
  await v.press("r");
  await v.settle();
  expect(asked).toEqual([false, true]);
  expect(v.frame()).toMatch(/^#20 · Task 9: a new one/m);
  expect(v.frame()).not.toContain("#12");
  v.unmount();
});

test("prs: q closes the view, and keys after it do nothing", async () => {
  const v = drawPrs(prsProps());
  await v.settle();
  await v.press("q");
  const after = v.frame();
  await v.press("j");
  expect(v.frame()).toBe(after);
  expect(after).not.toMatch(/^#13 · /m);
  v.unmount();
});

test("prs: m asks first, y merges the selected PR pinned to the head shown, and any key then reads again", async () => {
  const ran: string[][] = [];
  const asked: boolean[] = [];
  const v = drawPrs(prsProps({ act: (w) => {
    ran.push(w);
    return Promise.resolve("#13 merged.");
  }, load: (fresh) => {
    asked.push(fresh);
    return Promise.resolve(PRS);
  } }));
  await v.settle();
  await v.press("j");
  await v.press("m");
  expect(v.frame()).toContain(`Run \`factory owner merge 13 --head ${B}\`? It changes GitHub: it merges the pull request. [y/N]`);
  expect(ran).toEqual([]);
  await v.press("y");
  await v.settle();
  expect(ran).toEqual([["owner", "merge", "13", "--head", B]]);
  expect(v.frame()).toContain("#13 merged.");
  await v.press(" ");
  await v.settle();
  expect(asked).toEqual([false, true]);
  expect(v.frame()).toMatch(/^#13 · /m);
  v.unmount();
});

test("prs: m then any key but y runs nothing and says so", async () => {
  const ran: string[][] = [];
  const v = drawPrs(prsProps({ act: (w) => {
    ran.push(w);
    return Promise.resolve("");
  } }));
  await v.settle();
  await v.press("m");
  await v.press("n");
  expect(ran).toEqual([]);
  expect(v.frame()).toContain("Not run: nothing changed.");
  v.unmount();
});

test("prs: a PR with no head commit can't be merged from the view", async () => {
  const v = drawPrs(prsProps({ load: () => Promise.resolve({ pulls: [{ number: 5, title: "no head" }] }) }));
  await v.settle();
  await v.press("m");
  expect(v.frame()).toContain("no head commit");
  v.unmount();
});

test("prs: --prs <n> selects that PR; one that is not open is refused with code, message and fix", async () => {
  const v = drawPrs(prsProps({ select: 13 }));
  await v.settle();
  expect(v.frame()).toMatch(/^#13 · /m);
  v.unmount();
  const refused: Row[] = [];
  const w = drawPrs(prsProps({ select: 99, refuse: (p) => refused.push(p) }));
  await w.settle();
  w.unmount();
  expect(refused).toHaveLength(1);
  expect(refused[0]?.code).toBe("cockpit_no_pr");
  expect(typeof refused[0]?.fix).toBe("string");
});

test("prs: while reading it says so; a read past the time limit, or none at all, says what to run", async () => {
  let done: (g: Row) => void = () => {};
  const v = drawPrs(prsProps({ load: () => new Promise((r) => { done = r; }) }));
  await v.settle();
  expect(v.frame()).toContain("Reading the pull requests…");
  done(PRS);
  await v.settle();
  expect(v.frame()).toMatch(/^#12 · /m);
  v.unmount();
  const late = drawPrs(prsProps({ load: () => Promise.resolve("late") }));
  await late.settle();
  expect(late.frame()).toContain("Can't read the pull requests in 20 s");
  expect(late.frame()).toContain("factory prs");
  late.unmount();
  const none = drawPrs(prsProps({ load: () => Promise.resolve({ pulls: { error: "gh: not logged in" } }) }));
  await none.settle();
  expect(none.frame()).toContain("gh auth status");
  none.unmount();
});

test("prs: a title or branch can't drive the terminal", async () => {
  const evil = { pulls: [pr(12, "evil\x1b]0;pwned\x07 \x1b[31mred\x1b[0m\rtitle", A, { branch: "task/7-\x1b[2Jx" })] };
  const v = drawPrs(prsProps({ load: () => Promise.resolve(evil) }));
  await v.settle();
  const f = v.frame();
  v.unmount();
  expect(f).toContain("evil");
  expect(f.replace(/\n/g, "")).not.toMatch(/[\x00-\x1f\x7f]/);
});

// --- the Needs you view ------------------------------------------------------------------------------------------------

test("needs, wide and plain: each thing with its link and age, the selected one's next step, the keys last", async () => {
  const v = drawNeeds(needsProps());
  await v.settle();
  const f = v.frame();
  v.unmount();
  fits(f, 140, 30);
  expect(f).not.toMatch(ESC);
  expect(linesOf(f)[0]).toMatch(/^factory {2}work · Needs you\s+from the cockpit's snapshot · 3 min ago$/);
  expect(f).toContain("FOR YOU · 2");
  expect(f).toMatch(/^› Owner ask ship-it on #77, the product owner replied: https:\/\/github\.com\/o\/r\/issues\/77#c1\s+8 min$/m);
  expect(f).toMatch(/^ {2}PR #9 Update the factory is yours to merge: https:\/\/github\.com\/o\/r\/pull\/9$/m);
  expect(f).toContain("factory owner answer ship-it");
  expect(linesOf(f).at(-1)).toBe("j k move · r read again · q close");
});

test("needs, narrow and in colour: no line wider than the terminal, the same text as without colour", async () => {
  const plain = drawNeeds(needsProps({ cols: 50, rows: 14 }));
  await plain.settle();
  const coloured = drawNeeds(needsProps({ cols: 50, rows: 14, color: true }));
  await coloured.settle();
  const [p, c] = [plain.frame(), coloured.frame()];
  plain.unmount();
  coloured.unmount();
  fits(p, 50, 14);
  expect(p).toContain("› Owner ask ship-it");
  expect(c).toMatch(ESC);
  expect(strip(c)).toBe(p);
});

test("needs: j selects the next one, k goes back, r reads the snapshot again, q closes", async () => {
  let reads = 0;
  const v = drawNeeds(needsProps({ load: () => {
    reads += 1;
    return Promise.resolve({ needsYou: [] });
  } }));
  await v.settle();
  await v.press("j");
  expect(v.frame()).toMatch(/^› PR #9/m);
  expect(v.frame()).toContain("factory owner merge 9");
  await v.press("k");
  expect(v.frame()).toMatch(/^› Owner ask/m);
  await v.press("r");
  await v.settle();
  expect(reads).toBe(1);
  expect(v.frame()).toContain("Nothing needs you.");
  await v.press("q");
  const after = v.frame();
  await v.press("r");
  expect(reads).toBe(1);
  expect(v.frame()).toBe(after);
  v.unmount();
});

test("needs: no snapshot yet says how to read one", async () => {
  const v = drawNeeds(needsProps({ snapshot: null }));
  await v.settle();
  expect(v.frame()).toContain("No snapshot yet: `factory cockpit --json` reads one now.");
  v.unmount();
});

// --- off a terminal, within a time limit (bug 3 in #362) ------------------------------------------------------------------

/** A gh that never answers, and leaves a child holding its output open, as a slow GitHub read did. */
const HANGING_GH = "#!/usr/bin/env bash\nsleep 90 &\nwait\n";

test("factory cockpit --prs off a terminal prints one frame within the time limit when GitHub never answers", () => {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" } }));
  write(join(root, "bin", "gh"), HANGING_GH, 0o755);
  const env = envWith(join(root, "bin"), { XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined,
    FACTORY_CONFIG_DIR: undefined, TMUX: undefined, COLUMNS: "120", LINES: "30", NO_COLOR: "1" });
  const started = Date.now();
  const r = sh(["bash", join(SF, "factory"), "cockpit", "--prs"], { cwd: d, env, timeoutMs: 60_000 });
  const took = (Date.now() - started) / 1000;
  expect(r.code, r.out).toBe(0);
  expect(took, r.out).toBeLessThan(40);
  expect(r.stdout).toContain("Can't read the pull requests in 20 s");
  expect(r.stdout).toContain("q close");
}, 90_000);
