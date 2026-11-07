// A task whose pull request merged is closed on the board (#536), even when its agent skipped the step or its session
// died right after the merge. `factory board sweep` (factory_board.ts), which the dev manager's pass runs after the
// mirror, calls closeMerged before it frees any stale claim, so a merged task is never sent back to ready.
//
// "Linked": the pull request's branch names the task (`task/b25-...`, `b25-...`, `task/7-...`), or its title or body
// says `b25:` (or starts with `#7:`), or `Closes b25` / `Closes #7` (fixes and resolves too). One list call to GitHub
// (the 100 pull requests closed most recently), and none while nothing of the project's is in progress or in review.
//
// A PRD change's card (#578: a note with a `PRD change: #62` line, which the tasks from that change wait for) is closed
// the same way once its pull request merges, so those tasks become ready. One call per open card, none while there is none.
import { prdChangeIn } from "./core/domain/task.ts";
import { branchTask } from "./factory_config.ts";
import type { Board, Gh, Task } from "../message-board/src/index.ts";
import { Numbers } from "../message-board/src/index.ts";

/** What the list of pull requests gives for one. */
export interface MergedPull {
  number: number;
  title: string;
  body: string;
  branch: string;
  mergedAt: Date;
}

export interface ClosedAfterMerge {
  id: number;
  label: string;
  pull: number;
}

const REASON = "closed after merge by the dev manager";
const CLOSES = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+`;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether pull request `p` names the task people call `label` ("b25" for a task made on the board, "#7" for issue 7). */
export function names(label: string, p: Pick<MergedPull, "title" | "body" | "branch">): boolean {
  const text = `${p.title}\n${p.body}`;
  const board = /^b(\d+)$/.exec(label)?.[1];
  if (board) {
    const b = `b${board}`;
    return new RegExp(`^(?:task/)?${b}(?:-|$)`, "i").test(p.branch)
      || new RegExp(`(?<![\\w#/])${b}:`, "i").test(text)
      || new RegExp(`${CLOSES}${b}\\b`, "i").test(text);
  }
  const issue = /^#(\d+)$/.exec(label)?.[1];
  if (!issue) return false;
  return branchTask(p.branch) === issue
    || new RegExp(`^#?${issue}\\s*:`).test(p.title.trim())
    || new RegExp(`${CLOSES}${escape(`#${issue}`)}\\b`, "i").test(text);
}

/** The merged pull requests in GitHub's list of closed ones, newest first. */
export function mergedPulls(gh: Gh, repo: string): MergedPull[] {
  const list = gh.get(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
  const out: MergedPull[] = [];
  for (const raw of Array.isArray(list) ? (list as unknown[]) : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const merged = typeof r.merged_at === "string" ? new Date(r.merged_at) : null;
    if (typeof r.number !== "number" || !merged || Number.isNaN(merged.getTime())) continue;
    const head = typeof r.head === "object" && r.head !== null ? (r.head as Record<string, unknown>).ref : "";
    out.push({ number: r.number, title: typeof r.title === "string" ? r.title : "", body: typeof r.body === "string" ? r.body : "",
      branch: typeof head === "string" ? head : "", mergedAt: merged });
  }
  return out;
}

/** The project's tasks and bugs in progress or in review: their ref is one of `repo`'s issues or cards, or they have none. */
export async function open(board: Board, repo: string): Promise<Task[]> {
  const r = repo.toLowerCase();
  return (await board.tasks()).filter((t) => (t.kind === "task" || t.kind === "bug") && (t.status === "in_progress" || t.status === "in_review")
    && (t.ref === null || t.ref.toLowerCase().startsWith(`github:${r}#`) || t.ref.toLowerCase().startsWith(`factory:${r}/`)));
}

/** Close each of `tasks` that a merged pull request in `pulls` names: done, its claim released (taken back from its
 * holder), with the reason on its events. A task someone moved on the board after that pull request merged (sent back to
 * ready to be done again) is left as it is. Returns what it closed; a task the board refuses is said on stderr and left. */
export async function closeMerged(board: Board, repo: string, tasks: Task[], pulls: MergedPull[]): Promise<ClosedAfterMerge[]> {
  const numbers = new Numbers(repo);
  const closed: ClosedAfterMerge[] = [];
  for (const t of tasks) {
    const label = numbers.label(t);
    const p = pulls.find((x) => names(label, x));
    if (!p) continue;
    const moved = await board.events(0, 5000, { since: p.mergedAt, kind: "task.moved" });
    if (moved.some((e) => e.subject === `task:${t.id}`)) continue;
    try {
      await board.move(t.id, { to: "done", reason: `${REASON}: pull request #${p.number} merged` });
      closed.push({ id: t.id, label, pull: p.number });
    } catch (e) {
      process.stderr.write(`could not close ${label} after pull request #${p.number} merged: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return closed;
}

/** An open PRD change card (#578): its board id, its label (b12) and the pull request it is for. */
export interface PrdCard {
  id: number;
  label: string;
  pull: number;
}

/** The project's open PRD change cards: cards that aren't work (notes) with a `PRD change: #n` line in the title or body. */
export async function prdCards(board: Board, repo: string): Promise<PrdCard[]> {
  const r = repo.toLowerCase();
  const numbers = new Numbers(repo);
  const out: PrdCard[] = [];
  for (const t of await board.tasks({ limit: 100_000 })) {
    if (t.kind === "task" || t.kind === "bug" || t.kind === "epic" || t.status === "done") continue;
    const ref = (t.ref ?? "").toLowerCase();
    if (!(ref.startsWith(`github:${r}#`) || ref.startsWith(`factory:${r}/`))) continue;
    const pr = prdChangeIn(`${t.title}\n${t.body}`);
    if (pr !== null) out.push({ id: t.id, label: numbers.label(t), pull: Number(pr) });
  }
  return out;
}

/** Whether pull request `n` of `repo` has merged: GitHub's issue for it carries pull_request.merged_at. Throws a GithubError. */
export function pullMerged(gh: Gh, repo: string, n: number): boolean {
  const i = gh.get(`repos/${repo}/issues/${n}`);
  const pull = typeof i === "object" && i !== null ? (i as Record<string, unknown>).pull_request : null;
  return typeof pull === "object" && pull !== null && typeof (pull as Record<string, unknown>).merged_at === "string";
}

/** Close each of `cards` whose pull request merged, saying why on its events; the tasks that wait for it are then ready.
 * Returns what it closed; a card the board refuses is said on stderr and left. A GithubError stops it and is thrown. */
export async function closeMergedPrds(board: Board, repo: string, cards: PrdCard[], gh: Gh): Promise<PrdCard[]> {
  const closed: PrdCard[] = [];
  for (const c of cards) {
    if (!pullMerged(gh, repo, c.pull)) continue;
    try {
      await board.move(c.id, { to: "done", reason: `closed by the dev manager: its pull request #${c.pull} merged` });
      closed.push(c);
    } catch (e) {
      process.stderr.write(`could not close the PRD change ${c.label} after pull request #${c.pull} merged: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return closed;
}
