// The factory's web app (#421, #422, decision 0005), served by `factory ui` and bundled for the browser at release
// (tools/build_web.ts). Like Slack: on the far left the projects, then the selected project's channels (one per agent,
// one per view) with a search across every project's channels, and on the right the channel. Agents and machines are
// live over a WebSocket; starting and stopping an agent asks first, then runs `factory owner start|stop` on the server.
// Chat with an agent and the owner queue's approvals (#423) are in chat.tsx; the tasks, pull requests and CI views (#424)
// slot in as channels.
//
// It reads only the API (factory_ui_server.ts); the few rules it has are in model.ts, tested on their own.
import { type ReactNode, StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { agentState, ago, type ChannelView, channelHash, type LimitView, parseHash, type ProjectView, ROLE_TITLE, searchChannels,
  type Tone } from "./model.ts";
import { AgentsContext, Avatar, AVATAR_CSS } from "./avatar_view.tsx";
import { ChatLog, Composer, dispatchLive, OwnerQueueChannel, useChat } from "./chat.tsx";
import { type DocHit, DOCS_CSS, DocPageView, docChannel, pagesOf, parseDocChannel } from "./docs.tsx";
import type { DocSection } from "./docs_model.ts";
import { CSS } from "./style.ts";
import { CiChannel, loadViews, PullsChannel, TasksChannel, VIEWS_CSS } from "./views.tsx";
import { searchRows, type ViewsData } from "./views_model.ts";

// --- the API's shapes --------------------------------------------------------------------------------------------------

interface Problem {
  code: string;
  message: string;
  fix: string;
}

interface Project {
  id: string;
  name: string;
  path: string;
  current: boolean;
  problem: Problem | null;
}

interface Agent {
  name: string;
  role: string;
  state: string;
  detail: string;
  task: string | null;
  taskTitle: string | null;
  machine: string | null;
  machineName: string | null;
  here: boolean;
  runs: string;
  session: string | null;
  since: string | null;
  lastSeen: string | null;
  log: string[];
}

interface Machine {
  id: string;
  name: string;
  here: boolean;
  agents: { name: string; role: string; state: string; detail: string }[];
}

interface Live {
  agents: Agent[];
  machines: Machine[];
  runners: { name: string; state: "busy" | "idle" | "offline" }[];
  limit: LimitView | null;
  problems: Problem[];
}

type Conn = "connecting" | "live" | "reconnecting";

class Unauthorized extends Error {}

const TOKEN_KEY = "factory-ui-token";

function storedToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function keepToken(t: string): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // a private window: the token lives as long as the page
  }
}

/** The token from the address (?token=, then taken out of it so it isn't left in the history), else the kept one. */
function initialToken(): string {
  const url = new URL(location.href);
  const given = url.searchParams.get("token");
  if (given) {
    keepToken(given);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    return given;
  }
  return storedToken();
}

async function call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  if (r.status === 401) throw new Unauthorized();
  return (await r.json()) as T;
}

// --- small pieces ------------------------------------------------------------------------------------------------------

