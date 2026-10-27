// Agent cards (#107): who an agent is and what it can do, as data. This is the card a local agent would publish to an
// A2A peer (A2A's Agent Card); in this step nothing serves it, and `factory agents` renders from the same structure.
// The `/.well-known/agent-card.json` endpoint belongs to the later A2A adapter (docs/messages.md).
//
//   name       the agent's name (lowercase letters, digits, dashes; dev-manager, po and owner are the well-known ones)
//   kind       coding-agent | dev-manager | po
//   skills     what it does or answers, as short ids
//   state      working | idle | input-required | down, or silent (no ping for tasks.downMinutes), or unknown
//   location   machine (a terminal session) or cloud (a cloud session)
//   machine    the machine id when known (factory_machine.ts), else null
//   follow     how to watch it: remote-control:<name> for an agent on a machine (the name its Remote Control session
//              has), null for a cloud session
//   version    the factory version it runs
//   lastPing   the time of its last ping (ISO 8601), or null
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./factory_config.ts";
import { current, iso, machineOf, roleOf, stateOf } from "./factory_agents.ts";
import type { Issue } from "./factory_issues.ts";
import { parseIso } from "./factory_lib.ts";

const KINDS: Record<string, string> = { "dev-manager": "dev-manager", po: "po" };
const ROLE_KINDS: Record<string, string> = { "dev-manager": "dev-manager", "product-owner": "po" }; // an agent's role (its issue) decides its kind (#110)
const SKILLS: Record<string, string[]> = {
  "coding-agent": ["build-tasks"],
  "dev-manager": ["review-pull-requests", "answer-technical-questions", "answer-process-questions"],
  po: ["answer-product-questions", "keep-acceptance-criteria"],
};

export interface Card {
  name: string;
  kind: string;
  skills: string[];
  state: string;
  location: string;
  machine: string | null;
  follow: string | null;
  version: string;
  lastPing: string | null;
  role?: string;
}

export function kindOf(name: string): string {
  return KINDS[name] ?? "coding-agent";
}

/** The factory's own version (software-factory/VERSION), 'unknown' when it can't be read. */
export function factoryVersion(): string {
  try {
    const here = dirname(realpathSync(import.meta.path));
    return readFileSync(join(here, "..", "VERSION"), "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function card(name: string, state = "unknown", machineId: string | null = null, version: string | null = null,
  lastPing: string | null = null, role: string | null = null): Card {
  const kind = (role ? ROLE_KINDS[role] : undefined) || kindOf(name);
  const machine = kind === "coding-agent" || Boolean(machineId);
  return { name, kind, skills: [...(SKILLS[kind] as string[])], state, location: machine ? "machine" : "cloud",
    machine: machineId || null, follow: machine ? `remote-control:${name}` : null, version: version || factoryVersion(),
    lastPing };
}

/** The cards of the agents registered on GitHub (their current agent issue each), by name. */
export function cards(cfg: Config | Record<string, unknown>, issues: Issue[], version: string | null = null): Card[] {
  const out: Card[] = [];
  for (const issue of current(issues)) {
    const st = stateOf(cfg, issue);
    if (st) {
      const [name, status, ping] = st;
      const role = roleOf(issue);
      const c = card(name, status, machineOf(issue), version, iso(ping), role);
      c.role = role; // the role it runs (coding-agent, dev-manager, product-owner)
      out.push(c);
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.state < b.state ? -1 : a.state > b.state ? 1 : 0));
}

/** One line of `factory agents list`. */
export function row(c: Card): string {
  const ping = c.lastPing;
  const quiet = ping ? (Date.now() / 1000 - (parseIso(ping) ?? 0)) / 60 : 0;
  const when = quiet < 120 ? `${pyRound0(quiet)} min ago` : `${(quiet / 60).toFixed(1)} h ago`;
  return `${c.name.padEnd(12)} ${c.state.padEnd(8)} last ping ${ping} (${when})` +
    (c.machine ? `  machine ${c.machine}` : "") +
    (c.role !== undefined && c.role !== null && c.role !== "coding-agent" ? `  ${c.role}` : "");
}

/** Python's f"{x:.0f}": round half to even. */
export function pyRound0(x: number): string {
  const r = Math.round(x);
  const v = Math.abs(x - Math.trunc(x)) === 0.5 ? 2 * Math.round(x / 2) : r;
  return (Object.is(v, -0) ? 0 : v).toFixed(0);
}
