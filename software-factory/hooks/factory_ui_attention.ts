// The web UI's "Needs attention" list (#579): anything stuck, worked out from what the server already reads, never from
// a GitHub call of its own. Its inputs are the views (the board's or the snapshot's tasks and epics, the snapshot's pull
// requests and CI), the agents read live (heartbeats), the pull requests that left the snapshot's open list, and the
// product owner's open asks. Each item says why in plain words and carries one action the page runs through the
// confirm it uses elsewhere: Release or Close a task (POST .../tasks/:id/actions/release|close), Close an epic (the same
// route with the epic's id), Start an agent (POST .../agents/:name/start), Start work (one line to a coding agent's
// session, POST .../agents/:name/chat, which runs `factory say`), or open a page (its output, the PR, CI, Health).
//
// The cases, in the order the list shows them:
//   board-down      the message board can't be reached
//   runners-down    every CI runner is offline
//   agent-down      an agent is down while it holds a task                                 Start
//   role-down       no dev manager or product owner runs while its queue has items        Start
//   task-pr-gone    a task whose PR is no longer open (merged or closed) isn't done        Close
//   task-quiet      a task in progress whose holder is down, or that nothing moved for
//                   attention.taskQuietMinutes                                             Release
//   session-long    a session "working" longer than attention.<role>.maxMinutes          open its output
//   task-spinning   a task being built whose tokens or working time pass attention.spinFactor
//                   times the done tasks' median (with 5 done tasks or more), or that had
//                   attention.spinReviewRounds review rounds with must-fixes, or whose last
//                   attention.spinFailedCi CI runs failed (#580; factory_task_cost.ts)       open its output
//   idle-ready      a coding agent idle for attention.idleWithReadyMinutes while a task
//                   it may take is ready (#591); its session may hold a message typed
//                   but not sent                                                           Start work
//   epic-done       an epic whose tasks are all done is still open                         Close
//   prd-open        a PRD change is still an open PR while tasks are being built (#578)    open the PR
//   pr-waiting      a PR open longer than attention.prWaitHours with red checks, no
//                   review, a must-fix nobody picked up, or a merge only a person can do  open the PR
//
// The thresholds are settings (factory_settings_schema.ts, the settings page's Web UI table).
import type { Config } from "./factory_config.ts";
import type { Agent, Problem } from "./factory_ui_data.ts";
import { SETTINGS } from "./factory_settings_schema.ts";
import type { Views } from "./factory_ui_views.ts";
import { type Medians, spinReason, type TaskCost } from "./factory_task_cost.ts";

