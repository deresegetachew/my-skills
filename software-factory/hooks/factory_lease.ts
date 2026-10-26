// The minimal lease the dev-manager orchestrator needs (#97), in the shape issue #99 defines, behind one small module.
//
// A lease is a comment on the item's pull request or issue:
//
//   <!-- factory-review-claim manager=<name> sha=<head> until=<ISO time> -->        a review of one head commit
//   <!-- factory-answer-claim manager=<name> question=<comment id> until=<ISO> -->   an answer to one question
//   <!-- factory-item-claim manager=<name> item=<ref> until=<ISO time> -->           any other item (an agent, an issue)
//
// Protocol (the same as #99): a manager that wants an item and sees no unexpired claim by another manager posts one
// (`until` = now + minutes), re-reads the comments, and the earliest unexpired claim for that key wins (GitHub's comment
// order is the tie-break). The loser does nothing. A new head commit is a different key (the sha differs). A manager that
// dies leaves a claim that expires on its own; `release` ends it early by moving `until` to now.
//
// Identity: every role shares one GitHub account, so the holder is the name inside the comment, never the login.
//
// This module is the whole interface the orchestrator uses: `holder`, `acquire`, `release`. The full claim protocol of
// #99 (factory_manager_claims.ts) keeps these marker formats, so claims made here and there interoperate.
import * as fi from "./factory_issues.ts";
import { isoUtc, parseIso } from "./factory_lib.ts";

export const KINDS: Record<string, string> = { review: "sha", answer: "question", item: "item" };
const CLAIM = /<!--\s*factory-(review|answer|item)-claim\s+manager=([\w.-]+)\s+(sha|question|item)=(\S+)\s+until=(\S+?)\s*-->/;

export interface LeaseClaim {
  kind: string;
  holder: string;
  key: string;
  /** Seconds since the epoch. */
  until: number;
}

export interface Lease {
  target: number | string;
  kind: string;
  key: string;
  holder: string;
  comment: unknown;
  until: number;
}

/** Now, in whole seconds since the epoch. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function iso(t: number): string {
  return isoUtc(t);
}

export function render(kind: string, holder: string, key: string, until: number): string {
  const attr = KINDS[kind];
  if (attr === undefined) throw new Error(`KeyError: '${kind}'`);
  return `<!-- factory-${kind}-claim manager=${holder} ${attr}=${key} until=${iso(until)} -->`;
}

/** The claim in a comment body, else null. */
export function parse(body: string | null | undefined): LeaseClaim | null {
  const m = CLAIM.exec(body || "");
  if (!m || KINDS[m[1] as string] !== m[3]) return null;
  const until = parseIso(m[5]);
  return until !== null ? { kind: m[1] as string, holder: m[2] as string, key: m[4] as string, until } : null;
}

/** A sha may be written short or long; every other key must match exactly. */
export function sameKey(a: string, b: string): boolean {
  if (a === b) return true;
  const sha = /^[0-9a-f]{7,40}$/;
  return sha.test(a) && sha.test(b) && (a.startsWith(b) || b.startsWith(a));
}

/** The unexpired claims for `key`, in comment order: [comment, claim]. */
export function claimsOn(comments: fi.Comment[], kind: string, key: unknown, at: number = now()): [fi.Comment, LeaseClaim][] {
  const out: [fi.Comment, LeaseClaim][] = [];
  for (const c of comments) {
    const claim = parse(c.body);
    if (claim && claim.kind === kind && sameKey(claim.key, String(key)) && claim.until > at) out.push([c, claim]);
  }
  return out;
}

export function commentsOf(target: number | string): fi.Comment[] {
  return fi.ghAll<fi.Comment>(`repos/{owner}/{repo}/issues/${target}/comments`);
}

/** The manager holding the lease on `key` (the earliest unexpired claim), or null. */
export function holder(target: number | string, kind: string, key: unknown, comments: fi.Comment[] | null = null): string | null {
  const found = claimsOn(comments ?? commentsOf(target), kind, key);
  return found.length ? (found[0] as [fi.Comment, LeaseClaim])[1].holder : null;
}

/** Claims `key` on issue or PR `target` for `who`. Returns the lease when `who` holds it, else null. Already holding
 * an unexpired one is fine (the lease is returned as it is). */
export function acquire(target: number | string, kind: string, key: unknown, who: string, minutes: number): Lease | null {
  const k = String(key);
  const existing = claimsOn(commentsOf(target), kind, k);
  if (existing.length) {
    const [c, claim] = existing[0] as [fi.Comment, LeaseClaim];
    return claim.holder === who ? { target, kind, key: k, holder: who, comment: c.id, until: claim.until } : null;
  }
  const until = now() + minutes * 60;
  const posted = fi.gh<fi.Comment | null>("POST", `repos/{owner}/{repo}/issues/${target}/comments`, { body: render(kind, who, k, until) });
  const mine = posted?.id;
  const won = claimsOn(commentsOf(target), kind, k);
  if (!won.length || (won[0] as [fi.Comment, LeaseClaim])[0].id !== mine) {
    if (mine) end(target, mine, kind, who, k); // lost: end our claim at once so it does not outlive the loser's intent
    return null;
  }
  return { target, kind, key: k, holder: who, comment: mine, until };
}

export function end(target: number | string, commentId: unknown, kind: string, who: string, key: string): void {
  fi.gh("PATCH", `repos/{owner}/{repo}/issues/comments/${String(commentId)}`, { body: render(kind, who, key, now() - 1) + "\nreleased" });
}

/** Ends the lease early. Safe to call twice. */
export function release(lease: Lease | null | undefined): void {
  if (lease && lease.comment) end(lease.target, lease.comment, lease.kind, lease.holder, lease.key);
}
