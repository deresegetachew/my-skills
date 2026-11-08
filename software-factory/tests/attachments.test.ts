// Attachments (#637): `factory attach` and the board tool `board_attach` keep files for a task, a pull request (with its
// head commit), a sign-off item or an epic on the hub, never in git, with the metadata on the message board. On the hub
// the bytes are content-addressed files in its store; from another machine they ride on the board until the hub reads
// them. Size caps per file and per project and the retention are enforced, and a refusal writes nothing. A pull request
// gets one comment with where to find them, with no token in it. `factory attach ls` says which are for the head and
// reads a JUnit report. A real Postgres (board_pg.ts), the stateful fake gh (fakegh.ts) and the real `factory`.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { installFakeGh } from "./fakegh.ts";
import { gitRepo, HOOKS, type Proc, SF, sh, tmp, write } from "./support.ts";

setDefaultTimeout(120_000);

const REPO = "acme/shop";
const BIN = join(SF, "message-board", "bin.ts");
const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const NEW_HEAD = "9999999aaaaaaa9999999aaaaaaa9999999aaaaa";
type Row = Record<string, unknown>;

let pg: Pg;
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterEach(async () => {
  for (const b of boards.splice(0)) await b.end().catch(() => {});
  for (const d of drops.splice(0)) await d().catch(() => {});
}, 120_000);

afterAll(async () => {
  pg?.stop();
}, 120_000);

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
export const JUNIT = `<?xml version="1.0"?>
<testsuites><testsuite name="login" tests="2"><testcase classname="login" name="signs in"/>
<testcase classname="login" name="remembers me"><failure message="expected true">at login.test.ts:12</failure></testcase></testsuite></testsuites>`;

interface World {
  d: string;
  root: string;
  shots: string;
  cfg: string;
  dbFile: string;
  log: string;
  env: Record<string, string>;
  board: Board;
}

/** A project on a fresh board, with `settings` in its factory.json; `hub`: this machine runs the board. */
async function world(settings: Row = {}, hub = true): Promise<World> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const root = tmp("factory-attach-");
  const d = join(root, "work");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "board" }, agents: ["menelik"], ...settings }));
  gitRepo(d);
  sh(["git", "-C", d, "add", "-A"]);
  sh(["git", "-C", d, "commit", "-qm", "settings"]);
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  symlinkSync(join(SF, "factory"), join(d, "factory"));
  const bin = installFakeGh(root);
  const dbFile = join(root, "db.json");
  const mainSettings = { tasks: { source: "board" }, agents: ["menelik"], ...settings }; // main has the same settings unless a test says not
  writeFileSync(dbFile, JSON.stringify({ repo: REPO, issues: [], comments: {}, pulls: [{ number: 12, head: { sha: HEAD } }], mainSettings }));
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  const cfg = join(root, "cfg");
  if (hub) write(join(cfg, "message-board", "state.json"), JSON.stringify({ port: 5433, tailnetPort: 5434, address: "", image: "postgres:17-alpine" }));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("FACTORY_") && !k.startsWith("MB_") && !k.startsWith("GH_") && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  }
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, FAKE_DB: dbFile, LOOP_LOG: log, MB_URL: db.url, GH_REPO: REPO,
    FACTORY_CONFIG_DIR: cfg, HOME: root, NO_COLOR: "1", FACTORY_AGENT: "menelik" });
  const board = await Board.open(db.url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  const shots = join(d, "shots"); // inside the worktree: attach reads nothing outside it
  mkdirSync(shots);
  writeFileSync(join(shots, "home-phone.png"), PNG);
  writeFileSync(join(shots, "results.xml"), JUNIT);
  writeFileSync(join(shots, "run.log"), "start\nerror: the login failed\ndone\n");
  return { d, root, shots, cfg, dbFile, log, env, board };
}

function attach(w: World, ...args: string[]): Proc {
  return sh(["bash", join(w.d, "factory"), "attach", ...args], { cwd: w.d, env: w.env, timeoutMs: 120_000 });
}

function posted(w: World): Row[] {
  return ((JSON.parse(readFileSync(w.dbFile, "utf8")) as Row).posted as Row[] | undefined) ?? [];
}

