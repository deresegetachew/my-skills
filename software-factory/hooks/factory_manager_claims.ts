#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Several dev managers at once (#99): review and question claims with a lease, so two managers never review,
// answer, merge or ask the same thing twice, and a manager that dies mid-review does not block a PR.
//
//   factory_manager_claims.ts list    [--json]                 open PRs and unanswered questions, and who holds each
//   factory_manager_claims.ts review  <pr> --manager NAME      claim a PR's head commit for review (exit 0 won, 3 lost or held, 4 already reviewed)
//   factory_manager_claims.ts answer  <comment id> --manager NAME
//                                                              claim a `factory-question` (same exit codes)
//   factory_manager_claims.ts next    --manager NAME [--max N] [--json]
//                                                              sweep stale holds, then claim every free PR and question
//                                                              (up to N) and print what this manager won
//   factory_manager_claims.ts release <pr|question id> --manager NAME
//                                                              give a claim up (and take the hold off a PR)
//   factory_manager_claims.ts sweep                            take `factory-hold` off PRs whose lease ran out
//   factory_manager_claims.ts merge   <pr> --manager NAME [--method squash|merge|rebase]
//                                                              merge the approved head; "done by someone else" is not an error
//   factory_manager_claims.ts ask     --id SLUG --text TEXT    post an owner-queue ask once (by its id)
//
// The protocol lives in GitHub comments, so any manager on any machine takes part. All managers and builders share one
// GitHub account (owner's decision, 2026-10-25): the manager's name is inside the comment, and `trustedReviewers`
// cannot tell managers apart, so nothing here relies on it.
//
//   <!-- factory-review-claim manager=<name> sha=<head> until=<ISO time> -->
//   <!-- factory-answer-claim manager=<name> question=<comment id> until=<ISO time> -->
//   <!-- factory-claim-release manager=<name> sha=<head> -->            (or question=<comment id>)
//   <!-- factory-owner-ask id=<slug> -->                                 (on the owner-queue issue)
//
// A claim is a lease: `until` is now plus `manager.claimMinutes` (default 20), and never counts for more than
// MAX_LEASE_MINUTES after the comment was posted. The earliest unexpired claim for the same head (or question) wins,
// in the order GitHub lists the comments; a manager that posted a claim re-reads the comments and does nothing if it
// lost. A new head commit makes the sha differ, so the old claim means nothing. A review marker for the head
// (`factory-approved`, `factory-mustfix`, `pr-watch`) ends a review claim; a `factory-answer` after the question ends an
// answer claim. `merge` carries the head sha, so GitHub refuses a second manager's merge.
import { type Config, load } from "./factory_config.ts";
import * as fi from "./factory_issues.ts";
import { Exit, die, isoUtc, parseArgs, parseIso, pyDumps, pyInt, runMain } from "./factory_lib.ts";

export const MAX_LEASE_MINUTES = 120; // a lease never counts for longer than this after its comment, whatever `until` says
export const OWNER_QUEUE_TITLE = "Dev manager: needs the owner";
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const MARKER = /<!--\s*(factory-review-claim|factory-answer-claim|factory-claim-release)\s+([^>]*?)-->/;
const QUESTION = /<!--\s*factory-question\b/;
const ANSWER = /<!--\s*factory-answer(?!-)\b/;
const REVIEWED = /<!--\s*(?:factory-approved|factory-mustfix|pr-watch)\s+sha=([0-9a-f]{7,40})/g;
const APPROVED = /<!--\s*factory-approved\s+sha=([0-9a-f]{7,40})/;
const ASK = /<!--\s*factory-owner-ask\s+id=([A-Za-z0-9._-]+)/;

export const WON = 0;
export const LOST = 3;
export const DONE = 4;

/** A GitHub comment as the REST API gives it. */
export type Comment = fi.Comment;

export interface Claim {
  kind: "review" | "answer" | "release";
  manager: string;
  sha: string | null;
  question: string | null;
  id: unknown;
  created: number | null;
  /** Seconds since the epoch; null for a release. */
  until: number | null;
}

/** A live claim always has its `until`. */
export type Held = Claim & { until: number };

interface Pull {
  number: number;
  title: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  head: { sha: string; ref?: string };
  labels?: { name: string }[];
  [key: string]: unknown;
}

/** Now, in whole seconds since the epoch. */
export function nowUtc(): number {
  return Math.floor(Date.now() / 1000);
}

export function parseTime(text: string | null | undefined): number | null {
  return parseIso(text);
}

