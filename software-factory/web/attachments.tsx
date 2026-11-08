// The Attachments section (#637) on a task's, a pull request's and a sign-off item's page: an image gallery (open one
// to see it large, zoom in and out, step with the arrows or the keys, on a desktop or a phone), video, test results
// (passed, failed, skipped and the failures), logs with search, and any other file as a download. The rules are in
// attachments_model.ts. The bytes are fetched with the page's own sign-in and shown from memory (blob: addresses), so no
// token is ever put in an address. Nothing an agent made is ever shown as a page here: an HTML report or an SVG is a
// download.
import { useCallback, useEffect, useRef, useState } from "react";
import { type AttachmentRow, countText, downloadWhy, groupsOf, listAddress, marks, resultLine, resultTone, searchLog, sizeText, step, whoLine,
  zoomedWidth, zoomStep } from "./attachments_model.ts";
import { StatusDot } from "./parts.tsx";
import { authHeaders } from "./signin_model.ts";

interface Problem {
  code: string;
  message: string;
  fix: string;
}

interface Props {
  project: string;
  /** `pr:12`, `task:b3`, `signoff:<id>` (attachments_model.ts targetParam). */
  target: string;
  /** For a pull request: its head, so attachments for an older head are marked. */
  head?: string | null;
  token: string;
  /** How many there are, for a tab's count. */
  onCount?: (n: number) => void;
  /** A second section's words ("On its epic"): shown only when it has something. */
  title?: string;
}