function comments(w: World, n: number): string[] {
  const all = ((JSON.parse(readFileSync(w.dbFile, "utf8")) as Row).comments as Record<string, unknown[]> | undefined) ?? {};
  return (all[String(n)] ?? []).map((c) => (typeof c === "string" ? c : String((c as Row).body)));
}

function setHead(w: World, sha: string): void {
  const db = JSON.parse(readFileSync(w.dbFile, "utf8")) as Row;
  db.pulls = [{ number: 12, head: { sha } }];
  writeFileSync(w.dbFile, JSON.stringify(db));
}

/** Every file in the hub's store for the project. */
function stored(w: World): string[] {
  const root = join(w.cfg, "message-board", "attachments", "acme__shop");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((two) => readdirSync(join(root, two)).map((f) => join(root, two, f)));
}

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function err(p: Proc): Row {
  return JSON.parse(p.stderr.trim().split("\n").at(-1) ?? "{}") as Row;
}

test("factory attach pr: files for its head in the hub's store, metadata on the board, one comment with no token, nothing in git", async () => {
  const w = await world({ ui: { url: "http://hub:4747" } });
  const before = sh(["git", "-C", w.d, "status", "--porcelain"]).stdout;
  const p = attach(w, "pr", "12", join(w.shots, "home-phone.png"), join(w.shots, "results.xml"), join(w.shots, "run.log"), "--note", "phone and desktop");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Attached 3 files to PR #12 (head abc1234)");
  expect(p.stdout).toMatch(/home-phone\.png {2}image/);
  expect(p.stdout).toMatch(/results\.xml {2}junit/);
  expect(p.stdout).toMatch(/run\.log {2}log/);
  // the bytes: content-addressed files in the hub's store, readable only by its user; none on the board
  const files = stored(w);
  expect(files.map((f) => f.split("/").at(-1)).sort()).toEqual([sha(PNG), sha(JUNIT), sha("start\nerror: the login failed\ndone\n")].sort());
  for (const f of files) expect(statSync(f).mode & 0o777).toBe(0o600);
  expect(await w.board.values("attachment-bytes:")).toEqual([]);
  // the metadata on the board, by the agent, for the head
  const meta = (await w.board.values(`attachment:${REPO}:pr:12:`)).map((v) => v.value as Row);
  expect(meta.map((m) => m.name).sort()).toEqual(["home-phone.png", "results.xml", "run.log"]);
  expect(meta.every((m) => m.head === HEAD && m.by === "menelik" && m.note === "phone and desktop")).toBe(true);
  // one comment on the pull request, linking its page in the web UI, with no token
  const said = comments(w, 12);
  expect(said.length).toBe(1);
  expect(said[0]).toContain("<!-- factory-attachments -->");
  expect(said[0]).toContain("http://hub:4747/#/work/pr:12");
  expect(said[0]).not.toMatch(/token/i);
  // nothing changed in the repo
  expect(sh(["git", "-C", w.d, "status", "--porcelain"]).stdout).toBe(before);
  // a second attach (the same file again, and a new one) keeps the one comment and stores the same file once
  writeFileSync(join(w.shots, "home-desktop.png"), new Uint8Array([...PNG, 9, 9]));
  const again = attach(w, "pr", "12", join(w.shots, "home-phone.png"), join(w.shots, "home-desktop.png"));
  expect(again.code, again.out).toBe(0);
  expect(again.stdout).toContain("already links to them");
  expect(comments(w, 12).length).toBe(1);
  expect(stored(w).length).toBe(4);
});

