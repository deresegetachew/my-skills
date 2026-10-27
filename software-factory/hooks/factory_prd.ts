#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory prd` (#101): progress against the PRD, as plain text, computed from GitHub. Nothing is written by hand.
//
// Each user story in the PRD file (`prd` in factory.json) has an id, `US-<n>`, at the start of its heading or list item.
// A task issue says which stories it serves with one line, `PRD: US-3, US-5` (the task template has it). This prints,
// per story, its tasks and their state, then how much of the PRD is done and what has no task yet.
//
//   factory prd [--open] [--story N] [--json]
//   factory prd --stage [--ask vision|design|plan]   where the project is on the way to a first milestone (factory_flow.ts)
//
//   --open       hide the stories that are done
//   --story N    one story, with its title and every task
//   --json       the same data for scripts
//
// A story is `done` when it has tasks and all are closed, `in progress` when one is in progress or in review (or some
// are closed and some are not), `planned` when it has tasks and none has started, and `no task` when none names it.
// A story number that two stories use is reported, because a task can't tell which one it means (fix the PRD first).
// Read-only; the PRD is read from the working tree and the tasks through the GitHub REST API (`gh api`).
import { readFileSync, statSync } from "node:fs";
import { type Config, load, taskLabels } from "./factory_config.ts";
import { ghAll, type Issue, names } from "./factory_issues.ts";
import { die, Exit, pyDumps, runMain, splitLines } from "./factory_lib.ts";

