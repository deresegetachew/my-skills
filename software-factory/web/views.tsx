// The web app's tasks, pull requests and CI channels (#424), from the API's views data (factory_ui_views.ts, live over
// the WebSocket). The tasks channel shows a board (#439, board.tsx) or a list. Each has a filter (#392: every word, any
// case) and says how old its data is, with a button that reads it again. The CI channel puts the verdict first and its
// actions (#396) are buttons that ask first, then run their factory commands (factory_ci_view.ts), on the machine that
// serves the page.
import { type ReactNode, useEffect, useState } from "react";
import { Avatar } from "./avatar_view.tsx";
import { Board, EpicChips } from "./board.tsx";
import type { LaneBy } from "./board_model.ts";
import { Cited, Cites } from "./docs.tsx";
import { EPICS_CSS, EpicPage, NewEpic, type Talker } from "./epics.tsx";
import { Tabs } from "./parts.tsx";
import type { DocPage } from "./docs_model.ts";
import type { Tone } from "./model.ts";
import { type ActionRow, checksText, checksTone, epicBar, type EpicRow, epicTone, filterRows, groupByEpic, minutesText, type Origin, originText, type ProblemView, protectedText, type PullRow, reviewTone,
  type RunRow, runnerText, runnerTone, runStateText, runTone, type TaskRow, taskTone, verdictTone, type ViewsData } from "./views_model.ts";

export type Post = (path: string, body: unknown) => Promise<Record<string, unknown>>;
export type Say = (t: { title: string; text: string; tone: Tone }) => void;

export interface ViewProps {
  project: { id: string; name: string };
  views: ViewsData | undefined;
  /** The filter to start with (the search across views opens a channel on its row). */
  find: string;
  open: (channel: string, find?: string) => void;
  post: Post;
  /** The project's doc pages: a decision or a story that a title cites links to it (#438). */
  docs?: DocPage[];
  say: Say;
  /** The token the chat calls need (the epic page talks to the product owner and the dev manager, #440). */
  token?: string;
  /** This project's product owner and dev manager. */
  talkers?: Talker[];
}

