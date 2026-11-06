// The tasks channel drawn as a board (#439): a column per factory label (Ready, In progress, In review, Blocked, Done,
// and Not ready when a task has no ready label yet), swim lanes by agent or by epic, and cards with the task's number,
// title, holder, pull request and its checks. The lanes and columns are board_model.ts's. A card's actions (release,
// block, reassign; the API says which each card has) ask first, then run the commands the dev manager runs
// (factory_ui_views.ts taskAction) on the machine that serves the page; the board is live through the views message.
import { useContext, useState } from "react";
import { Avatar, AgentsContext } from "./avatar_view.tsx";
import { boardOf, columnsOf, type LaneBy } from "./board_model.ts";
import type { Tone } from "./model.ts";
import { checksText, checksTone, type TaskRow } from "./views_model.ts";
import type { Post, Say, ViewProps } from "./views.tsx";

type ActionName = "release" | "block" | "reassign";

const LABELS: Record<ActionName, string> = { release: "Release", block: "Block", reassign: "Reassign" };

const DOES: Record<ActionName, string> = {
  release: "puts it back to ready, with its agent's label off; the next free agent takes it",
  block: "parks it until a person provides what the reason says",
  reassign: "puts it back to ready, then tells that agent to take it",
};

interface Ask {
  task: TaskRow;
  action: ActionName;
}

function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot ${tone}`} aria-hidden="true" />;
}

function commandOf(a: Ask, reason: string, agent: string): string {
  const id = a.task.id;
  if (a.action === "block") return `factory issues block ${id} "${reason.trim() || "<reason>"}"`;
  if (a.action === "release") return `factory issues release ${id} "${reason.trim() || "released from the web UI"}"`;
  return `factory issues release ${id} "reassigned to ${agent || "<agent>"} from the web UI" then factory say ${agent || "<agent>"} "/next-task issue-${id}"`;
}

/** The confirm for one card's action: a reason for block (needed) and release (optional), an agent for reassign. */
function AskDialog({ ask, project, post, say, close }: { ask: Ask; project: ViewProps["project"]; post: Post; say: Say; close: () => void }) {
  const agents = Object.entries(useContext(AgentsContext)).filter(([, a]) => (a.role ?? "coding-agent") === "coding-agent")
    .map(([name]) => name).filter((n) => !ask.task.holders.includes(n)).sort();
  const [reason, setReason] = useState("");
  const [agent, setAgent] = useState(agents[0] ?? "");
  const [busy, setBusy] = useState(false);
  const ready = ask.action === "block" ? reason.trim() !== "" : ask.action === "reassign" ? agent !== "" : true;
  const go = async (): Promise<void> => {
    setBusy(true);
    try {
      const path = `/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(ask.task.id)}/actions/${ask.action}`;
      const r = await post(path, { confirm: true, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(ask.action === "reassign" ? { agent } : {}) });
      say(r.ok === true ? { title: `Ran ${String(r.command)}`, text: String(r.output ?? ""), tone: "good" }
        : { title: String(r.message ?? "It didn't run."), text: [r.fix, r.output].filter(Boolean).map(String).join("\n\n"), tone: "bad" });
    } finally {
      setBusy(false);
      close();
    }
  };
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) close(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="task-ask">
        <h3 id="task-ask">{LABELS[ask.action]} #{ask.task.id}?</h3>
        <p className="vsub">{ask.task.title}</p>
        {ask.action === "reassign" && (
          <label className="field">To
            {agents.length ? (
              <select value={agent} onChange={(e) => setAgent(e.target.value)} autoFocus>
                {agents.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            ) : <span className="empty">No other coding agent in this project.</span>}
          </label>
        )}
        {ask.action !== "reassign" && (
          <label className="field">{ask.action === "block" ? "What a person must provide" : "Why (optional)"}
            <input type="text" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus
              placeholder={ask.action === "block" ? "needs the Stripe keys" : "released from the web UI"} />
          </label>
        )}
        <p>This runs <code>{commandOf(ask, reason, agent)}</code> in {project.name}.</p>
        <p>It {DOES[ask.action]}.</p>
        <div className="actions">
          <button className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void go()} disabled={busy || !ready}>{busy ? "Running…" : "Run it"}</button>
        </div>
      </div>
    </div>
  );
}

function Card({ t, open, act }: { t: TaskRow; open: ViewProps["open"]; act: (a: Ask) => void }) {
  const actions = (t.actions ?? []).filter((a): a is ActionName => a in LABELS);
  return (
    <li className={t.next ? "bcard next" : "bcard"}>
      <div className="bhead">
        <span className="vid">{t.url ? <a className="ext" href={t.url} target="_blank" rel="noreferrer noopener">#{t.id}</a> : `#${t.id}`}</span>
        {t.next && <span className="tag">next</span>}
        <span className="bwho">{t.holders.map((h) => (
          <button key={h} className="link" title={h} aria-label={`Open ${h}'s channel`} onClick={() => open(`agent:${h}`)}><Avatar name={h} size={22} /></button>
        ))}</span>
      </div>
      <p className="btitle">{t.title}</p>
      {(t.pr || t.todos.all > 0) && (
        <p className="vsub">
          {t.pr && (
            <span className="bpr">
              <button className="link" onClick={() => open("view:pull-requests", `#${t.pr?.number}`)}>PR #{t.pr.number}</button>
              {t.pr.checks && <span title={checksText(t.pr.checks)}><Dot tone={checksTone(t.pr.checks.state)} />{checksText(t.pr.checks)}</span>}
            </span>
          )}
          {t.todos.all > 0 && <span>{t.todos.done}/{t.todos.all} todos</span>}
        </p>
      )}
      {actions.length > 0 && (
        <div className="bactions">
          {actions.map((a) => <button key={a} className="btn small" onClick={() => act({ task: t, action: a })}>{LABELS[a]}</button>)}
        </div>
      )}
    </li>
  );
}

