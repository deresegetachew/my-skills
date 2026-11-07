// The sign-off pages' rules (#454), from the owner's design (docs/design/web-ui/Signoff.dc.html, SignoffItem.dc.html):
// an item's title and the steps of its test plan, the list's tabs and groups with its one primary row (the single thing
// that needs the owner gets the red dot), the status words, the note a walk-through writes and the history. No command
// is shown on screen (the owner's rule). No React here, so tests/web_ui_signoff_model.test.ts runs it as it is.

export interface SignoffEvent {
  what: string;
  by: string;
  at: string;
  result?: string;
  note?: string;
}

/** One item as GET /api/projects/:p/signoff sends it (`factory signoff ls --all --json`). */
export interface SignoffItem {
  kind: "signoff" | "testplan";
  id: string;
  task: string | null;
  text: string;
  confirmed: boolean;
  state: string;
  by: string;
  at: string;
  results: string[][];
  history: SignoffEvent[];
}

export interface Step {
  n: number;
  text: string;
  /** What you should see, else "". */
  expect: string;
}

export type Dot = "working" | "waiting" | "idle" | "down" | "red";
export type Group = "proposed" | "ready" | "results";
export type Tab = "all" | "waiting" | "ready" | "results";

export interface Row {
  id: string;
  title: string;
  sub: string;
  /** Who it is from: the person who proposed or added it. */
  who: string;
  status: { text: string; dot: Dot };
  action: string;
  primary: boolean;
}

export interface SignoffList {
  line: string;
  tabs: Array<{ id: Tab; label: string; count: number }>;
  groups: Array<{ id: Group; title: string; rows: Row[] }>;
}

export interface Mark {
  result: "pass" | "fail" | null;
  note: string;
}

const STEP = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const EXPECT = /^\s*(?:you should see|expected|expect)\s*:\s*(.*)$/i;
const PASSES = /^\s*passes when\b/i;

