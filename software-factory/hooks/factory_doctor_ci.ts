// What `factory doctor` says about CI and the agents before a test run (#205, and the doctor part of #199).
//
// Four read-only checks, each an `ok`, `fix` (with the step) or `note`; everything it asks of GitHub is a `gh api` GET:
//
//   1. the repo variables CI_RUNS_ON and CI_RUNS_ON_LIGHT, and whether a runner with that label is online (a runner
//      that is missing is looked for again for a while first: a heavy runner's container restarts after every job, #246)
//   2. whether the newest run of the workflows on the main branch is green
//   3. in-progress issues held by an agent that is down (issues mode), and open Agent issues for names that are not
//      configured agents or roles (they never ran here)
//   4. a workflow whose setup does not match .claude/factory.json (pnpm/Node steps with no package.json, or a command
//      the workflow runs that factory.json leaves empty)
//
// A GitHub answer it can't read (no admin for the runners, gh signed out) is skipped or a note, never a fix.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Config, ROLE_NAMES, roleNames, taskSource, toFloat } from "./factory_config.ts";
import * as A from "./factory_agents.ts";
import { Exit, pyRepr, run, sleepSync } from "./factory_lib.ts";

/** Where the checks report: the doctor's report (`ok`, `fix` with the step, `note`). */
export interface Report {
  ok(what: string): void;
  fix(what: string, how: string): void;
  note(what: string, how: string): void;
}

export const REPO = "repos/{owner}/{repo}/";
export const VARIABLES = ["CI_RUNS_ON", "CI_RUNS_ON_LIGHT"] as const;
export const RUN_COMMANDS = ["typecheck", "lint", "test", "build"] as const;

type Row = Record<string, unknown>;

/** A `gh api` GET as JSON, or null when it fails or answers nothing readable. */
export function get(path: string): unknown {
  const p = run(["gh", "api", path], { timeoutMs: 30_000 });
  if (p.code !== 0 || !p.stdout.trim()) return null;
  try {
    return JSON.parse(p.stdout) as unknown;
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The runner labels a runs-on variable asks for: a JSON list, or one JSON string. */
export function labelsOf(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      parsed = value;
    }
  }
  if (typeof parsed === "string") return [parsed];
  return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
}

/** A Python list of strings as Python prints it: ['self-hosted', 'x-local']. */
function pyList(items: string[]): string {
  return "[" + items.map(pyRepr).join(", ") + "]";
}

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  return String(v);
}

function runnerLabels(x: Row): Set<string> {
  const labels = Array.isArray(x.labels) ? x.labels : [];
  return new Set(labels.map((l) => (isObject(l) && typeof l.name === "string" ? l.name : "").toLowerCase()));
}

function onlineWith(pool: Row[], need: Set<string>): Row[] {
  return pool.filter((x) => {
    if (x.status !== "online") return false;
    const have = runnerLabels(x);
    return [...need].every((l) => have.has(l));
  });
}

function seconds(name: string, dflt: string): number | null {
  const f = toFloat(process.env[name] ?? dflt);
  return f === null || Number.isNaN(f) ? null : f;
}

/** The runner pool again, until a runner with the labels is online or the wait is over (#246). A heavy runner's
 * container restarts after every job, and for a few seconds it has no registration; doctor must not report that gap.
 * FACTORY_DOCTOR_RUNNER_WAIT seconds (default 30), looking every FACTORY_DOCTOR_RUNNER_STEP seconds (default 5). */
export function waitForRunner(pool: Row[], need: Set<string>): [Row[], Row[]] {
  let limit = seconds("FACTORY_DOCTOR_RUNNER_WAIT", "30");
  let step = seconds("FACTORY_DOCTOR_RUNNER_STEP", "5");
  if (limit === null || step === null) [limit, step] = [30, 5];
  let waited = 0;
  for (;;) {
    const online = onlineWith(pool, need);
    if (online.length || waited >= limit || step <= 0) return [online, pool];
    sleepSync(step);
    waited += step;
    const found = get(REPO + "actions/runners");
    if (isObject(found) && Array.isArray(found.runners)) pool = found.runners.filter(isObject);
  }
}

