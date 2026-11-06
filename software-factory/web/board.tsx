// The tasks channel drawn as a board (#439, the owner's Board.dc.html): a column per factory label (Ready, In progress,
// In review, Blocked, Done, and Not ready when a task has no ready label yet), swim lanes by epic or by agent, and flat
// cards with the task's number, title, holder and one status, then its pull request and its checks. The lanes and
// columns are board_model.ts's. A card's actions (release, block, reassign; the API says which each card has) ask
// first, saying in plain words what happens and what doesn't, then run the commands the dev manager runs
// (factory_ui_views.ts taskAction) on the machine that serves the page; the board is live through the views message.
import { useContext, useState } from "react";
import { Avatar, AgentsContext } from "./avatar_view.tsx";
import { boardOf, cardTag, columnsOf, type LaneBy } from "./board_model.ts";
import type { Tone } from "./model.ts";
import { checksText, checksTone, type EpicRow, type PullRow, type TaskRow, taskTone } from "./views_model.ts";
import type { Post, Say, ViewProps } from "./views.tsx";

type ActionName = "release" | "block" | "reassign";

const LABELS: Record<ActionName, string> = { release: "Release", block: "Block", reassign: "Reassign" };

interface Ask {
  task: TaskRow;
  action: ActionName;
}

function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot ${tone}`} aria-hidden="true" />;
}

/** What the action does and doesn't do, in plain words, for the confirm. */
function whatHappens(a: Ask, agent: string): string {
  const id = `#${a.task.id}`;
  const who = a.task.holders[0];
  if (a.action === "release") {
    return `${id} goes back to Ready${who ? ` and ${who} lets go of it` : ""}; the next free agent takes it. Its branch and pull request stay.`;
  }
  if (a.action === "block") return `${id} moves to Blocked with your reason${who ? `, and ${who} stops on it` : ""}. Nothing is deleted: Release puts it back to Ready.`;
  return `${id} goes back to Ready, then ${agent || "the agent you pick"} is told to take it.${who ? ` ${who}'s branch stays.` : ""}`;
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
      say(r.ok === true ? { title: `${LABELS[ask.action]}: done for #${ask.task.id}.`, text: String(r.output ?? ""), tone: "good" }
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
        <p>{whatHappens(ask, agent)}</p>
        <p className="vsub">It runs in {project.name} on the machine that serves this page.</p>
        <div className="actions">
          <button className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void go()} disabled={busy || !ready}>{busy ? "Working…" : LABELS[ask.action]}</button>
        </div>
      </div>
    </div>
  );
}

