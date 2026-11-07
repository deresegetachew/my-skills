// The TaskTracker port on GitHub Issues (decision 0003, #377): each task is an open issue, its labels carry the state
// (`tasks.labels`: ready, in progress, in review, blocked, and agent:<name> for who has it), and a claim is a
// `<!-- factory-claim agent=<name> machine=<id> -->` comment; when two claim at once the earliest comment since the last
// release wins. The calls are the ones `factory issues` always made, moved here from factory_issues.ts; the helpers other
// commands still share (readyIssues, releaseIssue, the gh calls) stay there until their own step.
import { claimRecord } from "../../../factory_budget.ts";
import { citesIn } from "../../../factory_cites.ts";
import { type Config, taskLabels } from "../../../factory_config.ts";
import { addLabels, claimSettleSeconds, claimWinner, comment, gh, ghAll, humanComments, type Issue, names, openDependencies,
  isEpic, ownIssue, prdWait, readyIssues, releaseIssue, removeLabel, sortedByOrder, taskIssues, waitingForSlot } from "../../../factory_issues.ts";
import { sleepSync } from "../../../factory_lib.ts";
import { claimCopy, holderIsMe, holderName, leasesOn } from "../../../factory_leases.ts";
import { type Claimant, isMe } from "../../domain/claim.ts";
import { CoreError } from "../../domain/error.ts";
import { type Epic, parseEpic } from "../../domain/epic.ts";
import { checkClaim, dependencies, prdSkipNote, type Task, type TaskState, tickTodo, todos } from "../../domain/task.ts";
import type { Filed, NewTask, Picked, SkippedForPrd, TaskTracker } from "../../ports/task_tracker.ts";

/** How long a task claim on the board lasts when nothing releases it (#412): a week. A release, a block, giving it back and
 * the dev manager's sweep of a silent agent end it sooner. */
const TASK_SECONDS = 7 * 24 * 3600;

export class GithubTaskTracker implements TaskTracker {
  constructor(private readonly cfg: Config) {}

  list(): Task[] {
    const prds = new Map<number, boolean>();
    return sortedByOrder(taskIssues().filter((i) => !isEpic(i))).map((i) => this.task(i, prds));
  }

  epics(): Epic[] {
    const all = taskIssues("all");
    const open = new Set(all.filter((i) => i.state === "open" && !isEpic(i)).map((i) => String(i.number)));
    return all.filter(isEpic).sort((a, b) => a.number - b.number).map((i) => ({
      ...parseEpic({ number: i.number, title: i.title, body: i.body ?? "", labels: [...names(i)], closed: i.state !== "open", openIds: open }),
      url: typeof i.html_url === "string" ? i.html_url : null }));
  }

  show(id: string): string {
    const n = number(id);
    const i = issue(n);
    let text = `#${n} ${i.title}  [${[...names(i)].sort().join(", ")}]  ${i.state}\n\n${i.body || ""}`;
    for (const c of humanComments(n)) {
      const who = c.user?.login || "someone";
      text += `\n\n--- comment by ${who} ---\n${(c.body as string).trim()}`;
    }
    return text;
  }

  next(skipped: SkippedForPrd[] = []): Task | null {
    const prds = new Map<number, boolean>();
    const held: { issue: Issue; pr: string }[] = [];
    const i = readyIssues(this.cfg, taskIssues(), held, prds)[0];
    for (const h of held) skipped.push({ name: `#${h.issue.number}`, pr: h.pr });
    return i ? this.task(i, prds) : null;
  }

  pick(who: Claimant): Picked {
    const L = taskLabels(this.cfg);
    // Another machine's agent may have the same name: its issue is its, not ours to resume (#45).
    const own = taskIssues("open", L.agentPrefix + who.agent)
      .filter((i) => names(i).has(L.inProgress) && ownIssue(i.number, who.agent, who.machine));
    if (own.length) {
      const i = sortedByOrder(own)[0] as Issue;
      const full = waitingForSlot(this.cfg, i);
      // Its branch is pushed but the PR can't open yet: wait instead of a session that the gate stops, and don't take
      // new work meanwhile. The next pick after a merge frees a slot opens the PR.
      if (full) return { task: null, note: `#${i.number} is ready on its branch and waits for a pull-request slot (${full}).` };
      return { task: this.task(i, new Map()) }; // carry on with what this agent already holds
    }
    // the ready ones held back only for their PRD change (#578) are named in the note, claimed or not
    const held: { issue: Issue; pr: string }[] = [];
    const prds = new Map<number, boolean>();
    const ready = readyIssues(this.cfg, taskIssues(), held, prds);
    const note = prdSkipNote(held.map((h) => ({ name: `#${h.issue.number}`, pr: h.pr })));
    for (const i of ready) if (this.take(i, who)) return withNote({ task: { ...this.task(i, prds), state: "in-progress", holders: [who.agent] } }, note);
    return withNote({ task: null }, note);
  }

