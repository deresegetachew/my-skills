// The web UI's pull request page (#453, design PR.dc.html): one pull request read in full when its page opens, and the
// owner's actions on it. factory_ui_server.ts routes to it:
//
//   GET  /api/projects/:p/pull-requests/:n            the page: title, body, who opened it, its tasks, its checks (each
//                                                     with its state and run), the reviews (the factory's markers and
//                                                     GitHub's), the protected files and whether only a person may merge
//                                                     it, and the files with their diff (a Markdown file's text too)
//   POST /api/projects/:p/pull-requests/:n/actions/:name  {confirm: true, ...}: the owner's merge, ready, comment,
//                                                     request-changes and close
//
// Cost: the page is read only when it opens (never per poll) and kept until the pull request's head or its checks
// change: while the snapshot's row names the same head and checks state, a second look costs no GitHub call.
//
// Who opened it (authorOf): the agent from its `agent:<name>` label, else the branch's first part (`task/` a builder,
// `po/` or a product owner's name the product owner, `manager/` or a dev manager's name the dev manager, a builder's
// name that builder), else the product owner's markers in the body (the PRD-change template, `<!-- factory-po`), else
// a person. A pull request only a person may merge (it touches protected files, its body says "a person merges this
// one", or no builder wrote it) or one the product owner opened for the owner waits for you (truthOf).
//
// Every action is the owner's: in a factory session (FACTORY_AGENT or FACTORY_LOOP) it is refused with `owner_only`.
// Merge runs `factory owner merge <n> --head <sha>`, a merge commit as the factory's own merges (it checks again and pins the merge to the head the page
// showed); it is refused here first for a draft (`pr_draft`, mark it ready first) or checks that aren't green. After a
// merge into main the project's checkout is brought up to date when that is safe (factory_ui_checkout.ts, #566), and
// the answer's `checkout` says how that went (or why it was left as it is). Ready is
// `gh pr ready <n>`. Comment, request changes and close go through `gh api`. Request changes posts the factory's
// must-fix marker on the head (`<!-- factory-mustfix sha=<head> -->`, as the dev manager's verdicts do, so the author
// reworks it) and, with the message board, a verdict message to the author on its task's thread.
import { branchTask, type Config, DEFAULTS } from "./factory_config.ts";
import { bringUpToDate, mainBranchOf, mainOf } from "./factory_ui_checkout.ts";
import { type ActionResult, envFor, factoryScript, type Obj, resultOf, spawn, type UiProject } from "./factory_ui_data.ts";

const READ_MS = 30_000;
const ACT_MS = 120_000;
const TEXT_MAX = 4000;
const BODY_MAX = 60_000;
const PATCH_MAX = 200_000;
const MARKDOWN_FILES = 6;
const MARKDOWN_MAX = 200_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

// --- who opened it, and what waits for whom ----------------------------------------------------------------------------

export type AuthorRole = "coding-agent" | "product-owner" | "dev-manager" | "person";

export interface Author {
  /** The agent's name when it is known; null for "the product owner" when the project names several. */
  name: string | null;
  role: AuthorRole;
  /** "mentewab", "the product owner", "a builder", "a person". */
  text: string;
}

/** A role's names from the project's factory.json, else the defaults; only valid names. */
function namesOf(cfg: Config | null, role: string): string[] {
  const roles = obj(cfg?.roles);
  const mine = role === "coding-agent" ? cfg?.agents : obj(roles[role]).names;
  const base = role === "coding-agent" ? DEFAULTS.agents : obj(obj(DEFAULTS.roles)[role]).names;
  const given = Array.isArray(mine) ? mine : Array.isArray(base) ? base : [];
  return given.filter((n): n is string => typeof n === "string" && NAME.test(n));
}

const PO_PREFIX = new Set(["po", "product", "product-owner"]);
const MANAGER_PREFIX = new Set(["manager", "dev-manager"]);
const PO_BODY = /<!--\s*factory-po-|^##\s+What changes in the PRD\s*$/m;

function roleAuthor(role: "product-owner" | "dev-manager", names: string[], named: string | null): Author {
  const name = named ?? (names.length === 1 ? names[0] as string : null);
  return { name, role, text: name ?? (role === "product-owner" ? "the product owner" : "the dev manager") };
}

