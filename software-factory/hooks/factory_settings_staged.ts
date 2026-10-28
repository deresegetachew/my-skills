// Staged project settings (#306): changes the owner makes one by one, from the cockpit or `factory settings set
// --stage`, collect here and go out together in one `factory settings pr`.
//
// The staging file sits in the git directory (`<git common dir>/factory/settings-staged.json`), so it is never
// committed, is shared by the repo's worktrees and survives a checkout or a pull. It holds only what was asked for,
// key by key: `{"value": v}` to set, `{"unset": true}` to go back to the default. The pull request is built on the
// main branch as `origin` has it when the person runs `pr`, in a temporary worktree, so the person's own checkout
// (any branch, any state) is never touched, and a main that moved on since the staging is no problem. Each staged
// value is checked again first: a schema that changed since can make one invalid. Machine settings are never staged.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, git as runGit, pyDumps, run } from "./factory_lib.ts";
import { asText, checkValue, SETTINGS, SettingError } from "./factory_settings_schema.ts";
import { branchName, body, CLAUDE_SETTINGS, changesAllow, committed, title, writeAllow } from "./factory_settings_save.ts";
import * as store from "./factory_settings_store.ts";

export const SCHEMA = "factory-settings-staged/1";

export type Staged = Record<string, { value: unknown } | { unset: true }>;

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  return runGit(args);
}

/** Where the staging file lives: the git common directory, so every worktree of the repo sees the same one. */
export function stagingPath(): string {
  const p = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (p.code) {
    fail("settings_not_a_repo", "Staged settings live in the git repository, and this is not one.",
      "Run `factory settings` from the project's folder.");
  }
  return join(p.stdout.trim(), "factory", "settings-staged.json");
}

export function readStaged(): Staged {
  const data = store.readProject(stagingPath())[0];
  const changes = data.changes;
  return changes && typeof changes === "object" && !Array.isArray(changes) ? (changes as Staged) : {};
}

function writeStaged(changes: Staged): void {
  const path = stagingPath();
  if (!Object.keys(changes).length) {
    rmSync(path, { force: true });
    return;
  }
  store.writeAtomic(path, pyDumps({ schema: SCHEMA, changes }, { indent: 2, ensureAscii: false }) + "\n");
}

function count(n: number): string {
  return `${n} change${n === 1 ? "" : "s"} staged`;
}

/** Stage `key` (a project setting) to `value`, or back to its default when `value` is undefined. */
export function stage(key: string, value?: unknown): void {
  store.refuseInAgentSession();
  const changes = readStaged();
  changes[key] = value === undefined ? { unset: true } : { value };
  writeStaged(changes);
  const what = value === undefined ? "back to its default" : `= ${asText(value)}`;
  console.log(`${key} ${what} staged (${count(Object.keys(changes).length)}; ${store.PATH} is not changed). ` +
    "`factory settings pr` opens one pull request with all of them; `factory settings diff --staged` lists them.");
}

export function unstage(key?: string): void {
  store.refuseInAgentSession();
  const changes = readStaged();
  if (key === undefined) {
    writeStaged({});
    console.log(`Dropped ${count(Object.keys(changes).length).replace(" staged", "")}; nothing is staged now.`);
    return;
  }
  if (!(key in changes)) {
    fail("settings_not_staged", `\`${key}\` has no staged change.`, "`factory settings diff --staged` lists what is staged.");
  }
  delete changes[key];
  writeStaged(changes);
  console.log(`Dropped the staged change of ${key} (${count(Object.keys(changes).length)}).`);
}

export function showStaged(): void {
  const changes = readStaged();
  const keys = Object.keys(changes);
  if (!keys.length) {
    console.log("Nothing staged. `factory settings set --stage <key> <value>` stages a change.");
    return;
  }
  for (const key of keys) {
    const c = changes[key] as Staged[string];
    console.log(`${key}: ${"value" in c ? asText(c.value) : "back to its default"}`);
  }
  console.log(`\n${count(keys.length)}. \`factory settings pr\` opens one pull request with them; ` +
    "`factory settings unstage [<key>]` drops one, or all.");
}

/** The staged changes that can't be applied any more: [key, why]. */
export function invalid(changes: Staged): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, c] of Object.entries(changes)) {
    const s = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : undefined;
    if (!s) {
      out.push([key, "is no longer a project setting"]);
      continue;
    }
    if (!("value" in c)) continue;
    try {
      checkValue(s, c.value);
    } catch (e) {
      if (!(e instanceof SettingError)) throw e;
      out.push([key, e.message]);
    }
  }
  return out;
}

function applied(base: store.Data, changes: Staged): store.Data {
  const data = structuredClone(base);
  for (const [key, c] of Object.entries(changes)) {
    if ("value" in c) store.assign(data, key, c.value);
    else store.remove(data, key);
  }
  return data;
}