test("factory attach ls says which are for the head, reads the JUnit report, and says when no image is for the head", async () => {
  const w = await world();
  expect(attach(w, "pr", "12", join(w.shots, "home-phone.png"), join(w.shots, "results.xml")).code).toBe(0);
  const now = attach(w, "ls", "pr", "12");
  expect(now.code, now.out).toBe(0);
  expect(now.stdout).toMatch(/home-phone\.png .*head/);
  expect(now.stdout).toContain("1 passed, 1 failed, 0 skipped");
  expect(now.stdout).toContain("1 image for the head.");
  setHead(w, NEW_HEAD); // a new push: the screenshots are for an older head now
  const later = attach(w, "ls", "pr", "12");
  expect(later.stdout).toContain("old head abc1234");
  expect(later.stdout).toContain("No image for the head.");
  const json = JSON.parse(attach(w, "ls", "pr", "12", "--json").stdout) as { attachments: Row[] };
  expect(json.attachments.map((a) => a.current)).toEqual([false, false]);
  expect((json.attachments.find((a) => a.kind === "junit")?.summary as Row).failed).toBe(1);
  expect(attach(w, "ls", "task", "b3").stdout).toContain("Nothing is attached to task b3.");
});

test("a task, a sign-off item and an epic take attachments too, and a name is kept as a name, never a path", async () => {
  const w = await world();
  writeFileSync(join(w.shots, "a<b>.png"), PNG);
  expect(attach(w, "task", "#7", join(w.shots, "a<b>.png")).code).toBe(0);
  expect(attach(w, "signoff", "login-flow-2", join(w.shots, "run.log")).code).toBe(0);
  expect(attach(w, "epic", "b4", join(w.shots, "run.log")).code).toBe(0);
  const keys = (await w.board.values(`attachment:${REPO}:`)).map((v) => v.key.split(":").slice(2, 4).join(":")).sort();
  expect(keys).toEqual(["epic:b4", "signoff:login-flow-2", "task:7"]);
  const task = (await w.board.values(`attachment:${REPO}:task:7:`))[0]?.value as Row;
  expect(task.name).toBe("a-b-.png");
  expect(task.head).toBeNull();
  expect(posted(w).filter((x) => x.kind === "comment")).toEqual([]); // only a pull request gets a comment
});

test("bad input is refused with a fix and writes nothing", async () => {
  const w = await world();
  const cases: [string[], string][] = [
    [["pr", "nope", join(w.shots, "run.log")], "pull request's number"],
    [["thing", "1", join(w.shots, "run.log")], "task, a pr"],
    [["task", "7", join(w.shots, "missing.png")], "it isn't there"],
    [["task", "7"], "Name the files"],
    [["signoff", "../x", join(w.shots, "run.log")], "sign-off item's id"],
  ];
  for (const [args, said] of cases) {
    const p = attach(w, ...args);
    expect(p.code, p.out).toBe(1);
    const e = err(p);
    expect(String(e.message) + String(e.fix)).toContain(said);
    expect(typeof e.fix).toBe("string");
  }
  // a pull request GitHub doesn't know, and no --head
  const unknown = attach(w, "pr", "99", join(w.shots, "run.log"));
  expect(err(unknown).code).toBe("attach_pr_unknown");
  expect(await w.board.values("attachment")).toEqual([]);
  expect(stored(w)).toEqual([]);
});

test("the size caps: a file past attachments.maxFileMb, or the project past maxProjectMb, is refused and nothing is written", async () => {
  const w = await world({ attachments: { maxFileMb: 1, maxProjectMb: 1 } });
  writeFileSync(join(w.shots, "big.webm"), new Uint8Array(1024 * 1024 + 1));
  const big = attach(w, "task", "7", join(w.shots, "run.log"), join(w.shots, "big.webm"));
  expect(big.code, big.out).toBe(1);
  expect(String(err(big).message)).toContain("big.webm is 1 MB; one file may be at most 1 MB");
  expect(String(err(big).fix)).toContain("attachments.maxFileMb");
  expect(await w.board.values("attachment")).toEqual([]);
  expect(stored(w)).toEqual([]); // the log before it wasn't written either
  writeFileSync(join(w.shots, "a.log"), "a".repeat(600 * 1024));
  writeFileSync(join(w.shots, "b.log"), "b".repeat(600 * 1024));
  expect(attach(w, "task", "7", join(w.shots, "a.log")).code).toBe(0);
  expect(attach(w, "task", "7", join(w.shots, "a.log")).code).toBe(0); // the same file again takes no more space
  const full = attach(w, "task", "7", join(w.shots, "b.log"));
  expect(full.code, full.out).toBe(1);
  expect(String(err(full).fix)).toContain("attachments.maxProjectMb");
  expect((await w.board.values(`attachment:${REPO}:`)).length).toBe(2);
  expect(stored(w).length).toBe(1);
});