/** Who opened a pull request, from its agent label, its branch and its body (the header says how). */
export function authorOf(cfg: Config | null, o: { branch: string; agent?: string | null; body?: string }): Author {
  const agent = str(o.agent);
  if (NAME.test(agent)) return { name: agent, role: "coding-agent", text: agent };
  const seg = o.branch.split("/")[0]?.toLowerCase() ?? "";
  const po = namesOf(cfg, "product-owner");
  const mgr = namesOf(cfg, "dev-manager");
  if (o.branch.includes("/")) {
    if (PO_PREFIX.has(seg) || po.includes(seg)) return roleAuthor("product-owner", po, po.includes(seg) ? seg : null);
    if (MANAGER_PREFIX.has(seg) || mgr.includes(seg)) return roleAuthor("dev-manager", mgr, mgr.includes(seg) ? seg : null);
    if (namesOf(cfg, "coding-agent").includes(seg)) return { name: seg, role: "coding-agent", text: seg };
    if (seg === "task") return { name: null, role: "coding-agent", text: "a builder" };
  }
  if (o.body && PO_BODY.test(o.body)) return roleAuthor("product-owner", po, null);
  return { name: null, role: "person", text: "a person" };
}

/** The NEXT a page shows: one only a person merges ("owner merges") or one the product owner opened for the owner says
 *  "waiting for you", and `needsYou` is set (Home's "Needs you" reads it); anything else is as `factory prs` says. */
export function truthOf(next: { action: string; text: string }, author: Author): { next: { action: string; text: string }; needsYou: boolean } {
  if (next.action === "owner-merges") return { next: { action: next.action, text: "waiting for you" }, needsYou: true };
  if (author.role === "product-owner" && next.action !== "held") return { next: { action: "owner-review", text: "waiting for you" }, needsYou: true };
  return { next, needsYou: false };
}

/** The tasks a pull request is for: its branch's (`task/<n>-...`), then each `Closes #n`, `Fixes #n` or `Part of #n`. */
export function tasksOf(branch: string, body: string): string[] {
  const out: string[] = [];
  const own = branchTask(branch);
  if (own) out.push(own);
  for (const m of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\s+#(\d+)\b/gi)) {
    if (!out.includes(m[1] as string)) out.push(m[1] as string);
  }
  return out;
}

/** The changed files that are protected for project `cfg` (its `protected` patterns, but not its `alwaysAllowed`). */
export function protectedFiles(cfg: Config | null, files: string[]): string[] {
  const pats = Array.isArray(cfg?.protected) ? cfg.protected : DEFAULTS.protected;
  const allowed = Array.isArray(cfg?.alwaysAllowed) ? cfg.alwaysAllowed : DEFAULTS.alwaysAllowed;
  const rxs = pats.filter((x): x is string => typeof x === "string").flatMap((x) => {
    try {
      return [new RegExp(x)];
    } catch {
      return [];
    }
  });
  return files.filter((f) => !allowed.includes(f) && rxs.some((rx) => rx.test(f)));
}

// --- the page -----------------------------------------------------------------------------------------------------------

export interface CheckRow {
  name: string;
  /** passed, failed, running, queued, skipped, neutral */
  state: string;
  url: string | null;
  /** The Actions run it belongs to (the CI page's log), when GitHub says. */
  runId: number | null;
}

export interface FileRow {
  path: string;
  previous: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** The diff of this file; null when GitHub doesn't give one (a binary or a very large file). */
  patch: string | null;
  /** A Markdown file's text at the head, so it can be read rendered; null for any other file. */
  markdown: string | null;
}

export interface MarkerRow {
  kind: "approved" | "changes-asked" | "watched";
  by: string;
  sha: string;
  onHead: boolean;
  at: string;
}

export interface ReviewRow {
  by: string;
  state: string;
  onHead: boolean;
  at: string;
}

export interface CommentRow {
  by: string;
  at: string;
  body: string;
  /** Written by the factory (it starts with one of its markers). */
  factory: boolean;
}

