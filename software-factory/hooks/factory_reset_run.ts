#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory reset-run`: lists, and with --apply cleans, what an earlier run left in this project before a test run (#229).
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_reset_run.ts                 the plan, one line per thing; nothing is changed
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_reset_run.ts --apply         does each step and says what it did; a second run finds nothing
//   ... --agent NAME (repeatable)                                         also close NAME's Agent issue when it runs on another machine
//
// Four kinds of leftovers, all of this project (its checkout, its repo, its CI containers) and nothing else:
//   claim      this machine's local claims whose process is gone (what `factory release` lets go)
//   agent      open Agent issues of an agent that is down for good, or whose name is not a configured agent (it never ran);
//              never one whose agent is alive here. A down or silent agent that runs on another machine (its issue names
//              that machine, and this machine is not configured to run it) is only offline there: its issue stays open
//              unless the person names it with --agent (#236)
//   container  exited CI containers of this project's compose projects (<ci name>, <ci name>-N, <ci name>-light)
//   runner     this project's registered self-hosted runners (<ci name>-...) that are offline and idle
//   variable   CI_RUNS_ON or CI_RUNS_ON_LIGHT that asks for self-hosted runners when none with those labels is online (it is
//              deleted, so jobs use GitHub's runners)
// `factory ci clean` (factory_ci_clean.ts, #282) uses the same ciSteps() for the container and runner kinds.
// Errors are {code, message, fix} on stderr with exit 1. Every GitHub and Docker call goes through ghApi() and docker().
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { names as ciNamesOf } from "../ci/ci_names.ts";
import { agentIssues, byAgent, machineOf, stateOf } from "./factory_agents.ts";
import { type Config, load, roleNames, ROLE_NAMES, taskSource } from "./factory_config.ts";
import { type Claim, alive, release } from "./factory_claims.ts";
import { aliveHere } from "./factory_heartbeat.ts";
import { gh } from "./factory_issues.ts";
import { Exit, git, pyDumps, run, runMain, which } from "./factory_lib.ts";
import { machineId, machineNames } from "./factory_machine.ts";

const REPO = "repos/{owner}/{repo}/";
const VARIABLES = ["CI_RUNS_ON", "CI_RUNS_ON_LIGHT"];

type Obj = { [key: string]: unknown };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

export class Refusal extends Error {
  readonly body: { code: string; message: string; fix: string };
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.body = { code, message, fix };
  }
}

/** One `gh api` call; the parsed answer ({} for an empty one). Throws Refusal when gh fails. */
export function ghApi(path: string, method = "GET"): unknown {
  const p = run(["gh", "api", "-X", method, path], { timeoutMs: 60_000 });
  if (p.timedOut || !which("gh")) {
    throw new Refusal("github-unreachable", `gh did not answer (${p.timedOut ? "timed out" : p.stderr.trim() || "gh is not installed"}).`,
      "check the connection and `gh auth status`, then run it again.");
  }
  if (p.code !== 0) {
    throw new Refusal("github-failed", `gh api ${method} ${path} failed: ${(p.stderr || p.stdout).trim().slice(0, 200)}`,
      "sign in with `gh auth login` (the repo needs admin rights for runners and variables), then run it again.");
  }
  return p.stdout.trim() ? (JSON.parse(p.stdout) as unknown) : {};
}

/** [exit code, output] of one `docker` call; [127, ""] when docker is not installed or does not answer. */
export function docker(...args: string[]): [number, string] {
  const p = run(["docker", ...args], { timeoutMs: 60_000 });
  if (p.timedOut) return [127, ""];
  return [p.code, p.stdout.trim()];
}

// --- what is there ---------------------------------------------------------------------------------------------------------

/** [agent, why] for this machine's checkout claims whose loop is gone. Reads the claims file; changes nothing. */
function staleClaims(cfg: Config): [string, string][] {
  const out0 = git(["rev-parse", "--git-common-dir"]).stdout.trim();
  const common = resolve(out0 || ".git");
  let data: Obj;
  try {
    data = obj(JSON.parse(readFileSync(join(common, "factory", "claims.json"), "utf8")) as unknown);
  } catch {
    return [];
  }
  const hours = Number(cfg.claimStaleHours ?? 6);
  const checkouts = obj(data.checkouts);
  const tasks = obj(data.tasks);
  const out: [string, string][] = [];
  for (const agent of Object.keys(checkouts).sort()) {
    const claim = obj(checkouts[agent]) as Claim;
    if (!alive(claim, hours, true)) out.push([agent, `pid ${String(claim.pid ?? "None")} is gone`]);
  }
  for (const tid of Object.keys(tasks).sort()) {
    const claim = obj(tasks[tid]) as Claim;
    if (!(String(claim.agent) in checkouts) && !alive(claim, hours)) out.push([String(claim.agent), `its task claim ${tid} is stale`]);
  }
  return out;
}

