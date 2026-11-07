// Factory settings (#456), from the owner's design (docs/design/web-ui/Settings.dc.html, Releases.dc.html and
// Maintenance.dc.html): the team (add a coding agent, remove one after its preconditions), every project setting with
// its plain name, help and where its value comes from (staged, then proposed as one pull request the owner merges),
// this machine's settings (saved at once), the factory's version and update, and the clean-ups. The rules and words are
// in settings_model.ts; the data and every change go through /api/projects/:p/settings (factory_ui_settings.ts). Nothing
// here shows a command.
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Avatar } from "./avatar_view.tsx";
import { ROLE_TITLE } from "./model.ts";
import { channelOf, SETTINGS_TABS } from "./nav_model.ts";
import { ConfirmDialog, ListRow, StatusDot, Tabs } from "./parts.tsx";
import type { Check, ConfirmSpec } from "./parts_model.ts";
import { addAgentAsk, type CheckoutFacts, checkoutText, fieldOf, fromText, inputOf, MAINTENANCE, machineAgentsText, maintenanceAsk, nameProblem,
  proposeAsk, rawOf, removeAgentAsk, searchSettings, type SettingRow, type Staged, stagedText, syncAsk, updateAsk, valueText } from "./settings_model.ts";
import type { Post, Say } from "./views.tsx";

interface Problem {
  code: string;
  message: string;
  fix: string;
}

/** What the page needs to know of an agent as it runs now (the shell's live state). */
export interface LiveAgent {
  name: string;
  state: string;
  task: string | null;
  here: boolean;
  machineName: string | null;
}

interface SettingsData {
  team: { agents: { name: string; role: string }[]; next: Record<string, string[]>; free: string[] };
  sections: { id: string; title: string; rows: SettingRow[] }[];
  staged: { changes: Array<{ key: string; name: string; value?: unknown; unset?: true }>; problem: string | null };
  machine: { agents: string[]; from: string; board: boolean; rows: SettingRow[] };
  release: { pinned: string | null };
  dirty: boolean;
  pr: { number: number; url: string; title: string } | null;
  problems: Problem[];
}

interface ReleaseData {
  installed: string | null;
  pinned: string | null;
  newest: string | null;
  newer: boolean;
  update: { state: "running" | "done" | "failed"; startedAt: string; output: string } | null;
  problems: Problem[];
}

interface Props {
  project: { id: string; name: string };
  get: <T>(path: string) => Promise<T>;
  post: Post;
  say: Say;
  open: (channel: string) => void;
  agents: LiveAgent[];
}

const UNREACHABLE: Problem = { code: "unreachable", message: "The server can't be reached.",
  fix: "Check that the web UI is still running on its machine, then reload the page." };

function isProblem(x: unknown): x is Problem {
  return typeof x === "object" && x !== null && "code" in x && "fix" in x && !("team" in x) && !("installed" in x) && !("canUpdate" in x);
}

