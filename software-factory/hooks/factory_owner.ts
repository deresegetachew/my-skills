#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory owner`: what the owner does by hand, as factory commands, so the cockpit and the command line share them
// (US-6, #302). Each one is a thin wrapper over what exists.
//
//   factory owner merge <pr> [--head <sha>]  names the protected paths the PR touches, checks it is open, not a draft,
//                                            mergeable and green (factory_ci_judge.ts), then merges it (a merge commit) pinned to
//                                            its head (`gh pr merge --match-head-commit`). --head: only when the head is still
//                                            that commit (the one the cockpit showed, #309), else `pr_changed`
//   factory owner label <n> <label> [--remove]
//                                            adds (or removes) a label that exists on the repository
//   factory owner answer <ask-id> <text>     answers an owner-queue ask with `<!-- factory-owner-answer id=<ask-id> -->`
//   factory owner release <X.Y.Z>            tags main's commit vX.Y.Z and pushes the tag, when software-factory/VERSION
//                                            on main says X.Y.Z (the release workflow then publishes it)
//   factory owner start <role> [name]        starts `factory loop -i` as that role in its own tmux window on this machine,
//                                            the step `factory loop -i` uses (factory_window.ts), without attaching (#309)
//   factory owner stop <name>                ends that session's tmux session on this machine; one already ended is said so
//
// Who may run them (D12): the owner, in a terminal or the owner's own Claude session (no FACTORY_AGENT or FACTORY_LOOP).
// The dev manager (FACTORY_ROLE=dev-manager) may merge and label, each first checked by the manager gate
// (manager_gate.ts) on the exact gh command it runs, and never a pull request that touches protected paths. Answers,
// releases, starting and stopping stay the owner's. Every other factory session (a coding agent, the product owner) is
// refused before anything is read or written. Errors are one JSON line `{code, message, fix}` on stderr.
import { join } from "node:path";
import { state as judgeState, JudgeError } from "./factory_ci_judge.ts";
import { type Config, load, loadFromMain } from "./factory_config.ts";
import { type Comment, type Issue } from "./factory_issues.ts";
import { Exit, pyDumps, pyQuote, run, runMain } from "./factory_lib.ts";
import { OWNER_ASK, OWNER_QUEUE_TITLE, openOwnerAsks } from "./factory_prs.ts";
import { TAG_RE } from "./factory_release.ts";
import { running, sessionName, startLoop } from "./factory_window.ts";

const REPO = "repos/{owner}/{repo}";
const VERSION_FILE = "software-factory/VERSION";
const USAGE = `factory owner <command>

  merge <pr> [--head <sha>]   name the protected paths the pull request touches, then merge it (a merge commit) when it is open,
                              not a draft, mergeable and green, pinned to its head commit (--head: only if that is still the head)
  label <n> <label> [--remove]
                              add a label that exists on the repository to an issue or pull request (--remove: take it off)
  answer <ask-id> <text>      answer an ask in the owner queue ("Dev manager: needs the owner")
  release <X.Y.Z>             tag main vX.Y.Z and push the tag, when ${VERSION_FILE} on main says X.Y.Z
  start <role> [name]         start a coding-agent, dev-manager or product-owner session (factory loop -i) in its own tmux
                              window on this machine, without attaching
  stop <name>                 end that session's tmux session on this machine (one already ended: nothing to stop)

The owner runs these; the dev manager may merge and label, under the manager gate. Coding agents can't.`;

type Row = { [key: string]: unknown };
type Who = "owner" | "dev-manager";

function refuse(code: string, message: string, fix: string, exitCode = 1): never {
  process.stderr.write(pyDumps({ code, message, fix }) + "\n");
  throw new Exit(exitCode);
}

function row(v: unknown): Row {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Row) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Who is asking: the owner (no factory session), the dev manager, or refused for anyone else. */
export function who(): Who {
  const session = Boolean(process.env.FACTORY_AGENT || process.env.FACTORY_LOOP);
  if (!session) return "owner";
  if (process.env.FACTORY_ROLE === "dev-manager") return "dev-manager";
  const name = process.env.FACTORY_AGENT || "this session";
  return refuse("owner_only", `factory owner is for the owner and the dev manager; ${name} is a ` +
    `${process.env.FACTORY_ROLE || "coding-agent"} session.`,
    "Leave it to the owner: ask the dev manager in a <!-- factory-question --> comment on your pull request.");
}

