// The Board page (#439, the owner's Board.dc.html, on the foundations of #450): a column per factory label (Ready, In
// progress, In review, Blocked, Done, and Not ready when a task has no ready label yet), swim lanes by epic or by agent,
// and flat cards with the task's number, title, holder and one status, then its pull request and its checks. The lanes,
// columns and words are board_model.ts's. A card's actions (release, block, reassign; the API says which each card has)
// ask first, saying what happens and what doesn't, then run on the machine that serves the page (factory_ui_views.ts
// taskAction); the board is live through the views message. Colours are the palette's (theme.ts) only.
import { useContext, useEffect, useState } from "react";
import { Avatar, AgentsContext } from "./avatar_view.tsx";
import { blockersText, boardOf, cardEdge, cardTag, columnsOf, epicColour, laneColours, type LaneBy, type TaskAction, taskAsk, taskLabel, unheldText } from "./board_model.ts";
import { Chips } from "./parts.tsx";
import { ago, type Tone } from "./model.ts";
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

/** Calls `close` when Escape is pressed (#545: every dialog closes with Escape), unless `hold` (it is working). */
function useEscape(close: () => void, hold = false): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !hold) {
        e.stopPropagation();
        close();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [close, hold]);
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
  useEscape(close, busy);
  const go = async (): Promise<void> => {
    if (busy) return; // a second click while it runs does nothing
    setBusy(true);
    try {
      const path = `/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(ask.task.id)}/actions/${ask.action}`;
      const r = await post(path, { confirm: true, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(ask.action === "reassign" ? { agent } : {}) });
      say(r.ok === true ? { title: `${LABELS[ask.action]}: done for ${taskLabel(ask.task.id)}.`, text: String(r.output ?? ""), tone: "good" }
        : { title: String(r.message ?? "It didn't run."), text: [r.fix, r.output].filter(Boolean).map(String).join("\n\n"), tone: "bad" });
    } finally {
      setBusy(false);
      close();
    }
  };
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) close(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="task-ask">
        <h2 id="task-ask">{LABELS[ask.action]} {taskLabel(ask.task.id)}?</h2>
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
          <label className="field">{ask.action === "block" ? "Why it's blocked" : "Why (optional)"}
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

type Json = Record<string, unknown>;

/** A task's own page (#543), over the board: its words, who has it, its epic, what blocks it, its pull request, its actions
 *  (each asks first, as on the card), then its context entries and its thread, read from the message board when it
 *  opens. `t` is the task as the board shows it; null when the board doesn't list it (done long ago, or not this
 *  project's), then the page says so. Escape, Close or a click outside closes it. */
export function TaskPage({ id, t, project, token, open, post, say, close }: { id: string; t: TaskRow | null; project: ViewProps["project"]; token: string;
  open: ViewProps["open"]; post: Post; say: Say; close: () => void }) {
  const [got, setGot] = useState<Json | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  useEscape(close, ask !== null);
  useEffect(() => {
    let gone = false;
    if (!t) return;
    fetch(`/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json() as Promise<Json>)
      .then((j) => { if (!gone) setGot(j); })
      .catch(() => { if (!gone) setGot({ message: "The server can't be reached.", fix: "Check that the web UI still runs, then open this again." }); });
    return () => {
      gone = true;
    };
  }, [project.id, id, token, t?.state, t?.holders.join(",")]);
  const thread = Array.isArray(got?.thread) ? (got.thread as Json[]) : [];
  const context = Array.isArray(got?.context) ? (got.context as Json[]) : [];
  const failed = got !== null && !Array.isArray(got.thread);
  const body = typeof got?.body === "string" ? got.body.trim() : "";
  const actions = (t?.actions ?? []).filter((a): a is TaskAction => a in LABELS);
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog bthread" role="dialog" aria-modal="true" aria-labelledby="task-page">
        <h2 id="task-page">{taskLabel(id)} {t?.title ?? ""}</h2>
        {!t && <p className="empty">{taskLabel(id)} isn't on {project.name}'s board now: it may have been done more than a week ago.</p>}
        {t && <>
          <dl className="facts">
            <div><dt>State</dt><dd><Dot tone={taskTone(t.state)} />{t.stateText}</dd></div>
            <div><dt>Who</dt><dd>{t.holders.length ? t.holders.map((h) => <button key={h} className="link" onClick={() => open(`agent:${h}`)}>{h}</button>)
              : unheldText(t)}</dd></div>
            {t.epic && <div><dt>Epic</dt><dd><button className="link" onClick={() => open("view:epics", `#${t.epic}`)}>#{t.epic}</button></dd></div>}
            {blockersText(t) && <div><dt>Blocked by</dt><dd>{blockersText(t).replace(/^Blocked by /, "")}</dd></div>}
            {t.pr && <div><dt>Pull request</dt><dd><button className="link" onClick={() => open("view:pull-requests", `#${t.pr?.number}`)}>PR #{t.pr.number}</button>
              {t.pr.checks && <span className="muted"> · {checksText(t.pr.checks)}</span>}</dd></div>}
            {t.url && <div><dt>On GitHub</dt><dd><a className="ext" href={t.url} target="_blank" rel="noreferrer noopener">Issue {taskLabel(id)}</a></dd></div>}
          </dl>
          {actions.length > 0 && <div className="bactions">{actions.map((a) => <button key={a} className="btn small" onClick={() => setAsk({ task: t, action: a })}>{LABELS[a]}</button>)}</div>}
          {got === null && <p className="empty">Reading the task…</p>}
          {failed && <div className="notice bad" role="alert"><div><strong>{String(got?.message ?? "")}</strong><p>{String(got?.fix ?? "")}</p></div></div>}
          {body && <section aria-label="What it is"><p className="bbody">{body}</p></section>}
          {context.length > 0 && <section aria-label="Context">
            <h3 className="vgroup">Context</h3>
            <ul className="bentries">{context.map((c) => (
              <li key={String(c.id)}><span className="bkind">{String(c.kind)}</span> {String(c.body)} <span className="muted">· {String(c.author)}, {ago(String(c.at))}</span></li>
            ))}</ul>
          </section>}
          {got !== null && !failed && <section aria-label="Thread">
            <h3 className="vgroup">Thread</h3>
            {thread.length ? <ul className="bentries">{thread.map((m) => (
              <li key={String(m.id)}>
                <p className="bwhofrom"><Avatar name={String(m.from)} size={18} /><strong>{String(m.from)}</strong>{m.to ? <span className="muted">to {String(m.to)}</span> : null}
                  <span className="bkind">{String(m.kind)}</span><span className="muted">{ago(String(m.at))}</span></p>
                <p className="bbody">{String(m.body)}</p>
              </li>
            ))}</ul> : <p className="empty">Nothing said on this task yet.</p>}
          </section>}
        </>}
        <div className="actions"><button className="btn" onClick={close} autoFocus>Close</button></div>
      </div>
      {ask && <AskDialog ask={ask} project={project} post={post} say={say} close={() => setAsk(null)} />}
    </div>
  );
}

/** True when a click on a card was on one of its own controls (a link or a button), which keep their own action. */
function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a, input, select, textarea") !== null;
}

function Card({ t, edge, pull, open, act, openTask }: { t: TaskRow; edge: string; pull?: PullRow; open: ViewProps["open"]; act: (a: Ask) => void;
  openTask?: (id: string) => void }) {
  const actions = (t.actions ?? []).filter((a): a is TaskAction => a in LABELS);
  const tag = cardTag(t, pull);
  const blockers = blockersText(t);
  return (
    <li className={openTask ? "bcard opens" : "bcard"} data-edge={edge} style={{ borderLeftColor: `var(--${edge}-dot)` }}
      onClick={(e) => { if (openTask && !onControl(e.target)) openTask(t.id); }}>
      <p className="btitle">{openTask
        ? <button className="blink btitle-open" onClick={() => openTask(t.id)} aria-label={`Open ${taskLabel(t.id)} ${t.title}`}>{taskLabel(t.id)} {t.title}</button>
        : <>{t.url ? <a className="ext" href={t.url} target="_blank" rel="noreferrer noopener">{taskLabel(t.id)}</a> : taskLabel(t.id)} {t.title}</>}</p>
      <div className="bfoot">
        <span className="bwho">{t.holders.length ? t.holders.map((h) => (
          <button key={h} className="bavatar" title={h} aria-label={`Open ${h}'s page`} onClick={() => open(`agent:${h}`)}><Avatar name={h} size={20} /></button>
        )) : <span className="bnone">{unheldText(t)}</span>}</span>
        <span className="btag">{tag.needsYou && <span className="sdot down" aria-hidden="true" />}{tag.text}</span>
      </div>
      {blockers && <p className="bblock"><Dot tone="bad" />{blockers}</p>}
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

/** The board for `tasks` (already filtered), with its lanes by `by`. With `openTask` (its tasks come from the message
 *  board, #498) a click on a card opens the task's page (#543). */
export function Board({ tasks, all, epics, pulls, by, project, open, post, say, openTask }: { tasks: TaskRow[]; all: TaskRow[]; epics: EpicRow[];
  pulls: PullRow[]; by: LaneBy; project: ViewProps["project"]; open: ViewProps["open"]; post: Post; say: Say; openTask?: (id: string | null) => void }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const columns = columnsOf(all);
  const lanes = boardOf(tasks, by, epics);
  const colours = laneColours(lanes, by, epics, useContext(AgentsContext));
  const pullOf = new Map(pulls.map((p) => [p.number, p]));
  const grid = { gridTemplateColumns: `repeat(${columns.length}, minmax(150px, 1fr))` };
  return (
    <div className="board" role="region" aria-label={`Board, lanes by ${by}`}>
      <div className="bgrid bcols" style={grid}>
        {columns.map((c) => (
          <div key={c.state} className={`bcol-head ${taskTone(c.state)}`}><Dot tone={taskTone(c.state)} /><strong>{c.title}</strong>
            <span className="bcount">{tasks.filter((t) => t.state === c.state).length}</span></div>
        ))}
      </div>
      {lanes.map((l, i) => (
        <section key={l.key || "-"} className="blane" aria-label={l.title} data-colour={colours[i]}>
          <div className="blane-head">
            <span className="blane-dot" aria-hidden="true" style={{ background: `var(--${colours[i]}-dot)` }} />
            {by === "agent" && l.key ? <button className="blink bagent" onClick={() => open(`agent:${l.key}`)}><Avatar name={l.key} size={22} />{l.title}</button>
              : by === "epic" && l.key.startsWith("#") ? <button className="blink" onClick={() => open("view:epics", l.key)}>{l.title}</button>
              : <h2>{l.title}</h2>}
            <span className="bsub">{laneSub(l.key, l.count, by, epics)}</span>
          </div>
          <div className="bgrid" style={grid}>
            {columns.map((c) => (
              <ul key={c.state} className="bcell" data-col={c.title} aria-label={`${l.title}: ${c.title}`}>
                {(l.cells[c.state] ?? []).map((t) => <Card key={t.id} t={t} edge={cardEdge(t, by, colours[i] ?? "grey", epics)}
                  pull={t.pr ? pullOf.get(t.pr.number) : undefined} open={open} act={setAsk}
                  openTask={openTask ? (id) => openTask(id) : undefined} />)}
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
.board { overflow-x: auto; display: flex; flex-direction: column; gap: 8px; padding-bottom: 6px; }
.bgrid { display: grid; gap: 16px; min-width: min-content; align-items: start; }
.bcol-head { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); background: var(--bg-subtle);
  border: 1px solid var(--border); border-top: 3px solid var(--idle); border-radius: 8px; padding: 8px 10px; }
.bcol-head.good { border-top-color: var(--working); }
.bcol-head.warn { border-top-color: var(--waiting); }
.bcol-head.bad { border-top-color: var(--down); }
.bcol-head strong { color: var(--text); font-weight: 600; }
.bcount { color: var(--text-3); }
/* a lane is plain: a dot in its colour (laneColours) by its title, a hairline above it; the colour is on the cards */
.blane { display: flex; flex-direction: column; gap: 12px; min-width: min-content; border-top: 1px solid var(--border); padding-top: 20px; }
.blane-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; position: sticky; left: 0; max-width: calc(100vw - 32px); }
.blane-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; align-self: center; }
.blane-head h2, .blane-head .blink { margin: 0; font-size: 15px; font-weight: 600; color: var(--text); }
.blane-head .bagent { align-self: center; }
.bsub { color: var(--text-2); font-size: 13px; }
.blink { border: 0; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
.blink:hover { text-decoration: underline; }
.bcell { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
/* a card's left edge is its lane's colour, or by agent its epic's (cardEdge) */
.bcard { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-left: 4px solid var(--grey-dot); border-radius: 10px; padding: 12px 12px 12px 11px; display: flex;
  flex-direction: column; gap: 8px; box-shadow: var(--card-shadow); }
.btitle { margin: 0; font-weight: 600; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.btitle .ext { color: inherit; text-decoration: none; }
/* a card opens its task: the whole card is the target, its title the keyboard's */
.bcard.opens { cursor: pointer; }
.bcard.opens:hover { border-color: var(--border-strong); }
.btitle-open { font-weight: 600; text-align: left; line-height: 1.35; display: inline; }
.btitle-open:focus-visible { outline: 2px solid var(--focus, currentColor); outline-offset: 2px; border-radius: 4px; }
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
.bblock { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.bthread { width: min(680px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.bthread h2 { margin: 0; font-size: 17px; }
.bentries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.bentries li { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font-size: 13px; overflow-wrap: anywhere; }
.bwhofrom { margin: 0 0 6px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; }
.bbody { margin: 0; white-space: pre-wrap; }
.bkind { font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-2); }
.field input, .field select { height: 44px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); border-radius: 10px;
  padding: 0 12px; font: inherit; }
/* a phone: a lane's columns one under another, each named, and an empty one left out */
@media (max-width: 760px) {
  .board { overflow-x: visible; }
  .bcols { display: none; }
  .bgrid { grid-template-columns: minmax(0, 1fr) !important; min-width: 0; gap: 10px; }
  .blane { min-width: 0; }
  .blane-head { position: static; max-width: none; }
  .bcell { min-height: 0; }
  .bcell:empty { display: none; }
  .bcell::before { content: attr(data-col); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); }
}
`;