function Notice({ p, tone = "bad" }: { p: Problem; tone?: "bad" | "quiet" }) {
  return (
    <div className={`notice ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <StatusDot state={tone === "bad" ? "red" : "idle"} /><div><strong>{p.message}</strong><p>{p.fix}</p></div>
    </div>
  );
}

/** The Factory settings tabs (Settings, Integrations, Releases and updates, Maintenance). */
export function SettingsTabs({ page, open }: { page: string; open: (channel: string) => void }) {
  return <Tabs label="Factory settings" value={page} onChange={(p) => open(channelOf(p))} tabs={SETTINGS_TABS.map((t) => ({ id: t.page, label: t.label }))} />;
}

/** Says how a change went: a toast, and the data read again. */
function useAct(p: Props, reload: () => void) {
  const [busy, setBusy] = useState(false);
  const act = useCallback(async (path: string, body: unknown, good: { title: string; text?: string }): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    const r = await p.post(`/api/projects/${encodeURIComponent(p.project.id)}/${path}`, body);
    setBusy(false);
    if (r.ok === true) p.say({ title: good.title, text: good.text ?? String(r.output ?? ""), tone: "good" });
    else p.say({ title: String(r.message ?? "It didn't run."), text: String(r.fix ?? ""), tone: "bad" });
    reload();
    return r.ok === true ? r : null;
  }, [p.post, p.say, p.project.id, reload]);
  return { busy, act };
}

// --- Settings -------------------------------------------------------------------------------------------------------------

export function SettingsPage(p: Props) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const base = `/api/projects/${encodeURIComponent(p.project.id)}/settings`;
  const load = useCallback(() => {
    p.get<SettingsData | Problem>(base).then((d) => {
      if (isProblem(d)) setProblem(d);
      else {
        setProblem(null);
        setData(d);
      }
    }).catch(() => setProblem(UNREACHABLE));
  }, [p.get, base]);
  useEffect(load, [load]);
  // this machine's checkout against main (#566): read apart, since it fetches main from GitHub
  const [checkout, setCheckout] = useState<CheckoutFacts | null>(null);
  const loadCheckout = useCallback(() => {
    p.get<CheckoutFacts | Problem>(`${base}/checkout`).then((d) => setCheckout(isProblem(d) ? null : d)).catch(() => setCheckout(null));
  }, [p.get, base]);
  useEffect(loadCheckout, [loadCheckout]);
  const reload = useCallback(() => {
    load();
    loadCheckout();
  }, [load, loadCheckout]);
  const { busy, act } = useAct(p, reload);
  const [ask, setAsk] = useState<{ spec: ConfirmSpec; run: () => Promise<unknown>; fix?: (c: Check) => void } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  if (!data) {
    return (
      <div className="body">
        <SettingsTabs page="settings" open={p.open} />
        {problem ? <Notice p={problem} /> : <p className="empty">Reading the settings…</p>}
      </div>
    );
  }
  const changes = data.staged.changes;
  const removeSpec = (name: string): ConfirmSpec => {
    const a = p.agents.find((x) => x.name === name);
    const role = data.team.agents.find((x) => x.name === name)?.role ?? "coding-agent";
    return removeAgentAsk({ name, role, running: !!a && a.state !== "down", here: a?.here ?? false, machineName: a?.machineName ?? null, task: a?.task ?? null });
  };
  const confirm = async (): Promise<void> => {
    if (removing) {
      const ok = await act(`settings/team/${encodeURIComponent(removing)}/remove`, { confirm: true }, { title: `${removing} leaves the team once you propose and merge it.` });
      if (ok) setRemoving(null);
      return;
    }
    if (!ask) return;
    await ask.run();
    setAsk(null);
  };
  const fixRemove = (c: Check): void => {
    if (!removing || !c.fix) return;
    const a = p.agents.find((x) => x.name === removing);
    if (c.fix.startsWith("Stop")) void act(`agents/${encodeURIComponent(removing)}/stop`, { confirm: true }, { title: `Stopped ${removing}.` });
    else if (a?.task) void act(`tasks/${encodeURIComponent(a.task)}/actions/release`, { confirm: true }, { title: `#${a.task} is back to Ready.` });
  };

  return (
    <div className="body settings">
      <SettingsTabs page="settings" open={p.open} />
      {problem && <Notice p={problem} />}
      {data.problems.map((x) => <Notice key={x.code} p={x} tone="quiet" />)}
      {data.pr && (
        <div className="notice" role="status">
          <StatusDot state="waiting" />
          <div><strong>A settings pull request is open: #{data.pr.number} {data.pr.title}</strong>
            <p>It changes the project once you merge it. Agents can't merge it: it changes their own rules.</p></div>
          <a className="btn small" href={/^https:\/\//.test(data.pr.url) ? data.pr.url : "#"} target="_blank" rel="noreferrer noopener">Open the pull request</a>
        </div>
      )}
      <TeamCard data={data} agents={p.agents} busy={busy} open={p.open}
        add={(name) => setAsk({ spec: addAgentAsk(name), run: () => act("settings/team", { name }, { title: `${name} is staged.`,
          text: "Propose the staged changes when you are ready." }) })}
        remove={(name) => setRemoving(name)} />
      <ProjectSettings data={data} busy={busy}
        stage={(key, raw) => act("settings/stage", { key, value: raw }, { title: "Staged.", text: "Propose the staged changes when you are ready." })}
        reset={(key) => act("settings/stage", { key, unset: true }, { title: "Staged: back to the default." })} />
      <MachineSettings data={data} busy={busy} checkout={checkout}
        sync={(c) => setAsk({ spec: syncAsk(c), run: () => act("settings/checkout", { confirm: true }, { title: "This machine is up to date." }) })}
        save={(key, raw) => act("settings/machine", { key, value: raw }, { title: "Saved for this machine." })}
        reset={(key) => act("settings/machine", { key, unset: true }, { title: "Back to the default on this machine." })} />
      <p className="hint">Agents can't change their own rules: a project change is a pull request only you merge. This machine's settings are kept
        outside the repository and save at once.</p>
      {changes.length > 0 && (
        <div className="staged-bar" role="region" aria-label="Staged changes">
          <StatusDot state="waiting" />
          <span className="staged-n">{stagedText(changes.length)}</span>
          <span className="staged-what">{changes.map((c) => c.name).join(", ")}.</span>
          <button className="btn small" disabled={busy} onClick={() => void act("settings/unstage", {}, { title: "Dropped the staged changes." })}>Drop all</button>
          <button className="btn small primary" disabled={busy}
            onClick={() => setAsk({ spec: proposeAsk(changes.length), run: () => act("settings/pr", { confirm: true }, { title: "Pull request opened." }) })}>
            Propose as a pull request</button>
        </div>
      )}
      {(ask || removing) && (
        <ConfirmDialog key={removing ?? ask?.spec.title} spec={removing ? removeSpec(removing) : (ask as { spec: ConfirmSpec }).spec} busy={busy}
          onConfirm={() => void confirm()} onCancel={() => { setAsk(null); setRemoving(null); }} onFix={fixRemove} />
      )}
    </div>
  );
}

function TeamCard({ data, agents, busy, add, remove, open }: { data: SettingsData; agents: LiveAgent[]; busy: boolean; add: (name: string) => void;
  remove: (name: string) => void; open: (channel: string) => void }) {
  const [name, setName] = useState("");
  const taken = useMemo(() => [...new Set([...data.team.agents.map((a) => a.name), ...Object.values(data.team.next).flat()])], [data]);
  const why = name ? nameProblem(name.trim(), taken) : null;
  const nextAll = Object.values(data.team.next).flat();
  const adds = (data.team.next["coding-agent"] ?? []).filter((n) => !data.team.agents.some((a) => a.name === n));
  return (
    <section className="card" aria-labelledby="team-h">
      <h3 id="team-h">Your team</h3>
      <ul className="lrows">
        {data.team.agents.map((a) => {
          const live = agents.find((x) => x.name === a.name);
          const leaving = !nextAll.includes(a.name);
          const running = !!live && live.state !== "down";
          return (
            <ListRow key={a.name} avatar={{ name: a.name, role: a.role }}
              title={<button className="link" onClick={() => open(`agent:${a.name}`)}>{a.name}</button>}
              sub={`${ROLE_TITLE[a.role] ?? a.role}${live?.task ? ` · holds #${live.task}` : ""}${leaving ? " · staged to leave" : ""}`}
              status={{ state: running ? "working" : "idle", text: running ? live?.state ?? "running" : "not running" }}
              action={leaving ? null : <button className="btn small" disabled={busy} onClick={() => remove(a.name)}>Remove</button>} />
          );
        })}
        {adds.map((n) => <ListRow key={n} avatar={{ name: n, role: "coding-agent" }} title={n} sub="Coding agent · staged to join"
          status={{ state: "waiting", text: "staged" }} />)}
      </ul>
      <form className="add-agent" onSubmit={(e) => { e.preventDefault(); if (!why && name.trim()) { add(name.trim()); setName(""); } }}>
        <label htmlFor="agent-name">Add a coding agent</label>
        {data.team.free.length > 0 && (
          <div className="chips" role="group" aria-label="Free names">
            {data.team.free.map((n) => (
              <button key={n} type="button" className="chip" aria-pressed={name === n} onClick={() => setName(n)}>
                <Avatar name={n} role="coding-agent" size={20} />{n}</button>
            ))}
          </div>
        )}
        <span className="add-row">
          <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pick a name above, or type one"
            aria-invalid={!!why} aria-describedby={why ? "agent-err" : undefined} />
          <button className="btn primary" type="submit" disabled={busy || !name.trim() || !!why}>Add</button>
        </span>
        {why && <span id="agent-err" className="send-problem">{why}</span>}
      </form>
    </section>
  );
}

function Editor({ row, busy, save, reset, cancel, saveLabel }: { row: SettingRow; busy: boolean; save: (raw: string) => Promise<unknown>;
  reset: () => Promise<unknown>; cancel: () => void; saveLabel: string }) {
  const field = fieldOf(row.kind);
  const start = row.staged && "value" in row.staged ? row.staged.value : row.value;
  const [text, setText] = useState(() => inputOf(row.kind, start));
  const id = `edit-${row.key.replace(/[^a-z0-9]/gi, "-")}`;
  let input: ReactNode;
  if (field === "toggle") {
    input = <select id={id} value={text} onChange={(e) => setText(e.target.value)}><option value="true">On</option><option value="false">Off</option></select>;
  } else if (field === "choice") {
    input = <select id={id} value={text} onChange={(e) => setText(e.target.value)}>{(row.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  } else if (field === "json") {
    input = <textarea id={id} rows={4} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />;
  } else input = <input id={id} type={field === "number" ? "number" : "text"} value={text} onChange={(e) => setText(e.target.value)} />;
  return (
    <div className="editor" role="group" aria-label={`Editing ${row.name}`}>
      <label htmlFor={id}>{row.name}</label>
      {input}
      <span className="hint">{row.help}{row.needs ? ` Needs ${row.needs}.` : ""} Default: {valueText(row.default)}.</span>
      <div className="actions">
        <button className="btn primary small" disabled={busy} onClick={() => void save(rawOf(row.kind, text)).then((ok) => { if (ok) cancel(); })}>{saveLabel}</button>
        {row.from !== "default" && <button className="btn small" disabled={busy} onClick={() => void reset().then((ok) => { if (ok) cancel(); })}>Back to the default</button>}
        <button className="btn plain small" onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
}

function Rows({ rows, busy, save, reset, saveLabel }: { rows: SettingRow[]; busy: boolean; save: (key: string, raw: string) => Promise<unknown>;
  reset: (key: string) => Promise<unknown>; saveLabel: string }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (!rows.length) return <p className="empty">No setting matches.</p>;
  return (
    <ul className="srows">
      {rows.map((r) => (
        <li key={r.key}>
          {editing === r.key ? (
            <Editor row={r} busy={busy} saveLabel={saveLabel} cancel={() => setEditing(null)} save={(raw) => save(r.key, raw)} reset={() => reset(r.key)} />
          ) : (
            <>
              <span className="srow-main"><span className="srow-name">{r.name}</span><span className="srow-help">{r.help}</span></span>
              <span className="srow-value">
                <span className="srow-v">{valueText(r.staged && "value" in r.staged ? r.staged.value : r.value)}</span>
                <span className="srow-from">{r.from === "staged" && <StatusDot state="waiting" />}{fromText(r)}</span>
              </span>
              <button className="btn small" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r.key)}>Edit</button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function ProjectSettings({ data, busy, stage, reset }: { data: SettingsData; busy: boolean; stage: (key: string, raw: string) => Promise<unknown>;
  reset: (key: string) => Promise<unknown> }) {
  const [section, setSection] = useState("main");
  const [q, setQ] = useState("");
  const all = data.sections.flatMap((s) => s.rows);
  const nav = [{ id: "main", title: "The main ones", rows: all.filter((r) => r.main) }, ...data.sections];
  const shown = q.trim() ? searchSettings(all, q) : nav.find((s) => s.id === section)?.rows ?? [];
  const title = q.trim() ? `Matching "${q.trim()}"` : nav.find((s) => s.id === section)?.title ?? "";
  return (
    <section className="card" aria-labelledby="proj-h">
      <h3 id="proj-h">Project settings</h3>
      <p className="muted card-text">Kept in the repository. A change is staged here, then proposed with the others as one pull request.</p>
      <div className="sgrid">
        <nav aria-label="Sections" className="snav">
          <input type="search" aria-label="Search settings" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} />
          {nav.map((s) => (
            <button key={s.id} className="nav-item" aria-current={!q.trim() && s.id === section ? "page" : undefined} onClick={() => { setQ(""); setSection(s.id); }}>
              <span className="name">{s.title}</span><span className="tab-count">{s.rows.length}</span>
            </button>
          ))}
        </nav>
        <div className="spane">
          <h4>{title}</h4>
          <Rows rows={shown} busy={busy} save={stage} reset={reset} saveLabel="Stage this change" />
        </div>
      </div>
    </section>
  );
}

function MachineSettings({ data, busy, save, reset, checkout, sync }: { data: SettingsData; busy: boolean;
  save: (key: string, raw: string) => Promise<unknown>; reset: (key: string) => Promise<unknown>; checkout: CheckoutFacts | null;
  sync: (c: CheckoutFacts) => void }) {
  const m = data.machine;
  return (
    <section className="card" aria-labelledby="machine-h">
      <h3 id="machine-h">This machine</h3>
      <p className="muted card-text">Kept on this machine only, outside the repository. A change saves at once.</p>
      <dl className="facts">
        <div><dt>Agents that run here</dt><dd>{machineAgentsText(m)}</dd></div>
        <div><dt>Message board</dt><dd><StatusDot state={m.board ? "working" : "idle"} />{m.board ? "Set for this machine" : "Not set on this machine"}</dd></div>
        <div><dt>The project's checkout</dt><dd>{checkout
          ? <><StatusDot state={checkout.problem ? "red" : checkout.canUpdate ? "waiting" : "idle"} />{checkoutText(checkout)}</>
          : "Reading main from GitHub…"}</dd></div>
      </dl>
      {checkout?.problem && <Notice p={checkout.problem} tone="quiet" />}
      {checkout && (
        <div className="actions row-actions">
          <button className="btn" disabled={busy} onClick={() => sync(checkout)}>Bring this machine up to date</button>
          <span className="hint">Settings merged on GitHub apply here once this checkout has them; a merge from these pages does it for you.</span>
        </div>
      )}
      {m.from === "env" && <p className="hint">The agents above come from the environment the web UI started in; a saved choice below applies the next time it starts without it.</p>}
      <Rows rows={m.rows} busy={busy} save={save} reset={reset} saveLabel="Save" />
    </section>
  );
}

// --- Releases and updates -------------------------------------------------------------------------------------------------

export function ReleasesPage(p: Props) {
  const [rel, setRel] = useState<ReleaseData | null>(null);
  const [facts, setFacts] = useState<{ pinned: string | null; dirty: boolean } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [asking, setAsking] = useState(false);
  const base = `/api/projects/${encodeURIComponent(p.project.id)}/settings`;
  const load = useCallback(() => {
    p.get<ReleaseData | Problem>(`${base}/release`).then((d) => (isProblem(d) ? setProblem(d) : (setProblem(null), setRel(d)))).catch(() => setProblem(UNREACHABLE));
    p.get<SettingsData | Problem>(base).then((d) => { if (!isProblem(d)) setFacts({ pinned: d.release.pinned, dirty: d.dirty }); }).catch(() => undefined);
  }, [p.get, base]);
  useEffect(load, [load]);
  const running = rel?.update?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => p.get<ReleaseData>(`${base}/release`).then(setRel).catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [running, p.get, base]);
  const { busy, act } = useAct(p, load);
  const working = p.agents.filter((a) => a.here && a.state === "working").map((a) => a.name);
  const spec = rel ? updateAsk({ installed: rel.installed, newest: rel.newest, newer: rel.newer, pinned: facts?.pinned ?? rel.pinned, dirty: facts?.dirty ?? false, working }) : null;
  const state = !rel ? "" : rel.newer ? `${rel.newest} available` : rel.installed ? "The newest" : "Not on releases";
  return (
    <div className="body">
      <SettingsTabs page="releases" open={p.open} />
      {problem && <Notice p={problem} />}
      {rel?.problems.map((x) => <Notice key={x.code} p={x} />)}
      {!rel && !problem && <p className="empty">Reading the versions…</p>}
      {rel && (
        <section className="card" aria-labelledby="ver-h">
          <h3 id="ver-h">This project</h3>
          <dl className="facts">
            <div><dt>Runs</dt><dd>{rel.installed ?? "Its own copy of the factory, not a release"}</dd></div>
            <div><dt>Main pins</dt><dd>{rel.pinned ?? "No release"}</dd></div>
            <div><dt>Newest release</dt><dd>{rel.newest ?? "Unknown"}</dd></div>
            <div><dt>State</dt><dd><StatusDot state={rel.newer ? "waiting" : "idle"} />{state}</dd></div>
          </dl>
          <div className="actions row-actions">
            <button className="btn" onClick={load} disabled={busy || running}>Check for a new release</button>
            {spec && <button className="btn primary" disabled={busy || running || !rel.newer} onClick={() => setAsking(true)}>{running ? "Updating…" : spec.action}</button>}
          </div>
          {rel.update && (
            <div className="update-run">
              <p><StatusDot state={rel.update.state === "failed" ? "down" : rel.update.state === "done" ? "working" : "waiting"} />
                {rel.update.state === "running" ? "The update is running on this machine." : rel.update.state === "done"
                  ? "The update finished. Its files are in this checkout, ready for a pull request that pins the release."
                  : "The update stopped; nothing half-done is left. What it said is below."}</p>
              {rel.update.output && <pre className="log">{rel.update.output}</pre>}
            </div>
          )}
          <p className="hint">Publishing a release is the owner's own step and isn't done here.</p>
        </section>
      )}
      {asking && spec && <ConfirmDialog spec={spec} busy={busy} onCancel={() => setAsking(false)}
        onConfirm={() => void act("settings/update", { confirm: true }, { title: "The update has started.", text: "This page shows how it goes." }).then(() => setAsking(false))} />}
    </div>
  );
}

// --- Maintenance ----------------------------------------------------------------------------------------------------------

export function MaintenancePage(p: Props) {
  const [out, setOut] = useState<{ id: string; text: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const { busy, act } = useAct(p, () => undefined);
  const run = async (id: string, preview: boolean): Promise<void> => {
    const r = await act(`settings/maintenance/${id}${preview ? "/preview" : ""}`, preview ? {} : { confirm: true },
      { title: preview ? "Here is what it would clean." : "Cleaned up.", text: "" });
    if (r) setOut({ id, text: String(r.output ?? "") || "Nothing to clean." });
  };
  const item = MAINTENANCE.find((m) => m.id === asking);
  return (
    <div className="body">
      <SettingsTabs page="maintenance" open={p.open} />
      <p className="muted">Housekeeping for {p.project.name} on this machine. Nothing changes until you confirm.</p>
      <ul className="lrows" aria-label="Clean up">
        {MAINTENANCE.map((m) => (
          <ListRow key={m.id} title={m.title} sub={<span className="mwill">{m.will} {m.wont}</span>}
            action={(
              <span className="row-actions">
                {m.preview && <button className="btn small" disabled={busy} onClick={() => void run(m.id, true)}>See what it would do</button>}
                <button className="btn small danger" disabled={busy} onClick={() => setAsking(m.id)}>{m.action}</button>
              </span>
            )} />
        ))}
      </ul>
      {out && <section className="card" aria-label="What it said"><h3>{MAINTENANCE.find((m) => m.id === out.id)?.title}</h3><pre className="log">{out.text}</pre></section>}
      <p className="hint">Releasing a task an agent left after a crash is on the board: open the task and choose Release.</p>
      {item && <ConfirmDialog spec={maintenanceAsk(item)} busy={busy} onCancel={() => setAsking(null)}
        onConfirm={() => void run(item.id, false).then(() => setAsking(null))} />}
    </div>
  );
}

export const SETTINGS_CSS = String.raw`
.settings .card-text { margin: -4px 0 14px; font-size: 13px; }
.settings .lrow button.link { border: 0; background: none; padding: 0; cursor: pointer; font-weight: 600; font-size: inherit; }
.add-agent { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; font-size: 13px; color: var(--text-2); }
.add-agent .chip { height: 36px; padding: 0 12px 0 6px; }
.add-row { display: flex; gap: 8px; max-width: 520px; }
.add-row input, .editor input, .editor select, .editor textarea, .snav input { min-width: 0; border: 1px solid var(--border-strong); border-radius: 10px;
  background: var(--surface); color: var(--text); font: inherit; padding: 0 12px; height: 44px; }
.add-row input { flex: 1; }
.editor textarea { height: auto; padding: 10px 12px; font: 13px/1.5 var(--mono); }
.sgrid { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
.snav { flex: 0 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.snav input { margin-bottom: 8px; width: 100%; }
.spane { flex: 1 1 420px; min-width: 0; }
.spane h4 { margin: 0 0 4px; font-size: 15px; }
.srows { list-style: none; margin: 0; padding: 0; }
.srows li { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.srow-main { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.srow-name { font-weight: 600; }
.srow-help { color: var(--text-2); font-size: 13px; }
.srow-value { flex: 0 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: right; }
.srow-v { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
.srow-from { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; color: var(--text-3); font-size: 12px; }
.editor { flex: 1; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.editor label { font-weight: 600; color: var(--text); }
.editor .actions, .row-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row-actions { margin-top: 16px; }
.lrow .row-actions { margin-top: 0; }
.staged-bar { position: sticky; bottom: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 12px 16px;
  border: 1.5px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); }
.staged-n { font-weight: 600; }
.staged-what { color: var(--text-2); font-size: 13px; flex: 1 1 200px; min-width: 0; }
.update-run { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
.update-run p { margin: 0; display: flex; align-items: center; gap: 8px; }
.mwill { white-space: normal; }
@media (max-width: 760px) {
  .srow-value { text-align: left; }
  .srow-from { justify-content: flex-start; }
  .lrow:has(.row-actions) { flex-wrap: wrap; }
}
`;
