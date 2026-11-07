// The factory's web app (#421, #422, decision 0005), served by `factory ui` and bundled for the browser at release
// (tools/build_web.ts). The owner's design (#450, docs/design/web-ui/): on the far left the projects, then the selected
// project's sidebar (the pages, Your team, Run the factory) with a search across every project, and on the right the
// page under its header. Agents and machines are live over a WebSocket; starting and stopping an agent shows its
// preconditions and what will and won't happen first. Chat with an agent and the owner queue's approvals (#423) are in
// chat.tsx; the tasks, pull requests and CI views (#424) are pages; the shared parts are in parts.tsx.
//
// It reads only the API (factory_ui_server.ts); its rules are in model.ts, nav_model.ts, parts_model.ts and theme_model.ts,
// tested on their own. Nothing on screen names a command.
import { type ReactNode, StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { agentState, ago, channelHash, type ChannelView, type LimitView, parseHash, pickProject, type ProjectView, ROLE_TITLE,
  searchChannels, splitTask, taskChannel, type Tone } from "./model.ts";
import { ADD_CSS, AddProjectPage } from "./add_project.tsx";
import type { Run as AddRun } from "./add_project_model.ts";
import { AgentsContext, Avatar, AVATAR_CSS } from "./avatar_view.tsx";
import { BOARD_CSS } from "./board.tsx";
import { ChatLog, Composer, dispatchLive, OwnerQueueChannel, useChat } from "./chat.tsx";
import { type DocHit, DOCS_CSS, DocPageView, docChannel, pagesOf, parseDocChannel } from "./docs.tsx";
import type { DocSection } from "./docs_model.ts";
import { addMachineAsk, agentArgs, plainProblem } from "./machines_model.ts";
import { addressOf, channelOf, pageHead, pageOf, SETTINGS_TABS, sidebar } from "./nav_model.ts";
import { ARTIFACTS_CSS, ArtifactsPage } from "./artifacts.tsx";
import { MenuIcon } from "./page_head.tsx";
import { ConfirmDialog, ListRow, PARTS_CSS, StatusDot, Tabs } from "./parts.tsx";
import { type AgentFacts, type ConfirmSpec, startAgentAsk, stopAgentAsk, talkTargets } from "./parts_model.ts";
import { MaintenancePage, ReleasesPage, SETTINGS_CSS, SettingsPage } from "./settings.tsx";
import { SIGNOFF_CSS, SignoffPage } from "./signoff.tsx";
import { PR_CSS, PrPage } from "./pr.tsx";
import { CSS } from "./style.ts";
import { THEME_CSS } from "./theme.ts";
import { nextTheme, THEME_KEY, themeLabel, themeOf } from "./theme_model.ts";
import { CiChannel, EpicsChannel, loadViews, PullsChannel, TasksChannel, VIEWS_CSS } from "./views.tsx";
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

const UNREACHABLE_FIX = "Check that the web UI still runs on the machine that serves this page, start it again there, then reload.";

const TOKEN_KEY = "factory-ui-token";
const PROJECT_KEY = "factory-ui-project"; // the project last opened on this browser (#545)

function storedProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function keepProject(id: string): void {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {
    // a private window: the next visit opens the first project
  }
}
const ADD_HASH = "#/add-project";

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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </svg>
  );
}

/** The theme switch's icon: half a circle (follows the system), a sun (light) or a moon (dark). */
function ThemeIcon({ choice }: { choice: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {choice === "light" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>
        : choice === "dark" ? <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        : <><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" /></>}
    </svg>
  );
}

/** The light or dark the page shows: the owner's pick kept in the browser, else the system's, followed as it changes. */
function useTheme(): { choice: string | null; flip: () => void } {
  const kept = (): string | null => {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch {
      return null;
    }
  };
  const [choice, setChoice] = useState<string | null>(kept);
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent): void => setDark(e.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = themeOf(choice, dark);
  }, [choice, dark]);
  const flip = (): void => {
    const next = nextTheme(choice);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // a private window: the pick lasts as long as the page
    }
    setChoice(next);
  };
  return { choice, flip };
}

/** A project's square on the rail, in a category colour of its own. */
const PROJECT_COLOURS = ["violet", "green", "blue", "pink", "yellow"];