test("retention: an attachment past attachments.retentionDays is dropped with its file, and hidden until then", async () => {
  const w = await world({ attachments: { retentionDays: 7 } });
  expect(attach(w, "task", "7", join(w.shots, "run.log")).code).toBe(0);
  expect(attach(w, "task", "8", join(w.shots, "home-phone.png")).code).toBe(0);
  const [old] = await w.board.values(`attachment:${REPO}:task:7:`);
  const aged = { ...(old?.value as Row), at: new Date(Date.now() - 8 * 86_400_000).toISOString() };
  await w.board.setValue(old?.key as string, aged);
  expect(attach(w, "ls", "task", "7").stdout).toContain("Nothing is attached"); // hidden at once
  const past = new Date(Date.now() - 3600_000); // the files are past the grace a fresh file gets from a prune
  for (const f of stored(w)) utimesSync(f, past, past);
  const p = attach(w, "prune");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Dropped 1 attachment past 7 days.");
  expect(await w.board.values(`attachment:${REPO}:task:7:`)).toEqual([]);
  expect(stored(w).map((f) => f.split("/").at(-1))).toEqual([sha(PNG)]); // the log's file is gone, the image's kept
  expect(attach(w, "prune").stdout).toContain("Nothing is past its retention.");
});

test("from a machine that isn't the hub the bytes ride on the board, once per file", async () => {
  const w = await world({}, false);
  expect(attach(w, "task", "7", join(w.shots, "home-phone.png")).code).toBe(0);
  const second = attach(w, "task", "9", join(w.shots, "home-phone.png"));
  expect(second.code, second.out).toBe(0);
  expect(stored(w)).toEqual([]);
  const bytes = await w.board.values("attachment-bytes:");
  expect(bytes.map((b) => b.key)).toEqual([`attachment-bytes:${REPO}:${sha(PNG)}`]);
  expect(Buffer.from(String((bytes[0]?.value as Row).base64), "base64")).toEqual(Buffer.from(PNG));
});

test("without a board on this machine factory attach says how to get one", async () => {
  const w = await world();
  const env = { ...w.env };
  delete env.MB_URL;
  const p = sh(["bash", join(w.d, "factory"), "attach", "task", "7", join(w.shots, "run.log")], { cwd: w.d, env });
  expect(p.code).toBe(1);
  expect(err(p)).toMatchObject({ code: "attach_no_board" });
  expect(String(err(p).fix)).toContain("factory board up");
});

/** One tool call through the board's MCP server as `as` (a builder), from folder `cwd`; the tool's result. */
async function mcp(w: World, cwd: string, name: string, args: Row, extra: string[] = [], projectDir?: string): Promise<{ isError: boolean; out: Row; listed: string[] }> {
  const p = Bun.spawn([process.execPath, "--no-env-file", BIN, "mcp", "--as", "menelik", "--repo", REPO, ...extra],
    { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir ?? cwd, MB_URL: w.env.MB_URL, FACTORY_CONFIG_DIR: w.cfg } });
  const send = (m: unknown): void => {
    p.stdin.write(JSON.stringify(m) + "\n");
  };
  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await p.stdin.end();
  const timer = setTimeout(() => p.kill(9), 60_000);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(timer);
  const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: { isError?: boolean; structuredContent?: Row; tools?: { name: string }[] } });
  const r = lines.find((x) => x.id === 1);
  if (!r?.result) throw new Error(`${name} gave no result: ${out}`);
  return { isError: r.result.isError === true, out: r.result.structuredContent as Row, listed: (lines.find((x) => x.id === 2)?.result?.tools ?? []).map((t) => t.name) };
}

