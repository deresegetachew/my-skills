// The pull request page's rules (#453, design PR.dc.html): the page's data as the API gives it (factory_ui_pr.ts), the
// line under the title, each check's and file's words, a diff split into lines, and what each owner action asks first
// (its preconditions, what happens and what doesn't). No command is shown on screen, so none is written here. No React
// here, so tests/web_ui_pr_model.test.ts runs it as it is.
import type { ConfirmSpec } from "./parts_model.ts";

export interface PrAuthor {
  name: string | null;
  role: "coding-agent" | "product-owner" | "dev-manager" | "person";
  text: string;
}

export interface PrCheck {
  name: string;
  state: string;
  url: string | null;
  runId: number | null;
}

export interface PrFile {
  path: string;
  previous: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  markdown: string | null;
}

export interface PrPageData {
  number: number;
  title: string;
  url: string | null;
  state: string;
  merged: boolean;
  draft: boolean;
  branch: string;
  base: string;
  /** It goes into the project's main branch (#566); without it, a base named main does. */
  intoMain?: boolean;
  head: string;
  body: string;
  author: PrAuthor;
  tasks: string[];
  checks: { state: string; failing: string[]; list: PrCheck[] };
  review: { state: string; text: string; markers: Array<{ kind: string; by: string; sha: string; onHead: boolean; at: string }>;
    github: Array<{ by: string; state: string; onHead: boolean; at: string }> };
  protected: { files: string[]; personOnly: boolean; why: string };
  mergeable: boolean | null;
  files: PrFile[];
  filesMore: boolean;
  comments: Array<{ by: string; at: string; body: string; factory: boolean }>;
  next: { action: string; text: string };
  needsYou: boolean;
}

export type PrAction = "merge" | "ready" | "comment" | "request-changes" | "close";

const ROLE_WORD: Record<string, string> = { "product-owner": "product owner", "dev-manager": "dev manager", "coding-agent": "builder" };

/** "mentewab, product owner": who opened it, with the role when the name doesn't say it. */
export function authorLine(a: PrAuthor): string {
  if (a.role === "person") return "a person";
  return a.name ? `${a.name}, ${ROLE_WORD[a.role]}` : a.text;
}

/** The facts under the title: who, the protected files, the review. */
export function factsLine(pr: PrPageData): string {
  const bits = [authorLine(pr.author)];
  if (pr.protected.files.length) bits.push("changes protected files");
  if (pr.review.state !== "none") bits.push(pr.review.text);
  return bits.join(" · ");
}

/** One status, in words, with whether it is the one thing that needs the owner. */
export function statusOf(pr: PrPageData): { text: string; needsYou: boolean } {
  if (pr.merged) return { text: "Merged", needsYou: false };
  if (pr.state !== "open") return { text: "Closed", needsYou: false };
  const first = pr.draft ? "Draft" : pr.checks.state === "red" ? "Checks failing" : pr.review.state === "approved" ? "Approved"
    : pr.review.state === "changes-asked" ? "Changes asked" : pr.checks.state === "running" ? "Checks running" : "Open";
  const next = pr.next.text === "none" ? "" : pr.next.text;
  return { text: next ? `${first}, ${next}` : first, needsYou: pr.needsYou };
}

const CHECK_WORD: Record<string, string> = { passed: "Passed", failed: "Failed", running: "Running", queued: "Waiting to run", skipped: "Skipped",
  neutral: "Done" };

export function checkWord(state: string): string {
  return CHECK_WORD[state] ?? state;
}

/** A check's dot: green for passed, dark for failed (a result, not an alarm), amber while it runs, grey otherwise. */
export function checkDot(state: string): "working" | "ink" | "waiting" | "idle" {
  return state === "passed" ? "working" : state === "failed" ? "ink" : state === "running" || state === "queued" ? "waiting" : "idle";
}

const STATUS_WORD: Record<string, string> = { added: "new", removed: "deleted", renamed: "renamed", modified: "changed", copied: "copied", changed: "changed" };

export function fileWord(f: PrFile): string {
  return `${STATUS_WORD[f.status] ?? f.status} · +${f.additions} −${f.deletions}`;
}

export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  text: string;
}

/** A file's diff as lines: a hunk header, an added, a removed or an unchanged line. */
export function diffLines(patch: string): DiffLine[] {
  return patch.split("\n").map((l): DiffLine => {
    if (l.startsWith("@@")) return { kind: "hunk", text: l };
    if (l.startsWith("+")) return { kind: "add", text: l.slice(1) };
    if (l.startsWith("-")) return { kind: "del", text: l.slice(1) };
    if (l.startsWith("\\")) return { kind: "note", text: l.slice(1).trim() };
    return { kind: "ctx", text: l.slice(1) };
  });
}

function who(pr: PrPageData): string {
  return pr.author.name ?? pr.author.text;
}