export function stamp(t: number): string {
  return isoUtc(t);
}

/** HH:MM UTC of a time. */
export function hhmm(t: number): string {
  return isoUtc(t).slice(11, 16);
}

export function claimMinutes(cfg: Config): number {
  const v = (cfg.manager ?? {}).claimMinutes;
  const n = pyInt(v === undefined ? 20 : v);
  return n === null ? 20 : Math.max(n, 1);
}

export function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b) && ((a as string).startsWith(b as string) || (b as string).startsWith(a as string));
}

// ---------------------------------------------------------------------------------------------------- the comments

/** The claim or release marker in a comment, else null. */
export function parseMarker(comment: Comment): Claim | null {
  const m = MARKER.exec(comment.body || "");
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of (m[2] as string).matchAll(/(\w+)=(\S+)/g)) attrs[a[1] as string] = a[2] as string;
  const kind = ({ "factory-review-claim": "review", "factory-answer-claim": "answer", "factory-claim-release": "release" } as const)[
    m[1] as "factory-review-claim" | "factory-answer-claim" | "factory-claim-release"];
  if (!NAME.test(attrs.manager ?? "")) return null;
  const out: Claim = { kind, manager: attrs.manager as string, sha: attrs.sha ?? null, question: attrs.question ?? null,
    id: comment.id, created: parseTime(comment.created_at), until: null };
  if (kind !== "release") {
    let until = parseTime(attrs.until);
    if (until === null || (kind === "review" && !out.sha) || (kind === "answer" && !out.question)) return null;
    if (out.created !== null) until = Math.min(until, out.created + MAX_LEASE_MINUTES * 60); // a claim posted by something odd cannot hold a PR for days
    out.until = until;
  } else if (!(out.sha || out.question)) {
    return null;
  }
  return out;
}

function subjectOf(c: Claim): string {
  return c.sha ? `sha:${c.sha}` : `question:${String(c.question)}`;
}

/** Unexpired claims, in comment order, with a manager's own release dropping its earlier claims for that subject. */
export function liveClaims(comments: Comment[], now: number): Held[] {
  let claims: Claim[] = [];
  for (const c of comments) {
    const m = parseMarker(c);
    if (!m) continue;
    if (m.kind === "release") {
      claims = claims.filter((x) => !(x.manager === m.manager && subjectOf(x) === subjectOf(m) && x.kind === (m.sha ? "review" : "answer")));
    } else {
      claims.push(m);
    }
  }
  return claims.filter((c): c is Held => (c.until as number) > now);
}

/** The earliest unexpired review claim for exactly this head; GitHub's comment order breaks ties. */
export function reviewWinner(comments: Comment[], head: string, now: number): Held | null {
  return liveClaims(comments, now).find((c) => c.kind === "review" && sameSha(head, c.sha)) ?? null;
}

export function answerWinner(comments: Comment[], questionId: unknown, now: number): Held | null {
  return liveClaims(comments, now).find((c) => c.kind === "answer" && String(c.question) === String(questionId)) ?? null;
}

export function reviewed(comments: Comment[], head: string): boolean {
  return comments.some((c) => [...(c.body || "").matchAll(REVIEWED)].some((m) => sameSha(head, m[1])));
}

export function approved(comments: Comment[], head: string, trusted: Set<string> = new Set()): boolean {
  let ok = false;
  for (const c of comments) {
    const login = c.user?.login ?? "";
    const m = APPROVED.exec(c.body || "");
    if (m && (!trusted.size || trusted.has(login))) ok = sameSha(head, m[1]);
    else if ((c.body || "").includes("<!-- factory-mustfix")) ok = false;
  }
  return ok;
}

/** Questions with no later `factory-answer` (an answer settles every question before it). */
export function openQuestions(comments: Comment[]): Comment[] {
  let asked: Comment[] = [];
  for (const c of comments) {
    const b = c.body || "";
    if (QUESTION.test(b)) asked.push(c);
    else if (ANSWER.test(b)) asked = [];
  }
  return asked;
}

/** True when the hold label is on, some manager claimed this PR before, and no lease is running any more. */
export function staleHold(comments: Comment[], labels: Set<string>, hold: string, now: number): boolean {
  if (!labels.has(hold)) return false;
  const anyClaim = comments.some((c) => parseMarker(c)?.kind === "review");
  return anyClaim && !liveClaims(comments, now).some((c) => c.kind === "review");
}

// ---------------------------------------------------------------------------------------------------- GitHub

