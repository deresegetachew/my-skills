#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory status`: one read-only view of the whole factory, across machines (#64).
//
//   Agents     every agent on every machine (issues mode: their agent issues): working, idle, silent or down
//   Here       this machine's claims (which local agent holds which folder and task)
//   PRs        open pull requests: draft, CI, the reviewer's pass for the head (when the marker is on this machine),
//              the dev manager's hold, must-fix or approval, which dev manager has claimed the head for review
//              (a lease, #99), and "a person merges this one"
//   CI         runs queued and the oldest one's age, and the self-hosted runners (when GitHub lets us see them)
//   Tasks      issues mode: ready (by milestone), in progress, in review, blocked; plan mode: the next task
//
// Everything comes from `gh api` (GitHub's REST API), git and local files. It changes nothing on GitHub or in the
// working tree; in plan mode `next_task.ts` runs a `git fetch` to see main's plan. A section
// GitHub can't answer says so and the rest still shows.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_status.ts [--json]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentIssues, current, stateOf } from "./factory_agents.ts";
import { type Config, load, loadFromMain, taskLabels, taskSource } from "./factory_config.ts";
import { names, taskIssues } from "./factory_issues.ts";
import { bunCmd, isoUtc, parseArgs, parseIso, pyDumps, run, runMain } from "./factory_lib.ts";
import { passFile } from "./factory_review_pass.ts";
import { nowUtc } from "./factory_manager_claims.ts";
import { type Failed, ciState as judgedCi, claimOf, gateWord, isFailed, section, trustedOf } from "./factory_prs.ts";

const HOOKS = import.meta.dir;

type Obj = { [key: string]: unknown };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function gh(path: string): unknown {
  const p = run(["gh", "api", path]);
  if (p.code !== 0) throw new Error((p.stderr || p.stdout).trim().slice(0, 200) || "gh api failed");
  return p.stdout.trim() ? (JSON.parse(p.stdout) as unknown) : null;
}

function ago(stamp: string | null | undefined, now: number): string {
  const t = parseIso(stamp);
  if (t === null) return "";
  const m = Math.floor((now - t) / 60);
  return m < 120 ? `${m} min` : `${Math.floor(m / 60)} h`;
}

/** Python's round(): half to even. */
function round(x: number): number {
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 ? 2 * Math.round(x / 2) : r;
}

type Agents = { note: string } | { agents: { name: string; status: string; lastPing: string; minutesAgo: number }[] };

function agents(cfg: Config): Agents {
  if (taskSource(cfg) !== "issues") return { note: "agents report on GitHub in issues mode only (tasks.source \"issues\")" };
  const rows = current(agentIssues()).map((i) => stateOf(cfg, i)).filter((r) => r !== null);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] - b[2]));
  return { agents: rows.map(([n, s, t, q]) => ({ name: n, status: s, lastPing: isoUtc(t), minutesAgo: round(q) })) };
}

function lastLine(p: { code: number; stdout: string; stderr: string }, what: string): string {
  const text = (p.stderr || p.stdout || "").trim();
  return text ? (text.split(/\r?\n/).at(-1) as string) : `${what} exited ${p.code}`;
}

function here(): { claims: string[] } {
  const p = run([...bunCmd(join(HOOKS, "factory_claims.ts")), "list"]);
  if (p.code !== 0) throw new Error(lastLine(p, "factory_claims.ts"));
  return { claims: p.stdout.split("\n").filter((l) => l.trim()) };
}

function marker(branch: string, sha: string, kind: string): boolean | null {
  try {
    const path = passFile(branch, kind); // in the git folder (#260)
    return path === null ? null : readFileSync(path, "utf8").trim() === sha;
  } catch {
    return null; // not on this machine
  }
}

/** The CI rule of `factory prs` (factory_prs.ts), in the words this view has always used. */
function ciState(sha: string): string {
  const state = judgedCi(sha)[0];
  return state === "red" ? "failed" : state;
}

interface StatusPull {
  number: number;
  title: string;
  branch: string;
  draft: boolean;
  ci: string;
  reviewed: boolean | null;
  hold: boolean;
  devManager: string | null;
  claim: { manager: string; until: string } | null;
  personMerges: boolean;
}

function pulls(cfg: Config): { pulls: StatusPull[] } {
  // Main's settings, as the gate reads them: an agent can't widen trustedReviewers in its own copy.
  let gateCfg: Config;
  try {
    gateCfg = loadFromMain(cfg);
  } catch {
    gateCfg = cfg;
  }
  const trusted = trustedOf(gateCfg);
  const hold = gateCfg.holdLabel ?? "factory-hold";
  const one = (p: Obj): StatusPull => {
    const sha = str(obj(p.head).sha);
    const branch = str(obj(p.head).ref);
    const labels = new Set((Array.isArray(p.labels) ? p.labels : []).map((x) => str(obj(x).name)));
    const got = gh(`repos/{owner}/{repo}/issues/${String(p.number)}/comments?per_page=100`);
    const comments = (Array.isArray(got) ? got : []).map(obj);
    const dm = gateWord(comments, sha, trusted);
    const [held] = claimOf(comments, sha, nowUtc());
    return { number: Number(p.number), title: str(p.title), branch, draft: Boolean(p.draft), ci: ciState(sha),
      reviewed: marker(branch, sha, ".ok"), hold: labels.has(hold), devManager: dm,
      claim: held ? { manager: held.manager, until: held.until } : null,
      personMerges: str(p.body).toLowerCase().includes("a person merges this one") };
  };
  const list = gh("repos/{owner}/{repo}/pulls?state=open&per_page=100");
  return { pulls: (Array.isArray(list) ? list : []).map(obj).map(one) };
}

