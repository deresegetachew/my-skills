// The integrations page (#441), under Factory settings in the sidebar: what the factory connects to, one row each (name,
// one grey line, a status dot, one action), as the owner's design has it (docs/design/web-ui/Integrations.dc.html).
// Configure opens the row's settings in plain words and, when it needs a fix, what is wrong and the step that fixes it.
// Test asks it now on the machine that serves the page; "Test all" asks every one that has a test.
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./avatar_view.tsx";
import type { Tone } from "./model.ts";
import { type IntegrationRow, type IntegrationsData, type IntegrationTab, integrationTabs, integrationTone, showRows, type UsesData,
  usesGrid } from "./integrations_model.ts";
import type { Say } from "./views.tsx";

/** The settings channels: the page's address after the project in the hash. */
export const INTEGRATIONS_CHANNEL = "settings:integrations";

type Get = <T>(path: string) => Promise<T>;
type Post = (path: string, body: unknown) => Promise<Record<string, unknown>>;

interface Tested {
  ok: boolean;
  message: string;
  fix: string;
}

function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot ${tone}`} aria-hidden="true" />;
}

type Action = IntegrationRow["actions"][number];

function Row({ it, open, toggle, testing, tested, test, ask }: { it: IntegrationRow; open: boolean; toggle: () => void; testing: boolean;
  tested: Tested | undefined; test: () => void; ask: (a: Action) => void }) {
  const detail = `int-${it.id}`;
  const start = it.state === "off" ? it.actions.find((a) => a.name === "start") : undefined; // off, and can start here: its one action
  const more = it.actions.filter((a) => a !== start);
  return (
    <li className="int-row">
      <div className="int-line">
        <div className="int-main">
          <span className="int-name">{it.name}</span>
          <span className="int-sub">{it.sub}</span>
        </div>
        <span className="int-state"><Dot tone={integrationTone(it.state)} />{testing ? "Testing…" : it.stateText}</span>
        <div className="int-actions">
          {it.testable && <button className="btn" onClick={test} disabled={testing}>Test</button>}
          {start ? <button className="btn" onClick={() => ask(start)}>{start.label}</button> : (
            <button className={it.state === "bad" ? "btn primary" : "btn"} aria-expanded={open} aria-controls={detail} onClick={toggle}>
              {it.state === "bad" ? "Fix" : it.state === "off" ? "Set up" : "Configure"}
            </button>
          )}
        </div>
      </div>
      {tested && (
        <p className={`int-tested ${tested.ok ? "good" : "bad"}`} role="status">
          <Dot tone={tested.ok ? "good" : "bad"} /><span>{tested.message}{tested.fix && <span className="int-fix"> {tested.fix}</span>}</span>
        </p>
      )}
      {open && (
        <div className="int-detail" id={detail}>
          {it.problem && (
            <div className="notice bad" role="alert"><Dot tone="bad" /><div><strong>{it.problem.message}</strong><p>{it.problem.fix}</p></div></div>
          )}
          <dl className="facts">
            {it.settings.map((s) => <div key={s.label}><dt>{s.label}</dt><dd>{s.value}</dd></div>)}
          </dl>
          {more.length > 0 && <div className="int-more">{more.map((a) => <button key={a.name} className="btn" onClick={() => ask(a)}>{a.label}</button>)}</div>}
          <p className="empty int-how">A change to these settings goes through a settings pull request that only you merge.</p>
        </div>
      )}
    </li>
  );
}

function Grid({ uses }: { uses: UsesData }) {
  const rows = usesGrid(uses);
  return (
    <section className="int-uses" aria-labelledby="int-uses-h">
      <h3 id="int-uses-h">What each agent may use</h3>
      <p className="int-sub">{uses.note}</p>
      {!uses.connectors.length || !rows.length ? <p className="empty">Nothing is set up for the agents to use yet.</p> : (
        <div className="int-scroll">
          <table className="int-grid">
            <thead><tr><th scope="col">Agent</th>{uses.connectors.map((c) => <th scope="col" key={c.id}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <th scope="row"><span className="int-agent"><Avatar name={r.name} size={28} /><span><b>{r.name}</b><small>{r.role}</small></span></span></th>
                  {r.cells.map((c) => (
                    <td key={c.id}><input type="checkbox" checked={c.on} disabled={!uses.perAgent} aria-label={c.label} readOnly /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function IntegrationsPage({ project, get, post, say }: { project: { id: string; name: string }; get: Get; post: Post; say: Say }) {
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [asking, setAsking] = useState<{ id: string; a: Action } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<IntegrationTab>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [tested, setTested] = useState<Record<string, Tested>>({});
  const base = `/api/projects/${encodeURIComponent(project.id)}/integrations`;

  const load = useCallback(() => {
    get<IntegrationsData>(base).then((d) => { setData(d); setFailed(false); }).catch(() => setFailed(true));
  }, [get, base]);
  useEffect(load, [load]);

  const test = async (id: string): Promise<void> => {
    setTesting((s) => new Set(s).add(id));
    const r = await post(`${base}/${encodeURIComponent(id)}/test`, {});
    setTested((t) => ({ ...t, [id]: { ok: r.ok === true, message: String(r.message ?? "No answer."), fix: r.ok === true ? "" : String(r.fix ?? "") } }));
    setTesting((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  };

  const act = async (id: string, a: Action): Promise<void> => {
    setBusy(true);
    try {
      const r = await post(`${base}/${encodeURIComponent(id)}/actions/${encodeURIComponent(a.name)}`, { confirm: true });
      say(r.ok === true ? { title: `${a.label}: done`, text: String(r.output ?? ""), tone: "good" }
        : { title: String(r.message ?? "It didn't run."), text: [r.fix, r.output].filter(Boolean).map(String).join("\n\n"), tone: "bad" });
    } finally {
      setBusy(false);
      setAsking(null);
      load();
    }
  };

  if (failed) return <div className="body"><p className="empty">The integrations of {project.name} can't be read. Is the page's server still running?</p></div>;
  if (!data) return <div className="body"><p className="empty">Reading {project.name}…</p></div>;
  const rows = showRows(data.integrations, tab);
  const testable = data.integrations.filter((i) => i.testable);
  return (
    <div className="body int">
      <div className="int-head">
        <p className="int-summary">{data.summary}</p>
        <button className="btn" disabled={!testable.length || testing.size > 0} onClick={() => { for (const i of testable) void test(i.id); }}>Test all</button>
      </div>
      <div role="tablist" aria-label="Filter" className="int-tabs">
        {integrationTabs(data.integrations).map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label} <span className="int-count">{t.count}</span></button>
        ))}
      </div>
      {rows.length ? (
        <ul className="int-list">
          {rows.map((it) => (
            <Row key={it.id} it={it} open={open === it.id} toggle={() => setOpen(open === it.id ? null : it.id)} testing={testing.has(it.id)}
              tested={tested[it.id]} test={() => void test(it.id)} ask={(a) => setAsking({ id: it.id, a })} />
          ))}
        </ul>
      ) : <p className="empty">{tab === "bad" ? "Nothing needs a fix." : "Everything is set up."}</p>}
      <Grid uses={data.uses} />
      {asking && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) setAsking(null); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="int-ask">
            <h3 id="int-ask">{asking.a.label}?</h3>
            <p>This {asking.a.does}.</p>
            <div className="actions">
              <button className="btn" onClick={() => setAsking(null)} disabled={busy} autoFocus>Cancel</button>
              <button className="btn primary" onClick={() => void act(asking.id, asking.a)} disabled={busy}>{busy ? "Working…" : asking.a.label}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const INTEGRATIONS_CSS = String.raw`
