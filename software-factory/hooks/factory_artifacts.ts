#!/usr/bin/env -S bun --no-env-file
// `factory artifacts` (#104): the project's artifacts and designs, as reviewed copies in the repo.
//
// Artifacts (a PRD page, a design canvas, a design system) are where they are written. The **repo holds the reviewed copy**,
// and the roles read that: a role's `reads.md` names the copy's path like any other document. This command brings a copy
// into the project and keeps a manifest of where each came from, so anyone can tell which copy is older than its artifact.
//
//   factory artifacts pull <url|id> [dest] [--from DIR] [--title T] [--version V] [--force] [--dry-run]
//         copy the artifact's published files into the project (default dest: <artifacts.dir>/<id>) and record it in the
//         manifest. The files come from `artifacts.fetch` (a command, below), or from DIR, an export made by hand.
//   factory artifacts status [--json]     per copy: up to date, OLDER than its artifact, edited locally, missing, or can't tell
//   factory artifacts list                the manifest
//
// Two settings tell the factory how to reach an artifact; both are commands, empty by default, because how a terminal session
// may read an artifact is not settled (see "Spike" in docs/wiki/roles.md):
//   artifacts.fetch   writes the artifact `{url}` into the folder `{out}`; exit 0 when it did
//   artifacts.info    prints JSON {"title": ..., "updated": ..., "version": ...} for `{url}`; used by `status` and `doctor`
// With neither, `pull --from DIR` imports an export, and `status` says it can't tell.
//
// The manifest (`artifacts.manifest`, default docs/artifacts.json) is committed with the copies:
//   {"version": 1, "artifacts": [{"id", "url", "title", "dest", "updated", "version", "pulledAt", "pulledBy", "files"}]}
// `files` maps each file to its sha256, so a copy someone edited by hand is noticed and `pull` will not overwrite it without
// --force. Errors are {code, message, fix} JSON on stderr, exit 1.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Config, DEFAULTS as CONFIG_DEFAULTS, load } from "./factory_config.ts";
import { now as clockNow } from "./factory_clock.ts";
import { refuse } from "./factory_machine.ts";
import { Exit, isoUtc, pyDumps, run, runMain, shQuote } from "./factory_lib.ts";

const URL_ID = /^(?:https?:\/\/)?(?:www\.)?claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9][\w-]{2,80})\/?(?:[?#].*)?$/;
const BARE_ID = /^[A-Za-z0-9][\w-]{2,80}$/;
export const DEFAULTS = CONFIG_DEFAULTS.artifacts;

/** One copy in the manifest. */
export interface Entry {
  id: string;
  url: string;
  title: string;
  dest: string;
  updated?: string;
  version?: string;
  pulledAt: string;
  pulledBy: string;
  files?: Record<string, string>;
  [key: string]: unknown;
}

export interface Manifest {
  version?: number;
  artifacts: Entry[];
  [key: string]: unknown;
}

export interface Meta {
  title?: unknown;
  updated?: unknown;
  version?: unknown;
  [key: string]: unknown;
}

export function setting(cfg: Config, key: string): string {
  const mine = (cfg.artifacts ?? {}) as Record<string, unknown>;
  return String(mine[key] || (DEFAULTS as Record<string, unknown>)[key]);
}

/** Python's str() of a JSON value (as an f-string or str() would show it). */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return typeof v === "object" ? pyDumps(v) : String(v);
}

/** Python truthiness for a JSON value. */
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/** [id, url] from an artifact link or a bare id. */
export function identify(text: string): [string, string] {
  const t = (text || "").trim();
  const m = URL_ID.exec(t);
  if (m) return [m[1] as string, (t.split("#")[0] as string).split("?")[0]!.replace(/\/+$/, "")];
  if (BARE_ID.test(t)) return [t, `https://claude.ai/artifact/${t}`];
  return refuse("not-an-artifact", `'${text}' is not an artifact link or id.`, "Pass the link (https://claude.ai/artifact/<id>) or the id.");
}

function realpathLoose(p: string): string {
  // os.path.realpath: resolve what exists, keep the rest as written.
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      tail.push(head.slice(parent.length).replace(/^\/+/, ""));
      head = parent;
    }
  }
}

