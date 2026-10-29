#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The dev manager's orchestrator (#97, #109): what `factory dev-manager [name] loop` runs each cycle. It has no model.
//
// Each cycle it reads GitHub (factory_watch.ts: the seven checks, which include `factory precheck`'s), and:
//   - opens a thread note on every task issue that just went `factory:in-progress`, and closes the note of a closed issue;
//   - posts what only the owner can act on (a queued CI, an idle agent, a PR waiting for the product owner ...) to the
//     owner-queue issue, once per `id`, mentioning the owner so GitHub notifies his phone;
//   - applies the dead-man's switch: work that has waited `manager.deadManMinutes` with no dev-manager activity is reported
//     to the owner, naming it;
//   - starts one one-item sub-manager per item that needs a manager, at most `manager.maxSubManagers` at once, each a fresh
//     `claude -p "/manage-pass <item>"` on the manager settings profile, with the item's fact sheet and thread note in its
//     prompt, under a lease (factory_lease.ts). A sub-manager does its item and exits. The orchestrator never starts builders.
//
// A sub-manager gets a screen (#307, PRD US-4): when the dev manager itself runs in a factory window (FACTORY_WINDOW, as
// `factory resume` and `loop -i` start it) and tmux is installed, each sub-manager runs in its own tmux window, through
// the shared step of factory_window.ts: session <repo>-<name>-<item>, window dev-manager-<name>-<item>. Its output is
// shown there as readable lines and kept in <item>.out; `factory cockpit watch <item>` shows the window read-only.
// Otherwise it runs with no screen, as before.
//
// Labels and comments on GitHub are the source of truth; the only local state is `.git/factory-manager/<name>.log` and the
// pid files of the sub-managers it started. A thread's memory is a note comment on the task issue (on the PR when there is
// no issue); it is a memory for the sub-managers, not a cache.
//
//   factory_orchestrator.ts cycle [--name N] [--dry-run] [--interactive] [--wait]
//         exit 0: there was work (started, posted or already running)   exit 3: nothing to do
//         exit 4: GitHub was rate-limited or unreachable (the loop waits for it, factory_ratelimit.ts)
//         --dry-run   read everything and print what it would do; write nothing
//         --interactive  run the first item in a session you can type into (Remote Control), one item, then return
//         --wait      wait for the sub-managers it started
//   factory_orchestrator.ts sub --name N --item <ref> [--interactive]     one sub-manager (what cycle starts)
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, load, managerSetting, roleNames, safeAgent, taskLabels, toFloat } from "./factory_config.ts";
import { comment, type Comment, gh, ghAll, type Issue, taskIssues } from "./factory_issues.ts";
import * as lease from "./factory_lease.ts";
import { permissionFlags, prompt as rolePrompt, sessionFlags } from "./factory_roles.ts";
import { ciState, collect, isoformat, issueOf, isOwn, type Item, minutes, type Pull, reviewState } from "./factory_watch.ts";
import { bunCmd, Exit, GITHUB_BUSY, parseArgs, run, runMain, which } from "./factory_lib.ts";
import { remember } from "./factory_views_cache.ts";
import { type Job, running as sessionRunning, sessionName, startWindow, type Started, WindowError, windowName } from "./factory_window.ts";

export const OWNER_TITLE = "Dev manager: needs the owner";
export const ASK_RX = /<!--\s*factory-owner-ask\s+id=([^\s>]+)(?:\s+[^>]*?)?\s*-->/; // for=product may follow
export const NOTE_RX = /<!--\s*factory-manager-note\s+thread=(\S+)\s+status=(\w+)\s*-->/;

export function commonDir(): string {
  const p = run(["git", "rev-parse", "--git-common-dir"]);
  return resolve(p.stdout.trim() || ".git");
}

