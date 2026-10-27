#!/usr/bin/env -S bun --no-env-file
// PreToolUse hook on Bash: gate the coding agent's pull-request commands.
//
// create (and `gh pr new`, `gh pr ready`): needs a reviewer pass for the commit (<reviewMarkers>/<branch>.ok holding
//         it), except draft PRs (`--draft`), which are for questions and early feedback. When the diff touches a path
//         in `styles`, it also needs the architecture-reviewer's pass (<branch>.arch.ok). When main's factory.json sets
//         `commands.ci`, it also needs `factory verify` to have passed that commit (<branch>.ci.ok), so a PR doesn't
//         reach CI with errors the agent could have caught locally (#58).
// merge:  needs those passes for the PR's head commit, green CI, no protected paths changed (`protected` in
//         .claude/factory.json; `alwaysAllowed` files such as the build plan are fine), no hold label, no open
//         dev-manager must-fix, and `--match-head-commit <head>` so the commit checked is the commit merged.
// Numbers: create and ready also need every new decision or migration file (`decisions`, `numberedDirs`) to take a
//         number that neither main nor another open PR has (factory_numbers.ts); the message names the next free one.
// Issues mode (`tasks.source: "issues"`): create also needs the branch's issue (task/<n>-...) open, not blocked, not
//         held by another agent, and `Closes #<n>` in the PR body.
// Markers: agents may not post the dev manager's markers (factory-approved, factory-answer, factory-mustfix, and the
//         claim markers of factory_manager_claims.ts), add the review labels or remove the hold label.
// Messages (docs/messages.md): a comment with a `factory-msg` envelope is checked too. An agent posts as itself
//         (from= is FACTORY_AGENT), never as kind approval or mustfix, and answers, works on or fails only a question
//         addressed to it, with a valid state transition; the question is looked up in the thread (the number on the
//         command, else ref=). An envelope of another version is not read, so it passes. With `trustedReviewers` in
//         factory.json, only those GitHub logins' approvals count. An approval counts only for the commit it names (`sha=`).
//         `--admin` is refused: it skips branch protection (#260).
// gh api: a plain GET passes. Writes to `pulls/<n>/merge`, labels or reviews, and GraphQL mutations, are refused: the
//         plain gh commands are the checked way. Other writes have their fields and --input read: markers and messages
//         are checked as for comments, and `POST repos/<o>/<r>/pulls` gets the create checks (#260).
// Pushes: agents may not delete remote branches (`git push <remote> :<branch>` or `+:<branch>`), also inside bash -c,
//         nor force-push (-f, --force*, --mirror, a +refspec), wherever git's global options sit (#260).
// Quoting: gh and git are found in the parsed words, so `g\h` and `"g"h` are gh (#260).
// Settings: agents may not change the factory's settings (`factory settings set`, `unset`, `pr`, `interactive`, `--local`
//         changes, `docs --write`), also inside bash -c; the read-only ones (list, get, help, diff, validate) pass (#49).
// Wrappers: gh run through a shell, eval, xargs or a package runner (pnpm exec, npx, yarn) can't be checked: refused.
//
// This gate is a guard rail for well-meaning agents, not a security boundary: branch protection and required CI
// checks on GitHub are. It fails closed: an error, or a command it can't read, blocks the command.
// Exit 2 blocks the command and tells Claude why.
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Config, blockedIds, branchTask, load, loadFromMain, styled, taskLabels, taskSource, tasks,
} from "./factory_config.ts";
import { message as ciMessage, notStarted } from "./factory_ci.ts";
import { Exit, run as runCmd, runMain } from "./factory_lib.ts";
import * as fm from "./factory_messages.ts";
import { type Added, NumbersError, clashes, prAdded } from "./factory_numbers.ts";
import {
  GH_COMMANDS, GH_IN_SUBSTITUTION, GH_IN_TEXT, GIT_GLOBAL_WITH_VALUE, GLOBAL_WITH_VALUE, MERGE_VALUE_FLAGS, PREFIXES,
  PUSH_DELETE_IN_TEXT, SHELL_EXPANSION, WRAPPERS, type Flags, parseArgs, simpleCommands,
} from "./factory_shell.ts";

export const MARKERS = /<!--\s*factory-(approved|answer|mustfix|review-claim|claim-release|owner-ask)\b/;
export const REVIEW_LABELS = new Set(["tests-reviewed", "deps-reviewed"]);
export const SETTINGS_READ_ONLY = new Set(["list", "ls", "get", "show", "help", "options", "diff", "validate", "docs"]);
const SETTINGS_WITH_VALUE = new Set(["--section", "--file"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/s;
const NEXT = "`bun --no-env-file .claude/hooks/next_task.ts`";
/** gh api's flags that take a value. */
const API_VALUE_FLAGS = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input",
  "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview", "--hostname"]);
