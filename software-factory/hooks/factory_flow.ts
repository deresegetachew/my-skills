#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory prd --stage` (#103): where a project is on the way from an idea to a first milestone, read from the project and
// GitHub, and the owner's gates between the stages.
//
//   factory prd --stage                 the stages, what is done, what the owner has approved, and the next step
//   factory prd --stage --json          the same as JSON
//   factory prd --stage --ask <stage>   ask the owner to approve a stage (vision, design or plan): one owner-queue
//                                       comment, never posted twice
//
// The stages: 1 vision (the PRD has stories with unique numbers), 2 design (the design folder has references), 3 plan (task
// issues that name the stories, each with its "Done when"), 4 hand over (the three are approved and a task is ready for a
// coding agent). Nothing is stored apart from the owner-queue comments: an approval is the owner's reply under the ask
// `stage-<name>`, either `<!-- factory-owner-answer id=stage-<name> -->` or a first word of yes, approved, ok or go ahead.
// Any other reply is a question or a no: the stage stays open and the product owner reads it. Read-only except `--ask`.
// Errors are `{code, message, fix}` on stderr.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Config, load, taskLabels } from "./factory_config.ts";
import { comment, type Comment, ghAll, type Issue, names } from "./factory_issues.ts";
import { refuse } from "./factory_machine.ts";
import { ownerQueue } from "./factory_orchestrator.ts";
import { parseStories, storyRefs } from "./factory_prd.ts";
import { trustedOf } from "./factory_prs.ts";
import { pyDumps, runMain } from "./factory_lib.ts";

export const GATES = ["vision", "design", "plan"] as const;
export const YES = /^\W*(yes|approved?|ok|okay|go ahead)\b/i;
export const ASK = /<!--\s*factory-owner-ask\s+id=stage-([a-z]+)\b[^>]*-->/;
export const ANSWER = /<!--\s*factory-owner-answer\s+id=stage-([a-z]+)\s*-->/;
export const DONE_WHEN = /^#{1,6}\s*(acceptance criteria|done when)\b/im;

export function designDir(cfg: Config): string {
  const design = (cfg.design ?? {}) as Record<string, unknown>;
  const ref = String(design.references || "");
  return ref ? (ref.split("/")[0] as string) : "design";
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a folder holds at least one file, at any depth. */
export function hasFiles(folder: string): boolean {
  if (!isDir(folder)) return false;
  const walk = (d: string): boolean => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (walk(join(d, e.name))) return true;
      } else return true;
    }
    return false;
  };
  return walk(folder);
}

/** {stage: 'approved' | 'asked' | 'answered'} from the owner-queue comments, oldest first. A reply under a stage ask
 * that says yes (or carries the answer marker) approves it; any other reply leaves it open as `answered`. With
 * `trusted` logins, only their replies count: an agent's yes is not the owner's (#337). */
export function approvals(comments: Comment[], trusted: Set<string> = new Set()): Record<string, string> {
  const state: Record<string, string> = {};
  let last: string | null = null;
  for (const c of comments) {
    const body = c.body || "";
    const a = ASK.exec(body);
    if (a) {
      last = a[1] as string;
      state[last] = "asked";
      continue;
    }
    if (trusted.size && !trusted.has(c.user?.login ?? "")) continue;
    const m = ANSWER.exec(body);
    if (m && (m[1] as string) in state) state[m[1] as string] = "approved";
    else if (last && (state[last] === "asked" || state[last] === "answered")) {
      state[last] = YES.test(body.replace(/<!--[\s\S]*?-->/g, "")) ? "approved" : "answered";
    }
  }
  return state;
}

export type Evidence = Record<string, [done: boolean, line: string]>;

/** {stage: [done, line]} from the working tree and the task issues. */
export function evidence(cfg: Config, issues: Issue[]): Evidence {
  const path = cfg.prd || "docs/PRD.md";
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  const stories = isFile ? parseStories(readFileSync(path, "utf8")).filter((s) => s[1]) : [];
  const numbers = stories.map(([n]) => n);
  const dup = [...new Set(numbers.filter((n) => numbers.filter((x) => x === n).length > 1))].sort((a, b) => a - b);
  const vision: [boolean, string] = [stories.length > 0 && !dup.length,
    stories.length ? `${path}: ${new Set(numbers).size} stories` + (dup.length ? `, US-${dup[0]} used twice` : "")
      : `${path} has no stories with a title (\`- US-1: <what the person can do>\`)`];
  const folder = designDir(cfg);
  const design: [boolean, string] = [hasFiles(folder), hasFiles(folder) ? `${folder}/ has references` : `${folder}/ is empty or missing`];
  const tasks = issues.filter((i) => !("pull_request" in i) && !names(i).has("factory:agent") &&
    i.state_reason !== "not_planned" && storyRefs(i.body).length);
  const thin = tasks.filter((i) => !DONE_WHEN.test(i.body || "")).map((i) => i.number);
  const served = new Set(tasks.flatMap((i) => storyRefs(i.body)));
  const bare = [...new Set(numbers)].filter((n) => !served.has(n)).sort((a, b) => a - b);
  const ok = tasks.length > 0 && !thin.length;
  let line = `${tasks.length} tasks name a story`;
  if (thin.length) line += "; no `Done when` in " + thin.map((n) => `#${n}`).join(", ");
  if (tasks.length && bare.length) line += "; stories with no task: " + bare.map((n) => `US-${n}`).join(", ");
  const plan: [boolean, string] = [ok, tasks.length ? line : "no task names a story (`PRD: US-<n>`; `factory issues new`)"];
  return { vision, design, plan };
}

