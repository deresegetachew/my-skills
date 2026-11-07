// A pull request's page (#453), from the owner's design (docs/design/web-ui/PR.dc.html): its title, who opened it and its
// status; Overview (the description, read as a page, the checks and reviews, the protected files and who may merge it),
// Checks, Files (each diff, and a Markdown file read as a page too, so a PRD can be read) and Conversation (the comments,
// and the box to comment or ask for changes). Merge, Mark ready, Ask for changes, Comment and Close each ask first with
// their preconditions (pr_model.ts), then go through POST /api/projects/:p/pull-requests/:n/actions/:name. The page is
// read when it opens (GET .../pull-requests/:n), never on each poll. Nothing here shows a command.
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "./avatar_view.tsx";
import { type DocPage } from "./docs_model.ts";
import { MarkdownView } from "./docs.tsx";
import { PageHead } from "./page_head.tsx";
import { ConfirmDialog, StatusDot, Tabs } from "./parts.tsx";
import { askOf, checkDot, checkWord, diffLines, factsLine, fileWord, isMarkdownFile, mainAction, type PrAction, type PrFile, type PrPageData,
  statusOf } from "./pr_model.ts";
import type { Post, Say } from "./views.tsx";

interface Problem {
  code: string;
  message: string;
  fix: string;
}

interface Props {
  project: { id: string; name: string };
  number: string;
  /** Changes when the list sees a new head, new checks or a draft made ready: the page is asked again (from its cache
   *  while nothing changed). */
  rowKey: string;
  docs: DocPage[];
  get: <T>(path: string) => Promise<T>;
  post: Post;
  say: Say;
  open: (channel: string, find?: string) => void;
  onMenu: () => void;
  /** Opened from the Inbox's Merge (#458): ask first, with the preconditions, once the pull request is read. */
  askFirst?: "merge" | null;
}

type Tab = "overview" | "checks" | "files" | "conversation";

function Ext({ href, children }: { href: string | null; children: string }) {
  return href ? <a className="ext" href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <>{children}</>;
}

