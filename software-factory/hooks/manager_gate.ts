#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// PreToolUse hook on Bash for the dev manager's sessions (#96): the guard rails the manager's settings profile
// (.claude/manager/settings.json) wires in.
//
// It refuses, and says what to do instead (always: write an owner-queue ask):
//   - a merge unless the PR's latest approval marker is `<!-- factory-approved sha=<head> -->` for exactly the head being
//     merged, no must-fix came after it, the merge is pinned to that head (`-f sha=<head>`, or `--match-head-commit`) and
//     CI is judged green (newest non-skipped run per job name, factory_ci_judge.ts);
//   - closing a pull request (`gh api -X PATCH .../pulls/<n> -f state=closed`) unless a factory agent opened it (a `task/`
//     branch in this repository, or the manager's own `manager/` branch): anyone else's is the owner's to close (#203);
//   - a merge of a pull request the manager opened itself (a `manager/` branch, or a body with
//     `<!-- factory-role role=dev-manager ... -->`): its own PRs wait for the owner;
//   - deleting refs (`git push --delete`, `git push origin :branch`, `git branch -d`, `git update-ref -d`,
//     `gh api -X DELETE .../git/refs/...`), force-pushing, and pushing to the main branch;
//   - a gh command that carries `<!-- factory-owner-answer` (in the command or a body file it names): that marker is
//     the owner's answer, and only the owner writes it (#337); for the same reason, a comment body it can't read
//     (built with $(...) or $VARIABLES, or piped in on stdin);
//   - writes through `gh api` to `.github/` content, branch protection, rulesets, Actions secrets and variables, webhooks
//     and deploy keys (reading them is fine);
//   - reading secrets files (`.env*`, `secrets/`, keys) with a shell command.
//
// Like the PR gate it is a guard rail, not a security boundary: branch protection and required CI on GitHub are. It fails
// closed: an error, or a command it cannot read (gh or git hidden in bash -c, eval, xargs ...), blocks the command.
// Exit 2 blocks the command and tells Claude why.
import { basename } from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { load, loadFromMain } from "./factory_config.ts";
import { state as judgeState, JudgeError } from "./factory_ci_judge.ts";
import { Exit, run, runMain } from "./factory_lib.ts";
import {
  GH_IN_TEXT, GLOBAL_WITH_VALUE, MERGE_VALUE_FLAGS, PREFIXES, SHELL_EXPANSION, WRAPPERS, parseArgs, simpleCommands,
  type Flags,
} from "./factory_shell.ts";

const API_VALUE_FLAGS = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input", "-q",
  "--jq", "-t", "--template", "--cache", "--hostname", "-p", "--preview"]);
const ASK = "Write an owner-queue ask instead (a comment on the owner-queue issue starting `<!-- factory-owner-ask id=<slug> -->`).";
const OWN_BRANCH = /^manager\//;
const OWN_BODY = /<!--\s*factory-role\s+role=dev-manager\b/;
const APPROVED = /<!--\s*factory-approved\s+sha=([0-9a-f]{7,40})/;
const MUSTFIX = /<!--\s*factory-mustfix\b/;
const OWNER_ANSWER = /<!--\s*factory-owner-answer\b/;
const MERGE_PATH = /^(?<repo>repos\/[^/]+\/[^/]+)\/pulls\/(?<n>\d+)\/merge\/?$/;
const PULL_PATH = /^(?<repo>repos\/[^/]+\/[^/]+)\/pulls\/(?<n>\d+)\/?$/;
const AGENT_BRANCH = /^task\//;
const PROTECTED_WRITE: [RegExp, string][] = [
  [/\/contents\/\.github(\/|$)/, "`.github/` content (workflows and CODEOWNERS are protected)"],
  [/\/branches\/[^?]+\/protection/, "branch protection"],
  [/\/(rulesets|environments)(\/|$|\?)/, "repository rulesets and environments"],
  [/\/actions\/(secrets|variables)(\/|$|\?)/, "Actions secrets and variables"],
  [/\/(hooks|keys)(\/|$|\?)/, "webhooks and deploy keys"],
  [/\/git\/refs(\/|$|\?)/, "git refs"],
];
const SECRET = new RegExp(String.raw`(^|/)\.env(\.(?!example$|sample$|template$)[\w.-]+)?$|(^|/)secrets(/|$)|\.(pem|key|age)$|` +
  String.raw`(^|/)id_(rsa|ed25519|ecdsa)\b|(^|/)\.ssh(/|$)|(^|/)\.config/gh(/|$)`);
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const GIT_IN_TEXT = /(^|[^\p{L}\p{N}_.-])git\s+[a-z]/u;

