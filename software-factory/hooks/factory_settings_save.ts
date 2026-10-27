// Proposing a change of .claude/factory.json as a pull request (#49): `factory settings pr`, and the "branch and
// pull request" choice when the interactive menu saves.
//
// `.claude/` is protected, so project settings never go to main by hand. This makes a branch `settings/<short-name>`
// from the main branch, commits .claude/factory.json, pushes it and opens the PR (draft by default) with a body
// that lists each change and the review it needs. The owner merges it (#247). The person's checkout goes back to the
// main branch afterwards.
//
// A change of `permissions.allow` (#251) also writes the merged allow rules into .claude/factory/settings.json, the
// agents' settings, in the same commit (the release's own first, then the project's, as `factory update` does); the
// pin's hash of it follows, so the merged file is not drift. Either way a rule applies on an agent's next run once the
// owner merges this one pull request: the factory adds main's `permissions.allow` when it starts an agent (#258).
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { AGENT_SETTINGS, git as runGit, pyDumps, run } from "./factory_lib.ts";
import { PIN_PATH, projectAllow, sha256Bytes, withAllow } from "./factory_release.ts";
import { asText, DEFAULT_REVIEW, MISSING, NEEDS } from "./factory_settings_schema.ts";
import { type Change, changes, type Data, fail, PATH, readProject, refuseInAgentSession } from "./factory_settings_store.ts";

export const CLAUDE_SETTINGS = AGENT_SETTINGS;

function git(args: string[], check = true): { code: number; stdout: string; stderr: string } {
  const p = runGit(args);
  if (check && p.code) fail(`git ${args.join(" ")} failed: ${(p.stderr || p.stdout).trim()}`);
  return p;
}

/** .claude/factory.json as the current commit has it ({} when it has none). */
export function committed(): Data {
  const p = git(["show", `HEAD:${PATH}`], false);
  if (p.code) return {};
  try {
    const data = JSON.parse(p.stdout) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Data) : {};
  } catch {
    return {};
  }
}

function shown(value: unknown): string {
  return value === MISSING ? "(default)" : asText(value);
}

export function reviewsNeeded(diffs: Change[]): string[] {
  return diffs.filter(([key]) => key in NEEDS).map(([key]) => `\`${key}\`: ${NEEDS[key]}`);
}

export function branchName(diffs: Change[]): string {
  const words = diffs.slice(0, 3).map(([k]) => k).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40).replace(/^-+|-+$/g, "");
  const base = `settings/${words || "update"}`;
  let name = base;
  let n = 1;
  while (git(["rev-parse", "--verify", "-q", name], false).code === 0) {
    n += 1;
    name = `${base}-${n}`;
  }
  return name;
}

export function title(diffs: Change[]): string {
  const keys = diffs.map(([k]) => k);
  return "Factory settings: " + (keys.length <= 3 ? keys.join(", ") : `${keys.slice(0, 3).join(", ")} and ${keys.length - 3} more`);
}

/** Whether this change set touches the project's allow rules (#251). */
export function changesAllow(diffs: Change[]): boolean {
  return diffs.some(([key]) => key === "permissions.allow" || key === "permissions");
}

