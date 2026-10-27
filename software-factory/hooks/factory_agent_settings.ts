#!/usr/bin/env -S bun --no-env-file
// The settings a coding agent's session starts with (#258): the factory's rules for agents (its deny list, the PR gate
// and the other hooks), passed with `claude --settings <file>` by factory-loop.sh and `factory agent`.
//
// They are not the project's `.claude/settings.json`: Claude Code loads that file in every session in the folder, so
// the agents' rules also governed the owner's own sessions. Claude Code adds the `--settings` file on top of the
// project's and the user's own settings, so a project's own `.claude/settings.json` still applies, and a deny rule in
// either one wins.
//
// The file is the one the main branch has on the remote, never this worktree's copy (as factory_mcp.ts does for
// `.mcp.json`): an agent must not loosen its own next run. It is `.claude/factory/settings.json` with the
// `permissions.allow` entries from main's `.claude/factory.json` added after its own, and the claude.ai connectors off
// (#55). It is written to this worktree's git folder (`.git/factory-settings.json`) and the path is printed.
//
// A project not yet updated to this release has no `.claude/factory/settings.json` on main, only the old
// `.claude/settings.json`, which Claude Code loads from the folder: then only the connectors setting is printed. When
// main has neither, or the remote can't be asked, it exits 1 with {code, message, fix} on stderr and the caller starts
// no session: an agent without its rules would run unrestricted.
//
//   bun --no-env-file .claude/hooks/factory_agent_settings.ts      prints the value for `--settings`
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_SETTINGS, LEGACY_SETTINGS, pyDumps, runMain } from "./factory_lib.ts";
import { mainBranch } from "./factory_mcp.ts";

export const NO_CONNECTORS = '{"disableClaudeAiConnectors": true}';

type JsonObj = Record<string, unknown>;

function git(...args: string[]): { code: number; stdout: Uint8Array } {
  return gitIn(".", ...args);
}

function gitIn(dir: string, ...args: string[]): { code: number; stdout: Uint8Array } {
  try {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    if (p.exitCode === null) return { code: 1, stdout: new Uint8Array() };
    return { code: p.exitCode, stdout: p.stdout };
  } catch {
    return { code: 1, stdout: new Uint8Array() };
  }
}

function obj(v: unknown): JsonObj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as JsonObj : null;
}

const text = (b: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(b);

/** `path` with `.` and `..` folded, or null when it leaves the top of its repository. */
function normal(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** A file as the commit `rev` of the repository at `dir` has it, following links the way the checkout would (#258):
 * a link into the same repository is read from the same commit, a path inside a submodule from the submodule at the
 * commit `rev` pins (never its working files). A link that leaves the repository, a loop, or a missing file: null. */
function readAt(dir: string, rev: string, path: string, hops = 0): string | null {
  if (hops > 8) return null;
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const entry = text(gitIn(dir, "ls-tree", rev, "--", prefix).stdout).split("\n")[0] ?? "";
    const m = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(entry);
    if (!m) return null;
    const [, mode, sha] = m as unknown as [string, string, string];
    const rest = parts.slice(i).join("/");
    if (mode === "160000") return rest ? readAt(`${dir}/${prefix}`, sha, rest, hops + 1) : null; // a submodule at its pinned commit
    if (mode === "120000") {
      const target = text(gitIn(dir, "cat-file", "blob", sha).stdout);
      if (target.startsWith("/")) return null;
      const next = normal(`${parts.slice(0, i - 1).join("/")}/${target}${rest ? `/${rest}` : ""}`);
      return next === null ? null : readAt(dir, rev, next, hops + 1);
    }
    if (i === parts.length) return mode.startsWith("100") ? text(gitIn(dir, "cat-file", "blob", sha).stdout) : null;
  }
  return null;
}

/** A file as main has it (FETCH_HEAD), links followed, or null when main has none. */
function onMain(path: string): string | null {
  try {
    return readAt(".", "FETCH_HEAD", path);
  } catch {
    return null;
  }
}

/** The agents' settings with `extras` added to permissions.allow after the file's own (no repeats), connectors off. */
export function merged(settings: JsonObj, extras: string[]): JsonObj {
  const doc = structuredClone(settings);
  const perms = obj(doc.permissions) ?? (doc.permissions = {}) as JsonObj;
  const allow = (Array.isArray(perms.allow) ? perms.allow : (perms.allow = [])) as unknown[];
  for (const e of extras) if (!allow.includes(e)) allow.push(e);
  doc.disableClaudeAiConnectors = true;
  return doc;
}

/** `permissions.allow` from main's .claude/factory.json: the rule strings only. */
function mainAllow(): string[] {
  const text = onMain(".claude/factory.json");
  if (text === null) return [];
  try {
    const perms = obj(obj(JSON.parse(text))?.permissions);
    const allow = perms?.allow;
    return Array.isArray(allow) ? allow.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim()) : [];
  } catch {
    return [];
  }
}

function refuse(code: string, message: string, fix: string): number {
  process.stderr.write(pyDumps({ code, message, fix }) + "\n");
  return 1;
}

export function main(): number {
  const branch = mainBranch();
  if (!branch || git("fetch", "-q", "origin", `refs/heads/${branch}`).code !== 0) {
    return refuse("no_main", "could not read the main branch from origin, so the agent's rules (its deny list and hooks) are unknown. No session was started.",
      "check that `git fetch origin` works in this folder, then start it again.");
  }
  const text = onMain(AGENT_SETTINGS);
  if (text === null) {
    if (onMain(LEGACY_SETTINGS) !== null) {
      console.log(NO_CONNECTORS); // not updated yet: Claude Code loads the old .claude/settings.json from the folder
      return 0;
    }
    return refuse("no_agent_settings", `main has no ${AGENT_SETTINGS}, so an agent would start without its deny list and hooks. No session was started.`,
      "run `factory update` and merge its pull request (or, for a project that takes the kit by link, " +
      "`bash vendor/my-skills/software-factory/install.sh . --link` and commit the link), then start it again.");
  }
  let settings: JsonObj | null;
  try {
    settings = obj(JSON.parse(text));
  } catch {
    settings = null;
  }
  if (!settings) {
    return refuse("bad_agent_settings", `${AGENT_SETTINGS} on main is not a JSON object. No session was started.`,
      `fix ${AGENT_SETTINGS} on main (\`factory update\` puts the release's back), then start it again.`);
  }
  const path = resolve(new TextDecoder().decode(git("rev-parse", "--git-path", "factory-settings.json").stdout).trim());
  writeFileSync(path, pyDumps(merged(settings, mainAllow()), { indent: 2, ensureAscii: false }) + "\n", { mode: 0o600 });
  console.log(path);
  return 0;
}

if (import.meta.main) await runMain(() => main());