type Row = { [key: string]: unknown };

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function row(v: unknown): Row {
  return isRow(v) ? v : {};
}

function refuse(msg: string): never {
  process.stderr.write(msg + "\n");
  throw new Exit(2);
}

/** The program of a simple command, after VAR=value assignments and prefixes like env or sudo, and its arguments. */
function program(tokens: string[]): [string, string[]] {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/s.test(tokens[i] as string) || PREFIXES.has(tokens[i] as string)
    || (i > 0 && PREFIXES.has(tokens[i - 1] as string) && (tokens[i] as string).startsWith("-")))) i++;
  return i < tokens.length ? [basename(tokens[i] as string), tokens.slice(i + 1)] : ["", []];
}

function ghApi(path: string, ...extra: string[]): unknown {
  const p = run(["gh", "api", ...extra, path]);
  if (p.code !== 0) {
    refuse(`The manager gate could not read ${path} from GitHub (${(p.stderr || p.stdout).trim().slice(0, 200)}), so it did ` +
      "not run the command. Try again in a moment. " + ASK);
  }
  return p.stdout.trim() ? (JSON.parse(p.stdout) as unknown) : null;
}

function allPages(path: string): Row[] {
  const out: Row[] = [];
  for (let page = 1; ; page++) {
    const chunk = ghApi(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(chunk)) refuse(`GitHub answered something other than a list for ${path}. ` + ASK);
    out.push(...(chunk as Row[]));
    if (chunk.length < 100) return out;
  }
}

/** `trustedReviewers` from main's factory.json as GitHub has it (never this folder's copy). Fails closed. */
function trusted(): Set<string> {
  try {
    const who = loadFromMain(load()).trustedReviewers;
    return new Set(Array.isArray(who) ? who.map(String) : []);
  } catch (e) {
    const text = e instanceof Exit ? (e.text ?? String(e.exitCode)) : e instanceof Error ? e.message : String(e);
    refuse(`The manager gate could not read the project's settings from GitHub (${text.slice(0, 200)}), so it did not run ` +
      "the command. Try again in a moment. " + ASK);
  }
}

