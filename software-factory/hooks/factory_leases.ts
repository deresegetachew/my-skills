// Claims on the message board (#411, #412, #500). With `claim` in `messaging.kinds` (and
// `messaging.transport` board), who holds a review, an answer, an orchestrator's item, a rework or a task is decided by a
// compare-and-set in the board's leases (the project's keys), not by reading the comments back and letting the earliest one
// win: a claim that lost costs no GitHub write, and nobody re-reads a thread to find out who won. The winner writes the
// GitHub marker too (the double send of a kind's first week) while `claim` is in `messaging.githubCopy` (unset: the
// same as messaging.kinds). The board's copy is not the record (6 Nov 2026): with `claim` left out of githubCopy a claim and its
// release are on the board only, and a task claim writes only the labels the board, `factory next` and the PR gate read.
// Without `claim` in the kinds, or when the board can't be had (`board-unreachable`, said once), every claim is the GitHub
// one, exactly as before.
//
// The keys, one per thing that can be held:
//   review.<pr>.<head sha, 7>   answer.<question comment id>   item.<target>.<key>   rework.<pr>   task.<issue>
// A holder is the agent's name, with `@<machine id>` for the agents' claims (rework, task), as the GitHub markers carry
// `machine=`.
import { type Config, load } from "./factory_config.ts";
import { Exit, pyDumps } from "./factory_lib.ts";
import { githubCopies, busFor } from "./core/compose.ts";
import type { CoreError } from "./core/domain/error.ts";
import type { Leases } from "./core/ports/messaging.ts";
import { notice } from "./factory_wake.ts";

/** the board's claims, or null while `claim` hasn't moved (or the board can't be had and messaging.fallback is github). With
 * fallback "none" and the board out of reach, the command stops with {code, message, fix}. */
export function leasesOn(cfg: Config | null = null): Leases | null {
  let config: Config;
  try {
    config = cfg ?? load();
  } catch {
    return null;
  }
  try {
    return busFor(config, "claim", notice);
  } catch (e) {
    const x = e as CoreError;
    process.stderr.write(pyDumps({ code: x.code, message: x.message, fix: x.fix }) + "\n");
    throw new Exit(1);
  }
}

/** Whether a claim taken on the board (and its release) is also written to GitHub as a marker or comment:
 * `claim` in messaging.githubCopy. Only asked once leasesOn gave the board's claims. */
export function claimCopy(cfg: Config | null = null): boolean {
  try {
    return githubCopies(cfg ?? load(), "claim");
  } catch {
    return true;
  }
}

/** A claim key from its parts: anything the bucket can't hold becomes `_`. */
export function claimKey(...parts: (string | number)[]): string {
  return parts.map((p) => String(p).replace(/[^-_=a-zA-Z0-9/]/g, "_")).join(".");
}

/** A head commit as a claim key part: its first 7 characters, so a short and a long sha agree. */
export function shaKey(sha: string): string {
  return sha.slice(0, 7);
}

/** An agent's claim holder: `<agent>@<machine>`, or the name alone on a machine with no id. */
export function holderName(agent: string, machine: string): string {
  return machine ? `${agent}@${machine}` : agent;
}

/** [agent, machine or null] of a holder. */
export function parseHolder(holder: string): [string, string | null] {
  const at = holder.indexOf("@");
  return at < 0 ? [holder, null] : [holder.slice(0, at), holder.slice(at + 1) || null];
}

/** Whether `holder` is this agent on this machine (a holder without a machine matches by name, as on GitHub). */
export function holderIsMe(holder: string, agent: string, machine: string): boolean {
  const [a, m] = parseHolder(holder);
  return a === agent && !(m && machine && m !== machine);
}

/** "haile (machine 1a2b3c)": who holds a claim, for a line. */
export function describeHolder(holder: string): string {
  const [a, m] = parseHolder(holder);
  return m ? `${a} (machine ${m})` : a;
}
