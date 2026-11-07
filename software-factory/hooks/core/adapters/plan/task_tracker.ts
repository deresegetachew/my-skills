// The TaskTracker port on the build plan (decision 0003, #377): each task is a `- [ ] **1.3 Title.**` line in `plan`, its
// todos the checkboxes under it, a ticked line is done, and the `blocked` list says which are blocked and why. Claims
// are the local claims file (factory_claims.ts), as plan mode always kept them: a claim lasts as long as its process,
// and a task whose task/<id>-... branch got a recent commit counts as taken.
//
// Reads come from the main branch when they can (`git show origin/<main>:<path>`), so a stale working copy can't make an
// agent skip or repeat a task; writes go to the working copy, which the agent commits on its branch.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { citesIn } from "../../../factory_cites.ts";
import { alive, type Claims, claimTask, locked } from "../../../factory_claims.ts";
import { blockedIds, type Config, toFloat } from "../../../factory_config.ts";
import { prdWait } from "../../../factory_issues.ts";
import { run } from "../../../factory_lib.ts";
import type { Claimant } from "../../domain/claim.ts";
import type { Epic } from "../../domain/epic.ts";
import { CoreError } from "../../domain/error.ts";
import { checkClaim, dependencies, prdSkipNote, type Task, tickTodo, todos } from "../../domain/task.ts";
import type { Filed, NewTask, Picked, TaskTracker } from "../../ports/task_tracker.ts";

const LINE = /^[^\S\n]*- \[( |x|X)\] \*\*(\d+(?:\.\d+)*)\s*([^*]*)\*\*/;
const HEADING = /^#+\s*(.*)$/;

/** A task line in the plan's text: where it is, and its block (the lines under it up to the next task or heading). */
interface Line {
  id: string;
  title: string;
  done: boolean;
  at: number; // the task line's index
  end: number; // one past its block's last line
  group: string;
}

export class PlanTaskTracker implements TaskTracker {
  constructor(private readonly cfg: Config) {}

  list(): Task[] {
    return this.all().filter((t) => t.state !== "done");
  }

  show(id: string): string {
    const lines = this.read(this.cfg.plan).split("\n");
    const l = this.line(id, lines);
    const t = this.all().find((x) => x.id === id) as Task;
    return `${id} ${t.title}  [${t.state}]\n\n${lines.slice(l.at, l.end).join("\n").trimEnd()}`;
  }

  next(): Task | null {
    const all = this.all();
    return all.find((t) => t.state === "ready" && !t.waitsForPrd && !waiting(t, all).length) ?? null;
  }

  pick(who: Claimant): Picked {
    const all = this.all();
    const open = all.filter((t) => (t.state === "ready" || t.state === "in-progress") && !waiting(t, all).length);
    // a ready task whose PRD change hasn't merged is skipped, and the note says so (#578)
    const note = prdSkipNote(open.filter((t) => t.waitsForPrd).map((t) => ({ name: t.id, pr: t.waitsForPrd as string })));
    const free = open.filter((t) => !t.waitsForPrd);
    const id = free.length ? claimTask(free.map((t) => t.id), who.agent, who.pid ?? process.pid, this.cfg) : null;
    const t = free.find((x) => x.id === id);
    const picked: Picked = { task: t ? { ...t, state: "in-progress", holders: [who.agent] } : null };
    return note ? { ...picked, note } : picked;
  }

  claim(id: string, who: Claimant): Task {
    const all = this.all();
    const t = all.find((x) => x.id === id);
    if (!t || t.state === "done") {
      throw new CoreError("task-not-found", `${id} is not an open task in ${this.cfg.plan}.`, `Check the id with \`factory next\` or in ${this.cfg.plan}.`);
    }
    const [check, open] = checkClaim(t, who.agent, () => true, () => waiting(t, all));
    if (check === "mine") return t;
    if (check === "taken") throw new CoreError("task-taken", `${id} is already taken by ${t.holders[0] ?? "another agent"}.`, "Pick another task.");
    if (check === "blocked") throw new CoreError("task-blocked", `${id} is blocked (${this.cfg.blocked}).`, "Pick another task.");
    if (check === "prd") {
      throw new CoreError("task-waits-for-prd", `${id} waits for its PRD change, PR #${open[0]}, to merge.`,
        `Pick another task: ${id} is ready once the owner merges PR #${open[0]}. To build it now, take the \`PRD change:\` line out of ${id} in ${this.cfg.plan}.`);
    }
    if (check === "waiting") throw new CoreError("task-blocked", `${id} waits for ${open.join(", ")}.`, "Build the tasks it depends on first, or pick another task.");
    if (check === "not-ready") throw new CoreError("task-not-ready", `${id} is not ready.`, "Pick another task.");
    if (claimTask([id], who.agent, who.pid ?? process.pid, this.cfg) !== id) {
      throw new CoreError("task-taken", `Another agent claimed ${id} first.`, "Pick another task.");
    }
    return { ...t, state: "in-progress", holders: [who.agent] };
  }

  release(id: string): void {
    locked((data) => void delete data.tasks[id]);
    const text = this.working(this.cfg.blocked);
    const kept = text.split("\n").filter((l) => !isBlockedLine(l, id)).join("\n");
    if (kept !== text) writeFileSync(this.cfg.blocked, kept);
  }

  setState(id: string, state: "in-review" | "done"): string {
    const lines = this.working(this.cfg.plan).split("\n");
    const l = this.line(id, lines);
    if (state === "in-review") return `${id} is in review: a plan has no review state, so nothing changed.`;
    lines[l.at] = (lines[l.at] as string).replace(/- \[ \]/, "- [x]");
    writeFileSync(this.cfg.plan, lines.join("\n"));
    return `${id} is done: ticked in ${this.cfg.plan}.`;
  }

