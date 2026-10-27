#!/usr/bin/env -S bun --no-env-file
// Numbered files (decisions, migrations): a new one takes a number neither main nor another open PR has.
//
// Agents number decisions and migrations from main when they open a PR, so two PRs opened close together pick the
// same number, and the dev manager renumbered one PR after another. The PR gate now checks this when a PR is
// created or marked ready, and names the next free number.
//
// The folders: `decisions` in .claude/factory.json, plus `numberedDirs` (for example ["apps/api/migrations"]).
// A numbered file's name starts with its number and a dash or underscore: 0042-demo-guides.md, 0009_spare_parts.sql.
//
//   bun --no-env-file .claude/hooks/factory_numbers.ts      what this branch adds, and any clash (exit 1 on a clash)
import { basename, dirname } from "node:path";
import { type Config, load } from "./factory_config.ts";
import { run as runCmd, runMain } from "./factory_lib.ts";

export const NUMBERED = /^(\d{3,6})[-_]/;

/** What Python raised as RuntimeError: GitHub or git could not be read. The PR gate catches it and fails closed. */
export class NumbersError extends Error {}

/** [path, renamed from or null] */
export type Added = [path: string, previous: string | null];

function run(...a: string[]): [number, string, string] {
  const p = runCmd(a);
  return [p.code, p.stdout.trim(), p.stderr.trim()];
}

/** os.path.dirname: "" for a bare name. */
function dir(path: string): string {
  const d = dirname(path);
  return d === "." && !path.startsWith("./") ? "" : d;
}

export function folders(cfg: Config): string[] {
  const dirs = [cfg.decisions || "docs/decisions", ...(cfg.numberedDirs || [])];
  return [...new Set(dirs)].filter((d) => d).map((d) => d.replace(/\/+$/, ""));
}

/** [number, its width in digits], or null when the file name is not numbered. */
export function number(path: string): [number, number] | null {
  const m = NUMBERED.exec(basename(path));
  return m ? [Number(m[1]), (m[1] as string).length] : null;
}

export function inFolder(path: string, folder: string): boolean {
  return dir(path) === folder;
}

/** {number: path} for the numbered files on origin/<main> in `folder`. */
export function onMain(cfg: Config, folder: string): Map<number, string> {
  const [rc, out] = run("git", "ls-tree", "--name-only", `origin/${cfg.mainBranch}:${folder}`);
  const res = new Map<number, string>();
  if (rc !== 0) return res;
  for (const f of out.split("\n")) {
    const n = number(f);
    if (n) res.set(n[0], `${folder}/${f}`);
  }
  return res;
}

/** Main as it is now: a number another PR took and merged while this branch was built must count. */
export function fetchMain(cfg: Config): void {
  const [rc, , err] = run("git", "fetch", "-q", "origin", cfg.mainBranch);
  if (rc !== 0) throw new NumbersError(`could not fetch origin/${cfg.mainBranch}: ${err.slice(0, 200)}`);
}

/** The files this branch adds or renames. */
export function addedHere(cfg: Config): Added[] {
  const [rc, out, err] = run("git", "diff", "--name-status", "-M", "--diff-filter=AR", `origin/${cfg.mainBranch}...HEAD`);
  if (rc !== 0) {
    throw new NumbersError(`could not list this branch's new files against origin/${cfg.mainBranch}: ${err.slice(0, 200)}`);
  }
  const found: Added[] = [];
  for (const line of out ? out.split("\n") : []) {
    const parts = line.split("\t");
    found.push((parts[0] as string).startsWith("R") && parts.length === 3
      ? [parts[2] as string, parts[1] as string]
      : [parts[parts.length - 1] as string, null]);
  }
  return found;
}

/** A rename in the same folder that keeps its number (a new title) takes no new number. */
export function keepsItsNumber(path: string, previous: string | null): boolean {
  if (!previous || dir(previous) !== dir(path)) return false;
  const a = number(previous);
  const b = number(path);
  return a !== null && b !== null && a[0] === b[0];
}

