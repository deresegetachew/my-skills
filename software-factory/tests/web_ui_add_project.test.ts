// The web UI's "add or set up a new project" (#447), server side: GET /api/add-project (repos from gh, the folder, the
// projects, messaging, the legends), POST /api/add-project/check (a dry run: the seven steps, or a problem), POST
// /api/add-project (a run that clones or creates the repo, installs the kit with the real install.sh, writes the answers,
// runs the new project's `factory init`, opens a setup pull request, lists the project and runs `factory doctor`), a retry from the failed step, and the WebSocket messages. gh is a fake that logs every call and
// keeps its remotes as local bare repos; `factory` is a fake script (committed in each "cloned" repo) that logs what it
// was asked. Nothing here reaches the network.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { api, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { git, gitRepo, read, readJson, sh, write, writeExe } from "./support.ts";

const T = 90_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// --- the fakes ---------------------------------------------------------------------------------------------------------

/** The `factory` script a "cloned" repo carries: logs its arguments; `doctor` exits with the number in $FAKE_DOCTOR_FILE. */
const FACTORY_SCRIPT = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
if [ "$1" = "doctor" ]; then
  echo "doctor ran"
  code=$(cat "$FAKE_DOCTOR_FILE" 2>/dev/null || echo 0)
  if [ "$code" != "0" ]; then echo "problem: the fake doctor found something"; fi
  exit "$code"
fi
exit 0
`;

const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$LOOP_LOG"
case "$1 $2" in
  "repo list")
    if [ -n "$FAKE_GH_FAIL" ]; then echo "gh: not logged in" >&2; exit 1; fi
    cat "$FAKE_REPO_LIST"; exit 0 ;;
  "repo view")
    grep -qx "$3" "$FAKE_REMOTE_LIST" 2>/dev/null && { echo '{"name":"x"}'; exit 0; }
    echo "Could not resolve to a Repository" >&2; exit 1 ;;
  "repo create")
    echo "$3" >> "$FAKE_REMOTE_LIST"; echo "https://github.com/$3"; exit 0 ;;
  "repo clone")
    repo="$3"; dest="$4"
    n=0
    while [ -f "$FAKE_HOLD" ] && [ "$n" -lt 400 ]; do sleep 0.1; n=$((n+1)); done
    bare="$FAKE_REMOTES/$repo.git"
    if [ ! -d "$bare" ]; then mkdir -p "$(dirname "$bare")"; git init -q --bare -b main "$bare"; fi
    mkdir -p "$dest"; cd "$dest" || exit 1
    git init -q -b main
    git config user.email t@example.com; git config user.name t; git config commit.gpgsign false
    git remote add origin "$bare"
    if git ls-remote --exit-code origin main >/dev/null 2>&1; then
      git fetch -q origin main; git checkout -q -B main origin/main
    else
      cp "$FAKE_FACTORY_SRC" factory; chmod +x factory
      git add -A; git commit -q -m "first"; git push -q -u origin main
    fi
    exit 0 ;;
  "pr list")
    if [ -f "$FAKE_PRS" ]; then cat "$FAKE_PRS"; else echo "[]"; fi; exit 0 ;;
  "pr create")
    echo "https://github.com/acme/repo/pull/1"; exit 0 ;;
esac
exit 1
`;

const REPOS = [
  { nameWithOwner: "acme/shop", isPrivate: true, updatedAt: "2026-11-01T10:00:00Z" },
  { nameWithOwner: "acme/work", isPrivate: false, updatedAt: "2026-10-01T10:00:00Z" },
];

interface Setup {
  p: Project;
  ui: Running;
  /** The folder new projects go into (the serving project's parent). */
  folder: string;
  doctorFile: string;
  hold: string;
  remotes: string;
  prs: string;
}

async function setup(cfg: Row | null = null, env: Record<string, string> = {}): Promise<Setup> {
  const p = cfg ? project(cfg) : project();
  roots.push(p.root);
  const bin = join(p.root, "fakebin");
  writeExe(join(bin, "gh"), FAKE_GH);
  const doctorFile = join(p.root, "doctor-exit");
  const hold = join(p.root, "hold");
  const remotes = join(p.root, "remotes");
  const prs = join(p.root, "prs.json");
  write(join(p.root, "repos.json"), JSON.stringify(REPOS));
  write(join(p.root, "remote-list"), "");
  writeExe(join(p.root, "fake-factory.sh"), FACTORY_SCRIPT);
  write(doctorFile, "0");
  p.env.PATH = `${bin}:${p.env.PATH ?? ""}`;
  Object.assign(p.env, { FAKE_REPO_LIST: join(p.root, "repos.json"), FAKE_REMOTE_LIST: join(p.root, "remote-list"),
    FAKE_REMOTES: remotes, FAKE_FACTORY_SRC: join(p.root, "fake-factory.sh"), FAKE_DOCTOR_FILE: doctorFile, FAKE_HOLD: hold,
    FAKE_PRS: prs });
  // the serving project is clean and has a remote, so it can be told apart from a new one
  git(p.d, "remote", "add", "origin", "https://github.com/acme/work.git");
  git(p.d, "add", "-A");
  git(p.d, "commit", "-q", "-m", "setup");
  const ui = await startUi(p, ["--port", "0"], null, env);
  running.push(ui);
  return { p, ui, folder: p.root, doctorFile, hold, remotes, prs };
}

