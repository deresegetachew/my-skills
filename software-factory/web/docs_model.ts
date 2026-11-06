// The Docs section's rules (#438), with no React in it so they are tested on their own: Markdown read into blocks, the
// target of a link between pages, and the citations (`decision 0004`, `US-12`) in a task or a pull request that link
// straight to a page. Nothing here makes HTML: raw HTML in a page stays text, and only safe links are links.

export interface DocPage {
  id: string;
  title: string;
  path: string;
}

export interface DocSection {
  id: string;
  title: string;
  pages: DocPage[];
  problem: { code: string; message: string; fix: string } | null;
}

export type Inline = { text: string; href?: string } | { bold: string } | { code: string };

export interface Item {
  /** `us-12` for a PRD story (`- **US-12.** ...`), else null: the anchor a citation links to. */
  id: string | null;
  inlines: Inline[];
}

export type Block =
  | { type: "heading"; level: number; text: string; id: string }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; ordered: boolean; items: Item[] }
  | { type: "table"; head: string[]; rows: Inline[][][] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; inlines: Inline[] }
  | { type: "rule" };

/** A heading's anchor: its text in lower case, every run of other characters a dash ("4.5 The owner" is "4-5-the-owner"). */
export function headingId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** A link we make a link of: the web, a mail address, a page (relative) or an anchor. Anything with another scheme is not. */
function safeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|#)/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

function pushText(out: Inline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && "text" in last && last.href === undefined) last.text += text;
  else out.push({ text });
}

/** Inline code, bold and links in a line of text; the rest is text. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    pushText(out, line.slice(at, m.index));
    at = (m.index ?? 0) + m[0].length;
    if (m[1] !== undefined) out.push({ code: m[1] });
    else if (m[2] !== undefined) out.push({ bold: m[2] });
    else if (safeHref(m[4] as string)) out.push({ text: m[3] as string, href: m[4] as string });
    else pushText(out, m[3] as string);
  }
  pushText(out, line.slice(at));
  return out;
}

const LIST_ITEM = /^\s*([-*]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function plain(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").trim();
}

function startsBlock(line: string, next: string | undefined): boolean {
  return /^\s*(#{1,6}\s|```|>|(-{3,}|\*{3,})\s*$)/.test(line) || LIST_ITEM.test(line) || (TABLE_ROW.test(line) && next !== undefined && TABLE_RULE.test(next));
}

function itemOf(text: string): Item {
  const story = /^\*\*(US-\d+)\.?\*\*/i.exec(text);
  return { id: story ? (story[1] as string).toLowerCase() : null, inlines: parseInline(text) };
}

/** The blocks of a Markdown page. Lists are flat (an indented item is an item), and anything it doesn't know is a paragraph. */
export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const next = lines[i + 1];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*```\s*([\w-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i] as string); i++) body.push(lines[i] as string);
      i++;
      blocks.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const text = plain(heading[2] as string);
      blocks.push({ type: "heading", level: (heading[1] as string).length, text, id: headingId(text) });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (TABLE_ROW.test(line) && next !== undefined && TABLE_RULE.test(next)) {
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i] as string); i++) rows.push(cells(lines[i] as string).map(parseInline));
      blocks.push({ type: "table", head: cells(line).map(plain), rows });
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      const body: string[] = [];
      for (; i < lines.length && (lines[i] as string).trimStart().startsWith(">"); i++) body.push((lines[i] as string).replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", inlines: parseInline(body.join(" ")) });
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[1] as string);
      const items: Item[] = [];
      let text = "";
      const flush = (): void => {
        if (text) items.push(itemOf(text));
        text = "";
      };
      while (i < lines.length) {
        const here = lines[i] as string;
        const m = LIST_ITEM.exec(here);
        if (m && /\d/.test(m[1] as string) === ordered) {
          flush();
          text = m[2] as string;
        } else if (!here.trim()) {
          const ahead = lines.slice(i + 1).find((l) => l.trim());
          const am = ahead === undefined ? null : LIST_ITEM.exec(ahead);
          if (!am || /\d/.test(am[1] as string) !== ordered) break;
        } else if (m || startsBlock(here, lines[i + 1])) break;
        else text += ` ${here.trim()}`;
        i++;
      }
      flush();
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    for (; i < lines.length && (lines[i] as string).trim() && (body.length === 0 || !startsBlock(lines[i] as string, lines[i + 1])); i++) {
      body.push((lines[i] as string).trim());
    }
    blocks.push({ type: "paragraph", inlines: parseInline(body.join(" ")) });
  }
  return blocks;
}

export type LinkTarget = { kind: "page"; id: string; anchor: string } | { kind: "web"; url: string } | { kind: "none" };

function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** Where a link in page `fromId` goes: another page of the docs (found by its path), the web, or nowhere. */
export function linkTarget(fromId: string, href: string, pages: DocPage[]): LinkTarget {
  if (/^(https?:\/\/|mailto:)/i.test(href)) return { kind: "web", url: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "none" };
  const hash = href.indexOf("#");
  const anchor = hash < 0 ? "" : href.slice(hash + 1);
  const file = hash < 0 ? href : href.slice(0, hash);
  if (!file) return { kind: "page", id: fromId, anchor };
  const from = pages.find((p) => p.id === fromId);
  if (!from) return { kind: "none" };
  const dir = from.path.split("/").slice(0, -1).join("/");
  const path = normalize(file.startsWith("/") ? file : `${dir}/${file}`);
  const found = path === null ? undefined : pages.find((p) => normalize(p.path) === path);
  return found ? { kind: "page", id: found.id, anchor } : { kind: "none" };
}

export interface Cited {
  text: string;
  link?: { id: string; anchor: string };
}

const CITE = /\b(?:decision|ADR)\s+#?(\d{1,4})\b|\bUS-(\d+)\b/gi;

/** `text` in pieces: each decision (`decision 0004`, `ADR 5`) or PRD story (`US-12`) it cites that has a page is a piece with a link. */
export function citations(text: string, pages: DocPage[]): Cited[] {
  const out: Cited[] = [];
  let at = 0;
  const add = (t: string): void => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && !last.link) last.text += t;
    else out.push({ text: t });
  };
  for (const m of text.matchAll(CITE)) {
    const start = m.index ?? 0;
    let link: Cited["link"];
    if (m[1] !== undefined) {
      const n = Number(m[1]);
      const page = pages.find((p) => p.id.startsWith("decisions/") && Number(/^(\d+)/.exec(p.id.slice(10))?.[1]) === n);
      if (page) link = { id: page.id, anchor: "" };
    } else if (pages.some((p) => p.id === "prd")) link = { id: "prd", anchor: `us-${m[2]}` };
    if (!link) continue;
    add(text.slice(at, start));
    out.push({ text: m[0], link });
    at = start + m[0].length;
  }
  add(text.slice(at));
  return out.length ? out : [{ text }];
}
