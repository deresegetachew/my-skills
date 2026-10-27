// The factory's own lines in a project's CI workflows (#254). A workflow is the project's file (a template, given once),
// but the steps that call `.claude/hooks/` belong to the factory. A project that came from the Python releases still
// has `python3 .claude/hooks/factory_guard.py` there after the update to Bun removed those scripts, so CI on the update
// pull request fails at once. `factory update` rewrites those lines (and adds the Bun setup step a job then needs), and
// `factory doctor` names any workflow step that calls a hook script that is not there.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const WORKFLOW_DIR = ".github/workflows";
export const SETUP_BUN = "oven-sh/setup-bun@v2";

const OLD_HOOK = /\bpython3?\s+(\.claude\/hooks\/[\w.-]+)\.py\b/g;
// A Bun hook started without --config=/dev/null reads the project's bunfig.toml, whose preload runs first (#259).
const OPEN_BUN = /\bbun --no-env-file (?!--config=\/dev\/null)(\.claude\/hooks\/[\w.-]+\.ts)\b/g;
export const BUN_RUN = "bun --no-env-file --config=/dev/null";
const HOOK_REF = /\.claude\/hooks\/[\w.-]+/g;

/** The project's workflow files, relative to its root, sorted. */
export function workflowFiles(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, WORKFLOW_DIR));
  } catch {
    return [];
  }
  return names.filter((n) => (n.endsWith(".yml") || n.endsWith(".yaml")) && !n.startsWith(".")).sort().map((n) => `${WORKFLOW_DIR}/${n}`);
}

export interface Rewrite {
  text: string;
  /** [old, new] for each command changed, in order (repeats kept). */
  changed: [string, string][];
  /** How many jobs got the Bun setup step. */
  bunSteps: number;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The line ranges [start, end) of each job under `jobs:` (the whole file as one range when there is no `jobs:`). */
function jobRanges(lines: string[]): [number, number][] {
  const top = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (top < 0) return [[0, lines.length]];
  let jobIndent = -1;
  const starts: number[] = [];
  let end = lines.length;
  for (let i = top + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (!l.trim() || l.trimStart().startsWith("#")) continue;
    if (indentOf(l) === 0) {
      end = i;
      break;
    }
    if (jobIndent < 0) jobIndent = indentOf(l);
    if (indentOf(l) === jobIndent) starts.push(i);
  }
  return starts.map((s, k) => [s, starts[k + 1] ?? end]);
}

/** Where the step holding line i starts: the nearest `- ` line at or above it that is not deeper than it. */
function stepStart(lines: string[], i: number, from: number): number {
  const own = indentOf(lines[i] as string);
  for (let j = i; j >= from; j--) {
    const l = lines[j] as string;
    if (/^\s*- /.test(l) && indentOf(l) <= own) return j;
  }
  return i;
}

/** The workflow with each `python3 .claude/hooks/X.py` whose X.py is gone and X.ts exists (`has`) changed to
 * `bun --no-env-file --config=/dev/null .claude/hooks/X.ts`, each `bun --no-env-file .claude/hooks/X.ts` given the
 * --config=/dev/null it lacks (#259), and a Bun setup step added to each job that now runs one and has none. */
export function rewrite(text: string, has: (hook: string) => boolean): Rewrite {
  const lines = text.split("\n");
  const changed: [string, string][] = [];
  const touched: number[] = [];
  lines.forEach((line, i) => {
    const next = line.replace(OLD_HOOK, (all: string, base: string) => {
      if (has(base + ".py") || !has(base + ".ts")) return all;
      const now = `${BUN_RUN} ${base}.ts`;
      changed.push([all, now]);
      return now;
    }).replace(OPEN_BUN, (all: string, script: string) => {
      const now = `${BUN_RUN} ${script}`;
      changed.push([all, now]);
      return now;
    });
    if (next !== line) {
      lines[i] = next;
      touched.push(i);
    }
  });
  const inserts: [number, string][] = [];
  for (const [start, end] of jobRanges(lines)) {
    const first = touched.find((i) => i >= start && i < end);
    if (first === undefined || lines.slice(start, end).some((l) => l.includes("oven-sh/setup-bun"))) continue;
    const at = stepStart(lines, first, start);
    const dash = (lines[at] as string).match(/^\s*/)?.[0] ?? "";
    inserts.push([at, `${dash}- uses: ${SETUP_BUN}  # the factory's scripts run on Bun (#252)`]);
  }
  for (const [at, line] of inserts.sort((a, b) => b[0] - a[0])) lines.splice(at, 0, line);
  return { text: lines.join("\n"), changed, bunSteps: inserts.length };
}

/** What each workflow's rewrite would be, for the files that change. */
export function pending(root: string): Map<string, Rewrite> {
  const has = (hook: string): boolean => existsSync(join(root, hook));
  const out = new Map<string, Rewrite>();
  for (const rel of workflowFiles(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const r = rewrite(text, has);
    if (r.text !== text) out.set(rel, r);
  }
  return out;
}

/** Rewrite the factory's old lines in the project's workflows; returns what was changed, per file. Each file is
 * written whole (a temporary file renamed over it), so a failure leaves it as it was. */
export function fixWorkflows(root: string): Map<string, Rewrite> {
  const found = pending(root);
  for (const [rel, r] of found) {
    const path = join(root, rel);
    const tmp = path + ".factory-tmp";
    writeFileSync(tmp, r.text);
    chmodSync(tmp, statSync(path).mode & 0o7777);
    renameSync(tmp, path);
  }
  return found;
}

/** The lines `factory update` prints for the workflows it changed. */
export function lines(found: Map<string, Rewrite>): string[] {
  const out: string[] = [];
  for (const [rel, r] of found) {
    const kinds = [...new Map(r.changed).entries()];
    out.push(`Changed ${rel}: ${r.changed.length} step(s) now run the factory's hooks on Bun without the project's bunfig.toml` +
      (r.bunSteps ? ` (added \`uses: ${SETUP_BUN}\` to ${r.bunSteps} job(s))` : "") + ":");
    for (const [a, b] of kinds.slice(0, 8)) out.push(`    ${a}  ->  ${b}`);
  }
  return out;
}

/** The `.claude/hooks/` files a workflow's text names. */
export function hookRefs(text: string): string[] {
  return [...new Set([...text.matchAll(HOOK_REF)].map((m) => m[0]))].sort();
}

/** The jobs (their keys) that run `bun ...` and have no Bun setup step. */
export function bunWithoutSetup(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const [start, end] of jobRanges(lines)) {
    const job = lines.slice(start, end);
    if (job.some((l) => l.includes("oven-sh/setup-bun"))) continue;
    if (job.some((l) => /\brun:\s*bun\s/.test(l) || /^\s+bun\s/.test(l))) out.push((lines[start] as string).trim().replace(/:.*$/, ""));
  }
  return out;
}