/** A new git repo at `dir` (made if missing), one commit on main. */
function mkRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return gitRepo(dir);
}

function ghCalls(p: Project): string[] {
  return read(p.ghLog).split("\n").filter(Boolean);
}

function factoryCalls(p: Project): string[] {
  return read(p.factoryLog).split("\n").filter(Boolean);
}

/** A good clone request into `<folder>/<name>`. */
function req(s: Setup, over: Row = {}, name = "shop"): Row {
  return { source: "clone", repo: `acme/${name}`, path: join(s.folder, name), visibility: "private", tasks: "issues", mainBranch: "main",
    test: "bun test", lint: "bun x tsc --noEmit", protected: ["docs/", "secrets/"],
    team: { devManager: "haile", productOwner: "abebe", builders: ["menelik", "taytu"] }, ...over };
}

async function waitRun(ui: Running, id: string, ms = 80_000): Promise<Row> {
  const deadline = Date.now() + ms;
  let run: Row = {};
  while (Date.now() < deadline) {
    const r = await api(ui, `/api/add-project/runs/${id}`);
    run = r.json.run as Row;
    if (r.status === 200 && run.state !== "running") return run;
    await Bun.sleep(150);
  }
  throw new Error(`run ${id} still running: ${JSON.stringify(run)}`);
}

async function start(s: Setup, body: Row): Promise<string> {
  const r = await api(s.ui, "/api/add-project", { method: "POST", body: { confirm: true, ...body } });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  return String((r.json.run as Row).id);
}

function step(run: Row, id: string): Row {
  return (run.steps as Row[]).find((x) => x.id === id) as Row;
}

function states(run: Row): string[] {
  return (run.steps as Row[]).map((x) => `${x.id}:${x.state}`);
}

async function check(s: Setup, body: Row) {
  return api(s.ui, "/api/add-project/check", { method: "POST", body });
}

/** Every WebSocket message from now on. */
async function listen(ui: Running): Promise<{ msgs: Row[]; close: () => void }> {
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  const msgs: Row[] = [];
  ws.addEventListener("message", (e) => msgs.push(JSON.parse(String(e.data)) as Row));
  await new Promise<void>((ok, bad) => {
    ws.addEventListener("open", () => ok());
    ws.addEventListener("error", () => bad(new Error("websocket did not open")));
  });
  return { msgs, close: () => ws.close() };
}

async function until(f: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!f() && Date.now() < deadline) await Bun.sleep(100);
}

// --- the token ---------------------------------------------------------------------------------------------------------

test("every add-project endpoint needs the token (401) and nothing runs without it", async () => {
  const s = await setup();
  const calls: [string, string][] = [["GET", "/api/add-project"], ["POST", "/api/add-project/check"], ["POST", "/api/add-project"],
    ["GET", "/api/add-project/runs/x"], ["POST", "/api/add-project/runs/x/retry"]];
  for (const [method, path] of calls) {
    const none = await api(s.ui, path, { method, body: method === "POST" ? { confirm: true, ...req(s) } : undefined, token: null });
    expect(none.status, `${method} ${path}`).toBe(401);
    expect(none.json.code).toBe("ui_token_missing");
    const wrong = await api(s.ui, path, { method, body: method === "POST" ? { confirm: true, ...req(s) } : undefined, token: "x".repeat(43) });
    expect(wrong.status, `${method} ${path}`).toBe(401);
  }
  expect(ghCalls(s.p)).toEqual([]);
  expect(existsSync(join(s.folder, "shop"))).toBe(false);
}, T);

// --- the form's data ---------------------------------------------------------------------------------------------------

