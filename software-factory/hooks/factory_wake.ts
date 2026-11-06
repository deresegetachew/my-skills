#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Wake-ups over NATS (decision 0004 point 8, #410). When `wake` is in `messaging.kinds` (and `messaging.transport` is
// nats), an agent that does something another one waits for says so with a wake-up on factory.<project>.wake.<from>,
// and a loop with nothing to do listens for one instead of asking GitHub every minute. It still looks at GitHub every
// `messaging.pollMinutes` (default 15), for what stays there: CI results, the owner's words, anything a wake-up missed.
// Without `wake` in the kinds, or when NATS can't be reached, everything is as before: `wait` sleeps its time.
//
//   factory_wake.ts send --to <agent|dev-manager|po|coding-agent|all> [--ref pr#N|issue#N] [--why TEXT]
//       as FACTORY_AGENT. Never fails: with wake off it does nothing, and a send NATS refused is a notice on stderr.
//   factory_wake.ts wait --seconds N [--since <epoch seconds>]
//       wait up to N seconds for a wake-up addressed to this agent, its role (dev-manager, po, coding-agent) or all,
//       said since --since (default now) by another agent. Exit 0 woken (one line says by whom and why), 2 none came.
//   factory_wake.ts minutes <M>
//       how long an idle loop waits: M, or messaging.pollMinutes when that is longer and wake-ups come over NATS.
//
// Who wakes whom: the Claude hook (factory_agents.ts hook, PostToolUse) reads each shell command an agent ran, and
// wakesFor() below names the wake-ups it calls for: a pull request opened, marked ready or pushed to wakes the dev
// manager; a question wakes its addressee (`to=`, else the dev manager); an answer wakes the one it is addressed to
// (else every loop); a must-fix, an approval or a merge wakes the coding agents. A comment posted from a file
// (`--body-file`) is read for its markers too. A sub-manager's hand-off (the next step it leaves on a pull request,
// factory_orchestrator.ts) wakes the coding agents. Each of these is still written on GitHub, which stays the record
// (6 Nov 2026, #413): the wake-up only ends the reader's idle wait at once, instead of it polling.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Config, load, roleNames, toFloat } from "./factory_config.ts";
import { Exit, pyDumps, runMain, sleepSync } from "./factory_lib.ts";
import { messagingSettings, natsFor } from "./core/compose.ts";
import type { CoreError } from "./core/domain/error.ts";
import type { Wake, Wakes } from "./core/ports/messaging.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const noticed = new Set<string>();

/** A fallback the command goes on with ({code, message, fix}), on stderr once per process. */
export function notice(e: CoreError): void {
  if (noticed.has(e.code)) return;
  noticed.add(e.code);
  process.stderr.write(pyDumps({ code: e.code, message: e.message, fix: e.fix }) + "\n");
}

/** Whether the settings move wake-ups to NATS (no connection is made to answer). */
export function wakeIsOn(cfg: Config): boolean {
  const s = messagingSettings(cfg);
  return s.transport === "nats" && s.kinds.includes("wake");
}

/** NATS's wake-ups, or null: wake isn't on, or NATS can't be had (then `notice` says so, once). */
export function wakesOn(cfg: Config): Wakes | null {
  try {
    return natsFor(cfg, "wake", notice);
  } catch (e) {
    notice(e as CoreError);
    return null;
  }
}

/** The address a role answers to: dev-manager, po or coding-agent. */
export function roleAddress(cfg: Config, agent: string, role = process.env.FACTORY_ROLE ?? ""): string {
  if (role === "dev-manager" || roleNames(cfg, "dev-manager").includes(agent)) return "dev-manager";
  if (role === "product-owner" || roleNames(cfg, "product-owner").includes(agent)) return "po";
  return "coding-agent";
}

/** The names a waiting agent answers to, itself first. */
export function addresses(cfg: Config, agent: string): string[] {
  return [agent, roleAddress(cfg, agent), "all"];
}

/** Wait up to `seconds` for a wake-up for `agent` said since `since` (ms). The wake, or null when none came. Without
 * NATS (wake off, or it can't be reached) it sleeps the time and gives null. */
export function waitForWake(cfg: Config, agent: string, seconds: number, since: number = Date.now()): Wake | null {
  const started = Date.now();
  const wakes = agent && NAME.test(agent) ? wakesOn(cfg) : null;
  if (wakes) {
    try {
      return wakes.waitWake({ names: addresses(cfg, agent), since, seconds });
    } catch (e) {
      notice(e as CoreError);
    }
  }
  const left = seconds - (Date.now() - started) / 1000;
  if (left > 0) sleepSync(left);
  return null;
}

/** Send one wake-up as `from`; true when NATS took it. Never throws. */
export function wakeUp(cfg: Config, from: string, to: string, ref = "", why = ""): boolean {
  if (!wakeIsOn(cfg) || !NAME.test(from) || !NAME.test(to)) return false;
  const wakes = wakesOn(cfg);
  if (!wakes) return false;
  try {
    wakes.wake({ from, to, ref, why });
    return true;
  } catch (e) {
    notice(e as CoreError);
    return false;
  }
}