function Card({ t, pull, open, act }: { t: TaskRow; pull?: PullRow; open: ViewProps["open"]; act: (a: Ask) => void }) {
  const actions = (t.actions ?? []).filter((a): a is ActionName => a in LABELS);
  const tag = cardTag(t, pull);
  return (
    <li className="bcard">
      <p className="btitle">{t.url ? <a className="ext" href={t.url} target="_blank" rel="noreferrer noopener">#{t.id}</a> : `#${t.id}`} {t.title}</p>
      <div className="bfoot">
        <span className="bwho">{t.holders.length ? t.holders.map((h) => (
          <button key={h} className="link" title={h} aria-label={`Open ${h}'s channel`} onClick={() => open(`agent:${h}`)}><Avatar name={h} size={20} /></button>
        )) : <span className="bnone">Unassigned</span>}</span>
        <span className="btag">{tag.needsYou && <span className="dot bad" aria-hidden="true" />}{tag.text}</span>
      </div>
      {t.pr && (
        <p className="bpr">
          <button className="link" onClick={() => open("view:pull-requests", `#${t.pr?.number}`)}>PR #{t.pr.number}</button>
          {t.pr.checks && <span title={checksText(t.pr.checks)}><Dot tone={checksTone(t.pr.checks.state)} />{checksText(t.pr.checks)}</span>}
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

/** A lane's grey line: an epic's stage and how many of its tasks are done, or how many tasks an agent holds. */
function laneSub(key: string, count: number, by: LaneBy, epics: EpicRow[]): string {
  const e = by === "epic" ? epics.find((x) => `#${x.id}` === key) : undefined;
  if (e) return `${e.stageText} · ${e.done} of ${e.all} done`;
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}

/** The board for `tasks` (already filtered), with its lanes by `by`. */
export function Board({ tasks, all, epics, pulls, by, project, open, post, say }: { tasks: TaskRow[]; all: TaskRow[]; epics: EpicRow[];
  pulls: PullRow[]; by: LaneBy; project: ViewProps["project"]; open: ViewProps["open"]; post: Post; say: Say }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const columns = columnsOf(all);
  const lanes = boardOf(tasks, by, epics);
  const pullOf = new Map(pulls.map((p) => [p.number, p]));
  const grid = { gridTemplateColumns: `repeat(${columns.length}, minmax(200px, 1fr))` };
  return (
    <div className="board" role="region" aria-label={`Board, lanes by ${by}`}>
      <div className="bgrid bcols" style={grid}>
        {columns.map((c) => (
          <div key={c.state} className="bcol-head"><Dot tone={taskTone(c.state)} /><strong>{c.title}</strong>
            <span className="bcount">{tasks.filter((t) => t.state === c.state).length}</span></div>
        ))}
      </div>
      {lanes.map((l) => (
        <section key={l.key || "-"} className="blane" aria-label={l.title}>
          <div className="blane-head">
            {by === "agent" && l.key ? <button className="link agent-link" onClick={() => open(`agent:${l.key}`)}><Avatar name={l.key} size={22} />{l.title}</button>
              : by === "epic" && l.key.startsWith("#") ? <button className="link" onClick={() => open("view:epics", l.key)}>{l.title}</button>
              : <h3>{l.title}</h3>}
            <span className="bsub">{laneSub(l.key, l.count, by, epics)}</span>
          </div>
          <div className="bgrid" style={grid}>
            {columns.map((c) => (
              <ul key={c.state} className="bcell" aria-label={`${l.title}: ${c.title}`}>
                {(l.cells[c.state] ?? []).map((t) => <Card key={t.id} t={t} pull={t.pr ? pullOf.get(t.pr.number) : undefined} open={open} act={setAsk} />)}
              </ul>
            ))}
          </div>
        </section>
      ))}
      {ask && <AskDialog ask={ask} project={project} post={post} say={say} close={() => setAsk(null)} />}
    </div>
  );
}

/** The epic filter chips (the reference design's): All epics, then each epic that has a task; the chosen one is solid. */
export function EpicChips({ epics, chosen, choose }: { epics: EpicRow[]; chosen: string | null; choose: (id: string | null) => void }) {
  return (
    <div className="bchips" role="group" aria-label="Filter by epic">
      <button aria-pressed={chosen === null} onClick={() => choose(null)}>All epics</button>
      {epics.map((e) => (
        <button key={e.id} aria-pressed={chosen === e.id} onClick={() => choose(chosen === e.id ? null : e.id)}>
          <Dot tone="quiet" />{e.title}</button>
      ))}
    </div>
  );
}

export const BOARD_CSS = String.raw`
.bchips { display: flex; flex-wrap: wrap; gap: 8px; }
.bchips button { height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg); color: var(--text);
  font: inherit; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
.bchips button[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); font-weight: 600; }
.bchips button[aria-pressed="true"] .dot { display: none; }
.board { overflow-x: auto; display: flex; flex-direction: column; gap: 24px; padding-bottom: 6px; }
.bgrid { display: grid; gap: 16px; min-width: min-content; }
.bcols { padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.bcol-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.bcount { color: var(--faint); }
.blane { display: flex; flex-direction: column; gap: 12px; }
.blane-head { display: flex; align-items: baseline; gap: 12px; position: sticky; left: 0; font-size: 15px; font-weight: 600; }
.blane-head h3 { margin: 0; font-size: 15px; }
.blane-head .agent-link { align-self: center; }
.bsub { color: var(--faint); font-size: 13px; font-weight: 400; }
.bcell { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
.bcard { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.btitle { margin: 0; font-weight: 600; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.bfoot { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); }
.bwho { display: inline-flex; gap: 2px; align-items: center; }
.bnone { color: var(--faint); }
.btag { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  color: var(--muted); text-align: right; }
.bpr { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.bpr span { display: inline-flex; align-items: center; gap: 4px; }
.bactions { display: flex; flex-wrap: wrap; gap: 6px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); margin: 10px 0; }
.field input, .field select { border: 1px solid var(--line); background: var(--bg); color: var(--text); border-radius: 8px; padding: 6px 10px; font: inherit; }
`;
