// The GitHub adapter's import (#494, decision 0007 points 4 and 10): a repo's issues become tasks, their comments the
// tasks' threads. It reads GitHub only through the `gh` CLI's REST calls (`gh api`), paginated 100 at a time, with the
// comments read for the whole repo at once (`issues/comments?since=`), and counts its calls. The board's core knows
// nothing of GitHub: this module turns what GitHub says into an ImportBatch, and `Board.import` applies it.
//
// What a GitHub issue means here is the software factory's convention, given as FACTORY_MAPPING, which a caller may
// change. The factory defines these markers and labels itself; this folder imports nothing from it (decision 0007), so
// the small parts it needs are written again here. Where the factory defines each:
//   labels factory:ready|in-progress|in-review|blocked, agent:<name>   hooks/factory_config.ts (tasks.labels)
//   `Depends on #n`                                                     hooks/core/domain/task.ts (DEPENDS)
//   an epic's `- [ ] #n` lines, label `epic`                            hooks/core/domain/epic.ts (TASK_LINE)
//   `**Blocked:** <reason>` after a factory-release marker              hooks/core/adapters/github/task_tracker.ts (block)
//   factory-claim, factory-release                                      hooks/factory_issues.ts (CLAIM, RELEASE)
//   factory-question, factory-answer, factory-approved, factory-mustfix, pr-watch,
//   factory-owner-ask, factory-owner-answer, factory-po-reply           hooks/factory_prs.ts
//   factory-manager-note                                                hooks/factory_orchestrator.ts (NOTE_RX)
//   factory-review-claim, factory-answer-claim, factory-claim-release   hooks/factory_manager_claims.ts
//   factory-msg (the envelope)                                          hooks/core/domain/message.ts, docs/messages.md
//   the owner queue "Dev manager: needs the owner"                      hooks/factory_prs.ts (OWNER_QUEUE_TITLE)
//   factory-mirror (what the board's mirror wrote, #502)                 src/github/mirror.ts (MIRROR_MARK)
// A comment the board's own mirror wrote is never brought back as a message: the board already has it. Its markers still
// count (an ask's id, a blocked reason), so a reply to it joins the board's message, which the mirror linked to it.
import type { Board } from "../board.ts";
import type { ImportBatch, ImportMessage, ImportResult, ImportTask, Message, MessageKind, Outcome, Task, TaskKind } from "../types.ts";

export class GithubError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
    this.name = "GithubError";
  }
}

// ---------- the mapping ----------

export interface GithubMapping {
  /** The labels that give a task its status, and the prefix of the label that names who holds it. */
  labels: { ready: string; inProgress: string; inReview: string; blocked: string; agentPrefix: string };
  /** The labels that make an issue an epic or a bug; issues with these labels or titles are notes (not work items). */
  kinds: { epic: string[]; bug: string[]; noteLabels: string[]; noteTitles: string[] };
  /** A comment's marker (`<!-- factory-<name> ...-->`, or `pr-watch`) and the message kind it becomes. The marker's
   * name is kept as the message's tag; a comment with no marker is a `note` tagged `comment`. */
  markers: Record<string, MessageKind>;
  /** Who a question is addressed to when its marker doesn't say, and who asks go to. */
  questionsTo: string;
  asksTo: string;
}

export const FACTORY_MAPPING: GithubMapping = {
  labels: { ready: "factory:ready", inProgress: "factory:in-progress", inReview: "factory:in-review", blocked: "factory:blocked", agentPrefix: "agent:" },
  kinds: { epic: ["epic"], bug: ["bug"], noteLabels: ["factory:agent", "factory:agent-down"], noteTitles: ["Dev manager: needs the owner"] },
  markers: {
    question: "question", answer: "answer", "owner-ask": "ask", "owner-answer": "answer", "po-reply": "note", "manager-note": "note",
    claim: "status", release: "status", "review-claim": "status", "answer-claim": "status", "rework-claim": "status",
    "rework-release": "status", "claim-release": "status", "item-claim": "status",
    approved: "verdict", mustfix: "verdict", "pr-watch": "verdict",
  },
  questionsTo: "dev-manager",
  asksTo: "owner",
};

// ---------- GitHub through gh ----------

/** What GitHub's REST API gives for an issue and a comment; only the fields read here. */
export interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  state_reason?: string | null;
  labels?: ({ name?: string } | string)[];
  milestone?: { title?: string } | null;
  pull_request?: unknown;
  created_at?: string;
  updated_at?: string;
}