/** git push's flags that take a value (so `-o fix` is not -f). */
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const MARKER_MSG = "Only the dev manager posts factory-approved, factory-answer, factory-mustfix, claim and owner-ask comments. " +
  "Ask with <!-- factory-question --> instead.";

/** The command as bash reads its words, for the quick tests: quotes, backslashes and line continuations gone, so
 * `g\h` and `"g"h` read as gh. Only for finding a program; the checks run on the parsed words. */
function unquoted(text: string): string {
  return text.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "");
}

type Row = { [key: string]: unknown };

function row(v: unknown): Row {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Row) : {};
}

function run(...a: string[]): [number, string, string] {
  const p = runCmd(a);
  return [p.code, p.stdout.trim(), p.stderr.trim()];
}

/** Block the command: the reason on stderr, exit 2. */
export function block(msg: string): never {
  process.stderr.write(msg + "\n");
  throw new Exit(2);
}

/** Where the program of a simple command starts: after VAR=value assignments and prefixes like env or sudo. */
function programAt(tokens: string[], prefixFlags: boolean): number {
  let i = 0;
  while (i < tokens.length && (ASSIGNMENT.test(tokens[i] as string) || PREFIXES.has(tokens[i] as string)
    || (prefixFlags && i > 0 && PREFIXES.has(tokens[i - 1] as string) && (tokens[i] as string).startsWith("-")))) i++;
  return i;
}

/** True when these arguments of `factory settings` would change something: anything but the read-only commands. */
export function settingsChange(args: string[]): boolean {
  if (args.includes("-i")) return true;
  let sub: string | null = null;
  let skip = false;
  for (const a of args) {
    if (skip) skip = false;
    else if (SETTINGS_WITH_VALUE.has(a)) skip = true;
    else if (!a.startsWith("-")) {
      sub = a;
      break;
    }
  }
  if (sub === null) return false; // bare `factory settings` lists (the menu needs a terminal an agent doesn't have)
  return !SETTINGS_READ_ONLY.has(sub) || (sub === "docs" && args.includes("--write"));
}

/** True when the command (or a bash -c inside it) runs a `factory settings` command that changes settings. */
export function changesSettings(cmd: string, depth = 0): boolean {
  let parts: string[][];
  try {
    parts = simpleCommands(cmd);
  } catch {
    return /factory\s+settings\s+(?!(list|ls|get|show|help|options|diff|validate)\b)/.test(cmd);
  }
  for (const tokens of parts) {
    const i = programAt(tokens, true);
    if (i >= tokens.length) continue;
    const prog = basename(tokens[i] as string);
    const rest = tokens.slice(i + 1);
    if (["bash", "sh", "zsh", "dash"].includes(prog) && rest.includes("-c") && depth < 3) {
      const k = rest.indexOf("-c");
      if (k + 1 < rest.length && changesSettings(rest[k + 1] as string, depth + 1)) return true;
    } else if (prog === "factory" && rest[0] === "settings") {
      if (settingsChange(rest.slice(1))) return true;
    } else if (prog.startsWith("factory_settings") && settingsChange(rest)) {
      return true;
    } else if (prog === "python" || prog === "python3" || prog === "bun") {
      for (let k = 0; k < rest.length; k++) {
        if (basename(rest[k] as string).startsWith("factory_settings") && settingsChange(rest.slice(k + 1))) return true;
      }
    }
  }
  return false;
}

/** The arguments after `push` when this simple command is `git push`, else null. */
function pushArgs(tokens: string[]): string[] | null {
  let i = programAt(tokens, false);
  if (i >= tokens.length || basename(tokens[i] as string) !== "git") return null;
  i += 1;
  while (i < tokens.length && (tokens[i] as string).startsWith("-")) { // git's global options, some with a value
    i += GIT_GLOBAL_WITH_VALUE.has(tokens[i] as string) ? 2 : 1;
  }
  return i < tokens.length && tokens[i] === "push" ? tokens.slice(i + 1) : null;
}

/** Whether this simple command is `git push` with a refspec that deletes a remote branch (`:branch`). */
export function pushDeletes(tokens: string[]): boolean {
  return (pushArgs(tokens) ?? []).some((t) => (t.startsWith(":") || t.startsWith("+:")) && t.replace(/^\++/, "").length > 1);
}

/** Whether this simple command is a `git push` that can overwrite the remote: -f (also bundled, `-uf`), --force,
 * --force-with-lease, --force-if-includes, --mirror or a `+` refspec. */