export const ATTENTION_KINDS = ["board-down", "runners-down", "agent-down", "role-down", "task-pr-gone", "task-quiet", "session-long", "task-spinning", "idle-ready",
  "epic-done", "prd-open", "pr-waiting"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** The one thing an item offers. A task action (release, close) runs on `task`; start on `agent`; say sends `text` to
 *  `agent`'s session; open goes to `link`. */
export interface AttentionAction {
  kind: "release" | "close" | "start" | "say" | "open";
  label: string;
  task?: string;
  agent?: string;
  /** For say: the one line sent (`/next-task`). */
  text?: string;
  /** For open: the page (`agent:fasil`, `pr:21`, `view:ci`, `page:health`). */
  link?: string;
}

export interface AttentionItem {
  /** Stable while the cause lasts: kind and subject (`task-quiet:7`). */
  id: string;
  kind: AttentionKind;
  title: string;
  reason: string;
  task: string | null;
  agent: string | null;
  pr: number | null;
  epic: string | null;
  action: AttentionAction;
}

/** A pull request that left the snapshot's open list (factory_ui_ops.ts pullsGone): merged or closed. */
export interface GonePull {
  number: number;
  title: string;
  task: string | null;
  at: string;
}

export interface Limits {
  taskQuietMinutes: number;
  prWaitHours: number;
  maxMinutes: Record<string, number>;
  idleWithReadyMinutes: number;
  spinFactor: number;
  spinReviewRounds: number;
  spinFailedCi: number;
}

export interface AttentionInput {
  config: Config | null;
  views: Views;
  /** The agents read live; null while they aren't read yet or can't be (then no agent case is judged). */
  agents: Agent[] | null;
  gone: GonePull[];
  /** The product owner's open asks. */
  productAsks: number;
  /** What each task took (#580) and the done tasks' medians; null or left out while not read (no spinning is judged). */
  costs?: { tasks: TaskCost[]; medians: Medians } | null;
  now?: number;
}

const ROLES = ["coding-agent", "dev-manager", "product-owner"] as const;
const ROLE_WORD: Record<string, string> = { "coding-agent": "a coding agent", "dev-manager": "a dev manager", "product-owner": "a product owner" };
const ROLE_TITLE: Record<string, string> = { "dev-manager": "dev manager", "product-owner": "product owner" };
const DOWN = new Set(["down", "silent"]);
const BUILDING = new Set(["in-progress", "in-review"]);
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function whole(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : dflt;
}

function dflt(key: string): number {
  const v = SETTINGS[key]?.default;
  return typeof v === "number" ? v : 1;
}

/** The thresholds project `cfg` sets, else their defaults. */
export function limitsOf(cfg: Config | null): Limits {
  const a = obj(cfg?.attention);
  const maxMinutes: Record<string, number> = {};
  for (const r of ROLES) maxMinutes[r] = whole(obj(a[r]).maxMinutes, dflt(`attention.${r}.maxMinutes`));
  return { taskQuietMinutes: whole(a.taskQuietMinutes, dflt("attention.taskQuietMinutes")), prWaitHours: whole(a.prWaitHours, dflt("attention.prWaitHours")),
    maxMinutes, idleWithReadyMinutes: whole(a.idleWithReadyMinutes, dflt("attention.idleWithReadyMinutes")),
    spinFactor: whole(a.spinFactor, dflt("attention.spinFactor")), spinReviewRounds: whole(a.spinReviewRounds, dflt("attention.spinReviewRounds")),
    spinFailedCi: whole(a.spinFailedCi, dflt("attention.spinFailedCi")) };
}

/** A task's name as the pages write it: `#7` for an issue, `b3` for a task made on the board. */
function named(id: string): string {
  return /^\d+$/.test(id) ? `#${id}` : id;
}

function minutesSince(iso: string | null | undefined, now: number): number | null {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(at) ? null : Math.max(Math.floor((now - at) / 60_000), 0);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The names a role runs as (`agents`, `roles.<role>.names`), only valid ones: a bad name never stops the server. */
function namesOf(cfg: Config | null, role: string): string[] {
  const raw = role === "coding-agent" ? cfg?.agents : obj(obj(cfg?.roles)[role]).names;
  return (Array.isArray(raw) ? raw : []).filter((n): n is string => typeof n === "string" && NAME.test(n));
}

/** Everything that needs attention in one project, in the order the page shows it. */
export function attentionOf(i: AttentionInput): AttentionItem[] {
  const now = i.now ?? Date.now();
  const lim = limitsOf(i.config);
  const out: AttentionItem[] = [];
  const v = i.views;
  const tasks = v.tasks.tasks;
  const item = (kind: AttentionKind, key: string, x: Omit<AttentionItem, "id" | "kind" | "task" | "agent" | "pr" | "epic"> & Partial<AttentionItem>): void => {
    out.push({ id: `${kind}:${key}`, kind, task: null, agent: null, pr: null, epic: null, ...x });
  };

  // the board or the CI runners down: only a person can bring them back
  const board = [...v.tasks.problems, ...v.problems].find((p: Problem) => p.code === "ui_board_down" || p.code === "ui_board_unreachable");
  if (board) {
    item("board-down", "board", { title: "The message board can't be reached", reason: `${board.message} ${board.fix}`.trim(),
      action: { kind: "open", label: "Open Health", link: "page:health" } });
  }
  const runners = v.ci.runners;
  if (v.ci.mode !== "github" && runners.length && runners.every((r) => r.state === "offline")) {
    item("runners-down", "ci", { title: "Every CI runner is offline", reason: `${plural(runners.length, "runner")} and none online, so the checks can't run.`,
      action: { kind: "open", label: "Open CI", link: "view:ci" } });
  }

  const agents = i.agents;
  const row = new Map((agents ?? []).map((a) => [a.name, a]));
  const isDown = (name: string): boolean => {
    const a = row.get(name);
    return !a || DOWN.has(a.state);
  };

  // an agent down while it holds work
  if (agents) {
    const held = new Map<string, string[]>();
    for (const t of tasks) for (const h of t.holders) if (t.state !== "done") held.set(h, [...(held.get(h) ?? []), t.id]);
    // only one of the project's agents can be started; a task another holder keeps shows as held below (Release)
    const known = new Set([...ROLES.flatMap((r) => namesOf(i.config, r)), ...agents.map((a) => a.name)]);
    for (const [name, ids] of held) {
      if (!isDown(name) || !known.has(name)) continue;
      item("agent-down", name, { title: `${name} is down`, agent: name, task: ids[0] ?? null,
        reason: `${name} ${row.has(name) ? "is down" : "isn't running on any machine"} but holds ${ids.map(named).join(", ")}.`,
        action: { kind: "start", label: `Start ${name}`, agent: name } });
    }
    // a role down while its queue has items
    const queue: Record<string, number> = { "dev-manager": v.pulls.pulls.filter((p) => !p.draft).length, "product-owner": i.productAsks };
    for (const role of ["dev-manager", "product-owner"]) {
      const names = namesOf(i.config, role);
      const first = names[0];
      const n = queue[role] ?? 0;
      if (!first || !n) continue;
      const up = (agents ?? []).some((a) => a.role === role && !DOWN.has(a.state)) || names.some((x) => !isDown(x));
      if (up) continue;
      const what = role === "dev-manager" ? `${plural(n, "pull request")} ${n === 1 ? "waits" : "wait"} for review` : `${plural(n, "ask")} ${n === 1 ? "waits" : "wait"} for it`;
      item("role-down", role, { title: `No ${ROLE_TITLE[role]} is running`, agent: first, reason: `${what}, and no ${ROLE_TITLE[role]} runs to take ${n === 1 ? "it" : "them"}.`,
        action: { kind: "start", label: `Start ${first}`, agent: first } });
    }
  }

  // a task whose PR is gone (merged or closed) but that isn't done
  const goneOf = new Map<string, GonePull>();
  for (const g of i.gone) if (g.task && !goneOf.has(g.task)) goneOf.set(g.task, g);
  const flagged = new Set<string>();
  for (const t of tasks) {
    if (!BUILDING.has(t.state) || t.pr) continue;
    const g = goneOf.get(t.id);
    if (!g) continue;
    // claimed again since that PR went (one closed without merging, the task taken up again): its new PR isn't open yet
    const claimed = t.claimedAt ? Date.parse(t.claimedAt) : NaN;
    if (!Number.isNaN(claimed) && claimed > Date.parse(g.at)) continue;
    flagged.add(t.id);
    item("task-pr-gone", t.id, { title: `${named(t.id)} ${t.title}`, task: t.id, pr: g.number,
      reason: `PR #${g.number} is no longer open (merged or closed), but ${named(t.id)} is still ${t.stateText.toLowerCase() || t.state}.`,
      action: { kind: "close", label: "Close", task: t.id } });
  }

  // a task held but not moving
  if (agents) {
    for (const t of tasks) {
      if (t.state !== "in-progress" || !t.holders.length || flagged.has(t.id)) continue;
      const holder = t.holders[0] as string;
      const a = row.get(holder);
      let reason = "";
      if (isDown(holder)) reason = `Held by ${holder}, which ${a ? "is down" : "isn't running on any machine"}.`;
      else {
        const moved = minutesSince(t.updatedAt ?? null, now);
        const seen = minutesSince(a?.lastSeen ?? null, now);
        // a holder working on it keeps it moving while it is seen; one idle or on another task only by the task's own changes
        const onIt = a?.state === "working" && (!a.task || a.task === t.id || a.task === `#${t.id}`);
        const quiet = (onIt || moved === null ? [moved, seen] : [moved]).filter((m): m is number => m !== null);
        const least = quiet.length ? Math.min(...quiet) : null;
        if (least !== null && least >= lim.taskQuietMinutes) reason = `Held by ${holder}, but nothing has moved on it for ${plural(least, "minute")}.`;
      }
      if (!reason) continue;
      item("task-quiet", t.id, { title: `${named(t.id)} ${t.title}`, task: t.id, agent: holder, reason,
        action: { kind: "release", label: "Release", task: t.id } });
    }
    // a session working longer than its role's limit
    for (const a of agents) {
      if (a.state !== "working") continue;
      const m = minutesSince(a.since, now);
      const max = lim.maxMinutes[a.role] ?? lim.maxMinutes["coding-agent"] ?? 120;
      if (m === null || m < max) continue;
      item("session-long", a.name, { title: `${a.name} has been working for ${plural(m, "minute")}`, agent: a.name, task: a.task,
        reason: `Working for ${plural(m, "minute")}; the limit for ${ROLE_WORD[a.role] ?? "an agent"} is ${max}. It may be stuck.`,
        action: { kind: "open", label: "Open its output", link: `agent:${a.name}` } });
    }
    // a coding agent idle while a task it may take is ready (#591)
    const open = new Set(tasks.filter((t) => t.state !== "done").map((t) => t.id));
    const mayTake = (t: (typeof tasks)[number], name: string): boolean => t.state === "ready" && !t.holders.length &&
      (!t.assignee || t.assignee === name) && !t.blockedBy.length && !t.dependsOn.some((d) => open.has(d.replace(/^#/, "")));
    for (const a of agents) {
      if (a.role !== "coding-agent" || a.state !== "idle") continue;
      const idle = minutesSince(a.since, now);
      if (idle === null || idle < lim.idleWithReadyMinutes) continue;
      // on the board a ready task says when it last changed: one made ready a minute ago isn't waiting yet
      const ready = tasks.find((t) => mayTake(t, a.name) && (minutesSince(t.updatedAt, now) ?? idle) >= lim.idleWithReadyMinutes);
      if (!ready) continue;
      const unsent = a.prompt === "unsent";
      item("idle-ready", a.name, { title: unsent ? `${a.name} has a message typed but not sent` : `${a.name} is idle while ${named(ready.id)} is ready`,
        agent: a.name, task: ready.id,
        reason: `${a.name} has been idle for ${plural(idle, "minute")} while ${named(ready.id)} ${ready.title} is ready.` +
          (unsent ? " A message is typed in its session but not sent." : ""),
        action: { kind: "say", label: "Start work", agent: a.name, text: "/next-task" } });
    }
  }

  // a task being built whose agent may be going in circles (#580)
  if (i.costs) {
    const costOf = new Map(i.costs.tasks.map((c) => [c.task, c]));
    for (const t of tasks) {
      const c = costOf.get(t.id);
      if (!BUILDING.has(t.state) || !c) continue;
      const reason = spinReason(c, i.costs.medians, lim);
      if (!reason) continue;
      const who = t.holders[0] ?? (c.worker && NAME.test(c.worker) ? c.worker : null);
      item("task-spinning", t.id, { title: `${named(t.id)} ${t.title}`, task: t.id, agent: who, reason,
        action: { kind: "open", label: "Open its output", link: who ? `agent:${who}` : "view:tasks" } });
    }
  }

  // an epic whose tasks are all done
  for (const e of v.epics.epics) {
    if (e.all === 0 || e.done !== e.all || e.stage === "done") continue;
    item("epic-done", e.id, { title: `${named(e.id)} ${e.title}`, epic: e.id, reason: `${e.all === 1 ? "Its only task is" : `All ${e.all} tasks are`} done, but the epic is still open.`,
      action: { kind: "close", label: "Close the epic", task: e.id } });
  }

  // a PRD change still open while its tasks are being built (#578)
  const building = tasks.filter((t) => BUILDING.has(t.state)).length;
  for (const p of v.pulls.pulls) {
    if (!/\bprd\b/i.test(`${p.title} ${p.branch.replace(/[/_-]/g, " ")}`) || !building) continue;
    item("prd-open", String(p.number), { title: `PR #${p.number} ${p.title}`, pr: p.number,
      reason: `This PRD change is still open while ${plural(building, "task")} ${building === 1 ? "is" : "are"} being built from it. Read it, then merge it or say what to change.`,
      action: { kind: "open", label: "Open the PR", link: `pr:${p.number}` } });
  }

  // a PR waiting too long
  for (const p of v.pulls.pulls) {
    if (p.draft || out.some((x) => x.kind === "prd-open" && x.pr === p.number)) continue;
    const m = minutesSince(p.createdAt ?? null, now);
    if (m === null || m < lim.prWaitHours * 60) continue;
    const hours = plural(Math.floor(m / 60), "hour");
    const why = p.next.action === "owner-merges" ? "Only a person can merge it"
      : p.checks.state === "red" ? "Its checks are red"
      : p.review.state === "changes-asked" && !p.rework ? "A must-fix waits and nobody has picked it up"
      : p.review.state === "none" && !p.review.claim ? "Nobody has reviewed it" : "";
    if (!why) continue;
    item("pr-waiting", String(p.number), { title: `PR #${p.number} ${p.title}`, pr: p.number, task: p.task, reason: `${why}; open for ${hours}.`,
      action: { kind: "open", label: "Open the PR", link: `pr:${p.number}` } });
  }

  return out.sort((a, b) => ATTENTION_KINDS.indexOf(a.kind) - ATTENTION_KINDS.indexOf(b.kind));
}
