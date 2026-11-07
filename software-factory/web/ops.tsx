// Home, Activity, Health and Usage and cost (#455, #451), from the owner's designs (docs/design/web-ui/Main.dc.html,
// Activity.dc.html, Health.dc.html and Usage.dc.html). Each reads its route (GET /api/projects/:p/home|activity|health|usage,
// hooks/factory_ui_ops.ts) and reads it again when the WebSocket says something changed (`pulse`), at most every two
// seconds. Health's "Check again" posts .../health/check. The words are in ops_model.ts; nothing here shows a command.
import { type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AttentionList } from "./attention.tsx";
import { AttentionContext } from "./attention_context.tsx";
import { type AttentionItem, attentionLine } from "./attention_model.ts";
import { Avatar } from "./avatar_view.tsx";
import { ago } from "./model.ts";
import { type ActivityItem, activityDot, activitySub, attention, type HealthData, healthLine, type HomeData, homeLine, KIND_LABEL, mergePushed,
  passed, percentOf, type Problem, teamRow, tokensText, type UsageData, usageBar, usageTiles } from "./ops_model.ts";
import { PageHead } from "./page_head.tsx";
import { Chips, ListRow, StatusDot, Tabs } from "./parts.tsx";
import type { Post, Say } from "./views.tsx";

export interface OpsProps {
  project: { id: string; name: string };
  get: <T>(path: string) => Promise<T>;
  post: Post;
  say: Say;
  /** Opens a page (`view:tasks`), with the search it opens with (`#7`). */
  open: (channel: string, find?: string) => void;
  onMenu: () => void;
  /** Goes up when the WebSocket says this project changed. */
  pulse: number;
  /** Needs attention as the WebSocket last pushed it (#579); left out, Home's own. */
  attention?: AttentionItem[];
  /** Opens the confirm to start an agent (the same as its page's Start). */
  startAgent?: (name: string) => void;
}

/** The entries the WebSocket pushes ({type: "activity", project, items}, #583), for the Activity page on screen. */
const activityBus = new EventTarget();

/** Hands a pushed Activity message to the page (app.tsx calls it for each one). */
export function dispatchActivity(m: { project?: string; items?: unknown }): void {
  if (m.project && Array.isArray(m.items)) activityBus.dispatchEvent(new CustomEvent("items", { detail: { project: m.project, items: m.items as ActivityItem[] } }));
}

const UNREACHABLE: Problem = { code: "unreachable", message: "The server can't be reached.", fix: "Check that the web UI is still running on its machine, then reload the page." };

/** Reads `path` now, and again on each pulse (at most every two seconds); null until the first answer. */
function useLoad<T>(get: OpsProps["get"], path: string, pulse: number): { data: T | null; problem: Problem | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reload = useCallback(() => {
    last.current = Date.now();
    get<T>(path).then((d) => { setData(d); setProblem(null); }).catch(() => setProblem(UNREACHABLE));
  }, [get, path]);
  useEffect(() => {
    setData(null);
    reload();
  }, [reload]);
  useEffect(() => {
    if (pulse === 0) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, Math.max(2000 - (Date.now() - last.current), 0));
    return () => clearTimeout(timer.current);
  }, [pulse, reload]);
  return { data, problem, reload };
}

function Problems({ list }: { list: Problem[] }) {
  return (
    <>
      {list.map((x) => (
        <div key={x.code} className="notice warn" role="status"><StatusDot state="waiting" /><div><strong>{x.message}</strong><p>{x.fix}</p></div></div>
      ))}
    </>
  );
}

function Section({ title, link, children }: { title: string; link?: ReactNode; children: ReactNode }) {
  return (
    <section className="ops-sec">
      <div className="ops-sec-head"><h2>{title}</h2>{link}</div>
      {children}
    </section>
  );
}

function base(p: OpsProps): string {
  return `/api/projects/${encodeURIComponent(p.project.id)}`;
}

// --- Home --------------------------------------------------------------------------------------------------------------