export interface PrPage {
  number: number;
  title: string;
  url: string | null;
  state: string;
  merged: boolean;
  draft: boolean;
  branch: string;
  base: string;
  /** It goes into the project's main branch, so merging it here brings this machine's checkout up to date (#566). */
  intoMain: boolean;
  head: string;
  login: string;
  body: string;
  author: Author;
  tasks: string[];
  checks: { state: string; failing: string[]; list: CheckRow[] };
  review: { state: string; text: string; markers: MarkerRow[]; github: ReviewRow[] };
  protected: { files: string[]; personOnly: boolean; why: string };
  mergeable: boolean | null;
  files: FileRow[];
  filesMore: boolean;
  comments: CommentRow[];
  next: { action: string; text: string };
  needsYou: boolean;
  readAt: string;
}

const MARKER = /<!--\s*(factory-approved|factory-mustfix|pr-watch)\b([^>]*?)-->/g;
const KIND: Record<string, MarkerRow["kind"]> = { "factory-approved": "approved", "factory-mustfix": "changes-asked", "pr-watch": "watched" };
const PERSON_MERGES = "a person merges this one";

function checkState(c: Obj): string {
  const status = str(c.status);
  const conclusion = str(c.conclusion);
  if (status === "queued" || status === "waiting" || status === "pending" || status === "requested") return "queued";
  if (status !== "completed") return "running";
  if (conclusion === "success") return "passed";
  if (conclusion === "skipped") return "skipped";
  if (conclusion === "neutral") return "neutral";
  return "failed";
}

