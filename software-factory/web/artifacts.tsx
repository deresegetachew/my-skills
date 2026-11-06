// Designs and artifacts (#454), from the owner's design (docs/design/web-ui/Artifacts.dc.html): a tab of "PRD and
// decisions", one row per reviewed copy with how it stands and one action, "Check for new versions", and "Add an
// artifact". Pulling a copy asks first (its preconditions, what happens and what doesn't), then opens a pull request on
// the machine that serves the page; nothing in the person's checkout changes. The rules are in artifacts_model.ts; the
// data and the pull go through GET /api/projects/:p/artifacts and POST .../artifacts/pull. Nothing here shows a command.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type Artifact, addAsk, headLine, pullAsk, rowsOf } from "./artifacts_model.ts";
import { PageHead, PlusIcon } from "./page_head.tsx";
import { ConfirmDialog, ListRow, StatusDot, Tabs } from "./parts.tsx";
import type { ConfirmSpec } from "./parts_model.ts";
import type { Post, Say } from "./views.tsx";

interface Problem {
  code: string;
  message: string;
  fix: string;
}

interface Copies {
  artifacts: Artifact[];
  fetch: boolean;
  problems: Problem[];
}

interface Props {
  project: { id: string; name: string };
  get: <T>(path: string) => Promise<T>;
  post: Post;
  say: Say;
  open: (channel: string) => void;
  onMenu: () => void;
}

function FileIcon() {
  return (
    <span className="aicon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M9 21V9" />
      </svg>
    </span>
  );
}

/** An https address, else "": the manifest and the cache are files, so their links are not trusted as they are. */
function safe(url: string | undefined): string {
  return url && /^https:\/\//i.test(url) ? url : "";
}

