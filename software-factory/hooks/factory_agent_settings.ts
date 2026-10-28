#!/usr/bin/env -S bun --no-env-file --config=/dev/null
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
// The hooks it names run main's code too (#274): `.claude/hooks/` as main has it is unpacked, read-only, into
// `<git folder>/factory-hooks/<content hash>/hooks/`, and each hook line's `"$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>`
// becomes that file's absolute path. An agent that checks out an older gate in its worktree does not run it. When the
// hooks can't be unpacked it refuses like the rest: no session starts.
//
// A project not yet updated to this release has no `.claude/factory/settings.json` on main, only the old
// `.claude/settings.json`, which Claude Code loads from the folder: then only the connectors setting is printed. When
// main has neither, or the remote can't be asked, it exits 1 with {code, message, fix} on stderr and the caller starts
// no session: an agent without its rules would run unrestricted.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_agent_settings.ts      prints the value for `--settings`
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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

/** Where a path ends up in a commit once links and submodules are followed: the repository (`dir`) and commit (`rev`)
 * that hold it, its path there, its git mode (100644, 100755, 040000) and object id. */
interface Entry {
  dir: string;
  rev: string;
  path: string;
  mode: string;
  sha: string;
}

/** A path as the commit `rev` of the repository at `dir` has it, following links the way the checkout would (#258):
 * a link into the same repository is read from the same commit, a path inside a submodule from the submodule at the
 * commit `rev` pins (never its working files). A link that leaves the repository, a loop, or a missing path: null. */
function entryAt(dir: string, rev: string, path: string, hops = 0): Entry | null {
  if (hops > 8) return null;
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const entry = text(gitIn(dir, "ls-tree", rev, "--", prefix).stdout).split("\n")[0] ?? "";
    const m = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(entry);
    if (!m) return null;
    const [, mode, sha] = m as unknown as [string, string, string];
    const rest = parts.slice(i).join("/");
    if (mode === "160000") { // a submodule at its pinned commit
      const sub = `${dir}/${prefix}`;
      return rest ? entryAt(sub, sha, rest, hops + 1) : { dir: sub, rev: sha, path: "", mode: "040000", sha: `${sha}^{tree}` };
    }
    if (mode === "120000") {
      const target = text(gitIn(dir, "cat-file", "blob", sha).stdout);
      if (target.startsWith("/")) return null;
      const next = normal(`${parts.slice(0, i - 1).join("/")}/${target}${rest ? `/${rest}` : ""}`);
      return next === null ? null : entryAt(dir, rev, next, hops + 1);
    }
    if (i === parts.length) return { dir, rev, path: prefix, mode, sha };
  }
  return null;
}

/** A file's bytes as the commit has it, links followed, or null when it is missing or not a file. */
function bytesAt(dir: string, rev: string, path: string): Uint8Array | null {
  const e = entryAt(dir, rev, path);
  if (!e || !e.mode.startsWith("100")) return null;
  const p = gitIn(e.dir, "cat-file", "blob", e.sha);
  return p.code === 0 ? p.stdout : null;
}

/** A file as main has it (FETCH_HEAD), links followed, or null when main has none. */
function onMain(path: string): string | null {
  try {
    const b = bytesAt(".", "FETCH_HEAD", path);
    return b === null ? null : text(b);
  } catch {
    return null;
  }
}

// ---------- main's hooks, unpacked (#274) ----------
// The hook lines in the agents' settings name `"$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>.ts`: the worktree's copy,
// which an agent can swap for an older one from history. So `.claude/hooks/` as main has it is unpacked into the git
// folder (shared by every worktree), read-only, under a name made from its content, and the hook lines name those
// files instead. The hooks import each other by relative path, so the whole folder comes along; `VERSION` beside it,
// when main has one there (the factory's own layout), so a hook's `../VERSION` still reads the release.

export const HOOKS_DIR = ".claude/hooks";
const KEEP_DAYS = 7; // other unpacked copies not used for this long are removed

/** One file of the unpacked folder: its path in it, its bytes and whether it is executable. */
interface Unpacked {
  name: string;
  bytes: Uint8Array;
  exec: boolean;
}

/** main's `.claude/hooks/` files (links and submodules followed), plus `VERSION` beside the folder; null when main
 * has no such folder. Subfolders are left out: the hooks are one flat folder. */