function ownerOnly(what: string): never {
  return refuse("owner_only", `${what} is the owner's (D12), so the dev manager doesn't run it.`,
    "Write an owner-queue ask (a comment starting `<!-- factory-owner-ask id=<slug> -->`) and wait for the owner.");
}

// --- GitHub ---------------------------------------------------------------------------------------------------------

/** One REST call; null on a 404 when `ok404`. Any other failure stops with `github_failed`. */
function api<T>(method: string, path: string, body?: unknown, ok404 = false): T | null {
  const args = ["gh", "api", "-X", method, path, "-H", "Accept: application/vnd.github+json"];
  if (body !== undefined) args.push("--input", "-");
  const p = run(args, body !== undefined ? { input: JSON.stringify(body) } : {});
  if (p.code !== 0) {
    const text = (p.stderr || p.stdout).trim();
    if (ok404 && (text.includes("404") || text.includes("Not Found"))) return null;
    refuse("github_failed", `gh api ${method} ${path} failed: ${text.slice(0, 300)}`,
      "Check `gh auth status` and the network, then run the command again.");
  }
  return (p.stdout.trim() ? JSON.parse(p.stdout) : null) as T;
}

function apiAll<T>(path: string): T[] {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const chunk = api<unknown>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(chunk)) {
      refuse("github_failed", `GitHub answered something other than a list for ${path}.`, "Run the command again in a moment.");
    }
    out.push(...(chunk as T[]));
    if (chunk.length < 100) return out;
  }
}

function number(n: string | undefined, what: string, example: string): string {
  if (!n || !/^\d+$/.test(n)) refuse("bad_number", `Name the ${what} by its number (got ${n ? `\`${n}\`` : "nothing"}).`, example);
  return n;
}

function quote(s: string): string {
  return /^[\w.:\/{}=@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The dev manager's commands go through the manager gate first, on the exact command they run. */
function gate(cmd: string[]): void {
  const p = run([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "manager_gate.ts")],
    { input: JSON.stringify({ tool_input: { command: cmd.map(quote).join(" ") } }) });
  if (p.code !== 0) {
    refuse("gate_refused", `The manager gate refused it: ${(p.stderr || p.stdout).trim().slice(0, 600)}`,
      "Do what the gate says, or write an owner-queue ask for the owner.");
  }
}

// --- merge ----------------------------------------------------------------------------------------------------------

function protectedPaths(files: string[]): string[] {
  let cfg: Config;
  try {
    cfg = loadFromMain(load());
  } catch (e) {
    return refuse("github_failed", `Could not read the protected paths from main's .claude/factory.json: ${e instanceof Error ? e.message : String(e)}`,
      "Check `gh auth status` and the network, then run the command again.");
  }
  return files.filter((f) => !cfg.alwaysAllowed.includes(f) && cfg.protected.some((rx) => new RegExp(rx).test(f)));
}