export function runners(r: Report, variables: unknown[]): void {
  const wanted = new Map<string, unknown>();
  for (const v of variables) {
    if (isObject(v) && (VARIABLES as readonly string[]).includes(v.name as string)) wanted.set(v.name as string, v.value ?? null);
  }
  if (!wanted.size) return;
  const found = get(REPO + "actions/runners");
  let pool: Row[] | null = isObject(found) && Array.isArray(found.runners) ? found.runners.filter(isObject) : null;
  for (const name of VARIABLES) {
    if (!wanted.has(name)) continue;
    const value = pyStr(wanted.get(name));
    const labels = labelsOf(wanted.get(name));
    if (!labels.map((l) => l.toLowerCase()).includes("self-hosted")) {
      r.ok(`${name} ${value}: GitHub's own runners, nothing to keep online`);
      continue;
    }
    if (pool === null) {
      r.note(`${name} runner`, `can't read the repo's runners (it needs admin on the repo), so I can't tell whether one with ` +
        `${pyList(labels)} is online: check Settings > Actions > Runners`);
      continue;
    }
    const need = new Set(labels.map((l) => l.toLowerCase()));
    let online: Row[];
    [online, pool] = waitForRunner(pool, need);
    if (online.length) {
      r.ok(`${name} ${value}: runner ${pyStr((online[0] as Row).name)} is online`);
    } else {
      r.fix(`${name} ${value}`, `no online runner has the labels ${pyList(labels)}, so jobs wait for ever: start it with \`factory ci install\` ` +
        "(`factory ci status` shows the runners), or point the variable at one that exists (Settings > Secrets and variables > " +
        "Actions > Variables), or delete it to use GitHub's runners");
    }
  }
}

export function newestRun(r: Report, main: string): void {
  const found = get(REPO + `actions/runs?branch=${main}&per_page=1`);
  const runs = isObject(found) && "workflow_runs" in found ? found.workflow_runs : null;
  if (runs === null || runs === undefined) return;
  if (!Array.isArray(runs) || !runs.length) {
    r.note(`CI on ${main}`, "no workflow run on the main branch yet");
    return;
  }
  const one = (isObject(runs[0]) ? runs[0] : {}) as Row;
  const status = one.status ?? null;
  const url = pyStr(one.html_url ?? "");
  if (status !== null && status !== "completed") {
    r.note(`CI on ${main}`, `the newest run is ${pyStr(status)} (${url})`);
  } else if (one.conclusion === "success") {
    r.ok(`CI on ${main}: the newest run is green`);
  } else {
    r.fix(`CI on ${main}`, `the newest run ${pyStr(one.conclusion)} (${url}), so every agent pull request will fail too: ` +
      "open it, fix the workflow or the code, and merge that before agents start");
  }
}

export function agents(r: Report, cfg: Config): void {
  let stale: [number, string, string][];
  let issues: ReturnType<typeof A.agentIssues>;
  try {
    stale = A.staleClaims(cfg);
    issues = A.agentIssues();
  } catch (e) {
    if (e instanceof Exit) return;
    throw e;
  }
  for (const [number, name, status] of stale) {
    r.note(`#${number} held by ${name} (${status})`, `\`factory next\` skips it until the sweep frees it: run \`factory issues release ${number}\` ` +
      "now, or start the agent again");
  }
  const configured = new Set<string>([...(cfg.agents ?? []), ...ROLE_NAMES.flatMap((role) => roleNames(cfg, role))]);
  for (const [name, found] of A.byAgent(issues)) {
    const issue = found[0];
    if (issue && issue.state === "open" && !configured.has(name)) {
      r.note(`Agent issue #${issue.number} for ${name}`, `${name} is not an agent or role name in .claude/factory.json, so it never ran ` +
        `here: close #${issue.number} (an old test run left it)`);
    }
  }
}

function workflowFiles(): string[] {
  const dir = join(".github", "workflows");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => (n.endsWith(".yml") || n.endsWith(".yaml")) && !n.startsWith(".")).map((n) => join(dir, n)).sort();
}

export function workflow(r: Report, cfg: Config): void {
  const commands = (cfg.commands ?? {}) as unknown as Record<string, unknown>;
  for (const path of workflowFiles()) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const name = basename(path);
    if (/pnpm\/action-setup|actions\/setup-node|\bpnpm (install|i)\b/.test(text) && !existsSync("package.json")) {
      const test = (commands.test as string) || "";
      r.fix(name, "it installs pnpm and Node but the project has no package.json, so CI fails before any agent runs: replace those " +
        "steps with this project's own setup and commands" + (test ? ` (commands.test is \`${test}\`)` : " (set commands.test in .claude/factory.json first)"));
    }
    for (const cmd of RUN_COMMANDS) {
      if (new RegExp(`run:\\s*pnpm (run )?${cmd}\\b`).test(text) && !commands[cmd]) {
        r.fix(`${name} runs \`pnpm ${cmd}\``, `commands.${cmd} in .claude/factory.json is empty, so the Stop check and \`factory verify\` ` +
          `skip what CI runs: set it with \`factory settings set commands.${cmd} '<command>'\`, or take the step out of the workflow`);
      }
    }
  }
}

/** Every check above, onto the doctor's report. */
export function checks(r: Report, cfg: Config): void {
  const variables = get(REPO + "actions/variables");
  if (isObject(variables)) runners(r, Array.isArray(variables.variables) ? variables.variables : []);
  newestRun(r, cfg.mainBranch || "main");
  if (taskSource(cfg) === "issues") agents(r, cfg);
  workflow(r, cfg);
}