test("GET /api/add-project: the repos from gh, the one already in the factory marked, the folder, the legends, the messaging", async () => {
  const s = await setup();
  const r = await api(s.ui, "/api/add-project");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.repos).toEqual([
    { name: "acme/shop", private: true, updatedAt: "2026-11-01T10:00:00Z", inFactory: null },
    { name: "acme/work", private: false, updatedAt: "2026-10-01T10:00:00Z", inFactory: "work" },
  ]);
  // the server knows its project by its real path (git gives it that way: /private/var for /var on macOS)
  expect(realpathSync(String(r.json.folder))).toBe(realpathSync(s.folder));
  expect((r.json.projects as Row[]).map((x) => x.id)).toEqual(["work"]);
  expect(r.json.messaging).toBe("github");
  expect(r.json.legends).toEqual(["menelik", "taytu", "haile", "tewodros", "yohannes", "zewditu", "lalibela", "ezana", "alula", "abebe",
    "fasil", "mentewab"]);
  expect(r.json.problems).toEqual([]);
  expect(ghCalls(s.p)).toContain("gh repo list --json nameWithOwner,isPrivate,updatedAt --limit 100");
}, T);

test("GET /api/add-project: the serving project's messaging transport is given as board", async () => {
  const s = await setup({ tasks: { source: "issues" }, agents: ["menelik"], messaging: { transport: "board" } });
  const r = await api(s.ui, "/api/add-project");
  expect(r.json.messaging).toBe("board");
}, T);

test("GET /api/add-project: when gh fails there are no repos and one ui_add_github problem, not a crash", async () => {
  const s = await setup(null, { FAKE_GH_FAIL: "1" });
  const r = await api(s.ui, "/api/add-project");
  expect(r.status).toBe(200);
  expect(r.json.repos).toEqual([]);
  const problems = r.json.problems as Row[];
  expect(problems.length).toBe(1);
  expect(problems[0]?.code).toBe("ui_add_github");
  expect(typeof problems[0]?.fix).toBe("string");
  expect(r.json.legends).toHaveLength(12);
}, T);

// --- check -------------------------------------------------------------------------------------------------------------

test("check: a good request gives the seven steps in order and writes nothing, runs no gh write", async () => {
  const s = await setup();
  const before = readFileSync(join(s.p.d, ".claude", "factory.json"), "utf8");
  const r = await check(s, req(s));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.ok).toBe(true);
  const steps = r.json.steps as Row[];
  expect(steps.map((x) => x.id)).toEqual(["repo", "kit", "answers", "init", "commit", "list", "doctor"]);
  for (const x of steps) {
    expect(typeof x.title).toBe("string");
    expect(typeof x.detail).toBe("string");
  }
  const log = ghCalls(s.p).join("\n");
  expect(log).not.toMatch(/repo clone|repo create|pr create/);
  expect(existsSync(join(s.folder, "shop"))).toBe(false);
  expect(readFileSync(join(s.p.d, ".claude", "factory.json"), "utf8")).toBe(before);
  expect(existsSync(join(s.p.d, ".git", "factory", "ui-projects.json"))).toBe(false);
}, T);

test("check: every refusal is 400 with {code, message, fix}", async () => {
  const s = await setup();
  const taken = join(s.folder, "taken");
  write(join(taken, "other.txt"), "not a checkout");
  const notGit = join(s.folder, "plain");
  mkdirSync(notGit);
  const dirty = mkRepo(join(s.folder, "dirty"));
  write(join(dirty, "a.txt"), "one");
  git(dirty, "add", "-A");
  git(dirty, "commit", "-q", "-m", "a");
  write(join(dirty, "a.txt"), "two");
  const cases: [string, Row][] = [
    ["ui_add_source", req(s, { source: "zip" })],
    ["ui_add_repo", req(s, { repo: "not-a-repo" })],
    ["ui_add_repo", req(s, { source: "new", repo: "a/b/c" })],
    ["ui_add_path", req(s, { path: "relative/shop" })],
    ["ui_add_path", req(s, { source: "folder", path: join(s.folder, "nowhere") })],
    ["ui_add_path_taken", req(s, { path: taken })],
    ["ui_add_path_taken", req(s, { source: "new", path: taken })],
    ["ui_add_not_git", req(s, { source: "folder", path: notGit })],
    ["ui_add_dirty", req(s, { source: "folder", path: dirty })],
    ["ui_add_known", req(s, { source: "folder", path: s.p.d })],
    ["ui_add_branch", req(s, { mainBranch: "" })],
    ["ui_add_branch", req(s, { mainBranch: "my branch" })],
    ["ui_add_team", req(s, { team: { devManager: "haile", productOwner: "abebe", builders: [] } })],
    ["ui_add_team", req(s, { team: { devManager: "Haile!", productOwner: "abebe", builders: ["menelik"] } })],
    ["ui_add_team", req(s, { team: { devManager: "haile", productOwner: "abebe", builders: ["-bad"] } })],
    ["ui_add_team", req(s, { team: { devManager: "haile", productOwner: "abebe", builders: ["a".repeat(41)] } })],
    ["ui_add_team", req(s, { team: { devManager: "haile", productOwner: "haile", builders: ["menelik"] } })],
    ["ui_add_team", req(s, { team: { devManager: "haile", productOwner: "abebe", builders: ["menelik", "menelik"] } })],
    ["ui_add_team", req(s, { team: { devManager: "haile", productOwner: "abebe", builders: ["haile"] } })],
    ["ui_add_tasks", req(s, { tasks: "jira" })],
  ];
  for (const [code, body] of cases) {
    const r = await check(s, body);
    expect(r.status, `${code} ${JSON.stringify(body)} -> ${JSON.stringify(r.json)}`).toBe(400);
    expect(r.json.code, JSON.stringify(body)).toBe(code);
    expect(typeof r.json.message).toBe("string");
    expect(typeof r.json.fix).toBe("string");
  }
  expect(ghCalls(s.p).join("\n")).not.toMatch(/repo clone|repo create|pr create/);
  expect(existsSync(join(s.folder, "shop"))).toBe(false);
}, T);