export function HomePage(p: OpsProps) {
  const { data, problem } = useLoad<HomeData>(p.get, `${base(p)}/home`, p.pulse);
  const stuck = useContext(AttentionContext).agents;
  const attention = p.attention ?? data?.attention ?? [];
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return (
    <>
      <PageHead title="Home" purpose={data ? `${today}. ${homeLine(data)}` : "What the team is doing now, and what needs you."} onMenu={p.onMenu} />
      <div className="body">
        <Problems list={[...(problem ? [problem] : []), ...(data?.problems ?? [])]} />
        {!data && !problem && <p className="empty">Reading what the team is doing…</p>}
        {data && (
          <>
            {attention.length > 0 && (
              <Section title="Needs attention">
                <p className="ops-line">{attentionLine(attention)}</p>
                <AttentionList items={attention} project={p.project} post={p.post} say={p.say} open={p.open} startAgent={p.startAgent} />
              </Section>
            )}
            <Section title="Needs you">
              {!data.needs.length && <p className="empty">Nothing needs you now.</p>}
              <ul className="lrows" aria-label="Needs you">
                {data.needs.map((n, i) => (
                  <ListRow key={`${n.kind}/${i}`} lead={<StatusDot state={n.kind === "health" || n.kind === "ci" ? "red" : n.kind === "blocked" ? "waiting" : "red"} />}
                    title={n.title} sub={n.sub}
                    action={<button className={`btn small${i === 0 ? " primary" : ""}`} onClick={() => p.open(n.link, n.find)}>{n.action}</button>} />
                ))}
              </ul>
            </Section>
            <Section title="The team" link={<button className="btn plain small" onClick={() => p.open("view:tasks")}>Open the board ›</button>}>
              {!data.team.length && <p className="empty">No agent has reported yet.</p>}
              <ul className="lrows" aria-label="The team">
                {data.team.map((a) => {
                  const r = teamRow(a, data.limit);
                  const why = stuck[a.name];
                  return <ListRow key={a.name} avatar={{ name: a.name, role: a.role }} title={a.name}
                    sub={why ? <>{r.sub}<span className="stuck-mark"><span className="stuck-tag">Stuck</span><span className="stuck-why">{why}</span></span></> : r.sub}
                    status={{ state: r.dot, text: r.state }}
                    action={<button className="btn small" onClick={() => p.open(a.link)}>Talk</button>} />;
                })}
              </ul>
            </Section>
            <Section title="Progress" link={<button className="btn plain small" onClick={() => p.open("view:epics")}>Open the epics ›</button>}>
              <p className="ops-line">{data.progress.done} of {data.progress.all} tasks done.</p>
              <ul className="ops-bars" aria-label="Progress by epic">
                {data.progress.epics.map((e) => (
                  <li key={e.id}><span className="ops-bar-name">#{e.id} {e.title}</span>
                    <span className="ops-bar"><span style={{ width: `${percentOf(e.done, e.all)}%` }} /></span><span className="ops-bar-num">{e.done} of {e.all}</span></li>
                ))}
                {data.progress.noEpic.all > 0 && (
                  <li><span className="ops-bar-name">No epic</span><span className="ops-bar"><span style={{ width: `${percentOf(data.progress.noEpic.done, data.progress.noEpic.all)}%` }} /></span>
                    <span className="ops-bar-num">{data.progress.noEpic.done} of {data.progress.noEpic.all}</span></li>
                )}
              </ul>
            </Section>
            <Section title="Recent activity" link={<button className="btn plain small" onClick={() => p.open("page:activity")}>All activity ›</button>}>
              <Feed items={data.recent} open={p.open} />
              {data.activityFrom === "snapshot" && <p className="empty">From the last read of GitHub: claims, moves and comments show once the tasks are on the message board.</p>}
            </Section>
          </>
        )}
      </div>
    </>
  );
}

function Feed({ items, open }: { items: ActivityItem[]; open: OpsProps["open"] }) {
  if (!items.length) return <p className="empty">Nothing has happened yet.</p>;
  return (
    <ul className="lrows" aria-label="Activity">
      {items.map((x) => (
        <ListRow key={x.id} lead={x.agent ? <Avatar name={x.agent} size={32} /> : <StatusDot state={activityDot(x)} />}
          title={<button className="ops-feed-open" onClick={() => open(x.link, x.find)}>{x.agent && <strong>{x.agent} </strong>}<span className="ops-feed-text">{x.text}</span></button>}
          sub={activitySub(x)}
          action={<button className="btn plain small" onClick={() => open(x.link, x.find)}>Open</button>} />
      ))}
    </ul>
  );
}

// --- Activity ----------------------------------------------------------------------------------------------------------

interface ActivityData {
  from: "board" | "snapshot";
  items: ActivityItem[];
  agents: string[];
  kinds: string[];
  epics?: Array<{ id: string; title: string }>;
  problems: Problem[];
}

