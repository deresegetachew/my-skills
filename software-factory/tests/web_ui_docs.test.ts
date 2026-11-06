// The web UI's Docs section (#438): the PRD (the file `prd` names), the decisions folder (`decisions`) and the wiki, listed
// per project, read as pages, searched, and safe: only .md files inside those places are ever served. Run against the
// real server on a free port.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const PRD = "# PRD: the shop\n\n## 4. User stories\n\n- **US-1.** As a buyer, I pay by card.\n- **US-2.** As the owner, I refund an order.\n";

async function started(cfg: Row = CONFIG): Promise<{ ui: Running; d: string; root: string }> {
  const p = project(cfg);
  roots.push(p.root);
  write(join(p.d, "docs", "PRD.md"), PRD);
  write(join(p.d, "docs", "decisions", "0001-use-bun.md"), "# 0001: Use `Bun`\n\nWe use Bun. See [the PRD](../PRD.md).\n");
  write(join(p.d, "docs", "decisions", "0002-ports.md"), "# 0002: Ports and adapters\n\nA refund goes through a port.\n");
  write(join(p.d, "docs", "decisions", "notes.txt"), "not a page\n");
  const ui = await startUi(p);
  running.push(ui);
  return { ui, d: p.d, root: p.root };
}

const sections = (j: Row): Row[] => j.sections as Row[];
const pages = (s: Row | undefined): Row[] => (s?.pages as Row[]) ?? [];

test("the docs list: the PRD, the decisions in number order and the wiki, each page with an id, a plain title and its path", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/docs");
  expect(r.status).toBe(200);
  expect(sections(r.json).map((s) => s.id)).toEqual(["prd", "decisions", "wiki"]);
  const [prd, decisions, wiki] = sections(r.json);
  expect(pages(prd)).toEqual([{ id: "prd", title: "PRD: the shop", path: "docs/PRD.md" }]);
  expect(pages(decisions)).toEqual([
    { id: "decisions/0001-use-bun", title: "0001: Use Bun", path: "docs/decisions/0001-use-bun.md" },
    { id: "decisions/0002-ports", title: "0002: Ports and adapters", path: "docs/decisions/0002-ports.md" }]);
  expect(pages(wiki).length).toBeGreaterThan(5); // the factory's own wiki
  expect(pages(wiki).map((p) => p.id)).toContain("wiki/commands");
}, T);

test("a page is its Markdown, read as it is on disk", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/docs/page?id=decisions/0001-use-bun");
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ id: "decisions/0001-use-bun", title: "0001: Use Bun", path: "docs/decisions/0001-use-bun.md" });
  expect(r.json.markdown).toContain("See [the PRD](../PRD.md).");
  const prd = await api(ui, "/api/projects/work/docs/page?id=prd");
  expect(prd.json.markdown).toBe(PRD);
  const wiki = await api(ui, "/api/projects/work/docs/page?id=wiki/commands");
  expect(wiki.status).toBe(200);
  expect(String(wiki.json.markdown)).toContain("factory");
}, T);

test("the settings `prd` and `decisions` say where the PRD and the decisions are", async () => {
  const { ui, d } = await started({ ...CONFIG, prd: "spec/product.md", decisions: "adr" });
  write(join(d, "spec", "product.md"), "# The product\n");
  write(join(d, "adr", "0007-x.md"), "# 0007: X\n");
  const r = await api(ui, "/api/projects/work/docs");
  const [prd, decisions] = sections(r.json);
  expect(pages(prd)).toEqual([{ id: "prd", title: "The product", path: "spec/product.md" }]);
  expect(pages(decisions).map((p) => p.id)).toEqual(["decisions/0007-x"]);
}, T);

test("a missing PRD or decisions folder is a problem in its section {code, message, fix}, not an error", async () => {
  const { ui, d } = await started({ ...CONFIG, prd: "nope/PRD.md", decisions: "nope/adr" });
  rmSync(join(d, "docs"), { recursive: true });
  const r = await api(ui, "/api/projects/work/docs");
  expect(r.status).toBe(200);
  for (const s of sections(r.json).filter((x) => x.id !== "wiki")) {
    expect(pages(s)).toEqual([]);
    expect(Object.keys(s.problem as Row).sort()).toEqual(["code", "fix", "message"]);
  }
  const page = await api(ui, "/api/projects/work/docs/page?id=prd");
  expect(page.status).toBe(404);
  expect(page.json.code).toBe("doc_unknown");
}, T);

test("only listed pages are served: no path, no .., no file outside the folders, no link that leaves them", async () => {
  const { ui, d, root } = await started();
  write(join(root, "secret.md"), "# secret\n");
  symlinkSync(join(root, "secret.md"), join(d, "docs", "decisions", "0003-evil.md"));
  mkdirSync(join(d, "docs", "decisions", "sub"));
  const ids = ["../PRD", "decisions/../../../secret", "decisions/0003-evil", "decisions/notes", "decisions/sub", "docs/PRD.md", "wiki/../../x",
    "/etc/passwd", "decisions/0001-use-bun.md", "decisions%2F..%2F..%2Fsecret", ""];
  for (const id of ids) {
    const r = await api(ui, `/api/projects/work/docs/page?id=${encodeURIComponent(id)}`);
    expect([id, r.status, r.json.code]).toEqual([id, id === "" ? 400 : 404, id === "" ? "doc_id_missing" : "doc_unknown"]);
    expect(Object.keys(r.json).sort()).toEqual(["code", "fix", "message"]);
  }
  const list = await api(ui, "/api/projects/work/docs");
  expect(pages(sections(list.json)[1]).map((p) => p.id)).toEqual(["decisions/0001-use-bun", "decisions/0002-ports"]);
}, T);

test("search finds the lines that hold every word, in any case, in every page, and says which page and line", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/docs/search?q=REFUND%20order");
  expect(r.status).toBe(200);
  expect(r.json.hits).toEqual([{ id: "prd", title: "PRD: the shop", section: "PRD", line: 6, text: "- **US-2.** As the owner, I refund an order." }]);
  const two = (await api(ui, "/api/projects/work/docs/search?q=refund")).json.hits as Row[];
  expect(two.map((h) => h.id)).toEqual(["prd", "decisions/0002-ports"]);
  const title = (await api(ui, "/api/projects/work/docs/search?q=ports%20adapters")).json.hits as Row[];
  expect(title[0]).toMatchObject({ id: "decisions/0002-ports", line: 1 });
  expect((await api(ui, "/api/projects/work/docs/search?q=")).json.hits).toEqual([]);
  expect((await api(ui, "/api/projects/work/docs/search?q=zzzz-nothing")).json.hits).toEqual([]);
}, T);

test("the docs need the token, and an unknown project is 404", async () => {
  const { ui } = await started();
  for (const path of ["/docs", "/docs/page?id=prd", "/docs/search?q=a"]) {
    const r = await api(ui, `/api/projects/work${path}`, { token: null });
    expect([path, r.status]).toEqual([path, 401]);
  }
  expect((await api(ui, "/api/projects/nope/docs")).json.code).toBe("ui_project_unknown");
  expect((await api(ui, "/api/projects/work/docs", { method: "POST", body: {} })).status).toBe(405);
}, T);