test("check: a clean git repo as a folder is accepted, and a path that is a checkout of the repo is accepted for clone", async () => {
  const s = await setup();
  const repo = mkRepo(join(s.folder, "mine"));
  git(repo, "remote", "add", "origin", "https://github.com/acme/mine.git"); // a folder needs an origin for its setup pull request (#546)
  const folderOk = await check(s, req(s, { source: "folder", path: repo }));
  expect(folderOk.status, JSON.stringify(folderOk.json)).toBe(200);
  const checkout = mkRepo(join(s.folder, "shop"));
  git(checkout, "remote", "add", "origin", "https://github.com/acme/shop.git");
  const cloneOk = await check(s, req(s));
  expect(cloneOk.status, JSON.stringify(cloneOk.json)).toBe(200);
}, T);

// --- start -------------------------------------------------------------------------------------------------------------

test("start without confirm: 400 confirm_needed and nothing runs", async () => {
  const s = await setup();
  const r = await api(s.ui, "/api/add-project", { method: "POST", body: req(s) });
  expect(r.status).toBe(400);
  expect(r.json.code).toBe("confirm_needed");
  const no = await api(s.ui, "/api/add-project", { method: "POST", body: { confirm: false, ...req(s) } });
  expect(no.status).toBe(400);
  expect(ghCalls(s.p)).toEqual([]);
  expect(existsSync(join(s.folder, "shop"))).toBe(false);
}, T);

test("start with an invalid request: the same 400 problem as check, nothing runs", async () => {
  const s = await setup();
  const r = await api(s.ui, "/api/add-project", { method: "POST", body: { confirm: true, ...req(s, { mainBranch: "a b" }) } });
  expect(r.status).toBe(400);
  expect(r.json.code).toBe("ui_add_branch");
  expect(ghCalls(s.p)).toEqual([]);
}, T);

test("unknown run: GET and retry are 404 ui_add_run_unknown", async () => {
  const s = await setup();
  const g = await api(s.ui, "/api/add-project/runs/nope");
  expect(g.status).toBe(404);
  expect(g.json.code).toBe("ui_add_run_unknown");
  const r = await api(s.ui, "/api/add-project/runs/nope/retry", { method: "POST", body: { confirm: true } });
  expect(r.status).toBe(404);
  expect(r.json.code).toBe("ui_add_run_unknown");
}, T);

// --- clone, end to end -------------------------------------------------------------------------------------------------