/** Allows a merge of PR n pinned to `given`, or refuses and says why. `repo` is the API path prefix. */
function gateMerge(repo: string, n: string, given: string): void {
  if (!given) {
    refuse("Pin the merge to the head you reviewed: add `-f sha=<head>` (or --match-head-commit <head>). " +
      "GitHub then refuses it if the PR moved on. " + ASK);
  }
  const pr = ghApi(`${repo}/pulls/${n}`);
  if (!isRow(pr)) throw new TypeError("'NoneType' object has no attribute 'get'");
  if (pr.state !== "open") return; // already merged or closed: GitHub refuses it, and that means done by someone else
  const headRow = row(pr.head);
  const head = String(headRow.sha);
  const ref = String(headRow.ref ?? "");
  if (given.length < 7 || !head.startsWith(given)) {
    refuse(`PR #${n} has moved on: its head is ${head.slice(0, 12)}, not ${given.slice(0, 12)}. Review the new commit first ` +
      `(post a new \`<!-- factory-approved sha=${head.slice(0, 12)} -->\` only after reading it). ` + ASK);
  }
  if (OWN_BRANCH.test(ref) || OWN_BODY.test(String(pr.body || ""))) {
    refuse(`PR #${n} is a pull request the dev manager opened (${ref}). The manager does not merge its own pull requests: ` +
      "the owner does. " + ASK);
  }
  const who = trusted();
  let last: [string, string] | null = null; // the latest of the approval and must-fix markers decides
  for (const c of allPages(`${repo}/issues/${n}/comments`)) {
    const body = String(c.body || "");
    const login = String(row(c.user).login ?? "");
    if (MUSTFIX.test(body)) last = ["mustfix", ""];
    else {
      const m = APPROVED.exec(body);
      if (m && (!who.size || who.has(login))) last = ["approved", m[1] as string];
    }
  }
  if (last === null) {
    refuse(`PR #${n} has no \`<!-- factory-approved sha=<head> -->\` comment. Review it first; approve it with ` +
      `\`<!-- factory-approved sha=${head.slice(0, 12)} -->\`, or post a must-fix. ` + ASK);
  }
  if (last[0] === "mustfix") {
    refuse(`PR #${n}: the latest marker is a must-fix, not an approval. Wait for the fix and review it again.`);
  }
  if (!head.startsWith(last[1])) {
    refuse(`PR #${n}: the approval is for ${last[1].slice(0, 12)}, but the head is ${head.slice(0, 12)}. Review the new commit, then ` +
      "approve it. " + ASK);
  }
  let verdict: string;
  let jobs: string[];
  try {
    [verdict, jobs] = judgeState(head, repo);
  } catch (e) {
    if (!(e instanceof JudgeError)) throw e;
    refuse(`The manager gate could not judge CI for ${head.slice(0, 12)} (${e.message}). Try again in a moment.`);
  }
  if (verdict !== "green") {
    const what = ({ pending: "is still running", failed: "failed", none: "has no CI runs yet" } as Record<string, string>)[verdict];
    refuse(`CI ${what} for PR #${n} at ${head.slice(0, 12)}` + (jobs.length ? `: ${jobs.join(", ")}` : "") +
      ". CI is judged green only when the newest non-skipped run of every job succeeded. Wait with " +
      `\`factory wait ci ${n}\`, re-run only a flake the project's note lists, or post a must-fix.`);
  }
}

/** Allows closing PR n when a factory agent opened it (a task/ branch in this repository, or the manager's own branch),
 * else refuses: a pull request from the owner or anyone else is the owner's to close. */
function gateClose(repo: string, n: string): void {
  const pr = ghApi(`${repo}/pulls/${n}`);
  if (!isRow(pr)) throw new TypeError("'NoneType' object has no attribute 'get'");
  if (pr.state !== "open") return; // already closed or merged: nothing to close
  const head = row(pr.head);
  const ref = String(head.ref || "");
  const headRepo = row(head.repo).full_name;
  const baseRepo = row(row(pr.base).repo).full_name;
  if (headRepo && baseRepo && headRepo !== baseRepo) {
    refuse(`PR #${n} comes from another repository (${String(headRepo)}), so it is not a factory agent's. Closing it is the owner's. ` + ASK);
  }
  if (!(AGENT_BRANCH.test(ref) || OWN_BRANCH.test(ref))) {
    refuse(`PR #${n} is not a factory agent's (its branch is ${ref || "unknown"}, not task/...). The manager closes only the pull ` +
      "requests agents opened; one from the owner or anyone else is the owner's decision. " + ASK);
  }
}

function values(flags: Flags, ...names: string[]): string[] {
  return names.flatMap((n) => flags[n] ?? []);
}