/** The path under the project, else refuse: a copy never lands outside the repo. */
export function inside(path: string): string {
  const root = realpathLoose(process.cwd());
  const full = realpathLoose(join(root, path));
  if (isAbsolute(path) || full === root || !full.startsWith(root + sep)) {
    refuse("outside-project", `'${path}' is not a folder inside the project.`, "Pick a relative folder such as docs/artifacts/prd.");
  }
  return full;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readManifest(cfg: Config): Manifest {
  const path = setting(cfg, "manifest");
  if (!isFile(path)) return { version: 1, artifacts: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as Manifest).artifacts)) return data as Manifest;
  } catch {
    // not JSON: refused below
  }
  return refuse("bad-manifest", `${path} is not a valid artifacts manifest.`, "Fix the JSON, or delete it and pull the copies again.");
}

export function writeManifest(cfg: Config, data: Manifest): void {
  const path = setting(cfg, "manifest");
  mkdirSync(dirname(path) || ".", { recursive: true });
  data.artifacts = [...data.artifacts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeFileSync(path, pyDumps(data, { indent: 2, sortKeys: true }) + "\n");
}

/** {relative file: sha256} for every file under folder. */
export function digest(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() || e.isSymbolicLink()) {
        if (e.isSymbolicLink() && isDir(full)) continue; // os.walk lists a link to a folder as a folder and does not follow it
        out[relative(folder, full).split(sep).join("/")] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  walk(folder);
  return out;
}

/** Runs a configured command with {url} and {out} filled in (quoted). Returns [exit code, stdout, stderr]. */
export function runCommand(template: string, url: string, out = ""): [number, string, string] {
  const cmd = template.replaceAll("{url}", shQuote(url)).replaceAll("{out}", shQuote(out));
  const p = run(["/bin/sh", "-c", cmd], { timeoutMs: 120_000 });
  return [p.code, p.stdout, p.stderr.trim()];
}

/** {"title", "updated", "version"} from `artifacts.info`, or null when it isn't set or doesn't answer. */
export function info(cfg: Config, url: string): Meta | null {
  const cmd = setting(cfg, "info");
  if (!cmd) return null;
  let data: unknown = null;
  try {
    const [rc, out] = runCommand(cmd, url);
    data = rc === 0 ? (JSON.parse(out) as unknown) : null;
  } catch {
    return null;
  }
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Meta) : null;
}

function who(): string {
  return process.env.FACTORY_AGENT || process.env.USER || "unknown";
}

function nowIso(): string {
  return isoUtc(clockNow());
}

/** The files under the copy that differ from what was pulled (changed, added or removed). */
export function localEdits(entry: Entry): string[] | null {
  if (!isDir(entry.dest)) return null;
  const have = digest(entry.dest);
  const was = entry.files || {};
  return [...new Set([...Object.keys(have), ...Object.keys(was)])].filter((f) => have[f] !== was[f]).sort();
}

interface PullArgs {
  artifact: string;
  dest?: string;
  from?: string;
  title?: string;
  version?: string;
  updated?: string;
  force: boolean;
  dryRun: boolean;
}

