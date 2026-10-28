#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The GitHub side of `factory ci status`: recent CI runs on main and on open pull requests, anything queued for
// long, and (local mode) the runners registered with this project's label.
//
//   bun ci_status.ts --repo owner/name --label remanual-local [--local] [--now 2026-10-22T12:00:00Z]
//
// Reads GitHub through `gh api`. Prints plain lines; exit 0 even when GitHub can't be read (it says so).
//
// --json (#304, `factory ci status --json`): one object instead, with what ci.sh knows passed in (--mode, --runs-on,
// --docker 1|0, --instance id:name:state:manager:pid for each local runner). What GitHub can't answer is null, with
// a {code, message, fix} in "errors"; still exit 0.

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
  json: boolean;
  mode: string;
  runsOn: string | null;
  docker: boolean | null;
  instances: string[];
}

const USAGE = "usage: ci_status.ts [-h] --repo REPO --label LABEL [--local] [--light-label LIGHT_LABEL] " +
  "[--light-variable-set] [--now NOW] [--json [--mode MODE] [--runs-on VALUE] [--docker 1|0] [--instance SPEC]...]";

function parse(argv: string[]): Args {
  const a: Partial<Args> = { local: false, lightLabel: null, lightVariableSet: false, now: null, json: false,
    mode: "unknown", runsOn: null, docker: null, instances: [] };
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
    else if (t === "--json") a.json = true;
    else if (t === "--mode") a.mode = take();
    else if (t === "--runs-on") a.runsOn = take();
    else if (t === "--docker") a.docker = take() === "1";
    else if (t === "--instance") (a.instances as string[]).push(take());
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

/** Branch -> how it is shown: the default branch is "main", an open pull request's head is "#<number>". */
function branchesOf(repo: unknown, pulls: unknown): Map<string, string> {
  const mainBranch = isRow(repo) && "default_branch" in repo ? String(repo.default_branch) : "main";
  const branches = new Map<string, string>([[mainBranch, "main"]]);
  for (const p of rows(pulls)) branches.set(String((p.head as Row).ref), `#${String(p.number)}`);
  return branches;
}

/** The newest run on each of those branches (GitHub lists the newest first). */
function latestPerBranch(workflowRuns: Row[], branches: Map<string, string>): Map<string, Row> {
  const latest = new Map<string, Row>();
  for (const r of workflowRuns) {
    const b = r.head_branch;
    if (typeof b === "string" && branches.has(b) && !latest.has(b)) latest.set(b, r);
  }
  return latest;
}

function queuedLong(workflowRuns: Row[], now: number): Row[] {
  const queued = workflowRuns.filter((r) => ["queued", "waiting", "pending"].includes(String(r.status)));
  return queued.filter((r) => now - when(r.created_at) >= QUEUED_LONG_MIN * 60);
}

type Problem = { code: string; message: string; fix: string };

function runnerData(x: Row): Row {
  return { name: String(x.name), status: String(x.status), busy: Boolean(x.busy) };
}

/** "1:widget-ci:running:launchd:4242" -> {id, name, state, manager, pid}; an empty field is null. */
function instanceData(spec: string): Row {
  const [id = "", name = "", state = "", manager = "", pid = ""] = spec.split(":");
  return { id, name, state, manager: manager || null, pid: pid ? Number(pid) : null };
}

function statusJson(a: Args, now: number): Row {
  const errors: Problem[] = [];
  if (a.mode === "unknown") {
    errors.push({ code: "runs_on_unreadable", message: `gh can't read the repository variable CI_RUNS_ON; it needs admin on ${a.repo}.`,
      fix: "Run `gh auth status` to check the login, and use an account with admin on the repository." });
  }
  const runs = gh(`repos/${a.repo}/actions/runs?per_page=50`);
  const pulls = gh(`repos/${a.repo}/pulls?state=open&per_page=100`);
  const repo = gh(`repos/${a.repo}`);
  const runnersRaw = gh(`repos/${a.repo}/actions/runners?per_page=100`);
  const runnersData = runnersRaw === null ? null : isRow(runnersRaw) ? runnersRaw : {};
  if (runnersData === null) {
    errors.push({ code: "runners_unreadable", message: "The runners on GitHub can't be read (it needs admin on the repository).",
      fix: "Run `gh auth status`, and use an account with admin on the repository." });
  }
  const mine = runnersData === null ? null : listRunners(runnersData, a.label);
  let light: Row | null = null;
  if (a.lightLabel && runnersData !== null) {
    const lightRunners = listRunners(runnersData, a.lightLabel);
    light = { label: a.lightLabel, variableSet: a.lightVariableSet, runners: lightRunners.map(runnerData),
      noneOnline: !lightRunners.some((x) => x.status === "online") };
  }
  let latestRuns: Row[] | null = null;
  let queued: Row | null = null;
  if (runs === null || pulls === null) {
    errors.push({ code: "github_unreadable", message: "GitHub can't be read right now (gh offline or logged out).",
      fix: "Run `gh auth status` (and `gh auth login` if it says so), then `factory ci status --json` again." });
  } else {
    const branches = branchesOf(repo, pulls);
    const workflowRuns = isRow(runs) ? rows(runs.workflow_runs) : [];
    latestRuns = [...latestPerBranch(workflowRuns, branches)].map(([b, r]) => ({
      ref: branches.get(b) as string, branch: b, state: String(r.conclusion || r.status), name: String(r.name ?? ""),
      createdAt: String(r.created_at), minutesAgo: minutesSince(when(r.created_at), now),
    }));
    const old = queuedLong(workflowRuns, now);
    const online = mine === null ? null : mine.filter((x) => x.status === "online");
    queued = { count: old.length, longestMinutes: old.length ? Math.max(...old.map((r) => minutesSince(when(r.created_at), now))) : 0,
      thresholdMinutes: QUEUED_LONG_MIN, noRunnerOnline: a.mode === "local" && online !== null && online.length === 0 };
  }
  return { mode: a.mode, runsOn: a.runsOn, repo: a.repo, label: a.label, instances: a.instances.map(instanceData),
    docker: a.docker, runs: latestRuns, runners: mine === null ? null : mine.map(runnerData), light, queuedLong: queued,
    errors };
}

function main(argv: string[]): number {
  const a = parse(argv);
  const now = a.now ? when(a.now) : nowSeconds();
  if (a.json) {
    console.log(JSON.stringify(statusJson(a, now), null, 2));
    return 0;
  }

  const runs = gh(`repos/${a.repo}/actions/runs?per_page=50`);
  const pulls = gh(`repos/${a.repo}/pulls?state=open&per_page=100`);
  const repo = gh(`repos/${a.repo}`);
  if (runs === null || pulls === null) {
    console.log("CI runs: GitHub can't be read right now (gh offline or logged out).");
    return 0;
  }
  const branches = branchesOf(repo, pulls);
  const workflowRuns = isRow(runs) ? rows(runs.workflow_runs) : [];
  const latest = latestPerBranch(workflowRuns, branches);
  console.log("CI runs (latest per branch):");
  if (!latest.size) console.log("  none on main or on open pull requests");
  for (const [b, r] of latest) {
    const state = String(r.conclusion || r.status);
    console.log(`  ${(branches.get(b) as string).padEnd(6)} ${state.padEnd(11)} ${String(r.name ?? "")} on ${b}, ` +
      ago(when(r.created_at), now));
  }

  const old = queuedLong(workflowRuns, now);
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
