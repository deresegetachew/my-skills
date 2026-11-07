// This machine's checkout of a project, brought up to date with main from the web UI (#566). A settings change merged
// from the page (a new agent, a new setting) takes effect only once the project's checkout has it: the factory's
// commands on this machine (`factory owner start`, the loop's checkout of an agent) read `.claude/factory.json` from
// that folder. So after the UI merges a pull request into main, and when the owner asks from Factory settings, the
// checkout moves forward, but only when that is safe:
//
//   - it is the project's own folder, not an agent's worktree (`<project>-agents/<name>`; their loops pull themselves);
//   - it is on the main branch, or detached on a commit main already has (where the loop leaves the first agent's
//     folder between tasks);
//   - its tree is clean apart from ignored files (no change, no untracked file);
//   - it has no commit of its own, so it can fast-forward.
//
// Then `git fetch origin <main>` and `git merge --ff-only origin/<main>` (detached: `git checkout --detach
// origin/<main>`, the loop's own move between tasks), and the submodules when the project has them. When it isn't
// safe, nothing is touched and the answer says why and what to do, as {code, message, fix}.
//
// Why not read the team from origin/<main> instead (`git show`): the page would then show an agent that this machine
// can't start yet, since `factory owner start` and the loop read the checkout. Moving the checkout keeps what the page
// shows and what this machine runs the same; when it can't move, the page says so.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./factory_config.ts";
import { envFor, type Problem, refreshConfig, spawn, type UiProject } from "./factory_ui_data.ts";

const GIT_MS = 60_000;
const CHANGED_SHOWN = 5;
const BRANCH = /^[\w./-]+$/;

export interface CheckoutState {
  path: string;
  main: string;
  /** The branch checked out; null when HEAD is detached. */
  branch: string | null;
  /** Commits main on GitHub has that the checkout doesn't; null when it can't be known. */
  behind: number | null;
  /** Commits the checkout has that main on GitHub doesn't; null when it can't be known. */
  ahead: number | null;
  /** The first few changed or untracked paths. */
  changed: string[];
  /** Each precondition, as the page shows it. */
  onMain: boolean;
  clean: boolean;
  /** Safe to move forward, and there is something to take. */
  canUpdate: boolean;
  /** Why it can't be brought up to date (null: it can, or it already is). */
  problem: Problem | null;
}

export interface CheckoutResult extends CheckoutState {
  updated: boolean;
  /** What happened, in a sentence. */
  message: string;
}

/** The main branch in settings `cfg`. */
export function mainBranchOf(cfg: Config | null): string {
  const m = cfg?.mainBranch;
  return typeof m === "string" && BRANCH.test(m) && !m.startsWith("-") ? m : "main";
}

/** The project's main branch, from its settings. */
export function mainOf(p: UiProject): string {
  return mainBranchOf(p.config);
}

async function git(p: UiProject, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await spawn(["git", ...args], p.path, envFor(p), GIT_MS);
  return { code: r.code, out: r.stdout.trimEnd(), err: r.stderr.trim() }; // the start kept: `git status --porcelain` starts with a space
}

function count(r: { code: number; out: string }): number | null {
  return r.code === 0 && /^\d+$/.test(r.out) ? Number(r.out) : null;
}

const commits = (n: number): string => `${n} commit${n === 1 ? "" : "s"}`;
const AGAIN = "then choose Bring this machine up to date in Factory settings, under This machine";