function Notice({ tone, title, children }: { tone: "good" | "warn" | "bad"; title: string; children?: ReactNode }) {
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
  spec: ConfirmSpec;
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
            <p className="empty" style={{ margin: 0 }}>{channel.name} hasn't reported yet: it isn't running on any machine. Start it with the button above.</p>
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
                  : `Its output stays on ${agent.machineName ?? "its machine"}: open this page there to see it.`}
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

/** Start or Stop: each opens the confirm with its preconditions; one running on another machine says where instead. */
function agentActions(agent: Agent | undefined, channel: ChannelView, project: Project, onAsk: (a: Ask) => void) {
  const role = channel.role ?? "coding-agent";
  const down = !agent || agent.state === "down";
  const facts: AgentFacts = { name: channel.name, here: agent?.here ?? false, state: agent?.state ?? "down", machineName: agent?.machineName ?? agent?.machine ?? null,
    task: agent?.task ?? null };
  if (!down && agent && !agent.here) return <span className="tag quiet">on {agent.machineName ?? "another machine"}</span>;
  return down
    ? <button className="btn primary" onClick={() => onAsk({ verb: "start", project: project.id, agent: channel.name, role, spec: startAgentAsk(facts) })}>Start</button>
    : <button className="btn danger" onClick={() => onAsk({ verb: "stop", project: project.id, agent: channel.name, role, spec: stopAgentAsk(facts) })}>Stop</button>;
}

interface JoinCode { code: string; command: string; expiresAt: number }

type Post = (path: string, body: unknown) => Promise<Record<string, unknown>>;

/** Add machine (#445): a name and the team's agents it will run; after the confirm, the one command (with its join code)
 * to run on the new machine. That command is the only one the page shows: the owner copies it there. */