function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`dot ${tone}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function Notice({ tone, title, children }: { tone: "warn" | "bad"; title: string; children?: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <Dot tone={tone} />
      <div><strong>{title}</strong>{children}</div>
    </div>
  );
}

function ProblemNotice({ p }: { p: Problem }) {
  return <Notice tone="bad" title={p.message}><p>{p.fix}</p></Notice>;
}

function initials(name: string): string {
  const parts = name.split(/[-_ .]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

// --- the views ---------------------------------------------------------------------------------------------------------

interface Ask {
  verb: "start" | "stop";
  project: string;
  agent: string;
  role: string;
}

function AgentChannel({ agent, channel, live, project, token }: { agent: Agent | undefined; channel: ChannelView; live: Live | undefined;
  project: Project; token: string }) {
  const chat = useChat(token, project.id, channel.name);
  const limit = live?.limit ?? null;
  const st = agentState(agent, limit);
  const role = ROLE_TITLE[channel.role ?? ""] ?? channel.role ?? "";
  const runs = agent ? agent.runs === "tmux" && agent.session ? `tmux · ${agent.session}` : agent.runs || "—" : "—";
  return (
    <>
      <div className="body">
        {limit && <Notice tone="warn" title={limit.message}><p>The agents wait until then; nothing to do.</p></Notice>}
        {(live?.problems ?? []).map((p) => <ProblemNotice key={p.code} p={p} />)}
        {!live && <p className="empty">Reading {project.name}…</p>}
        {live && !agent && (
          <div className="card">
            <p className="empty" style={{ margin: 0 }}>
              {channel.name} hasn't reported yet: it isn't running on any machine. Start it here, or with
              {" "}<code>factory owner start {channel.role} {channel.name}</code>.
            </p>
          </div>
        )}
        {agent && (
          <section className="card" aria-label="Status">
            <dl className="facts">
              <div><dt>State</dt><dd className="state-big"><Dot tone={st.tone} />{st.text}</dd></div>
              <div><dt>Task</dt><dd>{agent.task ? <span>#{agent.task}{agent.taskTitle ? ` ${agent.taskTitle}` : ""}</span> : <span className="empty">none</span>}</dd></div>
              <div><dt>Role</dt><dd>{role}</dd></div>
              <div><dt>Machine</dt><dd>{agent.machineName ?? agent.machine ?? "—"}{agent.here && <span className="tag">this machine</span>}</dd></div>
              <div><dt>Runs in</dt><dd>{runs}</dd></div>
              <div><dt>Since</dt><dd>{ago(agent.since) || "—"}</dd></div>
              <div><dt>Last seen</dt><dd>{agent.state === "down" ? "—" : ago(agent.lastSeen) || "—"}</dd></div>
            </dl>
          </section>
        )}
        {agent && (
          <section className="card" aria-label="Recent output">
            <h3>Recent output</h3>
            {agent.log.length ? <pre className="log">{agent.log.join("\n")}</pre> : (
              <p className="empty" style={{ margin: 0 }}>
                {agent.state === "down" ? "It isn't running." : agent.here ? "Nothing printed yet."
                  : `Its output stays on ${agent.machineName ?? "its machine"}: `}
                {agent.state !== "down" && !agent.here && <code>factory follow {agent.name}</code>}
              </p>
            )}
          </section>
        )}
        <ChatLog chat={chat} agent={channel.name} />
      </div>
      <Composer chat={chat} agent={channel.name} role={channel.role ?? "coding-agent"} />
    </>
  );
}

function agentActions(agent: Agent | undefined, channel: ChannelView, project: Project, onAsk: (a: Ask) => void) {
  const role = channel.role ?? "coding-agent";
  const down = !agent || agent.state === "down";
  if (!down && agent && !agent.here) return <span className="tag quiet">on {agent.machineName ?? "another machine"}</span>;
  return down
    ? <button className="btn primary" onClick={() => onAsk({ verb: "start", project: project.id, agent: channel.name, role })}>Start</button>
    : <button className="btn" onClick={() => onAsk({ verb: "stop", project: project.id, agent: channel.name, role })}>Stop</button>;
}

function MachinesChannel({ live, project, open }: { live: Live | undefined; project: Project; open: (channel: string) => void }) {
  if (!live) return <div className="body"><p className="empty">Reading {project.name}…</p></div>;
  const runnerTone: Record<string, Tone> = { busy: "good", idle: "quiet", offline: "bad" };
  const runnerText: Record<string, string> = { busy: "running a job", idle: "waiting for a job", offline: "offline" };
  return (
    <div className="body">
      {live.limit && <Notice tone="warn" title={live.limit.message} />}
      {live.problems.map((p) => <ProblemNotice key={p.code} p={p} />)}
      {!live.machines.length && <p className="empty">No machine reports an agent yet. <code>factory loop -i</code> starts one.</p>}
      <div className="machines">
        {live.machines.map((m) => (
          <section className="card" key={m.id} aria-label={m.name}>
            <h3>{m.name}{m.here && <span className="tag">this machine</span>}</h3>
            <ul className="rows">
              {m.agents.map((a) => {
                const st = agentState(a, live.limit);
                return (
                  <li key={a.name}>
                    <Dot tone={st.tone} label={a.state} />
                    <Avatar name={a.name} role={a.role} />
                    <button className="link" onClick={() => open(`agent:${a.name}`)}>{a.name}</button>
                    <span className="detail">{st.text}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <section className="card" aria-label="CI runners">
          <h3>CI runners</h3>
          {live.runners.length ? (
            <ul className="rows">
              {live.runners.map((r) => (
                <li key={r.name}><Dot tone={runnerTone[r.state] ?? "quiet"} label={r.state} /><span>{r.name}</span><span className="detail">{runnerText[r.state]}</span></li>
              ))}
            </ul>
          ) : <p className="empty" style={{ margin: 0 }}>None known on this machine. <code>factory ci status</code> says where CI runs.</p>}
        </section>
      </div>
    </div>
  );
}

const COMING: Record<string, [string, string]> = {
  tasks: ["Tasks", "factory next"],
  "pull-requests": ["Pull requests", "factory prs"],
  ci: ["CI", "factory ci status"],
};

function ComingChannel({ name }: { name: string }) {
  const [title, command] = COMING[name] ?? [name, "factory help"];
  return (
    <div className="body">
      <div className="placeholder">
        <div className="big" aria-hidden="true">⌁</div>
        <h3>{title} come to this channel next</h3>
        <p>This view is being built (#424). Until then the same data is one command away: <code>{command}</code></p>
      </div>
    </div>
  );
}

/** The views that are channels of their own (#424, web/views.tsx). */
const VIEW_CHANNELS: Record<string, typeof TasksChannel> = { tasks: TasksChannel, "pull-requests": PullsChannel, ci: CiChannel };

// --- the app -----------------------------------------------------------------------------------------------------------

function Gate({ onToken, wrong }: { onToken: (t: string) => void; wrong: boolean }) {
  const [text, setText] = useState("");
  return (
    <main className="gate">
      <h1>Factory</h1>
      <p>{wrong ? "That token isn't this server's." : "This page needs the token `factory ui` printed."} Open the address it printed (it ends in
        {" "}<code>?token=…</code>), or paste the token from <code>.git/factory/ui-token</code>.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) onToken(text.trim()); }}>
        <input aria-label="Token" value={text} onChange={(e) => setText(e.target.value)} placeholder="token" autoFocus />
        <button className="btn primary" type="submit">Open</button>
      </form>
    </main>
  );
}

function App() {
  const [token, setToken] = useState(initialToken);
  const [wrong, setWrong] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [channelsBy, setChannelsBy] = useState<Record<string, ChannelView[]>>({});
  const [liveBy, setLiveBy] = useState<Record<string, Live>>({});
  const [viewsBy, setViewsBy] = useState<Record<string, ViewsData>>({}); // tasks, pull requests, CI (#424)
  const [docsBy, setDocsBy] = useState<Record<string, DocSection[]>>({}); // the PRD, the decisions and the wiki (#438)
  const [docHits, setDocHits] = useState<{ project: string; projectName: string; hit: DocHit }[]>([]);
  const [find, setFind] = useState(""); // the filter a view channel opens with (the search's row, #392)
  const [conn, setConn] = useState<Conn>("connecting");
  const [route, setRoute] = useState(() => parseHash(location.hash));
  const [query, setQuery] = useState("");
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ title: string; text: string; tone: Tone } | null>(null);
  const [menu, setMenu] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  const signedOut = useCallback((e: unknown) => {
    if (e instanceof Unauthorized) {
      keepToken("");
      setWrong(true);
      setToken("");
    }
  }, []);

  // the projects and their channels
  useEffect(() => {
    if (!token) return;
    let gone = false;
    (async () => {
      try {
        const { projects: list } = await call<{ projects: Project[] }>(token, "/api/projects");
        if (gone) return;
        setProjects(list);
        const all = await Promise.all(list.map((p) => call<{ channels: ChannelView[] }>(token, `/api/projects/${encodeURIComponent(p.id)}/channels`)));
        if (!gone) setChannelsBy(Object.fromEntries(list.map((p, i) => [p.id, all[i]?.channels ?? []])));
        const docs = await Promise.all(list.map((p) => call<{ sections?: DocSection[] }>(token, `/api/projects/${encodeURIComponent(p.id)}/docs`).catch(() => ({}))));
        if (!gone) setDocsBy(Object.fromEntries(list.map((p, i) => [p.id, (docs[i] as { sections?: DocSection[] }).sections ?? []])));
      } catch (e) {
        signedOut(e);
      }
    })();
    return () => {
      gone = true;
    };
  }, [token, signedOut]);

  // live: the WebSocket, opened again after it drops
  useEffect(() => {
    if (!token) return;
    let ws: WebSocket | null = null;
    let wait = 1000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = (): void => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        wait = 1000;
        setConn("live");
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; project?: string } & Live;
        if (m.type === "state" && m.project) {
          const { type: _t, project, ...data } = m;
          setLiveBy((before) => ({ ...before, [project as string]: data }));
        } else if (m.type === "views" && m.project) {
          const { type: _t, project, ...data } = m as unknown as { type: string; project: string } & ViewsData;
          setViewsBy((before) => ({ ...before, [project]: data }));
        } else dispatchLive(m);
      };
      ws.onclose = () => {
        if (stopped) return;
        setConn("reconnecting");
        timer = setTimeout(open, wait);
        wait = Math.min(wait * 2, 15_000);
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [token]);

  // a view channel (#424) opened before the WebSocket sent its data: read it through the API
  const viewProject = route && VIEW_CHANNELS[route.channel.replace(/^view:/, "")] ? route.project : null;
  const haveViews = viewProject !== null && viewProject in viewsBy;
  useEffect(() => {
    if (!token || viewProject === null || haveViews) return;
    loadViews((path) => call<Record<string, unknown>>(token, path), viewProject)
      .then((v) => setViewsBy((before) => (viewProject in before ? before : { ...before, [viewProject]: v })))
      .catch(signedOut);
  }, [token, viewProject, haveViews, signedOut]);

  // the shell's search also reads the docs of every project (the server does the matching)
  useEffect(() => {
    const words = query.trim();
    if (!token || !projects || !words) {
      setDocHits([]);
      return;
    }
    let gone = false;
    const timer = setTimeout(() => {
      Promise.all(projects.map((p) => call<{ hits?: DocHit[] }>(token, `/api/projects/${encodeURIComponent(p.id)}/docs/search?q=${encodeURIComponent(words)}`)
        .then((r) => (r.hits ?? []).map((hit) => ({ project: p.id, projectName: p.name, hit }))).catch(() => [])))
        .then((all) => { if (!gone) setDocHits(all.flat().slice(0, 30)); });
    }, 200);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [token, projects, query]);

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        search.current?.focus();
      }
      if (e.key === "Escape") {
        setAsk(null);
        setMenu(false);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // channels with any agent the live state reports that the settings don't name
  const views: ProjectView[] = useMemo(() => (projects ?? []).map((p) => {
    const base = channelsBy[p.id] ?? [];
    const named = new Set(base.map((c) => c.name));
    const extra: ChannelView[] = (liveBy[p.id]?.agents ?? []).filter((a) => !named.has(a.name))
      .map((a) => ({ id: `agent:${a.name}`, kind: "agent", name: a.name, title: a.name, role: a.role }));
    const agents = [...base.filter((c) => c.kind === "agent"), ...extra];
    return { id: p.id, name: p.name, channels: [...agents, ...base.filter((c) => c.kind === "view")] };
  }), [projects, channelsBy, liveBy]);

  const liveWords = useMemo(() => Object.fromEntries(Object.entries(liveBy).map(([p, l]) =>
    [p, Object.fromEntries(l.agents.map((a) => [a.name, `${a.state} ${a.detail}`]))])), [liveBy]);
  const hits = useMemo(() => searchChannels(views, query, liveWords), [views, query, liveWords]);
  const rowHits = useMemo(() => searchRows(projects ?? [], viewsBy, query), [projects, viewsBy, query]);

  const get = useCallback(<T,>(path: string) => call<T>(token, path).catch((e: unknown) => {
    signedOut(e);
    throw e;
  }), [token, signedOut]);

  if (!token) return <Gate wrong={wrong} onToken={(t) => { keepToken(t); setWrong(false); setToken(t); }} />;
  if (!projects) return <main className="gate"><p>Loading…</p></main>;

  const project = projects.find((p) => p.id === route?.project) ?? projects[0] as Project;
  const view = views.find((v) => v.id === project.id) ?? { id: project.id, name: project.name, channels: [] };
  const docRoute = route ? parseDocChannel(route.channel) : null;
  const docPages = pagesOf(docsBy[project.id]);
  const docPage = docRoute ? docPages.find((d) => d.id === docRoute.id) : undefined;
  const channel = view.channels.find((c) => c.id === route?.channel) ?? view.channels[0];
  const live = liveBy[project.id];
  const agentOf = (name: string): Agent | undefined => live?.agents.find((a) => a.name === name);
  const go = (p: string, c: string, f = ""): void => {
    setFind(f);
    location.hash = channelHash(p, c);
    setMenu(false);
    setQuery("");
  };

  const runAsk = async (): Promise<void> => {
    if (!ask) return;
    setBusy(true);
    try {
      const r = await call<{ ok?: boolean; command?: string; output?: string; message?: string; fix?: string }>(token,
        `/api/projects/${encodeURIComponent(ask.project)}/agents/${encodeURIComponent(ask.agent)}/${ask.verb}`, { method: "POST", body: { confirm: true } });
      setToast(r.ok ? { title: `Ran ${r.command}`, text: r.output ?? "", tone: "good" }
        : { title: r.message ?? "It didn't run.", text: [r.fix, r.output].filter(Boolean).join("\n\n"), tone: "bad" });
    } catch (e) {
      signedOut(e);
      if (!(e instanceof Unauthorized)) setToast({ title: "The server can't be reached.", text: "Is `factory ui` still running?", tone: "bad" });
    } finally {
      setBusy(false);
      setAsk(null);
    }
  };

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    try {
      return await call<Record<string, unknown>>(token, path, { method: "POST", body });
    } catch (e) {
      signedOut(e);
      return { ok: false, message: e instanceof Unauthorized ? "The token was refused." : "The server can't be reached.", fix: "Is `factory ui` still running?" };
    }
  };
  const viewChannel = (name: string) => {
    const View = VIEW_CHANNELS[name] as (typeof VIEW_CHANNELS)[string];
    return <View key={`${project.id}/${name}`} project={project} views={viewsBy[project.id]} find={find} post={post} say={setToast} docs={docPages}
      open={(c, f) => go(project.id, c, f)} />;
  };

  const sideAgent = (c: ChannelView) => {
    const a = live?.agents.find((x) => x.name === c.name);
    const st = agentState(a, live?.limit ?? null);
    return (
      <button key={c.id} className="chan" aria-current={c.id === channel?.id} onClick={() => go(project.id, c.id)} title={`${c.name}: ${st.text}`}>
        <Avatar name={c.name} role={c.role} size={28} tone={live ? st.tone : "quiet"} />
        <span className="name">{c.name}<span className="sub">{ROLE_TITLE[c.role ?? ""] ?? c.role}</span></span>
        {a?.task && <span className="meta">#{a.task}</span>}
      </button>
    );
  };

  const role = ROLE_TITLE[channel?.role ?? ""] ?? "";
  const agent = channel?.kind === "agent" ? agentOf(channel.name) : undefined;
  const subtitle = channel?.kind === "agent" ? [role, agentState(agent, live?.limit ?? null).text].filter(Boolean).join(" · ")
    : `${project.name} · ${project.current ? "this project" : project.path}`;

  const agentsHere = Object.fromEntries(view.channels.filter((c) => c.kind === "agent").map((c) => [c.name, { role: c.role, avatar: c.avatar }]));

  return (
    <AgentsContext.Provider value={agentsHere}>
    <div className={`app${menu ? " open" : ""}`}>
      {menu && <button className="backdrop" aria-label="Close the menu" onClick={() => setMenu(false)} />}
      <nav className="rail" aria-label="Projects">
        {projects.map((p) => (
          <button key={p.id} aria-current={p.id === project.id} title={p.name} aria-label={p.name}
            onClick={() => go(p.id, (views.find((v) => v.id === p.id)?.channels[0]?.id) ?? "view:machines")}>
            {initials(p.name)}
            {(p.problem || liveBy[p.id]?.limit) && <span className="flag" />}
          </button>
        ))}
      </nav>
      <nav className="side" aria-label="Channels">
        <div className="side-head">
          <h1>{project.name}</h1>
          <p title={project.path}>{project.current ? "this project" : project.path}</p>
        </div>
        <div className="search">
          <SearchIcon />
          <input ref={search} type="search" placeholder="Search channels" aria-label="Search channels across projects" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              const first = hits[0];
              const row = rowHits[0];
              if (e.key === "Enter" && first) go(first.project, first.channel.id);
              else if (e.key === "Enter" && row) go(row.project, row.channel, row.find);
              else if (e.key === "Enter" && docHits[0]) go(docHits[0].project, docChannel(docHits[0].hit.id));
              if (e.key === "Escape") setQuery("");
            }} />
          {!query && <kbd>/</kbd>}
        </div>
        <div className="channels">
          {query ? (
            <div className="section">
              <h2>{hits.length + rowHits.length + docHits.length ? `${hits.length + rowHits.length + docHits.length} match${hits.length + rowHits.length + docHits.length > 1 ? "es" : ""}` : `No match for "${query}"`}</h2>
              {hits.map((h) => (
                <button key={`${h.project}/${h.channel.id}`} className="chan" onClick={() => go(h.project, h.channel.id)}>
                  {h.channel.kind === "agent" ? <Avatar name={h.channel.name} role={h.channel.role} image={h.channel.avatar} size={20} /> : <span className="hash">#</span>}
                  <span className="name">{h.channel.title}<span className="sub">{h.projectName}{h.channel.role ? ` · ${ROLE_TITLE[h.channel.role] ?? h.channel.role}` : ""}</span></span>
                </button>
              ))}
              {rowHits.length > 0 && <h2>In the views</h2>}
              {rowHits.map((h, i) => (
                <button key={`${h.project}/${h.channel}/${h.find}/${i}`} className="chan" onClick={() => go(h.project, h.channel, h.find)}>
                  <span className="hash">›</span>
                  <span className="name">{h.title}<span className="sub">{h.view} · {h.projectName}{h.detail ? ` · ${h.detail}` : ""}</span></span>
                </button>
              ))}
              {docHits.length > 0 && <h2>In the docs</h2>}
              {docHits.map((h, i) => (
                <button key={`${h.project}/${h.hit.id}/${h.hit.line}/${i}`} className="chan" onClick={() => go(h.project, docChannel(h.hit.id))}>
                  <span className="hash">§</span>
                  <span className="name">{h.hit.text}<span className="sub">{h.hit.title} · line {h.hit.line} · {h.projectName}</span></span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="section">
                <h2>Agents</h2>
                {view.channels.filter((c) => c.kind === "agent").map(sideAgent)}
              </div>
              <div className="section">
                <h2>Views</h2>
                {view.channels.filter((c) => c.kind === "view").map((c) => (
                  <button key={c.id} className="chan" aria-current={c.id === channel?.id} onClick={() => go(project.id, c.id)}>
                    <span className="hash">#</span><span className="name">{c.title}</span>
                  </button>
                ))}
              </div>
              <div className="section">
                <h2>Docs</h2>
                {(docsBy[project.id] ?? []).map((s) => s.id === "prd" ? s.pages.map((d) => (
                  <button key={d.id} className="chan" aria-current={docRoute?.id === d.id} onClick={() => go(project.id, docChannel(d.id))}>
                    <span className="hash">§</span><span className="name">PRD</span>
                  </button>
                )) : (
                  <details key={s.id} className="docs-sec" open={docRoute !== null && s.pages.some((d) => d.id === docRoute.id)}>
                    <summary>{s.title} <span className="meta">{s.pages.length}</span></summary>
                    {s.pages.map((d) => (
                      <button key={d.id} className="chan" aria-current={docRoute?.id === d.id} title={d.title} onClick={() => go(project.id, docChannel(d.id))}>
                        <span className="hash">§</span><span className="name">{d.title}</span>
                      </button>
                    ))}
                  </details>
                ))}
                {(docsBy[project.id] ?? []).filter((s) => s.problem).map((s) => <p key={s.id} className="sub docs-problem" title={s.problem?.fix}>{s.title}: {s.problem?.message}</p>)}
              </div>
            </>
          )}
        </div>
        <div className="side-foot" role="status">
          <Dot tone={conn === "live" ? "good" : "warn"} />
          {conn === "live" ? "Live" : conn === "connecting" ? "Connecting…" : "Reconnecting…"}
        </div>
      </nav>
      <main className="main">
        <header className="main-head">
          <button className="menu" aria-label="Projects and channels" onClick={() => setMenu(true)}><MenuIcon /></button>
          <div className="grow">
            <h2>{docRoute ? <span className="hash">§</span>
              : channel?.kind === "agent" ? <Avatar name={channel.name} role={channel.role} size={26} /> : <span className="hash">#</span>}
              {docRoute ? docPage?.title ?? docRoute.id : channel?.title ?? "—"}</h2>
            <div className="subtitle">{docRoute ? `Docs · ${project.name}` : subtitle}</div>
          </div>
          {!docRoute && channel?.kind === "agent" && live && !project.problem && agentActions(agent, channel, project, setAsk)}
        </header>
        {project.problem ? <div className="body"><ProblemNotice p={project.problem} /></div>
          : docRoute ? <DocPageView key={`${project.id}/${docRoute.id}`} project={project.id} id={docRoute.id} anchor={docRoute.anchor} get={get} pages={docPages}
            open={(c) => go(project.id, c)} />
          : !channel ? <div className="body"><p className="empty">This project has no channels.</p></div>
          : channel.kind === "agent" ? <AgentChannel key={`${project.id}/${channel.name}`} agent={agent} channel={channel} live={live} project={project} token={token} />
          : channel.name === "owner-queue" ? <OwnerQueueChannel token={token} project={project.id} />
          : channel.name === "machines" ? <MachinesChannel live={live} project={project} open={(c) => go(project.id, c)} />
          : VIEW_CHANNELS[channel.name] ? viewChannel(channel.name)
          : <ComingChannel name={channel.name} />}
      </main>
      {ask && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) setAsk(null); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="ask-title">
            <h3 id="ask-title">{ask.verb === "start" ? "Start" : "Stop"} {ask.agent}?</h3>
            <p>This runs <code>factory owner {ask.verb === "start" ? `start ${ask.role} ${ask.agent}` : `stop ${ask.agent}`}</code> in {ask.project} on
              the machine that serves this page.</p>
            <div className="actions">
              <button className="btn" onClick={() => setAsk(null)} disabled={busy} autoFocus>Cancel</button>
              <button className={`btn ${ask.verb === "stop" ? "danger" : "primary"}`} onClick={() => void runAsk()} disabled={busy}>
                {busy ? "Running…" : ask.verb === "start" ? "Start" : "Stop"}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Dot tone={toast.tone} />
          <div><strong>{toast.title}</strong>{toast.text && <pre>{toast.text}</pre>}</div>
          <button aria-label="Close" onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </div>
    </AgentsContext.Provider>
  );
}

const style = document.createElement("style");
style.textContent = CSS + VIEWS_CSS + DOCS_CSS + AVATAR_CSS;
document.head.append(style);
createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><App /></StrictMode>);