/** {pr number: files it adds or renames} for the open PRs other than this branch's. */
export function openPrsAdded(skipBranch: string): Map<number, Added[]> {
  const [rc, out, err] = run("gh", "api", "--paginate", "repos/{owner}/{repo}/pulls?state=open&per_page=100",
    "--jq", '.[] | "\\(.number)\\t\\(.head.ref)\\t\\(.head.repo.full_name // "")\\t\\(.base.repo.full_name)"');
  if (rc !== 0) throw new NumbersError(`could not list the open pull requests: ${err.slice(0, 200)}`);
  const found = new Map<number, Added[]>();
  for (const line of out ? out.split("\n") : []) {
    const [n, ref, headRepo, baseRepo] = [...line.split("\t"), "", "", ""] as [string, string, string, string];
    if (!n) continue;
    if (ref === skipBranch && (headRepo === "" || headRepo === baseRepo)) {
      continue; // this branch's own PR (a fork's branch with the same name is another PR)
    }
    found.set(Number(n), prAdded(n));
  }
  return found;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Plain sentences, one per clash, each naming the next free number; [] when every new number is free.
 * `mine`: the files added or renamed, or this checkout's branch when null. */
export function clashes(cfg: Config, branch: string, mine: Added[] | null = null): string[] {
  fetchMain(cfg);
  const added = mine === null ? addedHere(cfg) : mine;
  const paths = added.filter(([p, prev]) => !keepsItsNumber(p, prev)).map(([p]) => p);
  const folderList = folders(cfg).filter((f) => paths.some((p) => inFolder(p, f)));
  if (!folderList.length) return [];
  const others = openPrsAdded(branch);
  const out: string[] = [];
  for (const folder of folderList) {
    const taken = new Map<number, string>();
    for (const [n, p] of onMain(cfg, folder)) taken.set(n, `${p} on main`);
    for (const pr of [...others.keys()].sort((a, b) => a - b)) {
      for (const [p] of others.get(pr) ?? []) {
        const n = number(p);
        if (inFolder(p, folder) && n && !taken.has(n[0])) taken.set(n[0], `${p} in #${pr}`);
      }
    }
    const fresh = paths.flatMap((p) => {
      const n = number(p);
      return inFolder(p, folder) && n ? [{ n: n[0], width: n[1], p }] : [];
    }).sort((a, b) => a.n - b.n || a.width - b.width || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
    const used = new Set([...taken.keys(), ...fresh.map((x) => x.n)]);
    let nxt = used.size ? Math.max(...used) + 1 : 1;
    const own = new Map<number, string>();
    for (const { n, width, p } of fresh) {
      const by = taken.get(n) || (own.has(n) ? `${own.get(n)} in this branch` : null);
      if (by) {
        out.push(`${p} uses number ${pad(n, width)}, which ${by} already has. Rename it to ` +
          `${pad(nxt, width)}, with its heading and every link to it.`);
        nxt += 1;
      } else {
        own.set(n, p);
      }
    }
  }
  return out;
}

/** The files a PR adds or renames, from GitHub (for `gh pr ready`, where the checkout may be another branch). */
export function prAdded(numberOfPr: number | string): Added[] {
  const [rc, out, err] = run("gh", "api", "--paginate", `repos/{owner}/{repo}/pulls/${numberOfPr}/files`, "--jq",
    '.[] | select(.status == "added" or .status == "renamed") | "\\(.filename)\\t\\(.previous_filename // "")"');
  if (rc !== 0) throw new NumbersError(`could not list the files of #${numberOfPr}: ${err.slice(0, 200)}`);
  return out.split("\n").filter((l) => l).map((line) => {
    const i = line.indexOf("\t");
    return i < 0 ? [line, null] : [line.slice(0, i), line.slice(i + 1) || null];
  });
}

export function main(): number {
  const cfg = load();
  const branch = run("git", "branch", "--show-current")[1];
  const found = clashes(cfg, branch);
  process.stdout.write((found.length ? found.join("\n") : "Every new decision and migration number is free.") + "\n");
  return found.length ? 1 : 0;
}

if (import.meta.main) await runMain(() => main());
