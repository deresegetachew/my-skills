#!/usr/bin/env -S bun --no-env-file
// `factory fix`: format and auto-fix the files this branch changed, so agents never spend a turn on style (#69).
//
// Runs `commands.fix` from .claude/factory.json on the changed files only: every file that differs from the merge base
// with main (committed on the branch, edited, or new and not ignored), minus deleted files and, when `fixPaths` is set,
// minus files that match none of its regexes. Unrelated files are never passed to the fixer, so they never churn.
//
// `commands.fix` holds `{files}` where the quoted file list goes (for example
// `prettier --write {files} && eslint --fix {files}`); without `{files}` the list is appended. A long list runs in
// chunks. The agent sees one line ("formatted 3 files", never a diff). When the fixer exits non-zero, the findings it
// could not fix are shown the way a failing check is: the failing lines first, `checkOutputLines` in all, and the log.
//
// The Stop check runs it before typecheck and test, and `factory verify` runs it before `commands.ci`.
//
//   factory fix            exit 0: nothing to do, or formatted; 1: the fixer failed or can't run
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { type Config, load } from "./factory_config.ts";
import { git, runMain, shell, shQuote } from "./factory_lib.ts";
import { excerpt, lineLimit, writeLog } from "./factory_run_check.ts";

/** Files per fixer run, so a big branch never exceeds the shell's argument limit. */
export const CHUNK = 100;

/** The commit the branch started from: the merge base with origin/<main>, else <main>, else HEAD. */
export function base(cfg: Config): string {
  for (const ref of [`origin/${cfg.mainBranch}`, cfg.mainBranch]) {
    const p = git(["merge-base", "HEAD", ref]);
    if (p.code === 0 && p.stdout.trim()) return p.stdout.trim();
  }
  return "HEAD";
}

function isPlainFile(name: string): boolean {
  try {
    return lstatSync(name).isFile();
  } catch {
    return false;
  }
}

/** Files changed on this branch that still exist, sorted, filtered by `fixPaths`. */
export function changedFiles(cfg: Config): string[] {
  const tracked = git(["diff", "--name-only", "--diff-filter=d", "-z", base(cfg), "--"]).stdout;
  const fresh = git(["ls-files", "-z", "--others", "--exclude-standard"]).stdout;
  let names = [...new Set((tracked + fresh).split("\0"))].filter((n) => n && isPlainFile(n));
  const patterns = (cfg.fixPaths || []).map((p) => new RegExp(p));
  if (patterns.length) names = names.filter((n) => patterns.some((p) => p.test(n)));
  return names.sort();
}

function digest(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    try {
      out[n] = createHash("sha256").update(readFileSync(n)).digest("hex");
    } catch {
      out[n] = "";
    }
  }
  return out;
}

export function commandFor(template: string, files: string[]): string {
  const quoted = files.map(shQuote).join(" ");
  return template.includes("{files}") ? template.split("{files}").join(quoted) : `${template} ${quoted}`;
}

/** Run the fixer. Returns [exit code, message]: the code is the fixer's own; the message is one line, or the capped
 * findings when it failed. An empty message means there was nothing to do. */
export function run(cfg: Config): [number, string] {
  const template = ((cfg.commands || {}).fix || "").trim();
  if (!template) return [0, ""];
  const files = changedFiles(cfg);
  if (!files.length) return [0, ""];
  const before = digest(files);
  let text = "";
  let rc = 0;
  let cmd = template;
  for (let i = 0; i < files.length; i += CHUNK) {
    cmd = commandFor(template, files.slice(i, i + CHUNK));
    const p = shell(cmd);
    text += p.stdout + p.stderr;
    if (p.code !== 0) {
      rc = p.code;
      break;
    }
  }
  const after = digest(files);
  const n = files.filter((f) => before[f] !== after[f]).length;
  const done = n ? `formatted ${n} file${n === 1 ? "" : "s"}` : "";
  if (rc === 0) return [0, done];
  const log = writeLog(cfg, "fix", `$ ${cmd}\n${text}`);
  const where = log ? ` Full log: ${log}` : "";
  const head = `\`commands.fix\` fails (exit ${rc}); fix what it names by hand.${where}`;
  return [rc, (done ? done + ". " : "") + head + "\n" + excerpt(text, lineLimit(cfg)).join("\n")];
}

export function main(): number {
  const cfg = load();
  if (!(cfg.commands || {}).fix) {
    process.stdout.write("commands.fix isn't set in .claude/factory.json, so there is nothing to run. Set it to your " +
      "formatter and auto-fixer, for example: prettier --write {files} && eslint --fix {files}\n");
    return 0;
  }
  const [rc, msg] = run(cfg);
  (rc ? process.stderr : process.stdout).write((msg || "nothing to format") + "\n");
  return rc;
}

if (import.meta.main) await runMain(() => main());