function commentsOf(n: number | string): Comment[] {
  return fi.ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`);
}

function post(n: number | string, body: string): Comment {
  return fi.gh<Comment>("POST", `repos/{owner}/{repo}/issues/${n}/comments`, { body });
}

function leaseText(who: string, what: string, until: number): string {
  return `Dev manager ${who} is ${what} until ${hhmm(until)} UTC. This is a lease: it ends when a review marker or an answer is posted, or when the time passes.`;
}

function holdOn(n: number, cfg: Config): void {
  fi.addLabels(n, [cfg.holdLabel ?? "factory-hold"]);
}

function holdOff(n: number, cfg: Config): void {
  fi.removeLabel(n, cfg.holdLabel ?? "factory-hold");
}

function checkName(name: string | undefined): string {
  if (!name || !NAME.test(name)) {
    die("factory manager-claims: give the manager's name with --manager (lowercase letters, digits, dashes), " +
      "for example --manager dm-1.");
  }
  return name;
}

function issueOf(comment: Comment): number {
  return Number(String(comment.issue_url).split("/").pop());
}

export type Outcome = [code: number, line: string];

/** Claim the PR's head for review; the earliest unexpired claim wins. */
export function claimReview(cfg: Config, pr: Pull, who: string, now: number = nowUtc()): Outcome {
  const n = pr.number;
  const head = pr.head.sha;
  const comments = commentsOf(n);
  if (reviewed(comments, head)) return [DONE, `PR #${n}: ${head.slice(0, 7)} already has a review marker`];
  const held = reviewWinner(comments, head, now);
  if (held && held.manager !== who) return [LOST, `PR #${n}: held by ${held.manager} until ${hhmm(held.until)} UTC`];
  if (held && held.manager === who) {
    holdOn(n, cfg); // already mine: make sure the hold is on, no second claim
    return [WON, `PR #${n}: already claimed by ${who} until ${hhmm(held.until)} UTC`];
  }
  const until = now + claimMinutes(cfg) * 60;
  const mine = post(n, `<!-- factory-review-claim manager=${who} sha=${head} until=${stamp(until)} -->\n` +
    leaseText(who, `reviewing ${head.slice(0, 7)}`, until));
  const winner = reviewWinner(commentsOf(n), head, now);
  if (!winner || winner.id !== mine.id) {
    return [LOST, `PR #${n}: lost the claim to ${winner ? winner.manager : "another manager"}; doing nothing`];
  }
  holdOn(n, cfg);
  return [WON, `PR #${n}: claimed ${head.slice(0, 7)} until ${hhmm(until)} UTC; hold on`];
}

export function claimAnswer(cfg: Config, qid: string | number, who: string, now: number = nowUtc()): Outcome {
  const q = fi.gh<Comment | null>("GET", `repos/{owner}/{repo}/issues/comments/${qid}`, undefined, true);
  if (!q || !QUESTION.test(q.body || "")) {
    die(`factory manager-claims: comment ${qid} is not a factory-question. Take the id from \`factory manager-claims list\`.`);
  }
  const n = issueOf(q);
  const comments = commentsOf(n);
  if (!openQuestions(comments).some((c) => String(c.id) === String(qid))) return [DONE, `question ${qid} on #${n}: already answered`];
  const held = answerWinner(comments, qid, now);
  if (held && held.manager !== who) return [LOST, `question ${qid} on #${n}: held by ${held.manager} until ${hhmm(held.until)} UTC`];
  if (held) return [WON, `question ${qid} on #${n}: already claimed by ${who}`];
  const until = now + claimMinutes(cfg) * 60;
  const mine = post(n, `<!-- factory-answer-claim manager=${who} question=${qid} until=${stamp(until)} -->\n` +
    leaseText(who, `answering the question above (comment ${qid})`, until));
  const winner = answerWinner(commentsOf(n), qid, now);
  if (!winner || winner.id !== mine.id) {
    return [LOST, `question ${qid} on #${n}: lost the claim to ${winner ? winner.manager : "another manager"}; doing nothing`];
  }
  return [WON, `question ${qid} on #${n}: claimed until ${hhmm(until)} UTC`];
}