type Ci = { queued: number; oldestQueued: string | null; runners: { name: string; status: unknown; busy: boolean }[] | null };

function ci(now: number): Ci {
  const got = obj(gh("repos/{owner}/{repo}/actions/runs?status=queued&per_page=100")).workflow_runs;
  const runs = (Array.isArray(got) ? got : []).map(obj);
  const stamps = runs.map((r) => str(r.created_at)).sort();
  const oldest = stamps.length ? (stamps[0] as string) : null;
  const out: Ci = { queued: runs.length, oldestQueued: oldest ? ago(oldest, now) : null, runners: null };
  try {
    const rs = obj(gh("repos/{owner}/{repo}/actions/runners?per_page=100")).runners;
    out.runners = (Array.isArray(rs) ? rs : []).map(obj).map((r) => ({ name: str(r.name), status: r.status ?? null, busy: Boolean(r.busy) }));
  } catch {
    out.runners = null; // listing runners needs admin on the repository
  }
  return out;
}

type Tasks = { next: string } | { ready: Record<string, number>; inProgress: number; inReview: number; blocked: number };

function tasks(cfg: Config): Tasks {
  if (taskSource(cfg) !== "issues") {
    const p = run(bunCmd(join(HOOKS, "next_task.ts")));
    const out = p.stdout.trim();
    if (p.code === 0 && out) return { next: out };
    if (p.code === 1 && out === "none") return { next: "nothing ready" };
    throw new Error(lastLine(p, "next_task.ts"));
  }
  const L = taskLabels(cfg);
  const counts = { inProgress: 0, inReview: 0, blocked: 0 };
  const ready: Record<string, number> = {};
  for (const i of taskIssues()) {
    const n = names(i);
    if (n.has(L.blocked)) counts.blocked += 1;
    else if (n.has(L.inReview)) counts.inReview += 1;
    else if (n.has(L.inProgress)) counts.inProgress += 1;
    else if (n.has(L.ready)) {
      const m = (i.milestone ?? {}).title || "no milestone";
      ready[m] = (ready[m] ?? 0) + 1;
    }
  }
  return { ready, ...counts };
}

interface Status {
  agents: Agents | Failed;
  here: { claims: string[] } | Failed;
  pulls: { pulls: StatusPull[] } | Failed;
  ci: Ci | Failed;
  tasks: Tasks | Failed;
}

function show(s: Status, taskMode = "plan"): void {
  const err = (part: Failed): string => `  can't read it: ${part.error}`;
  console.log("Agents (all machines)");
  const a = s.agents;
  if (isFailed(a)) console.log(err(a));
  else if ("note" in a) console.log("  " + a.note);
  else {
    console.log(a.agents.map((x) => `  ${x.name.padEnd(12)} ${x.status.padEnd(8)} last ping ${x.minutesAgo} min ago`).join("\n")
      || "  none registered");
  }
  console.log("This machine");
  const h = s.here;
  console.log(isFailed(h) ? `  claims: can't read them: ${h.error}` : h.claims.map((l) => "  " + l).join("\n") || "  no claims");
  console.log("Pull requests");
  const p = s.pulls;
  if (isFailed(p)) console.log(err(p));
  for (const x of isFailed(p) ? [] : p.pulls) {
    const flags = x.draft ? ["draft"] : [];
    flags.push(`CI ${x.ci}`);
    if (x.reviewed !== null) flags.push(x.reviewed ? "reviewed" : "not reviewed");
    if (x.claim) flags.push(`claimed by ${x.claim.manager} until ${x.claim.until.slice(11, 16)} UTC`);
    for (const [f, on] of [["hold", x.hold], [x.devManager, x.devManager], ["a person merges it", x.personMerges]] as const) {
      if (on) flags.push(f as string);
    }
    console.log(`  #${String(x.number).padEnd(5)} ${x.branch.slice(0, 40).padEnd(40)} ${flags.join(", ")}`);
  }
  if (!isFailed(p) && !p.pulls.length) console.log("  none open");
  console.log("CI");
  const c = s.ci;
  if (isFailed(c)) console.log(err(c));
  else {
    console.log(`  ${c.queued} queued` + (c.oldestQueued ? `, the oldest for ${c.oldestQueued}` : ""));
    if (c.runners === null) console.log("  runners: can't be listed (it needs admin on the repository)");
    else if (c.runners.length) {
      console.log("  runners: " + c.runners.map((r) => `${r.name} ${String(r.status ?? "None")}${r.busy ? " busy" : ""}`).join(", "));
    }
  }
  console.log("Tasks");
  const t = s.tasks;
  if (isFailed(t) && taskMode !== "issues") console.log(`  next task: can't read it: ${t.error}`);
  else if (isFailed(t)) console.log(err(t));
  else if ("next" in t) console.log(`  next: ${t.next}`);
  else {
    const ready = Object.entries(t.ready).map(([m, n]) => `${n} in ${m}`).join(", ") || "none";
    console.log(`  ready: ${ready}`);
    console.log(`  in progress ${t.inProgress}, in review ${t.inReview}, blocked ${t.blocked}`);
  }
}

const PROG = "factory_status.ts";
const USAGE = `usage: ${PROG} [-h] [--json]`;

export function main(argv: string[]): number {
  const a = parseArgs(argv, { flags: ["--json"] }, PROG, USAGE);
  const cfg = load();
  const now = Date.now() / 1000;
  const s: Status = { agents: section(() => agents(cfg)), here: section(here), pulls: section(() => pulls(cfg)),
    ci: section(() => ci(now)), tasks: section(() => tasks(cfg)) };
  if (a.json) console.log(pyDumps(s, { indent: 2 }));
  else show(s, taskSource(cfg));
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