function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`dot ${tone}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

function Problems({ list }: { list: ProblemView[] }) {
  return (
    <>
      {list.map((p) => (
        <div key={p.code + p.message} className="notice bad" role="alert">
          <Dot tone="bad" /><div><strong>{p.message}</strong><p>{p.fix}</p></div>
        </div>
      ))}
    </>
  );
}

function Ext({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? <a className="ext" href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <>{children}</>;
}

function ageText(v: ViewsData): string {
  if (v.refreshing) return "reading now…";
  if (v.age === null) return "no snapshot yet";
  return v.age < 60 ? "as of now" : `as of ${minutesText(v.age / 60)} ago`;
}

/** The filter box and how old the data is, with a read again. `origin` (the tasks and epics, #498): where they come
 *  from, the message board, live, or GitHub, read every so often. */
function Toolbar({ typed, setTyped, views, project, post, say, what, origin }: { typed: string; setTyped: (s: string) => void;
  views: ViewsData; project: { id: string }; post: Post; say: Say; what: string; origin?: Origin }) {
  const from = origin ? originText(origin) : "";
  const age = origin?.from === "board" ? from : [from, ageText(views)].filter(Boolean).join(" · ");
  const again = async (): Promise<void> => {
    const r = await post(`/api/projects/${encodeURIComponent(project.id)}/refresh`, {});
    if (r.ok !== true) say({ title: String(r.message ?? "It didn't start."), text: String(r.fix ?? ""), tone: "bad" });
  };
  return (
    <div className="vbar">
      <input type="search" className="vfilter" placeholder={`Filter ${what}`} aria-label={`Filter ${what}`} value={typed}
        onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setTyped(""); }} />
      <span className="vage" title={views.generatedAt ?? ""}>{age}</span>
      <button className="btn" onClick={() => void again()} disabled={views.refreshing}>Read again</button>
    </div>
  );
}

function useFilter(find: string): [string, (s: string) => void] {
  const [typed, setTyped] = useState(find);
  useEffect(() => setTyped(find), [find]);
  return [typed, setTyped];
}

function Loading({ name }: { name: string }) {
  return <div className="body"><p className="empty">Reading {name}…</p></div>;
}

function NoMatch({ typed }: { typed: string }) {
  return <p className="empty">No match for "{typed}".</p>;
}

function AgentLink({ name, open }: { name: string; open: ViewProps["open"] }) {
  return <button className="link agent-link" onClick={() => open(`agent:${name}`)}><Avatar name={name} size={20} />{name}</button>;
}

// --- tasks -------------------------------------------------------------------------------------------------------------

const LANES: Array<[string, string]> = [["in-progress", "in progress"], ["in-review", "in review"], ["ready", "ready"], ["blocked", "blocked"],
  ["new", "not ready"]];

function TaskLine({ t, open, docs }: { t: TaskRow; open: ViewProps["open"]; docs?: DocPage[] }) {
  return (
    <li className={t.next ? "vrow next" : "vrow"}>
      <span className="vid"><Ext href={t.url}>#{t.id}</Ext></span>
      <span className="vmain">
        <span className="vtitle"><Cited text={t.title} docs={docs} open={open} />{t.next && <span className="tag">next</span>}</span>
        <span className="vsub">
          {t.group && <span>{t.group}</span>}
          {t.todos.all > 0 && <span>{t.todos.done} of {t.todos.all} todos done</span>}
          {t.dependsOn.length > 0 && <span>after {t.dependsOn.map((d) => `#${d.replace(/^#/, "")}`).join(", ")}</span>}
          {t.pr && <span>PR <button className="link" onClick={() => open("view:pull-requests", `#${t.pr?.number}`)}>#{t.pr.number}</button></span>}
          <Cites cites={t.cites} title={t.title} docs={docs} open={open} />
        </span>
      </span>
      <span className="vwho">{t.holders.length ? t.holders.map((h) => <AgentLink key={h} name={h} open={open} />) : <span className="empty">—</span>}</span>
      <span className="vstate"><Dot tone={taskTone(t.state)} />{t.stateText}</span>
    </li>
  );
}

type TaskTab = LaneBy | "list";

const TASK_TABS: Array<[TaskTab, string]> = [["epic", "By epic"], ["agent", "By agent"], ["list", "List"]];