function mainHooks(): Unpacked[] | null {
  const top = entryAt(".", "FETCH_HEAD", HOOKS_DIR);
  if (!top || top.mode !== "040000") return null;
  const listing = gitIn(top.dir, "ls-tree", "-z", top.sha);
  if (listing.code !== 0) return null;
  const files: Unpacked[] = [];
  for (const line of text(listing.stdout).split("\0")) {
    const m = /^(\d+) \w+ [0-9a-f]+\t(.+)$/s.exec(line);
    if (!m || m[1] === "040000") continue;
    const name = m[2] as string;
    const e = entryAt(top.dir, top.rev, top.path ? `${top.path}/${name}` : name);
    if (!e || !e.mode.startsWith("100")) continue; // a link that leads nowhere: the checkout would have nothing there
    const blob = gitIn(e.dir, "cat-file", "blob", e.sha);
    if (blob.code !== 0) return null;
    files.push({ name: `hooks/${name}`, bytes: blob.stdout, exec: e.mode === "100755" });
  }
  const parent = top.path.split("/").slice(0, -1).join("/");
  if (top.path) {
    const version = bytesAt(top.dir, top.rev, parent ? `${parent}/VERSION` : "VERSION");
    if (version !== null) files.push({ name: "VERSION", bytes: version, exec: false });
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A name for these files: the same files always get the same folder, so a second start reuses it. */
function contentKey(files: Unpacked[]): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of files) {
    h.update(`${f.name}\0${f.exec ? 1 : 0}\0${f.bytes.length}\0`);
    h.update(f.bytes);
  }
  return h.digest("hex").slice(0, 32);
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether `dir` holds exactly these files, unchanged and read-only (and its folders too). */
function intact(dir: string, files: Unpacked[]): boolean {
  try {
    const want = new Map(files.map((f) => [f.name, f]));
    const seen: string[] = [];
    for (const sub of ["", "hooks"]) {
      const at = sub ? join(dir, sub) : dir;
      const st = lstatSync(at);
      if (!st.isDirectory() || (st.mode & 0o222) !== 0) return false;
      for (const n of readdirSync(at)) {
        const rel = sub ? `${sub}/${n}` : n;
        if (rel === "hooks") continue;
        const f = want.get(rel);
        const fst = lstatSync(join(dir, rel));
        if (!f || !fst.isFile() || (fst.mode & 0o222) !== 0 || !sameBytes(readFileSync(join(dir, rel)), f.bytes)) return false;
        seen.push(rel);
      }
    }
    return seen.length === files.length;
  } catch {
    return false;
  }
}

/** Remove a folder this script made read-only. */
function removeTree(path: string): void {
  try {
    const st = lstatSync(path);
    if (st.isDirectory()) {
      chmodSync(path, 0o700);
      for (const n of readdirSync(path)) removeTree(join(path, n));
    }
  } catch {
    // gone already, or not ours to open: rmSync says so below
  }
  rmSync(path, { recursive: true, force: true });
}

/** Write the files into a new folder beside `final`, read-only, and move it into place in one step. The folder a
 * running session may still use is replaced only by a rename, and a failure removes what was written. */
function unpackInto(root: string, final: string, files: Unpacked[]): void {
  const temp = mkdtempSync(join(root, ".unpacking-"));
  let old: string | null = null;
  try {
    mkdirSync(join(temp, "hooks"));
    for (const f of files) writeFileSync(join(temp, f.name), f.bytes, { mode: f.exec ? 0o555 : 0o444 });
    for (const f of files) chmodSync(join(temp, f.name), f.exec ? 0o555 : 0o444); // whatever the umask
    chmodSync(join(temp, "hooks"), 0o555);
    chmodSync(temp, 0o555);
    if (existsSync(final)) {
      old = `${temp}.old`;
      renameSync(final, old);
    }
    renameSync(temp, final);
  } catch (e) {
    removeTree(temp);
    if (old !== null && !existsSync(final)) renameSync(old, final);
    throw e;
  }
  if (old !== null) removeTree(old);
}

/** Remove other unpacked copies not used for KEEP_DAYS (a session may run on one for hours, so never sooner). */
function prune(root: string, keep: string): void {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const n of readdirSync(root)) {
    const p = join(root, n);
    try {
      if (p !== keep && lstatSync(p).mtimeMs < cutoff) removeTree(p);
    } catch {
      // another start removed it first
    }
  }
}

