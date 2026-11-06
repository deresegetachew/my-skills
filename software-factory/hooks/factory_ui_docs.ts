// The web UI's Docs section (#438): the PRD (the file `prd` in factory.json names), the decisions folder (`decisions`) and
// the factory's wiki, as pages the web app renders. Only Markdown files that are really inside those places are listed,
// and a page is served only when its id is in the list, so no path from a request is ever opened. Built-ins only.
//
//   GET /api/projects/:p/docs                  {sections: [{id, title, pages: [{id, title, path}], problem}]}
//   GET /api/projects/:p/docs/page?id=...      {id, title, path, markdown}
//   GET /api/projects/:p/docs/search?q=...     {hits: [{id, title, section, line, text}]}: lines holding every word
//
// Page ids: `prd`, `decisions/<file name without .md>`, `wiki/<file name without .md>`.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULTS } from "./factory_config.ts";
import type { Problem, UiProject } from "./factory_ui_data.ts";

export interface DocPage {
  id: string;
  title: string;
  path: string;
}

export interface DocSection {
  id: "prd" | "decisions" | "wiki";
  title: string;
  pages: DocPage[];
  problem: Problem | null;
}

export interface DocHit {
  id: string;
  title: string;
  section: string;
  line: number;
  text: string;
}

export interface DocReply {
  status: number;
  body: object;
}

const MAX_BYTES = 2_000_000;
const MAX_HITS = 50;
const STEM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The factory's own wiki: this file's `../docs/wiki`, with a link followed (the hooks may be linked into a project). */
function wikiDir(): string {
  return join(dirname(realpathSync(import.meta.path)), "..", "docs", "wiki");
}

function setting(p: UiProject, key: "prd" | "decisions"): string {
  const v = p.config?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : DEFAULTS[key];
}

/** The first `# ` heading as plain text (no code marks, bold or link syntax), else the file's name. */
export function titleOf(markdown: string, fallback: string): string {
  const m = /^# +(.+?)\s*#*\s*$/m.exec(markdown);
  const plain = (m?.[1] ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").trim();
  return plain || fallback;
}

/** The real path of `file` when it is a regular Markdown file whose real place is inside the real folder `root` (a link
 *  out is not), else null. Pages are read from that real path, so what was checked is what is read. */
function inside(root: string, file: string): string | null {
  try {
    const real = realpathSync(file);
    const rel = relative(root, real);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && real.endsWith(".md") && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function problem(code: string, message: string, fix: string): Problem {
  return { code, message, fix };
}

/** The file's text, or null when it can't be read or is over the cap. */
function textOf(file: string): string | null {
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    const raw = readFileSync(file);
    return raw.length > MAX_BYTES ? null : raw.toString("utf8");
  } catch {
    return null;
  }
}

/** A listed page, or null when it can't be read. One over the cap is listed by its file's name, and opening it says it
 *  is too big. */
function pageOf(id: string, file: string, shown: string, fallback: string): { page: DocPage; file: string } | null {
  try {
    if (statSync(file).size > MAX_BYTES) return { page: { id, title: fallback, path: shown }, file };
  } catch {
    return null;
  }
  const text = textOf(file);
  return text === null ? null : { page: { id, title: titleOf(text, fallback), path: shown }, file };
}

interface Listed {
  section: DocSection;
  files: Map<string, string>;
}

function listFolder(id: "decisions" | "wiki", title: string, dir: string, shownBase: string, root: string, missing: Problem): Listed {
  const files = new Map<string, string>();
  const pages: DocPage[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return { section: { id, title, pages, problem: missing }, files };
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const stem = name.slice(0, -3);
    const file = STEM.test(stem) ? inside(root, join(dir, name)) : null;
    if (!file) continue;
    const got = pageOf(`${id}/${stem}`, file, `${shownBase}/${name}`, stem);
    if (!got) continue;
    pages.push(got.page);
    files.set(got.page.id, file);
  }
  return { section: { id, title, pages, problem: null }, files };
}

function listAll(p: UiProject): Listed[] {
  let root = p.path;
  try {
    root = realpathSync(p.path);
  } catch {
    // an unreadable project folder: every section says so below
  }
  const out: Listed[] = [];
  const prdPath = setting(p, "prd");
  const prdFile = resolve(root, prdPath);
  const prdReal = inside(root, prdFile);
  const prd = new Map<string, string>();
  const prdPages: DocPage[] = [];
  let prdProblem: Problem | null = null;
  if (prdReal) {
    const got = pageOf("prd", prdReal, relative(root, prdFile).split(sep).join("/"), basename(prdFile, ".md"));
    if (got) {
      prdPages.push(got.page);
      prd.set("prd", prdReal);
    }
  }
  if (!prdPages.length) {
    prdProblem = problem("doc_prd_missing", `There is no PRD at ${prdPath}.`, "Write it there, or point `prd` in .claude/factory.json at it (`factory settings set prd <path>`).");
  }
  out.push({ section: { id: "prd", title: "PRD", pages: prdPages, problem: prdProblem }, files: prd });
  const decisions = setting(p, "decisions");
  const decisionsDir = resolve(root, decisions);
  out.push(listFolder("decisions", "Decisions", decisionsDir, relative(root, decisionsDir).split(sep).join("/"), root,
    problem("doc_decisions_missing", `There is no decisions folder at ${decisions}.`, "Make it there, or point `decisions` in .claude/factory.json at it (`factory settings set decisions <path>`).")));
  const wiki = wikiDir();
  let wikiRoot = wiki;
  try {
    wikiRoot = realpathSync(wiki);
  } catch {
    // no wiki next to the hooks: the section says so
  }
  out.push(listFolder("wiki", "Wiki", wiki, "docs/wiki", wikiRoot,
    problem("doc_wiki_missing", "The factory's wiki isn't next to its hooks.", "Run `factory update` to get the factory again.")));
  return out;
}

/** The project's docs, section by section. */
export function docsOf(p: UiProject): DocSection[] {
  return listAll(p).map((l) => l.section);
}

/** One page by id, or the 400/404 to answer. */
export function pageById(p: UiProject, id: string): DocReply {
  if (!id) {
    return { status: 400, body: problem("doc_id_missing", "Say which page: ?id=...", "GET /api/projects/:p/docs lists the ids.") };
  }
  for (const l of listAll(p)) {
    const file = l.files.get(id);
    const page = l.section.pages.find((x) => x.id === id);
    if (!file || !page) continue;
    const markdown = textOf(file);
    if (markdown === null) return { status: 413, body: problem("doc_too_big", `${page.path} is too big to show.`, "Open the file itself.") };
    return { status: 200, body: { ...page, markdown } };
  }
  return { status: 404, body: problem("doc_unknown", `There is no page ${id.slice(0, 80)}.`, "GET /api/projects/:p/docs lists the ids.") };
}

/** The lines that hold every word of `query` (any case), page by page, at most 50. */
export function searchDocs(p: UiProject, query: string): DocHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: DocHit[] = [];
  for (const l of listAll(p)) {
    for (const page of l.section.pages) {
      const text = textOf(l.files.get(page.id) ?? "");
      if (text === null) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        const low = line.toLowerCase();
        if (!words.every((w) => low.includes(w))) continue;
        hits.push({ id: page.id, title: page.title, section: l.section.title, line: i + 1, text: line.trim().slice(0, 200) });
        if (hits.length >= MAX_HITS) return hits;
      }
    }
  }
  return hits;
}
