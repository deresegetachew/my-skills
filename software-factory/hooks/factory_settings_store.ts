// Reading and writing the two settings files for `factory settings` (#49).
//
//   project   .claude/factory.json in the repo (committed through a pull request)
//   machine   this machine's own file outside the repo (factory_machine.ts namesFile())
//
// Writes keep the file readable: key order and `_about` entries stay, the file's own indent is kept (2 spaces when it
// has none), a trailing newline ends it, and the write is atomic (a temp file, then a rename).
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { machineSettings, namesFile, writeMachineSettings } from "./factory_machine.ts";
import { die, pyDumps } from "./factory_lib.ts";
import { lookup, MISSING, type Missing, pyEqual, SETTINGS } from "./factory_settings_schema.ts";

export const PATH = join(".claude", "factory.json");

export type Data = Record<string, unknown>;
export type Indent = number | string;

export function fail(message: string): never {
  die(`factory settings: ${message}`);
}

export function detectIndent(text: string): Indent {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const stripped = line.replace(/^[ \t]+/, "");
    if (stripped && stripped !== line && (line.startsWith("\t") || line.startsWith(" "))) {
      const lead = line.slice(0, line.length - stripped.length);
      return lead.startsWith("\t") ? "\t" : lead.length;
    }
  }
  return 2;
}

/** [data, indent]. {} and 2 when there is no file yet. */
export function readProject(path = PATH): [Data, Indent] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [{}, 2];
    throw e;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    fail(`${path} isn't valid JSON (${e instanceof Error ? e.message : String(e)}). Fix it by hand first.`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) fail(`${path} must hold a JSON object.`);
  return [data as Data, detectIndent(text)];
}

export function dump(data: unknown, indent: Indent = 2): string {
  return pyDumps(data, { indent, ensureAscii: false }) + "\n";
}