export interface GhComment {
  id: number;
  issue_url?: string;
  body?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
  updated_at?: string;
}

export interface Gh {
  /** GET one REST path (relative to the API's root); throws a GithubError. */
  get(path: string): unknown;
  /** A write (POST, PATCH, PUT, DELETE) to one REST path with a JSON body; GitHub's answer. Throws a GithubError. */
  send(method: string, path: string, body?: unknown): unknown;
  /** Whether gh is signed in (no call to GitHub). */
  signedIn(): boolean;
  readonly calls: number;
}

function spawn(args: string[], input?: string): { code: number; out: string; err: string } {
  try {
    const p = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : Buffer.from(input), timeout: 120_000 });
    return { code: p.exitCode ?? 124, out: p.stdout.toString(), err: p.stderr.toString() };
  } catch {
    throw new GithubError("gh-missing", "GitHub's CLI (gh) isn't installed or isn't on your PATH; the import reads GitHub through it.",
      "Install it (https://cli.github.com), run `gh auth login`, then run this again.");
  }
}

/** The `gh` CLI, counting each `gh api` call. */
export function ghCli(): Gh {
  let calls = 0;
  const api = (args: string[], path: string, input?: string): unknown => {
    calls++;
    const r = spawn(args, input);
    if (r.code !== 0) {
      const why = (r.err || r.out).trim().slice(-300);
      if (/rate limit/i.test(why)) {
        throw new GithubError("gh-rate-limited", `GitHub's hourly limit is used up: ${why}`, "Wait until the limit is back (`gh api rate_limit` says when), then run this again. Nothing was written.");
      }
      if (/auth login|401|Bad credentials/i.test(why)) {
        throw new GithubError("gh-signed-out", `gh can't read GitHub: ${why}`, "Run `gh auth login`, then run this again. Nothing was written.");
      }
      if (/HTTP (404|410)/.test(why)) {
        throw new GithubError("gh-not-found", `GitHub has no ${path.split("?")[0]}: ${why}`, "Check the repo name (--repo owner/name) and that gh can read it, then run this again. Nothing was written.");
      }
      throw new GithubError("gh-failed", `gh api ${path.split("?")[0]} failed: ${why}`, "Run this again once GitHub answers; check the repo name (--repo owner/name) if it keeps failing. Nothing was written.");
    }
    if (!r.out.trim()) return null; // a write GitHub answers with no body
    try {
      return JSON.parse(r.out) as unknown;
    } catch {
      throw new GithubError("gh-failed", `gh api ${path.split("?")[0]} didn't answer with JSON.`, "Run it again; if it keeps failing, check `gh api` by hand.");
    }
  };
  return {
    get calls() {
      return calls;
    },
    signedIn: () => spawn(["auth", "token"]).code === 0,
    get: (path: string): unknown => api(["api", path], path),
    send: (method: string, path: string, body?: unknown): unknown =>
      api(["api", "-X", method, path, "-H", "Accept: application/vnd.github+json", "--input", "-"], path, JSON.stringify(body ?? {})),
  };
}

/** Every page of a list, each item once by its key (a live repo can shift items between pages while they are read). */
export function pages<T>(gh: Gh, path: string, key: (x: T) => number): T[] {
  const all = new Map<number, T>();
  for (let page = 1; ; page++) {
    const got = gh.get(`${path}&page=${page}`);
    if (!Array.isArray(got)) throw new GithubError("gh-failed", `gh api ${path.split("?")[0]} didn't answer with a list.`, "Check the repo name (--repo owner/name), then run this again.");
    for (const x of got as T[]) all.set(key(x), x);
    if (got.length < 100) return [...all.values()];
  }
}

/** owner/name from --repo, GH_REPO, or the git remote `origin` of the folder it runs in. */
export function repoName(given: string | undefined, cwd = process.cwd()): string {
  const fromRemote = (): string => {
    try {
      const p = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) return "";
      const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(p.stdout.toString().trim());
      return m ? `${m[1]}/${m[2]}` : "";
    } catch {
      return "";
    }
  };
  const repo = (given ?? process.env.GH_REPO ?? fromRemote()).toLowerCase(); // GitHub names ignore case: one set of refs
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((p) => !/^[\w.-]+$/.test(p) || /^\.+$/.test(p))) {
    throw new GithubError("bad-input", repo ? `${JSON.stringify(repo)} isn't a GitHub repo name (owner/name).` : "Which GitHub repo? This folder has no GitHub remote named origin.",
      "Pass --repo owner/name, or run it in a checkout of the repo.");
  }
  return repo;
}