test("clone: every step runs, the answers are written, the project is listed, and the WebSocket saw it", async () => {
  const s = await setup();
  const ws = await listen(s.ui);
  const id = await start(s, req(s));
  const run = await waitRun(s.ui, id);
  expect(run.state, JSON.stringify(run)).toBe("done");
  expect(states(run)).toEqual(["repo:done", "kit:done", "answers:done", "init:done", "commit:done", "list:done", "doctor:done"]);
  expect(run).toMatchObject({ name: "shop", path: join(s.folder, "shop"), project: "shop" });
  for (const x of run.steps as Row[]) expect(x.problem).toBeNull();
  expect(String(step(run, "repo").command)).toContain("gh repo clone acme/shop");
  expect(String(step(run, "doctor").output)).toContain("doctor ran");

  const dest = join(s.folder, "shop");
  const gh = ghCalls(s.p);
  expect(gh).toContain(`gh repo clone acme/shop ${dest}`);
  const pr = gh.filter((l) => l.startsWith("gh pr create"));
  expect(pr.length).toBe(1);
  expect(pr[0]).toContain("--base main");
  expect(pr[0]).toContain("--head factory/setup");
  expect(gh.some((l) => l.startsWith("gh pr list") && l.includes("--head factory/setup"))).toBe(true);

  expect(existsSync(join(dest, ".claude", "hooks", "factory_config.ts"))).toBe(true);
  expect(read(join(dest, "factory"))).toContain("FAKE_FACTORY_LOG");
  const cfg = readJson<Row>(join(dest, ".claude", "factory.json"));
  expect((cfg.tasks as Row).source).toBe("issues");
  expect(cfg.mainBranch).toBe("main");
  expect((cfg.commands as Row).test).toBe("bun test");
  expect((cfg.commands as Row).lint).toBe("bun x tsc --noEmit");
  const prot = cfg.protected as string[];
  // a typed path becomes an anchored regex (protected is a list of regexes): a folder its prefix
  expect(prot).toContain("^docs/");
  expect(prot).toContain("^secrets/");
  expect(prot).not.toContain("docs/");
  expect(new Set(prot).size).toBe(prot.length);
  expect(cfg.agents).toEqual(["menelik", "taytu"]);
  expect(((cfg.roles as Row)["dev-manager"] as Row).names).toEqual(["haile"]);
  expect(((cfg.roles as Row)["product-owner"] as Row).names).toEqual(["abebe"]);
  expect(cfg.messaging).toBeUndefined();

  const calls = factoryCalls(s.p);
  expect(calls).toContain("init");
  expect(calls).toContain("doctor");

  expect(git(dest, "branch", "--list", "factory/setup").trim()).toContain("factory/setup");
  expect(git(s.remotes + "/acme/shop.git", "branch", "--list", "factory/setup").trim()).toContain("factory/setup");

  const listed = readJson<string[]>(join(s.p.d, ".git", "factory", "ui-projects.json"));
  expect(listed).toContain(dest);
  const projects = await api(s.ui, "/api/projects");
  expect((projects.json.projects as Row[]).map((x) => x.id)).toContain("shop");
  const channels = await api(s.ui, "/api/projects/shop/channels");
  expect(channels.status).toBe(200);

  await until(() => ws.msgs.some((m) => m.type === "projects"));
  ws.close();
  const adds = ws.msgs.filter((m) => m.type === "add-project");
  expect(adds.length).toBeGreaterThan(1);
  expect((adds[adds.length - 1]?.run as Row).state).toBe("done");
  expect(ws.msgs.some((m) => m.type === "projects")).toBe(true);
}, T);

test("a restarted factory ui still lists the added project", async () => {
  const s = await setup();
  const run = await waitRun(s.ui, await start(s, req(s)));
  expect(run.state, JSON.stringify(run)).toBe("done");
  await s.ui.stop();
  const again = await startUi(s.p);
  running.push(again);
  const projects = await api(again, "/api/projects");
  expect((projects.json.projects as Row[]).map((x) => x.id)).toEqual(["work", "shop"]);
}, T);

test("the same request again after it is done is refused with ui_add_known", async () => {
  const s = await setup();
  const run = await waitRun(s.ui, await start(s, req(s)));
  expect(run.state, JSON.stringify(run)).toBe("done");
  const clones = ghCalls(s.p).filter((l) => l.startsWith("gh repo clone")).length;
  const again = await check(s, req(s));
  expect(again.status).toBe(400);
  expect(again.json.code).toBe("ui_add_known");
  const start2 = await api(s.ui, "/api/add-project", { method: "POST", body: { confirm: true, ...req(s) } });
  expect(start2.status).toBe(400);
  expect(start2.json.code).toBe("ui_add_known");
  expect(ghCalls(s.p).filter((l) => l.startsWith("gh repo clone")).length).toBe(clones);
}, T);

test("an open setup pull request is not opened twice: no second pr create", async () => {
  const s = await setup();
  write(s.prs, JSON.stringify([{ number: 7, url: "https://github.com/acme/shop/pull/7", state: "OPEN" }]));
  const run = await waitRun(s.ui, await start(s, req(s)));
  expect(run.state, JSON.stringify(run)).toBe("done");
  expect(ghCalls(s.p).filter((l) => l.startsWith("gh pr create"))).toEqual([]);
}, T);

test("a path that is already a checkout of the repo skips the clone", async () => {
  const s = await setup();
  const dest = mkRepo(join(s.folder, "shop"));
  write(join(dest, "factory"), FACTORY_SCRIPT, 0o755);
  git(dest, "add", "-A");
  git(dest, "commit", "-q", "-m", "factory");
  const bare = join(s.remotes, "acme", "shop.git");
  mkdirSync(dirname(bare), { recursive: true });
  git(s.folder, "init", "-q", "--bare", "-b", "main", bare);
  git(dest, "remote", "add", "origin", bare);
  git(dest, "push", "-q", "origin", "main");
  const run = await waitRun(s.ui, await start(s, req(s)));
  expect(step(run, "repo").state).toBe("skipped");
  expect(ghCalls(s.p).filter((l) => l.startsWith("gh repo clone"))).toEqual([]);
}, T);