export function stateDir(name: string): string {
  const d = join(commonDir(), "factory-manager", `${name}.d`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Prints a line and, unless this is a dry run, appends it to `.git/factory-manager/<name>.log`. */
export interface Out {
  (line: string): void;
  dry: boolean;
  who: string;
}

export function makeOut(name: string, dry: boolean): Out {
  const out = ((line: string): void => {
    console.log(`[${name}] ${line}`);
    if (!dry) {
      try {
        mkdirSync(join(commonDir(), "factory-manager"), { recursive: true });
        appendFileSync(join(commonDir(), "factory-manager", `${name}.log`), `${lease.iso(lease.now())} ${line}\n`);
      } catch {
        // the log is a convenience
      }
    }
  }) as Out;
  out.dry = dry;
  out.who = name;
  return out;
}

// --- the owner queue ---------------------------------------------------------------------------------------------------

/** The login to mention: `manager.notify`, else the repository's owner when that is a person. */
export function ownerLogin(cfg: Config): string {
  const given = String(managerSetting(cfg, "notify") || "").replace(/^@+/, "");
  if (given) return given;
  const repo = gh<{ owner?: { login?: string; type?: string } | null } | null>("GET", "repos/{owner}/{repo}") ?? {};
  const owner = repo.owner ?? {};
  return owner.type === "User" ? owner.login ?? "" : "";
}

/** The number of the open "Dev manager: needs the owner" issue; made on demand when `create`. */
export function ownerQueue(_cfg: Config, create = false): number | null {
  for (const i of ghAll<Issue>("repos/{owner}/{repo}/issues?state=open")) {
    if (i.title === OWNER_TITLE && !("pull_request" in i)) return i.number;
  }
  if (!create) return null;
  const made = gh<Issue>("POST", "repos/{owner}/{repo}/issues", {
    title: OWNER_TITLE,
    body: "One comment per thing the dev manager needs from the owner, each starting " +
      "`<!-- factory-owner-ask id=<slug> -->`. Answer in the comment; the next pass reads the reply. Pin this " +
      "issue. Nothing is posted twice.",
  });
  return made.number;
}

/** Posts a report to the owner queue once per id. Returns true when it posted (or would, in a dry run). */
export function postAsk(cfg: Config, name: string, askId: string, line: string, out: Out): boolean {
  let queue = ownerQueue(cfg, false);
  if (queue) {
    for (const c of ghAll<Comment>(`repos/{owner}/{repo}/issues/${queue}/comments`)) {
      const m = ASK_RX.exec(c.body || "");
      if (m && m[1] === askId) return false;
    }
  }
  if (out.dry) {
    out(`would post to the owner queue (id ${askId}): ${line}`);
    return true;
  }
  queue = ownerQueue(cfg, true) as number;
  const login = ownerLogin(cfg);
  const body = `<!-- factory-owner-ask id=${askId} -->\n${login ? "@" + login + " " : ""}for your attention: ${line}\n\n` +
    `Posted by the dev manager ${name}. If you want it handled differently, say so here; the next pass reads the reply.`;
  comment(queue, body);
  out(`posted to the owner queue (id ${askId}): ${line}`);
  return true;
}

// --- thread notes ------------------------------------------------------------------------------------------------------

export function noteBody(thread: string, status: string, firstLine: string): string {
  return `<!-- factory-manager-note thread=${thread} status=${status} -->\n` +
    `**Dev manager note for ${thread}.** This is the thread's memory for the dev manager's sessions (they start ` +
    "with none); GitHub's labels and comments are the truth. The sub-manager edits it before it exits.\n\n" +
    `- ${firstLine}\n`;
}

export type Note = [comment: Comment, thread: string, status: string];

export function findNote(comments: Comment[]): Note | null {
  for (const c of comments) {
    const m = NOTE_RX.exec(c.body || "");
    if (m) return [c, m[1] as string, m[2] as string];
  }
  return null;
}

/** Opens a note on each in-progress task issue, closes the note of a closed one. No model. Returns what it did. */
export function lifecycle(cfg: Config, _name: string, out: Out): number[] {
  const tasks = (cfg.tasks || {}) as Record<string, unknown>;
  if (tasks.source !== "issues") return [];
  const L = taskLabels(cfg);
  const did: number[] = [];
  // An issue's comments are read again only when the issue changed since (#347); a dry run writes nothing, so it keeps nothing.
  const version = (i: Issue): string => (out.dry ? "" : i.updated_at ?? "");
  for (const i of taskIssues("open", L.inProgress)) {
    const n = i.number;
    if (remember(cfg, `note-${n}`, version(i), () => findNote(ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`)) !== null)) continue;
    if (out.dry) out(`would open the thread note on issue #${n}`);
    else {
      comment(n, noteBody(`issue-${n}`, "open", `opened ${lease.iso(lease.now())} (label ${L.inProgress})`));
      out(`opened the thread note on issue #${n}`);
    }
    did.push(n);
  }
  const since = lease.iso(lease.now() - 2 * 86400);
  let seen = 0;
  for (const i of ghAll<Issue>(`repos/{owner}/{repo}/issues?state=closed&since=${since}`)) {
    if ("pull_request" in i || seen >= 20 || !(i.labels ?? []).some((l) => l.name.startsWith("factory:"))) continue;
    seen += 1;
    // Kept once its note is closed (or it has none), so a closed issue is not read again until it changes.
    remember(cfg, `note-closed-${i.number}`, version(i), () => {
      const found = findNote(ghAll<Comment>(`repos/{owner}/{repo}/issues/${i.number}/comments`));
      if (found && found[2] === "open") {
        const c = found[0];
        if (out.dry) out(`would close the thread note on issue #${i.number}`);
        else {
          const body = (c.body || "").replace(NOTE_RX, `<!-- factory-manager-note thread=${found[1]} status=closed -->`);
          gh("PATCH", `repos/{owner}/{repo}/issues/comments/${c.id}`,
            { body: body + `- closed ${lease.iso(lease.now())}: the issue was closed, so the thread ends.\n` });
          out(`closed the thread note on issue #${i.number}`);
        }
        did.push(i.number);
      }
      return true;
    });
  }
  return did;
}

/** [issue or PR number to hold the note, thread name, note comment or null] for an item. */
export function threadOf(item: Item, commentsOf: ((n: number) => Comment[]) | null = null): [number | null, string, Comment | null] {
  const pr = item.pr;
  const comOf = commentsOf ?? ((n: number) => ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`));
  let holders: [number, string][] = [];
  if (pr) {
    const prObj = gh<Pull | null>("GET", `repos/{owner}/{repo}/pulls/${pr}`) ?? ({} as Partial<Pull>);
    const issue = prObj.head ? issueOf(prObj) : null;
    holders = [...(issue ? [[issue, `issue-${issue}`] as [number, string]] : []), [pr, `pr-${pr}`]];
  } else if (item.ref.startsWith("issue-")) {
    const n = Number(item.ref.split("-").slice(1).join("-"));
    holders = [[n, `issue-${n}`]];
  }
  for (const [number, thread] of holders) {
    const found = findNote(comOf(number));
    if (found) return [number, thread, found[0]];
  }
  return holders.length ? [(holders[0] as [number, string])[0], (holders[0] as [number, string])[1], null] : [null, item.ref, null];
}

// --- facts and prompts -------------------------------------------------------------------------------------------------

/** The item's facts, collected without a model: what the sub-manager would otherwise spend turns finding out. */
export function factSheet(_cfg: Config, item: Item, held: lease.Lease | null, note: Comment | null, owner: string): string {
  const lines = [`Item ${item.ref} (${item.kind}), waiting since ${item.since ? isoformat(item.since) : "unknown"}.`, `Why: ${item.line}`];
  const pr = item.pr;
  if (pr) {
    const p = gh<Pull | null>("GET", `repos/{owner}/{repo}/pulls/${pr}`) ?? ({} as Partial<Pull>);
    const head = p.head?.sha ?? "";
    const comments = ghAll<Comment>(`repos/{owner}/{repo}/issues/${pr}/comments`);
    const [state, at] = head ? reviewState(comments, head) : ["none", null];
    const [verdict, jobs] = head ? ciState(head) : ["none", [] as string[]];
    lines.push(`PR #${pr}: "${p.title ?? ""}" on branch ${p.head?.ref ?? "?"} into ` +
      `${p.base?.ref ?? "main"}, head ${head}, draft=${p.draft ? "True" : "False"}, ` +
      `mergeable_state=${p.mergeable_state ?? "?"}, labels: ` +
      `${(p.labels ?? []).map((x) => x.name).join(", ") || "none"}.`,
    `Review state of this head: ${state}` + (at ? ` (since ${isoformat(at)})` : "") + ".",
    `CI judged by the manager's rule: ${verdict}` + (jobs.length ? ` (${jobs.join(", ")})` : "") + ".",
    `The manager's own PR: ${isOwn(p) ? "yes" : "no"}.`);
    const issue = issueOf(p);
    if (issue) lines.push(`Task issue: #${issue}.`);
  }
  if (held) lines.push(`Your lease: ${lease.render(held.kind, held.holder, held.key, held.until)}`);
  if (owner) lines.push(`Owner login for an owner-queue ask: @${owner}.`);
  if (note) {
    lines.push(`Thread note (comment ${note.id}; edit it with PATCH repos/{owner}/{repo}/issues/comments/` +
      `${note.id} before you exit):\n${note.body}`);
  } else {
    lines.push("There is no thread note yet; create one on the PR or issue before you exit " +
      "(`<!-- factory-manager-note thread=<ref> status=open -->`).");
  }
  return lines.join("\n");
}

/** The refs of sub-managers this orchestrator started that are still alive (and drops the dead ones' pid files). */
export function running(name: string): string[] {
  const d = stateDir(name);
  const alive: string[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".pid")) continue;
    try {
      const text = readFileSync(join(d, f), "utf8").trim();
      if (!/^-?\d+$/.test(text)) throw new Error("not a pid");
      process.kill(Number(text), 0);
      alive.push(f.slice(0, -4));
    } catch {
      try {
        rmSync(join(d, f));
      } catch {
        // gone already
      }
    }
  }
  return alive;
}

// --- a skipped pull request --------------------------------------------------------------------------------------------

export const SKIP_RX = /<!--\s*factory-manager-skip\s+sha=(\w+)\s*-->/;
export const BOOKKEEPING = /<!--\s*factory-(?:review-claim|claim-release|manager-note|answer-claim|item-claim)\b/;

/** [reason, next step] for a pull request the sub-manager left without a verdict, from facts alone. */
export function skipReason(prObj: Partial<Pull>, head: string): [string, string] {
  if (prObj.draft) return ["it is a draft", "Mark it ready for review when the work is done; the manager looks at it then."];
  if (prObj.mergeable_state === "dirty") {
    return ["it has a merge conflict with the main branch",
      "Merge main into the branch (or rebase it) and push; the manager reviews the new commit."];
  }
  const [verdict, jobs] = ciState(head);
  if (verdict === "failed") {
    return [`CI failed (${jobs.join(", ")})`,
      "Fix the failing job (`factory ci log <pr number>` shows why) and push; the manager reviews the new commit."];
  }
  if (verdict !== "green") return ["CI has not finished", "The manager looks again when CI is done; nothing to do until then."];
  return ["the session ended without a review or a reason",
    "The next pass looks at it again; if it ends the same way, the owner is asked."];
}

/** A sub-manager that took a pull request and ended with no comment of its own leaves one (#195): what it saw, why it
 * did not review, and the next step. Once per head commit. Returns true when it posted. */
export function leaveVerdict(cfg: Config, name: string, item: Item, before: Set<unknown>, out: Out): boolean {
  const pr = item.pr;
  if (!pr || (item.kind !== "review" && item.kind !== "fix")) return false;
  const p = gh<Pull | null>("GET", `repos/{owner}/{repo}/pulls/${pr}`) ?? ({} as Partial<Pull>);
  const head = p.head?.sha ?? "";
  if ((p.state ?? "open") !== "open" || !head) return false;
  const comments = ghAll<Comment>(`repos/{owner}/{repo}/issues/${pr}/comments`);
  if (comments.some((c) => !before.has(c.id) && !BOOKKEEPING.test(c.body || ""))) return false; // it said something itself
  if (comments.some((c) => (SKIP_RX.exec(c.body || "") ?? [null, null])[1] === head)) return false; // already said so for this head
  const [reason, step] = skipReason(p, head);
  const failed = reason.startsWith("the session ended"); // nothing a person or CI will change: do not restart this head
  comment(pr, `<!-- factory-manager-skip sha=${head} -->\n` + (failed ? `<!-- factory-review-failed sha=${head} -->\n` : "") +
    `**Dev manager ${name} looked at this pull request and did not review it.** Reason: ${reason}.\n\nNext step: ${step}`);
  out(`pr-${pr}: left a comment saying why it was not reviewed (${reason})`);
  if (failed) {
    postAsk(cfg, name, `review-failed-${pr}-${head.slice(0, 7)}`, `PR #${pr} at ${head.slice(0, 7)}: the dev manager's session ended without a ` +
      "verdict, so this commit is skipped until it changes. Read " + join(stateDir(name), `pr-${pr}.out`) + ", then review it " +
      "yourself or push a new commit.", out);
  }
  return true;
}

// --- one sub-manager ---------------------------------------------------------------------------------------------------

/** The tmux session and window of the sub-manager `name` starts for `ref`. */
export function subWindow(name: string, ref: string): { session: string; window: string } {
  return { session: sessionName(`${name}-${ref}`), window: windowName("dev-manager", `${name}-${ref}`) };
}

/** Where a sub-manager for `ref` is on this clone: the dev manager that runs it now, else one whose run has ended. */
export function findSub(ref: string): { name: string; live: boolean; out: string } | null {
  const top = join(commonDir(), "factory-manager");
  let names: string[];
  try {
    names = readdirSync(top).filter((f) => f.endsWith(".d")).map((f) => f.slice(0, -2)).sort();
  } catch {
    return null;
  }
  const out = (name: string) => join(top, `${name}.d`, `${ref}.out`);
  const name = names.find((n) => running(n).includes(ref));
  if (name) return { name, live: true, out: out(name) };
  const ended = names.find((n) => existsSync(out(n)));
  return ended ? { name: ended, live: false, out: out(ended) } : null;
}

/** Runs one sub-manager in its own tmux window and waits for it. Its exit code, null when no window could be made
 * (the caller then runs it with no screen), or "busy" when a window from an earlier run is still open (it may still
 * be working, so the caller leaves the item to the next cycle). */
function inWindow(name: string, ref: string, job: Job, limit: number, out: Out): number | null | "busy" {
  const d = stateDir(name);
  const file = join(d, `${ref}.job.json`);
  rmSync(job.rc, { force: true });
  const { window } = subWindow(name, ref);
  writeFileSync(file, JSON.stringify({ ...job, env: { ...job.env, FACTORY_WINDOW: window } }), { mode: 0o600 });
  let s: Started;
  try {
    s = startWindow({ role: "dev-manager", name: `${name}-${ref}`, dir: process.cwd(),
      argv: [...bunCmd(join(import.meta.dir, "factory_window.ts")), "job", file] });
  } catch (e) {
    if (!(e instanceof WindowError)) throw e;
    if (!existsSync(file)) { // the window took its job and ended before tmux was asked: it ran, so don't run it twice
      s = { ...subWindow(name, ref), started: true, note: "" };
    } else {
      rmSync(file, { force: true });
      out(`${ref}: no tmux window (${e.message}); running it without one`);
      return null;
    }
  }
  if (!s.started) {
    rmSync(file, { force: true });
    out(`${ref}: its window ${s.window} is still open from an earlier run; leaving it (tmux kill-session -t ${s.session} ends it)`);
    return "busy";
  }
  out(`${ref}: running in tmux window ${s.window} (watch it read-only: factory cockpit watch ${ref})`);
  const deadline = limit > 0 ? Date.now() + limit * 1000 : Infinity;
  while (sessionRunning(s.session)) {
    if (existsSync(job.rc)) { // done; a tmux with remain-on-exit keeps the session, so close it here
      run(["tmux", "kill-session", "-t", `=${s.session}`]);
      break;
    }
    if (Date.now() >= deadline) {
      run(["tmux", "kill-session", "-t", `=${s.session}`]);
      out(`${ref}: stopped after ${(limit / 60).toFixed(0)} minutes (manager.subManagerMinutes)`);
      return 1;
    }
    Bun.sleepSync(500);
  }
  try {
    const rc = Number(readFileSync(job.rc, "utf8").trim());
    return Number.isInteger(rc) ? rc : 1;
  } catch {
    return 1; // the window ended without saying how
  } finally {
    rmSync(job.rc, { force: true });
  }
}

export function runSub(cfg: Config, name: string, ref: string, interactive = false): number {
  const out = makeOut(name, false);
  const pidfile = join(stateDir(name), `${ref}.pid`);
  writeFileSync(pidfile, String(process.pid));
  let held: lease.Lease | null = null;
  try {
    const item = collect(cfg).find((i) => i.ref === ref && i.to === "manager");
    if (!item) {
      out(`${ref}: nothing needs a manager any more`);
      return 0;
    }
    if (item.target) {
      held = lease.acquire(item.target, item.lease[0], item.lease[1], name, toFloat(managerSetting(cfg, "claimMinutes")) ?? 0);
      if (!held) {
        out(`${ref}: another manager holds the lease; leaving it`);
        return 0;
      }
    }
    let [number, thread, note] = threadOf(item);
    if (note === null && number) {
      comment(number, noteBody(thread, "open", `opened ${lease.iso(lease.now())} by ${name} for ${ref}`));
      [number, thread, note] = threadOf(item);
    }
    const sheet = factSheet(cfg, item, held, note, ownerLogin(cfg));
    const text = rolePrompt(cfg, "dev-manager", name, ref, sheet);
    const flags = sessionFlags(cfg, "dev-manager");
    const env = { ...process.env, FACTORY_AGENT: name, FACTORY_ROLE: "dev-manager", FACTORY_LOOP: "1", FACTORY_ITEM: ref };
    const limit = (toFloat(managerSetting(cfg, "subManagerMinutes")) ?? 0) * 60;
    const before = new Set<unknown>(item.pr ? ghAll<Comment>(`repos/{owner}/{repo}/issues/${item.pr}/comments`).map((c) => c.id) : []);
    out(`${ref}: starting a ${interactive ? "session you can type into" : "sub-manager"} (${item.line})`);
    let rc: number;
    if (interactive) {
      const args = ["claude", ...flags];
      if ((process.env.FACTORY_REMOTE_CONTROL ?? "1") === "1") args.push(`--remote-control=${name} ${ref}`);
      rc = run([...args, text], { env, inherit: true }).code;
    } else {
      const logfile = join(stateDir(name), `${ref}.out`);
      const clean = Object.fromEntries(Object.entries(env).filter((kv): kv is [string, string] => kv[1] !== undefined));
      let windowed: number | null | "busy" = null;
      if (process.env.FACTORY_WINDOW && which("tmux")) { // the dev manager has a window, so its sub-managers get one
        const { TMUX: _t, TMUX_PANE: _p, ...rest } = clean;
        windowed = inWindow(name, ref, { argv: ["claude", ...flags, ...permissionFlags(cfg), "--output-format", "stream-json",
          "--verbose", "-p", text], env: rest, log: logfile, rc: join(stateDir(name), `${ref}.rc`) }, limit, out);
      }
      if (windowed === "busy") return 0; // no verdict: the open window may still post its own
      if (windowed !== null) rc = windowed;
      else {
        const fd = openSync(logfile, "w");
        try {
          const p = Bun.spawnSync(["claude", ...flags, ...permissionFlags(cfg), "-p", text], {
            env: clean, stdin: "ignore", stdout: fd, stderr: fd, timeout: limit * 1000, killSignal: "SIGKILL",
          });
          if (p.exitedDueToTimeout) {
            out(`${ref}: stopped after ${(limit / 60).toFixed(0)} minutes (manager.subManagerMinutes)`);
            rc = 1;
          } else rc = p.exitCode ?? 1;
        } catch {
          rc = 127;
        } finally {
          closeSync(fd);
        }
      }
    }
    out(`${ref}: the session ended (${rc === 0 ? "ok" : `exit ${rc}`})`);
    try {
      leaveVerdict(cfg, name, item, before, out);
    } catch (e) { // a missing reason must not turn a finished session into a failure
      if (e instanceof Exit) throw e;
      out(`${ref}: could not leave the reason on the pull request (${e instanceof Error ? e.message : String(e)})`);
    }
    return rc === 0 ? 0 : 1;
  } finally {
    lease.release(held);
    try {
      rmSync(pidfile);
    } catch {
      // gone already
    }
  }
}

// --- the cycle ---------------------------------------------------------------------------------------------------------

export async function cycle(cfg: Config, name: string, dry = false, interactive = false, wait = false): Promise<number> {
  const out = makeOut(name, dry);
  const now = lease.now();
  const info: { activity?: number | null } = {};
  const items = collect(cfg, now, info);
  let did = lifecycle(cfg, name, out).length > 0;
  const managers = items.filter((i) => i.to === "manager");
  const owners = items.filter((i) => i.to === "owner");
  if (items.length) out(`${items.length} item(s) need attention: ` + items.map((i) => i.ref).join(", "));
  for (const i of owners) did = postAsk(cfg, name, i.ref, i.line, out) || did;
  const limit = toFloat(managerSetting(cfg, "deadManMinutes")) ?? 0;
  const stuck = managers.filter((i) => i.since && minutes(i.since, now) >= limit);
  const activity = info.activity ?? null;
  if (stuck.length && !(activity && minutes(activity, now) < limit)) {
    const refs = stuck.map((i) => i.ref).sort();
    const askId = "dead-man-" + createHash("sha1").update(refs.join(",")).digest("hex").slice(0, 8);
    const waited = Math.max(...stuck.map((i) => minutes(i.since, now)));
    const quiet = activity ? `for ${minutes(activity, now).toFixed(0)} min` : "recently";
    did = postAsk(cfg, name, askId, `${stuck.length} item(s) have waited up to ${waited.toFixed(0)} min and no dev manager has acted ` +
      `${quiet}: ${refs.join(", ")}. A fresh sub-manager is being started for each; if this repeats, check ` +
      `that \`factory dev-manager loop\` is running and read .git/factory-manager/${name}.log.`, out) || did;
  }
  const cap = interactive ? 1 : Math.max(1, Math.trunc(toFloat(managerSetting(cfg, "maxSubManagers")) ?? 1));
  if (managers.length > cap) { // a place is scarce: a commit whose CI is green is reviewed before one that cannot be merged yet (#202)
    const key = new Map(managers.map((i) => [i, i.kind === "review" && ciState(i.lease[1])[0] === "green" ? 0 : 1]));
    managers.sort((a, b) => (key.get(a) as number) - (key.get(b) as number));
  }
  const alive = dry ? [] : running(name);
  let foreign = 0;
  const started: string[] = [];
  const procs: Bun.Subprocess[] = [];
  for (const i of managers) {
    if (alive.includes(i.ref)) {
      out(`${i.ref}: a sub-manager is already on it`);
      continue;
    }
    if (i.target && !dry) {
      const who = lease.holder(i.target, i.lease[0], i.lease[1]);
      if (who && who !== name) {
        foreign += 1;
        out(`${i.ref}: ${who} holds the lease; leaving it`);
        continue;
      }
    }
    if (alive.length + foreign + started.length >= cap) {
      out(`${i.ref}: waiting for a free place (${cap} sub-manager(s) at most, manager.maxSubManagers)`);
      continue;
    }
    if (dry) {
      out(`would start a ${interactive ? "session you can type into" : "sub-manager"} for ${i.ref}: ${i.line}`);
      const modeFlags = ["", ...permissionFlags(cfg)].join(" ");
      out(`would run: claude -p "/manage-pass ${i.ref}" (manager profile${modeFlags}, a lease on ${i.target || i.ref})`);
      started.push(i.ref);
      continue;
    }
    if (interactive) {
      runSub(cfg, name, i.ref, true);
      started.push(i.ref);
      break;
    }
    const p = Bun.spawn([...bunCmd(import.meta.path), "sub", "--name", name, "--item", i.ref], {
      stdio: ["ignore", "ignore", "ignore"], detached: true, cwd: process.cwd(),
    });
    writeFileSync(join(stateDir(name), `${i.ref}.pid`), String(p.pid));
    out(`${i.ref}: started a sub-manager (pid ${p.pid}): ${i.line}`);
    started.push(i.ref);
    procs.push(p);
  }
  if (wait) {
    for (const p of procs) await p.exited;
  } else {
    for (const p of procs) p.unref();
  }
  const busy = items.length > 0 || did || alive.length > 0;
  if (!busy) out("nothing to do");
  return busy ? 0 : 3;
}

const USAGE = "usage: factory_orchestrator.ts [-h] {cycle,sub} ...";

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "cycle" && cmd !== "sub") {
    process.stderr.write(`${USAGE}\nfactory_orchestrator.ts: error: ` +
      (cmd === undefined ? "the following arguments are required: cmd" : `argument cmd: invalid choice: '${cmd}' (choose from 'cycle', 'sub')`) + "\n");
    throw new Exit(2);
  }
  const a = cmd === "cycle"
    ? parseArgs(rest, { valued: ["--name"], flags: ["--dry-run", "--interactive", "--wait"] }, "factory_orchestrator.ts cycle",
      "usage: factory_orchestrator.ts cycle [-h] [--name NAME] [--dry-run] [--interactive] [--wait]")
    : parseArgs(rest, { valued: ["--name", "--item"], flags: ["--interactive"], required: ["--item"] }, "factory_orchestrator.ts sub",
      "usage: factory_orchestrator.ts sub [-h] [--name NAME] --item ITEM [--interactive]");
  const cfg = load();
  const given = (a.name as string | undefined) ?? process.env.FACTORY_AGENT;
  const name = safeAgent(given || (roleNames(cfg, "dev-manager")[0] ?? "manager"));
  try {
    if (cmd === "cycle") return await cycle(cfg, name, Boolean(a["dry-run"]), Boolean(a.interactive), Boolean(a.wait));
    return runSub(cfg, name, a.item as string, Boolean(a.interactive));
  } catch (e) { // a gh call that failed: one line; the loop counts it as a failed cycle, or waits when GitHub was busy (#347)
    if (e instanceof Exit && e.text !== null) {
      process.stderr.write(`[${name}] ${e.text}\n`);
      return e.exitCode === GITHUB_BUSY ? GITHUB_BUSY : 1;
    }
    throw e;
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