/** The project file on `ref`: [data, indent], {} and 2 when it has none. */
function fileAt(ref: string): [store.Data, store.Indent] {
  const p = git(["show", `${ref}:${store.PATH}`]);
  if (p.code) return [{}, 2];
  try {
    const data = JSON.parse(p.stdout) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) return [data as store.Data, store.detectIndent(p.stdout)];
  } catch {
    // a broken file on main: the staged changes start from an empty one
  }
  return [{}, 2];
}

/** One pull request with every staged change, built on origin's main branch in a temporary worktree. */
export function openStagedPr(draft: boolean, mainBranch: string): void {
  store.refuseInAgentSession();
  const changes = readStaged();
  const bad = invalid(changes);
  if (bad.length) {
    fail("settings_staged_invalid",
      "Staged changes that are no longer valid, so no pull request was opened: " + bad.map(([k, why]) => `\`${k}\` ${why}`).join("; ") + ".",
      bad.map(([k]) => `factory settings unstage ${k}`).join(" and ") +
        ", then stage a valid value with `factory settings set --stage <key> <value>` and run `factory settings pr` again.");
  }
  const [here] = store.readProject();
  if (store.changes(committed(), here).length) {
    fail("settings_staged_and_edited",
      `There are staged changes and also uncommitted edits of ${store.PATH}; one pull request can't hold both safely.`,
      `Stage those edits with \`factory settings set --stage <key> <value>\` and undo them with \`git checkout -- ${store.PATH}\`, ` +
        "or drop the staged ones with `factory settings unstage`, then run `factory settings pr` again.");
  }
  const fetched = git(["fetch", "-q", "origin", mainBranch]);
  if (fetched.code) {
    fail("settings_fetch_failed", `Can't fetch ${mainBranch} from origin: ${(fetched.stderr || fetched.stdout).trim()}`,
      "Check `git remote -v` and your network, then run `factory settings pr` again. The staged changes are kept.");
  }
  const base = git(["rev-parse", "FETCH_HEAD"]).stdout.trim();
  const [old, indent] = fileAt(base);
  const now = applied(old, changes);
  const diffs = store.changes(old, now);
  if (!diffs.length) {
    fail("settings_staged_already_on_main", `${mainBranch} already has every staged change, so there is nothing to propose.`,
      "Run `factory settings unstage` to clear them.");
  }
  const branch = branchName(diffs);
  const dir = mkdtempSync(join(tmpdir(), "factory-settings-pr-"));
  const tree = join(dir, "tree");
  const home = process.cwd();
  let pushed = false;
  let added = false;
  try {
    const p = git(["worktree", "add", "-q", "-b", branch, tree, base]);
    if (p.code) fail("settings_worktree_failed", `Can't make the branch ${branch}: ${p.stderr.trim()}`, "Fix what git says, then run `factory settings pr` again.");
    added = true;
    process.chdir(tree);
    store.writeProject(now, indent);
    const extra = changesAllow(diffs) ? writeAllow() : [];
    const allowWritten = extra.includes(CLAUDE_SETTINGS);
    const paths = [store.PATH, ...extra];
    const text = body(diffs, allowWritten);
    for (const args of [["add", ...paths], ["commit", "-q", "-m", title(diffs) + "\n\n" + text, "--", ...paths]]) {
      const c = git(args);
      if (c.code) fail("settings_commit_failed", `git ${args[0]} failed: ${(c.stderr || c.stdout).trim()}`, "Fix what git says, then run `factory settings pr` again.");
    }
    const push = git(["push", "-q", "-u", "origin", branch]);
    if (push.code) {
      fail("settings_push_failed", `The push of ${branch} failed: ${push.stderr.trim()}`,
        "Fix the remote (`git remote -v`, `gh auth status`), then run `factory settings pr` again. The staged changes are kept.");
    }
    pushed = true;
    writeStaged({}); // they are on the pushed branch now
    const cmd = ["gh", "pr", "create", "--base", mainBranch, "--head", branch, "--title", title(diffs), "--body", text];
    if (draft) cmd.push("--draft");
    const pr = run(cmd);
    if (pr.code) {
      fail("settings_pr_failed", `The branch ${branch} is pushed, but \`gh pr create\` failed: ${pr.stderr.trim()}`,
        `Open the pull request by hand: gh pr create --base ${mainBranch} --head ${branch}`);
    }
    console.log(pr.stdout.trim() || `Pull request opened from ${branch}.`);
    console.log(`It has ${diffs.length === 1 ? "the staged change" : `all ${diffs.length} staged changes`}, on ${mainBranch} as origin has it now. ` +
      "It is " + (draft ? "a draft; mark it ready when you want it reviewed." : "ready for review."));
    console.log("The owner merges it: it changes `.claude/`, which is protected.");
    if (allowWritten) console.log(`It also writes the allow rules into ${CLAUDE_SETTINGS}, so they apply once it is merged.`);
  } finally {
    process.chdir(home);
    if (added) git(["worktree", "remove", "--force", tree]);
    if (added && !pushed) git(["branch", "-D", branch]); // nothing left behind when nothing went out
    rmSync(dir, { recursive: true, force: true });
  }
}