export function pushForces(tokens: string[]): boolean {
  const args = pushArgs(tokens) ?? [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k] as string;
    if (PUSH_VALUE_FLAGS.has(t)) k++;
    else if (t === "--mirror" || t.startsWith("--force")) return true;
    else if (/^-[^-]/.test(t) && (t.slice(1).split("o")[0] as string).includes("f")) return true; // -o takes the rest as its value
    else if (t.startsWith("+")) return true;
  }
  return false;
}

/** The simple commands, and the ones a wrapper runs: `xargs git push -f` and `bash -c 'git push -f'` (a few levels). */
function withWrapped(parts: string[][], depth = 0): string[][] {
  const out = [...parts];
  if (depth >= 3) return out;
  for (const p of parts) {
    if (!p.length || !WRAPPERS.has(basename(p[0] as string))) continue;
    out.push(...withWrapped([p.slice(1)], depth + 1));
    for (const arg of p.slice(1).filter((t) => /\s/.test(t))) {
      try {
        out.push(...withWrapped(simpleCommands(arg), depth + 1));
      } catch {
        // an argument that isn't a command: nothing to add
      }
    }
  }
  return out;
}

export type GhCall = [top: string, sub: string, args: string[]];

/** [top-level command, subcommand, args] when this simple command runs gh, else null. */
export function ghCall(tokens: string[]): GhCall | null {
  const i = programAt(tokens, true); // gh counts only as the program
  if (i >= tokens.length || basename(tokens[i] as string) !== "gh") return null;
  const rest = tokens.slice(i + 1);
  let k = 0;
  const word = (): [string, string[]] => {
    const lead: string[] = [];
    while (k < rest.length) {
      const t = rest[k] as string;
      if (GLOBAL_WITH_VALUE.has(t)) {
        lead.push(...rest.slice(k, k + 2));
        k += 2;
      } else if (t.startsWith("-")) {
        lead.push(t);
        k += 1;
      } else {
        k += 1;
        return [t, lead];
      }
    }
    return ["", lead];
  };
  const [top] = word();
  const [sub, lead] = word();
  return [top, sub, [...lead, ...rest.slice(k)]];
}

/** The arguments after `api`, in their order, when this simple command is `gh api`, else null. */
export function apiArgs(tokens: string[]): string[] | null {
  const i = programAt(tokens, true);
  if (i >= tokens.length || basename(tokens[i] as string) !== "gh") return null;
  for (let k = i + 1; k < tokens.length; k++) {
    const t = tokens[k] as string;
    if (GLOBAL_WITH_VALUE.has(t)) k++;
    else if (!t.startsWith("-")) return t === "api" ? tokens.slice(k + 1) : null;
  }
  return null;
}

function values(flags: Flags, ...names: string[]): string[] {
  return names.flatMap((n) => flags[n] ?? []);
}

/** Whether a boolean flag is set and every value given for it is true (gh uses the last one, so a mix is refused
 * as not set: --draft --draft=false is not a draft). */