/** Checks one `gh api` call; `flags` and `pos` are its parsed arguments (pos[0] is "api", pos[1] the path). */
function apiCall(flags: Flags, pos: string[], cmd: string): void {
  let path = pos.length > 1 ? (pos[1] as string) : "";
  const at = path.indexOf("://");
  if (at >= 0) path = path.slice(at + 3);
  path = path.replace(/^api\.github\.com\//, "").replace(/^\/+/, "");
  const given = values(flags, "-X", "--method");
  const fields = values(flags, "-f", "--raw-field", "-F", "--field");
  const method = (given.length ? (given[given.length - 1] as string) : fields.length || "--input" in flags ? "POST" : "GET").toUpperCase();
  if (method === "GET") return;
  const pull = PULL_PATH.exec(path);
  if (pull && method === "PATCH") {
    if ("--input" in flags || SHELL_EXPANSION.test(cmd)) {
      refuse("Write the pull request change as plain text (`-f state=closed`): the gate reads the command before the shell " +
        "expands $(...) or $VARIABLES, and it cannot read a body from --input. " + ASK);
    }
    if (fields.map((f) => f.replaceAll(" ", "")).includes("state=closed")) {
      gateClose(pull.groups?.repo as string, pull.groups?.n as string);
    }
    return;
  }
  const m = MERGE_PATH.exec(path);
  if (m && method === "PUT") {
    if ("--input" in flags || SHELL_EXPANSION.test(cmd)) {
      refuse("Write the merge's sha as plain text (`-f sha=<head>`): the gate reads the command before the shell " +
        "expands $(...) or $VARIABLES, and it cannot read a body from --input. " + ASK);
    }
    const shas = fields.filter((f) => f.startsWith("sha=")).map((f) => f.slice(4));
    gateMerge(m.groups?.repo as string, m.groups?.n as string, shas.length ? (shas[shas.length - 1] as string) : "");
    return;
  }
  for (const [rx, what] of PROTECTED_WRITE) {
    if (rx.test("/" + path)) {
      if (what === "git refs") {
        if (method === "DELETE" || method === "PATCH") refuse("The manager does not delete or move refs (that rewrites history). " + ASK);
        return;
      }
      refuse(`The manager does not change ${what}: that is the owner's. ` + ASK);
    }
  }
}

/** The files a gh call reads a body or field from: `--body-file f`, `--input f`, `-F key=@f`, and a bare `-F f`
 * (gh pr merge's --body-file). */
function bodyFiles(flags: Flags): string[] {
  const fields = values(flags, "-F", "--field").filter((v) => !v.includes("=") || /^[\w.[\]-]+=@/.test(v))
    .map((v) => v.replace(/^[\w.[\]-]+=@/, ""));
  return [...values(flags, "--body-file", "--input"), ...fields];
}

/** Whether a path is a regular file now (after links), so the gate reads what gh will read. */
function regularFile(path: string): boolean {
  try {
    return statSync(realpathSync(path)).isFile();
  } catch {
    return false;
  }
}

/** Whether a gh call would post the owner-answer marker: in the command's text or its tokens, or in a body file it
 * names. */
function postsOwnerAnswer(flags: Flags, args: string[], cmd: string): boolean {
  if (OWNER_ANSWER.test(cmd) || args.some((t) => OWNER_ANSWER.test(t))) return true;
  return bodyFiles(flags).some((p) => regularFile(p) && OWNER_ANSWER.test(readFileSync(p, "utf8")));
}

/** Whether a gh call's body is one the gate can't read before it runs: built by the shell (`$(...)`, `$VAR`); read from
 * stdin or anything else that is not a regular file (`-`, `/dev/stdin`); or read from a file in a command that runs
 * more than the gh call, which could write the file first. A missing file is left to gh to report. */
function hidesBody(flags: Flags, cmd: string, parts: number): boolean {
  const files = bodyFiles(flags);
  const texts = [...values(flags, "--body", "-b"),
    ...values(flags, "-f", "--raw-field", "-F", "--field").filter((v) => v.startsWith("body="))];
  if (!files.length && !texts.length) return false;
  if (SHELL_EXPANSION.test(cmd)) return true;
  if (files.length && parts > 1) return true;
  return files.some((p) => p === "-" || (existsSync(p) && !regularFile(p)));
}

function gitCall(args: string[]): void {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) i += GIT_VALUE_FLAGS.has(args[i] as string) ? 2 : 1;
  if (i >= args.length) return;
  const sub = args[i] as string;
  const rest = args.slice(i + 1);
  if (sub === "push") {
    if (rest.some((t) => ["-f", "--force", "--mirror", "--prune"].includes(t) || t.startsWith("--force") || t.startsWith("-f"))
      || rest.some((t) => t.startsWith("+"))) {
      refuse("The manager does not force-push. " + ASK);
    }
    if (rest.some((t) => t === "-d" || t === "--delete") || rest.some((t) => t.startsWith(":") && t.length > 1)) {
      refuse("The manager does not delete remote branches or tags. " + ASK);
    }
    const names = rest.filter((t) => !t.startsWith("-")).map((t) => t.replace(/^.*:/s, ""));
    if (names.some((n) => /^(refs\/heads\/)?(main|master)$/.test(n))) refuse("The manager does not push to the main branch. " + ASK);
  } else if ((sub === "branch" || sub === "tag") && rest.some((t) => ["-d", "-D", "--delete"].includes(t))) {
    refuse("The manager does not delete branches or tags. " + ASK);
  } else if (sub === "update-ref" && rest.includes("-d")) {
    refuse("The manager does not delete refs. " + ASK);
  }
}