/** Merge: open, not a draft, checks passing. Merged into the base with a merge commit, pinned to the commit shown. */
export function mergeAsk(pr: PrPageData): ConfirmSpec {
  const open = pr.state === "open";
  const green = pr.checks.state === "green";
  const short = pr.head.slice(0, 7);
  const intoMain = pr.intoMain ?? pr.base === "main";
  return {
    title: `Merge #${pr.number}?`,
    checks: [
      { title: "It is open", met: open, ...(open ? {} : { sub: `It is ${pr.state}.` }) },
      { title: "It is ready for review", met: !pr.draft, ...(pr.draft ? { sub: "It is a draft.", fix: "Mark ready" } : {}) },
      { title: "Its checks pass", met: green,
        ...(green ? {} : { sub: pr.checks.state === "red" ? `Failing: ${pr.checks.failing.join(", ")}.` : pr.checks.state === "none" ? "They haven't run yet."
          : "They are still running." }) },
    ],
    happens: `#${pr.number} is merged into ${pr.base || "the main branch"} at ${short}, the commit on this page. ` +
      `Its branch is deleted${pr.tasks.length ? `, and #${pr.tasks[0]} is done` : ""}.` +
      (intoMain ? " Then the project's checkout on this machine is brought up to date, so what it changes applies here at once, " +
        "when that checkout is on main with nothing uncommitted; else the page says what to do." : ""),
    doesNot: `If a new commit lands first, nothing is merged and you are asked again. ` +
      (intoMain ? "The agents' worktrees aren't touched: their loops bring themselves up to date. " : "") +
      (pr.protected.personOnly ? `${who(pr)} can't merge it: ${pr.protected.why.charAt(0).toLowerCase()}${pr.protected.why.slice(1)}` : "Nothing else changes."),
    action: `Merge #${pr.number}`,
    tone: "primary",
  };
}

/** Mark ready: only a draft. */
export function readyAsk(pr: PrPageData): ConfirmSpec {
  return {
    title: `Mark #${pr.number} ready?`,
    checks: [{ title: "It is a draft", met: pr.draft, ...(pr.draft ? {} : { sub: "It is already ready for review." }) }],
    happens: `#${pr.number} is no longer a draft, so it can be reviewed and merged.`,
    doesNot: "Nothing is merged, and its commits don't change.",
    action: "Mark ready",
    tone: "primary",
  };
}

/** Request changes: the author is told on the pull request (and on the message board, where there is one). */
export function changesAsk(pr: PrPageData): ConfirmSpec {
  return {
    title: `Ask ${who(pr)} for changes?`,
    checks: [{ title: "It is open", met: pr.state === "open" }],
    happens: `Your words go on #${pr.number} as a must-fix on its latest commit, and ${who(pr)} is told on its task's thread. ` +
      "It can't be merged until a new commit answers them.",
    doesNot: "Nothing is closed or merged, and no one else's work stops.",
    action: "Ask for changes",
    tone: "primary",
  };
}

/** Comment: words on the pull request. */
export function commentAsk(pr: PrPageData): ConfirmSpec {
  return {
    title: `Comment on #${pr.number}?`,
    checks: [],
    happens: `Your words go on #${pr.number}, where ${who(pr)} and the dev manager read them.`,
    doesNot: "It doesn't hold the merge or ask for changes.",
    action: "Comment",
    tone: "primary",
  };
}

/** Close: open only. The branch and its commits stay. */
export function closeAsk(pr: PrPageData): ConfirmSpec {
  return {
    title: `Close #${pr.number}?`,
    checks: [{ title: "It is open", met: pr.state === "open" }],
    happens: `#${pr.number} is closed without merging${pr.tasks.length ? `; #${pr.tasks[0]} stays open` : ""}. Your reason, if you give one, goes on it first.`,
    doesNot: "Its branch and commits are kept, so it can be opened again.",
    action: `Close #${pr.number}`,
    tone: "danger",
    typeName: `#${pr.number}`,
  };
}

export function askOf(action: PrAction, pr: PrPageData): ConfirmSpec {
  return action === "merge" ? mergeAsk(pr) : action === "ready" ? readyAsk(pr) : action === "request-changes" ? changesAsk(pr)
    : action === "comment" ? commentAsk(pr) : closeAsk(pr);
}

/** What the page offers first: Mark ready for a draft, Merge when it may be merged, else nothing. */
export function mainAction(pr: PrPageData): PrAction | null {
  if (pr.state !== "open") return null;
  return pr.draft ? "ready" : "merge";
}

/** The pull request as the page shows it (#611): once this page merged head `mergedHead`, a read that still says it is
 *  open at that head (it was asked before GitHub said merged) shows it merged, so Merge doesn't come back. A commit
 *  pushed after it, or nothing merged here, shows the read as it is. */
export function shownPr(pr: PrPageData, mergedHead: string | null): PrPageData {
  return mergedHead !== null && pr.head === mergedHead && pr.state === "open" ? { ...pr, state: "merged", merged: true } : pr;
}