/** Where the checkout of `p` stands against main on GitHub. `readMain`: fetch main from GitHub first. */
export async function checkoutState(p: UiProject, readMain = true): Promise<CheckoutState> {
  const main = mainOf(p);
  const base: CheckoutState = { path: p.path, main, branch: null, behind: null, ahead: null, changed: [], onMain: false, clean: false,
    canUpdate: false, problem: null };
  const says = (code: string, message: string, fix: string): CheckoutState => ({ ...base, problem: { code, message, fix } });
  if (p.problem) return says("checkout_unreadable", p.problem.message, p.problem.fix);
  const dirs = await git(p, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
  if (dirs.code !== 0) {
    return says("checkout_unreadable", `${p.path} isn't a git checkout (${dirs.err.split("\n").at(-1)?.slice(0, 200) ?? ""}).`,
      "Open the project from its own folder, where it was cloned.");
  }
  const [own = "", common = ""] = dirs.out.split("\n");
  if (resolve(p.path, own) !== resolve(p.path, common)) {
    return says("checkout_agent_worktree", `${p.path} is an agent's worktree, so it was left as it is: its loop brings it up to date itself.`,
      "Nothing to do here; open the project from its own folder to bring that one up to date.");
  }
  if (readMain) {
    const f = await git(p, ["fetch", "-q", "origin", `+refs/heads/${main}:refs/remotes/origin/${main}`]);
    if (f.code !== 0) {
      return says("checkout_fetch_failed", `Main can't be read from GitHub (${f.err.split("\n").at(-1)?.slice(0, 200) || `exit ${f.code}`}), so ${p.path} was left as it is.`,
        `Check that this machine can reach GitHub (the Machines page shows it), ${AGAIN}.`);
    }
  }
  if ((await git(p, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${main}`])).code !== 0) {
    return says("checkout_no_main", `This machine has no copy of ${main} from GitHub yet, so ${p.path} was left as it is.`,
      `Check that the project has an origin on GitHub with a ${main} branch, ${AGAIN}.`);
  }
  const head = await git(p, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const branch = head.code === 0 && head.out ? head.out : null;
  const status = await git(p, ["status", "--porcelain"]);
  const changed = status.out ? status.out.split("\n").map((l) => l.slice(3)).filter(Boolean) : [];
  const behind = count(await git(p, ["rev-list", "--count", `HEAD..refs/remotes/origin/${main}`]));
  const ahead = count(await git(p, ["rev-list", "--count", `refs/remotes/origin/${main}..HEAD`]));
  const onMain = branch === main || (branch === null && ahead === 0);
  const clean = status.code === 0 && changed.length === 0;
  const s: CheckoutState = { ...base, branch, behind, ahead, changed: changed.slice(0, CHANGED_SHOWN), onMain, clean };
  const no = (code: string, message: string, fix: string): CheckoutState => ({ ...s, problem: { code, message, fix } });
  if (!onMain) {
    const what = branch ? `on the branch ${branch}` : "on a commit main doesn't have";
    return no("checkout_not_on_main", `${p.path} is ${what}, not ${main}, so it was left as it is (an agent may be working there).`,
      `When that work is done and ${main} is checked out again there, ${AGAIN}.`);
  }
  if (!clean) {
    const list = changed.slice(0, CHANGED_SHOWN).join(", ") + (changed.length > CHANGED_SHOWN ? ", ..." : "");
    return no("checkout_dirty", `${p.path} has uncommitted changes (${list || "git can't say which"}), so it was left as it is.`,
      `Commit them on a branch or put them aside, ${AGAIN}.`);
  }
  if (behind === null || ahead === null) {
    return no("checkout_unreadable", `How far ${p.path} is from ${main} can't be read, so it was left as it is.`, `Reload the page, ${AGAIN}.`);
  }
  if (ahead > 0) {
    return no("checkout_diverged", `${p.path} has ${commits(ahead)} ${main} on GitHub doesn't have, so it can't simply move forward; it was left as it is.`,
      `Put those commits on a branch and open a pull request, or drop them, ${AGAIN}.`);
  }
  return { ...s, canUpdate: behind > 0 };
}

/** Brings the checkout of `p` up to date with main on GitHub when that is safe; else leaves it and says why. */
export async function bringUpToDate(p: UiProject): Promise<CheckoutResult> {
  const s = await checkoutState(p, true);
  if (s.problem) return { ...s, updated: false, message: s.problem.message };
  if (!s.canUpdate) return { ...s, updated: false, message: `${p.path} is up to date with ${s.main}.` };
  const target = `refs/remotes/origin/${s.main}`;
  const moved = s.branch ? await git(p, ["merge", "-q", "--ff-only", target]) : await git(p, ["checkout", "-q", "--detach", target]);
  if (moved.code !== 0) {
    const problem = { code: "checkout_ff_failed", message: `${p.path} couldn't move forward to ${s.main} (${moved.err.split("\n").at(-1)?.slice(0, 200) || `exit ${moved.code}`}); it was left as it is.`,
      fix: `Look at the folder for what git names, ${AGAIN}.` };
    return { ...s, canUpdate: false, problem, updated: false, message: problem.message };
  }
  let note = "";
  if (existsSync(join(p.path, ".gitmodules"))) {
    const sub = await git(p, ["submodule", "update", "--init", "-q"]);
    if (sub.code !== 0) note = ` Its submodules couldn't be updated (${sub.err.split("\n").at(-1)?.slice(0, 200) ?? ""}).`;
  }
  refreshConfig(p); // the merged settings show at once
  const behind = s.behind ?? 0;
  return { ...s, behind: 0, canUpdate: false, updated: true,
    message: `Brought ${p.path} up to date with ${s.main} (${commits(behind)}): what was merged applies on this machine now.${note}` };
}
