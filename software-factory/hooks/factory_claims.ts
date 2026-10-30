#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Lets several factory loops run on one project without stepping on each other.
//
// Two things are claimed, both in a lock-protected JSON file inside the repo's shared git directory
// (`<git-common-dir>/factory/claims.json`, so every worktree of a clone sees the same file and nothing is committed):
//
//   - checkouts: each loop works in its own checkout. The first loop takes the project folder; later loops get a
//     git worktree next to it (`<project>-agents/<name>`, named from `agents` in factory.json), created on first use and reused afterwards.
//   - tasks: a loop claims a task before building it, and other loops skip it.
//
// A claim belongs to a live process: when the pid that made it has exited (or the claim is older than
// `claimStaleHours`), it no longer counts. Loops on other machines or clones can't see this file, so a task whose
// `task/<id>-...` branch got a commit on the remote within `claimStaleHours` counts as taken too, and a PR's rework
// (`pr-<n>`) is also claimed on the PR itself ("Rework claims" below, #355): `release` takes that claim off, and
// `list` shows the ones GitHub holds as `rework` lines.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts checkout --pid $$     -> prints "<agent> <directory>" to work in
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts checkout --pid $$ --role dev-manager [--name lead]
//                                                                 -> the same for another role (#102): its names are
//                                                                    `roles.<role>.names`, its folder
//                                                                    `<project>-agents/<name>`. A name belongs to one
//                                                                    loop on a clone, whatever its role.
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts release [--agent taytu] [--tasks-only]
//                                                                 -> one line: what was released, or "Nothing to release: ..."
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts list
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts done [--agent taytu] --task 3.2     (factory loop -i: close the session)
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts clean                                remove unused agent worktrees
//   cd "$(bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts worktree taytu)" && claude
//                                                                 -> a plain Claude session in taytu's worktree; the
//                                                                    SessionStart hook (factory_session.ts) sets it up
// next_task.ts --claim <agent> --pid <pid> uses `claimTask` below.
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync,
  unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { agentName, agentSlot, branchTask, type Config, load, roleNames, safeAgent, taskSource, tasks as planTasks,
  toFloat } from "./factory_config.ts";
import * as fi from "./factory_issues.ts";
import { machineId, machineNames } from "./factory_machine.ts";
import { isClaude } from "./factory_session.ts";
import { type ArgSpec, die, Exit, flock, isoUtc, now, parseArgs, parseIso, pyDumps, run, runMain, sleepSync,
  splitLines } from "./factory_lib.ts";

export const HOST = hostname();

export interface Claim {
  agent?: string;
  pid?: number | string;
  host?: string;
  at?: number;
  path?: string;
  role?: string;
  [key: string]: unknown;
}

export interface Claims {
  checkouts: Record<string, Claim>;
  tasks: Record<string, Claim>;
  [key: string]: unknown;
}

function git(...a: string[]): string {
  const p = run(["git", ...a]);
  return p.code === 0 ? p.stdout.trim() : "";
}

export function stateDir(): string {
  const common = resolve(git("rev-parse", "--git-common-dir") || ".git");
  const d = join(common, "factory");
  mkdirSync(d, { recursive: true });
  return d;
}

/** The claims, read and written under an exclusive lock so two loops can't claim at the same moment. The body's
 * changes to `data` are saved when it returns (also when it returns early); a throw saves nothing. */
export function locked<T>(body: (data: Claims) => T): T {
  const d = stateDir();
  const fd = openSync(join(d, "claims.lock"), "w");
  try {
    flock(fd);
    const path = join(d, "claims.json");
    let data: Claims;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      data = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Claims;
    } catch {
      data = {} as Claims;
    }
    data.checkouts ??= {};
    data.tasks ??= {};
    const result = body(data);
    const tmp = path + ".tmp";
    writeFileSync(tmp, pyDumps(data, { indent: 2 }));
    renameSync(tmp, path);
    return result;
  } finally {
    closeSync(fd);
  }
}

function toPid(pid: unknown): number | null {
  if (typeof pid === "number" && Number.isInteger(pid)) return pid;
  if (typeof pid === "string" && /^\s*[+-]?\d+\s*$/.test(pid)) return Number(pid);
  return null;
}