export function pull(cfg: Config, a: PullArgs): void {
  const [aid, url] = identify(a.artifact);
  const dest = a.dest || `${setting(cfg, "dir")}/${aid}`;
  const full = inside(dest);
  const manifest = readManifest(cfg);
  const entry = manifest.artifacts.find((e) => e.id === aid) ?? null;
  if (entry && entry.dest !== dest) {
    refuse("moved", `${aid} is already in the project at ${entry.dest}.`, `Pull it there, or remove its entry from ${setting(cfg, "manifest")} first.`);
  }
  const edits = entry && !a.force ? localEdits(entry) : null;
  if (edits && edits.length) {
    refuse("edited-locally", `The copy at ${dest} was edited since it was pulled (${edits.slice(0, 3).join(", ")}).`,
      "Keep your edits by putting them in the artifact, or pull again with --force to replace the copy.");
  }
  if (!entry && existsSync(full) && readdirSync(full).length && !a.force) {
    refuse("not-empty", `${dest} already has files that are not a pulled copy.`, "Pick an empty folder, or use --force.");
  }
  const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "factory-artifact-"));
  try {
    if (a.from) {
      if (!isDir(a.from)) refuse("no-export", `${a.from} is not a folder.`, "Export the artifact's files into a folder and pass it with --from.");
      cpSync(a.from, tmp, { recursive: true });
    } else if (setting(cfg, "fetch")) {
      const [rc, , err] = runCommand(setting(cfg, "fetch"), url, tmp);
      if (rc !== 0) {
        refuse("fetch-failed", `artifacts.fetch failed for ${url}: ${err.slice(0, 200) || "exit " + rc}.`,
          "Run the command by hand to see why, or export the artifact and use --from <folder>.");
      }
    } else {
      refuse("no-fetcher", "This project has no way to fetch an artifact yet (artifacts.fetch is empty).",
        "Export the artifact's published files into a folder and run: factory artifacts pull " +
        `${url} ${dest} --from <folder>`);
    }
    const files = digest(tmp);
    const n = Object.keys(files).length;
    if (!n) refuse("empty", "The export has no files.", "Check that the artifact was exported, then try again.");
    const meta = info(cfg, url) ?? {};
    const pick = (...xs: unknown[]): unknown => xs.find(truthy) ?? xs[xs.length - 1];
    const row: Entry = {
      id: aid, url,
      title: pyStr(pick(a.title, meta.title, entry?.title, aid)),
      dest,
      updated: truthy(meta.updated) ? (meta.updated as string) : a.updated || "",
      version: truthy(meta.version) ? pyStr(meta.version) : a.version || "",
      pulledAt: nowIso(), pulledBy: who(), files,
    };
    if (a.dryRun) {
      console.log(`would copy ${n} file(s) of ${aid} into ${dest} and record it in ${setting(cfg, "manifest")}`);
      return;
    }
    if (isDir(full)) rmSync(full, { recursive: true, force: true });
    mkdirSync(dirname(full), { recursive: true });
    cpSync(tmp, full, { recursive: true });
    manifest.artifacts = [...manifest.artifacts.filter((e) => e.id !== aid), row];
    writeManifest(cfg, manifest);
    console.log(`pulled ${aid} into ${dest} (${n} file(s)); recorded in ${setting(cfg, "manifest")}. ` +
      "Review it and commit both in a pull request.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** [state, detail] for one copy: missing, edited, older, current or unknown. */
export function judge(cfg: Config, entry: Entry): [string, string] {
  if (!isDir(entry.dest)) return ["missing", `${entry.dest} does not exist: pull it again`];
  const edits = localEdits(entry) ?? [];
  if (edits.length) return ["edited", `edited locally (${edits.slice(0, 3).join(", ")}${edits.length > 3 ? ", ..." : ""})`];
  const meta = info(cfg, entry.url);
  if (!meta || !(truthy(meta.updated) || truthy(meta.version))) {
    return ["unknown", "can't tell whether the artifact changed (artifacts.info is not set or did not answer)"];
  }
  const newer = (truthy(meta.updated) && truthy(entry.updated) && pyStr(meta.updated) > pyStr(entry.updated)) ||
    (truthy(meta.version) && truthy(entry.version) && pyStr(meta.version) !== pyStr(entry.version));
  if (newer) {
    return ["older", `OLDER than the artifact (pulled ${entry.pulledAt}, artifact updated ${pyStr(truthy(meta.updated) ? meta.updated : meta.version)})`];
  }
  return ["current", "up to date"];
}

function ljust(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function status(cfg: Config, json: boolean): void {
  const rows = readManifest(cfg).artifacts.map((entry) => ({ entry, state: judge(cfg, entry) }));
  if (json) {
    console.log(pyDumps(rows.map((r) => ({ id: r.entry.id, dest: r.entry.dest, state: r.state[0], detail: r.state[1] })), { indent: 2 }));
  } else {
    console.log(rows.map((r) => `${ljust(r.entry.id, 28)} ${ljust(r.entry.dest, 36)} ${r.state[1]}`).join("\n") ||
      "no artifacts are pulled into this project");
  }
}

export function listing(cfg: Config): void {
  for (const e of readManifest(cfg).artifacts) {
    console.log(`${ljust(e.id, 28)} ${ljust(e.dest, 36)} ${e.title}  (pulled ${e.pulledAt} by ${e.pulledBy})`);
  }
}

const USAGE = "usage: factory artifacts [-h] {pull,status,list} ...";
const PULL_USAGE = "usage: factory artifacts pull [-h] [--from FROM_DIR] [--title TITLE]\n" +
  "                              [--version VERSION] [--updated UPDATED]\n" +
  "                              [--force] [--dry-run]\n" +
  "                              artifact [dest]";
const STATUS_USAGE = "usage: factory artifacts status [-h] [--json]";
const LIST_USAGE = "usage: factory artifacts list [-h]";
const HELP = USAGE + "\n\n`factory artifacts` (#104): the project's artifacts and designs, as reviewed\ncopies in the repo.\n\n" +
  "positional arguments:\n  {pull,status,list}\n\noptions:\n  -h, --help          show this help message and exit";
const PULL_HELP = PULL_USAGE + "\n\npositional arguments:\n  artifact\n  dest\n\noptions:\n" +
  "  -h, --help         show this help message and exit\n  --from FROM_DIR\n  --title TITLE\n  --version VERSION\n" +
  "  --updated UPDATED\n  --force\n  --dry-run";
const STATUS_HELP = STATUS_USAGE + "\n\noptions:\n  -h, --help  show this help message and exit\n  --json";
const LIST_HELP = LIST_USAGE + "\n\noptions:\n  -h, --help  show this help message and exit";

function argError(usage: string, prog: string, text: string): never {
  process.stderr.write(`${usage}\n${prog}: error: ${text}\n`);
  throw new Exit(2);
}

function help(text: string): never {
  console.log(text);
  throw new Exit(0);
}

/** argparse's subcommands, by hand: the same usage, help and errors (exit 2). */
export function parse(argv: string[]): { cmd: string; pull?: PullArgs; json: boolean } {
  const top = "factory artifacts";
  let i = 0;
  while (i < argv.length && argv[i]!.startsWith("-") && argv[i] !== "-") {
    if (argv[i] === "-h" || argv[i] === "--help") help(HELP);
    argError(USAGE, top, `the following arguments are required: cmd`);
  }
  const cmd = argv[i];
  if (cmd === undefined) argError(USAGE, top, "the following arguments are required: cmd");
  if (!["pull", "status", "list"].includes(cmd)) {
    argError(USAGE, top, `argument cmd: invalid choice: '${cmd}' (choose from 'pull', 'status', 'list')`);
  }
  const rest = argv.slice(i + 1);
  const extra: string[] = [];
  if (cmd === "pull") {
    const prog = `${top} pull`;
    const valued: Record<string, "from" | "title" | "version" | "updated"> =
      { "--from": "from", "--title": "title", "--version": "version", "--updated": "updated" };
    const a: PullArgs = { artifact: "", force: false, dryRun: false };
    const pos: string[] = [];
    for (let j = 0; j < rest.length; j++) {
      const x = rest[j] as string;
      const eq = x.startsWith("--") ? x.indexOf("=") : -1;
      const key = eq > 0 ? x.slice(0, eq) : x;
      if (x === "-h" || x === "--help") help(PULL_HELP);
      if (key in valued) {
        const v = eq > 0 ? x.slice(eq + 1) : rest[++j];
        if (v === undefined || (eq < 0 && v.startsWith("-") && v !== "-")) argError(PULL_USAGE, prog, `argument ${key}: expected one argument`);
        a[valued[key] as "from"] = v;
      } else if (x === "--force") a.force = true;
      else if (x === "--dry-run") a.dryRun = true;
      else if (x.startsWith("-") && x !== "-" && !x.includes(" ")) extra.push(x); // argparse: a word with a space is a value
      else if (pos.length < 2) pos.push(x);
      else extra.push(x);
    }
    if (!pos.length) argError(PULL_USAGE, prog, "the following arguments are required: artifact");
    if (extra.length) argError(USAGE, top, `unrecognized arguments: ${extra.join(" ")}`);
    a.artifact = pos[0] as string;
    a.dest = pos[1];
    return { cmd, pull: a, json: false };
  }
  let json = false;
  for (const x of rest) {
    if (x === "-h" || x === "--help") help(cmd === "status" ? STATUS_HELP : LIST_HELP);
    if (cmd === "status" && x === "--json") json = true;
    else if (cmd === "status" && x.startsWith("--json=")) {
      argError(STATUS_USAGE, `${top} status`, `argument --json: ignored explicit argument '${x.slice(7)}'`);
    } else extra.push(x);
  }
  if (extra.length) argError(USAGE, top, `unrecognized arguments: ${extra.join(" ")}`);
  return { cmd, json };
}

export function main(argv: string[]): void {
  const a = parse(argv);
  const cfg = load();
  if (a.cmd === "pull") pull(cfg, a.pull as PullArgs);
  else if (a.cmd === "status") status(cfg, a.json);
  else listing(cfg);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
