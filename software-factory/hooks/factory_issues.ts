#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Tasks as GitHub issues (`tasks.source: "issues"` in .claude/factory.json).
//
// Each task is an open issue written from the factory-task template: what we're building, goals, acceptance
// criteria and a checklist of todos. Labels carry the state, so the board and your phone show it:
//
//   factory:ready        can be picked up            factory:in-review   its PR is open
//   factory:in-progress  an agent is on it           factory:blocked     needs a person (the issue says why)
//   agent:<name>         which agent has it          factory-hold        the dev manager is reviewing its PR
//
// The branch is task/<issue number>-<short-name>, the PR says `Closes #<n>`, and merging the PR closes the issue.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts pick --agent taytu      the agent's own in-progress issue, else claim
//                                                                          the next ready one: prints "issue-42 <title>"
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts peek                     the next ready issue, without claiming it
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts show 42                  title, labels, body, then the people's comments
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts tick 42 3                tick the 3rd checkbox (1-based) in the body
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts review 42                in-progress -> in-review (after opening the PR);
//                                                                          prints which labels changed
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts block 42 "needs the Stripe keys"
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts give-back --agent taytu  release the claims that have no branch or PR
//                                                                          (the loop, #192)
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts release 42 ["why"]       back to ready, the agent's label off
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts stale [--hours 3]        in-progress issues with no activity (dev manager)
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts new --title T --body-file F [--milestone "Phase 3"] [--label L ...]
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts setup                    create the labels
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts list                     open task issues and their state
//
// Claims are race-free across machines: a claim is labels plus a `<!-- factory-claim agent=<name> machine=<id> -->`
// comment, and when two agents claim at once (even with the same name, on two machines) the earlier comment wins; the
// other takes its label off and picks again. Everything goes through the GitHub REST API (`gh api`).
import { readFileSync } from "node:fs";
import { type Config, load, taskLabels, toFloat } from "./factory_config.ts";
import { machineId } from "./factory_machine.ts";
import { die, Exit, parseArgs, parseIso, pyDumps, pyQuote, run, runMain, sleepSync } from "./factory_lib.ts";