export function pidAlive(pid: unknown): boolean {
  const n = toPid(pid);
  if (n === null) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the process is a factory loop or an agent's Claude session (`register`), judged by its program and
 * entry script, so a reused pid of some other program doesn't hold a name. Unknown (no `ps`): trust the pid. */
export function isLoop(pid: unknown): boolean {
  const p = run(["ps", "-p", String(pid), "-o", "command="]);
  if (p.code === 127 && !p.stdout) return true; // no ps to ask: the pid alone decides
  const words = p.stdout.split(/\s+/).filter((w) => w);
  if (!words.length) return false;
  const prog = basename(words[0] as string);
  if (prog === "factory-loop.sh") return true; // a script run directly (or a name set with exec -a)
  const shells = ["bash", "sh", "zsh", "dash"];
  const full = p.stdout.trim();
  return isClaude(p.stdout) || (shells.includes(prog) && runsLoopScript(full.slice((words[0] as string).length).trim()));
}

/** Whether a shell's arguments (as ps prints them, joined with spaces) start with the factory-loop.sh script.
 * The script is the first argument after the shell's flags. A one-word path (`factory-loop.sh`,
 * `./factory-loop.sh`, `/x/factory-loop.sh`) is unambiguous. A path with spaces in it (`/Users/me/My Projects/
 * app/factory-loop.sh`) can't be told from several arguments, so it counts only if that file exists. */
export function runsLoopScript(args: string): boolean {
  const words = args.split(/\s+/).filter((w) => w);
  let k = 0;
  while (k < words.length && (words[k] as string).startsWith("-")) k++;
  if (k === words.length) return false;
  if (basename(words[k] as string) === "factory-loop.sh") return true;
  const rest = words.slice(k).join(" ");
  const m = /^(\/.*?\/factory-loop\.sh)(?:\s|$)/.exec(rest);
  if (!m) return false;
  try {
    return statSync(m[1] as string).isFile();
  } catch {
    return false;
  }
}

/** Whether a claim still holds. A loop's checkout (`loop`) on this machine holds for as long as its loop runs,
 * however long that is: the age limit is only for what can't be checked (another machine, a task). */
export function alive(claim: Claim | null | undefined, staleHours: number, loop = false): boolean {
  if (!claim || !Object.keys(claim).length) return false;
  if (loop && claim.host === HOST) return pidAlive(claim.pid) && isLoop(claim.pid);
  if (Date.now() / 1000 - Number(claim.at ?? 0) > staleHours * 3600) return false;
  if (claim.host !== HOST) return true; // can't check a pid on another machine; the age limit applies
  return pidAlive(claim.pid);
}

function stamp(agent: string, pid: number | string, extra: Record<string, unknown> = {}): Claim {
  const n = toPid(pid);
  if (n === null) throw new Error(`invalid literal for int() with base 10: '${pid}'`);
  return { agent, pid: n, host: HOST, at: Date.now() / 1000, ...extra };
}

/** The names this machine may run, from FACTORY_AGENTS (comma-separated, set in the machine's shell profile, never
 * committed) or else the machine's names file (factory_machine.ts, #45), so two machines never start the same agent
 * (#48). Empty: every name. A name that isn't in `agents` stops with a plain message. */
function machineAgents(names: string[]): string[] {
  const only = machineNames();
  const unknown = only.filter((n) => !names.includes(n));
  if (unknown.length) {
    die(`FACTORY_AGENTS (or this machine's names file) names ${unknown.join(", ")}, which aren't ` +
      `agents in .claude/factory.json (${names.join(", ")}).`);
  }
  return only;
}

/** [[name, folder]] a loop of `role` may take, in order, and whether FACTORY_AGENTS (or the machine's names file)
 * cut the list. The first coding agent works in the project folder, every other name in <project>-agents/<name>.
 * `name` picks one. */
function candidatesFor(cfg: Config, mainTop: string, role: string, name: string | null): [[string, string][], boolean] {
  const agents = (cfg.agents || []) as string[];
  if (role === "coding-agent") {
    const names: string[] = [];
    for (let n = 1; n <= Math.max(agents.length, 1); n++) names.push(agentName(cfg, n));
    let found: [string, string][] = [[names[0] as string, mainTop], ...names.slice(1).map((n): [string, string] => [n, join(mainTop + "-agents", n)])];
    const only = machineAgents(names);
    if (only.length) found = found.filter((c) => only.includes(c[0])); // each keeps its own slot, folder, ports and database
    if (name) {
      found = found.filter((c) => c[0] === name);
      if (!found.length) {
        die(`${name} isn't a coding agent this machine may run: the agents are ` +
          `${names.join(", ")} (\`agents\` in .claude/factory.json; FACTORY_AGENTS narrows them).`);
      }
    }
    return [found, only.length > 0];
  }
  const names = name ? [safeAgent(name)] : roleNames(cfg, role);
  const clash = names.filter((n) => agents.includes(n));
  if (clash.length) {
    die(`${clash.join(", ")} is a coding agent's name, so a ${role} can't use it. Choose another name ` +
      `(\`roles.${role}.names\` in .claude/factory.json).`);
  }
  if (!names.length) {
    die(`${role} has no names: set \`roles.${role}.names\` in .claude/factory.json, or give one: ` +
      `factory ${role} <name> loop.`);
  }
  return [names.map((n): [string, string] => [n, join(mainTop + "-agents", n)]), false];
}

function mainTopDir(): string {
  return dirname(resolve(git("rev-parse", "--git-common-dir")));
}

function staleOf(cfg: Config): number {
  return toFloat(cfg.claimStaleHours ?? 6) ?? 6;
}

/** The project folder if no live loop holds it, else this loop's own worktree. Prints and returns it. */
export function checkout(pid: string, staleHours: number, role = "coding-agent", name: string | null = null): [string, string] {
  const mainTop = mainTopDir();
  const [agent, path] = locked((data) => {
    const cos = data.checkouts;
    const cfg = load();
    const [candidates, narrowed] = candidatesFor(cfg, mainTop, role, name);
    for (const [a, p] of candidates) {
      if (!alive(cos[a], staleHours, true)) {
        cos[a] = stamp(a, pid, { path: p, role });
        return [a, p] as [string, string];
      }
    }
    const shown = candidates.map((c) => c[0]).join(", ");
    if (name) {
      die(`${name} already has a live loop on this clone: start it under another name ` +
        `(factory ${role} <name> loop), or stop that one first.`);
    }
    if (role !== "coding-agent") {
      die(`every ${role} name (${shown}) already has a live loop on this clone; ` +
        `add names to \`roles.${role}.names\` in .claude/factory.json for more, or type one: ` +
        `factory ${role} <name> loop`);
    }
    if (narrowed) {
      die(`every agent this machine may run (${shown}, from FACTORY_AGENTS) already ` +
        "has a live loop on this clone; add a name to FACTORY_AGENTS for more");
    }
    die(`every agent (${shown}) already has a live loop on this clone; ` +
      "add names to `agents` in .claude/factory.json for more");
  });
  ensureWorktree(path, mainTop);
  console.log(`${agent} ${path}`);
  return [agent, path];
}

/** The names of `role` no live loop on this clone holds, in order (what a new loop would take). */
export function freeNames(role: string, staleHours: number): string[] {
  const mainTop = mainTopDir();
  const cfg = load();
  return locked((data) => candidatesFor(cfg, mainTop, role, null)[0]
    .map((c) => c[0]).filter((a) => !alive(data.checkouts[a], staleHours, true)));
}

export const REFSPEC_FIX = "git config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && git fetch origin";

/** {code, message, fix} when the repository has an `origin` remote but no `origin/<main>` (#181), else null. Cloning
 * an empty repo sets no fetch refspec, so the first push never makes a remote-tracking branch. */
export function missingOriginMain(main: string): { code: string; message: string; fix: string } | null {
  if (!git("remote", "get-url", "origin")) return null; // no origin at all: a local-only project, nothing to say here
  if (run(["git", "rev-parse", "--verify", "-q", `refs/remotes/origin/${main}`]).code === 0) return null;
  return { code: "no-origin-main", message: `There is no origin/${main} in this clone, so the factory has no branch to ` +
    "start an agent's folder from. Cloning an empty repository leaves no fetch setting for origin.",
  fix: `Run: ${REFSPEC_FIX}` };
}

function checked(cmd: string[], quietStdout = false): void {
  const p = run(cmd, { inherit: !quietStdout });
  if (quietStdout && p.stderr) process.stderr.write(p.stderr);
  if (p.code !== 0) throw new Error(`Command '${JSON.stringify(cmd)}' returned non-zero exit status ${p.code}.`);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Create the worktree at `path` from origin/<main> if it doesn't exist, with the local env files copied. */
export function ensureWorktree(path: string, mainTop: string): void {
  if (path === mainTop || isDir(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const cfg = load();
  run(["git", "fetch", "-q", "origin", cfg.mainBranch], { inherit: true });
  const err = missingOriginMain(cfg.mainBranch);
  if (err) {
    process.stderr.write(pyDumps(err) + "\n");
    throw new Exit(1);
  }
  checked(["git", "worktree", "add", "--detach", path, `origin/${cfg.mainBranch}`], true);
  // The kit's files in .claude/ are links into a submodule (vendor/my-skills): without it they point at nothing,
  // and a session would start without the factory's settings, hooks and deny rules (#46).
  if (existsSync(join(path, ".gitmodules"))) checked(["git", "-C", path, "submodule", "update", "--init", "-q"]);
  // A new worktree has no untracked local files: bring the local env files over.
  let locals: string[] = [];
  try {
    locals = readdirSync(mainTop).filter((f) => /^\.env\..*\.local$/.test(f));
  } catch {
    locals = [];
  }
  for (const f of [".env.local", ...locals]) {
    const src = join(mainTop, basename(f));
    if (isFile(src)) {
      const dst = join(path, basename(f));
      copyFileSync(src, dst);
      const st = statSync(src);
      utimesSync(dst, st.atime, st.mtime); // copy2 keeps the times too
    }
  }
}

/** The folder of agent `who` (a name, or a slot number; 1 is the project folder), created if needed. Prints it. */
export function worktree(who: string): void {
  const cfg = load();
  const n = /^\d+$/.test(who) ? Number(who) : agentSlot(cfg, who);
  const mainTop = mainTopDir();
  let path: string;
  if (n === null && ["dev-manager", "product-owner"].flatMap((r) => roleNames(cfg, r)).includes(who)) {
    path = join(mainTop + "-agents", who); // a dev manager's or product owner's folder
  } else if (n === null) {
    die(`no agent called ${who}: the agents are ${((cfg.agents || []) as string[]).join(", ")}`);
  } else path = n === 1 ? mainTop : join(mainTop + "-agents", agentName(cfg, n));
  ensureWorktree(path, mainTop);
  console.log(path);
}

/** Record that an interactive session (pid) works in this checkout. Returns the other live holder, if any. */
export function register(agent: string, pid: number, path: string, staleHours: number): Claim | null {
  return locked((data) => {
    const held = data.checkouts[agent];
    if (held && alive(held, staleHours, true) && (toPid(held.pid ?? 0) ?? 0) !== pid) return held;
    data.checkouts[agent] = stamp(agent, pid, { path });
    return null;
  });
}

/** Lets the agent's claims go; returns [checkout released, task ids released] so the caller can say what changed. */
export function release(agent: string, tasksOnly = false): [boolean, string[]] {
  return locked((data) => {
    let had = false;
    if (!tasksOnly && agent in data.checkouts) {
      had = data.checkouts[agent] !== null;
      delete data.checkouts[agent];
    }
    const tids = Object.entries(data.tasks).filter(([, c]) => c.agent === agent).map(([t]) => t);
    for (const t of tids) delete data.tasks[t];
    return [had, tids];
  });
}

/** The one line `release` prints: what it let go, or that there was nothing to release. */
export function releaseMessage(agent: string, tasksOnly: boolean, hadCheckout: boolean, tids: string[]): string {
  if (!hadCheckout && !tids.length) {
    return tasksOnly ? `Nothing to release: ${agent} holds no task claim.` :
      `Nothing to release: ${agent} holds no checkout or task claim.`;
  }
  const parts = [...(hadCheckout ? ["the checkout"] : []), ...(tids.length ? [`the task claim ${tids.join(", ")}`] : [])];
  return `Released ${agent}: ${parts.join(" and ")}.` + (tasksOnly ? " The checkout stays." : "");
}

/** Task ids with a task/<id>-... branch on the remote that got a commit within the stale window. */
function remoteBusy(staleHours: number): Record<string, string> {
  run(["git", "fetch", "-q", "origin", "+refs/heads/task/*:refs/remotes/origin/task/*"]);
  const busy: Record<string, string> = {};
  const out = git("for-each-ref", "--format=%(refname:strip=3) %(committerdate:unix)", "refs/remotes/origin/task");
  for (const line of splitLines(out)) {
    const i = line.lastIndexOf(" ");
    const name = i < 0 ? "" : line.slice(0, i);
    const ts = i < 0 ? line : line.slice(i + 1);
    const tid = branchTask(name); // name is "task/<id>-..."
    if (tid && /^\d+$/.test(ts) && Date.now() / 1000 - Number(ts) < staleHours * 3600) busy[tid] = name;
  }
  return busy;
}

/** The first of `openIds` this agent may build, claimed for it; null when every one is taken. */
export function claimTask(openIds: string[], agent: string, pid: number | string, cfg: Config): string | null {
  const stale = staleOf(cfg);
  const remote = remoteBusy(stale);
  return locked((data) => {
    const tasks = data.tasks;
    const mine = Object.entries(tasks).filter(([t, c]) => c.agent === agent && alive(c, stale) && openIds.includes(t));
    if (mine.length) return (mine[0] as [string, Claim])[0]; // keep working on what this agent already holds
    for (const tid of openIds) {
      const held = tasks[tid];
      if (held && held.agent !== agent && alive(held, stale)) continue;
      if (tid in remote && !(held && held.agent === agent)) continue;
      for (const [t, c] of Object.entries(tasks)) if (c.agent === agent) delete tasks[t]; // one task per agent at a time
      tasks[tid] = stamp(agent, pid);
      return tid;
    }
    return null;
  });
}

export function doneFile(agent: string): string {
  return join(stateDir(), `done-${safeAgent(agent)}`);
}

/** An interactive session finished its task: the Stop hook closes it and the loop moves on. */
export function markDone(agent: string, task: string): void {
  writeFileSync(doneFile(agent), task);
}

/** The task an agent marked done, removing the mark; '' when there is none. */
export function takeDone(agent: string): string {
  const p = doneFile(agent);
  if (!existsSync(p)) return "";
  const task = readFileSync(p, "utf8").trim();
  unlinkSync(p);
  return task;
}

/** Delete local task/<id>-... branches whose task is ticked on main (their PR has merged). */
export function tidyBranches(cfg: Config): string[] {
  let done: Set<string>;
  if (taskSource(cfg) === "issues") { // done = its issue is closed
    const p = run(["gh", "api", "--paginate", "repos/{owner}/{repo}/issues?state=closed&per_page=100"]);
    try {
      done = p.code === 0 ? new Set((JSON.parse(p.stdout.replace(/\]\[/g, ",")) as { number: number }[]).map((i) => String(i.number))) : new Set();
    } catch {
      done = new Set();
    }
  } else {
    const plan = git("show", `origin/${cfg.mainBranch}:${cfg.plan}`);
    done = new Set(planTasks(plan).filter(([, d]) => d).map(([i]) => i));
  }
  const gone: string[] = [];
  for (const name of git("for-each-ref", "--format=%(refname:short)", "refs/heads/task").split(/\s+/).filter((x) => x)) {
    const t = branchTask(name);
    if (t !== null && done.has(t) && run(["git", "branch", "-D", "-q", name]).code === 0) gone.push(name);
  }
  return gone;
}

/** Remove agent worktrees no live agent uses and that have no uncommitted work; prune merged task branches. */
export function clean(cfg: Config, staleHours: number): void {
  const mainTop = mainTopDir();
  const root = mainTop + "-agents";
  const busy = locked((data) => new Set(Object.values(data.checkouts).filter((c) => alive(c, staleHours, true)).map((c) => c.path)));
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of isDir(root) ? readdirSync(root).sort() : []) {
    const path = join(root, name);
    if (busy.has(path)) {
      kept.push(`${name} (in use)`);
      continue;
    }
    const dirty = run(["git", "-C", path, "status", "--porcelain", "--ignore-submodules"]).stdout.trim();
    if (dirty) {
      kept.push(`${name} (uncommitted changes)`);
      continue;
    }
    if (run(["git", "worktree", "remove", "--force", path]).code === 0) removed.push(name);
  }
  run(["git", "worktree", "prune"]);
  const branches = tidyBranches(cfg);
  console.log("removed worktrees: " + (removed.join(", ") || "none"));
  if (kept.length) console.log("kept: " + kept.join(", "));
  console.log("deleted merged task branches: " + (branches.join(", ") || "none"));
}

// ---------------------------------------------------------------------------------------------------- rework claims
// A task issue is claimed on GitHub (factory_issues.ts), but a PR's rework was claimed only in this clone's claims file,
// so two machines (or two clones) both started it (#355). Starting a rework now also posts a lease on the PR, as the
// dev manager's review claims do (factory_manager_claims.ts):
//
//   <!-- factory-rework-claim agent=<name> machine=<id> host=<host name> sha=<head> until=<ISO time> -->
//   <!-- factory-rework-release agent=<name> machine=<id> -->
//
// The earliest unexpired claim for the PR's current head wins, in the order GitHub lists the comments. A release drops
// that agent's (on that machine) earlier claims. A claim ends when its `until` passes, and never counts for longer than
// `claimStaleHours` after its comment was posted, so a crashed run doesn't hold a PR forever. A new head (the fix was
// pushed) makes an old claim mean nothing. next_task.ts claims, `release` and `list` below release and list, and
// factory_prs.ts shows the holder in the cockpit.

const REWORK_CLAIM = /<!--\s*factory-rework-claim\s+([^>]*?)-->/;
const REWORK_RELEASE = /<!--\s*factory-rework-release\s+([^>]*?)-->/;
const REWORK_NAME = /^[\w.-]+$/;

export interface ReworkClaim {
  agent: string;
  machine: string;
  host: string;
  sha: string;
  /** Seconds since the epoch. */
  until: number;
}

export interface HeldRework extends ReworkClaim {
  number: number;
}

/** This machine's host name, as a rework claim shows it. */
export function hostLabel(): string {
  return HOST.replace(/[^\w.-]/g, "-") || "unknown";
}

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of text.matchAll(/(\w+)=(\S+)/g)) out[a[1] as string] = a[2] as string;
  return out;
}

function sameSha(a: string, b: string): boolean {
  return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
}

/** Whether a rework claim is this agent on this machine. A machine without an id matches by name alone. */
export function isMine(c: ReworkClaim, agent: string, machine: string): boolean {
  return fi.isMe([c.agent, c.machine || null], agent, machine);
}

/** Unexpired rework claims in comment order, each agent's own release dropping its earlier ones; only those for `head`
 * when it is given. `hours` is `claimStaleHours`. */
export function liveReworkClaims(comments: fi.Comment[], head: string | null, at: number, hours: number): ReworkClaim[] {
  let claims: ReworkClaim[] = [];
  for (const c of comments) {
    const body = c.body || "";
    const r = REWORK_RELEASE.exec(body);
    if (r) {
      const a = attrs(r[1] as string);
      claims = claims.filter((x) => !(x.agent === a.agent && x.machine === (a.machine ?? "")));
      continue;
    }
    const m = REWORK_CLAIM.exec(body);
    if (!m) continue;
    const a = attrs(m[1] as string);
    let until = parseIso(a.until);
    if (!REWORK_NAME.test(a.agent ?? "") || !a.sha || until === null) continue;
    const posted = parseIso(c.created_at);
    if (posted !== null) until = Math.min(until, posted + hours * 3600);
    claims.push({ agent: a.agent as string, machine: a.machine ?? "", host: a.host ?? "", sha: a.sha, until });
  }
  return claims.filter((x) => x.until > at && (head === null || sameSha(x.sha, head)));
}

/** The claim that holds the rework of `head`, or null. */
export function reworkHolder(comments: fi.Comment[], head: string, at: number, hours: number): ReworkClaim | null {
  return liveReworkClaims(comments, head, at, hours)[0] ?? null;
}

function commentsOf(n: number): fi.Comment[] {
  return fi.ghAll<fi.Comment>(`repos/{owner}/{repo}/issues/${n}/comments`);
}

function postReworkRelease(n: number, agent: string, machine: string): void {
  const where = machine ? ` machine=${machine}` : "";
  fi.comment(n, `<!-- factory-rework-release agent=${agent}${where} -->\n**${agent}** stopped reworking this.`);
}

/** Claim the rework of PR `n` at `head` for this agent; true when the claim is this agent's (new or held already). A
 * claim that lost a simultaneous race is released at once, so it never holds the PR after the winner lets go. */
export function claimRework(cfg: Config, n: number, head: string, agent: string): boolean {
  const hours = staleOf(cfg);
  const machine = machineId();
  const held = reworkHolder(commentsOf(n), head, now(), hours);
  if (held) return isMine(held, agent, machine);
  const until = now() + hours * 3600;
  const host = hostLabel();
  const where = machine ? ` machine=${machine}` : "";
  fi.comment(n, `<!-- factory-rework-claim agent=${agent}${where} host=${host} sha=${head} until=${isoUtc(until)} -->\n` +
    `**${agent}** on ${host} is reworking ${head.slice(0, 7)} until ${isoUtc(until).slice(11, 16)} UTC. It's released when ` +
    "the run ends, or when that time passes.");
  sleepSync(fi.claimSettleSeconds()); // let a simultaneous claim land, then let the earliest comment decide
  const winner = reworkHolder(commentsOf(n), head, now(), hours);
  if (winner && isMine(winner, agent, machine)) return true;
  postReworkRelease(n, agent, machine);
  return false;
}

/** Release this agent's live rework claim on PR `n`, if it has one; true when a release was posted. */
export function releaseRework(cfg: Config, n: number, agent: string): boolean {
  const machine = machineId();
  const mine = liveReworkClaims(commentsOf(n), null, now(), staleOf(cfg)).some((c) => isMine(c, agent, machine));
  if (mine) postReworkRelease(n, agent, machine);
  return mine;
}

/** Every open PR whose rework is held, with its holder, in PR order. */
export function heldReworks(cfg: Config): HeldRework[] {
  const hours = staleOf(cfg);
  const out: HeldRework[] = [];
  const pulls = fi.ghAll<{ number: number; head: { sha: string } }>("repos/{owner}/{repo}/pulls?state=open");
  for (const p of pulls.sort((a, b) => a.number - b.number)) {
    const h = reworkHolder(commentsOf(p.number), p.head.sha, now(), hours);
    if (h) out.push({ number: p.number, ...h });
  }
  return out;
}

/** "haile on dev-pc (machine 1a2b3c) until 23:40 UTC": who holds a rework. */
export function describeRework(c: ReworkClaim): string {
  const where = c.host ? ` on ${c.host}` : "";
  const mach = c.machine ? ` (machine ${c.machine})` : "";
  return `${c.agent}${where}${mach} until ${isoUtc(c.until).slice(11, 16)} UTC`;
}

/** The run that held a PR's rework ended: take its claim off the PR too, so another machine may start it. */
function releaseReworks(cfg: Config, agent: string, tids: string[]): void {
  for (const t of tids.filter((x) => /^pr-\d+$/.test(x))) {
    try {
      if (releaseRework(cfg, Number(t.slice(3)), agent)) console.log(`Released ${agent}'s rework claim on #${t.slice(3)}.`);
    } catch (e) {
      console.log(`Could not take ${agent}'s rework claim off #${t.slice(3)} (${e instanceof Error ? e.message : String(e)}); ` +
        "it ends by itself after claimStaleHours.");
    }
  }
}

/** Rework claims on open PRs, from GitHub; none when GitHub can't be read (the local claims still show). */
function reworkClaims(cfg: Config): HeldRework[] {
  try {
    return heldReworks(cfg);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------- command line

const USAGE = "usage: factory_claims.ts [-h] {checkout,free,release,worktree,list,done,take-done,tidy-branches,clean} ...";
const PROG = "factory_claims.ts";

function usageError(text: string): never {
  process.stderr.write(`${USAGE}\n${PROG}: error: ${text}\n`);
  throw new Exit(2);
}

/** `release`, `done` and `take-done` without --agent take FACTORY_AGENT, so an agent's command needs no shell variable
 * (Claude Code asks before running one, and unattended nobody answers). An explicit --agent wins. */
function withEnvAgent(cmd: string, rest: string[]): string[] {
  const agent = (process.env.FACTORY_AGENT ?? "").trim();
  if (!["release", "done", "take-done"].includes(cmd) || !agent) return rest;
  if (rest.some((t) => t === "--agent" || t.startsWith("--agent="))) return rest;
  return [...rest, "--agent", agent];
}

function main(argv: string[]): void {
  const cmds = ["checkout", "free", "release", "worktree", "list", "done", "take-done", "tidy-branches", "clean"];
  const cmd = argv[0];
  if (!cmd) usageError("the following arguments are required: cmd");
  if (!cmds.includes(cmd)) usageError(`argument cmd: invalid choice: '${cmd}' (choose from ${cmds.map((c) => `'${c}'`).join(", ")})`);
  const rest = withEnvAgent(cmd, argv.slice(1));
  const specs: Record<string, ArgSpec> = {
    checkout: { valued: ["--pid", "--role", "--name"], required: ["--pid"] },
    free: { valued: ["--role"] },
    release: { valued: ["--agent"], flags: ["--tasks-only"], required: ["--agent"] },
    worktree: { positionals: ["n"] },
    done: { valued: ["--agent", "--task"], required: ["--agent", "--task"] },
    "take-done": { valued: ["--agent"], required: ["--agent"] },
  };
  const a = parseArgs(rest, specs[cmd] ?? {}, `${PROG} ${cmd}`, `usage: ${PROG} ${cmd} [-h]`);
  const cfg = load();
  const stale = staleOf(cfg);
  const s = (k: string): string => a[k] as string;
  if (cmd === "worktree") worktree(s("n"));
  else if (cmd === "done") markDone(s("agent"), s("task"));
  else if (cmd === "take-done") console.log(takeDone(s("agent")));
  else if (cmd === "tidy-branches") console.log(tidyBranches(cfg).join("\n"));
  else if (cmd === "clean") clean(cfg, stale);
  else if (cmd === "checkout") checkout(s("pid"), stale, (a.role as string | undefined) ?? "coding-agent", (a.name as string | undefined) ?? null);
  else if (cmd === "free") console.log(freeNames((a.role as string | undefined) ?? "coding-agent", stale).join("\n"));
  else if (cmd === "release") {
    const tasksOnly = Boolean(a["tasks-only"]);
    const [had, tids] = release(s("agent"), tasksOnly);
    console.log(releaseMessage(s("agent"), tasksOnly, had, tids));
    releaseReworks(cfg, s("agent"), tids);
  } else {
    locked((data) => {
      for (const kind of ["checkouts", "tasks"] as const) {
        for (const [k, v] of Object.entries(data[kind])) {
          const state = alive(v, stale) ? "live" : "stale";
          const role = v.role !== undefined && v.role !== null && v.role !== "coding-agent" ? ` (${v.role})` : "";
          console.log(`${kind.slice(0, -1).padEnd(8)} ${k.padEnd(10)} ${String(v.agent ?? "").padEnd(9)} pid ${v.pid ?? "None"} ${state} ${v.path ?? ""}${role}`);
        }
      }
    });
    for (const h of reworkClaims(cfg)) console.log(`${"rework".padEnd(8)} ${`pr-${h.number}`.padEnd(10)} ${describeRework(h)} (on GitHub)`);
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