/** The wake-ups a shell command an agent ran calls for: [{to, ref, why}], one per addressee. `body` is the text of a
 * comment the command posts from a file (`--body-file`), which the command line itself doesn't show. */
export function wakesFor(command: string, body = ""): Wake[] {
  const out: Wake[] = [];
  const add = (to: string, why: string): void => {
    if (!out.some((w) => w.to === to)) out.push({ from: "", to, ref: refOf(command), why });
  };
  const said = `${command}\n${body}`;
  if (/\bgh\s+pr\s+create\b/.test(command)) add("dev-manager", "opened a pull request");
  if (/\bgh\s+pr\s+ready\b/.test(command)) add("dev-manager", "marked a pull request ready");
  if (/\bgit\s+push\b/.test(command)) add("dev-manager", "pushed");
  if (/factory-question\b|kind=question\b/.test(said)) add(addressee(said, "question") ?? "dev-manager", "asked a question");
  if (/factory-answer(?!-)\b|kind=answer\b/.test(said)) add(addressee(said, "answer") ?? "all", "answered a question");
  if (/factory-mustfix\b|kind=mustfix\b/.test(said)) add("coding-agent", "asked for a fix");
  if (/factory-approved\b|kind=approval\b/.test(said)) add("coding-agent", "approved a pull request");
  if (/\bgh\s+pr\s+merge\b|manager_claims(?:\.ts)?\s+merge\b|\bmanager-claims\s+merge\b/.test(command)) {
    add("coding-agent", "merged a pull request");
  }
  if (/(?:factory_issues(?:\.ts)?|\bfactory\s+issues)\s+(?:release|new)\b/.test(command)) add("coding-agent", "a task is ready");
  return out;
}

/** The `to=` of a factory-msg envelope of `kind` in `text`, or null (an old marker names nobody). */
function addressee(text: string, kind: string): string | null {
  return new RegExp(`kind=${kind}\\b[^>]*?\\bto=([a-z0-9-]+)`).exec(text)?.[1] ?? null;
}

/** The text of the file a `gh ... --body-file F` (or `-F F`) command posts, or "" (none, `-` for stdin, unreadable). */
export function bodyFileOf(command: string, cwd: string = process.cwd()): string {
  const m = /(?:--body-file|\s-F)[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const file = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  if (!file || file === "-") return "";
  try {
    return readFileSync(resolve(cwd, file), "utf8").slice(0, 64 * 1024);
  } catch {
    return "";
  }
}

/** pr#N for `gh pr <verb> N`, else "". */
function refOf(command: string): string {
  const m = /\bgh\s+(pr|issue)\s+[a-z]+\s+#?(\d+)\b/.exec(command);
  return m ? `${m[1]}#${m[2]}` : "";
}

/** For the Claude hook: send, in the background, the wake-ups `command` calls for, as FACTORY_AGENT. Does nothing (and
 * starts nothing) while wake-ups aren't on NATS. */
export function wakeFromHook(cfg: Config, command: string): void {
  const agent = process.env.FACTORY_AGENT ?? "";
  if (!agent || !wakeIsOn(cfg)) return;
  for (const w of wakesFor(command, bodyFileOf(command))) {
    const args = [import.meta.path, "send", "--to", w.to, "--why", w.why, ...(w.ref ? ["--ref", w.ref] : [])];
    spawn(process.execPath, ["--no-env-file", "--config=/dev/null", ...args], { detached: true, stdio: "ignore" }).unref();
  }
}

// --- the command ----------------------------------------------------------------------------------------------------

const USAGE = "usage: factory_wake.ts send --to NAME [--ref REF] [--why TEXT] | wait --seconds N [--since EPOCH] | minutes M";

function option(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(text: string): never {
  process.stderr.write(`${USAGE}\nfactory_wake.ts: ${text}\n`);
  throw new Exit(2);
}

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const cfg = load();
  const agent = process.env.FACTORY_AGENT ?? "";
  if (cmd === "send") {
    const to = option(rest, "--to") ?? usage("send needs --to");
    wakeUp(cfg, agent, to, option(rest, "--ref") ?? "", option(rest, "--why") ?? "");
    return 0;
  }
  if (cmd === "wait") {
    const seconds = toFloat(option(rest, "--seconds") ?? "") ?? usage("wait needs --seconds N");
    const since = toFloat(option(rest, "--since") ?? "");
    const w = waitForWake(cfg, agent, seconds, since === null ? Date.now() : since * 1000);
    if (!w) return 2;
    console.log(`woken by ${w.from}: ${w.why || "something changed"}${w.ref ? ` (${w.ref})` : ""}`);
    return 0;
  }
  if (cmd === "minutes") {
    const m = toFloat(rest[0] ?? "") ?? usage("minutes needs a number");
    const poll = messagingSettings(cfg).pollMinutes;
    console.log(String(m > 0 && poll > m && wakeIsOn(cfg) && wakesOn(cfg) ? poll : m));
    return 0;
  }
  return usage(cmd ? `unknown command ${cmd}` : "a command is needed");
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