export function body(diffs: Change[], allowWritten = false): string {
  const lines = [`Changes to \`${PATH}\`, made with \`factory settings\`:`, ""];
  for (const [key, old, now] of diffs) lines.push(`- \`${key}\`: ${shown(old)} -> ${shown(now)}`);
  if (allowWritten) {
    lines.push(`- \`${CLAUDE_SETTINGS}\`: the rules of \`permissions.allow\` added after the release's own, so they apply ` +
      "once this pull request is merged (no `factory update` needed)");
  }
  const needs = reviewsNeeded(diffs);
  lines.push("", "Review needed:");
  lines.push(...(needs.length ? needs.map((n) => `- ${n}`) : ["- no extra label"]));
  lines.push(`- ${DEFAULT_REVIEW}`, "", "The settings are read by the PR gate and the hooks, so this is merged by the " +
    "owner, never by an agent.");
  return lines.join("\n");
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Write the project's allow rules into the agents' settings (after the release's own), and the pin's hash of it.
 * Returns the files written, or [] with a note printed when it cannot (no such file, or it is a link into the
 * shared factory, which this never writes through). Rules removed from the list stay until `factory update`. */
export function writeAllow(): string[] {
  let current: Uint8Array;
  try {
    if (isLink(CLAUDE_SETTINGS)) {
      console.log(`Note: ${CLAUDE_SETTINGS} is a link into the shared factory, so it is not changed here; ` +
        "the factory adds the rules from factory.json when it starts an agent.");
      return [];
    }
    current = readFileSync(CLAUDE_SETTINGS);
  } catch {
    console.log(`Note: there is no ${CLAUDE_SETTINGS} here; \`factory update\` writes it with these rules.`);
    return [];
  }
  const merged = withAllow(current, projectAllow("."));
  if (Buffer.from(merged).equals(Buffer.from(current))) return [];
  writeFileSync(CLAUDE_SETTINGS, merged);
  const written = [CLAUDE_SETTINGS];
  let pin: Data | null = null;
  try {
    pin = JSON.parse(readFileSync(PIN_PATH, "utf8")) as Data;
  } catch {
    pin = null;
  }
  const files = pin && typeof pin.files === "object" && pin.files !== null ? (pin.files as Record<string, unknown>) : null;
  const rel = AGENT_SETTINGS;
  if (pin && files && files[rel] === sha256Bytes(current)) { // the pin held the file as it was: keep it in step
    files[rel] = sha256Bytes(merged);
    writeFileSync(PIN_PATH, pyDumps(pin, { indent: 2, sortKeys: true }) + "\n");
    written.push(PIN_PATH);
  }
  return written;
}

/** Branch, commit, push and open the PR. Prints the PR's URL. Stops with a message that says how to go on. */
export function openPr(draft = true, main: string | null = null): void {
  refuseInAgentSession();
  const [data] = readProject();
  const mainBranch = main || (typeof data.mainBranch === "string" && data.mainBranch) || "main";
  const current = git(["branch", "--show-current"]).stdout.trim();
  if (current !== mainBranch) {
    fail(`you are on \`${current || "a detached HEAD"}\`, not on \`${mainBranch}\`. Run \`git checkout ${mainBranch}\` first, so the pull ` +
      "request carries only this settings change.");
  }
  const diffs = changes(committed(), data);
  if (!diffs.length) fail(`nothing to propose: ${PATH} is the same as in the last commit. Change a setting first.`);
  const branch = branchName(diffs);
  git(["checkout", "-q", "-b", branch]);
  let ok = false;
  try {
    const extra = changesAllow(diffs) ? writeAllow() : [];
    const allowWritten = extra.includes(CLAUDE_SETTINGS);
    const paths = [PATH, ...extra];
    const text = body(diffs, allowWritten);
    git(["add", ...paths]);
    git(["commit", "-q", "-m", title(diffs) + "\n\n" + text, "--", ...paths]);
    let p = git(["push", "-q", "-u", "origin", branch], false);
    if (p.code) {
      fail(`the commit is on branch ${branch}, but the push failed: ${p.stderr.trim()}\n` +
        `Fix the remote, then run: git push -u origin ${branch} && gh pr create --base ${mainBranch} --head ${branch}`);
    }
    const cmd = ["gh", "pr", "create", "--base", mainBranch, "--head", branch, "--title", title(diffs), "--body", text];
    if (draft) cmd.push("--draft");
    p = run(cmd);
    if (p.code) {
      fail(`the branch ${branch} is pushed, but \`gh pr create\` failed: ${p.stderr.trim()}\n` +
        `Open the pull request by hand from ${branch} into ${mainBranch}.`);
    }
    ok = true;
    console.log(p.stdout.trim() || `Pull request opened from ${branch}.`);
    console.log("It is " + (draft ? "a draft; mark it ready when you want it reviewed." : "ready for review."));
    console.log("The owner merges it: it changes `.claude/`, which is protected.");
    if (allowWritten) console.log(`It also writes the allow rules into ${CLAUDE_SETTINGS}, so they apply once it is merged.`);
  } finally {
    git(["checkout", "-q", mainBranch], false); // the person's checkout goes back to main, whatever happened
    if (ok) console.log(`You are back on ${mainBranch}; ${PATH} here is as main has it until the pull request merges.`);
  }
}