/** The newest run of each check, in name order. */
export function checksOf(runs: Obj[]): CheckRow[] {
  const by = new Map<string, Obj>();
  for (const r of runs) {
    const name = str(r.name);
    const before = by.get(name);
    if (!before || str(r.started_at) >= str(before.started_at)) by.set(name, r);
  }
  return [...by.values()].map((r) => {
    const url = str(r.html_url) || str(r.details_url) || null;
    const m = /\/actions\/runs\/(\d+)/.exec(str(r.details_url) || str(r.html_url));
    return { name: str(r.name), state: checkState(r), url, runId: m ? Number(m[1]) : null };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** One word for the checks: red (one failed), running, green, none (no runs yet). */
export function checksWord(rows: CheckRow[]): string {
  if (!rows.length) return "none";
  if (rows.some((r) => r.state === "failed")) return "red";
  if (rows.some((r) => r.state === "running" || r.state === "queued")) return "running";
  return "green";
}

function markersOf(comments: Obj[], head: string): MarkerRow[] {
  const out: MarkerRow[] = [];
  for (const c of comments) {
    for (const m of str(c.body).matchAll(MARKER)) {
      const sha = /sha=([0-9a-f]{7,40})/.exec(m[2] as string)?.[1] ?? "";
      out.push({ kind: KIND[m[1] as string] as MarkerRow["kind"], by: str(obj(c.user).login), sha: sha.slice(0, 12),
        onHead: Boolean(sha && head && (head.startsWith(sha) || sha.startsWith(head))), at: str(c.created_at) });
    }
  }
  return out;
}

/** The review in a line: the newest factory marker on the head, else the newest GitHub review on it, else none. */
function reviewLine(markers: MarkerRow[], github: ReviewRow[]): { state: string; text: string } {
  const mine = markers.filter((m) => m.onHead).at(-1);
  if (mine?.kind === "changes-asked") return { state: "changes-asked", text: `${mine.by || "the dev manager"} asked for changes` };
  if (mine?.kind === "approved") return { state: "approved", text: `${mine.by || "the dev manager"} approved it` };
  if (mine?.kind === "watched") return { state: "watching", text: `${mine.by || "the dev manager"} reviewed it` };
  const gh = github.filter((r) => r.onHead && r.state !== "COMMENTED").at(-1);
  if (gh?.state === "APPROVED") return { state: "approved", text: `${gh.by} approved it on GitHub` };
  if (gh?.state === "CHANGES_REQUESTED") return { state: "changes-asked", text: `${gh.by} asked for changes on GitHub` };
  return { state: "none", text: "not reviewed yet" };
}

function stripped(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** The page from what GitHub gave (pure, so the shape is easy to see). */
export function pageOf(cfg: Config | null, pr: Obj, files: Obj[], runs: Obj[], reviews: Obj[], comments: Obj[],
  markdown: Map<string, string>, row: Obj | null, now: Date): PrPage {
  const head = str(obj(pr.head).sha);
  const branch = str(obj(pr.head).ref);
  const body = str(pr.body).slice(0, BODY_MAX);
  const labels = list(pr.labels).map((l) => str(l.name));
  const agent = labels.find((l) => l.startsWith("agent:"))?.slice("agent:".length) ?? (str(row?.agent) || null);
  const author = authorOf(cfg, { branch, agent, body });
  const fileRows: FileRow[] = files.map((f) => {
    const path = str(f.filename);
    const patch = str(f.patch);
    return { path, previous: str(f.previous_filename) || null, status: str(f.status) || "modified", additions: Number(f.additions) || 0,
      deletions: Number(f.deletions) || 0, patch: patch ? patch.slice(0, PATCH_MAX) : null, markdown: markdown.get(path) ?? null };
  });
  const prot = protectedFiles(cfg, fileRows.flatMap((f) => [f.path, f.previous ?? ""]).filter(Boolean));
  const saysPerson = body.toLowerCase().includes(PERSON_MERGES);
  const personOnly = prot.length > 0 || saysPerson || author.role !== "coding-agent";
  const why = prot.length ? "It changes protected files, so the agent that wrote it may not merge it."
    : saysPerson ? "Its description says a person merges it."
    : author.role === "coding-agent" ? "A builder or the dev manager may merge it once it is approved and green."
    : `${author.text === "a person" ? "A person" : author.text[0]?.toUpperCase() + author.text.slice(1)} opened it, so a person merges it.`;
  const checkRows = checksOf(runs);
  const word = checksWord(checkRows);
  const markers = markersOf(comments, head);
  const github: ReviewRow[] = reviews.map((r) => ({ by: str(obj(r.user).login), state: str(r.state), onHead: str(r.commit_id) === head,
    at: str(r.submitted_at) }));
  const merged = pr.merged === true;
  const open = str(pr.state) === "open" && !merged;
  const listed = row ? { action: str(row.next) || "none", text: str(row.nextText) || str(row.next) || "none" } : null;
  const fallback = !open ? { action: "none", text: merged ? "merged" : "closed" }
    : pr.draft === true ? { action: "waiting-for-agent", text: "waiting for agent" }
    : personOnly && word === "green" ? { action: "owner-merges", text: "owner merges" }
    : { action: "none", text: "none" };
  const truth = open ? truthOf(listed ?? fallback, author) : { next: fallback, needsYou: false };
  return {
    number: Number(pr.number), title: str(pr.title), url: str(pr.html_url) || null, state: merged ? "merged" : str(pr.state) || "open", merged,
    draft: pr.draft === true, branch, base: str(obj(pr.base).ref), intoMain: str(obj(pr.base).ref) === mainBranchOf(cfg), head, login: str(obj(pr.user).login), body, author, tasks: tasksOf(branch, body),
    checks: { state: word, failing: checkRows.filter((c) => c.state === "failed").map((c) => c.name), list: checkRows },
    review: { ...reviewLine(markers, github), markers, github },
    protected: { files: prot, personOnly, why },
    mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
    files: fileRows, filesMore: files.length >= 100,
    comments: comments.map((c) => ({ by: str(obj(c.user).login), at: str(c.created_at), body: stripped(str(c.body)).slice(0, TEXT_MAX * 2),
      factory: /^\s*<!--/.test(str(c.body)) })).filter((c) => c.body !== ""),
    ...truth,
    readAt: now.toISOString(),
  };
}

// --- reading GitHub -----------------------------------------------------------------------------------------------------

type Answer = ActionResult;

function refusal(status: number, code: string, message: string, fix: string): Answer {
  return { status, body: { code, message, fix } };
}

class GhError extends Error {}

async function gh(p: UiProject, args: string[]): Promise<string> {
  const r = await spawn(["gh", ...args], p.path, envFor(p), READ_MS);
  if (r.code !== 0) throw new GhError((r.stderr || r.stdout).trim().split("\n").at(-1)?.slice(0, 300) || `gh exited ${r.code}`);
  return r.stdout;
}

async function ghJson(p: UiProject, path: string): Promise<unknown> {
  const out = await gh(p, ["api", path]);
  try {
    return JSON.parse(out) as unknown;
  } catch {
    throw new GhError(`gh api ${path} gave no JSON`);
  }
}

const REPO = "repos/{owner}/{repo}";

const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path);

interface Kept {
  head: string;
  ci: string;
  /** What GitHub gave for this head, so a new read of the checks makes the page again without reading it twice. */
  raw: { files: Obj[]; reviews: Obj[]; comments: Obj[]; markdown: Map<string, string> };
  page: PrPage;
}

/** The pages read so far, one per pull request, each kept until its head or its checks change. */
export class PrPages {
  private readonly kept = new Map<string, Kept>();
  private readonly reading = new Map<string, Promise<Answer>>();

  /** GET /api/projects/:p/pull-requests/:n. `row`: the snapshot's row for it (its head and checks), or null. */
  detail(p: UiProject, n: string, row: Obj | null, fresh = false): Promise<Answer> {
    if (!/^\d{1,9}$/.test(n)) return Promise.resolve(refusal(404, "ui_pr_unknown", `#${n} isn't a pull request number.`, "Open a pull request from the list."));
    const key = `${p.id}#${n}`;
    const k = this.kept.get(key);
    if (!fresh && k && row && str(row.head) === k.head && (str(row.ci) || k.ci) === k.ci) {
      return Promise.resolve({ status: 200, body: { project: p.id, cached: true, ...withRow(k.page, row) } });
    }
    const busy = this.reading.get(key);
    if (busy) return busy;
    const next = this.read(p, n, row, k).finally(() => this.reading.delete(key));
    this.reading.set(key, next);
    return next;
  }

  /** Forgets a page (after an action, so the next look reads it again). */
  forget(p: UiProject, n: string): void {
    this.kept.delete(`${p.id}#${n}`);
  }

  private async read(p: UiProject, n: string, row: Obj | null, k: Kept | undefined): Promise<Answer> {
    try {
      const pr = obj(await ghJson(p, `${REPO}/pulls/${n}`));
      if (!pr.number) return refusal(404, "ui_pr_unknown", `There is no pull request #${n} in ${p.name}.`, "Open a pull request from the list.");
      const head = str(obj(pr.head).sha);
      const runs = list(obj(await ghJson(p, `${REPO}/commits/${head}/check-runs?per_page=100`)).check_runs);
      let raw: Kept["raw"];
      if (k && k.head === head) raw = k.raw; // the same head: only the checks (and the state around them) are read again
      else {
        const files = list(await ghJson(p, `${REPO}/pulls/${n}/files?per_page=100`));
        const reviews = list(await ghJson(p, `${REPO}/pulls/${n}/reviews?per_page=100`));
        const comments = list(await ghJson(p, `${REPO}/issues/${n}/comments?per_page=100`));
        const markdown = new Map<string, string>();
        for (const f of files.filter((x) => isMarkdown(str(x.filename)) && str(x.status) !== "removed").slice(0, MARKDOWN_FILES)) {
          const path = str(f.filename);
          try {
            const text = await gh(p, ["api", "-H", "Accept: application/vnd.github.raw", `${REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${head}`]);
            markdown.set(path, text.slice(0, MARKDOWN_MAX));
          } catch {
            // shown as its diff only
          }
        }
        raw = { files, reviews, comments, markdown };
      }
      const page = pageOf(p.config, pr, raw.files, runs, raw.reviews, raw.comments, raw.markdown, row, new Date());
      this.kept.set(`${p.id}#${n}`, { head, ci: str(row?.ci) || page.checks.state, raw, page });
      return { status: 200, body: { project: p.id, cached: false, ...page } };
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      if (/not found|404/i.test(e.message)) return refusal(404, "ui_pr_unknown", `There is no pull request #${n} in ${p.name}.`, "Open a pull request from the list.");
      return refusal(502, "ui_pr_unreadable", `Pull request #${n} can't be read from GitHub (${e.message}).`,
        "Run `gh auth status` (and `gh auth login` if it says so), then open the page again.");
    }
  }
}

/** A kept page with what the snapshot's newer row says about what comes next. */
function withRow(page: PrPage, row: Obj): PrPage {
  if (!str(row.next)) return page;
  const truth = truthOf({ action: str(row.next), text: str(row.nextText) || str(row.next) }, page.author);
  return { ...page, ...truth };
}

// --- acting -------------------------------------------------------------------------------------------------------------

export const PR_ACTIONS = ["merge", "ready", "comment", "request-changes", "close"] as const;
export type PrActionName = (typeof PR_ACTIONS)[number];

/** The message board's part in "request changes": a verdict to the author on the task's thread. */
export interface PrBoard {
  /** Posts `body` to `to` on task `task` (an issue number or b<id>; null: on no task). Null when this project has no
   *  board; else what it did. Throws a {code, message, fix} when the board can't take it. */
  verdict(p: UiProject, task: string | null, to: string, body: string): Promise<string | null>;
}

/** `<!--` made harmless, so the owner's words carry no factory marker (as factory_prs.ts's breakMarkers). */
function breakMarkers(text: string): string {
  return text.replace(/<!--/g, "&lt;!--");
}

function textOf(v: unknown): string {
  return breakMarkers((typeof v === "string" ? v : "").trim()).slice(0, TEXT_MAX);
}

async function runAll(p: UiProject, steps: string[][]): Promise<Answer> {
  const out: string[] = [];
  const shown = steps.map((s) => s.map((w) => (w.length > 60 ? `${w.slice(0, 57)}...` : /\s/.test(w) ? `"${w}"` : w)).join(" ")).join(" then ");
  let last = { code: 0, stdout: "", stderr: "" };
  for (const s of steps) {
    const cmd = s[0] === "factory" ? ["bash", factoryScript(p), ...s.slice(1)] : s;
    last = await spawn(cmd, p.path, envFor(p), ACT_MS);
    out.push(`$ ${s[0] === "gh" && s.includes("-f") ? s.slice(0, s.indexOf("-f")).join(" ") : s.join(" ")}`, (last.stdout + last.stderr).trimEnd());
    if (last.code !== 0) break;
  }
  return resultOf(p, shown, last, out.join("\n").trim());
}

/** POST /api/projects/:p/pull-requests/:n/actions/:name with `body`. Owner only; each needs {confirm: true}. */
export async function prAction(p: UiProject, n: string, name: string, body: unknown, board: PrBoard | null = null): Promise<Answer> {
  if (process.env.FACTORY_AGENT || process.env.FACTORY_LOOP) {
    return refusal(403, "owner_only", `Acting on a pull request is the owner's; ${process.env.FACTORY_AGENT || "this session"} is a factory session.`,
      "Leave it to the owner: ask the dev manager in a <!-- factory-question --> comment on your pull request.");
  }
  if (!(PR_ACTIONS as readonly string[]).includes(name)) {
    return refusal(404, "ui_action_unknown", `A pull request has no action ${name}.`, `Its actions: ${PR_ACTIONS.join(", ")}.`);
  }
  if (!/^\d{1,9}$/.test(n)) return refusal(404, "ui_pr_unknown", `#${n} isn't a pull request number.`, "Open a pull request from the list.");
  const action = name as PrActionName;
  const b = obj(body);
  if (b.confirm !== true) {
    return refusal(400, "confirm_needed", `To ${action.replace("-", " ")} #${n} changes it on GitHub, so it needs a confirm.`, 'Send {"confirm": true} (the page asks you first).');
  }
  const text = textOf(b.text);
  if ((action === "comment" || action === "request-changes") && !text) {
    return refusal(400, "ui_text_needed", action === "comment" ? "A comment needs some words." : "Say what should change.",
      'Send {"confirm": true, "text": "<what you want>"}.');
  }
  let pr: Obj;
  try {
    pr = obj(await ghJson(p, `${REPO}/pulls/${n}`));
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    return refusal(502, "ui_pr_unreadable", `Pull request #${n} can't be read from GitHub (${e.message}), so nothing was done.`,
      "Run `gh auth status` (and `gh auth login` if it says so), then try again.");
  }
  if (!pr.number) return refusal(404, "ui_pr_unknown", `There is no pull request #${n} in ${p.name}.`, "Open a pull request from the list.");
  const head = str(obj(pr.head).sha);
  if (str(pr.state) !== "open" || pr.merged === true) {
    return refusal(409, "pr_not_open", `#${n} is ${pr.merged === true ? "merged" : "closed"}, so nothing was done.`, "Read the list again.");
  }
  const seen = str(b.head);
  if (seen && !head.startsWith(seen)) {
    return refusal(409, "pr_changed", `#${n} changed since you looked: its head is now ${head.slice(0, 12)}, not ${seen.slice(0, 12)}.`,
      "Look at the page again (it reads the new commit), then try again.");
  }
  if (action === "merge") {
    if (pr.draft === true) return refusal(409, "pr_draft", `#${n} is a draft, so it can't be merged.`, "Mark it ready first, then merge it.");
    let word: string;
    let failing: string[];
    try {
      const rows = checksOf(list(obj(await ghJson(p, `${REPO}/commits/${head}/check-runs?per_page=100`)).check_runs));
      word = checksWord(rows);
      failing = rows.filter((r) => r.state === "failed").map((r) => r.name);
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      return refusal(502, "ui_pr_unreadable", `The checks of #${n} can't be read from GitHub (${e.message}), so nothing was merged.`, "Try again in a moment.");
    }
    if (word === "red") return refusal(409, "checks_failed", `Checks failed on #${n}: ${failing.join(", ")}.`, "Open its checks and their logs; merge once they pass.");
    if (word !== "green") {
      return refusal(409, "checks_pending", `The checks on #${n} ${word === "none" ? "haven't run yet" : "are still running"}.`, "Wait for them to pass, then merge.");
    }
    const merged = await runAll(p, [["factory", "owner", "merge", n, "--head", head]]);
    if (merged.status !== 200 || str(obj(pr.base).ref) !== mainOf(p)) return merged;
    // what was merged applies on this machine once its checkout has it (#566): moved forward when that is safe
    const checkout = await bringUpToDate(p);
    const said = [str(merged.body.output), checkout.message, checkout.problem?.fix ?? ""].filter(Boolean).join("\n");
    return { status: 200, body: { ...merged.body, output: said, checkout } };
  }
  if (action === "ready") {
    if (pr.draft !== true) return refusal(409, "pr_not_draft", `#${n} is already ready for review.`, "Read the page again.");
    return runAll(p, [["gh", "pr", "ready", n]]);
  }
  if (action === "comment") return runAll(p, [["gh", "api", "-X", "POST", `${REPO}/issues/${n}/comments`, "-f", `body=${text}`]]);
  if (action === "close") {
    const why = textOf(b.text);
    const steps = why ? [["gh", "api", "-X", "POST", `${REPO}/issues/${n}/comments`, "-f", `body=Closed by the owner: ${why}`]] : [];
    return runAll(p, [...steps, ["gh", "api", "-X", "PATCH", `${REPO}/pulls/${n}`, "-f", "state=closed"]]);
  }
  // request changes: the dev manager's must-fix on this head, then the author on the board
  const r = await runAll(p, [["gh", "api", "-X", "POST", `${REPO}/issues/${n}/comments`, "-f",
    `body=<!-- factory-mustfix sha=${head} -->\n**The owner asks for changes** on ${head.slice(0, 12)}.\n\n${text}`]]);
  if (r.status !== 200) return r;
  const labels = list(pr.labels).map((l) => str(l.name));
  const author = authorOf(p.config, { branch: str(obj(pr.head).ref), agent: labels.find((l) => l.startsWith("agent:"))?.slice(6) ?? null, body: str(pr.body) });
  const said = [str(r.body.output), `The must-fix is on #${n}, so ${author.text} reworks it.`];
  if (board && author.name) {
    const task = tasksOf(str(obj(pr.head).ref), str(pr.body))[0] ?? null;
    try {
      const done = await board.verdict(p, task, author.name, `PR #${n}: the owner asks for changes.\n\n${text}`);
      if (done) said.push(done);
    } catch (e) {
      const x = obj(e);
      said.push(`The message board didn't take the message to ${author.name} (${str(x.message) || String(e)}); the comment on #${n} still asks for the changes.`);
    }
  }
  return { status: 200, body: { ...r.body, output: said.filter(Boolean).join("\n") } };
}
