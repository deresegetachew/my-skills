// The integrations page's rules that aren't drawing (#441): its tabs and their counts, the rows each tab shows, and the
// tone of a state's dot. No React here, so tests/web_ui_integrations_model.test.ts runs it as it is.
import type { Tone } from "./model.ts";

export type IntegrationState = "ok" | "bad" | "off" | "unknown";
export type IntegrationTab = "all" | "bad" | "off";

export interface IntegrationRow {
  id: string;
  name: string;
  sub: string;
  state: IntegrationState;
  stateText: string;
  settings: { label: string; value: string }[];
  problem: { code: string; message: string; fix: string } | null;
  testable: boolean;
  actions: { name: string; label: string; does: string }[];
}

export interface UsesData {
  perAgent: boolean;
  note: string;
  connectors: { id: string; label: string }[];
  agents: { name: string; role: string; uses: string[] }[];
}

export interface IntegrationsData {
  project: string;
  summary: string;
  counts: { all: number; bad: number; off: number };
  integrations: IntegrationRow[];
  uses: UsesData;
}

export interface GridRow {
  name: string;
  role: string;
  cells: { id: string; on: boolean; label: string }[];
}

/** The grid of what each agent may use: a row per agent, a cell per connector, each labelled for a screen reader. */
export function usesGrid(u: UsesData): GridRow[] {
  return u.agents.map((a) => ({ name: a.name, role: a.role, cells: u.connectors.map((c) => {
    const on = a.uses.includes(c.id);
    return { id: c.id, on, label: `${a.name} ${on ? "may" : "may not"} use ${c.label}` };
  }) }));
}

const TAB_LABEL: Record<IntegrationTab, string> = { all: "All", bad: "Needs a fix", off: "Not set up" };

/** The rows tab `tab` shows, in the server's order. */
export function showRows<T extends { state: string }>(rows: T[], tab: IntegrationTab): T[] {
  return tab === "all" ? rows : rows.filter((r) => r.state === tab);
}

/** The page's tabs, each with how many rows it shows. */
export function integrationTabs(rows: { state: string }[]): { id: IntegrationTab; label: string; count: number }[] {
  return (["all", "bad", "off"] as const).map((id) => ({ id, label: TAB_LABEL[id], count: showRows(rows, id).length }));
}

/** The tone of a state's dot: set up is good, a fix is bad, the rest quiet. */
export function integrationTone(state: string): Tone {
  return state === "ok" ? "good" : state === "bad" ? "bad" : "quiet";
}
