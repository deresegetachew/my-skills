// The integrations page (#441), under Factory settings in the sidebar: what the factory connects to, one row each (name,
// one grey line, a status dot, one action), as the owner's design has it (docs/design/web-ui/Integrations.dc.html).
// Configure opens the row's settings in plain words and, when it needs a fix, what is wrong and the step that fixes it.
// Test asks it now on the machine that serves the page; "Test all" asks every one that has a test.
import { useCallback, useEffect, useState } from "react";
import type { Tone } from "./model.ts";
import { type IntegrationRow, type IntegrationsData, type IntegrationTab, integrationTabs, integrationTone, showRows } from "./integrations_model.ts";

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

function Row({ it, open, toggle, testing, tested, test }: { it: IntegrationRow; open: boolean; toggle: () => void; testing: boolean;
  tested: Tested | undefined; test: () => void }) {
  const detail = `int-${it.id}`;
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
          <button className={it.state === "bad" ? "btn primary" : "btn"} aria-expanded={open} aria-controls={detail} onClick={toggle}>
            {it.state === "bad" ? "Fix" : it.state === "off" ? "Set up" : "Configure"}
          </button>
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
          <p className="empty int-how">A change here goes through a settings pull request that only you merge.</p>
        </div>
      )}
    </li>
  );
}

export function IntegrationsPage({ project, get, post }: { project: { id: string; name: string }; get: Get; post: Post }) {
  const [data, setData] = useState<IntegrationsData | null>(null);
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
              tested={tested[it.id]} test={() => void test(it.id)} />
          ))}
        </ul>
      ) : <p className="empty">{tab === "bad" ? "Nothing needs a fix." : "Everything is set up."}</p>}
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
@media (max-width: 760px) {
  .int-state { width: auto; }
  .int-actions { width: 100%; justify-content: flex-start; }
}
`;