  tick(id: string, index: number): void {
    const lines = this.working(this.cfg.plan).split("\n");
    const l = this.line(id, lines);
    const block = tickTodo(lines.slice(l.at + 1, l.end).join("\n"), index, id);
    writeFileSync(this.cfg.plan, [...lines.slice(0, l.at + 1), block, ...lines.slice(l.end)].join("\n"));
  }

  block(id: string, reason: string): void {
    this.line(id, this.working(this.cfg.plan).split("\n"));
    locked((data) => void delete data.tasks[id]); // a block ends the claim, as on GitHub
    const text = existsSync(this.cfg.blocked) ? readFileSync(this.cfg.blocked, "utf8") : "# Blocked\n\n";
    writeFileSync(this.cfg.blocked, `${text}${text.endsWith("\n") ? "" : "\n"}- ${id}: ${reason}\n`);
  }

  epics(): Epic[] {
    return [];
  }

  /** Its claims don't run out: nothing to keep. */
  keep(_id: string): boolean {
    return false;
  }

  file(task: NewTask): Filed {
    const lines = this.working(this.cfg.plan).split("\n");
    const found = parse(lines);
    const last = found[found.length - 1];
    const id = last ? nextId(last.id) : "1.1";
    let at = last ? last.end : lines.length;
    while (last && at > last.at + 1 && !(lines[at - 1] as string).trim()) at--; // after its last line, not its blank ones
    const first = task.body.split("\n").find((x) => x.trim())?.trim() ?? "";
    const line = `- [ ] **${id} ${task.title.replace(/\.+$/, "")}.**${first ? " " + first : ""}`;
    lines.splice(at, 0, line);
    writeFileSync(this.cfg.plan, lines.join("\n"));
    return { id, url: this.cfg.plan };
  }

  /** Every task in the plan (done ones too), in order, with its state. */
  private all(): Task[] {
    const lines = this.read(this.cfg.plan).split("\n");
    const blocked = blockedIds(this.read(this.cfg.blocked));
    const held = this.held();
    const prds = new Map<number, boolean>();
    return parse(lines).map((l): Task => {
      const block = lines.slice(l.at + 1, l.end).join("\n");
      const holder = held[l.id];
      const state = l.done ? "done" : blocked.has(l.id) ? "blocked" : holder ? "in-progress" : "ready";
      // a ready task's PRD change (#578) is looked up on GitHub, once per pull request; a task without the line asks nothing
      const prd = state === "ready" ? prdWait(`${lines[l.at]}\n${block}`, prds) : null;
      return { id: l.id, title: l.title, state, holders: holder && !l.done ? [holder] : [],
        dependsOn: dependencies(`${lines[l.at]}\n${block}`, "plan"), todos: todos(block), group: l.group, tags: [],
        cites: citesIn(`${lines[l.at]}\n${block}`), ...(prd === null ? {} : { waitsForPrd: prd }) };
    });
  }

  /** The line for task `id`, or a refusal. */
  private line(id: string, lines: string[]): Line {
    const l = parse(lines).find((x) => x.id === id);
    if (!l) throw new CoreError("task-not-found", `${id} is not a task in ${this.cfg.plan}.`, `Check the id in ${this.cfg.plan}.`);
    return l;
  }

  /** The agents holding tasks by a live local claim: {task id: agent}. Read without the lock and without making the
   * claims folder, so looking changes nothing. */
  private held(): Record<string, string> {
    const p = run(["git", "rev-parse", "--git-common-dir"]);
    const file = join(resolve(p.code === 0 && p.stdout.trim() ? p.stdout.trim() : ".git"), "factory", "claims.json");
    let data: Partial<Claims> = {};
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as Partial<Claims>;
    } catch {
      return {};
    }
    const stale = toFloat(this.cfg.claimStaleHours ?? 6) ?? 6;
    const out: Record<string, string> = {};
    for (const [tid, c] of Object.entries(data.tasks ?? {})) if (c.agent && alive(c, stale)) out[tid] = c.agent;
    return out;
  }

  /** `path` from the main branch when it can, else the working copy, else "". */
  private read(path: string): string {
    const p = run(["git", "show", `origin/${this.cfg.mainBranch}:${path}`]);
    return p.code === 0 ? p.stdout : this.working(path);
  }

  private working(path: string): string {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }
}

function parse(lines: string[]): Line[] {
  const out: Line[] = [];
  let group = "";
  lines.forEach((text, k) => {
    const h = HEADING.exec(text);
    const m = LINE.exec(text);
    if (h || m) {
      const prev = out[out.length - 1];
      if (prev && prev.end === -1) prev.end = k;
    }
    if (h) group = (h[1] as string).trim();
    if (m) {
      out.push({ id: m[2] as string, title: (m[3] as string).trim().replace(/\.+$/, ""), done: (m[1] as string).toLowerCase() === "x",
        at: k, end: -1, group });
    }
  });
  const last = out[out.length - 1];
  if (last && last.end === -1) last.end = lines.length;
  return out;
}

/** The task ids `t` depends on that are in the plan and not done (an id the plan doesn't have doesn't hold it back). */
function waiting(t: Task, all: Task[]): string[] {
  return t.dependsOn.filter((d) => all.some((x) => x.id === d && x.state !== "done"));
}

function isBlockedLine(line: string, id: string): boolean {
  const m = /^\s*-\s*(\d+(?:\.\d+)*)\s*:/.exec(line);
  return m !== null && m[1] === id;
}

/** 1.3 -> 1.4; 2 -> 3. */
function nextId(id: string): string {
  const parts = id.split(".");
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
  return parts.join(".");
}