test("board_attach: a builder attaches files from its folder to a pull request's head, within the limits it was started with", async () => {
  const w = await world();
  const r = await mcp(w, w.d, "board_attach", { target: "pr", id: "12", files: ["shots/home-phone.png", "shots/results.xml"], head: HEAD, note: "phone" });
  expect(r.isError, JSON.stringify(r.out)).toBe(false);
  expect(r.listed).toContain("board_attach");
  expect((r.out.attachments as Row[]).map((a) => [a.name, a.kind, a.head])).toEqual([["home-phone.png", "image", HEAD], ["results.xml", "junit", HEAD]]);
  expect(stored(w).length).toBe(2);
  const meta = (await w.board.values(`attachment:${REPO}:pr:12:`)).map((v) => v.value as Row);
  expect(meta.every((m) => m.by === "menelik")).toBe(true);
  // a file that isn't there, and one past the cap it was started with
  const missing = await mcp(w, w.d, "board_attach", { target: "task", id: "b3", files: ["shots/nope.png"] });
  expect(missing.isError).toBe(true);
  expect(String((missing.out.error as Row).message)).toContain("it isn't there");
  writeFileSync(join(w.shots, "big.log"), "x".repeat(1024 * 1024 + 1));
  const big = await mcp(w, w.d, "board_attach", { target: "task", id: "b3", files: ["shots/big.log"] }, ["--attach-limits", "1,2000,30"]);
  expect(big.isError).toBe(true);
  expect(String((big.out.error as Row).message)).toContain("one file may be at most 1 MB");
  expect(await w.board.values(`attachment:${REPO}:task:b3:`)).toEqual([]);
});

// --- what may be read: only regular files inside the worktree, never secrets (#637 security review) -------------------

/** Paths an injected task might ask for: outside the worktree, through a link, secrets inside it, a folder. */
function forbidden(w: World): string[] {
  write(join(w.root, "outside.txt"), "secret outside");
  symlinkSync(join(w.root, "outside.txt"), join(w.shots, "link-out.png"));
  write(join(w.d, ".env"), "TOKEN=x");
  write(join(w.d, ".env.local"), "TOKEN=y");
  write(join(w.d, ".claude", "notes.md"), "rules");
  mkdirSync(join(w.shots, "a-folder"));
  return ["/etc/hosts", "../outside.txt", join(w.shots, "link-out.png"), ".env", ".env.local", ".git/config", ".claude/notes.md",
    join(w.shots, "a-folder")];
}

test("factory attach reads only regular files inside the worktree: outside it, a link out, .env, .git and .claude are refused", async () => {
  const w = await world();
  for (const path of forbidden(w)) {
    const p = attach(w, "task", "7", join(w.shots, "run.log"), path);
    expect(p.code, `${path}: ${p.out}`).toBe(1);
    const e = err(p);
    expect(e.code, path).toBe("attach_path_refused");
    expect(String(e.fix), path).not.toBe("");
  }
  expect(await w.board.values("attachment")).toEqual([]);
  expect(stored(w)).toEqual([]);
});

test("board_attach reads only regular files inside the worktree too", async () => {
  const w = await world();
  for (const path of forbidden(w)) {
    const r = await mcp(w, w.d, "board_attach", { target: "task", id: "b3", files: ["shots/run.log", path] });
    expect(r.isError, path).toBe(true);
    expect(String((r.out.error as Row).message), path).toContain("can't be attached");
  }
  expect(await w.board.values("attachment")).toEqual([]);
  expect(stored(w)).toEqual([]);
});

test("a file past the cap is refused from its size, before it is read", async () => {
  const w = await world({ attachments: { maxFileMb: 1 } });
  const big = join(w.shots, "big.log");
  writeFileSync(big, "x".repeat(1024 * 1024 + 1));
  chmodSync(big, 0o000); // unreadable: a check that read it first would fail another way
  const p = attach(w, "task", "7", big);
  chmodSync(big, 0o600);
  expect(p.code, p.out).toBe(1);
  expect(String(err(p).message)).toContain("one file may be at most 1 MB");
});