export function PrPage(p: Props) {
  const [pr, setPr] = useState<PrPageData | Problem | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [ask, setAsk] = useState<PrAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [again, setAgain] = useState(0);
  // after a merge here: why this machine's checkout was left as it is (#566), until the page is left
  const [leftAlone, setLeftAlone] = useState<Problem | null>(null);
  const base = `/api/projects/${encodeURIComponent(p.project.id)}/pull-requests/${encodeURIComponent(p.number)}`;
  const load = useCallback((fresh: boolean) => {
    p.get<PrPageData | Problem>(`${base}${fresh ? "?fresh=1" : ""}`).then(setPr)
      .catch(() => setPr({ code: "ui_unreachable", message: "The server can't be reached.", fix: "Check that the web UI still runs on its machine, then reload." }));
  }, [p.get, base]);
  useEffect(() => load(again > 0), [load, p.rowKey, again]);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !p.askFirst || !pr || !("number" in pr) || mainAction(pr) !== p.askFirst) return;
    asked.current = true;
    setAsk(p.askFirst);
  }, [pr, p.askFirst]);

  const back = <button className="link back" onClick={() => p.open("view:pull-requests")}>Pull requests</button>;
  if (!pr || !("number" in pr)) {
    return (
      <>
        <PageHead title={`#${p.number}`} onMenu={p.onMenu} before={<nav className="crumbs" aria-label="Breadcrumb">{back}<span aria-hidden="true">/</span><span>#{p.number}</span></nav>} />
        <div className="body">
          {!pr ? <p className="empty">Reading the pull request from GitHub…</p>
            : <div className="notice bad" role="alert"><StatusDot state="red" /><div><strong>{pr.message}</strong><p>{pr.fix}</p></div></div>}
        </div>
      </>
    );
  }

  const status = statusOf(pr);
  const first = mainAction(pr);
  const run = async (): Promise<void> => {
    if (!ask) return;
    setBusy(true);
    const r = await p.post(`${base}/actions/${ask}`, { confirm: true, head: pr.head, text: ask === "comment" || ask === "request-changes" || ask === "close" ? text : "" });
    setBusy(false);
    const done: Record<PrAction, string> = { merge: `Merged #${pr.number}.`, ready: `#${pr.number} is ready for review.`, comment: "Your comment is on it.",
      "request-changes": "Asked for changes.", close: `Closed #${pr.number}.` };
    if (r.ok === true) {
      p.say({ title: done[ask], text: String(r.output ?? "").split("\n").filter((l) => !l.startsWith("$ ")).join("\n").trim(), tone: "good" });
      if (ask !== "merge" && ask !== "ready") setText("");
      const co = r.checkout;
      const why = typeof co === "object" && co !== null ? (co as { problem?: unknown }).problem : null;
      if (ask === "merge") setLeftAlone(typeof why === "object" && why !== null && "fix" in why ? why as Problem : null);
    } else p.say({ title: String(r.message ?? "It didn't run."), text: String(r.fix ?? ""), tone: "bad" });
    setAsk(null);
    setAgain((n) => n + 1);
  };

  return (
    <>
      <PageHead onMenu={p.onMenu} title={<>#{pr.number} {pr.title}</>}
        before={<nav className="crumbs" aria-label="Breadcrumb">{back}<span aria-hidden="true">/</span><span>#{pr.number}</span></nav>}
        purpose={<span className="pr-facts">{pr.author.name && <Avatar name={pr.author.name} role={pr.author.role} size={24} />}{factsLine(pr)}</span>}
        actions={<>
          {first && <button className="btn primary" onClick={() => setAsk(first)}>{first === "ready" ? "Mark ready" : `Merge #${pr.number}`}</button>}
          {pr.url && <a className="btn" href={pr.url} target="_blank" rel="noreferrer noopener">Open on GitHub</a>}
        </>} />
      <div className="body pr-page">
        <p className="pr-status"><StatusDot state={status.needsYou ? "red" : "idle"} />{status.text}</p>
        {leftAlone && (
          <div className="notice" role="status">
            <StatusDot state="waiting" />
            <div><strong>Merged, but this machine's checkout wasn't brought up to date. {leftAlone.message}</strong><p>{leftAlone.fix}</p></div>
            <button className="btn small" onClick={() => p.open("page:settings")}>Factory settings</button>
          </div>
        )}
        <Tabs label="Pull request views" value={tab} onChange={setTab} tabs={[{ id: "overview", label: "Overview" },
          { id: "checks", label: "Checks", count: pr.checks.list.length }, { id: "files", label: "Files", count: pr.files.length },
          { id: "conversation", label: "Conversation", count: pr.comments.length }]} />
        {tab === "overview" && <Overview pr={pr} {...p} setTab={setTab} />}
        {tab === "checks" && <Checks pr={pr} open={p.open} />}
        {tab === "files" && <Files pr={pr} docs={p.docs} open={p.open} />}
        {tab === "conversation" && <Conversation pr={pr} text={text} setText={setText} ask={setAsk} />}
      </div>
      {ask && <ConfirmDialog key={ask} spec={askOf(ask, pr)} busy={busy} onConfirm={() => void run()} onCancel={() => setAsk(null)}
        onFix={(c) => { if (c.fix === "Mark ready") setAsk("ready"); }} />}
    </>
  );
}

function Overview({ pr, docs, open, setTab }: { pr: PrPageData; docs: DocPage[]; open: Props["open"]; setTab: (t: Tab) => void }) {
  return (
    <div className="pr-cols">
      <div className="pr-main">
        <section aria-labelledby="pr-desc">
          <h2 id="pr-desc">Description</h2>
          {pr.body.trim() ? <MarkdownView markdown={pr.body} from={`pr-${pr.number}`} pages={docs} open={open} label={`The description of #${pr.number}`} />
            : <p className="empty">No description.</p>}
        </section>
        <section aria-labelledby="pr-ck">
          <h2 id="pr-ck">Checks and reviews</h2>
          <ul className="pr-rows">
            {pr.checks.list.map((c) => <li key={c.name}><span className="grow">{c.name}</span><span className="pr-state"><StatusDot state={checkDot(c.state)} />{checkWord(c.state)}</span></li>)}
            {!pr.checks.list.length && <li><span className="grow muted">No checks have run on the latest commit.</span></li>}
            <li><span className="grow">Review</span><span className="pr-state"><StatusDot state={pr.review.state === "approved" ? "working" : pr.review.state === "changes-asked" ? "ink" : "idle"} />{pr.review.text}</span></li>
          </ul>
          <button className="link" onClick={() => setTab("checks")}>Every check and review ›</button>
        </section>
      </div>
      <aside className="pr-side" aria-labelledby="pr-prot">
        <h2 id="pr-prot">Protected files it changes</h2>
        {pr.protected.files.length ? <ul className="pr-rows">{pr.protected.files.map((f) => <li key={f} className="mono">{f}</li>)}</ul>
          : <p className="muted">None.</p>}
        <p className="muted">{pr.protected.personOnly ? `Only a person may merge it. ${pr.protected.why}` : pr.protected.why}</p>
        {pr.tasks.length > 0 && <>
          <h2>{pr.tasks.length > 1 ? "Its tasks" : "Its task"}</h2>
          <p>{pr.tasks.map((t) => <button key={t} className="link" onClick={() => open("view:tasks", `#${t}`)}>#{t} </button>)}</p>
        </>}
        <h2>Branch</h2>
        <p className="mono">{pr.branch} → {pr.base}</p>
      </aside>
    </div>
  );
}

function Checks({ pr, open }: { pr: PrPageData; open: Props["open"] }) {
  return (
    <div className="pr-main">
      <section aria-labelledby="pr-checks">
        <h2 id="pr-checks">Checks on {pr.head.slice(0, 7)}</h2>
        {!pr.checks.list.length ? <p className="empty">No checks have run on the latest commit yet.</p> : (
          <ul className="pr-rows">
            {pr.checks.list.map((c) => (
              <li key={c.name}>
                <span className="grow">{c.name}</span>
                <span className="pr-state"><StatusDot state={checkDot(c.state)} />{checkWord(c.state)}</span>
                <span className="pr-links">
                  <button className="link" onClick={() => open("view:ci", `#${pr.number}`)}>Log</button>
                  {c.url && <Ext href={c.url}>On GitHub</Ext>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="pr-reviews">
        <h2 id="pr-reviews">Reviews</h2>
        <ul className="pr-rows">
          {pr.review.markers.map((m, i) => (
            <li key={`m${i}`}><span className="grow">The factory's review by {m.by || "the dev manager"}: {m.kind === "approved" ? "approved" : m.kind === "changes-asked" ? "changes asked" : "reviewed"}</span>
              <span className="pr-state muted">{m.onHead ? "on the latest commit" : `on ${m.sha.slice(0, 7)}`}</span></li>
          ))}
          {pr.review.github.map((r, i) => (
            <li key={`g${i}`}><span className="grow">{r.by} on GitHub: {r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "asked for changes" : "commented"}</span>
              <span className="pr-state muted">{r.onHead ? "on the latest commit" : "on an earlier commit"}</span></li>
          ))}
          {!pr.review.markers.length && !pr.review.github.length && <li><span className="grow muted">Not reviewed yet.</span></li>}
        </ul>
      </section>
    </div>
  );
}

function FileView({ f, docs, open }: { f: PrFile; docs: DocPage[]; open: Props["open"] }) {
  const md = f.markdown !== null && isMarkdownFile(f.path);
  const [read, setRead] = useState(md);
  return (
    <li className="pr-file">
      <div className="pr-file-head">
        <span className="mono grow">{f.previous ? `${f.previous} → ` : ""}{f.path}</span>
        <span className="muted">{fileWord(f)}</span>
        {md && <span className="pr-toggle" role="group" aria-label={`Show ${f.path}`}>
          <button className="btn small" aria-pressed={read} onClick={() => setRead(true)}>Read</button>
          <button className="btn small" aria-pressed={!read} onClick={() => setRead(false)}>Changes</button>
        </span>}
      </div>
      {read && f.markdown !== null ? <div className="pr-md"><MarkdownView markdown={f.markdown} from={f.path} pages={docs} open={open} label={f.path} /></div>
        : f.patch === null ? <p className="empty">GitHub doesn't show this file's changes (it is binary or very large).</p>
        : (
          <pre className="pr-diff" aria-label={`Changes to ${f.path}`}>
            {diffLines(f.patch).map((l, i) => <span key={i} className={`dl ${l.kind}`}>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}{l.text}{"\n"}</span>)}
          </pre>
        )}
    </li>
  );
}

function Files({ pr, docs, open }: { pr: PrPageData; docs: DocPage[]; open: Props["open"] }) {
  return (
    <div className="pr-main">
      {!pr.files.length && <p className="empty">No files changed.</p>}
      <ul className="pr-files">{pr.files.map((f) => <FileView key={f.path} f={f} docs={docs} open={open} />)}</ul>
      {pr.filesMore && <p className="muted">It changes more files than shown here; open it on GitHub for the rest.</p>}
    </div>
  );
}

function Conversation({ pr, text, setText, ask }: { pr: PrPageData; text: string; setText: (t: string) => void; ask: (a: PrAction) => void }) {
  const open = pr.state === "open";
  return (
    <div className="pr-main">
      <ol className="pr-talk">
        {pr.comments.map((c, i) => (
          <li key={i}>
            <span className="pr-who">{c.by}{c.factory && <span className="tag quiet">factory</span>} · {new Date(c.at).toLocaleString()}</span>
            <p>{c.body}</p>
          </li>
        ))}
        {!pr.comments.length && <li className="empty">No comments yet.</li>}
      </ol>
      {open && (
        <form className="pr-say" onSubmit={(e) => { e.preventDefault(); if (text.trim()) ask("comment"); }}>
          <label htmlFor="pr-text">Your words</label>
          <textarea id="pr-text" rows={4} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={`What should ${pr.author.name ?? pr.author.text} know or change?`} />
          <span className="actions">
            <button className="btn" type="submit" disabled={!text.trim()}>Comment</button>
            <button className="btn primary" type="button" disabled={!text.trim()} onClick={() => ask("request-changes")}>Ask for changes</button>
            <span className="grow" />
            <button className="btn danger" type="button" onClick={() => ask("close")}>Close #{pr.number}</button>
          </span>
          <span className="muted">Close takes your words as its reason, if you wrote any.</span>
        </form>
      )}
    </div>
  );
}

export const PR_CSS = String.raw`
.crumbs { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--text-3); margin-bottom: 6px; }
.crumbs .link { color: var(--text-2); }
.pr-facts { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pr-status { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); margin: 0 0 12px; }
.pr-page h2 { font-size: 15px; margin: 0 0 8px; }
.pr-cols { display: flex; flex-wrap: wrap; gap: 48px; align-items: flex-start; margin-top: 20px; }
.pr-main { flex: 3 1 480px; min-width: 0; display: flex; flex-direction: column; gap: 28px; margin-top: 20px; }
.pr-cols .pr-main { margin-top: 0; }
.pr-side { flex: 2 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.pr-side h2 { margin-top: 12px; }
.pr-rows { list-style: none; margin: 0; padding: 0; }
.pr-rows li { display: flex; align-items: center; gap: 16px; padding: 10px 4px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; flex-wrap: wrap; }
.pr-rows .grow, .pr-file-head .grow { flex: 1; min-width: 0; }
.pr-state { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 13px; }
.pr-links { display: inline-flex; gap: 12px; font-size: 13px; }
.pr-files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 16px; }
.pr-file { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.pr-file-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 14px; background: var(--bg-subtle); border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
.pr-toggle { display: inline-flex; gap: 6px; }
.pr-toggle .btn[aria-pressed="true"] { background: var(--bg-active); font-weight: 600; }
.pr-md { padding: 4px 18px 12px; }
.pr-diff { margin: 0; padding: 8px 0; overflow-x: auto; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--surface); }
.pr-diff .dl { display: block; padding: 0 14px; white-space: pre; }
.pr-diff .dl.add { background: var(--green-fill); color: var(--green-ink); }
.pr-diff .dl.del { background: var(--red-fill); color: var(--red-ink); }
.pr-diff .dl.hunk { color: var(--text-3); }
.pr-diff .dl.note { color: var(--text-3); font-style: italic; }
.pr-talk { list-style: none; margin: 0; padding: 0; }
.pr-talk li { padding: 14px 4px; border-bottom: 1px solid var(--border); }
.pr-talk p { margin: 4px 0 0; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.pr-who { font-size: 13px; color: var(--text-3); display: inline-flex; gap: 6px; align-items: center; }
.pr-say { display: flex; flex-direction: column; gap: 8px; }
.pr-say textarea { font: inherit; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface); color: var(--text); resize: vertical; }
.pr-say .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.pr-say .grow { flex: 1; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
`;