export function writeAtomic(path: string, text: string): void {
  const folder = dirname(path) || ".";
  mkdirSync(folder, { recursive: true });
  const tmpDir = mkdtempSync(join(folder, ".factory-settings-"));
  const tmp = join(tmpDir, basename(path));
  try {
    const fd = openSync(tmp, "w");
    writeSync(fd, text);
    closeSync(fd);
    let mode = 0o644;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      // a new file
    }
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function writeProject(data: Data, indent: Indent = 2, path = PATH): void {
  writeAtomic(path, dump(data, indent));
}

export function readMachine(): Data {
  return machineSettings();
}

export function machinePath(): string {
  return namesFile();
}

export function writeMachine(data: Data): string {
  return writeMachineSettings(data);
}

function isObject(v: unknown): v is Data {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function assign(data: Data, key: string, value: unknown): void {
  let node = data;
  const parts = key.split(".");
  for (const part of parts.slice(0, -1)) {
    if (!isObject(node[part])) node[part] = {};
    node = node[part] as Data;
  }
  node[parts[parts.length - 1] as string] = value;
}

/** Takes `key` out; a group left empty by it goes too. True when something was removed. */
export function remove(data: Data, key: string): boolean {
  const parts = key.split(".");
  let node: unknown = data;
  for (const part of parts.slice(0, -1)) {
    node = isObject(node) ? node[part] : null;
    if (!isObject(node)) return false;
  }
  const last = parts[parts.length - 1] as string;
  if (!isObject(node) || !(last in node)) return false;
  delete node[last];
  // walk back up, dropping groups the removal emptied (but never `_about`-style keys)
  const nodes: Data[] = [data];
  for (const part of parts.slice(0, -1)) nodes.push((nodes[nodes.length - 1] as Data)[part] as Data);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (Object.keys(nodes[i + 1] as Data).length === 0) delete (nodes[i] as Data)[parts[i] as string];
    else break;
  }
  return true;
}

export type Change = [key: string, old: unknown | Missing, now: unknown | Missing];

/** [key, old value or MISSING, new value or MISSING] between two project dicts, by setting, then other keys. */
export function changes(old: Data, now: Data): Change[] {
  const out: Change[] = [];
  for (const key of Object.keys(SETTINGS)) {
    const a = lookup(old, key);
    const b = lookup(now, key);
    if (a === MISSING && b === MISSING) continue;
    if (a === MISSING || b === MISSING || !pyEqual(a, b)) out.push([key, a, b]);
  }
  const covered = new Set(Object.keys(SETTINGS).map((k) => k.split(".")[0]));
  for (const key of [...Object.keys(old), ...Object.keys(now).filter((k) => !(k in old))]) {
    if (covered.has(key) || key.startsWith("_")) continue;
    const a = key in old ? old[key] : MISSING;
    const b = key in now ? now[key] : MISSING;
    if (a === MISSING || b === MISSING || !pyEqual(a, b)) out.push([key, a, b]);
  }
  return out;
}

// --- a unified diff (Python's difflib.unified_diff with n=3), for the menu's review before saving -----------------

function lcsOps(a: string[], b: string[]): ["=" | "-" | "+", string][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      (dp[i] as number[])[j] = a[i] === b[j] ? ((dp[i + 1] as number[])[j + 1] as number) + 1
        : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
    }
  }
  const ops: ["=" | "-" | "+", string][] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push(["=", a[i] as string]);
      i++;
      j++;
    } else if (j < m && (i >= n || ((dp[i] as number[])[j + 1] as number) >= ((dp[i + 1] as number[])[j] as number))) {
      ops.push(["+", b[j] as string]);
      j++;
    } else {
      ops.push(["-", a[i] as string]);
      i++;
    }
  }
  // difflib lists the removed lines of a change before the added ones
  for (let k = 0; k < ops.length; k++) {
    if ((ops[k] as [string, string])[0] === "=") continue;
    let e = k;
    while (e < ops.length && (ops[e] as [string, string])[0] !== "=") e++;
    const block = ops.slice(k, e);
    ops.splice(k, e - k, ...block.filter((o) => o[0] === "-"), ...block.filter((o) => o[0] === "+"));
    k = e - 1;
  }
  return ops;
}

function range(start: number, length: number): string {
  if (length === 1) return String(start + 1);
  if (length === 0) return `${start},0`;
  return `${start + 1},${length}`;
}

function keepEnds(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function unifiedDiff(oldText: string, newText: string, name: string): string {
  const ops = lcsOps(keepEnds(oldText), keepEnds(newText));
  const changed = ops.map((o, k) => (o[0] !== "=" ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return "";
  const groups: [number, number][] = [];
  for (const k of changed) {
    const last = groups[groups.length - 1];
    if (last && k - last[1] <= 6) last[1] = k;
    else groups.push([k, k]);
  }
  const out = [`--- a/${name}\n`, `+++ b/${name}\n`];
  for (const [first, lastChange] of groups) {
    const from = Math.max(0, first - 3);
    const to = Math.min(ops.length - 1, lastChange + 3);
    let aStart = 0;
    let bStart = 0;
    for (let k = 0; k < from; k++) {
      const op = (ops[k] as [string, string])[0];
      if (op !== "+") aStart++;
      if (op !== "-") bStart++;
    }
    const slice = ops.slice(from, to + 1);
    const aLen = slice.filter((o) => o[0] !== "+").length;
    const bLen = slice.filter((o) => o[0] !== "-").length;
    out.push(`@@ -${range(aStart, aLen)} +${range(bStart, bLen)} @@\n`);
    for (const [op, line] of slice) out.push((op === "=" ? " " : op) + line);
  }
  return out.join("");
}

export function refuseInAgentSession(): void {
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    if (name in process.env) { // set at all, even to an empty string
      die("factory settings: only a person changes the factory's settings, in their own " +
        `terminal (${name} is set, so this looks like an agent session). The PR gate reads ` +
        "these settings, so an agent never changes them.");
    }
  }
}