async function blobOf(token: string, path: string): Promise<Blob> {
  const r = await fetch(path, { headers: authHeaders(token) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.blob();
}

/** A blob: address for an attachment's bytes, made when it is first needed and let go when the section goes. */
function useBlobUrl(token: string, path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let gone = false;
    let made: string | null = null;
    blobOf(token, path).then((b) => {
      if (gone) return;
      made = URL.createObjectURL(b);
      setUrl(made);
    }).catch(() => {});
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [token, path]);
  return url;
}

/** Saves a file: fetched with the sign-in, then handed to the browser as a download under its own name. */
async function download(token: string, r: AttachmentRow): Promise<void> {
  const b = await blobOf(token, `${r.file}?download=1`);
  const url = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = url;
  a.download = r.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function Attachments({ project, target, head, token, onCount, title }: Props) {
  const [rows, setRows] = useState<AttachmentRow[] | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let gone = false;
    fetch(listAddress(project, target, head), { headers: authHeaders(token) })
      .then((r) => r.json() as Promise<{ attachments?: AttachmentRow[] } & Partial<Problem>>)
      .then((j) => {
        if (gone) return;
        if (Array.isArray(j.attachments)) {
          setRows(j.attachments);
          onCount?.(j.attachments.length);
        } else setProblem({ code: String(j.code ?? ""), message: String(j.message ?? "The attachments can't be read."), fix: String(j.fix ?? "") });
      })
      .catch(() => { if (!gone) setProblem({ code: "ui_unreachable", message: "The server can't be reached.", fix: "Check that the web UI still runs, then reload." }); });
    return () => {
      gone = true;
    };
  }, [project, target, head, token]);

  const heading = title ? `Attachments ${title.charAt(0).toLowerCase()}${title.slice(1)}` : "Attachments";
  if (problem) {
    // without a board there is nothing to show, and that isn't news on every page
    if (problem.code === "attachments_no_board" || title) return null;
    return <section className="attach" aria-label={heading}><h3 className="vgroup">{heading}</h3>
      <p className="empty">{problem.message} {problem.fix}</p></section>;
  }
  if (!rows) return title ? null : <section className="attach" aria-label={heading}><h3 className="vgroup">{heading}</h3><p className="empty">Reading the attachments…</p></section>;
  if (title && !rows.length) return null; // a second section (the epic's) only when it has something
  const g = groupsOf(rows);
  return (
    <section className="attach" aria-label={heading}>
      <h3 className="vgroup">{heading} <span className="muted">· {countText(rows)}</span></h3>
      {!rows.length && <p className="empty">Agents attach screenshots, test results and logs with board_attach or factory attach.</p>}
      {g.images.length > 0 && (
        <ul className="agallery" aria-label="Images">
          {g.images.map((r, i) => <Thumb key={r.id} r={r} token={token} onOpen={() => setOpen(i)} />)}
        </ul>
      )}
      {g.videos.map((r) => <Video key={r.id} r={r} token={token} />)}
      {g.results.map((r) => <Results key={r.id} r={r} token={token} />)}
      {g.logs.map((r) => <Log key={r.id} r={r} token={token} />)}
      {g.files.length > 0 && (
        <ul className="afiles" aria-label="Files">
          {g.files.map((r) => (
            <li key={r.id}>
              <span className="aname">{r.name}</span> <span className="muted">{sizeText(r.size)} · {whoLine(r)}</span>
              {downloadWhy(r) && <span className="muted"> · {downloadWhy(r)}</span>}
              {r.note && <p className="anote">{r.note}</p>}
              <button className="btn small" onClick={() => void download(token, r)}>Download</button>
            </li>
          ))}
        </ul>
      )}
      {open !== null && g.images[open] && (
        <Viewer rows={g.images} index={open} token={token} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}

function Thumb({ r, token, onOpen }: { r: AttachmentRow; token: string; onOpen: () => void }) {
  const url = useBlobUrl(token, r.file);
  return (
    <li className={r.old ? "old" : ""}>
      <button className="athumb" onClick={onOpen} aria-label={`Open ${r.name}`}>
        {url ? <img src={url} alt={r.note || r.name} loading="lazy" /> : <span className="muted">{r.name}</span>}
      </button>
      <p className="acap"><span className="aname">{r.name}</span><span className="muted">{whoLine(r)}</span></p>
    </li>
  );
}

/** One image large: fitted to the screen, then zoomed in steps up to 4 times (buttons, + and -, or a double tap);
 *  the arrows and the left and right keys step through the gallery; Escape or Close shuts it. */
function Viewer({ rows, index, token, onIndex, onClose }: { rows: AttachmentRow[]; index: number; token: string; onIndex: (i: number) => void; onClose: () => void }) {
  const r = rows[index] as AttachmentRow;
  const url = useBlobUrl(token, r.file);
  const [zoom, setZoom] = useState(1);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageBox = (): { w: number; h: number } => ({ w: (stageRef.current?.clientWidth ?? 0) - 16, h: (stageRef.current?.clientHeight ?? 0) - 16 });
  useEffect(() => {
    setZoom(1);
    setNat(null);
  }, [index]);
  useEffect(() => closeRef.current?.focus(), []);
  const go = useCallback((by: 1 | -1) => onIndex(step(index, rows.length, by)), [index, rows.length, onIndex]);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => zoomStep(z, 1));
      else if (e.key === "-") setZoom((z) => zoomStep(z, -1));
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [go, onClose]);
  return (
    <div className="overlay aviewer" data-theme="dark" role="dialog" aria-modal="true" aria-label={r.name} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="aview-bar">
        <span className="aname">{r.name} <span className="muted">{index + 1} of {rows.length} · {whoLine(r)}</span></span>
        <span className="aview-tools">
          <button className="btn small" onClick={() => setZoom((z) => zoomStep(z, -1))} aria-label="Zoom out" disabled={zoom <= 1}>−</button>
          <span className="muted" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button className="btn small" onClick={() => setZoom((z) => zoomStep(z, 1))} aria-label="Zoom in" disabled={zoom >= 4}>+</button>
          {rows.length > 1 && <button className="btn small" onClick={() => go(-1)} aria-label="Previous image">‹</button>}
          {rows.length > 1 && <button className="btn small" onClick={() => go(1)} aria-label="Next image">›</button>}
          <button ref={closeRef} className="btn small" onClick={onClose}>Close</button>
        </span>
      </div>
      <div className="aview-stage" ref={stageRef}>
        {url ? <img src={url} alt={r.note || r.name}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={zoom === 1 || !nat ? { maxWidth: "100%", maxHeight: "100%" } : { width: `${zoomedWidth(nat, stageBox(), zoom)}px`, maxWidth: "none", maxHeight: "none" }}
          onDoubleClick={() => setZoom((z) => (z >= 4 ? 1 : zoomStep(z, 1)))} />
          : <p className="empty">Loading…</p>}
      </div>
      {r.note && <p className="aview-note">{r.note}</p>}
    </div>
  );
}

function Video({ r, token }: { r: AttachmentRow; token: string }) {
  const [on, setOn] = useState(false);
  const url = useBlobUrl(token, on ? r.file : null);
  return (
    <div className={`arow${r.old ? " old" : ""}`}>
      <p><span className="aname">{r.name}</span> <span className="muted">{sizeText(r.size)} · {whoLine(r)}</span></p>
      {r.note && <p className="anote">{r.note}</p>}
      {on ? (url ? <video className="avideo" src={url} controls playsInline /> : <p className="empty">Loading…</p>)
        : <button className="btn small" onClick={() => setOn(true)}>Play</button>}
    </div>
  );
}

function Results({ r, token }: { r: AttachmentRow; token: string }) {
  const s = r.summary;
  return (
    <div className={`arow${r.old ? " old" : ""}`}>
      <p className="ahead"><StatusDot state={resultTone(s)} /><span className="aname">{r.name}</span> <span className="muted">{whoLine(r)}</span></p>
      <p className="ares">{resultLine(s)}</p>
      {r.note && <p className="anote">{r.note}</p>}
      {s?.ok && s.failures.length > 0 && (
        <ul className="afail" aria-label="Failures">
          {s.failures.map((f, i) => (
            <li key={i}>
              <details>
                <summary><strong>{f.classname ? `${f.classname} › ` : ""}{f.name}</strong>{f.message && <span className="muted"> · {f.message}</span>}</summary>
                {f.text && <pre className="alog">{f.text}</pre>}
              </details>
            </li>
          ))}
        </ul>
      )}
      <button className="btn small" onClick={() => void download(token, r)}>Download the report</button>
    </div>
  );
}

function Log({ r, token }: { r: AttachmentRow; token: string }) {
  const [text, setText] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [failed, setFailed] = useState(false);
  const show = (): void => {
    blobOf(token, r.file).then((b) => b.text()).then(setText).catch(() => setFailed(true));
  };
  const hits = text === null ? [] : searchLog(text, q);
  return (
    <div className={`arow${r.old ? " old" : ""}`}>
      <p><span className="aname">{r.name}</span> <span className="muted">{sizeText(r.size)} · {whoLine(r)}</span></p>
      {r.note && <p className="anote">{r.note}</p>}
      {text === null ? <span className="aactions">
        <button className="btn small" onClick={show}>Show the log</button>
        <button className="btn small" onClick={() => void download(token, r)}>Download</button>
        {failed && <span className="muted"> It can't be read now; try again.</span>}
      </span> : <>
        <input className="asearch" type="search" placeholder="Search the log" aria-label={`Search ${r.name}`} value={q} onChange={(e) => setQ(e.target.value)} />
        <p className="muted">{q.trim() ? `${hits.length} line${hits.length === 1 ? "" : "s"} with “${q.trim()}”` : `${hits.length} lines`}</p>
        <pre className="alog">{hits.map((h) => (
          <span key={h.n} className="aline"><span className="alno">{h.n}</span>{marks(h.line, q).map((m, i) => m.hit ? <mark key={i}>{m.text}</mark> : <span key={i}>{m.text}</span>)}{"\n"}</span>
        ))}</pre>
      </>}
    </div>
  );
}

export const ATTACH_CSS = String.raw`
.attach { margin-top: 20px; }
.attach .muted { color: var(--text-3); }
.agallery { list-style: none; margin: 8px 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.agallery li.old, .arow.old { opacity: .6; }
.athumb { display: block; width: 100%; aspect-ratio: 4 / 3; padding: 0; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-subtle);
  overflow: hidden; cursor: zoom-in; }
.athumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.acap { margin: 4px 0 0; display: flex; flex-direction: column; font-size: 13px; overflow-wrap: anywhere; }
.aname { font-weight: 600; overflow-wrap: anywhere; }
.anote { margin: 4px 0; color: var(--text-2); }
.arow { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 8px 0; background: var(--surface); }
.arow p { margin: 2px 0; }
.ares { font-variant-numeric: tabular-nums; }
.afail { list-style: none; margin: 6px 0; padding: 0; }
.afail li { border-top: 1px solid var(--border); padding: 6px 0; }
.afail summary { cursor: pointer; overflow-wrap: anywhere; }
.alog { max-height: 420px; overflow: auto; background: var(--bg-subtle); border-radius: 8px; padding: 8px; font: 12px/1.5 var(--mono); white-space: pre-wrap;
  overflow-wrap: anywhere; margin: 6px 0; }
.alno { display: inline-block; min-width: 4ch; margin-right: 1ch; color: var(--text-3); text-align: right; user-select: none; }
.alog mark { background: var(--yellow-dot); color: var(--text); border-radius: 2px; }
.asearch { width: 100%; max-width: 360px; margin: 6px 0 2px; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: 8px;
  background: var(--surface); color: var(--text); font: inherit; }
.aactions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.afiles { list-style: none; margin: 8px 0; padding: 0; }
.afiles li { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; border-top: 1px solid var(--border); padding: 8px 0; }
.afiles li .btn { margin-left: auto; }
.avideo { width: 100%; max-height: 70vh; border-radius: 8px; background: var(--bg-subtle); }
.aviewer { display: flex; flex-direction: column; place-items: stretch; padding: 0; background: var(--surface); color: var(--text); }
.aview-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding: 10px 16px; color: var(--text); }
.aview-bar .muted { color: var(--text-2); }
.aview-tools { display: flex; gap: 6px; align-items: center; }
.aview-tools .btn { min-width: 44px; min-height: 44px; }
.aview-stage { flex: 1; min-height: 0; overflow: auto; display: flex; padding: 8px; touch-action: pan-x pan-y pinch-zoom; }
.aview-stage img { display: block; margin: auto; object-fit: contain; cursor: zoom-in; }
.ahead { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.aview-note { color: var(--text); padding: 8px 16px 16px; margin: 0; }
@media (max-width: 640px) {
  .agallery { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .aview-bar { padding: 8px; }
  .afiles li .btn { margin-left: 0; }
}
`;