// --- the board -------------------------------------------------------------------------------------------------------

test("a serving project that names the board gives the new project the board too, and no step makes keys", async () => {
  const s = await setup({ tasks: { source: "issues" }, agents: ["menelik"], messaging: { transport: "board" },
    roles: { "dev-manager": { names: ["fasil"] }, "product-owner": { names: ["mentewab"] } } });
  const run = await waitRun(s.ui, await start(s, req(s, { repo: "acme/Shop" })));
  expect(run.state, JSON.stringify(run)).toBe("done");
  expect((run.steps as Row[]).map((x) => x.id)).not.toContain("keys");
  const cfg = readJson<Row>(join(s.folder, "shop", ".claude", "factory.json"));
  expect((cfg.messaging as Row).transport).toBe("board");
}, T);

// --- doctor fails, then a retry ----------------------------------------------------------------------------------------

test("doctor fails: the run stops there with its output; a retry goes on from it and nothing is done twice", async () => {
  const s = await setup();
  writeFileSync(s.doctorFile, "1");
  const id = await start(s, req(s));
  const failed = await waitRun(s.ui, id);
  expect(failed.state).toBe("failed");
  expect(states(failed)).toEqual(["repo:done", "kit:done", "answers:done", "init:done", "commit:done", "list:done",
    "doctor:failed"]);
  const doctor = step(failed, "doctor");
  expect(String(doctor.output)).toContain("the fake doctor found something");
  const problem = doctor.problem as Row;
  expect(typeof problem.code).toBe("string");
  expect(String(problem.fix).toLowerCase()).toContain("retry");

  const noConfirm = await api(s.ui, `/api/add-project/runs/${id}/retry`, { method: "POST", body: {} });
  expect(noConfirm.status).toBe(400);
  expect(noConfirm.json.code).toBe("confirm_needed");

  writeFileSync(s.doctorFile, "0");
  const retry = await api(s.ui, `/api/add-project/runs/${id}/retry`, { method: "POST", body: { confirm: true } });
  expect(retry.status, JSON.stringify(retry.json)).toBe(202);
  const done = await waitRun(s.ui, String((retry.json.run as Row).id));
  expect(done.state, JSON.stringify(done)).toBe("done");
  expect(step(done, "doctor").state).toBe("done");
  const gh = ghCalls(s.p);
  expect(gh.filter((l) => l.startsWith("gh repo clone")).length).toBe(1);
  expect(gh.filter((l) => l.startsWith("gh pr create")).length).toBe(1);
  expect(factoryCalls(s.p).filter((l) => l === "init").length).toBe(1);
  expect(factoryCalls(s.p).filter((l) => l === "doctor").length).toBe(2);

  const again = await api(s.ui, `/api/add-project/runs/${id}/retry`, { method: "POST", body: { confirm: true } });
  expect(again.status).toBe(409);
  expect(again.json.code).toBe("ui_add_not_failed");
}, T);

// --- folder ------------------------------------------------------------------------------------------------------------

