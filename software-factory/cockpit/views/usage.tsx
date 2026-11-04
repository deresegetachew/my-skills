// The Usage and lessons view (#341, #367), drawn after its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VUsage.dc.html):
// each task of the last 7 days against its budget as a bar, with its agent and the subagent that spent most, a few
// figures, and the lessons. The hook (factory_cockpit_ui.ts) counts the tokens from this machine's Claude Code logs and
// reads the lessons file, so this makes no GitHub call; rework rounds and CI runs are on GitHub, so it names
// `factory report` for them.
import { type Line, list, type Obj, plain, seg, type Style } from "./lines.tsx";
import { type Card, cards, heading, padStr, para, wrapText } from "./doc.tsx";
import type { Got } from "./read.ts";

interface TaskUse {
  task: string;
  agent: string;
  budget: number | null;
  used: number;
  top: string;
}

function taskOf(o: Obj): TaskUse {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { task: plain(o.task), agent: plain(o.agent) || "—", budget: typeof o.budget === "number" ? o.budget : null,
    used: n(o.used), top: plain(o.top) || "—" };
}

function median(xs: number[]): number | null {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function tokensShort(n: number): string {
  return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}m` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function barStyle(pct: number): Style {
  return pct >= 100 ? "red" : pct >= 80 ? "amber" : "blue";
}

/** `cells` wide: filled for what is used (full at 100% and over), the rest light. */
function bar(t: TaskUse, cells: number): Line {
  if (t.budget === null) return [seg("░".repeat(cells), "dim")];
  const pct = Math.round((t.used / t.budget) * 100);
  const full = Math.min(Math.round((pct / 100) * cells), cells);
  return [seg("█".repeat(full), barStyle(pct)), seg("░".repeat(cells - full), "dim")];
}

function percent(t: TaskUse): [string, Style] {
  if (t.budget === null) return ["—", "dim"];
  const pct = Math.round((t.used / t.budget) * 100);
  return [pct >= 100 ? `${pct}% over` : `${pct}%`, barStyle(pct)];
}

function tasksTable(tasks: TaskUse[], w: number): Line[] {
  if (!tasks.length) return para("No task on this machine in the last 7 days.", w, "dim");
  const out: Line[] = [];
  if (w >= 80) {
    const cells = 20;
    out.push([seg(`${padStr("task", 8)}${padStr("agent", 12)}${padStr("budget", 9)}${padStr("used", cells + 11)}spent most`, "dim")]);
    for (const t of tasks) {
      const [p, ps] = percent(t);
      const budget = t.budget === null ? "none" : tokensShort(t.budget);
      out.push([seg(padStr(`#${t.task}`, 8), "dim"), seg(padStr(t.agent, 12)), seg(padStr(budget, 9)), ...bar(t, cells),
        seg(` ${padStr(p, 10)}`, ps), seg(t.top, "dim")]);
    }
    return out;
  }
  for (const t of tasks) {
    const [p, ps] = percent(t);
    out.push([seg(`#${t.task}  `, "dim"), seg(`${t.agent}  `), seg(t.budget === null ? "none" : tokensShort(t.budget))]);
    out.push([seg("  "), ...bar(t, 10), seg(` ${p}  `, ps), seg(t.top, "dim")]);
  }
  return out;
}

function figures(tasks: TaskUse[], w: number): Line[] {
  const budgeted = tasks.filter((t) => t.budget !== null);
  const ratio = median(budgeted.map((t) => t.used / (t.budget as number)));
  const per = median(tasks.map((t) => t.used));
  const shown: Array<[string, string]> = [["tasks", String(tasks.length)],
    ["budget vs used, median", ratio === null ? "—" : ratio.toFixed(2)],
    ["over budget", String(budgeted.filter((t) => t.used > (t.budget as number)).length)],
    ["per task, median", per === null ? "—" : tokensShort(per)]];
  const out = w >= 96
    ? cards(shown.map(([label, value]): Card => ({ title: label, warn: false, lines: [[value, "bold"]] })), w)
    : shown.map(([label, value]): Line => [seg(`${label}: `, "dim"), seg(value, "bold")]);
  out.push(...para("Rework rounds and CI runs per task are on GitHub: factory report. Logs are per machine: a task built " +
    "on another machine shows in its own factory usage.", w, "dim"));
  return out;
}

function lessons(data: Obj, w: number): Line[] {
  const all = (Array.isArray(data.lessons) ? data.lessons : []).map(plain);
  const out: Line[] = [[seg("Lessons", "bold"), seg(`  ${all.length} of ${plain(data.cap) || "40"}`, "dim")]];
  out.push(...para(`${plain(data.path)}, read first by builders and reviewers`, w, "dim"));
  if (!all.length) out.push([seg("No lessons yet.", "dim")]);
  for (const l of all) out.push(...wrapText(l, w - 2).map((x, i): Line => [seg(i ? "  " : "- ", "dim"), seg(x)]));
  out.push(...para("suggest from recent must-fixes: factory lessons suggest · add: factory lessons add \"<rule>\" (dev manager) · " +
    "prune: factory lessons prune (dev manager)", w, "dim", " · "));
  return out;
}

const KEYS = "by task, role, agent or model: factory usage --by agent · a period: factory usage --since <date> · " +
  "one task: factory usage --task <n> --budget · rework and CI runs: factory report";

/** Every line of the Usage and lessons view (undefined: still reading), at most `w` wide. */
export function usageLines(data: Got | undefined, w: number): Line[] {
  if (data === undefined) return [[seg("Reading this machine's logs…")]];
  if (data === null || data === "late") return para("This machine's logs can't be read: run `factory usage` to see why.", w);
  const out: Line[] = [...heading([seg("factory", "amber"), seg(`  ${plain(data.repo)} · Usage and lessons`, "dim")],
    "factory usage (this machine's logs) · last 7 days", w)];
  out.push([], ...wrapText("Tasks against their budget · fresh input + output, cache reads not counted", w, " · ")
    .map((l, i): Line => [seg(l, i ? "dim" : "bold")]));
  const tasks = list(data.tasks).map(taskOf);
  out.push(...tasksTable(tasks, w), [], ...figures(tasks, w), [], ...lessons(data, w));
  out.push([], ...para(KEYS, w, "dim", " · "));
  return out;
}
