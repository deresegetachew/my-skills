// The Board page (#439, the owner's Board.dc.html, on the foundations of #450): a column per factory label (Ready, In
// progress, In review, Blocked, Done, and Not ready when a task has no ready label yet), swim lanes by epic or by agent,
// and flat cards with the task's number, title, holder and one status, then its pull request and its checks. The lanes,
// columns and words are board_model.ts's. A card's actions (release, block, reassign; the API says which each card has)
// ask first, saying what happens and what doesn't, then run on the machine that serves the page (factory_ui_views.ts
// taskAction); the board is live through the views message. Colours are the palette's (theme.ts) only.
import { useContext, useState } from "react";
import { Avatar, AgentsContext } from "./avatar_view.tsx";
import { boardOf, cardTag, columnsOf, epicColour, type LaneBy, type TaskAction, taskAsk } from "./board_model.ts";
import { Chips } from "./parts.tsx";
import type { Tone } from "./model.ts";
import { checksText, checksTone, type EpicRow, type PullRow, type TaskRow, taskTone } from "./views_model.ts";
import type { Post, Say, ViewProps } from "./views.tsx";

const LABELS: Record<TaskAction, string> = { release: "Release", block: "Block", reassign: "Reassign" };

interface Ask {
  task: TaskRow;
  action: TaskAction;
}

function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot ${tone}`} aria-hidden="true" />;
}

/** The confirm for one card's action, in the shared confirm's look: a reason for block (needed) and release (optional),
 *  an agent for reassign, then what happens and what doesn't. */
function AskDialog({ ask, project, post, say, close }: { ask: Ask; project: ViewProps["project"]; post: Post; say: Say; close: () => void }) {
  const agents = Object.entries(useContext(AgentsContext)).filter(([, a]) => (a.role ?? "coding-agent") === "coding-agent")
    .map(([name]) => name).filter((n) => !ask.task.holders.includes(n)).sort();
  const [reason, setReason] = useState("");
  const [agent, setAgent] = useState(agents[0] ?? "");
  const [busy, setBusy] = useState(false);
  const ready = ask.action === "block" ? reason.trim() !== "" : ask.action === "reassign" ? agent !== "" : true;
  const words = taskAsk(ask.action, ask.task, agent);
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
        <h2 id="task-ask">{LABELS[ask.action]} #{ask.task.id}?</h2>
        <p className="muted">{ask.task.title}</p>
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
        <div className="confirm-what">
          <strong>What happens</strong><p>{words.happens}</p>
          <strong>What doesn't</strong><p>{words.doesNot}</p>
        </div>
        <p className="muted">It runs in {project.name} on the machine that serves this page.</p>
        <div className="actions">
          <button className="btn primary" onClick={() => void go()} disabled={busy || !ready}>{busy ? "Working…" : LABELS[ask.action]}</button>
          <button className="btn plain" onClick={close} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Card({ t, pull, open, act }: { t: TaskRow; pull?: PullRow; open: ViewProps["open"]; act: (a: Ask) => void }) {
  const actions = (t.actions ?? []).filter((a): a is TaskAction => a in LABELS);
  const tag = cardTag(t, pull);
  return (
    <li className="bcard">
      <p className="btitle">{t.url ? <a className="ext" href={t.url} target="_blank" rel="noreferrer noopener">#{t.id}</a> : `#${t.id}`} {t.title}</p>
      <div className="bfoot">
        <span className="bwho">{t.holders.length ? t.holders.map((h) => (
          <button key={h} className="bavatar" title={h} aria-label={`Open ${h}'s page`} onClick={() => open(`agent:${h}`)}><Avatar name={h} size={20} /></button>
        )) : <span className="bnone">Unassigned</span>}</span>
        <span className="btag">{tag.needsYou && <span className="sdot down" aria-hidden="true" />}{tag.text}</span>
      </div>
      {t.pr && (
        <p className="bpr">
          <button className="blink" onClick={() => open("view:pull-requests", `#${t.pr?.number}`)}>PR #{t.pr.number}</button>
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
  const grid = { gridTemplateColumns: `repeat(${columns.length}, minmax(150px, 1fr))` };
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
            {by === "agent" && l.key ? <button className="blink bagent" onClick={() => open(`agent:${l.key}`)}><Avatar name={l.key} size={22} />{l.title}</button>
              : by === "epic" && l.key.startsWith("#") ? <button className="blink" onClick={() => open("view:epics", l.key)}>{l.title}</button>
              : <h2>{l.title}</h2>}
            <span className="bsub">{laneSub(l.key, l.count, by, epics)}</span>
          </div>
          <div className="bgrid" style={grid}>
            {columns.map((c) => (
              <ul key={c.state} className="bcell" data-col={c.title} aria-label={`${l.title}: ${c.title}`}>
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

/** The epic filter (the reference design's chips): All epics, then each epic that has a task, each with its colour's
 *  dot; the chosen one is the solid pill. `all` is every epic, so an epic keeps its colour however the list is cut. */
export function EpicChips({ epics, all, chosen, choose }: { epics: EpicRow[]; all: EpicRow[]; chosen: string | null; choose: (id: string | null) => void }) {
  const chips = [{ id: "", label: "All epics" },
    ...epics.map((e) => ({ id: e.id, label: e.title, dot: epicColour(Math.max(all.findIndex((x) => x.id === e.id), 0)) }))];
  return <Chips label="Filter by epic" chips={chips} value={chosen ?? ""} onChange={(id) => choose(id === "" ? null : id)} />;
}

export const BOARD_CSS = String.raw`
.bfilters { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.board { overflow-x: auto; display: flex; flex-direction: column; gap: 28px; padding-bottom: 6px; }
.bgrid { display: grid; gap: 16px; min-width: min-content; align-items: start; }
.bcols { padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.bcol-head { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
.bcol-head strong { color: var(--text); font-weight: 600; }
.bcount { color: var(--text-3); }
.blane { display: flex; flex-direction: column; gap: 12px; }
.blane-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; position: sticky; left: 0; max-width: calc(100vw - 32px); }
.blane-head h2, .blane-head .blink { margin: 0; font-size: 15px; font-weight: 600; color: var(--text); }
.blane-head .bagent { align-self: center; }
.bsub { color: var(--text-3); font-size: 13px; }
.blink { border: 0; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
.blink:hover { text-decoration: underline; }
.bcell { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
.bcard { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.btitle { margin: 0; font-weight: 600; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.btitle .ext { color: inherit; text-decoration: none; }
.btitle .ext:hover { text-decoration: underline; }
.bfoot { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--text-2); }
.bwho { display: inline-flex; gap: 2px; align-items: center; }
.bavatar { border: 0; background: none; padding: 0; cursor: pointer; display: inline-flex; border-radius: 50%; }
.bnone { color: var(--text-3); }
.btag { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-2); text-align: right; }
.bpr { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-2); }
.bpr .blink { font-weight: 600; color: var(--text); }
.bpr span { display: inline-flex; align-items: center; gap: 4px; }
.bactions { display: flex; flex-wrap: wrap; gap: 6px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-2); }
.field input, .field select { height: 44px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); border-radius: 10px;
  padding: 0 12px; font: inherit; }
/* a phone: a lane's columns one under another, each named, and an empty one left out */
@media (max-width: 760px) {
  .board { overflow-x: visible; }
  .bcols { display: none; }
  .bgrid { grid-template-columns: minmax(0, 1fr) !important; min-width: 0; gap: 10px; }
  .blane-head { position: static; max-width: none; }
  .bcell { min-height: 0; }
  .bcell:empty { display: none; }
  .bcell::before { content: attr(data-col); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); }
}
`;