/** main's hooks unpacked under the git folder: the folder, or null when main has no hooks folder. Throws when they
 * can't be written. */
export function unpackMainHooks(): string | null {
  const files = mainHooks();
  if (files === null) return null;
  const common = new TextDecoder().decode(git("rev-parse", "--git-common-dir").stdout).trim();
  if (!common) throw new Error("not in a git repository");
  const root = join(realpathSync(common), "factory-hooks");
  mkdirSync(root, { recursive: true });
  const final = join(root, contentKey(files));
  if (intact(final, files)) {
    const now = new Date();
    utimesSync(final, now, now); // in use: keep it from being pruned
  } else unpackInto(root, final, files);
  prune(root, final);
  return final;
}

/** The ways a hook line names a script in the worktree's `.claude/hooks/`. */
const WORKTREE_HOOK = [
  /"\$\{?CLAUDE_PROJECT_DIR\}?\/\.claude\/hooks\/([\w.-]+)"/g, // "$CLAUDE_PROJECT_DIR/.claude/hooks/x.ts"
  /"?\$\{?CLAUDE_PROJECT_DIR\}?"?\/\.claude\/hooks\/([\w.-]+)/g, // "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.ts
];

/** The settings with every hook line pointed at the unpacked folder (`'<folder>/hooks/<name>'`); null when a line
 * still names `.claude/hooks/` some other way, which would run the worktree's copy. */
export function pointHooksAt(settings: JsonObj, folder: string): JsonObj | null {
  const doc = structuredClone(settings);
  const quoted = `'${folder}/hooks/`;
  for (const matchers of Object.values(obj(doc.hooks) ?? {})) {
    for (const m of Array.isArray(matchers) ? matchers : []) {
      for (const h of Array.isArray(obj(m)?.hooks) ? (obj(m)?.hooks as unknown[]) : []) {
        const hook = obj(h);
        if (!hook || typeof hook.command !== "string") continue;
        let c = hook.command;
        for (const rx of WORKTREE_HOOK) c = c.replace(rx, (_, name: string) => `${quoted}${name}'`);
        if (c.includes(".claude/hooks/")) return null;
        hook.command = c;
      }
    }
  }
  return doc;
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
  let folder: string | null;
  try {
    folder = unpackMainHooks();
  } catch (e) {
    return refuse("hooks_not_unpacked", `main's ${HOOKS_DIR} could not be unpacked into the git folder ` +
      `(${e instanceof Error ? e.message : String(e)}), so the agent's hooks would run its own folder's copy. No session was started.`,
      "check that this project's git folder (`git rev-parse --git-common-dir`) is writable and has free space, " +
      "remove its factory-hooks folder if it is damaged (`chmod -R u+w <git folder>/factory-hooks && rm -rf <git folder>/factory-hooks`), then start it again.");
  }
  if (folder === null) {
    return refuse("no_main_hooks", `main has no ${HOOKS_DIR} folder, so the agent's hooks (the PR gate among them) have nothing to run. No session was started.`,
      "run `factory update` and merge its pull request (or, for a project that takes the kit by link, " +
      "`bash vendor/my-skills/software-factory/install.sh . --link` and commit the links), then start it again.");
  }
  if (folder.includes("'")) {
    return refuse("bad_hooks_path", `the git folder's path (${folder}) has a single quote, which a hook line can't name. No session was started.`,
      "move the project to a folder whose path has no single quote, then start it again.");
  }
  const pointed = pointHooksAt(settings, folder);
  if (!pointed) {
    return refuse("unknown_hook_line", `a hook line in ${AGENT_SETTINGS} on main names .claude/hooks/ in a way the factory can't point at main's copy. No session was started.`,
      `write each hook line as the release does (\`"$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>.ts\`; \`factory update\` puts the release's back), then start it again.`);
  }
  const path = resolve(new TextDecoder().decode(git("rev-parse", "--git-path", "factory-settings.json").stdout).trim());
  writeFileSync(path, pyDumps(merged(pointed, mainAllow()), { indent: 2, ensureAscii: false }) + "\n", { mode: 0o600 });
  console.log(path);
  return 0;
}

if (import.meta.main) await runMain(() => main());
