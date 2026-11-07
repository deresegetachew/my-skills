// What each task took (#580): the facts on a task's page and an epic's page, read from GET /api/projects/:p/costs, and
// the sortable "By task" table on Usage and cost. The words are cost_model.ts's.
import { useEffect, useState } from "react";
import { costCells, type CostRow, type CostsData, SORT_KEYS, SORT_LABEL, type SortKey, sortCosts } from "./cost_model.ts";
import { authHeaders } from "./signin_model.ts";

/** What each task took in `project`, read once when a page opens (null until it answers, or when it can't be read). */
export function useCosts(project: string, token: string): CostsData | null {
  const [data, setData] = useState<CostsData | null>(null);
  useEffect(() => {
    let gone = false;
    fetch(`/api/projects/${encodeURIComponent(project)}/costs`, { headers: authHeaders(token) })
      .then((r) => r.json() as Promise<CostsData>)
      .then((j) => { if (!gone && Array.isArray(j.tasks)) setData(j); })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [project, token]);
  return data;
}

/** A list of facts, as the task and epic pages show theirs. */
export function CostFacts({ title, facts }: { title: string; facts: Array<{ label: string; value: string }> }) {
  return (
    <section aria-label={title}>
      <h3 className="vgroup">{title}</h3>
      <dl className="facts">{facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
    </section>
  );
}

/** The "By task" table: one row per task, sorted by the column picked (again: the other way). */
export function CostTable({ rows, open }: { rows: CostRow[]; open: (channel: string, find?: string) => void }) {
  const [key, setKey] = useState<SortKey>("cost");
  const [desc, setDesc] = useState(true);
  const pick = (k: SortKey): void => {
    if (k === key) setDesc(!desc);
    else {
      setKey(k);
      setDesc(k !== "task");
    }
  };
  if (!rows.length) return <p className="empty">No task has a session or a recorded time yet.</p>;
  return (
    <div className="cost-table-wrap">
      <table className="cost-table">
        <thead>
          <tr>{SORT_KEYS.map((k) => (
            <th key={k} scope="col" aria-sort={k === key ? (desc ? "descending" : "ascending") : "none"}>
              <button className="link" onClick={() => pick(k)}>{SORT_LABEL[k]}{k === key ? (desc ? " ↓" : " ↑") : ""}</button>
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {sortCosts(rows, key, desc).map((r) => {
            const c = costCells(r);
            return (
              <tr key={r.task}>
                {SORT_KEYS.map((k) => k === "task"
                  ? <td key={k}><button className="link" onClick={() => open("view:tasks", `#${r.task}`)}>{c.task}</button></td>
                  : <td key={k}>{c[k]}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const COSTS_CSS = String.raw`
.cost-table-wrap { overflow-x: auto; margin: 12px 0; }
.cost-table { border-collapse: collapse; width: 100%; font-size: 13px; }
.cost-table th, .cost-table td { text-align: right; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.cost-table th:first-child, .cost-table td:first-child { text-align: left; white-space: normal; }
.cost-table th { color: var(--text-2); font-weight: 500; }
`;