// ---------- what a comment says ----------

const MARKER = /<!--\s*(factory-[a-z][a-z-]*|pr-watch)\b([^>]*?)-->/;
const ENVELOPE = /<!--\s*factory-msg\b([\s\S]*?)-->/;
const ENVELOPE_KINDS: Record<string, MessageKind> = { question: "question", answer: "answer", mustfix: "verdict", approval: "verdict", status: "status" };
const NAMED = /\b(?:agent|manager)=([\w.-]+)/;
const BLOCKED = /\*\*Blocked:\*\*\s*(.+)/;
const DEPENDS = /depends on\s+((?:#\d+[\s,and]*)+)/gi;
const EPIC_LINE = /^\s*[-*]\s+\[[ xX]\]\s+#(\d+)\b/gm;
/** What the board's mirror writes on each comment it posts (src/github/mirror.ts). */
export const MIRRORED = /<!--\s*factory-mirror\b[^>]*-->/;

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w-]+)=("([^"]*)"|\S+)/g)) out[m[1] as string] = m[3] ?? (m[2] as string);
  return out;
}

interface Said {
  kind: MessageKind;
  tag: string;
  from: string | null;
  to: string | null;
  /** The envelope's id, or the owner ask's id. */
  id: string | null;
  /** What it replies to: an envelope id (`msg:`), an ask id (`ask:`), or the last question here (`question`). */
  replyTo: string | null;
}

/** What a comment is, by the factory's markers; an envelope wins over an old marker in the same comment. */
export function readComment(body: string, map: GithubMapping): Said {
  const env = ENVELOPE.exec(body);
  if (env) {
    const a = attributes(env[1] as string);
    const kind = ENVELOPE_KINDS[a.kind ?? ""];
    if (a.v === "1" && kind) {
      return { kind, tag: "msg", from: a.from || null, to: a.to || (kind === "question" ? map.questionsTo : null), id: a.id ?? null,
        replyTo: a["in-reply-to"] ? `msg:${a["in-reply-to"]}` : null };
    }
  }
  const m = MARKER.exec(body);
  if (!m) return { kind: "note", tag: "comment", from: null, to: null, id: null, replyTo: null };
  const name = (m[1] as string).replace(/^factory-/, "");
  const a = attributes(m[2] as string);
  const kind = map.markers[name] ?? "note";
  const named = NAMED.exec(m[2] as string)?.[1] ?? null;
  const said: Said = { kind, tag: name, from: named && named !== "none" ? named : null, to: null, id: null, replyTo: null };
  if (name === "question") said.to = map.questionsTo;
  if (name === "answer") said.replyTo = "question";
  if (name === "owner-ask") Object.assign(said, { id: a.id ?? null, to: map.asksTo });
  if (name === "owner-answer") said.replyTo = a.id ? `ask:${a.id}` : null;
  if (name === "po-reply") {
    said.replyTo = a.ask ? `ask:${a.ask}` : null;
    if (/\bdone\b/.test(m[2] as string)) said.kind = "answer";
  }
  if (name === "manager-note") said.from = "dev-manager";
  return said;
}