function Ext({ href, className, children }: { href: string; className?: string; children: string }) {
  return <a className={className} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

export function ArtifactsPage(p: Props) {
  const [data, setData] = useState<Copies | null>(null);
  const [reading, setReading] = useState(false);
  const [ask, setAsk] = useState<{ spec: ConfirmSpec; artifact: string; dest: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(p.project.id)}/artifacts`;
  const load = useCallback(() => {
    setReading(true);
    p.get<Copies>(base).then(setData).catch(() => setData({ artifacts: [], fetch: false, problems: [{ code: "unreachable",
      message: "The server can't be reached.", fix: "Check that the web UI is still running on its machine, then reload the page." }] }))
      .finally(() => setReading(false));
  }, [p.get, base]);
  useEffect(load, [load]);

  const list = data?.artifacts ?? [];
  const rows = rowsOf(list);
  const pull = async (): Promise<void> => {
    if (!ask) return;
    setBusy(true);
    const r = await p.post(`${base}/pull`, { artifact: ask.artifact, ...(ask.dest ? { dest: ask.dest } : {}), confirm: true });
    setBusy(false);
    setAsk(null);
    if (r.ok === true) {
      p.say({ title: "Pull request opened.", text: "The dev manager reviews the new copy; builders keep the current one until it merges.", tone: "good" });
      load();
    } else p.say({ title: String(r.message ?? "No pull request was opened."), text: String(r.fix ?? ""), tone: "bad" });
  };

  return (
    <>
      <PageHead title="Designs and artifacts" purpose={headLine(list)} onMenu={p.onMenu}
        actions={(
          <>
            <button className="btn" onClick={load} disabled={reading}>{reading ? "Checking…" : "Check for new versions"}</button>
            <button className="btn primary" onClick={() => setAdding(true)}><PlusIcon />Add an artifact</button>
          </>
        )} />
      <div className="body">
        <Tabs label="Documents" value="artifacts" onChange={(t) => { if (t === "docs") p.open("page:docs"); }}
          tabs={[{ id: "docs", label: "PRD and decisions" }, { id: "artifacts", label: "Designs and artifacts", ...(data ? { count: list.length } : {}) }]} />
        {data?.problems.map((x) => (
          <div key={x.code} className="notice bad" role="alert"><StatusDot state="red" /><div><strong>{x.message}</strong><p>{x.fix}</p></div></div>
        ))}
        {!data && <p className="empty">Reading the list of copies…</p>}
        {data && !data.problems.length && !list.length && (
          <p className="empty">Add a design so builders work from a reviewed copy, not a link that can change.</p>)}
        <ul className="lrows" aria-label="Designs and artifacts">
          {rows.map((r, i) => {
            const a = list[i] as Artifact;
            const pullable = r.action === "Pull new copy" || r.action === "Pull again";
            const url = safe(a.url);
            const pr = safe(a.review?.url);
            return (
              <ListRow key={r.id} lead={<FileIcon />} sub={r.sub} status={{ state: r.status.dot === "down" ? "ink" : r.status.dot, text: r.status.text }}
                title={url ? <Ext href={url} className="atitle">{r.name}</Ext> : r.name}
                action={pullable
                  ? <button className={`btn small${r.primary ? " primary" : ""}`} onClick={() => setAsk({ spec: pullAsk(a, data?.fetch ?? false), artifact: a.url || a.id, dest: a.dest })}>{r.action}</button>
                  : r.action === "Open the PR" ? (pr ? <Ext href={pr} className="btn small">{r.action}</Ext> : null)
                  : url ? <Ext href={url} className="btn small">{r.action}</Ext> : null} />
            );
          })}
        </ul>
        {data && list.length > 0 && !data.fetch && (
          <p className="empty">Fetching artifacts isn't set up for this project yet, so a new copy can't be pulled from here. Set it up in Integrations.</p>)}
      </div>
      {adding && <AddDialog close={() => setAdding(false)}
        next={(link, dest) => { setAdding(false); setAsk({ spec: addAsk(link, data?.fetch ?? false), artifact: link, dest }); }} />}
      {ask && <ConfirmDialog spec={ask.spec} busy={busy} onConfirm={() => void pull()} onCancel={() => setAsk(null)}
        onFix={() => { setAsk(null); p.open("page:integrations"); }} />}
    </>
  );
}

function AddDialog({ close, next }: { close: () => void; next: (link: string, dest: string) => void }) {
  const [link, setLink] = useState("");
  const [dest, setDest] = useState("");
  const okLink = /^[A-Za-z0-9][^\s]{0,299}$/.test(link.trim());
  const okDest = !dest.trim() || (/^[A-Za-z0-9_][\w./-]{0,199}$/.test(dest.trim()) && !dest.split("/").includes(".."));
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (okLink && okDest) next(link.trim(), dest.trim());
  };
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <form className="dialog sform" role="dialog" aria-modal="true" aria-labelledby="addart-h" onSubmit={submit}>
        <h2 id="addart-h">Add an artifact</h2>
        <p className="muted">A design, a PRD page or a diagram that builders should work from. A reviewed copy goes into the repo, so they read
          what was reviewed, not a link that can change.</p>
        <label>Its link
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://claude.ai/artifact/…" autoFocus />
        </label>
        <label>Folder in the repo (optional)
          <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="docs/artifacts/<its id>" />
          {!okDest && <span className="send-problem">Give a folder inside the project, such as docs/design/home.</span>}
        </label>
        <div className="actions">
          <button className="btn primary" type="submit" disabled={!okLink || !okDest}>Next</button>
          <button className="btn plain" type="button" onClick={close}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

export const ARTIFACTS_CSS = String.raw`
.aicon { width: 36px; height: 36px; border-radius: 10px; background: var(--bg-subtle); color: var(--text-2); display: flex; align-items: center;
  justify-content: center; margin-left: -2px; }
.lrow-who:has(.aicon) { width: 36px; }
a.atitle { color: var(--text); text-decoration: none; font-size: 15px; }
a.atitle:hover { text-decoration: underline; }
a.btn { text-decoration: none; }
`;
