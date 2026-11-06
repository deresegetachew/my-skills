// The web app's tasks, pull requests and CI channels (#424): the cockpit's views as channels, from the API's views data
// (factory_ui_views.ts, live over the WebSocket). Each has a filter (#392: every word, any case) and says how old its
// data is, with a button that reads it again. The CI channel puts the verdict first and its actions (#396) are buttons
// that ask first, then run the same commands the cockpit's CI view runs, on the machine that serves the page.
import { type ReactNode, useEffect, useState } from "react";
import { Avatar } from "./avatar_view.tsx";
import type { Tone } from "./model.ts";
import { type ActionRow, checksText, checksTone, epicBar, type EpicRow, epicTone, filterRows, groupByEpic, minutesText, type ProblemView, protectedText, type PullRow, reviewTone,
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
  say: Say;
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

/** The filter box and how old the data is, with a read again. */
function Toolbar({ typed, setTyped, views, project, post, say, what }: { typed: string; setTyped: (s: string) => void;
  views: ViewsData; project: { id: string }; post: Post; say: Say; what: string }) {
  const again = async (): Promise<void> => {
    const r = await post(`/api/projects/${encodeURIComponent(project.id)}/refresh`, {});
    if (r.ok !== true) say({ title: String(r.message ?? "It didn't start."), text: String(r.fix ?? ""), tone: "bad" });
  };
  return (
    <div className="vbar">
      <input type="search" className="vfilter" placeholder={`Filter ${what}`} aria-label={`Filter ${what}`} value={typed}
        onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setTyped(""); }} />
      <span className="vage" title={views.generatedAt ?? ""}>{ageText(views)}</span>
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

function TaskLine({ t, open }: { t: TaskRow; open: ViewProps["open"] }) {
  return (
    <li className={t.next ? "vrow next" : "vrow"}>
      <span className="vid"><Ext href={t.url}>#{t.id}</Ext></span>
      <span className="vmain">
        <span className="vtitle">{t.title}{t.next && <span className="tag">next</span>}</span>
        <span className="vsub">
          {t.group && <span>{t.group}</span>}
          {t.todos.all > 0 && <span>{t.todos.done} of {t.todos.all} todos done</span>}
          {t.dependsOn.length > 0 && <span>after {t.dependsOn.map((d) => `#${d.replace(/^#/, "")}`).join(", ")}</span>}
          {t.pr && <span>PR <button className="link" onClick={() => open("view:pull-requests", `#${t.pr?.number}`)}>#{t.pr.number}</button></span>}
        </span>
      </span>
      <span className="vwho">{t.holders.length ? t.holders.map((h) => <AgentLink key={h} name={h} open={open} />) : <span className="empty">—</span>}</span>
      <span className="vstate"><Dot tone={taskTone(t.state)} />{t.stateText}</span>
    </li>
  );
}

export function TasksChannel(p: ViewProps) {
  const [typed, setTyped] = useFilter(p.find);
  if (!p.views) return <Loading name={p.project.name} />;
  const v = p.views;
  const all = v.tasks.tasks;
  const rows = filterRows(all, typed);
  return (
    <div className="body">
      <Toolbar typed={typed} setTyped={setTyped} views={v} project={p.project} post={p.post} say={p.say} what="tasks" />
      <Problems list={[...v.problems, ...v.tasks.problems]} />
      <div className="lanes" aria-label="Tasks by state">
        {LANES.map(([s, name]) => <span key={s}><Dot tone={taskTone(s)} />{name} {all.filter((t) => t.state === s).length}</span>)}
      </div>
      <p className="vnote">In the order <code>factory next</code> walks them{v.tasks.next ? <>; the next one is <strong>#{v.tasks.next}</strong></> : "; none is ready to take"}.</p>
      {!all.length && !v.problems.length && <p className="empty">No open tasks.</p>}
      {all.length > 0 && !rows.length && <NoMatch typed={typed} />}
      {rows.length > 0 && v.epics.epics.length === 0 && <ul className="vlist" aria-label="Tasks">{rows.map((t) => <TaskLine key={t.id} t={t} open={p.open} />)}</ul>}
      {rows.length > 0 && v.epics.epics.length > 0 && groupByEpic(rows, v.epics.epics).map((g) => (
        <section key={g.epic?.id ?? "none"} aria-label={g.epic ? `Tasks in epic ${g.epic.title}` : "Tasks in no epic"}>
          <h3 className="vgroup">{g.epic
            ? <button className="link" onClick={() => p.open("view:epics", `#${g.epic?.id}`)}>Epic #{g.epic.id} {g.epic.title}</button>
            : "In no epic"}</h3>
          <ul className="vlist">{g.tasks.map((t) => <TaskLine key={t.id} t={t} open={p.open} />)}</ul>
        </section>
      ))}
    </div>
  );
}

// --- epics -------------------------------------------------------------------------------------------------------------

const STAGES: Array<[string, string]> = [["investigating", "investigating"], ["prd", "PRD being written"], ["decision", "decision"],
  ["planned", "planned"], ["building", "building"], ["done", "done"], ["parked", "parked"]];

function EpicCard({ e, open }: { e: EpicRow; open: ViewProps["open"] }) {
  const pct = epicBar(e);
  return (
    <li className="card epic">
      <div className="prhead">
        <span className="vid"><Ext href={e.url}>#{e.id}</Ext></span>
        <span className="vtitle">{e.title}</span>
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

export function EpicsChannel(p: ViewProps) {
  const [typed, setTyped] = useFilter(p.find);
  if (!p.views) return <Loading name={p.project.name} />;
  const v = p.views;
  const all = v.epics.epics;
  const rows = filterRows(all, typed);
  return (
    <div className="body">
      <Toolbar typed={typed} setTyped={setTyped} views={v} project={p.project} post={p.post} say={p.say} what="epics" />
      <Problems list={[...v.problems, ...v.epics.problems]} />
      <div className="lanes" aria-label="Epics by stage">
        {STAGES.map(([s, name]) => <span key={s}><Dot tone={epicTone(s)} />{name} {all.filter((e) => e.stage === s).length}</span>)}
      </div>
      {!all.length && !v.problems.length && <p className="empty">No epics. An epic is an issue labelled <code>epic</code> with a task list of <code>- [ ] #n</code> lines.</p>}
      {all.length > 0 && !rows.length && <NoMatch typed={typed} />}
      {rows.length > 0 && <ul className="vcards" aria-label="Epics">{rows.map((e) => <EpicCard key={e.id} e={e} open={p.open} />)}</ul>}
    </div>
  );
}

// --- pull requests -----------------------------------------------------------------------------------------------------

function PullCard({ pr, open }: { pr: PullRow; open: ViewProps["open"] }) {
  return (
    <li className="card pr">
      <div className="prhead">
        <span className="vid"><Ext href={pr.url}>#{pr.number}</Ext></span>
        <span className="vtitle">{pr.title}</span>
        {pr.draft && <span className="tag quiet">draft</span>}
      </div>
      <dl className="facts">
        <div><dt>Checks</dt><dd><Dot tone={checksTone(pr.checks.state)} />{checksText(pr.checks)}</dd></div>
        <div><dt>Review</dt><dd><Dot tone={reviewTone(pr.review.state)} />{pr.review.text}{pr.review.claim && pr.review.state !== "none" ? ` · ${pr.review.claim} holds it` : ""}</dd></div>
        <div><dt>Protected files</dt><dd><Dot tone={pr.protected ? "warn" : pr.protected === false ? "good" : "quiet"} />{protectedText(pr.protected)}</dd></div>
        <div><dt>Agent</dt><dd>{pr.agent ? <AgentLink name={pr.agent} open={open} /> : <span className="empty">a person</span>}{pr.rework && <span className="tag">{pr.rework} reworking</span>}</dd></div>
        <div><dt>Task</dt><dd>{pr.task ? <button className="link" onClick={() => open("view:tasks", `#${pr.task}`)}>#{pr.task}</button> : <span className="empty">—</span>}</dd></div>
        <div><dt>Next</dt><dd>{pr.next.text}</dd></div>
      </dl>
      <p className="vsub mono">{pr.branch}</p>
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
      {rows.length > 0 && <ul className="prs" aria-label="Pull requests">{rows.map((pr) => <PullCard key={pr.number} pr={pr} open={p.open} />)}</ul>}
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
        {!ci.runners.length && <p className="empty">{ci.mode === "local" ? <>No runner has the label {ci.label}: <code>factory ci install</code> registers this machine's.</>
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
.vfilter { flex: 1; min-width: 160px; border: 1px solid var(--line); background: var(--bg); color: var(--text); border-radius: 8px;
  padding: 6px 10px; font: inherit; font-size: 13px; }
.vage { color: var(--faint); font-size: 12px; white-space: nowrap; }
.vnote { color: var(--muted); font-size: 13px; margin: 0; }
.lanes { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--muted); }
.lanes span { display: inline-flex; align-items: center; gap: 6px; }
.vlist { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); }
.vrow { display: grid; grid-template-columns: 64px 1fr minmax(80px, 160px) 120px; gap: 12px; align-items: center; padding: 10px 14px;
  border-top: 1px solid var(--line); }
.vrow:first-child { border-top: 0; }
.vgroup { font-size: 13px; margin: 12px 0 6px; color: var(--muted); }
.vcards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.ebar { height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; margin: 10px 0 6px; }
.ebar span { display: block; height: 100%; background: var(--accent); }
.etasks { display: flex; flex-wrap: wrap; gap: 4px 10px; }
button.link.done { color: var(--muted); font-weight: 400; }
.vrow.next { background: color-mix(in srgb, var(--accent) 6%, var(--bg)); }
.vid { font-family: var(--mono); font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.vmain { min-width: 0; display: flex; flex-direction: column; }
.vtitle { font-weight: 600; min-width: 0; overflow-wrap: anywhere; display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.vsub { color: var(--muted); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; }
.vsub.mono { font-family: var(--mono); margin-top: 10px; }
.vwho { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.vstate { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); white-space: nowrap; }
button.link { border: 0; background: none; padding: 0; cursor: pointer; font-weight: 600; color: inherit; }
button.link:hover, a.ext:hover { color: var(--accent-text); text-decoration: underline; }
a.ext { color: inherit; text-decoration: none; }
.prs { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.prhead { display: flex; gap: 10px; align-items: baseline; margin-bottom: 12px; flex-wrap: wrap; }
.verdict { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 700; padding: 14px 16px; border-radius: var(--radius);
  border: 1px solid; }
.verdict.good { border-color: color-mix(in srgb, var(--good) 45%, transparent); background: color-mix(in srgb, var(--good) 9%, var(--bg)); }
.verdict.warn { border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 9%, var(--bg)); }
.verdict.bad { border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: color-mix(in srgb, var(--bad) 8%, var(--bg)); }
.vactions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.vcount { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.vrunstate { width: 84px; font-size: 13px; color: var(--muted); }
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
`;
