// The integrations page's few rules (#441): its tabs and their counts, the rows a tab shows, the line under the title and
// the colour of a row's dot. No React here, so it is tested on its own.
import type { Tone } from "./model.ts";

export type IntegrationState = "connected" | "needs-fix" | "not-set-up" | "unknown";

/** One row, as GET /api/projects/:p/integrations gives it (factory_ui_integrations.ts). */
export interface IntegrationRow {
  id: string;
  name: string;
  state: IntegrationState;
  stateText: string;
  sub: string;
  fix: string | null;
  test: string | null;
}

export type TabId = "all" | "needs-fix" | "not-set-up";

export interface Tab {
  id: TabId;
  label: string;
  count: number;
}

export function tabsOf(rows: IntegrationRow[]): Tab[] {
  return [
    { id: "all", label: "All", count: rows.length },
    { id: "needs-fix", label: "Needs a fix", count: rows.filter((r) => r.state === "needs-fix").length },
    { id: "not-set-up", label: "Not set up", count: rows.filter((r) => r.state === "not-set-up").length },
  ];
}

export function rowsFor(rows: IntegrationRow[], tab: TabId): IntegrationRow[] {
  return tab === "all" ? rows : rows.filter((r) => r.state === tab);
}

/** The line under the title: how many, and what needs the owner. */
export function summary(rows: IntegrationRow[]): string {
  const all = `${rows.length} connection${rows.length === 1 ? "" : "s"}.`;
  const bad = rows.filter((r) => r.state === "needs-fix");
  if (!bad.length) return rows.length > 1 ? `${all} Nothing needs you.` : all;
  if (bad.length === 1) return `${all} One needs a fix: ${(bad[0] as IntegrationRow).name}.`;
  return `${all} ${bad.length} need a fix.`;
}

export function stateTone(state: IntegrationState): Tone {
  return state === "connected" ? "good" : state === "needs-fix" ? "bad" : "quiet";
}