/** Give a claim up: a PR number (hold off, release marker when it is still unreviewed) or a question comment id. */
export function release(cfg: Config, target: string, who: string): Outcome {
  const pr = fi.gh<Pull | null>("GET", `repos/{owner}/{repo}/pulls/${target}`, undefined, true);
  if (pr) {
    const n = pr.number;
    const head = pr.head.sha;
    const held = reviewWinner(commentsOf(n), head, nowUtc());
    if (held && held.manager !== who) return [LOST, `PR #${n}: held by ${held.manager}, not ${who}; hold left on`];
    if (held) post(n, `<!-- factory-claim-release manager=${who} sha=${head} -->\nDev manager ${who} gave up the review of ${head.slice(0, 7)}.`);
    holdOff(n, cfg);
    return [WON, `PR #${n}: hold off` + (held ? ", claim released" : "")];
  }
  const q = fi.gh<Comment | null>("GET", `repos/{owner}/{repo}/issues/comments/${target}`, undefined, true);
  if (!q) die(`factory manager-claims: ${target} is neither an open PR nor a comment. Check the number.`);
  const n = issueOf(q);
  const held = answerWinner(commentsOf(n), target, nowUtc());
  if (held && held.manager === who) {
    post(n, `<!-- factory-claim-release manager=${who} question=${target} -->\nDev manager ${who} gave up the question (comment ${target}).`);
    return [WON, `question ${target} on #${n}: claim released`];
  }
  return [LOST, `question ${target} on #${n}: no claim by ${who} to release`];
}

/** Take `factory-hold` off PRs whose lease ran out (the manager died). Returns the PR numbers. */
export function sweep(cfg: Config, now: number = nowUtc(), pulls: Pull[] | null = null): number[] {
  const hold = cfg.holdLabel ?? "factory-hold";
  const freed: number[] = [];
  for (const p of pulls ?? fi.ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open")) {
    const labels = new Set((p.labels ?? []).map((x) => x.name));
    if (labels.has(hold) && staleHold(commentsOf(p.number), labels, hold, now)) {
      holdOff(p.number, cfg);
      freed.push(p.number);
    }
  }
  return freed;
}

// ---------------------------------------------------------------------------------------------------- the picture

type ClaimView = { manager: string; until: string } | null;

export interface PrRow {
  number: number;
  title: string;
  head: string;
  draft: boolean;
  hold: boolean;
  state: string;
  staleHold: boolean;
  claim: ClaimView;
}

export interface QuestionRow {
  number: number;
  id: unknown;
  state: string;
  claim: ClaimView;
}

export interface Scan {
  prs: PrRow[];
  questions: QuestionRow[];
}

/** Everything a manager decides from: open PRs with their review state and claim, open questions with theirs. */
export function scan(cfg: Config, now: number = nowUtc()): Scan {
  const hold = cfg.holdLabel ?? "factory-hold";
  const prs: PrRow[] = [];
  const questions: QuestionRow[] = [];
  for (const p of fi.ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open")) {
    const n = p.number;
    const head = p.head.sha;
    const comments = commentsOf(n);
    const labels = new Set((p.labels ?? []).map((x) => x.name));
    const w = reviewWinner(comments, head, now);
    const state = reviewed(comments, head) ? "reviewed" : p.draft ? "draft" : w ? "claimed" : "free";
    prs.push({ number: n, title: p.title, head, draft: Boolean(p.draft), hold: labels.has(hold), state,
      staleHold: staleHold(comments, labels, hold, now), claim: w ? { manager: w.manager, until: stamp(w.until) } : null });
    questions.push(...questionRows(n, comments, now));
  }
  for (const i of fi.ghAll<fi.Issue>("repos/{owner}/{repo}/issues?state=open")) {
    if (!("pull_request" in i) && i.comments) questions.push(...questionRows(i.number, commentsOf(i.number), now));
  }
  return { prs, questions };
}

function questionRows(n: number, comments: Comment[], now: number): QuestionRow[] {
  return openQuestions(comments).map((q) => {
    const w = answerWinner(comments, q.id, now);
    return { number: n, id: q.id, state: w ? "claimed" : "free", claim: w ? { manager: w.manager, until: stamp(w.until) } : null };
  });
}

interface Won {
  swept: number[];
  reviews: { number: number; head: string }[];
  answers: { number: number; question: unknown }[];
}

/** Sweep stale holds, then claim every free PR and question (up to `limit`). Returns what this manager won. */
export function pick(cfg: Config, who: string, limit: number | null = null): Won {
  const won: Won = { swept: sweep(cfg), reviews: [], answers: [] };
  let taken = 0;
  for (const p of fi.ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open")) {
    if (limit !== null && taken >= limit) break;
    if (p.draft) continue;
    const [code, line] = claimReview(cfg, p, who);
    if (code === WON && !line.includes("already claimed")) {
      won.reviews.push({ number: p.number, head: p.head.sha });
      taken += 1;
    }
  }
  for (const q of scan(cfg).questions) {
    if (limit !== null && taken >= limit) break;
    if (q.state !== "free") continue;
    const [code, line] = claimAnswer(cfg, q.id as number, who);
    if (code === WON && !line.includes("already claimed")) {
      won.answers.push({ number: q.number, question: q.id });
      taken += 1;
    }
  }
  return won;
}