export type AgentStep = [number: number, name: string, why: string, close: boolean];

/** Whether `name`'s Agent issue may be closed from here: the person named it, this machine is configured to run it,
 * or its issue names this machine (or none: an older kit) (#236). */
function belongsHere(name: string, issueMachine: string | null, named: string[]): boolean {
  if (named.includes(name) || machineNames().includes(name)) return true;
  return !issueMachine || issueMachine === machineId();
}

/** [number, name, why, close] for open Agent issues: close true for the ones to close, false for a down or silent agent
 * of another machine that is left alone (#236). Issues mode only. */
function deadAgentIssues(cfg: Config, named: string[]): AgentStep[] {
  if (taskSource(cfg) !== "issues") return [];
  const configured = new Set([...(cfg.agents ?? []), ...ROLE_NAMES.flatMap((role) => roleNames(cfg, role))]);
  const out: AgentStep[] = [];
  for (const [name, found] of byAgent(agentIssues())) {
    const issue = found[0];
    if (!issue || issue.state !== "open" || aliveHere(name)) continue;
    const st = stateOf(cfg, issue);
    const status = st ? st[1] : null;
    if (status === "down" || status === "silent") {
      const other = machineOf(issue);
      if (belongsHere(name, other, named)) out.push([issue.number, name, `${name} is ${status}`, true]);
      else out.push([issue.number, name, `${name} is ${status} on machine ${other}, which may only be offline`, false]);
    } else if (!configured.has(name) && status === null) {
      out.push([issue.number, name, `${name} never ran here (not in \`agents\`)`, true]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** This project's CI names (ci_names.ts), or null when it can't tell the repository. */
function ciNames(cfg: Config): Record<string, string> | null {
  try {
    return ciNamesOf(obj(cfg.ci));
  } catch (e) {
    if (e instanceof Exit) return null;
    throw e;
  }
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** [id, container name] of exited containers of this project's compose projects. */
function exitedContainers(name: string): [string, string][] {
  const [rc, out] = docker("ps", "-a", "--filter", "status=exited", "--format", '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}');
  const mine = new RegExp(`^${escapeRx(name)}(-([1-9]|1[0-6]|light))?$`);
  const found: [string, string][] = [];
  for (const line of rc === 0 ? out.split(/\r?\n/) : []) {
    const [cid, cname, project] = [...line.split("\t"), "", ""] as [string, string, string];
    if (cid && mine.test(project)) found.push([cid, cname]);
  }
  return found;
}

function runnersOf(repoPath: string): Obj[] | null {
  const found = ghApi(repoPath + "actions/runners?per_page=100");
  const rs = obj(found).runners;
  return typeof found === "object" && found !== null && !Array.isArray(found) && Array.isArray(rs) ? rs.map(obj) : null;
}

function offlineRunners(pool: Obj[] | null, name: string): [unknown, string][] {
  return (pool ?? []).filter((x) => x.status === "offline" && !x.busy && String(x.name ?? "").startsWith(name + "-"))
    .map((x) => [x.id, String(x.name ?? "")]);
}

function labelsOf(value: unknown): string[] {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  } catch {
    parsed = value;
  }
  if (typeof parsed === "string") return [parsed];
  return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
}

/** [variable, labels] that ask for self-hosted runners when no online runner has those labels. Unknown pool: none. */
function danglingVariables(pool: Obj[] | null): [string, string[]][] {
  if (pool === null) return [];
  const found = obj(ghApi(REPO + "actions/variables"));
  const out: [string, string[]][] = [];
  for (const v of (Array.isArray(found.variables) ? found.variables : []).map(obj)) {
    if (!VARIABLES.includes(String(v.name))) continue;
    const labels = labelsOf(v.value);
    const need = new Set(labels.map((l) => l.toLowerCase()));
    if (!need.has("self-hosted")) continue;
    const online = pool.filter((x) => {
      if (x.status !== "online") return false;
      const have = new Set((Array.isArray(x.labels) ? x.labels : []).map((l) => String(obj(l).name ?? "").toLowerCase()));
      return [...need].every((l) => have.has(l));
    });
    if (!online.length) out.push([String(v.name), labels]);
  }
  return out;
}

/** Python's repr of a list of strings: ['a', 'b']. */
function reprList(xs: string[]): string {
  return "[" + xs.map((x) => `'${x}'`).join(", ") + "]";
}

// --- the plan --------------------------------------------------------------------------------------------------------------

export type Step = [kind: string, text: string, action: (() => unknown) | null];

/** [kind, description, action]: each action is a function that does the step (null: a note). */
export function plan(cfg: Config, named: string[] = []): Step[] {
  const steps: Step[] = [];
  for (const [agent, why] of staleClaims(cfg)) {
    steps.push(["claim", `release the claims of ${agent} (${why})`, () => release(agent)]);
  }
  for (const [number, name, why, close] of deadAgentIssues(cfg, named)) {
    if (close) steps.push(["agent", `close Agent issue #${number} (${why})`, () => closeIssue(number)]);
    else steps.push(["note", `left Agent issue #${number} open (${why}); to close it from here: factory reset-run --apply --agent ${name}`, null]);
  }
  return [...steps, ...ciSteps(cfg, "delete")];
}

/** The CI part of the plan, one implementation for `factory reset-run` and `factory ci clean` (#282): this project's
 * exited CI containers and its offline idle runners, then each runs-on variable that asks for self-hosted runners
 * when none with its labels is online. `variables` "delete" removes such a variable (reset-run); "note" only says so
 * and names `factory ci use`, since that changes where jobs run (ci clean). */
export function ciSteps(cfg: Config, variables: "delete" | "note"): Step[] {
  const steps: Step[] = [];
  const names = ciNames(cfg);
  if (names === null) {
    steps.push(["note", "skipped the CI containers, runners and variables: can't tell this project's repository " +
      "(set ci.repo in .claude/factory.json or sign in with `gh auth login`)", null]);
    return steps;
  }
  const ciName = names.CI_NAME as string;
  for (const [cid, cname] of exitedContainers(ciName)) {
    steps.push(["container", `remove the exited container ${cname} (${cid})`, () => docker("rm", cid)]);
  }
  let pool: Obj[] | null;
  try {
    pool = runnersOf(REPO);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    pool = null; // no admin on the repo: the runner steps are skipped, the others still run
  }
  for (const [rid, rname] of offlineRunners(pool, ciName)) {
    steps.push(["runner", `remove the offline runner ${rname} (id ${String(rid)})`, () => ghApi(REPO + `actions/runners/${String(rid)}`, "DELETE")]);
  }
  for (const [v, labels] of danglingVariables(pool)) {
    if (variables === "delete") {
      steps.push(["variable", `delete ${v} (no online runner has ${reprList(labels)}); jobs then use GitHub's runners`,
        () => ghApi(REPO + `actions/variables/${v}`, "DELETE")]);
    } else {
      steps.push(["note", `${v} asks for ${reprList(labels)} and no online runner has those labels, so those jobs wait; ` +
        "`factory ci install` starts runners here, or `factory ci use github` sends the jobs to GitHub's runners", null]);
    }
  }
  return steps;
}

/** Prints the steps under `title`; with `apply` does each one first and says so. `nothing` when there is nothing to do. */
export function runSteps(steps: Step[], apply: boolean, title: string, nothing: string): void {
  console.log(apply ? `${title} --apply` : `${title} (a plan: nothing is changed; add --apply to do it)`);
  for (const [kind, text, action] of steps) {
    if (action === null) console.log(`  ${kind}: ${text}`);
    else if (apply) {
      action();
      console.log(`  done, ${kind}: ${text}`);
    } else console.log(`  ${kind}: ${text}`);
  }
  if (!steps.some((s) => s[2] !== null)) console.log(`  ${nothing}`);
}

/** Writes a Refusal as {code, message, fix} on stderr; returns 1. Anything else is thrown on. */
export function refused(e: unknown): number {
  if (!(e instanceof Refusal)) throw e;
  process.stderr.write(pyDumps(e.body) + "\n");
  return 1;
}

function closeIssue(number: number): void {
  gh("PATCH", `repos/{owner}/{repo}/issues/${number}`, { state: "closed", state_reason: "not_planned" });
}

const USAGE_FIX = "Use: factory reset-run [--apply] [--agent NAME].";

export function main(argv: string[]): number {
  const named: string[] = [];
  let apply = false;
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--apply") apply = true;
    else if (a === "--agent" && i + 1 < argv.length) named.push(argv[++i] as string);
    else if (a.startsWith("--agent=") && a.length > 8) named.push(a.slice(8));
    else unknown.push(a);
  }
  if (unknown.length) {
    process.stderr.write(pyDumps({ code: "usage", message: `unknown option ${unknown.join(" ")}.`, fix: USAGE_FIX }) + "\n");
    return 1;
  }
  try {
    ghApi("user");
    runSteps(plan(load(), named), apply, "factory reset-run", "Nothing to reset.");
  } catch (e) {
    return refused(e);
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