export const STORY = /^\s*(?:#{1,6}\s+|[-*]\s+|\|\s*)?\**US-(\d+)\b\**\s*[:.)|—–-]*\s*(.*?)\s*\|?\s*$/;
export const PRD_LINE = /^[\s>*-]*\**PRD\b\**\s*:?\**\s*:?\s*(.*)$/i;
export const STORY_REF = /\bUS-(\d+)\b/g;
export const STATES = ["done", "in progress", "planned", "no task"] as const;

export type Story = [n: number, title: string, line: number];

/** [(n, title, line)] for every line that starts a story, in file order (a number used twice appears twice). */
export function parseStories(text: string): Story[] {
  const out: Story[] = [];
  splitLines(text).forEach((line, i) => {
    const m = STORY.exec(line);
    if (m) out.push([Number(m[1]), (m[2] as string).replace(/[*_`]+/g, "").trim(), i + 1]);
  });
  return out;
}

/** The story numbers a task body names on its `PRD:` line(s). */
export function storyRefs(body: string | null | undefined): number[] {
  const found = new Set<number>();
  for (const line of splitLines(body || "")) {
    const m = PRD_LINE.exec(line);
    if (m) for (const r of (m[1] as string).matchAll(STORY_REF)) found.add(Number(r[1]));
  }
  return [...found].sort((a, b) => a - b);
}

export function taskState(cfg: Config, issue: Issue): string {
  if (issue.state === "closed") return "done";
  const have = names(issue);
  const labels = taskLabels(cfg);
  for (const [key, word] of [["inReview", "in review"], ["inProgress", "in progress"], ["blocked", "blocked"], ["ready", "ready"]] as const) {
    if (have.has(labels[key])) return word;
  }
  return "open";
}

export interface TaskRow {
  number: number;
  title: string;
  state: string;
}

export function storyState(tasks: TaskRow[]): string {
  if (!tasks.length) return "no task";
  const states = tasks.map((t) => t.state);
  if (states.every((s) => s === "done")) return "done";
  if (states.some((s) => s === "in progress" || s === "in review" || s === "done")) return "in progress";
  return "planned";
}

export interface StoryRow {
  story: number;
  title: string;
  line: number;
  state: string;
  tasks: TaskRow[];
}

export interface Report {
  stories: StoryRow[];
  counts: Record<string, number>;
  total: number;
  duplicates: Record<string, number[]>;
  tasks: { total: number; done: number };
  unknown: Record<string, number[]>;
}

/** The data `factory prd` prints: per story its tasks and state, the duplicates and the unknown references. */
export function report(cfg: Config, stories: Story[], issues: Issue[]): Report {
  const byStory = new Map<number, TaskRow[]>();
  for (const i of issues) {
    if ("pull_request" in i || names(i).has("factory:agent") || i.state_reason === "not_planned") {
      continue; // a PR, an agent's issue, or a task closed as not planned counts for nothing
    }
    for (const n of storyRefs(i.body)) {
      if (!byStory.has(n)) byStory.set(n, []);
      (byStory.get(n) as TaskRow[]).push({ number: i.number, title: i.title ?? "", state: taskState(cfg, i) });
    }
  }
  const seen = new Map<number, number>();
  const dup = new Map<number, number[]>();
  const rows: StoryRow[] = [];
  for (const [n, title, line] of stories) {
    if (seen.has(n)) {
      if (!dup.has(n)) dup.set(n, [seen.get(n) as number]);
      (dup.get(n) as number[]).push(line);
      continue;
    }
    seen.set(n, line);
    const tasks = [...(byStory.get(n) ?? [])].sort((a, b) => a.number - b.number);
    rows.push({ story: n, title, line, state: storyState(tasks), tasks });
  }
  const counts: Record<string, number> = {};
  for (const s of STATES) counts[s] = rows.filter((r) => r.state === s).length;
  const every = rows.flatMap((r) => r.tasks);
  const unknown: Record<string, number[]> = {};
  for (const n of [...byStory.keys()].filter((k) => !seen.has(k)).sort((a, b) => a - b)) {
    unknown[String(n)] = (byStory.get(n) as TaskRow[]).map((t) => t.number);
  }
  const duplicates: Record<string, number[]> = {};
  for (const [n, lines] of dup) duplicates[String(n)] = lines;
  return { stories: rows, counts, total: rows.length, duplicates,
    tasks: { total: every.length, done: every.filter((t) => t.state === "done").length }, unknown };
}

export function render(data: Report, prdPath: string, onlyOpen = false, story: number | null = null): string {
  let out: string[] = [];
  const rows = data.stories.filter((r) => (story === null || r.story === story) && !(onlyOpen && r.state === "done"));
  for (const r of rows) {
    const mark = r.tasks.length ? `${r.tasks.filter((t) => t.state === "done").length}/${r.tasks.length}` : "-";
    const head = `US-${String(r.story).padEnd(3)} ${r.state.padEnd(12)} ${mark.padEnd(5)} ${r.title.slice(0, 70)}`;
    out.push(head.trimEnd());
    if (r.tasks.length && (story !== null || r.state !== "done")) {
      out.push("        " + r.tasks.map((t) => `#${t.number} ${t.state}`).join(", "));
    }
  }
  if (story !== null && !rows.length) return `factory prd: ${prdPath} has no story US-${story}.`;
  if (story === null) {
    const c = data.counts;
    const t = data.tasks;
    const head = `${prdPath}: ${data.total} stories: ${c.done} done, ${c["in progress"]} in progress, ` +
      `${c.planned} planned, ${c["no task"]} with no task. Tasks: ${t.done} of ${t.total} done.`;
    out = [head, "", ...out];
    for (const [n, lines] of Object.entries(data.duplicates).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      out.push(`\nUS-${n} is used by ${lines.length} stories (lines ${lines.join(", ")}). A task can't say ` +
        "which one it serves: renumber the PRD first.");
    }
    for (const [n, nums] of Object.entries(data.unknown)) {
      out.push(`\nTasks ${nums.map((x) => "#" + x).join(", ")} name US-${n}, which the PRD does not have.`);
    }
  }
  return out.join("\n");
}

const USAGE = "usage: factory_prd.ts [-h] [--open] [--story STORY] [--json]";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export async function main(argv: string[]): Promise<void> {
  let open = false;
  let json = false;
  let story: number | null = null;
  const extra: string[] = [];
  const error = (text: string): never => {
    process.stderr.write(`${USAGE}\nfactory_prd.ts: error: ${text}\n`);
    throw new Exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--open") open = true;
    else if (a === "--json") json = true;
    else if (a === "--story" || a.startsWith("--story=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (v === undefined) error("argument --story: expected one argument");
      if (!/^\s*[+-]?\d+\s*$/.test(v as string)) error(`argument --story: invalid int value: '${v}'`);
      story = Number(v);
    } else if (a === "-h" || a === "--help") {
      console.log(`${USAGE}\n\nProgress against the PRD, from GitHub. Read-only.`);
      return;
    } else extra.push(a);
  }
  if (extra.includes("--stage") || extra.includes("--ask")) {
    const flow = await import("./factory_flow.ts"); // the flow stages and the owner's gates (#103)
    return flow.main(argv);
  }
  if (extra.length) error(`unrecognized arguments: ${extra.join(" ")}`);
  const cfg = load();
  const path = cfg.prd || "docs/PRD.md";
  if (!isFile(path)) die(`factory prd: ${path} does not exist. Set \`prd\` in .claude/factory.json to the PRD file.`);
  const stories = parseStories(readFileSync(path, "utf8"));
  if (!stories.length) {
    die(`factory prd: ${path} has no story ids. Start each user story's heading or list item with \`US-<n>\` ` +
      "(for example `- US-3: Upload a manual`), then tasks can say `PRD: US-3`.");
  }
  const data = report(cfg, stories, ghAll<Issue>("repos/{owner}/{repo}/issues?state=all"));
  console.log(json ? pyDumps(data, { indent: 2 }) : render(data, path, open, story));
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