function merge(n: string, me: Who, seen: string | null): void {
  const pr = row(api<Row>("GET", `${REPO}/pulls/${n}`, undefined, true));
  if (!Object.keys(pr).length) refuse("no_such_pr", `There is no pull request #${n}.`, "Check the number with `factory prs`.");
  const head = str(row(pr.head).sha);
  console.log(`PR #${n} ${str(pr.title)}`);
  if (seen !== null && !head.toLowerCase().startsWith(seen.toLowerCase())) {
    refuse("pr_changed", `#${n} changed since you looked: its head is now ${head.slice(0, 12)}, not ${seen.slice(0, 12)}.`,
      `Look at it again (r in the cockpit's Pull requests view, or \`factory prs\`), then merge: factory owner merge ${n}`);
  }
  if (pr.state !== "open" || pr.merged === true) {
    refuse("pr_not_open", `Pull request #${n} is ${pr.merged === true ? "merged" : str(pr.state) || "not open"}.`, "Nothing to merge; `factory prs` lists the open ones.");
  }
  // A rename is listed under its new name; the old one (previous_filename) is changed too.
  const hits = protectedPaths(apiAll<Row>(`${REPO}/pulls/${n}/files`).flatMap((f) => [str(f.filename), str(f.previous_filename)].filter(Boolean)));
  console.log(`Protected paths: ${hits.length ? hits.join(", ") : "none"}`);
  if (hits.length && me === "dev-manager") {
    refuse("protected_owner_merges", `#${n} changes protected paths (${hits.slice(0, 8).join(", ")}), so the owner merges it.`,
      "Write an owner-queue ask naming the pull request, and leave it open.");
  }
  if (pr.draft === true) refuse("pr_draft", `#${n} is a draft.`, `Mark it ready (\`gh pr ready ${n}\`) once it is, then merge it.`);
  let verdict: string;
  let jobs: string[];
  try {
    [verdict, jobs] = judgeState(head);
  } catch (e) {
    if (!(e instanceof JudgeError)) throw e;
    return refuse("github_failed", `Could not judge CI for ${head.slice(0, 12)}: ${e.message}`, "Run the command again in a moment.");
  }
  const failing = jobs.length ? `: ${jobs.join(", ")}` : "";
  if (verdict === "failed") {
    refuse("checks_failed", `CI failed for #${n} at ${head.slice(0, 12)}${failing}.`, `See why with \`factory ci log ${n}\`; merge once it is green.`);
  }
  if (verdict !== "green") {
    refuse("checks_pending", `CI ${verdict === "none" ? "has not run" : "is still running"} for #${n} at ${head.slice(0, 12)}${failing}.`,
      `Wait with \`factory wait ci ${n}\`, then run the command again.`);
  }
  if (pr.mergeable === false || pr.mergeable_state === "dirty") {
    refuse("not_mergeable", `#${n} can't be merged as it is (it conflicts with the base branch).`,
      "Merge the main branch into the pull request's branch and push, then run the command again.");
  }
  const cmd = ["gh", "pr", "merge", n, "--merge", "--delete-branch", "--match-head-commit", head];
  if (me === "dev-manager") gate(cmd);
  const p = run(cmd);
  if (p.code !== 0) {
    refuse("merge_failed", `gh pr merge #${n} failed: ${(p.stderr || p.stdout).trim().slice(0, 300)}`,
      `Look at the pull request (\`gh pr view ${n} --web\`) and run the command again.`);
  }
  console.log(`Merged #${n} at ${head.slice(0, 12)}.`);
}

// --- label ----------------------------------------------------------------------------------------------------------

function label(n: string, name: string | undefined, remove: boolean, me: Who): void {
  if (!name) refuse("needs_label", "Say which label.", `factory owner label ${n} factory:ready`);
  const known = apiAll<Row>(`${REPO}/labels`).map((l) => str(l.name));
  if (!known.includes(name)) {
    refuse("no_such_label", `The repository has no label \`${name}\`.`,
      "`factory issues setup` makes the factory's labels; `gh label list` shows the ones there are.");
  }
  if (api<Row>("GET", `${REPO}/issues/${n}`, undefined, true) === null) {
    refuse("no_such_item", `There is no issue or pull request #${n}.`, "Check the number with `factory prs` or `factory issues list`.");
  }
  const path = remove ? `${REPO}/issues/${n}/labels/${pyQuote(name)}` : `${REPO}/issues/${n}/labels`;
  if (me === "dev-manager") gate(["gh", "api", "-X", remove ? "DELETE" : "POST", path, ...(remove ? [] : ["-f", `labels[]=${name}`])]);
  if (remove) api("DELETE", path, undefined, true);
  else api("POST", path, { labels: [name] });
  console.log(`#${n}: ${remove ? "removed" : "added"} ${name}.`);
}

// --- answer ---------------------------------------------------------------------------------------------------------

function answer(id: string | undefined, text: string): void {
  if (!id) refuse("needs_id", "Say which ask you answer.", "`factory cockpit --needs` lists the open asks with their ids.");
  if (!text.trim()) refuse("needs_text", `Write the answer to ${id}.`, `factory owner answer ${id} "yes, go ahead"`);
  const queue = apiAll<Issue & Row>(`${REPO}/issues?state=open`)
    .find((i) => str(i.title).startsWith(OWNER_QUEUE_TITLE) && !("pull_request" in i && i.pull_request));
  if (!queue) {
    refuse("no_owner_queue", `There is no open "${OWNER_QUEUE_TITLE}" issue, so there is nothing to answer.`,
      "The dev manager opens it with its first ask; `factory cockpit --needs` shows what needs you.");
  }
  const comments = apiAll<Comment>(`${REPO}/issues/${queue.number}/comments`) as Row[];
  const asked = comments.map((c) => OWNER_ASK.exec(str(c.body))?.[1]).filter((s): s is string => Boolean(s));
  const open = openOwnerAsks(comments).map(([slug]) => slug);
  if (!asked.includes(id)) {
    refuse("no_such_ask", `There is no ask \`${id}\` in #${queue.number}. Open: ${open.length ? open.join(", ") : "none"}.`,
      "`factory cockpit --needs` lists the open asks with their ids.");
  }
  if (!open.includes(id)) {
    console.log(`${id} is already answered on #${queue.number}; nothing posted.`);
    return;
  }
  api("POST", `${REPO}/issues/${queue.number}/comments`, { body: `<!-- factory-owner-answer id=${id} -->\n\n${text.trim()}` });
  console.log(`Answered ${id} on #${queue.number}.`);
}

