// The web UI's attachments (#637): GET /api/projects/:p/attachments lists a target's files (a pull request's marked old
// for another head, a JUnit report with its summary), and GET .../attachments/:id/file serves the bytes as untrusted:
// the type worked out again from the name and the first bytes, nosniff, a sandbox policy, inline only for images and
// video, everything else (SVG and HTML included) a download. Both sit behind the same token as the API, ids and targets
// are checked, and bytes attached from another machine move from the board into the hub's store on the first read.
// A real Postgres (board_pg.ts) and the real server (startUi).
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { attach, type Attachment, Board, DEFAULT_LIMITS } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { api, CONFIG, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { sh, write } from "./support.ts";

setDefaultTimeout(120_000);

const REPO = "acme/shop";
const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JUNIT = `<testsuite name="cart" tests="3"><testcase name="adds"/><testcase name="skips"><skipped/></testcase>
<testcase classname="cart" name="pays"><error message="boom">trace</error></testcase></testsuite>`;

let pg: Pg;
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];
const running: Running[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => {});
  for (const b of boards.splice(0)) await b.end().catch(() => {});
  for (const d of drops.splice(0)) await d().catch(() => {});
}, 120_000);

afterAll(() => pg?.stop());

interface World {
  p: Project;
  board: Board;
  url: string;
  ui: Running;
  /** The hub's store for the project, in the server's settings folder. */
  store: string;
  by: Record<string, Attachment>;
}

/** A project whose origin is acme/shop, on a board, served by a UI on the hub; files attached from "another machine". */
async function world(): Promise<World> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const p = project(CONFIG);
  sh(["git", "-C", p.d, "remote", "add", "origin", `https://github.com/${REPO}.git`]);
  const settings = join(p.root, "config", "software-factory", "message-board");
  write(join(settings, "state.json"), JSON.stringify({ port: 5433, tailnetPort: 5434, address: "", image: "postgres:17-alpine" }));
  const board = await Board.open(db.url, { as: "menelik", max: 1 });
  boards.push(board);
  await board.migrate();
  const by: Record<string, Attachment> = {};
  const add = async (kind: "pr" | "task", id: string, head: string | null, name: string, bytes: Uint8Array | string): Promise<void> => {
    const [a] = await attach(board, REPO, { target: { kind, id }, head, files: [{ name, bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes }] },
      DEFAULT_LIMITS, false);
    by[name] = a as Attachment;
  };
  await add("pr", "12", "1111111aaaaaaa", "before.png", new Uint8Array([...PNG, 7]));
  await add("pr", "12", HEAD, "phone.png", PNG);
  await add("pr", "12", HEAD, "results.xml", JUNIT);
  await add("pr", "12", HEAD, "report.html", "<script>alert(1)</script>");
  await add("pr", "12", HEAD, "logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  await add("pr", "12", HEAD, "fake.png", "<html><script>alert(1)</script></html>");
  await add("task", "b3", null, "run.log", "one\ntwo\n");
  const ui = await startUi(p, ["--port", "0"], null, { MB_URL: db.url });
  running.push(ui);
  // the board opens a moment after the server starts
  for (let i = 0; i < 100 && (await api(ui, "/api/projects/work/attachments")).status !== 200; i++) await Bun.sleep(150);
  return { p, board, url: db.url, ui, store: join(settings, "attachments", "acme__shop"), by };
}