export function isTrue(flags: Flags, ...names: string[]): boolean {
  const given = values(flags, ...names);
  return given.length > 0 && given.every((v) => v === "" || v === "true");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The PR or comment body the command passes: --body values and --body-file contents. */
export function bodyText(flags: Flags): string {
  const given = values(flags, "-b", "--body", "-c", "--comment", "-F", "--body-file");
  if (given.some((v) => SHELL_EXPANSION.test(v))) {
    block("Write the body as plain text or a --body-file path: the PR gate reads the command before the shell " +
      "expands $(...), `...` or $VARIABLES, so it can't check what they'd say.");
  }
  let text = values(flags, "-b", "--body", "-c", "--comment").join("\n");
  for (const f of values(flags, "-F", "--body-file")) {
    if (f === "-") block("Pass the body with --body or a --body-file path, not on stdin: the PR gate has to read it.");
    if (!isFile(f)) block(`--body-file ${f} doesn't exist.`);
    text += "\n" + readFileSync(f, "utf8");
  }
  return text;
}

function main(): void {
  const data = row(JSON.parse(readFileSync(0, "utf8")) as unknown);
  const cmd = String(row(data.tool_input).command || "");
  if (cmd.includes("settings") && changesSettings(cmd)) {
    block("Agents don't change the factory's settings (`factory settings set`, `unset`, `pr`, `interactive`, " +
      "`--local`, `docs --write`): the PR gate reads them. `factory settings list`, `get`, `help`, `diff` and " +
      "`validate` are fine. Ask the dev manager to change the setting in a pull request.");
  }
  const plain = unquoted(cmd);
  if (/\bpush\b/.test(plain) && /\bgit\b/.test(plain)) {
    let pushes: string[][] = [];
    try {
      pushes = simpleCommands(cmd);
    } catch {
      block("The PR gate can't read this command (unbalanced quotes?). Write it more simply.");
    }
    if (pushes.some(pushDeletes) || pushes.some((p) => p.length > 0 && WRAPPERS.has(basename(p[0] as string))
      && PUSH_DELETE_IN_TEXT.test(p.slice(1).join(" ")))) {
      block("Agents don't delete remote branches (`git push <remote> :<branch>`). Leave branch clean-up to the " +
        "dev manager.");
    }
    if (withWrapped(pushes).some(pushForces)) {
      block("Agents don't force-push (-f, --force, --force-with-lease, --force-if-includes, --mirror or a +refspec): " +
        "it overwrites commits a reviewer or another agent saw. Push new commits on top instead (`git push origin " +
        "<branch>`), or ask the dev manager with <!-- factory-question --> if the branch really needs rewriting.");
    }
  }
  // no gh at all: the fast path for every other Bash call. On the text without quotes, so `g\h` and `"g"h` are seen;
  // the checks below find gh in the parsed words.
  if (!/(^|[^\p{L}\p{N}_.-])gh\b/u.test(plain)) return;
  let parts: string[][] = [];
  try {
    parts = simpleCommands(cmd);
  } catch {
    block("The PR gate can't read this command (unbalanced quotes?). Write it more simply.");
  }
  const found: [GhCall, string[]][] = [];
  for (const p of parts) {
    const c = ghCall(p);
    if (c) found.push([c, p]);
  }
  // gh hidden inside one argument (bash -c '...', eval "...", xargs sh -c ...) can't be checked: refuse it.
  if (parts.some((p) => p.length > 0 && WRAPPERS.has(basename(p[0] as string))
    && (p.slice(1).some((t) => GH_IN_TEXT.test(unquoted(t))) || GH_IN_TEXT.test(unquoted(p.slice(1).join(" ")))))
    || GH_IN_SUBSTITUTION.test(cmd) || GH_IN_SUBSTITUTION.test(plain)) {
    block("Run gh directly, not inside bash -c, sh -c, eval or a quoted string: the PR gate has to see the command.");
  }
  if (!found.length) return;
  // The rules come from main's factory.json, never this worktree's copy, which the agent could edit (#51).
  const cfg = loadFromMain(load());
  for (const [[top], tokens] of found) {
    if ((top === "pr" || top === "issue") && tokens.some((t) => t === "-R" || t === "--repo" || t.startsWith("--repo=") || t.startsWith("-R"))) {
      block("Agents work on this repository only: leave out -R/--repo, so the gate checks the PR it means.");
    }
  }
  if (parts.some((p) => p.length > 0 && ["cd", "pushd", "popd"].includes(basename(p[0] as string)))) {
    block("Run pull-request commands from the project folder, without cd in the same command: the gate checks " +
      "the repository it runs in.");
  }
  const calls = found.map(([c]) => c);
  for (const [top] of calls) {
    if (top === "alias") block("Agents don't define gh aliases.");
    if (top && !GH_COMMANDS.has(top)) {
      block(`\`gh ${top}\` isn't a gh command the factory knows (aliases and extensions aren't allowed for ` +
        "agents). Use the plain gh command.");
    }
  }
  for (const [top, sub, args] of calls) {
    if ((top === "pr" || top === "issue") && ["comment", "edit", "review", "close", "reopen", "create", "new"].includes(sub)) {
      checkMarkers(cfg, sub, args);
    }
  }
  const apiCreates: ApiCreate[] = [];
  for (const [, tokens] of found) {
    const api = apiArgs(tokens);
    const create = api ? gateApi(api) : null;
    if (create) apiCreates.push(create);
  }
  const prCalls = calls.filter(([top]) => top === "pr").map(([, sub, args]): [string, string[]] => [sub, args]);
  const merges = prCalls.filter(([sub]) => sub === "merge").map(([, args]) => args);
  const gated = prCalls.filter(([sub, args]) => ["create", "new", "ready", "merge"].includes(sub)
    && !(sub === "ready" && isTrue(parseArgs(args)[0], "--undo"))); // back to draft: nothing to gate
  if (!gated.length && !apiCreates.length) return;
  if (merges.length > 1) block("One merge per command, so each one is checked.");
  if (merges.length && parts.some((p) => p.length > 0 && basename(p[0] as string) === "git" && p.slice(1, 4).includes("push"))) {
    block("Push and merge in separate commands: a push in the same command would merge a commit nobody checked.");
  }
  if (gated.length + apiCreates.length > 1) block("One pull-request command at a time (create, ready or merge), so each one is checked.");
  if (apiCreates.length) {
    const c = apiCreates[0] as ApiCreate;
    gateCreate(cfg, c.draft, c.body);
    return;
  }
  const [sub, args] = gated[0] as [string, string[]];
  if (sub === "create" || sub === "new") {
    const [flags] = parseArgs(args);
    gateCreate(cfg, isTrue(flags, "--draft", "-d"), () => bodyText(flags));
  } else if (sub === "ready") gateReady(cfg, args);
  else gateMerge(cfg, args);
}

type ApiCreate = { draft: boolean; body: () => string };

/** A file's text for the gate, or a refusal when it can't be read: stdin can't be checked. */
function fileText(path: string, flag: string): string {
  if (path === "-" || path === "") block(`Pass ${flag} a file path, not stdin: the PR gate has to read it (--input <file>, -F body=@<file>).`);
  if (!isFile(path)) block(`${path} (${flag}) doesn't exist.`);
  return readFileSync(path, "utf8");
}

/** Every string in a JSON value, so an escaped `<!--` reads as the marker it is. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (typeof v === "object" && v !== null) return Object.values(v).flatMap(strings);
  return [];
}

/** `gh api`: reads pass. Writes to merges, labels and reviews, and GraphQL mutations, are refused: the plain gh
 * commands are the checked way. Other writes have their text checked for markers and messages; a pull request created
 * through the API is returned for the create checks. */
function gateApi(args: string[]): ApiCreate | null {
  const [flags, pos] = parseArgs(args, API_VALUE_FLAGS);
  const raw = values(flags, "-f", "--raw-field");
  const typed = values(flags, "-F", "--field");
  const inputs = values(flags, "--input");
  const methods = values(flags, "-X", "--method");
  const method = (methods.length ? methods[methods.length - 1] as string
    : raw.length || typed.length || inputs.length ? "POST" : "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null; // a read: the settings decide whether it may run at all
  const endpoint = (pos[0] ?? "").replace(/^\/+/, "").split("?")[0] as string;
  if ([endpoint, ...raw, ...typed, ...inputs].some((v) => SHELL_EXPANSION.test(v))) {
    block("Write the endpoint, the fields and the --input path as plain text: the PR gate reads the command before " +
      "the shell expands $(...), `...` or $VARIABLES, so it can't check what they'd say.");
  }
  if (/^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(endpoint)) {
    block("Merge with `gh pr merge <n> --match-head-commit <head>`, which the PR gate checks, not through `gh api`.");
  }
  const field = (f: string): [string, string] => {
    const i = f.indexOf("=");
    return i < 0 ? [f, ""] : [f.slice(0, i), f.slice(i + 1)];
  };
  const fields: [string, string][] = [...raw.map(field),
    ...typed.map(field).map(([k, v]): [string, string] => [k, v.startsWith("@") ? fileText(v.slice(1), "-F") : v])];
  if (/(^|\/)labels(\/|$)/.test(endpoint) || fields.some(([k]) => /^labels(\[|$)/.test(k))) {
    block("Change labels with `gh pr edit` or `gh issue edit` (--add-label, --remove-label), which the PR gate checks, " +
      "not through `gh api`.");
  }
  if (/\/reviews(\/|$)/.test(endpoint)) {
    block("Agents don't post pull-request reviews: the dev manager reviews. Ask with a `gh pr comment` holding " +
      "<!-- factory-question --> instead.");
  }
  let text = fields.map(([, v]) => v).join("\n");
  for (const f of inputs) {
    const body = fileText(f, "--input");
    let parsed: string[] = [];
    try {
      parsed = strings(JSON.parse(body) as unknown);
    } catch {
      // not JSON: the raw text is checked
    }
    text += "\n" + body + "\n" + parsed.join("\n");
  }
  if (endpoint === "graphql" && /\bmutation\b/.test(text)) {
    block("Agents don't run GraphQL mutations through `gh api`: the PR gate can't check them. Use the plain gh " +
      "command (gh pr comment, gh pr edit, gh pr merge), which it checks.");
  }
  if (MARKERS.test(text)) block(MARKER_MSG);
  const thread = /^repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/(\d+)\/comments$/.exec(endpoint);
  checkMessages(thread ? (thread[1] as string) : null, text);
  if (method === "POST" && /^repos\/[^/]+\/[^/]+\/pulls$/.test(endpoint)) {
    const last = (k: string): string | undefined => fields.filter(([n]) => n === k).map(([, v]) => v).pop();
    return { draft: last("draft") === "true", body: () => fields.filter(([n]) => n === "body").map(([, v]) => v).join("\n") };
  }
  return null;
}

function checkMarkers(cfg: Config, sub: string, args: string[]): void {
  const [flags] = parseArgs(args);
  if (Object.values(flags).some((vs) => vs.some((v) => SHELL_EXPANSION.test(v)))) {
    block("Write labels and other values as plain text: the PR gate reads the command before the shell expands " +
      "$(...), `...` or $VARIABLES.");
  }
  if (sub === "review" && ("--approve" in flags || "-a" in flags)) block("Agents don't approve pull requests; the dev manager does.");
  const text = bodyText(flags);
  if (MARKERS.test(text)) block(MARKER_MSG);
  const [, pos] = parseArgs(args);
  checkMessages(pos.length && /^\d+$/.test(pos[0] as string) ? (pos[0] as string) : null, text); // `gh pr comment 7`
  const labels = (...n: string[]): Set<string> => new Set(values(flags, ...n).flatMap((v) => v.split(",").map((x) => x.trim())));
  const hold = cfg.holdLabel ?? "factory-hold";
  if (labels("--remove-label").has(hold)) block(`Only the dev manager removes \`${hold}\`.`);
  const added = labels("--add-label", "-l", "--label");
  if ([...REVIEW_LABELS].some((l) => added.has(l))) block("Only the dev manager adds the review labels (tests-reviewed, deps-reviewed).");
}

function readThread(number: string): fm.Message[] {
  const [rc, out, err] = run("gh", "api", "--paginate", `repos/{owner}/{repo}/issues/${number}/comments`);
  if (rc !== 0) block(`I could not read the comments of #${number} to check this message (${err.slice(0, 200)}). Try again in a moment.`);
  return fm.messagesOf(fm.decodePages(out) as fm.CommentLike[]);
}

/** The reserved senders and the state machine for messages in the new envelope (docs/messages.md): an agent posts as
 * itself; approvals and must-fixes stay the dev manager's; only the addressee answers, works on or fails a question,
 * and a transition must be valid. Envelopes of another version, and plain text, pass: nothing reads them. `number` is
 * the thread the command names, if it names one. */
function checkMessages(number: string | null, text: string): void {
  const found = fm.parseEnvelopes(text);
  if (!found.length) return;
  const me = process.env.FACTORY_AGENT || null;
  for (const m of found) {
    let problem = fm.checkNew(m, null, me); // the checks that need no thread
    if (!problem && (m.kind === "answer" || m.kind === "status") && m.inReplyTo) {
      const ref = fm.refNumber(m.ref);
      if (number && ref && ref !== number) {
        block(`This message says ref=${m.ref} but you are commenting on #${number}. Post the reply in the thread ` +
          "of the question, or fix ref=.");
      }
      if (!(number || ref)) {
        block("Say which pull request or issue this reply belongs to: add ref=pr#<n> or ref=issue#<n> to the " +
          "message, or name the number on the command (gh pr comment <n>).");
      }
      problem = fm.checkNew(m, fm.fold(readThread((number || ref) as string)), me);
    }
    if (problem) block(problem + " (Messages: docs/messages.md in the software-factory.)");
  }
}

/** Whether the review marker <reviewMarkers>/<branch><kind> holds exactly `sha`. */
export function passed(cfg: Pick<Config, "reviewMarkers">, branch: string, sha: string, kind = ".ok"): boolean {
  const mark = join(cfg.reviewMarkers, branch.replace(/\//g, "_") + kind);
  if (!isFile(mark)) return false;
  return readFileSync(mark, "utf8").trim() === sha;
}

const ARCH_MSG = "This change touches code with a style guide ({skills}), and the architecture-reviewer hasn't passed " +
  "this commit. Ask the architecture-reviewer subagent, fix every must-fix, then try again.";

function needReviews(cfg: Config, branch: string, head: string, changed: string[]): void {
  if (!passed(cfg, branch, head)) {
    block("No reviewer pass for this commit. Ask the reviewer subagent to review the diff, fix any " +
      "must-fix items, then try again.");
  }
  const styles = styled(changed, cfg);
  if (styles.length && !passed(cfg, branch, head, ".arch.ok")) {
    const skills = [...new Set(styles.flatMap((st) => st.skills ?? []))].sort();
    block(ARCH_MSG.replace("{skills}", skills.join(", ")));
  }
}

/** `commands.ci` on main: the same checks CI runs, passed locally for this exact commit by `factory verify`. */
function needLocalCi(cfg: Config, branch: string, head: string): void {
  if ((cfg.commands ?? {}).ci && !passed(cfg, branch, head, ".ci.ok")) {
    block("CI's checks haven't passed locally for this commit. Run `factory verify` (or " +
      "`bun --no-env-file .claude/hooks/factory_verify.ts`), fix what fails, commit, and try again.");
  }
}

function needTask(cfg: Config, branch: string, body: string): void {
  const tid = branchTask(branch);
  if (tid && taskSource(cfg) === "issues") {
    const L = taskLabels(cfg);
    const n = tid.split(".")[0] as string;
    const [rc, out, err] = run("gh", "api", `repos/{owner}/{repo}/issues/${n}`);
    if (rc !== 0) {
      block(`Branch ${branch} names issue #${n}, which I can't read (${err.slice(0, 200)}). Name the branch ` +
        "task/<issue number>-<short-name>.");
    }
    const issue = row(JSON.parse(out) as unknown);
    const names = new Set((Array.isArray(issue.labels) ? issue.labels : []).map((x) => String(row(x).name)));
    if (issue.state !== "open") block(`Issue #${n} is closed. Pick the next job with ${NEXT}.`);
    const heldBy = [...names].filter((x) => x.startsWith(L.agentPrefix)).map((x) => x.slice(L.agentPrefix.length));
    const me = process.env.FACTORY_AGENT;
    if (me && heldBy.length && !heldBy.includes(me)) {
      block(`Issue #${n} now belongs to ${heldBy.join(", ")} (it was released while you were quiet). Leave it, ` +
        `and pick the next job with ${NEXT}.`);
    }
    if (names.has(L.blocked)) block(`Issue #${n} is blocked (see its comments). Pick the next job with ${NEXT}.`);
    if (!new RegExp(String.raw`\b(closes|fixes|resolves)\s+#${n}\b`, "i").test(body)) {
      block(`Say \`Closes #${n}\` in the pull request body, so merging it closes the issue.`);
    }
  } else if (tid) {
    const main = cfg.mainBranch;
    const plan = run("git", "show", `origin/${main}:${cfg.plan}`)[1];
    const done = new Set(tasks(plan).filter(([, d]) => d).map(([i]) => i));
    const blocked = blockedIds(run("git", "show", `origin/${main}:${cfg.blocked}`)[1]);
    if (done.has(tid)) block(`Task ${tid} is already ticked on ${main}. Run ${NEXT} and build that one.`);
    if (blocked.has(tid)) block(`Task ${tid} is in ${cfg.blocked}. Pick the next task with ${NEXT}.`);
  }
}

function needRoom(cfg: Config): void {
  const [rc, out, err] = run("gh", "pr", "list", "--author", "@me", "--state", "open", "--json", "number,isDraft");
  if (rc !== 0) block(`Could not count your open pull requests (${err.slice(0, 200)}). Try again in a moment.`);
  const list = JSON.parse(out || "[]") as unknown;
  const ready = (Array.isArray(list) ? list : []).map(row).filter((p) => !p.isDraft).map((p) => Number(p.number));
  const cap = Math.trunc(Number(cfg.maxOpenPRs));
  if (ready.length >= cap) {
    block(`${ready.length} of your pull requests are open (limit ${cfg.maxOpenPRs}): ` +
      [...ready].sort((a, b) => a - b).map((n) => `#${n}`).join(", ") + ". Wait for the oldest with " +
      `\`.claude/hooks/wait_for_merge.sh ${Math.min(...ready)}\`, or answer what's blocking it, before opening another.`);
  }
}

function needFreeNumbers(cfg: Config, branch: string, added: Added[] | null = null): void {
  let found: string[] = [];
  try {
    found = clashes(cfg, branch, added);
  } catch (e) {
    if (!(e instanceof NumbersError)) throw e;
    block(`Could not check the decision and migration numbers (${e.message}). Run \`git fetch origin\` and try again.`);
  }
  if (found.length) {
    block("A new numbered file takes a number that's already used:\n- " + found.join("\n- ") +
      "\nRename it on this branch, commit, push, then open the pull request again.");
  }
}

function gateCreate(cfg: Config, draft: boolean, body: () => string): void {
  if (draft) return; // drafts are how agents ask questions; they can't be merged, and ready and merge stay gated
  const branch = run("git", "branch", "--show-current")[1];
  const head = run("git", "rev-parse", "HEAD")[1];
  const [rc, out, err] = run("git", "diff", "--name-only", `origin/${cfg.mainBranch}...HEAD`);
  if (rc !== 0) {
    block(`Could not list this branch's changes against origin/${cfg.mainBranch} (${err.slice(0, 200)}). ` +
      "Run `git fetch origin` and try again.");
  }
  const changed = out.split(/\s+/).filter((x) => x);
  needReviews(cfg, branch, head, changed);
  needLocalCi(cfg, branch, head);
  needTask(cfg, branch, body());
  needFreeNumbers(cfg, branch);
  needRoom(cfg);
}

function prRef(pos: string[]): string[] {
  if (!pos.length) return [];
  const ref = pos[0] as string;
  if (!/^\d+$/.test(ref)) { // a URL could name another repository, which the gate doesn't check
    block(`Name the pull request by its number (got \`${ref}\`), so the gate checks the one you mean.`);
  }
  return [ref];
}

function view(ref: string[], fields: string): Row {
  const [rc, out, err] = run("gh", "pr", "view", ...ref, "--json", fields);
  if (rc !== 0) block("Could not read the pull request: " + (err || out).slice(0, 300));
  return row(JSON.parse(out) as unknown);
}

function prFiles(number: unknown): string[] {
  const [rc, out, err] = run("gh", "api", "--paginate", `repos/{owner}/{repo}/pulls/${String(number)}/files`, "--jq", ".[].filename");
  if (rc !== 0) block("Could not list the pull request's files: " + err.slice(0, 300));
  return out.split("\n").filter((x) => x);
}

function gateReady(cfg: Config, args: string[]): void {
  const [, pos] = parseArgs(args);
  const pr = view(prRef(pos), "number,headRefName,headRefOid,body");
  const branch = String(pr.headRefName);
  const head = String(pr.headRefOid);
  needReviews(cfg, branch, head, prFiles(pr.number));
  needLocalCi(cfg, branch, head);
  needTask(cfg, branch, typeof pr.body === "string" ? pr.body : "");
  let added: Added[] = [];
  try {
    added = prAdded(pr.number as number);
  } catch (e) {
    if (!(e instanceof NumbersError)) throw e;
    block(`Could not check the decision and migration numbers (${e.message}). Try again in a moment.`);
  }
  needFreeNumbers(cfg, branch, added);
  needRoom(cfg);
}

function gateMerge(cfg: Config, args: string[]): void {
  const [flags, pos] = parseArgs(args, MERGE_VALUE_FLAGS);
  if ("--admin" in flags) {
    block("Merge without --admin: it skips branch protection and the required checks, which are what really guard " +
      "main. If the merge is blocked, leave the pull request open for the dev manager or a person.");
  }
  const pr = view(prRef(pos), "number,headRefName,headRefOid,comments,labels");
  const head = String(pr.headRefOid);
  const hold = cfg.holdLabel ?? "factory-hold";
  if ((Array.isArray(pr.labels) ? pr.labels : []).some((label) => row(label).name === hold)) {
    block(`The dev manager is reviewing this pull request (label \`${hold}\`). Leave it open and continue with the ` +
      "next task: the dev manager approves and merges it, or posts must-fixes, and removes the label.");
  }
  const trusted = new Set(Array.isArray(cfg.trustedReviewers) ? (cfg.trustedReviewers as unknown[]).map(String) : []);
  let last: string | null = null; // a must-fix holds the merge until an approval of the current head commit comes after it
  for (const c of (Array.isArray(pr.comments) ? pr.comments : []).map(row)) {
    const body = typeof c.body === "string" ? c.body : "";
    const login = String(row(c.author).login ?? "");
    for (const [kind, sha] of fm.verdicts(body)) { // the envelope or the old marker
      if (kind === "mustfix") last = "mustfix";
      else if (!trusted.size || trusted.has(login)) last = sha && head.startsWith(sha) ? "approved" : "stale";
    }
  }
  if (last === "mustfix") {
    block("The dev manager left a must-fix on this pull request (a `<!-- factory-mustfix -->` comment). Fix it, " +
      "push, reply on the PR, and leave the merge to the dev manager, who approves with `<!-- factory-approved -->`.");
  }
  if (last === "stale") block("The dev manager's approval is for an older commit. Leave the merge to the dev manager.");
  const pinned = values(flags, "--match-head-commit");
  if (!(pinned.length === 1 && pinned[0] === head)) {
    block(`Add \`--match-head-commit ${head}\` so GitHub merges only the commit this gate checked.`);
  }
  const files = prFiles(pr.number);
  needReviews(cfg, String(pr.headRefName), head, files);
  const [rc] = run("gh", "pr", "checks", String(pr.number));
  if (rc !== 0) {
    const why = notStarted(head);
    if (why) block(ciMessage(why));
    block("CI is not green (or still running) for this pull request. Wait for it or fix it; do not merge.");
  }
  const hits = files.filter((p) => !cfg.alwaysAllowed.includes(p) && cfg.protected.some((rx) => new RegExp(rx).test(p)));
  if (hits.length) {
    block("This pull request changes protected files, so the dev manager or a person merges it: " +
      hits.slice(0, 8).join(", ") + ". Leave it open, say so in the PR description, and continue with the next task.");
  }
}

if (import.meta.main) {
  await runMain(() => {
    try {
      main();
    } catch (e) {
      if (e instanceof Exit) throw e;
      // fail closed: a gate that crashes must not let the command through
      const name = e instanceof Error ? e.name : typeof e;
      const text = e instanceof Error ? e.message : String(e);
      block(`The PR gate hit an error (${name}: ${text}); the command was not run. Fix the cause (for ` +
        "example .claude/factory.json, or gh not installed or signed in) and try again.");
    }
    return 0;
  });
}