function show(s: Scan): void {
  console.log("Pull requests");
  for (const p of s.prs) {
    let flag = ({ reviewed: "has a review marker for this head", draft: "draft", free: "free to review",
      claimed: "claimed by {manager} until {until}" } as Record<string, string>)[p.state] as string;
    if (p.claim) flag = flag.replace("{manager}", p.claim.manager).replace("{until}", p.claim.until);
    let extra = p.hold ? ", hold on" : "";
    extra += p.staleHold ? ", STALE hold (lease ran out)" : "";
    console.log(`  #${String(p.number).padEnd(5)} ${p.head.slice(0, 7)}  ${flag}${extra}`);
  }
  if (!s.prs.length) console.log("  none open");
  console.log("Questions waiting");
  for (const q of s.questions) {
    const flag = q.state === "free" || !q.claim ? "free to answer" : `claimed by ${q.claim.manager} until ${q.claim.until}`;
    console.log(`  #${String(q.number).padEnd(5)} comment ${String(q.id)}  ${flag}`);
  }
  if (!s.questions.length) console.log("  none");
}

// ---------------------------------------------------------------------------------------------------- merge, ask

/** Merge the approved head with its sha. A refusal because someone else merged or pushed is not an error. */
export function merge(cfg: Config, n: number, who: string, method: string): Outcome {
  const pr = fi.gh<Pull>("GET", `repos/{owner}/{repo}/pulls/${n}`);
  if (pr.merged || pr.state !== "open") {
    return [0, `PR #${n}: already ${pr.merged ? "merged" : "closed"} (done by someone else)`];
  }
  const head = pr.head.sha;
  const trusted = new Set(Array.isArray(cfg.trustedReviewers) ? (cfg.trustedReviewers as unknown[]).map(String) : []);
  if (!approved(commentsOf(n), head, trusted)) {
    return [1, `factory manager-claims: PR #${n} has no factory-approved marker for ${head.slice(0, 7)}. ` +
      "Review it first and post <!-- factory-approved sha=<head> -->."];
  }
  try {
    fi.gh("PUT", `repos/{owner}/{repo}/pulls/${n}/merge`, { sha: head, merge_method: method });
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    const now = fi.gh<Pull>("GET", `repos/{owner}/{repo}/pulls/${n}`);
    if (now.merged) return [0, `PR #${n}: merged by someone else (done by someone else)`];
    if (now.head.sha !== head) {
      return [0, `PR #${n}: the head moved to ${now.head.sha.slice(0, 7)} while merging; it needs a new review (nothing merged)`];
    }
    if (now.state !== "open") return [0, `PR #${n}: closed by someone else`];
    return [1, `factory manager-claims: GitHub refused the merge of #${n}: ${e.message}. Check CI and conflicts, then try again.`];
  }
  holdOff(n, cfg);
  return [0, `PR #${n}: merged ${head.slice(0, 7)} (${who})`];
}

export function ownerQueue(create: boolean): number | null {
  for (const i of fi.ghAll<fi.Issue>("repos/{owner}/{repo}/issues?state=open")) {
    if (i.title === OWNER_QUEUE_TITLE && !("pull_request" in i)) return i.number;
  }
  if (!create) return null;
  const made = fi.gh<{ number: number }>("POST", "repos/{owner}/{repo}/issues", {
    title: OWNER_QUEUE_TITLE,
    body: "One comment per thing the dev managers cannot decide, each starting `<!-- factory-owner-ask id=<slug> -->`. " +
      "Answer in the comment; the next manager pass reads the reply. Pin this issue." });
  return made.number;
}

