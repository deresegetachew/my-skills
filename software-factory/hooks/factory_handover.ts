#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory handover snapshot` (#100): the state a manager hands over, read from GitHub on the day, as plain text.
//
// The runbook (docs/manager-handover.md) starts by moving a long-running manager's notes out of its session. A snapshot made
// by hand goes stale; this prints the same facts from GitHub so nothing important stays only in a tick message:
//
//   factory handover snapshot        print it (markdown); post it as a comment on the owner queue, or paste it into
//                                    `<roles.dir>/dev-manager/README.md` where it is a stable fact
//   factory handover snapshot --json the same as JSON
//
// It lists: open pull requests (with who opened them), tasks in progress, blocked and ready, the open owner-queue asks and
// the open questions, the agents (role, state, machine), what needs a manager right now (`factory precheck`), and the numbers
// in use in the numbered folders (decisions, migrations) on main and in open PRs. It only reads.
import { type Config, load, taskLabels } from "./factory_config.ts";
import { agentIssues } from "./factory_agents.ts";
import { cards } from "./factory_cards.ts";
import { type Comment, ghAll, taskIssues } from "./factory_issues.ts";
import { folders, number } from "./factory_numbers.ts";
import { ownerQueue } from "./factory_orchestrator.ts";
import { openOwnerAsks, trustedOf } from "./factory_prs.ts";
import { type Pull, precheck } from "./factory_wait.ts";
import { die, pyDumps, run, runMain, splitLines } from "./factory_lib.ts";

const DOC = `\`factory handover snapshot\` (#100): the state a manager hands over, read from GitHub on the day, as plain text.

The runbook (docs/manager-handover.md) starts by moving a long-running manager's notes out of its session. A snapshot made
by hand goes stale; this prints the same facts from GitHub so nothing important stays only in a tick message:

  factory handover snapshot        print it (markdown); post it as a comment on the owner queue, or paste it into
                                   \`<roles.dir>/dev-manager/README.md\` where it is a stable fact
  factory handover snapshot --json the same as JSON

It lists: open pull requests (with who opened them), tasks in progress, blocked and ready, the open owner-queue asks and
the open questions, the agents (role, state, machine), what needs a manager right now (\`factory precheck\`), and the numbers
in use in the numbered folders (decisions, migrations) on main and in open PRs. It only reads.
`;

export function firstLine(text: string | null | undefined): string {
  for (const line of splitLines((text || "").replace(/<!--[\s\S]*?-->/g, ""))) {
    if (line.trim()) return line.trim().slice(0, 100);
  }
  return "";
}

/** {folder: highest number on main} for the numbered folders, from git (origin/<main>). */
export function numbersInUse(cfg: Config): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const folder of folders(cfg)) {
    const p = run(["git", "ls-tree", "--name-only", `origin/${cfg.mainBranch}:${folder}`]);
    const nums = p.code === 0 ? splitLines(p.stdout).map((n) => number(n)).filter((x) => x !== null).map((x) => x[0]) : [];
    out[folder] = nums.length ? Math.max(...nums) : null;
  }
  return out;
}

interface PullRow extends Pull {
  title?: string;
}

export interface Snapshot {
  at: string;
  pullRequests: { number: number; title: string; by: string; head: string; draft: boolean }[];
  tasks: Record<string, { number: number; title: string }[]>;
  ownerQueue: number | null;
  ownerAsks: { id: string; line: string }[];
  agents: { name: string; role: string; state: string; machine: string | null }[];
  needsAManager: string[];
  numbers: Record<string, number | null>;
}

export function snapshot(cfg: Config): Snapshot {
  const prs = ghAll<PullRow>("repos/{owner}/{repo}/pulls?state=open");
  const labels = taskLabels(cfg);
  const tasks: Record<string, { number: number; title: string }[]> = {};
  for (const key of ["inProgress", "blocked", "ready"]) {
    tasks[key] = taskIssues("open", labels[key] as string).map((i) => ({ number: i.number, title: i.title }));
  }
  const queue = ownerQueue(cfg, false);
  const asks: { id: string; line: string }[] = [];
  if (queue) {
    for (const [slug, c] of openOwnerAsks(ghAll<Comment>(`repos/{owner}/{repo}/issues/${queue}/comments`), trustedOf(cfg))) {
      asks.push({ id: slug, line: firstLine(typeof c.body === "string" ? c.body : "") });
    }
  }
  const t = (cfg.tasks || {}) as Record<string, unknown>;
  const agents = t.source === "issues" ? cards(cfg, agentIssues()) : [];
  return {
    at: new Date().toISOString().slice(0, 16) + "Z",
    pullRequests: prs.map((p) => ({ number: p.number, title: p.title ?? "", by: (p.user ?? {}).login ?? "",
      head: p.head.sha.slice(0, 7), draft: Boolean(p.draft) })),
    tasks, ownerQueue: queue, ownerAsks: asks,
    agents: agents.map((a) => ({ name: a.name, role: a.role ?? a.kind, state: a.state, machine: a.machine })),
    needsAManager: precheck(cfg),
    numbers: numbersInUse(cfg),
  };
}

export function render(s: Snapshot): string {
  const tasks = (key: string): { number: number; title: string }[] => s.tasks[key] ?? [];
  const out = [`## Manager handover snapshot (${s.at})`, "",
    "Made from GitHub on the day; the labels, markers and comments are the truth, this is a reading of them.", ""];
  out.push(`**Open pull requests (${s.pullRequests.length})**`);
  const prs = s.pullRequests.map((p) => `- #${p.number} ${p.title} (by ${p.by}, head ${p.head}${p.draft ? ", draft" : ""})`);
  out.push(...(prs.length ? prs : ["- none"]));
  for (const [key, title] of [["inProgress", "Tasks in progress"], ["blocked", "Tasks blocked"], ["ready", "Tasks ready"]] as const) {
    out.push("", `**${title} (${tasks(key).length})**`);
    const rows = tasks(key).map((t) => `- #${t.number} ${t.title}`);
    out.push(...(rows.length ? rows : ["- none"]));
  }
  out.push("", `**Open owner-queue asks (${s.ownerAsks.length})**` + (s.ownerQueue ? `, issue #${s.ownerQueue}` : ", no queue issue yet"));
  const asks = s.ownerAsks.map((a) => `- \`${a.id}\`: ${a.line}`);
  out.push(...(asks.length ? asks : ["- none"]));
  out.push("", `**Needs a manager right now (${s.needsAManager.length})**`);
  const needs = s.needsAManager.map((line) => `- ${line}`);
  out.push(...(needs.length ? needs : ["- nothing"]));
  out.push("", `**Agents (${s.agents.length})**`);
  const agents = s.agents.map((a) => `- ${a.name}: ${a.role}, ${a.state}` + (a.machine ? `, machine ${a.machine}` : ""));
  out.push(...(agents.length ? agents : ["- none registered on GitHub"]));
  out.push("", "**Numbers in use on main** (the next free one is one more; check open PRs too)");
  out.push(...Object.entries(s.numbers).map(([folder, n]) => `- ${folder}: ${n !== null ? n : "none yet"}`));
  return out.join("\n");
}

export function main(a: string[]): void {
  if (!a.length || a[0] !== "snapshot") die(DOC);
  const s = snapshot(load());
  console.log(a.includes("--json") ? pyDumps(s, { indent: 2 }) : render(s));
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