test("factory attach takes its limits and ui.url from main's settings, not the worktree's", async () => {
  const w = await world({ attachments: { maxFileMb: 1 } });
  write(join(w.d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "board" }, agents: ["menelik"], attachments: { maxFileMb: 999 },
    ui: { url: "http://evil.example" } }));
  writeFileSync(join(w.shots, "big.log"), "x".repeat(1024 * 1024 + 1));
  const p = attach(w, "task", "7", join(w.shots, "big.log"));
  expect(p.code, p.out).toBe(1);
  expect(String(err(p).message)).toContain("one file may be at most 1 MB");
  expect(attach(w, "pr", "12", join(w.shots, "run.log")).code).toBe(0);
  expect(comments(w, 12)[0]).not.toContain("evil.example");
});

test("prune leaves a file written in the last minutes alone, so it can't race an attach", async () => {
  const w = await world();
  // a file in the store with no attachment yet: an attach between writing the file and recording it
  const fresh = join(w.cfg, "message-board", "attachments", "acme__shop", "aa", "a".repeat(64));
  write(fresh, "in flight");
  expect(attach(w, "prune").code).toBe(0);
  expect(existsSync(fresh)).toBe(true);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(fresh, old, old);
  expect(attach(w, "prune").code).toBe(0);
  expect(existsSync(fresh)).toBe(false);
});

test("attaching a file the store already has makes it fresh again, so a prune can't take it from under the attach", async () => {
  const w = await world();
  expect(attach(w, "task", "7", join(w.shots, "run.log")).code).toBe(0);
  const [file] = stored(w);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(file as string, old, old);
  expect(attach(w, "task", "8", join(w.shots, "run.log")).code).toBe(0);
  expect(statSync(file as string).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
});

// --- the checkout is where the session runs, not where a forged .git says (#637, second review) -------------------------

/** A folder `inner` in the worktree whose `.git` file points at a forged git folder that says the checkout is `w.root`,
 *  the folder above the worktree (a stand-in for the home folder). */
function forgedCheckout(w: World): string {
  const inner = join(w.d, "inner");
  mkdirSync(inner);
  const fake = join(w.d, "fake-gitdir");
  sh(["git", "init", "-q", "--bare", fake]);
  sh(["git", "-C", fake, "config", "core.bare", "false"]);
  sh(["git", "-C", fake, "config", "core.worktree", w.root]);
  writeFileSync(join(inner, ".git"), `gitdir: ${fake}\n`);
  expect(sh(["git", "-C", inner, "rev-parse", "--show-toplevel"]).stdout.trim()).toBe(sh(["realpath", w.root]).stdout.trim());
  write(join(w.root, "secret.txt"), "the home folder's secret");
  return inner;
}

test("a forged .git that moves the checkout to a folder above it is refused, by factory attach and board_attach", async () => {
  const w = await world();
  const inner = forgedCheckout(w);
  // the hook itself: the factory script would look for its hooks where the forged .git says
  const p = sh([process.execPath, "--no-env-file", "--config=/dev/null", join(HOOKS, "factory_attach.ts"), "task", "7", "../../secret.txt"],
    { cwd: inner, env: w.env, timeoutMs: 120_000 });
  expect(p.code, p.out).toBe(1);
  expect(err(p).code, p.stderr).toBe("attach_path_refused");
  const r = await mcp(w, inner, "board_attach", { target: "task", id: "b3", files: ["../../secret.txt"] });
  expect(r.isError).toBe(true);
  expect(String((r.out.error as Row).message)).toContain("isn't the checkout");
  expect(await w.board.values("attachment")).toEqual([]);
  expect(stored(w)).toEqual([]);
});

test("a hard link to a file outside the checkout is refused", async () => {
  const w = await world();
  write(join(w.root, "outside.txt"), "secret outside");
  linkSync(join(w.root, "outside.txt"), join(w.shots, "hard.log"));
  const p = attach(w, "task", "7", join(w.shots, "hard.log"));
  expect(p.code, p.out).toBe(1);
  expect(String(err(p).message)).toContain("hard link");
  const r = await mcp(w, w.d, "board_attach", { target: "task", id: "b3", files: ["shots/hard.log"] });
  expect(r.isError).toBe(true);
  expect(await w.board.values("attachment")).toEqual([]);
});