function folderRepo(s: Setup, name: string): string {
  const dir = join(s.folder, name);
  mkRepo(dir);
  writeExe(join(dir, "factory"), FACTORY_SCRIPT);
  if (name === "mine") write(join(dir, ".claude", "factory.json"), '{"keep":"me","protected":["docs/"]}\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "files");
  const bare = join(s.remotes, "acme", `${name}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "origin", "main");
  return dir;
}

test("folder: an existing clean git repo is set up with no gh repo call", async () => {
  const s = await setup();
  const dir = folderRepo(s, "mine");
  const run = await waitRun(s.ui, await start(s, req(s, { source: "folder", repo: "", path: dir })));
  expect(run.state, JSON.stringify(run)).toBe("done");
  expect(step(run, "repo").state).toBe("done");
  expect(run.project).toBe("mine");
  expect(ghCalls(s.p).filter((l) => /^gh repo /.test(l))).toEqual([]);
  // the repo already has a factory.json, so install.sh only keeps it (it is "set up"): its other keys and protected entries stay
  const cfg = readJson<Row>(join(dir, ".claude", "factory.json"));
  expect(cfg.keep).toBe("me");
  expect(cfg.agents).toEqual(["menelik", "taytu"]);
  expect([...(cfg.protected as string[])].sort()).toEqual(["^docs/", "^secrets/", "docs/"]);
  expect(factoryCalls(s.p)).toContain("init");
}, T);

test("folder on a feature branch: the setup branch starts from the main branch on GitHub, without the feature's commits", async () => {
  const s = await setup();
  const dir = folderRepo(s, "mine");
  git(dir, "checkout", "-q", "-b", "feature");
  write(join(dir, "feature.txt"), "work in progress\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feature work");
  const run = await waitRun(s.ui, await start(s, req(s, { source: "folder", repo: "", path: dir })));
  expect(run.state, JSON.stringify(run)).toBe("done");
  expect(git(dir, "log", "--format=%s", "origin/main..origin/factory/setup").trim().split("\n")).toEqual(["Set up the factory"]);
}, T);

test("protected paths: a file is matched whole, a folder as a prefix, and regex characters are taken as they are", async () => {
  const s = await setup();
  const dir = folderRepo(s, "mine");
  const run = await waitRun(s.ui, await start(s, req(s, { source: "folder", repo: "", path: dir,
    protected: ["factory", ".claude/", "src/(old)/", "a+b.ts"] })));
  expect(run.state, JSON.stringify(run)).toBe("done");
  const prot = readJson<Row>(join(dir, ".claude", "factory.json")).protected as string[];
  expect(prot).toEqual(["docs/", "^factory$", "^\\.claude/", "^src/\\(old\\)/", "^a\\+b\\.ts$"]);
  for (const p of prot) expect(() => new RegExp(p)).not.toThrow();
  expect(prot.some((p) => new RegExp(p).test("src/factory.ts"))).toBe(false);
}, T);

test("protected paths: one with a leading / is refused with ui_add_protected", async () => {
  const s = await setup();
  const r = await api(s.ui, "/api/add-project/check", { method: "POST", body: req(s, { protected: ["/etc/"] }) });
  expect(r.status).toBe(400);
  expect(r.json.code).toBe("ui_add_protected");
  expect(String(r.json.fix)).toMatch(/without a leading \//);
}, T);

test("folder: a repo with uncommitted changes is refused with ui_add_dirty and nothing is touched", async () => {
  const s = await setup();
  const dir = folderRepo(s, "mine");
  write(join(dir, "factory"), FACTORY_SCRIPT + "# edited\n", 0o755);
  const r = await api(s.ui, "/api/add-project", { method: "POST", body: { confirm: true, ...req(s, { source: "folder", path: dir }) } });
  expect(r.status).toBe(400);
  expect(r.json.code).toBe("ui_add_dirty");
  expect(existsSync(join(dir, ".claude", "hooks"))).toBe(false);
  expect(ghCalls(s.p)).toEqual([]);
}, T);

test("clone or new into a checkout of the repo with an untracked file: ui_add_dirty, nothing is touched or pushed", async () => {
  const s = await setup();
  const dir = folderRepo(s, "shop");
  write(join(dir, ".env"), "SECRET=1\n");
  for (const source of ["clone", "new"]) {
    const r = await api(s.ui, "/api/add-project", { method: "POST", body: { confirm: true, ...req(s, { source, path: dir }) } });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.code).toBe("ui_add_dirty");
  }
  expect(existsSync(join(dir, ".claude", "hooks"))).toBe(false);
  expect(ghCalls(s.p)).toEqual([]);
  expect(git(dir, "ls-remote", "--heads", "origin").trim().split("\n").filter(Boolean)).toHaveLength(1);
}, T);

test("check: a main branch that starts with a dash or is the setup branch is refused with ui_add_branch", async () => {
  const s = await setup();
  for (const mainBranch of ["-main", ".main", "factory/setup"]) {
    const r = await check(s, req(s, { mainBranch }));
    expect(r.status, `${mainBranch} -> ${JSON.stringify(r.json)}`).toBe(400);
    expect(r.json.code).toBe("ui_add_branch");
  }
  const ok = await check(s, req(s, { mainBranch: "release/2" }));
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
}, T);

test("folder: a subfolder of a checkout is refused with ui_add_not_top; a symlink to the top is accepted", async () => {
  const s = await setup();
  const dir = folderRepo(s, "mine");
  mkdirSync(join(dir, "sub"));
  write(join(dir, "sub", "keep.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "sub");
  const r = await check(s, req(s, { source: "folder", repo: "", path: join(dir, "sub") }));
  expect(r.status, JSON.stringify(r.json)).toBe(400);
  expect(r.json.code).toBe("ui_add_not_top");
  expect(String(r.json.fix)).toContain(dir);
  const link = join(s.folder, "mine-link");
  symlinkSync(dir, link);
  const ok = await check(s, req(s, { source: "folder", repo: "", path: link }));
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
}, T);

test("the setup pull request step fails when the main branch can't be fetched, and nothing is pushed", async () => {
  const s = await setup();
  const dir = folderRepo(s, "mine");
  git(dir, "remote", "set-url", "origin", join(s.remotes, "acme", "gone.git"));
  const run = await waitRun(s.ui, await start(s, req(s, { source: "folder", repo: "", path: dir })));
  expect(run.state).toBe("failed");
  expect(step(run, "commit").state).toBe("failed");
  expect(String((step(run, "commit").problem as Row).code)).toBe("ui_add_fetch");
  expect(git(dir, "branch", "--show-current").trim()).toBe("main");
  expect(ghCalls(s.p).filter((l) => l.startsWith("gh pr create"))).toEqual([]);
}, T);

// --- new---------------------------------------------------------------------------------------------------------------

test("new: gh repo view says it is missing, so gh repo create --private --add-readme runs, then the clone", async () => {
  const s = await setup();
  const run = await waitRun(s.ui, await start(s, req(s, { source: "new", repo: "acme/fresh", path: join(s.folder, "fresh") })));
  expect(run.state, JSON.stringify(run)).toBe("done");
  const gh = ghCalls(s.p);
  const at = (prefix: string) => gh.findIndex((l) => l.startsWith(prefix));
  expect(at("gh repo view acme/fresh --json name")).toBeGreaterThanOrEqual(0);
  const create = gh[at("gh repo create acme/fresh")] as string;
  expect(create).toContain("--private");
  expect(create).toContain("--add-readme");
  expect(at("gh repo view")).toBeLessThan(at("gh repo create"));
  expect(at("gh repo create")).toBeLessThan(at("gh repo clone"));
  expect(gh).toContain(`gh repo clone acme/fresh ${join(s.folder, "fresh")}`);
}, T);

test("new: visibility public passes --public", async () => {
  const s = await setup();
  const run = await waitRun(s.ui, await start(s, req(s, { source: "new", repo: "acme/open", visibility: "public", path: join(s.folder, "open") })));
  expect(run.state, JSON.stringify(run)).toBe("done");
  const create = ghCalls(s.p).find((l) => l.startsWith("gh repo create acme/open")) as string;
  expect(create).toContain("--public");
  expect(create).not.toContain("--private");
}, T);

test("new: when the repo already exists nothing is created, it is only cloned", async () => {
  const s = await setup();
  write(join(s.p.root, "remote-list"), "acme/fresh\n");
  const run = await waitRun(s.ui, await start(s, req(s, { source: "new", repo: "acme/fresh", path: join(s.folder, "fresh") })));
  expect(run.state, JSON.stringify(run)).toBe("done");
  const gh = ghCalls(s.p);
  expect(gh.some((l) => l.startsWith("gh repo create"))).toBe(false);
  expect(gh).toContain(`gh repo clone acme/fresh ${join(s.folder, "fresh")}`);
}, T);

// --- busy --------------------------------------------------------------------------------------------------------------

test("a second start while one is running is 409 ui_add_busy, and the first still finishes", async () => {
  const s = await setup();
  writeFileSync(s.hold, "1");
  const id = await start(s, req(s));
  const mid = await api(s.ui, `/api/add-project/runs/${id}`);
  expect(mid.status).toBe(200);
  expect((mid.json.run as Row).state).toBe("running");
  const second = await api(s.ui, "/api/add-project", { method: "POST", body: { confirm: true, ...req(s, {}, "other") } });
  expect(second.status).toBe(409);
  expect(second.json.code).toBe("ui_add_busy");
  expect(typeof second.json.fix).toBe("string");
  rmSync(s.hold);
  const run = await waitRun(s.ui, id);
  expect(run.state, JSON.stringify(run)).toBe("done");
  expect(ghCalls(s.p).filter((l) => l.startsWith("gh repo clone")).length).toBe(1);
  expect(sh(["ls", s.folder]).stdout).not.toContain("other");
}, T);

test("check: a folder with no origin is refused with ui_add_no_remote, before anything runs (#546)", async () => {
  const s = await setup();
  const lone = mkRepo(join(s.folder, "lone"));
  const r = await check(s, req(s, { source: "folder", repo: "", path: lone }));
  expect(r.status, JSON.stringify(r.json)).toBe(400);
  expect(r.json.code).toBe("ui_add_no_remote");
  expect(String(r.json.message)).toContain("has no remote called origin");
  expect(String(r.json.fix)).toContain("git remote add origin");
  const started = await api(s.ui, "/api/add-project", { method: "POST", body: { confirm: true, ...req(s, { source: "folder", repo: "", path: lone }) } });
  expect(started.status).toBe(400);
  expect(started.json.code).toBe("ui_add_no_remote");
  expect(existsSync(join(lone, ".claude", "hooks"))).toBe(false);
  expect(ghCalls(s.p)).toEqual([]);
}, T);