/** Post an owner-queue ask once. Two managers racing: the earliest comment with the id stays, the other is deleted. */
export function ask(text: string, slug: string): Outcome {
  if (!/^[A-Za-z0-9._-]+$/.test(slug || "")) {
    die("factory manager-claims: --id is a slug of letters, digits, dots, dashes and underscores.");
  }
  const n = ownerQueue(true) as number;
  const mine = (): Comment[] => commentsOf(n).filter((c) => ASK.exec(c.body || "")?.[1] === slug);
  if (mine().length) return [0, `ask ${slug}: already on #${n}, not posted again`];
  const c = post(n, `<!-- factory-owner-ask id=${slug} -->\nThis needs your yes: ${text}`);
  const first = mine()[0] as Comment;
  if (first.id !== c.id) {
    fi.gh("DELETE", `repos/{owner}/{repo}/issues/comments/${String(c.id)}`);
    return [0, `ask ${slug}: another manager posted it first; mine removed`];
  }
  return [0, `ask ${slug}: posted on #${n}`];
}

// ---------------------------------------------------------------------------------------------------- command line

const COMMANDS = ["list", "review", "answer", "next", "release", "sweep", "merge", "ask"];
const PROG = "factory_manager_claims.ts";
const USAGE = `usage: ${PROG} [-h] [--manager MANAGER] [--max LIMIT] [--json] [--method {squash,merge,rebase}] [--id SLUG]
                                 [--text TEXT]
                                 {list,review,answer,next,release,sweep,merge,ask} [target]`;

function usageError(text: string): never {
  process.stderr.write(`${USAGE}\n${PROG}: error: ${text}\n`);
  throw new Exit(2);
}

export function main(argv: string[]): number {
  const a = parseArgs(argv, { valued: ["--manager", "--max", "--method", "--id", "--text"], flags: ["--json"],
    positionals: ["command", "target?"] }, PROG, USAGE);
  const command = String(a.command);
  if (!COMMANDS.includes(command)) {
    usageError(`argument command: invalid choice: '${command}' (choose from ${COMMANDS.map((c) => `'${c}'`).join(", ")})`);
  }
  let limit: number | null = null;
  if (a.max !== undefined) {
    limit = pyInt(a.max);
    if (limit === null || typeof a.max !== "string" || !/^\s*[+-]?\d+\s*$/.test(a.max)) usageError(`argument --max: invalid int value: '${String(a.max)}'`);
  }
  const method = (a.method as string | undefined) ?? "squash";
  if (!["squash", "merge", "rebase"].includes(method)) {
    usageError(`argument --method: invalid choice: '${method}' (choose from 'squash', 'merge', 'rebase')`);
  }
  const target = a.target as string | undefined;
  const manager = a.manager as string | undefined;
  const cfg = load();
  if (["review", "answer", "release", "merge"].includes(command) && !/^\d+$/.test(target ?? "")) {
    die(`factory manager-claims: ${command} needs a number: factory manager-claims ${command} <number> --manager NAME`);
  }
  if (["review", "answer", "release", "merge", "next"].includes(command)) checkName(manager);
  const who = manager as string;
  let code: number;
  let line: string;
  if (command === "list") {
    const s = scan(cfg);
    if (a.json) console.log(pyDumps(s, { indent: 2 }));
    else show(s);
    return 0;
  } else if (command === "review") {
    const pr = fi.gh<Pull>("GET", `repos/{owner}/{repo}/pulls/${target}`);
    if (pr.state !== "open") {
      console.log(`PR #${target}: not open`);
      return DONE;
    }
    [code, line] = claimReview(cfg, pr, who);
  } else if (command === "answer") {
    [code, line] = claimAnswer(cfg, target as string, who);
  } else if (command === "release") {
    [code, line] = release(cfg, target as string, who);
  } else if (command === "sweep") {
    const freed = sweep(cfg);
    console.log(freed.length ? "hold taken off: " + freed.map((n) => `#${n}`).join(", ") : "no stale hold");
    return 0;
  } else if (command === "merge") {
    [code, line] = merge(cfg, Number(target), who, method);
  } else if (command === "ask") {
    if (!a.id || !a.text) die("factory manager-claims: ask needs --id SLUG and --text TEXT.");
    [code, line] = ask(a.text as string, a.id as string);
  } else {
    const won = pick(cfg, who, limit);
    if (a.json) console.log(pyDumps(won, { indent: 2 }));
    else {
      for (const n of won.swept) console.log(`swept: PR #${n} hold taken off (lease ran out)`);
      for (const r of won.reviews) console.log(`review: PR #${r.number} ${r.head.slice(0, 7)}`);
      for (const q of won.answers) console.log(`answer: question ${String(q.question)} on #${q.number}`);
      if (!(won.reviews.length || won.answers.length)) console.log("nothing to claim");
    }
    return 0;
  }
  if (code === 1) process.stderr.write(line + "\n");
  else console.log(line);
  return code;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
