#!/usr/bin/env -S bun --no-env-file
// `factory run-check [--name N] [--lines N] <command>`: run a check or test command quietly (#68).
//
// The full output goes to a log file (`<checkLogDir>/<name>.log`, default tmp/checks), and the agent sees only a
// capped summary: one line when it passes; when it fails, the lines that name a failure first, then the end of the
// output (`checkOutputLines` in all), and the log path to open only if that isn't enough. Exit code: the command's.
// The log folder holds a `.gitignore`, so a log never counts as an untracked file (the Stop check and `factory verify`
// compare those).
//
//   factory run-check pnpm -s test
//   factory run-check --name types -- pnpm -s typecheck
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, load } from "./factory_config.ts";
import { pyInt, runMain, shell, shQuote, splitLines } from "./factory_lib.ts";

/** A line that names a failure: a failed test, an assertion, a compiler error with its file and line. */
export const FAILURE = /(\bFAIL(ED)?\b|✗|×|\bError\b|\berror TS\d+|AssertionError|\bexpected\b|Traceback|:\d+:\d+)/i;

/** At most `limit` lines: the failing ones first (in order), then the end of the output, without repeats. */
export function excerpt(text: string, limit: number): string[] {
  const lines = splitLines(text.trim()).filter((l) => l.trim());
  const failing = lines.flatMap((l, i) => (FAILURE.test(l) ? [i] : [])).slice(0, Math.max(Math.floor(limit / 2), 1));
  const tail: number[] = [];
  for (let i = Math.max(lines.length - (limit - failing.length), 0); i < lines.length; i++) tail.push(i);
  const keep = limit > 0 ? [...new Set([...failing, ...tail])].sort((a, b) => a - b).slice(-limit) : [];
  const out: string[] = [];
  let last: number | null = null;
  for (const i of keep) {
    if (last !== null && i !== last + 1) out.push("...");
    out.push(lines[i] as string);
    last = i;
  }
  return out;
}

/** `checkOutputLines`, at least 1; 40 when it isn't a number (a bad value must never hide a failure). */
export function lineLimit(cfg: Config): number {
  const n = pyInt(cfg.checkOutputLines || 40);
  return n === null ? 40 : Math.max(n, 1);
}

/** Save the full output; returns the path, or "" when it can't be written (the summary still works). */
export function writeLog(cfg: Config, name: string, text: string): string {
  const d = cfg.checkLogDir || "tmp/checks";
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "check";
  const path = join(d, safe + ".log");
  try {
    mkdirSync(d, { recursive: true });
    const gi = join(d, ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*\n");
    writeFileSync(path, text);
    return path;
  } catch {
    return "";
  }
}

/** Run `cmd` in a shell. Returns [exit code, the summary to show]. */
export function run(cmd: string, cfg: Config, name?: string | null, limit?: number | null): [number, string] {
  const max = limit || lineLimit(cfg);
  const r = shell(cmd);
  const text = r.stdout + r.stderr;
  const fallback = Array.from(cmd.replace(/[^\p{L}\p{N}_]+/gu, "-")).slice(0, 40).join("");
  const log = writeLog(cfg, name || fallback, `$ ${cmd}\n${text}`);
  const where = log ? `Full log: ${log}` : "The full log could not be saved.";
  const n = splitLines(text).length;
  if (r.code === 0) return [0, `ok: \`${cmd}\` (${n} lines hidden). ${where}`];
  const head = `\`${cmd}\` fails (exit ${r.code}). First errors, ${max} lines at most. ${where}`;
  return [r.code, head + "\n" + excerpt(text, max).join("\n")];
}

export function main(argv: string[]): number {
  let name: string | null = null;
  let lines: number | null = null;
  let args = [...argv];
  while (args.length > 1 && (args[0] === "--name" || args[0] === "--lines")) {
    if (args[0] === "--name") name = args[1] as string;
    else {
      const n = pyInt(args[1]);
      if (n === null) {
        process.stderr.write("factory run-check: --lines takes a number\n");
        return 2;
      }
      lines = Math.max(n, 1);
    }
    args = args.slice(2);
  }
  if (args[0] === "--") args = args.slice(1);
  if (!args.length) {
    process.stderr.write("usage: factory run-check [--name N] [--lines N] [--] <command>\n");
    return 2;
  }
  const cmd = args.length === 1 ? (args[0] as string) : args.map(shQuote).join(" ");
  const [code, summary] = run(cmd, load(), name, lines);
  (code ? process.stderr : process.stdout).write(summary + "\n");
  return code;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