export function ActivityPage(p: OpsProps) {
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [task, setTask] = useState("");
  const [epic, setEpic] = useState("");
  const [paused, setPaused] = useState(false);
  const [pushed, setPushed] = useState<ActivityItem[]>([]);
  const pulse = useRef(p.pulse);
  if (!paused) pulse.current = p.pulse;
  const q = new URLSearchParams({ ...(agent ? { agent } : {}), ...(kind ? { kind } : {}), ...(epic ? { epic } : {}),
    ...(task.trim() ? { task: task.trim() } : {}) }).toString();
  const { data, problem } = useLoad<ActivityData>(p.get, `${base(p)}/activity${q ? `?${q}` : ""}`, pulse.current);
  // a new entry the WebSocket pushes goes on top at once (#583); the next read has it too
  useEffect(() => setPushed([]), [data]);
  useEffect(() => {
    if (paused) return;
    const h = (e: Event): void => {
      const d = (e as CustomEvent<{ project: string; items: ActivityItem[] }>).detail;
      if (d.project === p.project.id) setPushed((before) => [...d.items, ...before]);
    };
    activityBus.addEventListener("items", h);
    return () => activityBus.removeEventListener("items", h);
  }, [paused, p.project.id]);
  const items = data ? mergePushed(data.items, pushed, { agent, task, epic, kind }) : [];
  const waiting = paused && p.pulse !== pulse.current;
  return (
    <>
      <PageHead title="Activity" onMenu={p.onMenu}
        purpose={data?.from === "board" ? "Everything that happened, newest first. Live from the message board." : "Everything that happened, newest first."}
        actions={<button className="btn" onClick={() => setPaused(!paused)}>{paused ? (waiting ? "Resume (new events)" : "Resume") : "Pause"}</button>} />
      <div className="body">
        <Problems list={[...(problem ? [problem] : []), ...(data?.problems ?? [])]} />
        <Tabs label="Kind" value={kind} onChange={setKind}
          tabs={[{ id: "", label: "Everything" }, ...(data?.kinds ?? []).map((k) => ({ id: k, label: KIND_LABEL[k] ?? k }))]} />
        <div className="ops-filters">
          <Chips label="Agent" value={agent} onChange={setAgent} chips={[{ id: "", label: "Everyone" }, ...(data?.agents ?? []).map((a) => ({ id: a, label: a }))]} />
          {(data?.epics?.length ?? 0) > 0 && (
            <Chips label="Epic" value={epic} onChange={setEpic}
              chips={[{ id: "", label: "Every epic" }, ...(data?.epics ?? []).map((e) => ({ id: e.id, label: `#${e.id}${e.title ? ` ${e.title}` : ""}` }))]} />
          )}
          <label className="ops-task">Task <input type="search" placeholder="#7" value={task} onChange={(e) => setTask(e.target.value)} aria-label="Filter by task" /></label>
        </div>
        {!data && !problem && <p className="empty">Reading what happened…</p>}
        {data && <Feed items={items} open={p.open} />}
      </div>
    </>
  );
}

// --- Health ------------------------------------------------------------------------------------------------------------

export function HealthPage(p: OpsProps) {
  const { data, problem, reload } = useLoad<HealthData>(p.get, `${base(p)}/health`, p.pulse);
  const [checking, setChecking] = useState(false);
  const busy = checking || data?.running === true;
  const again = async (): Promise<void> => {
    setChecking(true);
    const r = await p.post(`${base(p)}/health/check`, {});
    setChecking(false);
    if (r.code && !r.groups) p.say({ title: String(r.message ?? "The checks didn't run."), text: String(r.fix ?? ""), tone: "bad" });
    reload();
  };
  const rows = attention(data);
  return (
    <>
      <PageHead title="Health" purpose={healthLine(data)} onMenu={p.onMenu}
        actions={<button className="btn primary" disabled={busy} onClick={() => void again()}>{busy ? "Checking…" : "Check again"}</button>} />
      <div className="body">
        <Problems list={[...(problem ? [problem] : []), ...(data?.problems ?? [])]} />
        {data?.ranAt && (
          <Section title={rows.length ? `Needs attention ${rows.length}` : "Needs attention"}>
            {!rows.length && <p className="empty">Every check passes.</p>}
            <ul className="lrows" aria-label="Needs attention">
              {rows.map((r) => (
                <ListRow key={r.key} lead={<StatusDot state={r.status.dot} />} title={r.what} sub={`${r.where} · ${r.fix}`} status={{ state: r.status.dot, text: r.status.text }} />
              ))}
            </ul>
          </Section>
        )}
        {data?.ranAt && (
          <Section title="Passed">
            <ul className="lrows" aria-label="Passed">
              {passed(data).map((g) => <ListRow key={g.id} lead={<StatusDot state="working" />} title={g.title} sub={g.sub} status={{ state: "working", text: g.count }} />)}
            </ul>
          </Section>
        )}
        <p className="empty">Checking never changes anything. It costs GitHub calls, so it runs when you ask, not on every look{data?.ranAt ? `; the last run was ${ago(data.ranAt)}` : ""}.</p>
      </div>
    </>
  );
}

// --- Usage and cost ----------------------------------------------------------------------------------------------------

