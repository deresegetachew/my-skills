// The web app's integrations page (#441), under Factory settings: what the factory connects to (GitHub, the messaging
// hub, the CI runners, the build cache, the plugins and the MCP connectors), each with its state, one line, the fix when
// it needs one, and a Test button that runs a read-only check on the machine that serves the page. Its rules are in
// integrations_model.ts; the data is GET /api/projects/:p/integrations (factory_ui_integrations.ts).
import { useCallback, useEffect, useState } from "react";
import { type IntegrationRow, rowsFor, stateTone, summary, type TabId, tabsOf } from "./integrations_model.ts";
import type { Tone } from "./model.ts";

/** The channel id the page has in the address (#/<project>/settings:integrations). */
export const INTEGRATIONS_CHANNEL = "settings:integrations";

type Get = <T>(path: string) => Promise<T>;
type Post = (path: string, body: unknown) => Promise<Record<string, unknown>>;

interface Problem {
  code: string;
  message: string;
  fix: string;
}

interface Result {
  ok: boolean;
  title: string;
  text: string;
}

function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`dot ${tone}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

function resultOf(r: Record<string, unknown>): Result {
  const output = typeof r.output === "string" ? r.output : "";
  if (r.ok === true) return { ok: true, title: "It works.", text: output };
  return { ok: false, title: String(r.message ?? "The test didn't run."), text: [r.fix, output].filter(Boolean).join("\n\n") };
}

function Row({ r, testing, result, onTest, open }: { r: IntegrationRow; testing: boolean; result: Result | undefined; onTest: () => void;
  open: (channel: string) => void }) {
  return (
    <li className="irow">
      <div className="imain">
        <span className="iname">{r.name}</span>
        <span className="isub">{r.sub}</span>
        {r.fix && <span className="isub ifix">{r.fix}</span>}
        {testing && <span className="isub" role="status">Testing…</span>}
        {!testing && result && (
          <div className={`notice ${result.ok ? "good" : "bad"} iresult`} role={result.ok ? "status" : "alert"}>
            <Dot tone={result.ok ? "good" : "bad"} />
            <div><strong>{result.title}</strong>{result.text && <pre>{result.text}</pre>}</div>
          </div>
        )}
      </div>
      <span className="istate"><Dot tone={stateTone(r.state)} />{r.stateText}</span>
      <span className="iact">
        {r.id === "ci" && <button className="btn" onClick={() => open("view:ci")}>Open CI</button>}
        {r.test && <button className={r.state === "needs-fix" ? "btn primary" : "btn"} onClick={onTest} disabled={testing}>Test</button>}
      </span>
    </li>
  );
}

export function IntegrationsPage({ project, get, post, open }: { project: { id: string; name: string }; get: Get; post: Post;
  open: (channel: string) => void }) {
  const base = `/api/projects/${encodeURIComponent(project.id)}/integrations`;
  const [rows, setRows] = useState<IntegrationRow[] | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<TabId>("all");
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, Result>>({});

  const load = useCallback(() => {
    get<{ integrations?: IntegrationRow[]; problems?: Problem[] }>(base)
      .then((r) => {
        setRows(r.integrations ?? []);
        setProblems(r.problems ?? []);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [get, base]);
  useEffect(load, [load]);

  const test = useCallback(async (id: string): Promise<void> => {
    setTesting((s) => new Set(s).add(id));
    const r = await post(`${base}/${encodeURIComponent(id)}/test`, {});
    setResults((before) => ({ ...before, [id]: resultOf(r) }));
    setTesting((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, [post, base]);

  const testAll = async (): Promise<void> => {
    for (const r of rows ?? []) if (r.test) await test(r.id);
    load();
  };

  if (failed) {
    return (
      <div className="body">
        <div className="notice bad" role="alert"><Dot tone="bad" /><div><strong>The integrations can't be read.</strong>
          <p>Is <code>factory ui</code> still running? <button className="link" onClick={load}>Try again</button></p></div></div>
      </div>
    );
  }
  if (!rows) return <div className="body"><p className="empty">Reading {project.name}…</p></div>;
  const shown = rowsFor(rows, tab);
  return (
    <div className="body integrations">
      <div className="ihead">
        <p className="vnote">{summary(rows)}</p>
        <button className="btn" onClick={() => void testAll()} disabled={testing.size > 0 || !rows.some((r) => r.test)}>Test all</button>
      </div>
      {problems.map((p) => (
        <div key={p.code} className="notice bad" role="alert"><Dot tone="bad" /><div><strong>{p.message}</strong><p>{p.fix}</p></div></div>
      ))}
      <div className="itabs" role="tablist" aria-label="Filter">
        {tabsOf(rows).map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} onClick={() => setTab(t.id)}>{t.label} {t.count}</button>
        ))}
      </div>
      {shown.length ? (
        <ul className="ilist" aria-label="Integrations">
          {shown.map((r) => <Row key={r.id} r={r} testing={testing.has(r.id)} result={results[r.id]} onTest={() => void test(r.id)} open={open} />)}
        </ul>
      ) : <p className="empty">Nothing here.</p>}
      <p className="vnote">Which agent may use which of these comes next: a change to it will become a settings pull request that only you merge.</p>
    </div>
  );
}

export const INTEGRATIONS_CSS = String.raw`
.integrations { max-width: 1100px; }
.ihead { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.itabs { display: flex; gap: 28px; border-bottom: 1px solid var(--line); }
.itabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 0; margin-bottom: -1px; font: inherit;
  color: var(--muted); cursor: pointer; min-height: 44px; }
.itabs button[aria-selected="true"] { border-bottom-color: var(--text); color: var(--text); font-weight: 600; }
.ilist { list-style: none; margin: 0; padding: 0; }
.irow { display: grid; grid-template-columns: 1fr 150px auto; gap: 16px; align-items: center; padding: 16px 4px; border-bottom: 1px solid var(--line); }
.imain { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.iname { font-weight: 600; font-size: 15px; }
.isub { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.ifix { color: var(--text); }
.istate { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.iact { display: flex; gap: 8px; justify-content: flex-end; }
.iact .btn { min-height: 40px; }
.iresult { margin-top: 6px; }
.notice.good { border-color: color-mix(in srgb, var(--good) 45%, transparent); background: color-mix(in srgb, var(--good) 8%, var(--bg)); }
.iresult pre { white-space: pre-wrap; max-height: 240px; overflow: auto; margin: 6px 0 0; font-size: 12px; }
@media (max-width: 760px) {
  .irow { grid-template-columns: 1fr; gap: 8px; }
  .iact { justify-content: flex-start; }
}
`;
