// The Team page's rules (#581) that aren't drawing: every role in one list, with where each runs, its state and its
// task; the machines a new agent can go on; how many coding agents run at once here, in words; and the confirms for
// renaming an agent and setting the limit, each saying what will and won't happen. Adding and removing use the confirms
// of settings_model.ts, and Start and Stop those of parts_model.ts. No command is shown on screen (the owner's rule).
// No React here, so tests/web_ui_team_model.test.ts runs it as it is.
import { ROLE_TITLE } from "./model.ts";
import { andList, type ConfirmSpec } from "./parts_model.ts";
import { idleChecks, type RemoveFacts } from "./settings_model.ts";

/** An agent as it runs now (the shell's live state). */
export interface TeamLive {
  name: string;
  state: string;
  task: string | null;
  here: boolean;
  machineName: string | null;
}

/** The team as GET /api/projects/:p/settings sends it. */
export interface TeamFacts {
  agents: { name: string; role: string }[];
  /** The names once the staged changes are in. */
  next: Record<string, string[]>;
  /** Earlier names, by the name now. */
  former: Record<string, string[]>;
}

/** What this machine runs: its own list (from "machine"), FACTORY_AGENTS ("env") or every agent ("project"), and what
 * waits for a merge. */
export interface TeamMachine {
  agents: string[];
  from: string;
  pending: { join: string[]; leave: string[] };
}

export interface TeamRowView {
  name: string;
  role: string;
  roleTitle: string;
  /** Where it runs, in words. */
  machine: string;
  running: boolean;
  /** It runs on the machine that serves the page. */
  here: boolean;
  state: string;
  stateText: string;
  task: string | null;
  former: string[];
  /** Staged to join or to leave the team. */
  change: "joins" | "leaves" | null;
}

const ORDER = ["product-owner", "dev-manager", "coding-agent"];

const STATE_TEXT: Record<string, string> = { working: "Working", waiting: "Waiting", idle: "Idle", down: "Not running" };

/** Where `name` runs, in words: the machine it runs on now, else what this machine's settings say. */
export function whereText(name: string, live: TeamLive | undefined, m: TeamMachine, hereName: string | null): string {
  const here = hereName ?? "This machine";
  if (live && live.state !== "down") return live.machineName ?? (live.here ? here : "Another machine");
  if (m.from === "project") return `${here} (it runs every agent)`;
  if (m.agents.includes(name)) return here;
  if (m.pending.join.includes(name)) return `${here}, once merged`;
  return "Not on this machine";
}

/** Every role in one list: the product owner, the dev manager, then each coding agent, those staged to join last. */
export function teamRows(o: { team: TeamFacts; live: TeamLive[]; machine: TeamMachine; hereName: string | null }): TeamRowView[] {
  const next = Object.values(o.team.next).flat();
  const joining = Object.entries(o.team.next).flatMap(([role, names]) => names.filter((n) => !o.team.agents.some((a) => a.name === n))
    .map((name) => ({ name, role })));
  const all = [...o.team.agents, ...joining];
  const rank = (role: string): number => (ORDER.includes(role) ? ORDER.indexOf(role) : ORDER.length);
  const sorted = all.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a.role) - rank(y.a.role) || x.i - y.i).map((x) => x.a);
  return sorted.map(({ name, role }) => {
    const live = o.live.find((l) => l.name === name);
    const running = !!live && live.state !== "down";
    const state = running ? live?.state ?? "working" : "down";
    const joins = joining.some((j) => j.name === name);
    return { name, role, roleTitle: ROLE_TITLE[role] ?? role, machine: whereText(name, live, o.machine, o.hereName), running,
      here: live?.here ?? false, state, stateText: STATE_TEXT[state] ?? state, task: live?.task ?? null, former: o.team.former[name] ?? [],
      change: joins ? "joins" : next.includes(name) ? null : "leaves" };
  });
}

/** The coding agents running on this machine now. */
export function codingHere(agents: { name: string; role: string }[], live: TeamLive[]): string[] {
  return agents.filter((a) => a.role === "coding-agent").map((a) => a.name)
    .filter((n) => live.some((l) => l.name === n && l.here && l.state !== "down"));
}

/** The machines a new agent can go on: this one first, then the others the team runs on, then choose later. */
export function machineChoices(machines: { name: string; here: boolean }[]): { id: string; label: string }[] {
  const here = machines.find((m) => m.here);
  return [{ id: "here", label: here ? `This machine (${here.name})` : "This machine" },
    ...machines.filter((m) => !m.here).map((m) => ({ id: m.name, label: m.name })), { id: "later", label: "Choose later" }];
}

/** "No limit · 2 running here now", "At most 3 · 1 running here now". */
export function atOnceText(max: number | null, running: number): string {
  return `${max === null ? "No limit" : `At most ${max}`} · ${running} running here now`;
}

/** Setting how many coding agents run at once on this machine: saved at once, nothing is stopped. */
export function atOnceAsk(max: number | null, running: string[]): ConfirmSpec {
  const over = max !== null && running.length > max;
  return {
    title: max === null ? "Remove the limit on this machine?" : `Run at most ${max} coding agent${max === 1 ? "" : "s"} at once here?`,
    checks: [],
    happens: max === null ? "Any number of coding agents can be started on this machine. It is saved for this machine at once."
      : `Starting a coding agent here is refused while ${max} already run${max === 1 ? "s" : ""}. It is saved for this machine at once.`,
    doesNot: `${running.length ? `${andList(running)} keep${running.length === 1 ? "s" : ""} running${over ? ", even past the limit; stop one to get under it" : ""}. ` : ""}` +
      "Other machines keep their own limit, and the project's settings don't change.",
    action: max === null ? "Remove the limit" : `Save at most ${max}`,
    tone: "primary",
  };
}

/** Renaming an agent (#581): stopped, holding no task, and a free name; it is staged with the old name kept as an
 * earlier one. Its pull requests, branches, messages and finished tasks keep the name they were made under. */
export function renameAgentAsk(a: RemoveFacts, to: string, taken: string[]): ConfirmSpec {
  const free = !!to && !taken.includes(to) && to !== a.name;
  return {
    title: `Rename ${a.name} to ${to}?`,
    checks: [...idleChecks(a),
      { title: `${to || "The new name"} is free`, met: free, ...(free ? {} : { sub: "Pick a name no agent of the team has." }) }],
    happens: `${to} takes ${a.name}'s place in the team as a staged change, and ${a.name} is kept as its earlier name. Once you propose and ` +
      `merge it, ${to} shows in Your team, runs where ${a.name} ran on this machine, and you start it from its page.`,
    doesNot: `${a.name}'s pull requests, branches, messages and finished tasks keep the name ${a.name}, and nothing on GitHub changes until you propose it.`,
    action: `Rename to ${to}`,
    tone: "primary",
  };
}
