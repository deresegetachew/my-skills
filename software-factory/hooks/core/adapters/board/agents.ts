// The AgentRoster port on the message board (#513): with `tasks.source` board, each agent's liveness is a value,
// `<project>:agent:<name>` (the project as compose.ts's messagingProject names it, so projects sharing a board don't
// meet), written as that agent, with a `signal.agent` event ({project, name, status, detail}) in the same transaction, so
// a watcher hears it. The claims of an agent that went quiet are freed by the board's own sweep (its claim time passed
// and it sent no heartbeat for the quiet time).
import type { AgentRoster, AgentState } from "../../ports/agents.ts";
import type { BoardChild } from "./child.ts";

export interface BoardRosterOptions {
  child: BoardChild;
  /** The project's name (compose.ts's messagingProject). */
  project: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function stateOf(v: unknown): AgentState | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!text(o.name) || !text(o.status) || !text(o.ping)) return null;
  const extra: Record<string, string> = {};
  if (o.extra && typeof o.extra === "object" && !Array.isArray(o.extra)) {
    for (const [k, x] of Object.entries(o.extra as Record<string, unknown>)) if (typeof x === "string" && x) extra[k] = x;
  }
  return { name: text(o.name), role: text(o.role) || "coding-agent", status: text(o.status), detail: text(o.detail), ping: text(o.ping),
    started: text(o.started), machine: text(o.machine), extra };
}

export class BoardAgentRoster implements AgentRoster {
  constructor(private readonly o: BoardRosterOptions) {}

  save(s: AgentState, by = s.name): void {
    const signal = { name: "agent", payload: { project: this.o.project, name: s.name, status: s.status, detail: s.detail } };
    this.o.child.one(by, "setValue", this.key(s.name), { v: 1, ...s }, [signal]);
  }

  list(): AgentState[] {
    const rows = this.o.child.one("factory", "values", this.key("")) as { key: string; value: unknown }[];
    return rows.map((r) => stateOf(r.value)).filter((s): s is AgentState => s !== null);
  }

  sweepClaims(quietSeconds?: number): { id: string; holder: string }[] {
    const swept = this.o.child.one("factory", "sweep", quietSeconds === undefined ? {} : { quietSeconds }) as { id: number; holder: string }[];
    return swept.map((s) => ({ id: String(s.id), holder: s.holder }));
  }

  private key(name: string): string {
    return `${this.o.project}:agent:${name}`;
  }
}
