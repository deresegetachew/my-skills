#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The GitHub side of `factory ci status`: recent CI runs on main and on open pull requests, anything queued for
// long, and (local mode) the runners registered with this project's label.
//
//   bun ci_status.ts --repo owner/name --label remanual-local [--local] [--now 2026-10-22T12:00:00Z]
//
// Reads GitHub through `gh api`. Prints plain lines; exit 0 even when GitHub can't be read (it says so).

// Self-contained (no import from ../hooks): ci.sh runs it from wherever its own folder is, alone.

function die(code: number): never {
  process.exit(code);
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function parseIso(text: string): number | null {
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t / 1000;
}

function run(cmd: string[]): { code: number; stdout: string } {
  try {
    const p = Bun.spawnSync(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
  } catch {
    return { code: 127, stdout: "" };
  }
}

const QUEUED_LONG_MIN = 15; // a run queued longer than this is called out

type Row = { [key: string]: unknown };

function gh(path: string): unknown {
  const p = run(["gh", "api", path]);
  if (p.code !== 0) return null;
  try {
    return JSON.parse(p.stdout) as unknown;
  } catch {
    return null;
  }
}

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rows(v: unknown): Row[] {
  return Array.isArray(v) ? v.filter(isRow) : [];
}

function when(s: unknown): number {
  const t = parseIso(String(s));
  if (t === null) throw new Error(`not a time: ${String(s)}`);
  return t;
}

function minutesSince(t: number, now: number): number {
  return Math.floor((now - t) / 60);
}

function ago(t: number, now: number): string {
  const m = minutesSince(t, now);
  return m < 120 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

interface Args {
  repo: string;
  label: string;
  local: boolean;
  lightLabel: string | null;
  lightVariableSet: boolean;
  now: string | null;
}

const USAGE = "usage: ci_status.ts [-h] --repo REPO --label LABEL [--local] [--light-label LIGHT_LABEL] " +
  "[--light-variable-set] [--now NOW]";

function parse(argv: string[]): Args {
  const a: Partial<Args> = { local: false, lightLabel: null, lightVariableSet: false, now: null };
  const err = (msg: string): never => {
    process.stderr.write(`${USAGE}\nci_status.ts: error: ${msg}\n`);
    return die(2);
  };
  for (let i = 0; i < argv.length; i++) {
    let t = argv[i] as string;
    let value: string | undefined;
    if (t.startsWith("--") && t.includes("=")) {
      value = t.slice(t.indexOf("=") + 1);
      t = t.slice(0, t.indexOf("="));
    }
    const take = (): string => {
      if (value !== undefined) return value;
      const v = argv[++i];
      if (v === undefined) return err(`argument ${t}: expected one argument`);
      return v;
    };
    if (t === "--repo") a.repo = take();
    else if (t === "--label") a.label = take();
    else if (t === "--local") a.local = true;
    else if (t === "--light-label") a.lightLabel = take();
    else if (t === "--light-variable-set") a.lightVariableSet = true;
    else if (t === "--now") a.now = take();
    else if (t === "-h" || t === "--help") {
      console.log(USAGE);
      die(0);
    } else err(`unrecognized arguments: ${argv.slice(i).join(" ")}`);
  }
  const missing = [a.repo === undefined ? "--repo" : "", a.label === undefined ? "--label" : ""].filter(Boolean);
  if (missing.length) err(`the following arguments are required: ${missing.join(", ")}`);
  return a as Args;
}

function listRunners(data: Row | null, label: string): Row[] {
  return rows(data?.runners).filter((x) => rows(x.labels).some((lab) => lab.name === label));
}

function runnerLine(x: Row): string {
  return `  ${String(x.name)}: ${String(x.status)}${x.busy ? ", busy" : ""}`;
}

function main(argv: string[]): number {
  const a = parse(argv);
  const now = a.now ? when(a.now) : nowSeconds();

  const runs = gh(`repos/${a.repo}/actions/runs?per_page=50`);
  const pulls = gh(`repos/${a.repo}/pulls?state=open&per_page=100`);
  const repo = gh(`repos/${a.repo}`);
  if (runs === null || pulls === null) {
    console.log("CI runs: GitHub can't be read right now (gh offline or logged out).");
    return 0;
  }
  const mainBranch = isRow(repo) && "default_branch" in repo ? String(repo.default_branch) : "main";
  const branches = new Map<string, string>([[mainBranch, "main"]]);
  for (const p of rows(pulls)) branches.set(String((p.head as Row).ref), `#${String(p.number)}`);
  const workflowRuns = isRow(runs) ? rows(runs.workflow_runs) : [];
  const latest = new Map<string, Row>();
  for (const r of workflowRuns) {
    const b = r.head_branch;
    if (typeof b === "string" && branches.has(b) && !latest.has(b)) latest.set(b, r);
  }
  console.log("CI runs (latest per branch):");
  if (!latest.size) console.log("  none on main or on open pull requests");
  for (const [b, r] of latest) {
    const state = String(r.conclusion || r.status);
    console.log(`  ${(branches.get(b) as string).padEnd(6)} ${state.padEnd(11)} ${String(r.name ?? "")} on ${b}, ` +
      ago(when(r.created_at), now));
  }

  const queued = workflowRuns.filter((r) => ["queued", "waiting", "pending"].includes(String(r.status)));
  const old = queued.filter((r) => now - when(r.created_at) >= QUEUED_LONG_MIN * 60);
  let online: Row[] | null = null;
  if (a.local) {
    const raw = gh(`repos/${a.repo}/actions/runners?per_page=100`);
    const data = raw === null ? null : isRow(raw) ? raw : {};
    const mine = listRunners(data, a.label);
    console.log(data !== null ? `Runners on GitHub with the label ${a.label}:`
      : "Runners on GitHub: can't be read (it needs admin on the repository).");
    for (const x of mine) console.log(runnerLine(x));
    if (data !== null && !mine.length) console.log("  none registered right now");
    online = data === null ? null : mine.filter((x) => x.status === "online");
  }
  // The light lane (#90): listed whenever there is one, and a CI_RUNS_ON_LIGHT that no online runner has is a
  // stuck Factory guard, in either mode (the workflow tries CI_RUNS_ON_LIGHT first).
  if (a.lightLabel) {
    const raw = gh(`repos/${a.repo}/actions/runners?per_page=100`);
    if (raw !== null) {
      const light = listRunners(isRow(raw) ? raw : {}, a.lightLabel);
      console.log(`Light lane (${a.lightLabel}, the Factory guard):`);
      for (const x of light) console.log(runnerLine(x));
      if (!light.length) console.log("  none registered right now");
      if (a.lightVariableSet && !light.some((x) => x.status === "online")) {
        console.log(`Warning: CI_RUNS_ON_LIGHT asks for ${a.lightLabel}, and no runner with that label is online, so ` +
          "every Factory guard waits. Start the light runner (factory ci install), or delete CI_RUNS_ON_LIGHT " +
          "so the guard uses CI_RUNS_ON.");
      }
    }
  }
  if (old.length) {
    const longest = Math.max(...old.map((r) => minutesSince(when(r.created_at), now)));
    let msg = `Waiting: ${old.length} run${old.length > 1 ? "s" : ""} queued for up to ${longest} min`;
    if (a.local && online !== null && online.length === 0) {
      msg += `, and no runner with the label ${a.label} is online. Is the runner running (factory ci status ` +
        "above), Docker up and the machine awake? `factory ci use github` sends jobs back to GitHub.";
    }
    console.log(msg);
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