export interface Row {
  stage: string;
  done: boolean;
  approval: string;
  line?: string;
  queue: number | null;
}

export function status(cfg: Config, comments: Comment[] | null = null, issues: Issue[] | null = null): Row[] {
  const queue = ownerQueue(cfg, false);
  const cs = comments ?? (queue ? ghAll<Comment>(`repos/{owner}/{repo}/issues/${queue}/comments`) : []);
  const all = issues ?? ghAll<Issue>("repos/{owner}/{repo}/issues?state=all");
  const ev = evidence(cfg, all);
  const approved = approvals(cs, trustedOf(cfg));
  const rows: Row[] = [];
  for (const name of GATES) {
    const [done, line] = ev[name] as [boolean, string];
    rows.push({ stage: name, done, approval: done ? approved[name] ?? "not asked" : "not ready", line, queue });
  }
  const ready = all.filter((i) => names(i).has(taskLabels(cfg).ready) && i.state === "open");
  const go = rows.every((r) => r.approval === "approved");
  rows.push({ stage: "hand over", done: go && ready.length > 0, approval: "-", queue,
    line: go && ready.length ? `${ready.length} ready tasks: start \`factory coding-agent loop\`` :
      !go ? "waiting for the three approvals" : "no task is ready" });
  return rows;
}

export function nextStep(rows: Row[]): string {
  for (const r of rows.slice(0, 3)) {
    if (!r.done) return `Next: finish the ${r.stage} (${r.line}).`;
    if (r.approval === "not asked") return `Next: ask the owner: factory prd --stage --ask ${r.stage}`;
    if (r.approval === "asked" || r.approval === "answered") {
      return `Next: wait for the owner's yes on stage-${r.stage}` + (r.approval === "answered" ? " (a reply is there; read it)" : "");
    }
  }
  return (rows[3] as Row).done ? "Next: start the coding agents." : "Next: add a ready task.";
}

export function render(rows: Row[]): string {
  const out = ["Flow stages (the owner approves each gate)", ""];
  rows.forEach((r, i) => {
    const word = r.done ? "done" : "not yet";
    out.push(`${i + 1} ${r.stage.padEnd(10)} ${word.padEnd(8)} ${r.approval.padEnd(10)} ${r.line}`);
  });
  return [...out, "", nextStep(rows)].join("\n");
}

export function ask(cfg: Config, stage: string, rows: Row[]): void {
  if (!(GATES as readonly string[]).includes(stage)) {
    refuse("unknown-stage", `'${stage}' is not a stage the owner approves.`, `Use one of ${GATES.join(", ")}.`);
  }
  const i = (GATES as readonly string[]).indexOf(stage);
  const row = rows[i] as Row;
  if (!row.done) refuse("not-ready", `The ${stage} is not done: ${row.line}.`, `Finish it, then ask: factory prd --stage --ask ${stage}`);
  if (i && (rows[i - 1] as Row).approval !== "approved") {
    refuse("earlier-gate", `The ${GATES[i - 1]} is not approved yet.`, `Wait for the owner's yes on stage-${GATES[i - 1]} first.`);
  }
  if (row.approval !== "not asked") {
    console.log(`stage-${stage}: already ${row.approval}; nothing posted.`);
    return;
  }
  const queue = ownerQueue(cfg, true) as number;
  comment(queue, `<!-- factory-owner-ask id=stage-${stage} -->\nPlease approve the ${stage}: ${row.line}.\n\n` +
    "Reply `yes` to approve it, or say what to change; the product owner reads the reply.");
  console.log(`stage-${stage}: asked in the owner queue (#${queue}).`);
}

export function main(a: string[]): void {
  const cfg = load();
  const rows = status(cfg);
  if (a.includes("--ask")) {
    const k = a.indexOf("--ask");
    ask(cfg, k + 1 < a.length ? a[k + 1] as string : "", rows);
    return;
  }
  console.log(a.includes("--json") ? pyDumps(rows, { indent: 2 }) : render(rows));
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