export function UsagePage(p: OpsProps) {
  const { data, problem } = useLoad<UsageData>(p.get, `${base(p)}/usage`, 0);
  const [tab, setTab] = useState<"task" | "agent" | "day">("task");
  const rows = data ? (tab === "task" ? data.tasks : tab === "agent" ? data.agents : data.days ?? []) : [];
  const max = Math.max(0, ...rows.map((r) => Math.max(r.used, r.budget ?? 0)));
  return (
    <>
      <PageHead title="Usage and cost" onMenu={p.onMenu}
        purpose={data?.measured === false ? "No token use is recorded on this machine in these dates; below are the GitHub calls." : "What each agent and task used, against its budget."} />
      <div className="body">
        <Problems list={[...(problem ? [problem] : []), ...(data?.problems ?? [])]} />
        {!data && !problem && <p className="empty">Reading the logs on this machine…</p>}
        {data && (
          <>
            <div className="ops-tiles">
              {usageTiles(data).map((t) => <div key={t.label} className="card ops-tile"><span>{t.label}</span><strong>{t.value}</strong><span>{t.line}</span></div>)}
            </div>
            {data.measured && (
              <>
                <Tabs label="Group by" value={tab} onChange={setTab} tabs={[{ id: "task", label: "By task", count: data.tasks.length },
                  { id: "agent", label: "By agent", count: data.agents.length }, { id: "day", label: "By day", count: data.days?.length ?? 0 }]} />
                <ul className="ops-bars" aria-label={tab === "task" ? "Tokens by task" : tab === "agent" ? "Tokens by agent" : "Tokens by day"}>
                  {rows.map((r) => {
                    const b = usageBar(r, max);
                    return (
                      <li key={r.key}>
                        <span className="ops-bar-name">{tab === "task" && r.key !== "-" ? `#${r.key} ` : ""}{r.title || r.key}</span>
                        <span className="ops-bar"><span style={{ width: b.width }} /></span>
                        <span className="ops-bar-num"><StatusDot state={b.dot} />{b.text}</span>
                      </li>
                    );
                  })}
                </ul>
                <p className="empty">Tokens count fresh input and output, as a budget does. {data.budget.tokens === null ? "No budget is set, so nothing is compared." :
                  `A dot turns yellow at ${data.budget.warnPercent}% of the budget and red over it; a budget never stops an agent.`}</p>
              </>
            )}
            {data.github && (
              <Section title="GitHub calls in the last hour">
                <p className="ops-line">{data.github.total} from the factory on this machine{data.github.account ? `; GitHub counts ${data.github.account.used} of ${data.github.account.limit} used on the account` : ""}.</p>
                <ul className="lrows" aria-label="GitHub calls by agent">
                  {Object.entries(data.github.agents).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([who, n]) => (
                    <ListRow key={who} title={who} status={{ state: "idle", text: `${n} calls` }} />
                  ))}
                </ul>
              </Section>
            )}
            <Section title="Not measured yet">
              <ul className="ops-list">{data.notMeasured.map((x) => <li key={x}>{x}</li>)}</ul>
            </Section>
          </>
        )}
      </div>
    </>
  );
}

export const OPS_CSS = String.raw`
.ops-sec { margin: 8px 0 28px; }
.ops-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ops-sec-head h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.ops-line { margin: 4px 0 10px; color: var(--text-2); }
.ops-feed-text { font-weight: 400; }
.ops-feed-open { all: unset; cursor: pointer; }
.ops-feed-open:hover .ops-feed-text { text-decoration: underline; }
.ops-feed-open:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; border-radius: 4px; }
.ops-bars { list-style: none; margin: 12px 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.ops-bars li { display: grid; grid-template-columns: minmax(120px, 2fr) 3fr 120px; align-items: center; gap: 14px; }
.ops-bars .ops-bar-num { justify-content: flex-end; }
.ops-bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ops-bar { height: 8px; border-radius: 999px; background: var(--bg-subtle); overflow: hidden; }
.ops-bar span { display: block; height: 100%; background: var(--text-3); border-radius: 999px; }
.ops-bar-num { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 13px; white-space: nowrap; }
.ops-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 18px; }
.ops-tile { display: flex; flex-direction: column; gap: 4px; }
.ops-tile span { color: var(--text-2); font-size: 13px; }
.ops-tile strong { font-size: 22px; }
.ops-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin: 14px 0; }
.ops-task { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 13px; }
.ops-task input { height: 40px; width: 110px; border: 1px solid var(--border-strong); border-radius: 10px; padding: 0 12px; font: inherit;
  background: var(--surface); color: var(--text); }
.ops-list { margin: 6px 0; padding-left: 18px; color: var(--text-2); line-height: 1.6; }
@media (max-width: 760px) { .ops-bars li { grid-template-columns: 1fr; gap: 4px; } }
`;