function main(): void {
  const data = JSON.parse(readFileSync(0, "utf8")) as unknown;
  const input = row(row(data).tool_input);
  const cmd = String(input.command || "");
  let parts: string[][];
  try {
    parts = simpleCommands(cmd);
  } catch {
    refuse("The manager gate cannot read this command (unbalanced quotes?). Write it more simply.");
  }
  for (const p of parts) {
    const [prog, args] = program(p);
    if (!prog) continue;
    if (WRAPPERS.has(prog) && (args.some((t) => GH_IN_TEXT.test(t) || GIT_IN_TEXT.test(t)) || GH_IN_TEXT.test(args.join(" ")))) {
      refuse("Run gh and git directly, not inside bash -c, sh -c, eval or a quoted string: the manager gate has to " +
        "see the command.");
    }
    if (prog === "git") gitCall(args);
    else if (prog === "gh") {
      const [flags, pos] = parseArgs(args, new Set([...API_VALUE_FLAGS, ...MERGE_VALUE_FLAGS, ...GLOBAL_WITH_VALUE]));
      if (postsOwnerAnswer(flags, args, cmd)) {
        refuse("The manager does not post `<!-- factory-owner-answer -->`: that marker is the owner's answer, and only the " +
          "owner writes it. Leave the ask open for the owner to answer; post your own note without the marker.");
      }
      if (pos[0] === "api") apiCall(flags, pos, cmd);
      else if (pos[0] === "pr" && pos[1] === "merge") {
        if (pos.length < 3 || !/^\d+$/.test(pos[2] as string)) refuse("Name the pull request by its number, so the gate checks the one you mean.");
        if (SHELL_EXPANSION.test(cmd)) {
          refuse("Write the head sha as plain text: the gate reads the command before the shell expands $(...) or " +
            "$VARIABLES. " + ASK);
        }
        const heads = flags["--match-head-commit"] ?? [];
        gateMerge("repos/{owner}/{repo}", pos[2] as string, heads.length ? (heads[heads.length - 1] as string) : "");
      }
      if (hidesBody(flags, cmd, parts.length)) { // after the checks above, which say more about the commands they cover
        refuse("Write the comment's body as plain text (-f body=\"...\"), or write the file with the Write tool and post it " +
          "in a command of its own (-F body=@<file>): the gate reads the body before the shell runs, so it can't check one " +
          "built with $(...) or $VARIABLES, read from stdin, or written by the same command.");
      }
    } else if (args.some((t) => !t.startsWith("-") && SECRET.test(t))) {
      refuse("The manager does not read secrets files (.env*, secrets/, keys). " + ASK);
    }
  }
}

if (import.meta.main) {
  await runMain(() => {
    try {
      main();
    } catch (e) {
      if (e instanceof Exit) throw e;
      // fail closed
      const name = e instanceof Error ? e.name : typeof e;
      const text = e instanceof Error ? e.message : String(e);
      refuse(`The manager gate hit an error (${name}: ${text}); the command was not run. ` + ASK);
    }
    return 0;
  });
}
