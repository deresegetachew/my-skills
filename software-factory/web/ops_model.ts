// The words and shapes of Health, Usage and cost, Activity and Home (#455, #451), from the owner's designs
// (docs/design/web-ui/Health.dc.html, Usage.dc.html, Activity.dc.html, Main.dc.html). No React here, so
// tests/web_ui_ops_model.test.ts runs it as it is. The data comes from GET /api/projects/:p/health|usage|activity|home
// (hooks/factory_ui_ops.ts).
import type { AttentionItem } from "./attention_model.ts";
import { agentState, ago, type LimitView, type Tone } from "./model.ts";
import type { DotState } from "./parts.tsx";

export interface Problem {
  code: string;
  message: string;
  fix: string;
}

// --- Health ------------------------------------------------------------------------------------------------------------

export type Level = "ok" | "warning" | "failed";

export interface HealthCheck {
  level: Level;
  what: string;
  fix: string;
}

export interface HealthData {
  ranAt: string | null;
  ok: boolean | null;
  running: boolean;
  counts: { ok: number; warning: number; failed: number };
  groups: Array<{ id: string; title: string; checks: HealthCheck[] }>;
  problems: Problem[];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The line under Health's title: how many checks, what to fix, when they ran. */
export function healthLine(h: HealthData | null, now = Date.now()): string {
  if (!h || (!h.ranAt && h.running)) return "Checking this machine and the project…";
  if (!h.ranAt) return "Not checked yet.";
  const all = h.counts.ok + h.counts.warning + h.counts.failed;
  const parts = [h.counts.failed ? `${h.counts.failed} to fix` : "", h.counts.warning ? plural(h.counts.warning, "warning") : ""].filter(Boolean);
  const verdict = parts.length ? `${parts.join(", ")}.` : "All pass.";
  return `${plural(all, "check")}. ${verdict} ${h.running ? "Checking again…" : `Ran ${ago(h.ranAt, now)}.`}`;
}

export interface AttentionRow {
  key: string;
  what: string;
  where: string;
  fix: string;
  status: { text: string; dot: DotState };
}

/** What needs attention: each failed check, then each warning, with the part it is about. */
export function attention(h: HealthData | null): AttentionRow[] {
  if (!h) return [];
  const rows: AttentionRow[] = [];
  for (const level of ["failed", "warning"] as const) {
    for (const g of h.groups) {
      g.checks.forEach((c, i) => {
        if (c.level !== level) return;
        rows.push({ key: `${g.id}/${i}`, what: c.what, where: g.title, fix: c.fix,
          status: level === "failed" ? { text: "To fix", dot: "red" } : { text: "Warning", dot: "waiting" } });
      });
    }
  }
  return rows;
}

/** Each part with its passed checks: its title, the first few names, and how many passed. */
export function passed(h: HealthData | null): Array<{ id: string; title: string; sub: string; count: string }> {
  if (!h) return [];
  return h.groups.map((g) => {
    const ok = g.checks.filter((c) => c.level === "ok");
    const names = ok.slice(0, 4).map((c) => c.what).join(", ");
    return { id: g.id, title: g.title, sub: ok.length > 4 ? `${names} and ${ok.length - 4} more` : names, count: `${ok.length} ok` };
  }).filter((g) => g.count !== "0 ok");
}

// --- Usage and cost ----------------------------------------------------------------------------------------------------

export interface UsageRow {
  key: string;
  title: string;
  used: number;
  replies: number;
  budget: number | null;
  percent: number | null;
  tone: "ok" | "warn" | "over" | "none";
  /** US dollars at the API's prices, of the replies whose model's price is known; null when none had one. */
  cost?: number | null;
  unpriced?: number;
}

export interface UsageData {
  since: string | null;
  until: string | null;
  measured: boolean;
  total: { used: number; replies: number; tasks: number; cost?: number | null; unpriced?: number };
  budget: { tokens: number | null; source: string | null; warnPercent: number };
  tasks: UsageRow[];
  agents: UsageRow[];
  days?: UsageRow[];
  pricesAsOf?: string | null;
  github: { total: number; agents: Record<string, number>; commands: Record<string, number>; account: { used: number; limit: number; reset: string } | null } | null;
  notMeasured: string[];
  problems: Problem[];
}

/** 950 -> "950", 300000 -> "300k", 1240000 -> "1.2M". */
export function tokensText(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** A bar: its width against the biggest row, its dot (yellow from the warning percent, red over the budget) and its words. */
export function usageBar(r: UsageRow, max: number): { width: string; dot: DotState; text: string } {
  const width = `${max > 0 ? Math.max(Math.round((r.used / max) * 100), r.used > 0 ? 1 : 0) : 0}%`;
  const dot: DotState = r.tone === "over" ? "red" : r.tone === "warn" ? "waiting" : "idle";
  const tokens = r.budget === null ? tokensText(r.used) : `${tokensText(r.used)} of ${tokensText(r.budget)}`;
  const text = typeof r.cost === "number" ? `${tokens} · ${costText(r.cost)}` : tokens;
  return { width, dot, text };
}

/** The dates a report covers: "30 Oct to 6 Nov" (the until day is the day after the last). */
export function rangeText(since: string | null, until: string | null): string {
  if (!since || !until) return "";
  const day = (iso: string, back = 0): string => {
    const d = new Date(Date.parse(iso) - back);
    return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
  };
  return `${day(since)} to ${day(until, 86_400_000)}`;
}

/** Dollars for a cost: "$29.20", "<$0.01" for a little, "-" when nothing had a known price. */
export function costText(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "-";
  return cost > 0 && cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

/** The line under the cost tile: the prices' date, and how many replies had no known price. */
function costLine(u: UsageData): string {
  const unpriced = u.total.unpriced ?? 0;
  if (unpriced) return `${plural(unpriced, "reply", "replies")} without a known price`;
  return u.pricesAsOf ? `API prices of ${u.pricesAsOf}` : "at API prices";
}

/** The tiles above the bars. */
export function usageTiles(u: UsageData): Array<{ label: string; value: string; line: string }> {
  const over = u.tasks.filter((t) => t.tone === "over").length;
  const warn = u.tasks.filter((t) => t.tone === "warn").length;
  return [
    { label: "Tokens", value: tokensText(u.total.used), line: rangeText(u.since, u.until) },
    { label: "Cost", value: costText(u.total.cost), line: costLine(u) },
    { label: "Tasks", value: String(u.total.tasks), line: `${plural(u.total.replies, "reply", "replies")} counted` },
    { label: "Budget", value: u.budget.tokens === null ? "None" : tokensText(u.budget.tokens),
      line: u.budget.tokens === null ? "No budget set" : over || warn ? `${over} over, ${warn} near it` : "Every task within it" },
    { label: "GitHub calls", value: u.github ? String(u.github.total) : "?", line: "this machine, last hour" },
  ];
}

// --- Activity ----------------------------------------------------------------------------------------------------------

export interface ActivityItem {
  id: string;
  at: string | null;
  agent: string | null;
  kind: string;
  text: string;
  task: string | null;
  pr: number | null;
  link: string;
  find: string;
}

export const KIND_LABEL: Record<string, string> = { claim: "Claims", move: "Moves", comment: "Comments", close: "Closes", handoff: "Hand-offs",
  new: "New tasks", note: "Notes", pr: "Pull requests", ci: "CI", ask: "Asks" };

const KIND_WORD: Record<string, string> = { claim: "Claim", move: "Move", comment: "Comment", close: "Close", handoff: "Hand-off", new: "New task",
  note: "Note", pr: "Pull request", ci: "CI", ask: "Question" };

/** The grey line under an event: its kind, its task or PR, and when. */
export function activitySub(x: ActivityItem, now = Date.now()): string {
  const ref = x.pr !== null ? `PR #${x.pr}` : x.task ? (/^\d+$/.test(x.task) ? `#${x.task}` : x.task) : "";
  return [KIND_WORD[x.kind] ?? x.kind, ref, x.at ? ago(x.at, now) : ""].filter(Boolean).join(" · ");
}

/** The dot of an event: red for what waits on the owner, the failed CI too; yellow for moves and hand-offs. */
export function activityDot(x: ActivityItem): DotState {
  if (x.kind === "ask" || x.kind === "ci") return "red";
  if (x.kind === "move" || x.kind === "handoff") return "waiting";
  if (x.kind === "claim" || x.kind === "close" || x.kind === "pr") return "working";
  return "idle";
}

// --- Home --------------------------------------------------------------------------------------------------------------

export interface NeedRow {
  kind: string;
  title: string;
  sub: string;
  link: string;
  find: string;
  action: string;
}

export interface TeamMember {
  name: string;
  role: string;
  state: string;
  detail: string;
  task: string | null;
  taskTitle: string | null;
  machine: string | null;
  link: string;
}

export interface HomeData {
  /** Needs attention (#579): anything stuck, each with its reason and one action. */
  attention?: AttentionItem[];
  needs: NeedRow[];
  team: TeamMember[];
  progress: { done: number; all: number; epics: Array<{ id: string; title: string; done: number; all: number; stage: string }>; noEpic: { done: number; all: number } };
  recent: ActivityItem[];
  activityFrom: "board" | "snapshot";
  limit: LimitView | null;
  problems: Problem[];
}

const ROLE_WORD: Record<string, string> = { "product-owner": "Product owner", "dev-manager": "Dev manager", "coding-agent": "Builder" };
const DOT: Record<Tone, DotState> = { good: "working", warn: "waiting", bad: "down", quiet: "idle" };

/** Home's line under its title: who works, what needs the owner. */
export function homeLine(h: HomeData): string {
  const working = h.team.filter((a) => a.state === "working").length;
  const needs = h.needs.length;
  const team = h.team.length ? `${plural(working, "agent")} working of ${h.team.length}` : "No agent reported yet";
  return `${team}, ${needs ? `${plural(needs, "thing")} ${needs === 1 ? "needs" : "need"} you` : "nothing needs you"}.`;
}

/** A team member's row: the role (and machine) with the task, the state in words and its dot. */
export function teamRow(a: TeamMember, limit: LimitView | null): { sub: string; state: string; dot: DotState } {
  const st = agentState({ state: a.state, detail: a.detail }, limit);
  const task = a.task ? `#${a.task}${a.taskTitle ? ` ${a.taskTitle}` : ""}` : "";
  return { sub: [`${ROLE_WORD[a.role] ?? "Builder"}${a.machine ? ` on ${a.machine}` : ""}`, task].filter(Boolean).join(" · "), state: st.text, dot: DOT[st.tone] };
}

/** Tasks done of all, as a percent for a bar. */
export function percentOf(done: number, all: number): number {
  return all > 0 ? Math.round((done / all) * 100) : 0;
}