// --- release --------------------------------------------------------------------------------------------------------

function git(...args: string[]): { code: number; out: string; err: string } {
  const p = run(["git", ...args]);
  return { code: p.code, out: p.stdout.trim(), err: (p.stderr || p.stdout).trim() };
}

/** The commit the tag names on origin, or "" when origin has no such tag. */
function remoteTag(tag: string): string {
  const p = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  if (p.code !== 0) refuse("git_failed", `Could not ask origin for its tags: ${p.err.slice(0, 300)}`, "Check the network and `git remote -v`, then run it again.");
  const lines = p.out.split("\n").filter((l) => l).map((l) => l.split("\t"));
  const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`) ?? lines.find(([, ref]) => ref === `refs/tags/${tag}`);
  return peeled ? (peeled[0] as string) : "";
}

function release(given: string | undefined): void {
  const tag = given && !given.startsWith("v") ? `v${given}` : given ?? "";
  if (!TAG_RE.test(tag)) refuse("bad_version", `\`${given ?? ""}\` isn't a version like 1.4.0.`, "factory owner release 1.4.0");
  const version = tag.slice(1);
  const main = load().mainBranch || "main";
  const f = git("fetch", "-q", "origin", `+refs/heads/${main}:refs/remotes/origin/${main}`);
  if (f.code !== 0) refuse("git_failed", `Could not fetch ${main} from origin: ${f.err.slice(0, 300)}`, "Check the network and `git remote -v`, then run it again.");
  const shown = git("show", `origin/${main}:${VERSION_FILE}`);
  if (shown.code !== 0) {
    refuse("no_version_file", `${main} has no ${VERSION_FILE}, so this isn't where factory releases come from.`,
      "Run it in the my-skills repository, where the factory's releases are cut.");
  }
  if (shown.out !== version) {
    refuse("version_mismatch", `${VERSION_FILE} on ${main} is ${shown.out || "empty"}, not ${version}.`,
      `Bump ${VERSION_FILE} to ${version} in a pull request and merge it, then run \`factory owner release ${version}\` again.`);
  }
  const sha = git("rev-parse", `origin/${main}^{commit}`).out;
  const there = remoteTag(tag);
  if (there === sha) {
    console.log(`${tag} is already published at ${sha.slice(0, 12)}; nothing to do.`);
    return;
  }
  if (there) {
    refuse("tag_exists", `origin already has ${tag}, at ${there.slice(0, 12)}, not at ${main}'s ${sha.slice(0, 12)}.`,
      "A published release is never moved: bump the version and release that.");
  }
  const local = git("rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`);
  if (local.code === 0 && local.out !== sha) {
    refuse("local_tag_differs", `Your local ${tag} is at ${local.out.slice(0, 12)}, not at ${main}'s ${sha.slice(0, 12)}.`,
      `Delete the local tag (\`git tag -d ${tag}\`), then run it again.`);
  }
  const made = local.code !== 0;
  if (made) {
    const t = git("tag", "-a", tag, "-m", tag, sha);
    if (t.code !== 0) refuse("git_failed", `Could not make the tag ${tag}: ${t.err.slice(0, 300)}`, "Fix what git says, then run it again.");
  }
  const p = git("push", "-q", "origin", `refs/tags/${tag}`);
  if (p.code !== 0) {
    if (made) git("tag", "-d", tag); // nothing half done: no local tag left that origin doesn't have
    refuse("push_failed", `Could not push ${tag} to origin: ${p.err.slice(0, 300)}`, "Check your access to the repository, then run it again.");
  }
  console.log(`Tagged ${tag} at ${sha.slice(0, 12)} (${main}) and pushed it. The release workflow builds and publishes it.`);
}

