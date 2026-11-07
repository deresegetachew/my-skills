// An epic (#440): something bigger than a task, that holds tasks and has a stage of its own. It lives as an issue
// labelled `epic` (stage in an `epic:<stage>` label, tasks as `- [ ] #n` lines, optional `PRD:` and `Decisions:` lines).
// Plain rules, no I/O: the adapters read the issues and give them here.
import { citesIn } from "./cites.ts";

export const EPIC_STAGES = ["investigating", "prd", "decision", "planned", "building", "done", "parked"] as const;
export type EpicStage = (typeof EPIC_STAGES)[number];

export interface EpicTask {
  id: string;
  done: boolean;
}

export interface Epic {
  id: string;
  title: string;
  stage: EpicStage;
  tasks: EpicTask[];
  prd: string;
  decisions: string[];
  /** The first plain line of the body (not a task, PRD or Decisions line), at most 300 characters; "" for none. */
  summary: string;
  /** The decisions and PRD stories its title and body cite, as written (the rule is core/domain/cites.ts). */
  cites: string[];
  url: string | null;
}

export interface EpicInput {
  number: number;
  title: string;
  body: string;
  labels: string[];
  closed: boolean;
  openIds: Set<string>;
}

const TASK_LINE = /^\s*[-*]\s+\[([ xX])\]\s+#(\d+)\b/gm;

function stageOf(labels: string[], closed: boolean): EpicStage {
  if (closed || labels.includes("epic:done")) return "done";
  for (const l of labels) {
    const s = l.startsWith("epic:") ? l.slice(5) : "";
    if ((EPIC_STAGES as readonly string[]).includes(s) && s !== "done") return s as EpicStage;
  }
  return "investigating";
}

/** The epic an issue is: see the top of this file. A line is done when its box is ticked or what it names is no longer
 * open. `openIds` is every open item a line may name, of any kind: a task, a pull request, an agent issue or a sub-epic
 * counts as not done while it is open, and done once it is closed or merged (#464). */
export function parseEpic(input: EpicInput): Epic {
  const seen = new Map<string, EpicTask>();
  for (const m of input.body.matchAll(TASK_LINE)) {
    const id = m[2] as string;
    if (!seen.has(id)) seen.set(id, { id, done: m[1] !== " " || !input.openIds.has(id) });
  }
  const prd = /^PRD:[ \t]*(.*)$/m.exec(input.body)?.[1]?.trim() ?? "";
  const decisions = (/^Decisions:[ \t]*(.*)$/m.exec(input.body)?.[1] ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  return { id: String(input.number), title: input.title, stage: stageOf(input.labels, input.closed), tasks: [...seen.values()], prd, decisions,
    summary: summaryOf(input.body), cites: citesIn(`${input.title}\n${input.body}`), url: null };
}

function summaryOf(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l && !/^[-*]\s+\[[ xX]\]/.test(l) && !/^(PRD|Decisions):/.test(l));
  return (line ?? "").slice(0, 300);
}

export function progress(e: Epic): { done: number; all: number } {
  return { done: e.tasks.filter((t) => t.done).length, all: e.tasks.length };
}