function AddMachine({ project, live, post }: { project: Project; live: Live; post: Post }) {
  const [openForm, setOpenForm] = useState(false);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<(JoinCode & { name: string }) | null>(null);
  const [problem, setProblem] = useState<{ message: string; fix: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const team = live.agents.map((a) => ({ name: a.name, role: a.role }));
  const chosen = team.filter((a) => picked.includes(a.name));
  const reset = (): void => {
    setMade(null); setName(""); setPicked([]); setCopied(false); setProblem(null);
  };
  const make = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const r = await post(`/api/projects/${encodeURIComponent(project.id)}/machines`, { confirm: true, name: name.trim(), agents: agentArgs(chosen) });
    setBusy(false);
    setAsking(false);
    const join = r.join as Partial<JoinCode> | undefined;
    if (r.ok && join && typeof join.command === "string") setMade({ code: String(join.code ?? ""), command: join.command, expiresAt: Number(join.expiresAt ?? 0), name: name.trim() });
    else setProblem(plainProblem(String(r.message ?? "The hub couldn't make the join code."), String(r.fix ?? "")));
  };
  const copy = async (): Promise<void> => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const toggle = (agent: string): void => setPicked((p) => (p.includes(agent) ? p.filter((x) => x !== agent) : [...p, agent]));
  return (
    <section className="card add-machine" aria-label="Add machine">
      <h3>Add machine</h3>
      {!openForm ? (
        <>
          <p className="muted card-text">Join another computer to this hub's message board, so its agents share claims and messages with the team.</p>
          <div className="actions"><button className="btn primary" onClick={() => setOpenForm(true)}>Add machine</button></div>
        </>
      ) : made ? (
        <div className="join-made" aria-live="polite">
          <p className="card-text">On <strong>{made.name}</strong>, in the project's folder, run this.{made.expiresAt > 0
            ? ` It works once, until ${new Date(made.expiresAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : " It works once."}</p>
          <output aria-label="The command to run on the new machine" className="join-cmd">{made.command}</output>
          <div className="actions">
            <button className="btn primary" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
            <button className="btn plain" onClick={() => { reset(); setOpenForm(false); }}>Done</button>
          </div>
          <p className="muted card-note">It holds the machine's login to the board: send it over a private channel.</p>
        </div>
      ) : (
        <form className="join-form" onSubmit={(e) => { e.preventDefault(); setAsking(true); }}>
          {problem && <Notice tone="bad" title={problem.message}>{problem.fix && <p>{problem.fix}</p>}</Notice>}
          <label className="field">Machine name
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="office-pc" autoComplete="off" />
          </label>
          <fieldset className="field">
            <legend>Agents it will run</legend>
            {team.length ? (
              <ul className="lrows">
                {team.map((a) => (
                  <ListRow key={a.name} avatar={a} title={a.name} sub={ROLE_TITLE[a.role] ?? a.role}
                    action={<input type="checkbox" className="pick" checked={picked.includes(a.name)} onChange={() => toggle(a.name)} aria-label={`Run ${a.name} there`} />} />
                ))}
              </ul>
            ) : <p className="muted card-text">No agents are named in this project yet.</p>}
          </fieldset>
          <div className="actions">
            <button className="btn primary" type="submit" disabled={!name.trim()}>Make the join code</button>
            <button className="btn plain" type="button" onClick={() => { reset(); setOpenForm(false); }}>Cancel</button>
          </div>
        </form>
      )}
      {asking && <ConfirmDialog spec={addMachineAsk(name, chosen, live.machines.map((m) => m.name))} busy={busy} onConfirm={() => void make()}
        onCancel={() => setAsking(false)} />}
    </section>
  );
}

function MachinesChannel({ live, project, open, post }: { live: Live | undefined; project: Project; open: (channel: string) => void; post: Post }) {
  if (!live) return <div className="body"><p className="empty">Reading {project.name}…</p></div>;
  const runnerTone: Record<string, Tone> = { busy: "good", idle: "quiet", offline: "bad" };
  const runnerText: Record<string, string> = { busy: "running a job", idle: "waiting for a job", offline: "offline" };
  return (
    <div className="body">
      {live.limit && <Notice tone="warn" title={live.limit.message} />}
      {live.problems.map((p) => <ProblemNotice key={p.code} p={p} />)}
      {!live.machines.length && <p className="empty">No machine reports an agent yet. Start one from Your team.</p>}
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
        <AddMachine project={project} live={live} post={post} />
        <section className="card" aria-label="CI runners">
          <h3>CI runners</h3>
          {live.runners.length ? (
            <ul className="rows">
              {live.runners.map((r) => (
                <li key={r.name}><Dot tone={runnerTone[r.state] ?? "quiet"} label={r.state} /><span>{r.name}</span><span className="detail">{runnerText[r.state]}</span></li>
              ))}
            </ul>
          ) : <p className="empty" style={{ margin: 0 }}>None known on this machine. CI and runners says where CI runs.</p>}
        </section>
      </div>
    </div>
  );
}

/** A page of the design not built yet: what it will hold, and the pages that already have some of it. */
const COMING: Record<string, { what: string; see: string[] }> = {
  home: { what: "Home will show what the team is doing now and what needs you, on one page.", see: ["inbox", "board", "prs"] },
  activity: { what: "Activity will show everything that happened, newest first.", see: ["prs", "ci"] },
  health: { what: "Health will check every part of the factory and give a fix for what doesn't work.", see: ["machines", "ci"] },
  usage: { what: "Usage and cost will show what each agent and task used, against its budget.", see: ["board"] },
  integrations: { what: "The services the agents use will be listed here, with whether each one works.", see: [] },
};

function ComingPage({ page, open }: { page: string; open: (channel: string) => void }) {
  const c = COMING[page] ?? { what: "This page is being built.", see: [] };
  const tabs = SETTINGS_TABS.some((t) => t.page === page);
  return (
    <div className="body">
      {tabs && <Tabs label="Factory settings" value={page} onChange={(p) => open(channelOf(p))} tabs={SETTINGS_TABS.map((t) => ({ id: t.page, label: t.label }))} />}
      <div className="placeholder">
        <h2>Coming next</h2>
        <p>{c.what}</p>
        {c.see.length > 0 && (
          <div className="links">
            {c.see.map((p) => <button key={p} className="btn" onClick={() => open(channelOf(p))}>Open {pageHead(p).title}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

/** PRD and decisions: a tab per section (the PRD, the decisions, the wiki), and a row per page that opens it. */
function DocsIndex({ sections, open }: { sections: DocSection[] | undefined; open: (channel: string) => void }) {
  const [tab, setTab] = useState("");
  const s = sections?.find((x) => x.id === tab) ?? sections?.[0];
  if (!sections) return <div className="body"><p className="empty">Reading the docs…</p></div>;
  if (!s) return <div className="body"><p className="empty">No PRD, decisions or wiki could be read for this project. Reload the page to try again.</p></div>;
  return (
    <div className="body">
      <Tabs label="PRD and decisions" value={s.id} onChange={(t) => (t === "artifacts" ? open(channelOf("artifacts")) : setTab(t))}
        tabs={[...sections.map((x) => ({ id: x.id, label: x.title, count: x.pages.length })), { id: "artifacts", label: "Designs and artifacts" }]} />
      {s.problem && <ProblemNotice p={s.problem} />}
      {!s.problem && !s.pages.length && <p className="empty">Nothing here yet.</p>}
      <ul className="lrows" aria-label={s.title}>
        {s.pages.map((d) => (
          <ListRow key={d.id} title={d.title} sub={d.path}
            action={<button className="btn small" onClick={() => open(docChannel(d.id))}>Open</button>} />
        ))}
      </ul>
    </div>
  );
}

/** Factory settings' own pages (#456, web/settings.tsx); Integrations is still to come (#441). */
const SETTINGS_PAGES: Record<string, typeof SettingsPage> = { settings: SettingsPage, releases: ReleasesPage, maintenance: MaintenancePage };

/** The views that are channels of their own (#424, web/views.tsx). */
const VIEW_CHANNELS: Record<string, typeof TasksChannel> = { tasks: TasksChannel, epics: EpicsChannel, "pull-requests": PullsChannel, ci: CiChannel };

// --- the app -----------------------------------------------------------------------------------------------------------

/** What the list knows of pull request `n` that changes its page: a new head, new checks, a draft made ready (#453). */
function prRowKey(v: ViewsData | undefined, n: string): string {
  const r = v?.pulls.pulls.find((x) => String(x.number) === n);
  return r ? `${r.head ?? ""}|${r.checks.state}|${r.draft}|${r.next.action}` : "";
}

/** The page the address bar names; a page's own name (`page:board`) is read as the address it opens. */
function routeOf(hash: string): { project: string; channel: string; task: string | null } | null {
  const r = parseHash(hash);
  if (!r) return null;
  const s = splitTask(r.channel); // a task opened on the board (#543): view:tasks/task:b3
  return { project: r.project, channel: addressOf(s.channel), task: s.task };
}

function Gate({ onToken, wrong }: { onToken: (t: string) => void; wrong: boolean }) {
  const [text, setText] = useState("");
  return (
    <main className="gate">
      <h1>Factory</h1>
      <p>{wrong ? "That token isn't this server's." : "This page needs the token the server printed when it started."} Open the address it
        printed (it ends in <code>?token=…</code>), or paste the token kept in <code>.git/factory/ui-token</code>.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) onToken(text.trim()); }}>
        <input aria-label="Token" value={text} onChange={(e) => setText(e.target.value)} placeholder="token" autoFocus />
        <button className="btn primary" type="submit">Open</button>
      </form>
    </main>
  );
}

function App() {
  const theme = useTheme();
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
  const [route, setRoute] = useState(() => routeOf(location.hash));
  const [query, setQuery] = useState("");
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ title: string; text: string; tone: Tone } | null>(null);
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState(() => location.hash === ADD_HASH); // Add a project (#447)
  const [addRun, setAddRun] = useState<AddRun | null>(null);
  const [listed, setListed] = useState(0); // goes up when the server's project list changes
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
  }, [token, signedOut, listed]);

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
        } else if (m.type === "add-project") setAddRun((m as unknown as { run: AddRun }).run);
        else if (m.type === "projects") setListed((n) => n + 1);
        else dispatchLive(m);
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
    const onHash = (): void => {
      setRoute(routeOf(location.hash));
      setAdding(location.hash === ADD_HASH);
    };
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

  // a POST whose function stays the same between renders (Add a project's Review asks again when it changes)
  const postStable = useCallback((path: string, body: unknown) => call<Record<string, unknown>>(token, path, { method: "POST", body })
    .catch((e: unknown): Record<string, unknown> => {
      signedOut(e);
      return { ok: false, message: e instanceof Unauthorized ? "The token was refused." : "The server can't be reached.", fix: "Check that the web UI still runs on this machine." };
    }), [token, signedOut]);

  if (!token) return <Gate wrong={wrong} onToken={(t) => { keepToken(t); setWrong(false); setToken(t); }} />;
  if (!projects) return <main className="gate"><p>Loading…</p></main>;
  if (adding) {
    return <AddProjectPage get={get} post={postStable} run={addRun} setRun={setAddRun} live={conn === "live"}
      close={() => { location.hash = ""; setAdding(false); }}
      open={(p) => { setAdding(false); location.hash = channelHash(p, "page:home"); }} />;
  }

  const project = pickProject(projects, route?.project, storedProject()) as Project;
  if (route?.project === project.id) keepProject(project.id);
  const view = views.find((v) => v.id === project.id) ?? { id: project.id, name: project.name, channels: [] };
  const docRoute = route ? parseDocChannel(route.channel) : null;
  const docPages = pagesOf(docsBy[project.id]);
  const docPage = docRoute ? docPages.find((d) => d.id === docRoute.id) : undefined;
  const channel = view.channels.find((c) => c.id === route?.channel);
  const pageRoute = route?.channel?.startsWith("page:") || route?.channel?.startsWith("signoff:") || route?.channel?.startsWith("pr:");
  const page = channel || docRoute ? pageOf(route?.channel ?? "") : pageOf(pageRoute ? route?.channel ?? "" : "page:home");
  const signoffId = route?.channel?.startsWith("signoff:") ? route.channel.slice("signoff:".length) : null;
  const prNumber = route?.channel?.startsWith("pr:") ? route.channel.slice("pr:".length) : null; // a pull request's page (#453)
  // the pages that write their own header from their data (#454)
  const ownHead = !project.problem && !docRoute && !channel && (page === "signoff" || page === "artifacts" || prNumber !== null);
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
      setToast(r.ok ? { title: `${ask.verb === "start" ? "Started" : "Stopped"} ${ask.agent}.`, text: r.output ?? "", tone: "good" }
        : { title: r.message ?? "It didn't run.", text: [r.fix, r.output].filter(Boolean).join("\n\n"), tone: "bad" });
    } catch (e) {
      signedOut(e);
      if (!(e instanceof Unauthorized)) setToast({ title: "The server can't be reached.", text: UNREACHABLE_FIX, tone: "bad" });
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
      return { ok: false, message: e instanceof Unauthorized ? "The token was refused." : "The server can't be reached.", fix: UNREACHABLE_FIX };
    }
  };
  const viewChannel = (name: string) => {
    const View = VIEW_CHANNELS[name] as (typeof VIEW_CHANNELS)[string];
    const talkers = talkTargets(view.channels.filter((c) => c.kind === "agent"));
    return <View key={`${project.id}/${name}`} project={project} views={viewsBy[project.id]} find={find} post={post} say={setToast} docs={docPages}
      token={token} talkers={talkers}
      open={(c, f) => go(project.id, c, f)}
      task={route?.task ?? null}
      openTask={(id) => { location.hash = channelHash(project.id, id ? taskChannel(`view:${name}`, id) : `view:${name}`); }} />;
  };

  const agentChannels = view.channels.filter((c) => c.kind === "agent");
  const nav = sidebar({
    page,
    team: agentChannels.map((c) => {
      const a = agentOf(c.name);
      return { name: c.name, role: c.role, ...(a ? { state: a.state, detail: a.detail } : {}) };
    }),
    counts: { prs: viewsBy[project.id]?.pulls.pulls.length ?? 0 },
    limit: live?.limit ?? null,
  });

  const role = ROLE_TITLE[channel?.role ?? ""] ?? "";
  const agent = channel?.kind === "agent" ? agentOf(channel.name) : undefined;
  const head = docRoute ? { title: docPage?.title ?? docRoute.id, purpose: `PRD and decisions · ${docPage?.path ?? ""}` }
    : channel?.kind === "agent" ? { title: channel.name, purpose: [role, agentState(agent, live?.limit ?? null).text].filter(Boolean).join(" · ") }
    : pageHead(page);

  const agentsHere = Object.fromEntries(view.channels.filter((c) => c.kind === "agent").map((c) => {
    const s = agentState(agentOf(c.name), live?.limit ?? null); // the same words and tone as the sidebar (#545)
    return [c.name, { role: c.role, avatar: c.avatar, tone: s.tone, state: s.text }];
  }));

  return (
    <AgentsContext.Provider value={agentsHere}>
    <div className={`app${menu ? " open" : ""}`}>
      {menu && <button className="backdrop" aria-label="Close the menu" onClick={() => setMenu(false)} />}
      <nav className="rail" aria-label="Projects">
        {projects.map((p, i) => {
          const c = PROJECT_COLOURS[i % PROJECT_COLOURS.length] as string;
          return (
            <button key={p.id} className="proj" aria-current={p.id === project.id} title={p.name} aria-label={p.problem ? `${p.name}: ${p.problem.message}` : p.name}
              style={{ background: `var(--${c}-fill)`, color: `var(--${c}-ink)` }} onClick={() => go(p.id, "page:home")}>
              {initials(p.name)}
              {(p.problem || liveBy[p.id]?.limit) && <span className="flag" />}
            </button>
          );
        })}
        <button className="icon add" title="Add a project" aria-label="Add a project" onClick={() => { location.hash = ADD_HASH; }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <span className="grow" />
        <button className="icon" onClick={theme.flip} aria-label={`${themeLabel(theme.choice)}. Change it`} title={themeLabel(theme.choice)}>
          <ThemeIcon choice={theme.choice ?? "system"} />
        </button>
        <button className="icon" aria-label="Factory settings" aria-current={nav.ops.some((n) => n.page === "settings" && n.on)}
          onClick={() => go(project.id, channelOf("settings"))}><GearIcon /></button>
      </nav>
      <nav className="side" aria-label={`${project.name}: pages and team`}>
        <div className="side-head">
          <h1 title={project.path}>{project.name}</h1>
          <p role="status"><StatusDot state={conn === "live" ? "working" : "waiting"} />
            {conn === "live" ? (project.current ? "Live · this project" : "Live") : conn === "connecting" ? "Connecting…" : "Reconnecting…"}</p>
        </div>
        <div className="search">
          <SearchIcon />
          <input ref={search} type="search" placeholder="Search" aria-label="Search every project: agents, pages, tasks, pull requests and docs" value={query}
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
        {query ? (
          <div className="nav" aria-label="Search results">
            <h2>{hits.length + rowHits.length + docHits.length ? `${hits.length + rowHits.length + docHits.length} match${hits.length + rowHits.length + docHits.length > 1 ? "es" : ""}` : `No match for "${query}"`}</h2>
            {hits.map((h) => (
              <button key={`${h.project}/${h.channel.id}`} className="nav-item" onClick={() => go(h.project, h.channel.id)}>
                {h.channel.kind === "agent" ? <Avatar name={h.channel.name} role={h.channel.role} image={h.channel.avatar} size={20} /> : <span className="hash">#</span>}
                <span className="name">{h.channel.kind === "view" ? pageHead(pageOf(h.channel.id)).title : h.channel.title}
                  <span className="sub">{h.projectName}{h.channel.role ? ` · ${ROLE_TITLE[h.channel.role] ?? h.channel.role}` : ""}</span></span>
              </button>
            ))}
            {rowHits.length > 0 && <h2>In the pages</h2>}
            {rowHits.map((h, i) => (
              <button key={`${h.project}/${h.channel}/${h.find}/${i}`} className="nav-item" onClick={() => go(h.project, h.channel, h.find)}>
                <span className="hash">›</span>
                <span className="name">{h.title}<span className="sub">{pageHead(pageOf(h.channel)).title} · {h.projectName}{h.detail ? ` · ${h.detail}` : ""}</span></span>
              </button>
            ))}
            {docHits.length > 0 && <h2>In the docs</h2>}
            {docHits.map((h, i) => (
              <button key={`${h.project}/${h.hit.id}/${h.hit.line}/${i}`} className="nav-item" onClick={() => go(h.project, docChannel(h.hit.id))}>
                <span className="hash">§</span>
                <span className="name">{h.hit.text}<span className="sub">{h.hit.title} · line {h.hit.line} · {h.projectName}</span></span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="nav">
              {nav.main.map((n) => (
                <button key={n.page} className="nav-item" aria-current={n.on ? "page" : undefined} onClick={() => go(project.id, n.channel)}>
                  <span className="name">{n.label}</span>
                  {n.badge && <span className={`badge ${n.badge.tone}`} aria-label={`${n.badge.count} ${n.page === "inbox" ? "need you" : "open"}`}>{n.badge.count}</span>}
                </button>
              ))}
            </div>
            <div className="nav">
              <h2>Your team</h2>
              {!nav.team.length && <p className="empty" style={{ margin: "0 10px", fontSize: 13 }}>No agents named yet.</p>}
              {nav.team.map((t) => (
                <button key={t.name} className="nav-item mate" aria-current={t.on ? "page" : undefined} title={t.title} onClick={() => go(project.id, t.channel)}>
                  <Avatar name={t.name} role={t.roleId} size={28} />
                  <span className="name">{t.name}<span className="sub">{t.role}</span></span>
                  <span role="img" aria-label={t.title} style={{ display: "inline-flex" }}><StatusDot state={t.dot} /></span>
                </button>
              ))}
            </div>
            <div className="nav">
              <h2>Run the factory</h2>
              {nav.ops.map((n) => (
                <button key={n.page} className="nav-item" aria-current={n.on ? "page" : undefined} onClick={() => go(project.id, n.channel)}>
                  <span className="name">{n.label}</span>
                  {n.badge && <span className={`badge ${n.badge.tone}`}>{n.badge.count}</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </nav>
      <main className="main">
        {!ownHead && (
          <header className="page-head">
            <button className="menu" aria-label="Projects and pages" onClick={() => setMenu(true)}><MenuIcon /></button>
            <div className="grow">
              <h1>{channel?.kind === "agent" && <Avatar name={channel.name} role={channel.role} size={40} />}{head.title}</h1>
              {head.purpose && <p>{head.purpose}</p>}
            </div>
            {!docRoute && channel?.kind === "agent" && live && !project.problem && <div className="page-actions">{agentActions(agent, channel, project, setAsk)}</div>}
          </header>
        )}
        {project.problem ? <div className="body"><ProblemNotice p={project.problem} /></div>
          : docRoute ? <DocPageView key={`${project.id}/${docRoute.id}`} project={project.id} id={docRoute.id} anchor={docRoute.anchor} get={get} pages={docPages}
            open={(c) => go(project.id, c)} />
          : channel?.kind === "agent" ? <AgentChannel key={`${project.id}/${channel.name}`} agent={agent} channel={channel} live={live} project={project} token={token} />
          : page === "docs" ? <DocsIndex key={project.id} sections={docsBy[project.id]} open={(c) => go(project.id, c)} />
          : ownHead && page === "signoff" ? <SignoffPage key={project.id} project={project} id={signoffId} token={token} get={get} post={post} say={setToast}
            talkers={talkTargets(view.channels.filter((c) => c.kind === "agent"))} open={(c, f) => go(project.id, c, f)} onMenu={() => setMenu(true)} />
          : ownHead && prNumber !== null ? <PrPage key={`${project.id}/${prNumber}`} project={project} number={prNumber} docs={docPages} get={get} post={post}
            say={setToast} open={(c, f) => go(project.id, c, f)} onMenu={() => setMenu(true)} rowKey={prRowKey(viewsBy[project.id], prNumber)} />
          : ownHead && page === "artifacts" ? <ArtifactsPage key={project.id} project={project} get={get} post={post} say={setToast}
            open={(c) => go(project.id, c)} onMenu={() => setMenu(true)} />
          : !channel && SETTINGS_PAGES[page] ? (() => {
            const Page = SETTINGS_PAGES[page] as typeof SettingsPage;
            return <Page key={`${project.id}/${page}`} project={project} get={get} post={post} say={setToast} open={(c) => go(project.id, c)}
              agents={live?.agents ?? []} />;
          })()
          : !channel ? <ComingPage page={page} open={(c) => go(project.id, c)} />
          : channel.name === "owner-queue" ? <OwnerQueueChannel token={token} project={project.id} />
          : channel.name === "machines" ? <MachinesChannel live={live} project={project} open={(c) => go(project.id, c)} post={post} />
          : VIEW_CHANNELS[channel.name] ? viewChannel(channel.name)
          : <ComingPage page={page} open={(c) => go(project.id, c)} />}
      </main>
      {ask && <ConfirmDialog key={`${ask.verb}/${ask.agent}`} spec={ask.spec} busy={busy} onConfirm={() => void runAsk()} onCancel={() => setAsk(null)} />}
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
style.textContent = THEME_CSS + CSS + PARTS_CSS + VIEWS_CSS + DOCS_CSS + BOARD_CSS + AVATAR_CSS + SIGNOFF_CSS + ARTIFACTS_CSS + ADD_CSS + SETTINGS_CSS + PR_CSS;
document.head.append(style);
createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><App /></StrictMode>);