export function TasksChannel(p: ViewProps) {
  const [typed, setTyped] = useFilter(p.find);
  const [picked, setTab] = useState<TaskTab | null>(null);
  const [epic, setEpic] = useState<string | null>(null);
  if (!p.views) return <Loading name={p.project.name} />;
  const v = p.views;
  const epics = v.epics.epics;
  const tab: TaskTab = picked ?? (epics.length ? "epic" : "agent"); // the design opens by epic; with no epics, by agent
  const all = v.tasks.tasks;
  const withTasks = epics.filter((e) => all.some((t) => t.epic === e.id));
  const chosen = epic && withTasks.some((e) => e.id === epic) ? epic : null;
  const rows = filterRows(all, typed).filter((t) => chosen === null || t.epic === chosen);
  const mode = tab === "list" ? "list" : "board";
  return (
    <div className="body">
      <Toolbar typed={typed} setTyped={setTyped} views={v} project={p.project} post={p.post} say={p.say} what="cards" origin={v.tasks} />
      <Problems list={[...v.problems, ...v.tasks.problems]} />
      <div className="bfilters">
        <Tabs label="Group lanes by" value={tab} onChange={setTab} tabs={TASK_TABS.map(([id, label]) => ({ id, label }))} />
        {withTasks.length > 0 && <EpicChips epics={withTasks} all={epics} chosen={chosen} choose={setEpic} />}
      </div>
      {mode === "list" && <div className="lanes" aria-label="Tasks by state">
        {LANES.map(([s, name]) => <span key={s}><Dot tone={taskTone(s)} />{name} {all.filter((t) => t.state === s).length}</span>)}
      </div>}
      {mode === "list" && <p className="vnote">In the order the builders take them{v.tasks.next ? <>; the next one is <strong>#{v.tasks.next}</strong></> : "; none is ready to take"}.</p>}
      {!all.length && !v.problems.length && v.tasks.from !== "unknown" && <p className="empty">No open tasks.</p>}
      {all.length > 0 && !rows.length && <NoMatch typed={typed} />}
      {rows.length > 0 && tab !== "list" && <Board tasks={rows} all={all} epics={epics} pulls={v.pulls.pulls} by={tab} project={p.project} open={p.open}
        post={p.post} say={p.say} token={v.tasks.from === "board" ? p.token : undefined} />}
      {rows.length > 0 && mode === "list" && v.epics.epics.length === 0 && <ul className="vlist" aria-label="Tasks">{rows.map((t) => <TaskLine key={t.id} t={t} open={p.open} docs={p.docs} />)}</ul>}
      {rows.length > 0 && mode === "list" && v.epics.epics.length > 0 && groupByEpic(rows, v.epics.epics).map((g) => (
        <section key={g.epic?.id ?? "none"} aria-label={g.epic ? `Tasks in epic ${g.epic.title}` : "Tasks in no epic"}>
          <h3 className="vgroup">{g.epic
            ? <button className="link" onClick={() => p.open("view:epics", `#${g.epic?.id}`)}>Epic #{g.epic.id} {g.epic.title}</button>
            : "In no epic"}</h3>
          <ul className="vlist">{g.tasks.map((t) => <TaskLine key={t.id} t={t} open={p.open} docs={p.docs} />)}</ul>
        </section>
      ))}
    </div>
  );
}

// --- epics -------------------------------------------------------------------------------------------------------------


function EpicCard({ e, open, pick, docs }: { e: EpicRow; open: ViewProps["open"]; pick: (id: string) => void; docs?: DocPage[] }) {
  const pct = epicBar(e);
  return (
    <li className="card epic">
      <div className="prhead">
        <span className="vid"><Ext href={e.url}>#{e.id}</Ext></span>
        <span className="vtitle"><button className="link" onClick={() => pick(e.id)}><Cited text={e.title} docs={docs} open={open} /></button></span>
        <span className="vstate"><Dot tone={epicTone(e.stage)} />{e.stageText}</span>
      </div>
      <div className="ebar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${e.done} of ${e.all} tasks done`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="vsub">{e.all ? `${e.done} of ${e.all} tasks done` : "No tasks yet"}</p>
      <dl className="facts">
        {e.prd && <div><dt>PRD</dt><dd>{e.prd}</dd></div>}
        {e.decisions.length > 0 && <div><dt>Decisions</dt><dd>{e.decisions.join(", ")}</dd></div>}
        {e.tasks.length > 0 && <div><dt>Tasks</dt><dd className="etasks">{e.tasks.map((t) => (
          <button key={t.id} className={t.done ? "link done" : "link"} onClick={() => open("view:tasks", `#${t.id}`)}>{t.done ? "✓ " : ""}#{t.id}</button>))}</dd></div>}
      </dl>
    </li>
  );
}

/** A column of the epics board: the stages in the order an epic walks them, then parked. */
const BOARD: Array<[string, string]> = [["investigating", "Investigating"], ["prd", "PRD"], ["decision", "Decision"], ["planned", "Planned"],
  ["building", "Building"], ["done", "Done"], ["parked", "Parked"]];

function EpicBoard({ epics, open }: { epics: EpicRow[]; open: (id: string) => void }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <div className="eboard" style={{ gridTemplateColumns: `repeat(${BOARD.length}, minmax(160px, 1fr))` }}>
        {BOARD.map(([s, name]) => {
          const here = epics.filter((e) => e.stage === s);
          return (
            <section key={s} aria-label={name}>
              <h4><Dot tone={epicTone(s)} />{name} <span className="empty">{here.length}</span></h4>
              {here.map((e) => (
                <article key={e.id}>
                  <button className="link" onClick={() => open(e.id)}>{e.title}</button>
                  {e.summary && <span className="vsub">{e.summary}</span>}
                  <span className="vsub">{e.all ? `${e.done} of ${e.all} tasks` : "Not split yet"} · #{e.id}</span>
                </article>
              ))}
              {!here.length && <span className="vsub">None.</span>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

type EpicTab = "board" | "list";

export function EpicsChannel(p: ViewProps) {
  const [typed, setTyped] = useFilter(p.find);
  const [tab, setTab] = useState<EpicTab>("board");
  const [adding, setAdding] = useState(false);
  const wanted = /^#(\d+)$/.exec(p.find.trim())?.[1] ?? null; // a task's epic link opens the epic itself
  const [chosen, setChosen] = useState<string | null>(wanted);
  useEffect(() => setChosen(wanted), [wanted]);
  if (!p.views) return <Loading name={p.project.name} />;
  const v = p.views;
  const all = v.epics.epics;
  const rows = filterRows(all, chosen ? "" : typed);
  const epic = chosen ? all.find((e) => e.id === chosen) : undefined;
  const talkers = p.talkers ?? [];
  if (epic) {
    return <EpicPage epic={epic} tasks={v.tasks.tasks} token={p.token ?? ""} project={p.project.id} talkers={talkers} docs={p.docs} open={p.open}
      back={() => setChosen(null)} />;
  }
  return (
    <div className="body">
      <Toolbar typed={typed} setTyped={setTyped} views={v} project={p.project} post={p.post} say={p.say} what="epics" origin={v.epics} />
      <Problems list={[...v.problems, ...v.epics.problems]} />
      <div className="etabs-row">
        <Tabs<EpicTab> label="Epic views" value={tab} onChange={setTab} tabs={[{ id: "board", label: "Board" }, { id: "list", label: "List" }]} />
        <button className="btn primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>New epic</button>
      </div>
      {adding && <NewEpic token={p.token ?? ""} project={p.project.id} talkers={talkers} close={() => setAdding(false)} />}
      {!all.length && !v.problems.length && v.epics.from !== "unknown" && <p className="empty">No epics. Tell the product owner what you want with New epic.</p>}
      {all.length > 0 && !rows.length && <NoMatch typed={typed} />}
      {rows.length > 0 && tab === "board" && <EpicBoard epics={rows} open={setChosen} />}
      {rows.length > 0 && tab === "list" && <ul className="vcards" aria-label="Epics">{rows.map((e) => <EpicCard key={e.id} e={e} open={p.open} pick={setChosen} docs={p.docs} />)}</ul>}
    </div>
  );
}

// --- pull requests -----------------------------------------------------------------------------------------------------

function PullCard({ pr, open, docs }: { pr: PullRow; open: ViewProps["open"]; docs?: DocPage[] }) {
  return (
    <li className="card pr">
      <div className="prhead">
        <span className="vid"><Ext href={pr.url}>#{pr.number}</Ext></span>
        <span className="vtitle"><button className="link" onClick={() => open(`pr:${pr.number}`)} aria-label={`Open #${pr.number}: ${pr.title}`}>{pr.title}</button></span>
        {pr.draft && <span className="tag quiet">draft</span>}
      </div>
      <dl className="facts">
        <div><dt>Checks</dt><dd><Dot tone={checksTone(pr.checks.state)} />{checksText(pr.checks)}</dd></div>
        <div><dt>Review</dt><dd><Dot tone={reviewTone(pr.review.state)} />{pr.review.text}{pr.review.claim && pr.review.state !== "none" ? ` · ${pr.review.claim} holds it` : ""}</dd></div>
        <div><dt>Protected files</dt><dd><Dot tone={pr.protected ? "warn" : pr.protected === false ? "good" : "quiet"} />{protectedText(pr.protected)}</dd></div>
        <div><dt>Opened by</dt><dd>{pr.author?.name ? <AgentLink name={pr.author.name} open={open} /> : <span className="empty">{pr.author?.text ?? pr.agent ?? "a person"}</span>}{pr.rework && <span className="tag">{pr.rework} reworking</span>}</dd></div>
        <div><dt>Task</dt><dd>{pr.task ? <button className="link" onClick={() => open("view:tasks", `#${pr.task}`)}>#{pr.task}</button> : <span className="empty">—</span>}</dd></div>
        <div><dt>Next</dt><dd>{pr.needsYou && <Dot tone="bad" />}{pr.next.text}</dd></div>
      </dl>
      <p className="vsub"><span className="mono">{pr.branch}</span><Cites cites={pr.cites} title={pr.title} docs={docs} open={open} /></p>
    </li>
  );
}

export function PullsChannel(p: ViewProps) {
  const [typed, setTyped] = useFilter(p.find);
  if (!p.views) return <Loading name={p.project.name} />;
  const v = p.views;
  const all = v.pulls.pulls;
  const rows = filterRows(all, typed);
  return (
    <div className="body">
      <Toolbar typed={typed} setTyped={setTyped} views={v} project={p.project} post={p.post} say={p.say} what="pull requests" />
      <Problems list={[...v.problems, ...v.pulls.problems]} />
      {!all.length && !v.problems.length && <p className="empty">No open pull request.</p>}
      {all.length > 0 && !rows.length && <NoMatch typed={typed} />}
      {rows.length > 0 && <ul className="prs" aria-label="Pull requests">{rows.map((pr) => <PullCard key={pr.number} pr={pr} open={p.open} docs={p.docs} />)}</ul>}
    </div>
  );
}

// --- CI ----------------------------------------------------------------------------------------------------------------

interface Ask {
  action: ActionRow;
  run?: RunRow;
  command: string;
  does: string;
}

function rerunCommand(r: RunRow, repo: string): string {
  return `gh run rerun ${r.id} --failed --repo ${repo}`;
}

function logCommand(r: RunRow): string {
  return `factory ci log ${/^#\d+$/.test(r.ref) ? r.ref.slice(1) : String(r.id)}`;
}

export function CiChannel(p: ViewProps) {
  const [typed, setTyped] = useFilter(p.find);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ title: string; text: string } | null>(null);
  if (!p.views) return <Loading name={p.project.name} />;
  const v = p.views;
  const ci = v.ci;
  const runs = filterRows(ci.runs, typed);
  const runners = filterRows(ci.runners, typed);
  const byName = Object.fromEntries(ci.actions.map((a) => [a.name, a]));
  const path = (name: string) => `/api/projects/${encodeURIComponent(p.project.id)}/ci/actions/${name}`;

  const go = async (a: Ask): Promise<void> => {
    setBusy(true);
    try {
      const r = await p.post(path(a.action.name), { confirm: true, ...(a.run?.id ? { run: a.run.id } : {}) });
      p.say(r.ok === true ? { title: `Ran ${String(r.command)}`, text: String(r.output ?? ""), tone: "good" }
        : { title: String(r.message ?? "It didn't run."), text: [r.fix, r.output].filter(Boolean).map(String).join("\n\n"), tone: "bad" });
    } finally {
      setBusy(false);
      setAsk(null);
    }
  };
  const openLog = async (r: RunRow): Promise<void> => {
    setLog({ title: logCommand(r), text: "Reading…" });
    const got = await p.post(path("log"), { run: r.id });
    setLog({ title: String(got.command ?? logCommand(r)), text: String(got.output ?? got.message ?? "") || "(no output)" });
  };
  const button = (name: string, primary = false) => {
    const a = byName[name];
    if (!a) return null;
    return (
      <button key={name} className={`btn${primary ? " primary" : ""}`} disabled={!a.command} title={a.note ?? a.command ?? ""}
        onClick={() => a.command && setAsk({ action: a, command: a.command, does: a.does ?? "" })}>{a.label}</button>
    );
  };
  const machines = [...new Set(runners.map((r) => r.machine))].sort((a, b) => Number(runners.some((r) => r.machine === b && r.here)) -
    Number(runners.some((r) => r.machine === a && r.here)) || a.localeCompare(b));
  const heavy = ci.settings.heavy;

  return (
    <div className="body">
      {ci.verdict && (
        <div className={`verdict ${verdictTone(ci.verdict.tone)}`} role="status"><Dot tone={verdictTone(ci.verdict.tone)} />{ci.verdict.text}</div>
      )}
      <Toolbar typed={typed} setTyped={setTyped} views={v} project={p.project} post={p.post} say={p.say} what="runs and runners" />
      <Problems list={[...v.problems, ...ci.problems]} />
      {ci.verdict && (
        <section className="card" aria-label="Runner actions">
          <h3>Where jobs run: {ci.mode === "local" ? `this machine's runners (${ci.label})` : ci.mode === "github" ? "GitHub's runners" : "unknown"}</h3>
          <div className="vactions">
            {button("install", true)}
            {ci.mode !== "local" && button("use-local")}
            {ci.mode !== "github" && button("use-github")}
            <span className="vcount">
              {button("runners-down")}
              <span>{heavy ? `${heavy.raw} heavy` : "heavy ?"}</span>
              {button("runners-up")}
            </span>
            {button("light-lane")}
            {button("clean")}
          </div>
          <p className="vsub">{heavy ? `Heavy runners on ${ci.host}: ${heavy.raw}, from ${heavy.source}.` : `The heavy runner count is read on the machine that serves this page.`}
            {" "}Each button asks first, then runs on {ci.host}.</p>
        </section>
      )}
      <section className="card" aria-label="Runs">
        <h3>Queue and recent runs</h3>
        {!ci.runs.length ? <p className="empty" style={{ margin: 0 }}>No runs on main or an open pull request.</p>
          : !runs.length ? <NoMatch typed={typed} /> : (
            <ul className="rows">
              {runs.map((r) => (
                <li key={`${r.id}-${r.ref}`}>
                  <Dot tone={runTone(r.state)} label={r.state} />
                  <span className="vrunstate">{runStateText(r.state)}</span>
                  <span className="vid">{r.ref}</span>
                  <span className="vtitle"><Ext href={r.url}>{r.name} on {r.branch}</Ext></span>
                  <span className="detail">{minutesText(r.minutesAgo)} ago</span>
                  {r.id !== null && <button className="btn small" onClick={() => void openLog(r)}>Log</button>}
                  {r.failed && r.id !== null && byName.rerun && (
                    <button className="btn small" onClick={() => setAsk({ action: byName.rerun as ActionRow, run: r, command: rerunCommand(r, ci.repo),
                      does: "reruns that run's failed jobs on GitHub" })}>Rerun</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        {ci.waiting.length > 0 && <p className="vsub">Waiting on CI: {ci.waiting.map((ref) => (
          <button key={ref} className="link" onClick={() => p.open("view:pull-requests", ref)}>{ref} </button>))}</p>}
      </section>
      <div className="machines runners" aria-label="Runners">
        {!ci.runners.length && <p className="empty">{ci.mode === "local" ? <>No runner has the label {ci.label} yet: register this machine's from its terminal.</>
          : "No self-hosted runner: CI runs on GitHub's runners."}</p>}
        {machines.map((m) => (
          <section className="card" key={m} aria-label={m}>
            <h3>{m}{runners.some((r) => r.machine === m && r.here) && <span className="tag">this machine</span>}</h3>
            <ul className="rows">
              {runners.filter((r) => r.machine === m).map((r) => (
                <li key={r.name}><Dot tone={runnerTone(r.state)} label={r.state} /><span>{r.name}</span><span className="tag quiet">{r.lane}</span>
                  <span className="detail">{runnerText(r.state)}</span></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {ask && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) setAsk(null); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="ci-ask">
            <h3 id="ci-ask">{ask.action.label}?</h3>
            <p>This runs <code>{ask.command}</code> in {p.project.name} on {ci.host}.</p>
            {ask.does && <p>It {ask.does}.</p>}
            <div className="actions">
              <button className="btn" onClick={() => setAsk(null)} disabled={busy} autoFocus>Cancel</button>
              <button className="btn primary" onClick={() => void go(ask)} disabled={busy}>{busy ? "Running…" : "Run it"}</button>
            </div>
          </div>
        </div>
      )}
      {log && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setLog(null); }}>
          <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="ci-log">
            <h3 id="ci-log"><code>{log.title}</code></h3>
            <pre className="log">{log.text}</pre>
            <div className="actions"><button className="btn" onClick={() => setLog(null)} autoFocus>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The three channels' data read through the API (GET tasks, pull-requests and ci), for when the WebSocket hasn't sent it. */
export async function loadViews(get: (path: string) => Promise<Record<string, unknown>>, project: string): Promise<ViewsData> {
  const base = `/api/projects/${encodeURIComponent(project)}`;
  const [t, ep, pr, ci] = await Promise.all([get(`${base}/tasks`), get(`${base}/epics`), get(`${base}/pull-requests`), get(`${base}/ci`)]);
  const own = (x: Record<string, unknown>) => (Array.isArray(x.problems) ? x.problems : []) as ProblemView[];
  return { generatedAt: (t.generatedAt as string | null) ?? null, age: (t.age as number | null) ?? null, refreshing: t.refreshing === true,
    problems: [], tasks: { ...(t as unknown as ViewsData["tasks"]), problems: own(t) },
    epics: { source: String(ep.source ?? ""), epics: (ep.epics ?? []) as EpicRow[], problems: own(ep) },
    pulls: { pulls: (pr.pulls ?? []) as PullRow[], problems: own(pr) }, ci: { ...(ci as unknown as ViewsData["ci"]), problems: own(ci) } };
}

export const VIEWS_CSS = String.raw`
.vbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.vfilter { flex: 1; min-width: 160px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); border-radius: 10px;
  padding: 0 12px; height: 40px; font: inherit; font-size: 13px; }
.vage { color: var(--text-3); font-size: 12px; white-space: nowrap; }
.vnote { color: var(--text-2); font-size: 13px; margin: 0; }
.lanes { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--text-2); }
.lanes span { display: inline-flex; align-items: center; gap: 6px; }
.vlist { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
.vrow { display: grid; grid-template-columns: 64px 1fr minmax(80px, 160px) 120px; gap: 12px; align-items: center; padding: 12px 16px;
  border-top: 1px solid var(--border); }
.vrow:first-child { border-top: 0; }
.vgroup { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; margin: 16px 0 8px; color: var(--text-3); }
.vcards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.ebar { height: 6px; border-radius: 3px; background: var(--bg-active); overflow: hidden; margin: 10px 0 6px; }
.ebar span { display: block; height: 100%; background: var(--primary); }
.etasks { display: flex; flex-wrap: wrap; gap: 4px 10px; }
button.link.done { color: var(--text-2); font-weight: 400; }
.vrow.next { background: var(--bg-subtle); }
.vid { font-family: var(--mono); font-size: 12.5px; color: var(--text-2); white-space: nowrap; }
.vmain { min-width: 0; display: flex; flex-direction: column; }
.vtitle { font-weight: 600; min-width: 0; overflow-wrap: anywhere; display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.vsub { color: var(--text-2); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; }
.vsub.mono { font-family: var(--mono); margin-top: 10px; }
.card .vsub { margin-top: 10px; }
.vsub .mono { font-family: var(--mono); }
.vwho { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.vstate { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); white-space: nowrap; }
button.link { border: 0; background: none; padding: 0; cursor: pointer; font-weight: 600; color: inherit; }
button.link:hover, a.ext:hover { color: var(--text); text-decoration: underline; }
a.ext { color: inherit; text-decoration: none; }
.prs { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.prhead { display: flex; gap: 10px; align-items: baseline; margin-bottom: 12px; flex-wrap: wrap; }
.verdict { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; padding: 14px 16px; border-radius: 14px;
  border: 1px solid var(--border); background: var(--surface); }
.vactions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.vcount { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); }
.vrunstate { width: 84px; font-size: 13px; color: var(--text-2); }
.btn.small { padding: 2px 10px; font-size: 12px; }
.machines.runners { grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); }
.machines.runners .rows span:nth-child(2) { overflow-wrap: anywhere; }
.dialog.wide { width: min(820px, 100%); }
.dialog.wide pre.log { max-height: 60vh; }
@media (max-width: 760px) {
  .vrow { grid-template-columns: 52px 1fr; }
  .vwho, .vstate { grid-column: 2; }
  .vrunstate { width: auto; }
}
.etabs-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
${EPICS_CSS}`;
