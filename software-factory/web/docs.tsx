// The web app's Docs section (#438): the PRD, the decisions and the wiki of each project as readable pages (headings, tables,
// links between them), and the citations in a task or a pull request that link straight to a page. The rules are in
// docs_model.ts; the server (factory_ui_docs.ts) only sends Markdown, which is turned into elements here, never into HTML.
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { type Block, citations, type DocPage, type DocSection, type Inline, linkTarget, parseMarkdown } from "./docs_model.ts";

export type Get = <T>(path: string) => Promise<T>;

/** The channel a page opens in: `doc:<id>` and, to land on a heading or a story, `#<anchor>`. */
export function docChannel(id: string, anchor = ""): string {
  return anchor ? `doc:${id}#${anchor}` : `doc:${id}`;
}

export function parseDocChannel(channel: string): { id: string; anchor: string } | null {
  if (!channel.startsWith("doc:")) return null;
  const rest = channel.slice(4);
  const hash = rest.indexOf("#");
  return hash < 0 ? { id: rest, anchor: "" } : { id: rest.slice(0, hash), anchor: rest.slice(hash + 1) };
}

export function pagesOf(sections: DocSection[] | undefined): DocPage[] {
  return (sections ?? []).flatMap((s) => s.pages);
}

interface Open {
  (channel: string): void;
}

/** `text` with each decision or PRD story it cites turned into a link to that page. */
export function Cited({ text, docs, open }: { text: string; docs: DocPage[] | undefined; open: Open }) {
  if (!docs?.length) return <>{text}</>;
  return (
    <>
      {citations(text, docs).map((c, i) => c.link
        ? <button key={i} className="link doclink" title="Open it in the docs" onClick={() => open(docChannel(c.link?.id ?? "", c.link?.anchor))}>{c.text}</button>
        : <Fragment key={i}>{c.text}</Fragment>)}
    </>
  );
}

function Inlines({ list, from, pages, open }: { list: Inline[]; from: string; pages: DocPage[]; open: Open }): ReactNode {
  return list.map((n, i) => {
    if ("bold" in n) return <strong key={i}>{n.bold}</strong>;
    if ("code" in n) return <code key={i}>{n.code}</code>;
    if (n.href === undefined) return <Fragment key={i}>{n.text}</Fragment>;
    const t = linkTarget(from, n.href, pages);
    if (t.kind === "web") return <a key={i} className="ext" href={t.url} target="_blank" rel="noreferrer noopener">{n.text}</a>;
    if (t.kind === "page") return <button key={i} className="link" onClick={() => open(docChannel(t.id, t.anchor))}>{n.text}</button>;
    return <Fragment key={i}>{n.text}</Fragment>;
  });
}

function BlockView({ b, from, pages, open }: { b: Block; from: string; pages: DocPage[]; open: Open }) {
  const inl = (list: Inline[]): ReactNode => <Inlines list={list} from={from} pages={pages} open={open} />;
  switch (b.type) {
    case "heading": {
      const Tag = `h${Math.min(b.level + 1, 6)}` as "h2";
      return <Tag id={`doc-${b.id}`} className="dochead">{b.text}</Tag>;
    }
    case "paragraph": return <p>{inl(b.inlines)}</p>;
    case "quote": return <blockquote>{inl(b.inlines)}</blockquote>;
    case "rule": return <hr />;
    case "code": return <pre className="doccode"><code>{b.text}</code></pre>;
    case "list": {
      const items = b.items.map((it, i) => <li key={i} id={it.id ? `doc-${it.id}` : undefined}>{inl(it.inlines)}</li>);
      return b.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "table": return (
      <div className="doctable" role="region" tabIndex={0} aria-label="Table">
        <table>
          <thead><tr>{b.head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inl(c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
}

interface PageData {
  id: string;
  title: string;
  path: string;
  markdown: string;
}

/** One page of the docs, with a way back to the list on a phone. */
export function DocPageView({ project, id, anchor, get, pages, open }: { project: string; id: string; anchor: string; get: Get; pages: DocPage[]; open: Open }) {
  const [page, setPage] = useState<PageData | { code: string; message: string; fix: string } | null>(null);
  useEffect(() => {
    let gone = false;
    setPage(null);
    get<PageData | { code: string; message: string; fix: string }>(`/api/projects/${encodeURIComponent(project)}/docs/page?id=${encodeURIComponent(id)}`)
      .then((p) => { if (!gone) setPage(p); })
      .catch(() => { if (!gone) setPage({ code: "ui_unreachable", message: "The server can't be reached.", fix: "Is `factory ui` still running?" }); });
    return () => { gone = true; };
  }, [project, id, get]);
  const blocks = page && "markdown" in page ? parseMarkdown(page.markdown) : [];
  useEffect(() => {
    if (anchor && page && "markdown" in page) document.getElementById(`doc-${anchor}`)?.scrollIntoView();
  }, [page, anchor]);
  if (!page) return <div className="body"><p className="empty">Reading the page…</p></div>;
  if (!("markdown" in page)) {
    return <div className="body"><div className="notice bad" role="alert"><div><strong>{page.message}</strong><p>{page.fix}</p></div></div></div>;
  }
  return (
    <div className="body">
      <article className="doc" aria-label={page.title}>
        <p className="docpath">{page.path}</p>
        {blocks.map((b, i) => <BlockView key={i} b={b} from={id} pages={pages} open={open} />)}
      </article>
    </div>
  );
}

export interface DocHit {
  id: string;
  title: string;
  section: string;
  line: number;
  text: string;
}

export const DOCS_CSS = `
.doc { max-width: 78ch; line-height: 1.6; overflow-wrap: anywhere; }
.doc h2, .doc h3, .doc h4, .doc h5, .doc h6 { line-height: 1.25; margin: 1.6em 0 .5em; scroll-margin-top: 12px; }
.doc h2 { font-size: 1.5rem; margin-top: .4em; }
.doc li { margin: .25em 0; scroll-margin-top: 12px; }
.doc li:target, .doc :target { background: color-mix(in srgb, currentColor 8%, transparent); }
.doc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; padding: .1em .3em; border-radius: 4px; background: color-mix(in srgb, currentColor 8%, transparent); }
.doc .doccode { overflow-x: auto; padding: 12px 14px; border-radius: 8px; background: color-mix(in srgb, currentColor 7%, transparent); }
.doc .doccode code { padding: 0; background: none; }
.doc blockquote { margin: 1em 0; padding: .1em 1em; border-left: 3px solid color-mix(in srgb, currentColor 25%, transparent); opacity: .85; }
.doc .doctable { overflow-x: auto; margin: 1em 0; }
.doc table { border-collapse: collapse; min-width: 100%; font-size: .93em; }
.doc th, .doc td { text-align: left; vertical-align: top; padding: 6px 10px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
.doc th { background: color-mix(in srgb, currentColor 7%, transparent); }
.docpath { font-size: .8rem; opacity: .65; font-family: ui-monospace, monospace; margin: 0 0 8px; }
.docs-pages { display: flex; flex-direction: column; }
.docs-sec > summary { cursor: pointer; padding: 4px 12px; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; opacity: .75; }
.doclink { text-decoration: underline; }
`;