function readable(id: string): string {
  const words = id.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The item's title: a `# heading` or a first line that isn't a step (without "To check: "), else its id made readable. */
export function titleOf(it: Pick<SignoffItem, "id" | "text">): string {
  const first = (it.text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  if (!first || STEP.test(first)) return readable(it.id);
  return first.replace(/^#+\s*/, "").replace(/^to check:\s*/i, "").trim() || readable(it.id);
}

/** The numbered steps of a plan, each with what you should see. An indented line goes on with its step's words. */
export function stepsOf(text: string): Step[] {
  const steps: Step[] = [];
  let open = false;
  for (const line of text.split(/\r?\n/)) {
    const s = STEP.exec(line);
    const last = steps[steps.length - 1];
    if (s) {
      steps.push({ n: Number(s[1]), text: (s[2] as string).trim(), expect: "" });
      open = true;
    } else if (open && last && EXPECT.test(line)) last.expect = ((EXPECT.exec(line) as RegExpExecArray)[1] as string).trim();
    else if (open && last && /^\s+\S/.test(line) && !PASSES.test(line)) last.text = `${last.text} ${line.trim()}`;
    else open = false;
  }
  return steps;
}

/** The plan's "Passes when ..." line, else null. */
export function passWhen(text: string): string | null {
  return text.split(/\r?\n/).find((l) => PASSES.test(l))?.trim() ?? null;
}

export function groupOf(it: SignoffItem): Group {
  if (it.kind === "testplan" && it.state === "proposed") return "proposed";
  if (it.state === "confirmed" || it.state === "open") return "ready";
  return "results";
}

const STATUS: Record<string, { text: string; dot: Dot }> = {
  proposed: { text: "Waiting for you", dot: "waiting" },
  confirmed: { text: "Confirmed", dot: "idle" },
  open: { text: "To check", dot: "idle" },
  passed: { text: "Passed", dot: "working" },
  failed: { text: "Failed", dot: "down" },
  blocked: { text: "Blocked", dot: "waiting" },
};

export function statusOf(it: SignoffItem): { text: string; dot: Dot } {
  return STATUS[it.state] ?? { text: it.state, dot: "idle" };
}

const ACTION: Record<Group, string> = { proposed: "Review plan", ready: "Record result", results: "Open" };
const GROUPS: Array<{ id: Group; title: string }> = [{ id: "proposed", title: "Proposed" }, { id: "ready", title: "Ready to test" },
  { id: "results", title: "Results" }];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function day(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today 10:05", "Yesterday 18:00", or "3 Nov", in this browser's time; "" without a time. */
export function whenText(iso: string, now: Date): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return `Today ${hm}`;
  if (days === 1) return `Yesterday ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function firstLine(s: string | undefined): string {
  return (s ?? "").split(/\r?\n/)[0]?.trim() ?? "";
}

/** "by mentewab, today 10:05" (without the time when there is none). */
function byWhen(who: string, iso: string, now: Date): string {
  const when = lower(whenText(iso, now));
  return `by ${who || "someone"}${when ? `, ${when}` : ""}`;
}

/** A task as people see it (#552): "#12" for an issue's, "b12" for a task made on the message board. */
export function taskLabel(task: string): string {
  return /^\d+$/.test(task) ? `#${task}` : task;
}

/** Whether the add dialog's "For task" names a task: 12 or #12 for an issue, b12 for a task made on the board. */
export function taskInputOk(text: string): boolean {
  return /^(?:#?[1-9]\d*|[bB][1-9]\d*)$/.test(text.trim());
}

/** What the add dialog does with the server's answer (#552): it closes on success; else it stays open, with what was
 * typed, and shows the error and its fix. */
export function addOutcome(r: Record<string, unknown>): { close: boolean; error: { message: string; fix: string } | null } {
  if (r.ok === true) return { close: true, error: null };
  const message = typeof r.message === "string" && r.message ? r.message : "It wasn't added.";
  const fix = typeof r.fix === "string" && r.fix ? r.fix : "Check what you typed, then try again. Reload the page if it keeps failing.";
  return { close: false, error: { message, fix } };
}

/** What "Failed: make it a task" asks the product owner: a task for the builders, linked to the item's task (#552). */
export function failedAsk(it: SignoffItem, note: string): string {
  const link = it.task ? `, linked to task ${taskLabel(it.task)}` : "";
  return `It failed. Please make it a task for the builders${link}.${note ? `\n${note}` : ""}`;
}

/** An item's preview as GET /api/projects/:p/signoff/:id/preview sends it (#582). */
export interface PreviewStatus {
  state: "none" | "starting" | "running" | "stopping" | "failed" | "stopped";
  /** Whether the project says how to run its app (preview.command on its main branch). */
  configured: boolean;
  path: string | null;
  output: string[];
  error: { code: string; message: string; fix: string } | null;
  pr?: number | null;
  commit?: string;
  reason?: string;
}

/** The preview's line on the item: what it says, the fix when it failed, whether the page keeps asking (busy) and
 * whether the link can be opened. */
export function previewLine(s: PreviewStatus): { text: string; fix: string; busy: boolean; open: boolean } {
  const what = s.pr ? `pull request #${s.pr}` : `main${s.commit ? ` (${s.commit.slice(0, 7)})` : ""}`;
  if (s.state === "starting") return { text: `Starting ${what}…`, fix: "", busy: true, open: false };
  if (s.state === "running") return { text: `Running ${what}.`, fix: "", busy: false, open: Boolean(s.path) };
  if (s.state === "stopping") return { text: "Stopping…", fix: "", busy: true, open: false };
  if (s.state === "failed") return { text: s.error?.message ?? "The preview failed.", fix: s.error?.fix ?? "", busy: false, open: false };
  if (s.state === "stopped") return { text: s.reason || "Stopped.", fix: "", busy: false, open: false };
  return { text: "Not running.", fix: "", busy: false, open: false };
}

/** The preview's address (#582): its own origin, the page's host on the previews' port, with the one-time link's path
 * (it ends in ?code=...). The web UI's token never goes there. */
export function previewLink(here: { protocol: string; hostname: string }, port: number, path: string): string {
  const host = here.hostname.includes(":") ? `[${here.hostname}]` : here.hostname;
  return `${here.protocol}//${host}:${port}${path}`;
}

/** The grey line under a row's title. */
function subOf(it: SignoffItem, now: Date): string {
  const task = it.task ? `For task ${taskLabel(it.task)} · ` : "";
  const g = groupOf(it);
  if (g === "proposed") {
    const n = stepsOf(it.text).length;
    return `${task}plan${n ? ` of ${n} step${n === 1 ? "" : "s"}` : ""} ${byWhen(it.by, it.at, now)}`;
  }
  if (g === "ready") {
    const confirmed = [...it.history].reverse().find((h) => h.what === "confirmed");
    if (confirmed) return `${task}confirmed ${byWhen(confirmed.by, confirmed.at, now)}`;
    return `${task}added ${byWhen(it.by, it.at, now)}`;
  }
  const last = [...it.history].reverse().find((h) => h.what === "result");
  const note = firstLine(last?.note ?? it.results.at(-1)?.[2]);
  return [`Recorded ${byWhen(last?.by || it.results.at(-1)?.[1] || "", last?.at ?? "", now)}`, note].filter(Boolean).join(" · ");
}

/** The list: its line, the tabs with their counts, and the groups that have rows. Exactly one row is primary and red:
 * the oldest plan waiting for the owner. */
export function listOf(items: SignoffItem[], now: Date): SignoffList {
  const waiting = items.filter((it) => groupOf(it) === "proposed").sort((a, b) => a.at.localeCompare(b.at));
  const first = waiting[0]?.id;
  const rows = (g: Group): Row[] => items.filter((it) => groupOf(it) === g).map((it) => {
    const primary = it.id === first && g === "proposed";
    return { id: it.id, title: titleOf(it), sub: subOf(it, now), who: it.by, action: ACTION[g], primary,
      status: primary ? { text: "Waiting for you", dot: "red" } : statusOf(it) };
  });
  const groups = GROUPS.map((g) => ({ ...g, rows: rows(g.id) })).filter((g) => g.rows.length);
  const count = (g: Group): number => items.filter((it) => groupOf(it) === g).length;
  const n = items.length;
  const w = waiting.length;
  const line = "What only a person can check. " + (!n ? "Nothing yet."
    : `${n} item${n === 1 ? "" : "s"}${w ? `; ${w} plan${w === 1 ? " is" : "s are"} waiting for you` : ""}.`);
  return { line, groups, tabs: [{ id: "all", label: "All", count: n }, { id: "waiting", label: "Waiting for you", count: w },
    { id: "ready", label: "Ready to test", count: count("ready") }, { id: "results", label: "Results", count: count("results") }] };
}

const TAB_GROUP: Record<Exclude<Tab, "all">, Group> = { waiting: "proposed", ready: "ready", results: "results" };

/** The groups a tab shows. */
export function filterGroups(list: SignoffList, tab: Tab): SignoffList["groups"] {
  return tab === "all" ? list.groups : list.groups.filter((g) => g.id === TAB_GROUP[tab]);
}

const WORD: Record<string, string> = { pass: "passed", fail: "failed", blocked: "blocked" };

/** The note a walk-through writes: a line per step that has a result or a note, then the owner's own words. */
export function noteOf(steps: Step[], marks: Mark[], extra: string): string {
  const lines = steps.flatMap((s, i) => {
    const m = marks[i];
    if (!m || (!m.result && !m.note.trim())) return [];
    const head = m.result ? `Step ${s.n} ${WORD[m.result]}` : `Step ${s.n}`;
    return [m.note.trim() ? `${head}: ${m.note.trim()}` : head];
  });
  if (extra.trim()) lines.push(extra.trim());
  return lines.join("\n");
}

/** What the steps add up to: fail when any failed, pass when all passed, else null (not done yet). */
export function outcomeOf(marks: Mark[]): "pass" | "fail" | null {
  if (marks.some((m) => m.result === "fail")) return "fail";
  return marks.length && marks.every((m) => m.result === "pass") ? "pass" : null;
}

/** The item's story, newest first, in the person's words. */
export function historyOf(it: SignoffItem, now: Date): Array<{ text: string; when: string }> {
  const n = stepsOf(it.text).length;
  return [...it.history].reverse().map((h) => {
    const note = firstLine(h.note);
    const text = h.what === "added" ? `${h.by} added it`
      : h.what === "proposed" ? `${h.by} proposed the plan${n ? `, ${n} step${n === 1 ? "" : "s"}` : ""}`
      : h.what === "confirmed" ? `${h.by} confirmed the plan`
      : `${h.by} recorded ${WORD[h.result ?? ""] ?? h.result ?? "a result"}${note ? `: ${note}` : ""}`;
    return { text, when: whenText(h.at, now) };
  });
}