export const CLAIM = /<!--\s*factory-claim\s+agent=([\w.-]+)(?:\s+machine=([\w-]+))?\s*-->/;
export const RELEASE = /<!--\s*factory-release\s+agent=([\w.-]+)\s*-->/;
const DEPENDS = /depends on\s+((?:#\d+[\s,and]*)+)/gi;
const BOX = /^(\s*[-*]\s+\[)([ xX])(\]\s+)/gm;
const COLORS: Record<string, string> = { ready: "0e8a16", inProgress: "1d76db", inReview: "5319e7", blocked: "b60205" };

/** A GitHub issue (or pull request) as the REST API gives it; only the fields the factory reads are typed. */
export interface Issue {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  labels: { name: string; [key: string]: unknown }[];
  milestone?: { number: number; title?: string; [key: string]: unknown } | null;
  pull_request?: unknown;
  updated_at?: string;
  html_url?: string;
  comments?: number;
  user?: { login?: string } | null;
  [key: string]: unknown;
}

export interface Comment {
  id?: number;
  body?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
  html_url?: string;
  [key: string]: unknown;
}

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  return pyDumps(v).replace(/"/g, "'").replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False").replace(/\bnull\b/g, "None");
}

/** `gh api -X <method> <path>` with `data` as the JSON body; the parsed answer (null for an empty one). Stops with
 * the error on a failure, or gives null for a 404 when `ok404`. */
export function gh<T = unknown>(method: string, path: string, data?: unknown, ok404 = false): T {
  const args = ["gh", "api", "-X", method, path, "-H", "Accept: application/vnd.github+json"];
  if (data !== undefined && data !== null) args.push("--input", "-");
  const p = run(args, data !== undefined && data !== null ? { input: pyDumps(data) } : {});
  if (p.code !== 0) {
    if (ok404 && (p.stderr.includes("404") || (p.stdout + p.stderr).includes("Not Found"))) return null as T;
    die(`gh api ${method} ${path} failed: ${(p.stderr || p.stdout).trim().slice(0, 300)}`);
  }
  return (p.stdout.trim() ? JSON.parse(p.stdout) : null) as T;
}

/** Every page of a list endpoint. A redirect or error object is not an empty list: callers would act on "nothing there". */
export function ghAll<T = Issue>(path: string): T[] {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const chunk = gh<unknown>("GET", `${path}${sep}per_page=100&page=${page}`) ?? [];
    if (!Array.isArray(chunk)) die(`gh api GET ${path} answered something other than a list: ${pyStr(chunk).slice(0, 200)}`);
    out.push(...(chunk as T[]));
    if (chunk.length < 100) return out;
  }
}

export function names(issue: { labels?: { name: string }[] | null }): Set<string> {
  return new Set((issue.labels ?? []).map((l) => l.name));
}

export function addLabels(n: number | string, labels: string[]): void {
  gh("POST", `repos/{owner}/{repo}/issues/${n}/labels`, { labels: [...labels] });
}

export function removeLabel(n: number | string, label: string): void {
  gh("DELETE", `repos/{owner}/{repo}/issues/${n}/labels/${pyQuote(label)}`, undefined, true);
}

export function comment(n: number | string, body: string): void {
  gh("POST", `repos/{owner}/{repo}/issues/${n}/comments`, { body });
}

// Comments the factory writes about its own work (claims, reviews, usage ...). `show` leaves them out; a person's
// comment, and a question or answer that carries words, is read as part of the task.
export const FACTORY_NOISE = new RegExp("^\\s*<!--\\s*factory-(?:claim|release|approved|mustfix|review-claim|claim-release|" +
  "answer-claim|item-claim|usage|agent|role|manager-note)\\b");

/** The comments on issue n that people wrote, oldest first (a decision may live in one: #204). */
export function humanComments(n: number | string): Comment[] {
  return ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`)
    .filter((c) => (c.body ?? "").trim() && !FACTORY_NOISE.test(c.body as string));
}

export function showText(n: number | string, i: Issue): string {
  let text = `#${n} ${i.title}  [${[...names(i)].sort().join(", ")}]  ${i.state}\n\n${i.body || ""}`;
  for (const c of humanComments(n)) {
    const who = c.user?.login || "someone";
    text += `\n\n--- comment by ${who} ---\n${(c.body as string).trim()}`;
  }
  return text;
}

export function taskIssues(state = "open", label: string | null = null): Issue[] {
  const q = `repos/{owner}/{repo}/issues?state=${state}` + (label ? `&labels=${label}` : "");
  return ghAll(q).filter((i) => !("pull_request" in i) &&
    (label === "factory:agent" || !names(i).has("factory:agent"))); // agent issues aren't tasks
}

/** Milestones in the order they were made (Phase 3 before Phase 4), then issue number. */
export function order(a: Issue, b: Issue): number {
  const ka = a.milestone ? a.milestone.number : 1e9;
  const kb = b.milestone ? b.milestone.number : 1e9;
  return ka - kb || a.number - b.number;
}

export function sortedByOrder(issues: Issue[]): Issue[] {
  return [...issues].sort(order);
}

/** The issues and pull requests this one depends on ("Depends on #12, #14") that are still open. One of the
 * open task issues in `openNumbers` is known; any other number (a pull request, an issue that isn't a task) is
 * looked up once, since `openNumbers` holds no pull requests. A number that doesn't exist doesn't hold it back.
 * `lookedUp` caches the answers across issues. */
export function openDependencies(issue: Issue, openNumbers: Set<number>, lookedUp: Map<number, boolean> = new Map()): number[] {
  const deps = new Set<number>();
  for (const m of (issue.body ?? "").matchAll(DEPENDS)) for (const d of (m[1] as string).matchAll(/#(\d+)/g)) deps.add(Number(d[1]));
  const stillOpen: number[] = [];
  for (const d of [...deps].sort((x, y) => x - y)) {
    if (!openNumbers.has(d) && !lookedUp.has(d)) {
      const found = gh<Issue | null>("GET", `repos/{owner}/{repo}/issues/${d}`, undefined, true);
      lookedUp.set(d, Boolean(found) && found?.state === "open");
    }
    if (openNumbers.has(d) || lookedUp.get(d)) stillOpen.push(d);
  }
  return stillOpen;
}

export type ClaimMark = [agent: string, machine: string | null];

/** [agent, machine] for the claim comments since the last release, oldest first. `machine` is null for a claim
 * made before claims carried one. */
export function claimsSinceRelease(n: number | string): ClaimMark[] {
  let out: ClaimMark[] = [];
  for (const c of ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`)) {
    const body = c.body || "";
    if (RELEASE.test(body)) out = [];
    const m = CLAIM.exec(body);
    if (m) out.push([m[1] as string, m[2] ?? null]);
  }
  return out;
}

/** [agent, machine] of the claim comment that came first since the last release, or null. Block and release both
 * post a release, so an old claim never outlives them (unblock an issue with `release`, not by editing labels). */
export function claimWinner(n: number | string): ClaimMark | null {
  return claimsSinceRelease(n)[0] ?? null;
}

/** Whether a claim [agent, machine] is this agent on this machine. A claim without a machine (an older kit)
 * matches by name alone, as it always did; so does a machine that has no id. */
export function isMe(claim: ClaimMark | null, agent: string, machine: string): boolean {
  if (!claim || claim[0] !== agent) return false;
  return !(claim[1] && machine && claim[1] !== machine);
}

/** Whether this agent on this machine may carry on with in-progress issue `n`: the claim that won it is its own.
 * (The winning claim, not the newest comment: a loser's claim comment is newer and must not hide the winner's issue.) */
export function ownIssue(n: number, agent: string, machine: string): boolean {
  const winner = claimWinner(n);
  return !winner || isMe(winner, agent, machine);
}

export function readyIssues(cfg: Config): Issue[] {
  const L = taskLabels(cfg);
  const openNow = taskIssues();
  const openNumbers = new Set(openNow.map((i) => i.number));
  const ready = openNow.filter((i) => names(i).has(L.ready) && !names(i).has(L.blocked) &&
    ![...names(i)].some((x) => x.startsWith(L.agentPrefix)));
  const lookedUp = new Map<number, boolean>();
  return sortedByOrder(ready).filter((i) => !openDependencies(i, openNumbers, lookedUp).length);
}

export function pick(cfg: Config, agent: string): Issue | null {
  const L = taskLabels(cfg);
  const mine = L.agentPrefix + agent;
  const machine = machineId();
  // Another machine's agent may have the same name: its issue is its, not ours to resume (#45).
  const own = taskIssues("open", mine).filter((i) => names(i).has(L.inProgress) && ownIssue(i.number, agent, machine));
  if (own.length) {
    const i = sortedByOrder(own)[0] as Issue;
    const full = waitingForSlot(cfg, i);
    if (full) {
      // Its branch is pushed but the PR can't open yet: wait instead of a session that the gate stops, and
      // don't take new work meanwhile. The next pick after a merge frees a slot opens the PR.
      process.stderr.write(`#${i.number} is ready on its branch and waits for a pull-request slot (${full}).\n`);
      return null;
    }
    return i; // carry on with what this agent already holds
  }
  for (const i of readyIssues(cfg)) if (claimIssue(cfg, agent, i)) return i;
  return null;
}

/** Labels and a claim comment for issue `i`; true when this agent's claim won. */
export function claimIssue(cfg: Config, agent: string, i: Issue): boolean {
  const L = taskLabels(cfg);
  const mine = L.agentPrefix + agent;
  const machine = machineId();
  const n = i.number;
  addLabels(n, [L.inProgress, mine]);
  removeLabel(n, L.ready);
  const where = machine ? ` machine=${machine}` : "";
  comment(n, `<!-- factory-claim agent=${agent}${where} -->\n**${agent}** is working on this.`);
  sleepSync(claimSettleSeconds()); // let a simultaneous claim land, then let the earliest comment decide
  const winner = claimWinner(n);
  if (isMe(winner, agent, machine)) return true;
  if (!winner || winner[0] !== agent) removeLabel(n, mine); // someone else was first; their labels stay
  // (a winner with our own name on another machine owns that label too: leave it on)
  return false;
}

export interface Refusal {
  code: string;
  message: string;
  fix: string;
}

/** Claim issue #n for the agent: [issue, null] on success, [null, {code, message, fix}] when it can't be claimed.
 * Nothing is changed on a refusal. An issue this agent already holds is returned as it is. */
export function pickNamed(cfg: Config, agent: string, n: number): [Issue, null] | [null, Refusal] {
  const L = taskLabels(cfg);
  const mine = L.agentPrefix + agent;
  const i = gh<Issue | null>("GET", `repos/{owner}/{repo}/issues/${n}`, undefined, true);
  if (!i || i.state !== "open" || "pull_request" in i) {
    return [null, { code: "issue-not-found", message: `#${n} is not an open task issue.`,
      fix: "Check the number with `factory issues` and try again." }];
  }
  const have = names(i);
  if (have.has(mine) && have.has(L.inProgress) && ownIssue(n, agent, machineId())) return [i, null];
  const held = [...have].filter((x) => x.startsWith(L.agentPrefix));
  if (held.length || have.has(L.inProgress) || have.has(L.inReview)) {
    const who = held.length ? (held[0] as string).slice(L.agentPrefix.length) : "another agent";
    return [null, { code: "issue-taken", message: `#${n} is already taken by ${who}.`,
      fix: "Pick another issue, or ask the dev manager to release it with `factory issues release`." }];
  }
  if (have.has(L.blocked)) {
    return [null, { code: "issue-blocked", message: `#${n} is blocked.`,
      fix: "Wait for the dev manager to unblock it, or pick another issue." }];
  }
  const openDeps = openDependencies(i, new Set(taskIssues().map((x) => x.number)), new Map());
  if (openDeps.length) {
    return [null, { code: "issue-blocked", message: `#${n} waits for ${openDeps.map((d) => "#" + d).join(", ")}.`,
      fix: "Build the issues it depends on first, or pick another issue." }];
  }
  if (!have.has(L.ready)) {
    return [null, { code: "issue-not-ready", message: `#${n} is not labelled ${L.ready}.`,
      fix: "Ask the dev manager to make it ready, or pick another issue." }];
  }
  if (claimIssue(cfg, agent, i)) return [i, null];
  return [null, { code: "issue-taken", message: `Another agent claimed #${n} first.`, fix: "Pick another issue." }];
}

/** How long a claim waits for a simultaneous one to land: 2 s, or FACTORY_CLAIM_SETTLE_SECONDS (the tests set 0). */
export function claimSettleSeconds(): number {
  const v = toFloat(process.env.FACTORY_CLAIM_SETTLE_SECONDS ?? "2");
  return v === null ? 2.0 : Math.max(0.0, v);
}

interface Branch {
  name: string;
  commit: { sha: string };
}

interface Pull {
  number: number;
  draft?: boolean;
  head: { ref: string; sha?: string; repo?: { full_name?: string } | null };
  user?: { login?: string } | null;
  [key: string]: unknown;
}

/** When the issue's task branch is pushed with no open PR and `maxOpenPRs` ready PRs are open (the gate's cap),
 * a short reason; else null. A branch with no commits beyond main is still being built, so it doesn't wait. */
export function waitingForSlot(cfg: Config, issue: Issue): string | null {
  const n = issue.number;
  const branches = ghAll<Branch>("repos/{owner}/{repo}/branches").map((b) => b.name).filter((b) => b.startsWith(`task/${n}-`));
  if (!branches.length) return null;
  const prs = ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open");
  const base = (gh<{ full_name?: string } | null>("GET", "repos/{owner}/{repo}") ?? {}).full_name;
  if (prs.some((p) => branches.includes(p.head.ref) && ((p.head.repo ?? {}).full_name || base) === base)) {
    return null; // its PR is open: rework and review go their own way
  }
  const main = cfg.mainBranch ?? "main";
  const ahead = branches.filter((b) => ((gh<{ ahead_by?: number } | null>("GET", `repos/{owner}/{repo}/compare/${main}...${b}`) ?? {}).ahead_by ?? 0) > 0);
  const me = (gh<{ login?: string } | null>("GET", "user") ?? {}).login; // the gate's cap counts this account's ready PRs (--author @me)
  const ready = prs.filter((p) => !p.draft && (p.user ?? {}).login === me).map((p) => p.number).sort((a, b) => a - b);
  const cap = cfg.maxOpenPRs ?? 3;
  if (ahead.length && ready.length >= Math.trunc(Number(cap))) {
    return `${ready.length} of ${cap} open: ` + ready.map((x) => `#${x}`).join(", ");
  }
  return null;
}

/** Back to ready: the agent's label and the in-progress, in-review or blocked label come off. */
export function releaseIssue(cfg: Config, n: number, reason = ""): void {
  const L = taskLabels(cfg);
  const i = gh<Issue>("GET", `repos/{owner}/{repo}/issues/${n}`);
  const agents = [...names(i)].filter((x) => x.startsWith(L.agentPrefix)).map((x) => x.slice(L.agentPrefix.length));
  for (const x of names(i)) {
    if (x.startsWith(L.agentPrefix) || [L.inProgress, L.inReview, L.blocked].includes(x)) removeLabel(n, x);
  }
  addLabels(n, [L.ready]);
  const who = agents[0] ?? "none";
  comment(n, `<!-- factory-release agent=${who} -->\nBack to ready` + (reason ? `: ${reason}` : "."));
}

/** After a run ends (#192): the issues this agent claimed that have no pushed branch, no open pull request and are not
 * in review go back to ready, so a failed or cancelled run leaves no claim on GitHub. Returns the lines to print. */
export function giveBack(cfg: Config, agent: string): string[] {
  const L = taskLabels(cfg);
  const machine = machineId();
  const held = taskIssues("open", L.agentPrefix + agent)
    .filter((i) => names(i).has(L.inProgress) && ownIssue(i.number, agent, machine));
  if (!held.length) return [`Nothing to give back: ${agent} holds no in-progress issue.`];
  const branches = ghAll<Branch>("repos/{owner}/{repo}/branches").map((b) => b.name);
  const heads = ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open").map((p) => p.head.ref);
  const out: string[] = [];
  for (const i of sortedByOrder(held)) {
    const n = i.number;
    const pushed = [...branches, ...heads].filter((b) => b.startsWith(`task/${n}-`));
    if (pushed.length) out.push(`kept #${n}: ${pushed[0]} is on GitHub, so the work carries on from there.`);
    else {
      releaseIssue(cfg, n, "the run ended with no pull request");
      out.push(`released #${n}: the run ended with no branch or pull request, so it is ready again.`);
    }
  }
  return out;
}

/** In progress -> in review; returns the one line saying which labels changed. */
export function reviewIssue(cfg: Config, n: number): string {
  const L = taskLabels(cfg);
  const have = names(gh<Issue>("GET", `repos/{owner}/{repo}/issues/${n}`));
  if (have.has(L.inReview) && !have.has(L.inProgress)) return `#${n} was already in review: nothing changed.`;
  addLabels(n, [L.inReview]);
  removeLabel(n, L.inProgress);
  const gone = have.has(L.inProgress) ? `, removed ${L.inProgress}` : "";
  return `#${n} is in review: added ${L.inReview}${gone}.`;
}

export function tick(n: number, index: number): void {
  const issue = gh<Issue>("GET", `repos/{owner}/{repo}/issues/${n}`);
  let body = issue.body || "";
  const boxes = [...body.matchAll(BOX)];
  if (!(index > 0 && index <= boxes.length)) die(`#${n} has ${boxes.length} checkboxes; there is no number ${index}`);
  const m = boxes[index - 1] as RegExpMatchArray;
  const at = (m.index as number) + (m[1] as string).length;
  body = body.slice(0, at) + "x" + body.slice(at + 1);
  gh("PATCH", `repos/{owner}/{repo}/issues/${n}`, { body });
}

/** The latest of: the issue's own update, and a commit on its task branch (seconds since the epoch). */
export function lastActivity(issue: Issue): number {
  const times = [issue.updated_at as string];
  for (const b of ghAll<Branch>("repos/{owner}/{repo}/branches")) {
    if (b.name.startsWith(`task/${issue.number}-`)) {
      const c = gh<{ commit: { committer: { date: string } } }>("GET", `repos/{owner}/{repo}/commits/${b.commit.sha}`);
      times.push(c.commit.committer.date);
    }
  }
  return Math.max(...times.map((t) => parseIso(t) ?? 0));
}

/** Creates the task, agent, hold and review labels that are missing; returns the names it created (`factory issues
 * setup`, and `factory init`). A list passed as `present` gets the names that were already there. */
export function setupLabels(cfg: Config, present?: string[]): string[] {
  const L = taskLabels(cfg);
  const have = new Set(ghAll<{ name: string }>("repos/{owner}/{repo}/labels").map((x) => x.name));
  const wanted: [string, string][] = [...Object.keys(COLORS).map((k): [string, string] => [L[k] as string, COLORS[k] as string]),
    ["factory-hold", "fbca04"], ["factory:agent", "bfdadc"], ["factory:agent-down", "d4c5f9"],
    ...((cfg.agents || []) as string[]).map((n): [string, string] => [L.agentPrefix + n, "c5def5"]),
    ["tests-reviewed", "0e8a16"], ["deps-reviewed", "0e8a16"]]; // the guard wants them (the dev manager adds them)
  const made: string[] = [];
  for (const [name, color] of wanted) {
    if (have.has(name)) present?.push(name);
    else {
      gh("POST", "repos/{owner}/{repo}/labels", { name, color });
      made.push(name);
    }
  }
  return made;
}

const PROG = "factory_issues.ts";
const CMDS = ["pick", "peek", "show", "tick", "review", "block", "release", "give-back", "stale", "new", "setup", "list"];

function intArg(v: unknown, name: string, cmd: string): number {
  const s = String(v);
  if (!/^\s*[+-]?\d+\s*$/.test(s)) {
    process.stderr.write(`usage: ${PROG} ${cmd} [-h]\n${PROG} ${cmd}: error: argument ${name}: invalid int value: '${s}'\n`);
    throw new Exit(2);
  }
  return Number(s);
}

function main(argv: string[]): number {
  const usage = `usage: ${PROG} [-h] {${CMDS.join(",")}} ...`;
  const cmd = argv[0];
  if (!cmd || !CMDS.includes(cmd)) {
    process.stderr.write(`${usage}\n${PROG}: error: ` + (cmd ? `argument cmd: invalid choice: '${cmd}'` :
      "the following arguments are required: cmd") + "\n");
    return 2;
  }
  const specs: Record<string, Parameters<typeof parseArgs>[1]> = {
    pick: { valued: ["--agent"], required: ["--agent"] },
    show: { positionals: ["n"] },
    tick: { positionals: ["n", "index"] },
    review: { positionals: ["n"] },
    block: { positionals: ["n", "reason"] },
    release: { positionals: ["n", "reason?"] },
    "give-back": { valued: ["--agent"], required: ["--agent"] },
    stale: { valued: ["--hours"] },
    new: { valued: ["--title", "--body-file", "--milestone"], multi: ["--label"], required: ["--title", "--body-file"] },
  };
  const a = parseArgs(argv.slice(1), specs[cmd] ?? {}, `${PROG} ${cmd}`, `usage: ${PROG} ${cmd} [-h]`);
  const n = a.n !== undefined ? intArg(a.n, "n", cmd) : 0;
  const cfg = load();
  const L = taskLabels(cfg);

  if (cmd === "pick") {
    const i = pick(cfg, a.agent as string);
    if (!i) {
      console.log("none");
      return 1;
    }
    console.log(`issue-${i.number} ${i.title}`);
  } else if (cmd === "peek") {
    const ready = readyIssues(cfg);
    if (!ready.length) {
      console.log("none");
      return 1;
    }
    console.log(`issue-${(ready[0] as Issue).number} ${(ready[0] as Issue).title}`);
  } else if (cmd === "show") {
    console.log(showText(n, gh<Issue>("GET", `repos/{owner}/{repo}/issues/${n}`)));
  } else if (cmd === "tick") tick(n, intArg(a.index, "index", cmd));
  else if (cmd === "review") console.log(reviewIssue(cfg, n));
  else if (cmd === "block") {
    const i = gh<Issue>("GET", `repos/{owner}/{repo}/issues/${n}`);
    for (const x of names(i)) if (x.startsWith(L.agentPrefix) || x === L.inProgress || x === L.ready) removeLabel(n, x);
    addLabels(n, [L.blocked]);
    // A block ends the claim too, so whoever takes it after the unblock wins it (factory-release).
    const held = [...names(i)].filter((x) => x.startsWith(L.agentPrefix)).map((x) => x.slice(L.agentPrefix.length));
    comment(n, `<!-- factory-release agent=${held[0] ?? "none"} -->\n**Blocked:** ${a.reason}`);
  } else if (cmd === "give-back") console.log(giveBack(cfg, a.agent as string).join("\n"));
  else if (cmd === "release") releaseIssue(cfg, n, (a.reason as string | undefined) ?? "");
  else if (cmd === "stale") {
    const given = a.hours !== undefined ? toFloat(a.hours) : null;
    const tasks = (cfg.tasks ?? {}) as Record<string, unknown>;
    const hours = given || (toFloat(tasks.staleHours ?? 3) ?? 3);
    const nowS = Date.now() / 1000;
    for (const i of taskIssues("open", L.inProgress)) {
      const age = (nowS - lastActivity(i)) / 3600;
      if (age >= hours && waitingForSlot(cfg, i)) continue; // finished and pushed, waiting for a PR slot: not abandoned
      if (age >= hours) {
        const agents = [...names(i)].filter((x) => x.startsWith(L.agentPrefix));
        console.log(`#${i.number} ${agents.join(", ") || "(no agent)"} quiet for ${age.toFixed(1)} h: ${i.title}`);
      }
    }
  } else if (cmd === "new") {
    const data: Record<string, unknown> = { title: a.title, body: readFileSync(a["body-file"] as string, "utf8"),
      labels: [L.ready, ...(a.label as string[])] };
    const milestone = a.milestone as string | undefined;
    if (milestone) {
      const ms = new Map(ghAll<{ title: string; number: number }>("repos/{owner}/{repo}/milestones?state=all").map((m) => [m.title, m.number]));
      if (!ms.has(milestone)) ms.set(milestone, gh<{ number: number }>("POST", "repos/{owner}/{repo}/milestones", { title: milestone }).number);
      data.milestone = ms.get(milestone);
    }
    const i = gh<Issue>("POST", "repos/{owner}/{repo}/issues", data);
    console.log(`#${i.number} ${i.html_url}`);
  } else if (cmd === "setup") {
    const there: string[] = [];
    for (const name of setupLabels(cfg, there)) console.log(`created ${name}`);
    for (const name of there) console.log(`already there: ${name}`);
  } else if (cmd === "list") {
    for (const i of sortedByOrder(taskIssues())) {
      const state = [...names(i)].filter((x) => x.startsWith("factory") || x.startsWith(L.agentPrefix));
      const ms = (i.milestone ?? {}).title ?? "";
      console.log(`#${String(i.number).padEnd(5)} ${ms.padEnd(10)} ${state.sort().join(", ").padEnd(45)} ${i.title}`);
    }
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
