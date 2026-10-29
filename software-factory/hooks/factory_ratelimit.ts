#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// GitHub's API limit, for the loops (#347). Every agent on the owner's account shares 5,000 calls an hour. A pass whose
// GitHub call met the limit (or a secondary limit, or the network) exits GITHUB_BUSY (4, factory_lib.ts); the loop then
// runs `wait` instead of counting a failed pass, and runs `idle` to know how long an idle wait should be.
//
//   factory_ratelimit.ts wait --attempt N [--name AGENT]
//         the limit is used up: "GitHub limit reached; waiting until HH:MM UTC", and sleeps until the reset;
//         else (a secondary limit, a timeout): "GitHub did not answer; trying again in M min", M = 1, 2, 4, 8, 15, 15 ...
//         for the Nth busy pass in a row. Exit 0.
//   factory_ratelimit.ts idle MINUTES
//         the minutes an idle loop waits: MINUTES, or twice that while fewer than `github.reserve` (500) calls are left
//         this hour (said on stderr). MINUTES when the limit can't be read.
//
// Both read `gh api rate_limit` (which does not count against the limit) through one file in this machine's state folder,
// fresh for a minute, so the loops on a machine make one small read between them. Time comes from factory_clock.ts: with
// FACTORY_NOW set (a test's fake clock) `wait` says what it would wait and does not sleep.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "./factory_clock.ts";
import { type Config, load, toFloat } from "./factory_config.ts";
import { stateDir } from "./factory_machine.ts";
import { die, isoUtc, parseArgs, pyDumps, run, runMain, sleepSync } from "./factory_lib.ts";

export const DEFAULT_RESERVE = 500;
const FRESH_SECONDS = 60;
const MAX_BACKOFF_MINUTES = 15;

export interface Limit {
  limit: number;
  remaining: number;
  reset: number; // seconds since 1970
}

/** `github.reserve` from the project's settings: 500 when unset or not a number, never below 0. */
export function reserve(cfg: Config): number {
  const g = cfg.github;
  const raw = typeof g === "object" && g !== null && !Array.isArray(g) ? (g as Config).reserve : undefined;
  const n = raw === undefined || raw === null ? null : toFloat(raw);
  return n === null ? DEFAULT_RESERVE : Math.max(n, 0);
}

function cacheFile(): string {
  return join(stateDir(), "github-rate.json");
}

function asLimit(v: unknown): Limit | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const [limit, remaining, reset] = [o.limit, o.remaining, o.reset];
  return typeof limit === "number" && typeof remaining === "number" && typeof reset === "number" ? { limit, remaining, reset } : null;
}

function cached(t: number): Limit | null {
  try {
    const e = JSON.parse(readFileSync(cacheFile(), "utf8")) as { at?: unknown; core?: unknown };
    const age = typeof e.at === "number" ? t - e.at : -1;
    return age >= 0 && age < FRESH_SECONDS ? asLimit(e.core) : null;
  } catch {
    return null;
  }
}

function keep(core: Limit, t: number): void {
  const path = cacheFile();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(tmp, pyDumps({ at: t, core }));
    renameSync(tmp, path);
  } catch {
    // the next read asks GitHub again
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The core limit now: from the shared file while it is fresh, else `gh api rate_limit`. Null when it can't be read. */
export function status(): Limit | null {
  const t = now();
  const hit = cached(t);
  if (hit) return hit;
  const p = run(["gh", "api", "rate_limit"], { timeoutMs: 30_000 });
  if (p.code !== 0) return null;
  let core: Limit | null = null;
  try {
    const body = JSON.parse(p.stdout) as { resources?: { core?: unknown } };
    core = asLimit(body.resources?.core);
  } catch {
    return null;
  }
  if (core) keep(core, t);
  return core;
}

/** Minutes to wait before the Nth busy pass in a row tries again: 1, 2, 4, 8, then 15. */
export function backoff(attempt: number): number {
  return Math.min(2 ** Math.max(attempt - 1, 0), MAX_BACKOFF_MINUTES);
}

function hhmm(t: number): string {
  return isoUtc(t).slice(11, 16);
}

/** [the line to print, seconds to wait] after the Nth busy pass in a row. */
export function plan(attempt: number, core: Limit | null, t: number): [string, number] {
  if (core && core.remaining <= 0 && core.reset > t) {
    return [`GitHub limit reached; waiting until ${hhmm(core.reset)} UTC`, Math.ceil(core.reset - t) + 5];
  }
  const m = backoff(attempt);
  return [`GitHub did not answer; trying again in ${m} min`, m * 60];
}

/** The minutes an idle loop waits, and a note when it waits longer because the limit runs low. */
export function idle(cfg: Config, minutes: number, core: Limit | null): [number, string | null] {
  const floor = reserve(cfg);
  if (!core || floor <= 0 || core.remaining >= floor) return [minutes, null];
  return [minutes * 2, `GitHub has ${core.remaining} of ${core.limit} calls left this hour (below github.reserve, ${floor}); ` +
    `waiting ${minutes * 2} min instead of ${minutes}.`];
}

const USAGE = "usage: factory_ratelimit.ts {wait --attempt N [--name AGENT] | idle MINUTES}";

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "wait") {
    const a = parseArgs(rest, { valued: ["--attempt", "--name"] }, "factory_ratelimit.ts wait", USAGE);
    const attempt = Math.max(Math.trunc(toFloat(a.attempt ?? "1") ?? 1), 1);
    const t = now();
    const [line, seconds] = plan(attempt, status(), t);
    console.log((a.name ? `[${a.name}] ` : "") + line);
    if (!(process.env.FACTORY_NOW ?? "").trim()) sleepSync(seconds);
    return 0;
  }
  if (cmd === "idle") {
    const minutes = toFloat(rest[0] ?? "");
    if (minutes === null) die(USAGE);
    const [wait, note] = idle(load(), minutes, status());
    if (note) process.stderr.write(note + "\n");
    console.log(String(wait));
    return 0;
  }
  die(USAGE);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