.int { max-width: 1100px; }
.int-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; justify-content: space-between; }
.int-summary { margin: 0; color: var(--muted); }
.int-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--line); }
.int-tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 0; cursor: pointer; color: var(--muted); margin-bottom: -1px; min-height: 44px; }
.int-tabs button[aria-selected="true"] { border-bottom-color: var(--text); color: var(--text); font-weight: 600; }
.int-count { color: var(--faint); font-weight: 400; }
.int-list { list-style: none; margin: 0; padding: 0; }
.int-row { border-bottom: 1px solid var(--line); padding: 14px 2px; }
.int-line { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.int-main { flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.int-name { font-weight: 600; font-size: 15px; }
.int-sub { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.int-state { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; width: 130px; flex: none; }
.int-actions { display: flex; gap: 8px; justify-content: flex-end; flex: none; }
.int-actions .btn { min-height: 40px; }
.int-tested { display: flex; gap: 8px; align-items: flex-start; margin: 10px 0 0; font-size: 13px; }
.int-tested .dot { margin-top: 6px; }
.int-fix { color: var(--muted); }
.int-detail { margin-top: 12px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius); }
.int-detail > * + * { margin-top: 12px; }
.int-how { font-size: 13px; margin-bottom: 0; }
.int-more { display: flex; gap: 8px; flex-wrap: wrap; }
.int-uses { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; }
.int-uses h3 { margin: 0; font-size: 15px; }
.int-scroll { overflow-x: auto; }
.int-grid { width: 100%; border-collapse: collapse; min-width: 480px; }
.int-grid th, .int-grid td { padding: 8px; border-bottom: 1px solid var(--line); font-size: 13px; }
.int-grid thead th { color: var(--faint); font-weight: 500; text-align: center; }
.int-grid thead th:first-child, .int-grid tbody th { text-align: left; padding-left: 2px; }
.int-grid tbody th { font-weight: 400; }
.int-grid td { text-align: center; }
.int-grid input { width: 18px; height: 18px; accent-color: var(--text); }
.int-agent { display: inline-flex; align-items: center; gap: 10px; }
.int-agent > span { display: flex; flex-direction: column; }
.int-agent small { color: var(--faint); font-size: 12px; }
@media (max-width: 760px) {
  .int-state { width: auto; }
  .int-actions { width: 100%; justify-content: flex-start; }
}
`;