/** The board for `tasks` (already filtered), with its lanes by `by`. */
export function Board({ tasks, all, by, project, open, post, say }: { tasks: TaskRow[]; all: TaskRow[]; by: LaneBy; project: ViewProps["project"];
  open: ViewProps["open"]; post: Post; say: Say }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const columns = columnsOf(all);
  const lanes = boardOf(tasks, by);
  const grid = { gridTemplateColumns: `repeat(${columns.length}, minmax(220px, 1fr))` };
  return (
    <div className="board" role="region" aria-label={`Board, lanes by ${by}`}>
      <div className="bgrid bcols" style={grid}>
        {columns.map((c) => (
          <div key={c.state} className="bcol-head">{c.title} <span className="bcount">{tasks.filter((t) => t.state === c.state).length}</span></div>
        ))}
      </div>
      {lanes.map((l) => (
        <section key={l.key || "-"} className="blane" aria-label={l.title}>
          <h3 className="blane-head">
            {by === "agent" && l.key ? <button className="link agent-link" onClick={() => open(`agent:${l.key}`)}><Avatar name={l.key} size={22} />{l.title}</button>
              : <span>{l.title}</span>}
            <span className="bcount">{l.count}</span>
          </h3>
          <div className="bgrid" style={grid}>
            {columns.map((c) => (
              <ul key={c.state} className="bcell" aria-label={`${l.title}: ${c.title}`}>
                {(l.cells[c.state] ?? []).map((t) => <Card key={t.id} t={t} open={open} act={setAsk} />)}
              </ul>
            ))}
          </div>
        </section>
      ))}
      {ask && <AskDialog ask={ask} project={project} post={post} say={say} close={() => setAsk(null)} />}
    </div>
  );
}

export const BOARD_CSS = String.raw`
.vmode { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.vmode button { border: 0; background: var(--bg); color: var(--muted); padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.vmode button[aria-pressed="true"] { background: var(--bg-soft); color: var(--text); font-weight: 600; }
.board { overflow-x: auto; display: flex; flex-direction: column; gap: 14px; padding-bottom: 6px; }
.bgrid { display: grid; gap: 10px; min-width: min-content; }
.bcol-head { font-size: 12.5px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding: 0 4px; }
.bcount { color: var(--faint); font-weight: 600; margin-left: 4px; }
.blane { display: flex; flex-direction: column; gap: 8px; }
.blane-head { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; position: sticky; left: 0; }
.bcell { list-style: none; margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 8px; min-height: 44px;
  background: var(--bg-soft); border-radius: var(--radius); }
.bcard { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.bcard.next { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
.bhead { display: flex; align-items: center; gap: 6px; }
.bwho { margin-left: auto; display: inline-flex; gap: 2px; }
.btitle { margin: 0; font-weight: 600; font-size: 13.5px; overflow-wrap: anywhere; }
.bpr { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.bpr span { display: inline-flex; align-items: center; gap: 4px; }
.bactions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); margin: 10px 0; }
.field input, .field select { border: 1px solid var(--line); background: var(--bg); color: var(--text); border-radius: 8px; padding: 6px 10px; font: inherit; }
`;