/** The issue numbers a body says it depends on ("Depends on #12, #14"), each once. */
export function dependsOn(body: string): number[] {
  const found = new Set<number>();
  for (const m of body.matchAll(DEPENDS)) for (const d of (m[1] as string).matchAll(/#(\d+)/g)) found.add(Number(d[1]));
  return [...found].sort((a, b) => a - b);
}

/** The issue numbers an epic lists as its tasks (`- [ ] #n`, ticked or not). */
export function epicTasks(body: string): number[] {
  return [...body.matchAll(EPIC_LINE)].map((m) => Number(m[1]));
}

// ---------- the batch ----------

const labelNames = (i: GhIssue): string[] => (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);
const issueOf = (c: GhComment): number | null => {
  const m = /\/issues\/(\d+)$/.exec(c.issue_url ?? "");
  return m ? Number(m[1]) : null;
};
const OUTCOME: Record<string, Outcome> = { completed: "done", not_planned: "wont_do", duplicate: "duplicate" };

/** A comment already on the board (from an earlier run), to read replies and reasons against. */
interface Known {
  ref: string;
  issue: number;
  body: string;
  at: number;
}

export interface Read {
  repo: string;
  closed: boolean;
  /** The board is the record: an issue already on the board brings no notes from its labels (its status is the board's). */
  boardIsRecord?: boolean;
  issues: GhIssue[];
  comments: GhComment[];
  /** Comments brought by an earlier run, on the issues this run looks at. */
  known: Known[];
  /** The refs already on the board (any status). */
  onBoard: Set<string>;
  /** What each of them is on the board (a closed issue that is a task there stays one). */
  kinds?: Map<string, TaskKind>;
}

export interface Built {
  batch: ImportBatch;
  skipped: { prComments: number; notImported: number; deps: number; mirrored: number };
}

export const issueRef = (repo: string, n: number): string => `github:${repo}#${n}`;
export const commentRef = (repo: string, id: number): string => `github:${repo}/comments/${id}`;

/** Whether the factory took issue `i` as a task (#515): it carries one of the factory's labels (ready, in progress, in
 * review, blocked, or agent:<name>), as a task does in issues mode, where only a labelled issue is ever claimed. */
export function isFactoryTask(i: GhIssue, map: GithubMapping): boolean {
  const L = map.labels;
  return labelNames(i).some((l) => [L.ready, L.inProgress, L.inReview, L.blocked].includes(l) || l.startsWith(L.agentPrefix));
}

/** What issue `i` is on the board. A new issue the factory didn't take as a task (no factory label: a channel, a bug
 * report nobody triaged) comes in as a note, never ready. A task or a bug already on the board is never demoted (#515):
 * it may be held, or in progress, and the mirror takes the factory's labels off an issue it closes; it keeps its kind
 * until a factory label says otherwise. */
function kindOf(i: GhIssue, map: GithubMapping, onBoard?: TaskKind): TaskKind {
  const labels = labelNames(i);
  if (labels.some((l) => map.kinds.epic.includes(l))) return "epic";
  if (labels.some((l) => map.kinds.noteLabels.includes(l)) || map.kinds.noteTitles.includes(i.title)) return "note";
  const work = onBoard === "task" || onBoard === "bug";
  if (!isFactoryTask(i, map)) return work ? (onBoard as TaskKind) : "note";
  return labels.some((l) => map.kinds.bug.includes(l)) ? "bug" : "task";
}

/** Turn what was read into an ImportBatch: pure, no calls. */
export function buildBatch(read: Read, map: GithubMapping, options: Record<string, unknown> = {}): Built {
  const { repo } = read;
  const issues = read.issues.filter((i) => !i.pull_request);
  const prs = new Set(read.issues.filter((i) => i.pull_request).map((i) => i.number));
  const mine = new Set(issues.map((i) => i.number));
  const ref = (n: number): string => issueRef(repo, n);
  const reachable = (n: number): boolean => mine.has(n) || read.onBoard.has(ref(n));
  const skipped = { prComments: 0, notImported: 0, deps: 0, mirrored: 0 };

  // Comments, in the order they were said: the board's (an earlier run's) and the new ones, per issue.
  type Line = { ref: string; issue: number; body: string; at: number; login: string; fresh: boolean };
  const lines: Line[] = read.known.map((k) => ({ ...k, login: "", fresh: false }));
  const freshRefs = new Set<string>();
  for (const c of read.comments) {
    const n = issueOf(c);
    if (n === null || !mine.has(n)) {
      if (n !== null && prs.has(n)) skipped.prComments++;
      else skipped.notImported++;
      continue;
    }
    if (!(c.body ?? "").trim()) continue;
    const r = commentRef(repo, c.id);
    freshRefs.add(r);
    lines.push({ ref: r, issue: n, body: c.body ?? "", at: Date.parse(c.created_at ?? "") || 0, login: c.user?.login ?? "github", fresh: true });
  }
  const seen = new Set<string>();
  const ordered = lines
    .filter((l) => l.fresh || !freshRefs.has(l.ref))
    .sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref, "en", { numeric: true }))
    .filter((l) => (seen.has(l.ref) ? false : (seen.add(l.ref), true)));

  const asks = new Map<string, string>();
  const envelopes = new Map<string, string>();
  const lastQuestion = new Map<number, string>();
  const claimedBy = new Map<number, string>();
  const blockedWhy = new Map<number, string>();
  const messages: ImportMessage[] = [];
  for (const l of ordered) {
    const s = readComment(l.body, map);
    let replyTo: string | null = null;
    if (s.replyTo === "question") replyTo = lastQuestion.get(l.issue) ?? null;
    else if (s.replyTo?.startsWith("ask:")) replyTo = asks.get(s.replyTo.slice(4)) ?? null;
    else if (s.replyTo?.startsWith("msg:")) replyTo = envelopes.get(s.replyTo.slice(4)) ?? null;
    if (s.kind === "question") lastQuestion.set(l.issue, l.ref);
    if (s.tag === "owner-ask" && s.id) asks.set(s.id, l.ref);
    if (s.tag === "msg" && s.id) envelopes.set(s.id, l.ref);
    if (s.tag === "claim" && s.from) claimedBy.set(l.issue, s.from);
    const blocked = BLOCKED.exec(l.body);
    if (blocked) blockedWhy.set(l.issue, (blocked[1] as string).trim());
    if (!l.fresh) continue;
    if (MIRRORED.test(l.body)) {
      skipped.mirrored++; // the board's own, copied there by its mirror
      continue;
    }
    messages.push({ ref: l.ref, task: ref(l.issue), kind: s.kind, tag: s.tag, from: s.from ?? l.login, to: s.to, body: l.body,
      inReplyTo: replyTo, createdAt: new Date(l.at) });
  }

  // An epic's `- [ ] #n` lines set the parent: the first epic (by number) that lists a task.
  const parentOf = new Map<number, number>();
  for (const e of [...issues].sort((a, b) => a.number - b.number)) {
    if (kindOf(e, map) !== "epic") continue;
    for (const n of epicTasks(e.body ?? "")) if (n !== e.number && !parentOf.has(n)) parentOf.set(n, e.number);
  }

  const tasks: ImportTask[] = issues.map((i) => {
    const labels = labelNames(i);
    const r = ref(i.number);
    const notes: ImportTask["notes"] = [];
    const labelNotes = !(read.boardIsRecord && read.onBoard.has(r));
    let status: ImportTask["status"] = "open";
    let outcome: Outcome | null = null;
    if (i.state === "closed") {
      status = "done";
      outcome = OUTCOME[i.state_reason ?? ""] ?? "done";
    } else if (labels.includes(map.labels.inReview)) status = "in_review";
    else if (labels.includes(map.labels.inProgress)) {
      const agent = labels.find((l) => l.startsWith(map.labels.agentPrefix))?.slice(map.labels.agentPrefix.length) ?? claimedBy.get(i.number);
      notes.push({ ref: `${r}/in-progress`, kind: "discovery",
        body: `Was in progress on GitHub${agent ? `, claimed by ${agent}` : ""}. Claims start fresh on the board: claim it again here.` });
    } else if (labels.includes(map.labels.blocked)) {
      notes.push({ ref: `${r}/blocked`, kind: "blocker", body: `Blocked on GitHub: ${blockedWhy.get(i.number) ?? "no reason given"}.` });
    }
    let body = i.body ?? "";
    const ms = i.milestone?.title;
    if (ms && !body.includes(`Milestone: ${ms}`)) body = `${body.trimEnd()}${body.trim() ? "\n\n" : ""}Milestone: ${ms}`;
    const deps = dependsOn(i.body ?? "").filter((n) => n !== i.number);
    const blockedBy = deps.filter(reachable).map(ref);
    skipped.deps += deps.length - blockedBy.length;
    const p = parentOf.get(i.number);
    return {
      ref: r, title: i.title, body, kind: kindOf(i, map, read.kinds?.get(r)), status, outcome, createdAt: i.created_at ? new Date(i.created_at) : undefined,
      parentRef: p !== undefined && mine.has(p) ? ref(p) : null, blockedBy, notes: labelNotes ? notes : undefined,
    };
  });
  return { batch: { source: `github:${repo}`, tasks, messages, options }, skipped };
}