  claim(id: string, who: Claimant): Task {
    const L = taskLabels(this.cfg);
    const n = number(id);
    const i = gh<Issue | null>("GET", `repos/{owner}/{repo}/issues/${n}`, undefined, true);
    if (!i || i.state !== "open" || "pull_request" in i) throw notFound(id);
    if (isEpic(i)) throw new CoreError("issue-epic", `#${n} is an epic, not a task.`, "Claim one of the tasks it lists instead, or run `factory next`.");
    const t = this.task(i, new Map());
    const [check, open] = checkClaim(t, who.agent, () => ownIssue(n, who.agent, who.machine),
      () => openDependencies(i, new Set(taskIssues().map((x) => x.number)), new Map()).map(String));
    if (check === "mine") return t;
    if (check === "taken") {
      throw new CoreError("issue-taken", `#${n} is already taken by ${t.holders[0] ?? "another agent"}.`,
        "Pick another issue, or ask the dev manager to release it with `factory issues release`.");
    }
    if (check === "blocked") throw new CoreError("issue-blocked", `#${n} is blocked.`, "Wait for the dev manager to unblock it, or pick another issue.");
    if (check === "prd") {
      throw new CoreError("issue-waits-for-prd", `#${n} waits for its PRD change, PR #${open[0]}, to merge.`,
        `Pick another issue: #${n} is ready once the owner merges PR #${open[0]}. To build it now, the owner takes the \`PRD change:\` line out of #${n}.`);
    }
    if (check === "waiting") {
      throw new CoreError("issue-blocked", `#${n} waits for ${open.map((d) => "#" + d).join(", ")}.`,
        "Build the issues it depends on first, or pick another issue.");
    }
    if (check === "not-ready") {
      throw new CoreError("issue-not-ready", `#${n} is not labelled ${L.ready}.`, "Ask the dev manager to make it ready, or pick another issue.");
    }
    if (!this.take(i, who)) throw new CoreError("issue-taken", `Another agent claimed #${n} first.`, "Pick another issue.");
    return { ...t, state: "in-progress", holders: [who.agent] }; // as the claim left it, without asking GitHub again
  }

  release(id: string, reason = ""): void {
    releaseIssue(this.cfg, number(id), reason);
  }

  setState(id: string, state: "in-review" | "done"): string {
    const L = taskLabels(this.cfg);
    const n = number(id);
    if (state === "done") {
      gh("PATCH", `repos/{owner}/{repo}/issues/${n}`, { state: "closed" });
      return `#${n} is done: closed.`;
    }
    const have = names(issue(n));
    if (have.has(L.inReview) && !have.has(L.inProgress)) return `#${n} was already in review: nothing changed.`;
    addLabels(n, [L.inReview]);
    removeLabel(n, L.inProgress);
    const gone = have.has(L.inProgress) ? `, removed ${L.inProgress}` : "";
    return `#${n} is in review: added ${L.inReview}${gone}.`;
  }

  tick(id: string, index: number): void {
    const n = number(id);
    gh("PATCH", `repos/{owner}/{repo}/issues/${n}`, { body: tickTodo(issue(n).body || "", index, `#${n}`) });
  }

  block(id: string, reason: string): void {
    const L = taskLabels(this.cfg);
    const n = number(id);
    const i = issue(n);
    for (const x of names(i)) if (x.startsWith(L.agentPrefix) || x === L.inProgress || x === L.ready) removeLabel(n, x);
    addLabels(n, [L.blocked]);
    leasesOn(this.cfg)?.drop(`task.${n}`); // and its claim on the board (#412)
    // A block ends the claim too, so whoever takes it after the unblock wins it (factory-release).
    const held = [...names(i)].filter((x) => x.startsWith(L.agentPrefix)).map((x) => x.slice(L.agentPrefix.length));
    comment(n, `<!-- factory-release agent=${held[0] ?? "none"} -->\n**Blocked:** ${reason}`);
  }

  /** Its claims don't run out: nothing to keep. */
  keep(_id: string): boolean {
    return false;
  }