async function get(w: World, path: string, token: string | null = w.ui.token): Promise<Response> {
  return fetch(w.ui.url + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

test("the list for a pull request: oldest first, the older head's marked old, a JUnit report with its summary, no other target's", async () => {
  const w = await world();
  const r = await api(w.ui, `/api/projects/work/attachments?target=pr:12&head=${HEAD}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const rows = r.json.attachments as Row[];
  expect(rows.map((a) => a.name)).toEqual(["before.png", "phone.png", "results.xml", "report.html", "logo.svg", "fake.png"]);
  expect(rows.map((a) => a.old)).toEqual([true, false, false, false, false, false]);
  expect(rows.map((a) => a.kind)).toEqual(["image", "image", "junit", "html", "file", "file"]);
  expect(rows.map((a) => a.inline)).toEqual([true, true, false, false, false, false]);
  expect(rows[1]).toMatchObject({ by: "menelik", head: HEAD, file: `/api/projects/work/attachments/${w.by["phone.png"]?.id}/file` });
  expect(rows[2]?.summary).toMatchObject({ ok: true, passed: 1, failed: 1, skipped: 1,
    failures: [{ suite: "cart", name: "pays", classname: "cart", kind: "error", message: "boom", text: "trace" }] });
  expect(r.json).toMatchObject({ target: "pr:12", head: HEAD, limits: { maxFileMb: 25, maxProjectMb: 2000, retentionDays: 30 } });
  const task = await api(w.ui, "/api/projects/work/attachments?target=task:b3");
  expect((task.json.attachments as Row[]).map((a) => a.name)).toEqual(["run.log"]);
});

test("files are served as untrusted: exact type, nosniff, sandboxed, inline only for images and video", async () => {
  const w = await world();
  const file = (name: string, q = ""): Promise<Response> => get(w, `/api/projects/work/attachments/${w.by[name]?.id}/file${q}`);
  const png = await file("phone.png");
  expect(png.status).toBe(200);
  expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
  expect(png.headers.get("content-type")).toBe("image/png");
  expect(png.headers.get("x-content-type-options")).toBe("nosniff");
  expect(png.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  expect(png.headers.get("content-disposition")).toStartWith("inline;");
  expect((await file("phone.png", "?download=1")).headers.get("content-disposition")).toStartWith("attachment;");
  const html = await file("report.html");
  expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(html.headers.get("content-disposition")).toBe(`attachment; filename="report.html"; filename*=UTF-8''report.html`);
  expect(html.headers.get("x-content-type-options")).toBe("nosniff");
  const svg = await file("logo.svg");
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expect(svg.headers.get("content-disposition")).toStartWith("attachment;");
  const fake = await file("fake.png"); // named .png, but not one: never shown as an image
  expect(fake.headers.get("content-type")).toBe("application/octet-stream");
  expect(fake.headers.get("content-disposition")).toStartWith("attachment;");
  const log = await file("run.log");
  expect(log.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await log.text()).toBe("one\ntwo\n");
});

test("bytes attached from another machine move into the hub's store on the first read and leave the board", async () => {
  const w = await world();
  const a = w.by["phone.png"] as Attachment;
  expect(await w.board.value(`attachment-bytes:${REPO}:${a.sha256}`)).not.toBeNull();
  expect((await get(w, `/api/projects/work/attachments/${a.id}/file`)).status).toBe(200);
  expect(existsSync(join(w.store, a.sha256.slice(0, 2), a.sha256))).toBe(true);
  expect(await w.board.value(`attachment-bytes:${REPO}:${a.sha256}`)).toBeNull();
  expect(new Uint8Array(await (await get(w, `/api/projects/work/attachments/${a.id}/file`)).arrayBuffer())).toEqual(PNG); // from the store now
});

test("behind the same token as the API; ids and targets are checked", async () => {
  const w = await world();
  const id = w.by["phone.png"]?.id as string;
  expect((await get(w, `/api/projects/work/attachments/${id}/file`, null)).status).toBe(401);
  expect((await get(w, `/api/projects/work/attachments/${id}/file`, "wrong")).status).toBe(401);
  expect((await get(w, "/api/projects/work/attachments", null)).status).toBe(401);
  for (const bad of ["..%2F..%2Fetc%2Fpasswd", "abc", "000000000000"]) {
    const r = await get(w, `/api/projects/work/attachments/${bad}/file`);
    expect(r.status, bad).toBe(404);
    expect(((await r.json()) as Row).code).toBe("attachment_unknown");
  }
  const target = await api(w.ui, "/api/projects/work/attachments?target=pr:..%2Fx");
  expect(target.status).toBe(400);
  expect(target.json).toMatchObject({ code: "attachments_bad_input" });
  expect(typeof target.json.fix).toBe("string");
  const post = await api(w.ui, "/api/projects/work/attachments", { method: "POST", body: {} });
  expect(post.status).toBe(405);
});

test("the page lets in only images and video it fetched itself (blob:), and a server with no board says how to get one", async () => {
  const p = project(CONFIG);
  const ui = await startUi(p);
  running.push(ui);
  const page = await fetch(ui.url + "/");
  const csp = page.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(csp).toContain("media-src 'self' blob:");
  expect(csp).not.toMatch(/script-src[^;]*blob:/);
  const r = await api(ui, "/api/projects/work/attachments?target=pr:12");
  expect(r.status).toBe(404);
  expect(r.json).toMatchObject({ code: "attachments_no_board" });
  expect(String(r.json.fix)).toContain("factory board up");
});