// --- start and stop (#309) ------------------------------------------------------------------------------------------
//
// This machine's tmux, never the cockpit's own server: TMUX is dropped, so the session is where `factory follow`, `say`
// and the heartbeat look for it.

const ROLES = ["coding-agent", "dev-manager", "product-owner"];

function agentName(name: string | undefined, example: string): string {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    refuse("bad_name", `Name the session by its agent name, such as taytu (got ${name ? `\`${name}\`` : "nothing"}).`, example);
  }
  return name;
}

function start(role: string | undefined, name: string | undefined): void {
  if (!role || !ROLES.includes(role)) {
    refuse("bad_role", `Say which role to start: ${ROLES.join(", ")} (got ${role ? `\`${role}\`` : "nothing"}).`,
      "factory owner start coding-agent taytu");
  }
  delete process.env.TMUX;
  startLoop(role, name === undefined ? "" : agentName(name, `factory owner start ${role} taytu`), ["-i"]);
  console.log("`factory follow <name>` shows it, or Enter on it in the cockpit.");
}

function stop(name: string): void {
  delete process.env.TMUX;
  const session = sessionName(name);
  if (!running(session)) {
    console.log(`${name} is not running on this machine (no tmux session ${session}); nothing to stop.`);
    return;
  }
  const p = run(["tmux", "kill-session", "-t", `=${session}`]);
  if (p.code !== 0 && running(session)) {
    refuse("stop_failed", `tmux could not end ${session}: ${(p.stderr || p.stdout).trim().slice(0, 200)}`,
      `Run \`tmux ls\` to see it, then \`tmux kill-session -t ${session}\`.`);
  }
  console.log(`Stopped ${name} (tmux session ${session}). Its task stays claimed for it: start it again to go on, ` +
    `or \`factory release ${name}\` to give its claims back.`);
}

// --- the command ----------------------------------------------------------------------------------------------------

/** `merge <pr> [--head <sha>]`: the number and the head the owner saw, if given. */
function mergeArgs(rest: string[]): [string, string | null] {
  const at = rest.indexOf("--head");
  if (at < 0) return [number(rest[0], "pull request", "factory owner merge 12"), null];
  const sha = rest[at + 1] ?? "";
  if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    refuse("needs_head", `--head needs the commit you saw, 7 to 40 hex characters (got ${sha ? `\`${sha}\`` : "nothing"}).`,
      "factory owner merge 12 --head 0123abc");
  }
  const words = rest.filter((_, i) => i !== at && i !== at + 1);
  return [number(words[0], "pull request", "factory owner merge 12"), sha];
}

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return 0;
  }
  if (!["merge", "label", "answer", "release", "start", "stop"].includes(cmd)) {
    refuse("unknown_command", `factory owner has no command \`${cmd}\`.`,
      "Use one of: merge, label, answer, release, start, stop (`factory owner help`).", 2);
  }
  const me = who();
  if (cmd === "merge") {
    const [n, seen] = mergeArgs(rest);
    merge(n, me, seen);
  }
  else if (cmd === "start" || cmd === "stop") {
    if (me === "dev-manager") ownerOnly(cmd === "start" ? "Starting a session" : "Stopping a session");
    if (rest.length > (cmd === "start" ? 2 : 1)) {
      refuse("bad_args", `factory owner ${cmd} takes ${cmd === "start" ? "a role and a name" : "one name"}, not \`${rest.join(" ")}\`.`,
        cmd === "start" ? "factory owner start coding-agent taytu" : "factory owner stop taytu", 2);
    }
    if (cmd === "start") start(rest[0], rest[1]);
    else stop(agentName(rest[0], "factory owner stop taytu"));
  } else if (cmd === "label") {
    const remove = rest.includes("--remove");
    const words = rest.filter((w) => w !== "--remove");
    label(number(words[0], "issue or pull request", "factory owner label 12 factory:ready"), words[1], remove, me);
  } else if (cmd === "answer") {
    if (me === "dev-manager") ownerOnly("Answering the owner queue");
    answer(rest[0], rest.slice(1).join(" "));
  } else {
    if (me === "dev-manager") ownerOnly("Publishing a release");
    release(rest[0]);
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