  file(task: NewTask): Filed {
    const L = taskLabels(this.cfg);
    const data: Record<string, unknown> = { title: task.title, body: task.body, labels: [L.ready, ...(task.tags ?? [])] };
    if (task.group) {
      const ms = new Map(ghAll<{ title: string; number: number }>("repos/{owner}/{repo}/milestones?state=all").map((m) => [m.title, m.number]));
      if (!ms.has(task.group)) ms.set(task.group, gh<{ number: number }>("POST", "repos/{owner}/{repo}/milestones", { title: task.group }).number);
      data.milestone = ms.get(task.group);
    }
    const i = gh<Issue>("POST", "repos/{owner}/{repo}/issues", data);
    return { id: String(i.number), url: String(i.html_url) };
  }

  /** Labels and a claim comment for issue `i`; true when this claim won. With claims on the board (#412) the board decides
   * first: a task another agent holds there is left untouched, and the winner writes its labels and comment once. */
  private take(i: Issue, who: Claimant): boolean {
    const L = taskLabels(this.cfg);
    const mine = L.agentPrefix + who.agent;
    const n = i.number;
    const bus = leasesOn(this.cfg);
    if (bus) {
      const took = bus.claim(`task.${n}`, holderName(who.agent, who.machine), TASK_SECONDS);
      if (!took.held && !holderIsMe(took.holder, who.agent, who.machine)) return false;
      addLabels(n, [L.inProgress, mine]);
      removeLabel(n, L.ready);
      if (!claimCopy(this.cfg)) return true; // the board only (messaging.githubCopy): the labels, no comment
      const where = who.machine ? ` machine=${who.machine}` : "";
      comment(n, `<!-- factory-claim agent=${who.agent}${where} -->\n**${who.agent}** is working on this.\n${claimRecord(i.body)}`);
      return true;
    }
    addLabels(n, [L.inProgress, mine]);
    removeLabel(n, L.ready);
    const where = who.machine ? ` machine=${who.machine}` : "";
    // The budget the issue has now goes into the claim, so a later edit of the issue does not move it (#183).
    comment(n, `<!-- factory-claim agent=${who.agent}${where} -->\n**${who.agent}** is working on this.\n${claimRecord(i.body)}`);
    sleepSync(claimSettleSeconds()); // let a simultaneous claim land, then let the earliest comment decide
    const won = claimWinner(n);
    const claim = won ? { agent: won[0], machine: won[1] } : null;
    if (isMe(claim, who.agent, who.machine)) return true;
    if (!claim || claim.agent !== who.agent) removeLabel(n, mine); // someone else was first; their labels stay
    // (a winner with our own name on another machine owns that label too: leave it on)
    return false;
  }

  /** Issue `i` as a task. `prds` caches the PRD changes looked up, so a list asks GitHub once per pull request. */
  private task(i: Issue, prds: Map<number, boolean>): Task {
    const L = taskLabels(this.cfg);
    const have = names(i);
    const state: TaskState = i.state !== "open" ? "done" : have.has(L.inProgress) ? "in-progress" : have.has(L.inReview) ? "in-review" :
      have.has(L.blocked) ? "blocked" : have.has(L.ready) ? "ready" : "new";
    const body = i.body ?? "";
    return { id: String(i.number), title: i.title, state, holders: [...have].filter((x) => x.startsWith(L.agentPrefix))
      .map((x) => x.slice(L.agentPrefix.length)), dependsOn: dependencies(body, "issue"), todos: todos(body),
    group: i.milestone?.title ?? "", tags: [...have], cites: citesIn(body), ...this.prd(i, state, prds) };
  }

  /** `waitsForPrd` for a ready or new task whose PRD change hasn't merged (#578). One held, blocked, in review or done waits
   * for nothing, and costs no look. */
  private prd(i: Issue, state: TaskState, prds: Map<number, boolean>): { waitsForPrd?: string } {
    const pr = state === "ready" || state === "new" ? prdWait(i.body ?? "", prds) : null;
    return pr === null ? {} : { waitsForPrd: pr };
  }
}

function withNote(p: Picked, note: string | undefined): Picked {
  return note ? { ...p, note } : p;
}

function notFound(id: string): CoreError {
  return new CoreError("issue-not-found", `#${id} is not an open task issue.`, "Check the number with `factory issues` and try again.");
}

/** The issue number an id names; a plan id (1.3) or anything else is not one. */
function number(id: string): number {
  if (!/^\d+$/.test(id)) throw notFound(id);
  return Number(id);
}

function issue(n: number): Issue {
  return gh<Issue>("GET", `repos/{owner}/{repo}/issues/${n}`);
}
