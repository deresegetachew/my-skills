// The AgentRoster port (#513): where each agent says it is alive and what it does, with `tasks.source` board. In issues
// mode the agents keep an issue each on GitHub (factory_agents.ts), which is not this port; on the message board each
// agent's last word is a value (adapters/board/agents.ts). core/compose.ts's agentRoster picks it.

/** What an agent last said about itself. Times are ISO 8601 (UTC). */
export interface AgentState {
  name: string;
  /** coding-agent, dev-manager or product-owner. */
  role: string;
  /** working, waiting, idle, input-required or down. */
  status: string;
  /** What it works on or waits for ("working on #42"), "" when idle or down. */
  detail: string;
  /** Its last ping. */
  ping: string;
  /** When its loop or session started. */
  started: string;
  /** The machine id it runs on ("" when unknown). */
  machine: string;
  /** The rest of what its marker carried in issues mode: kind, task, where, follow ... */
  extra: Record<string, string>;
}

export interface AgentRoster {
  /** Keep `state` as the agent's last word, replacing the one before; written as `by` (default: the agent itself). */
  save(state: AgentState, by?: string): void;
  /** Every agent's last word, by name. */
  list(): AgentState[];
  /** Free the claims whose time passed and whose holder was quiet for `quietSeconds` (the tracker's own rules). */
  sweepClaims(quietSeconds?: number): { id: string; holder: string }[];
}