// ---------- the run ----------

export interface ImportSummary {
  repo: string;
  closed: boolean;
  /** The board is the record: statuses the board changed since the last import were kept. */
  boardIsRecord: boolean;
  result: ImportResult;
  skipped: Built["skipped"] & { gone: number };
  /** The since the comments were read from, or null for all of them. */
  since: string | null;
  calls: number;
}

/** The margin taken off the last run's start when reading comments `since` it, for clocks that differ. */
const SINCE_MARGIN_MS = 10 * 60 * 1000;

/** Read `repo`'s issues (open, or all with `closed`) and their comments from GitHub, and import them into `board`. */
export async function importFromGithub(board: Board, opts: { repo: string; closed?: boolean; dryRun?: boolean; gh?: Gh; mapping?: GithubMapping;
  boardIsRecord?: boolean }): Promise<ImportSummary> {
  const boardIsRecord = opts.boardIsRecord === true;
  const gh = opts.gh ?? ghCli();
  const map = opts.mapping ?? FACTORY_MAPPING;
  const closed = opts.closed === true;
  if (!gh.signedIn()) {
    throw new GithubError("gh-signed-out", "gh isn't signed in to GitHub, so the issues can't be read.", "Run `gh auth login`, then run this again. Nothing was written.");
  }
  const source = `github:${opts.repo}`;
  const prefix = `${source}#`;
  const startedAt = new Date();
  const all = await board.tasks({ all: true, limit: 1_000_000 });
  const onBoard = new Map(all.filter((t) => t.ref?.startsWith(prefix)).map((t) => [t.ref as string, t]));
  const issues = pages<GhIssue>(gh, `repos/${opts.repo}/issues?state=${closed ? "all" : "open"}&per_page=100`, (i) => i.number);

  // Issues the board has open that GitHub no longer lists as open: read each, to close it here too.
  let gone = 0;
  if (!closed) {
    const listed = new Set(issues.map((i) => issueRef(opts.repo, i.number)));
    for (const [r, t] of onBoard) {
      if (listed.has(r) || t.status === "done") continue;
      const n = Number(r.slice(prefix.length));
      try {
        const i = gh.get(`repos/${opts.repo}/issues/${n}`) as GhIssue;
        if (i && i.number === n && !i.pull_request) issues.push(i);
        else gone++;
      } catch (e) {
        if (e instanceof GithubError && e.code === "gh-not-found") gone++; // only 404 and 410 mean gone; anything else stops the run
        else throw e;
      }
    }
  }

  // Comments for the whole repo: since the last run when nothing older can be missing (same or fewer issues, none new).
  const last = await board.lastImport(source);
  const lastStart = typeof last?.options.startedAt === "string" ? Date.parse(last.options.startedAt) : NaN;
  const nothingNew = issues.filter((i) => !i.pull_request).every((i) => onBoard.has(issueRef(opts.repo, i.number)));
  const since = last && Number.isFinite(lastStart) && nothingNew && (!closed || last.options.closed === true)
    ? new Date(lastStart - SINCE_MARGIN_MS).toISOString() : null;
  const comments = pages<GhComment>(gh, `repos/${opts.repo}/issues/comments?per_page=100${since ? `&since=${since}` : ""}`, (c) => c.id);

  const known = since ? await knownComments(board, onBoard, comments, issues, opts.repo, map) : [];
  const built = buildBatch({ repo: opts.repo, closed, issues, comments, known, onBoard: new Set(onBoard.keys()), kinds: new Map([...onBoard].map(([r, t]) => [r, t.kind])), boardIsRecord }, map,
    { startedAt: startedAt.toISOString(), closed });
  const result = await board.import(built.batch, { dryRun: opts.dryRun === true, keepBoardStatus: boardIsRecord });
  return { repo: opts.repo, closed, boardIsRecord, result, skipped: { ...built.skipped, gone }, since, calls: gh.calls };
}

/** The comments an earlier run brought, on the issues this run has new comments for or must read a reason on. */
async function knownComments(board: Board, onBoard: Map<string, Task>, comments: GhComment[], issues: GhIssue[], repo: string, map: GithubMapping): Promise<Known[]> {
  const want = new Set<number>(comments.map(issueOf).filter((n): n is number => n !== null));
  for (const i of issues) if (labelNames(i).some((l) => l === map.labels.blocked || l === map.labels.inProgress)) want.add(i.number);
  const out: Known[] = [];
  for (const n of want) {
    const t = onBoard.get(issueRef(repo, n));
    if (!t) continue;
    const thread: Message[] = await board.thread({ task: t.id });
    for (const m of thread) if (m.ref) out.push({ ref: m.ref, issue: n, body: m.body, at: m.createdAt.getTime() });
  }
  return out;
}
