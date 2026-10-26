// The per-machine heartbeat daemon (#108): real agent liveness (working, waiting, idle, down), written to GitHub only
// on change plus a keepalive, and a live `factory agents ls`.
//
// A fake `gh` (it also logs every call), a fake `tmux`, and real processes standing in for a loop and for its
// `factory wait` child. Time is fake: FACTORY_NOW moves by hand, so hours of daemon cycles take a moment. The Python
// test ran a cycle in its own process with the world's environment; here a short Bun process does it, with the same
// environment, folder and clock. (test_doctor_notes_a_missing_daemon_and_agents_cannot_install_or_stop_it stays in
// test_heartbeat.py until factory_doctor is ported.)
import { afterEach, expect, test } from "bun:test";
import { existsSync, renameSync, symlinkSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import * as H from "../hooks/factory_heartbeat.ts";
import { type Env, hook as autostartHook, log as aLog, machine, parsePlist, project } from "./autostart_support.ts";
import { FAKE_GH, type IssueRow, issue, setup } from "./issues_support.ts";
import { HOOKS, type Proc, read, runHook, SF, sh, tmp, write, writeExe } from "./support.ts";

const FAKE_TMUX = `#!/bin/sh
case "$1" in
  list-sessions) [ -f "$FAKE_TMUX_DIR/sessions" ] || exit 1; cat "$FAKE_TMUX_DIR/sessions" ;;
  capture-pane)
    while [ $# -gt 0 ]; do case "$1" in -t) t="\${2#=}"; shift ;; esac; shift; done
    [ -f "$FAKE_TMUX_DIR/$t.pane" ] && cat "$FAKE_TMUX_DIR/$t.pane" ;;
esac
`;

const GH_LOGGER = '#!/bin/sh\necho "$*" >>"$FAKE_LOG/gh.log"\nexec "$(dirname "$0")/gh.real" "$@"\n';

const WORKER = String.raw`import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const hooks = __HOOKS__;
const H = await import(join(hooks, "factory_heartbeat.ts"));
const FA = await import(join(hooks, "factory_agents.ts"));
const { load } = await import(join(hooks, "factory_config.ts"));
const box = process.argv[2] as string;
for (let n = 1; ; n++) {
  const req = join(box, "req-" + n + ".json");
  while (!existsSync(req)) Bun.sleepSync(5);
  const { env, cwd, code } = JSON.parse(readFileSync(req, "utf8"));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  process.chdir(cwd);
  let out;
  try {
    const value = new Function("H", "FA", "load", code)(H, FA, load);
    out = { ok: true, value: value === undefined ? null : value };
  } catch (e) {
    out = { ok: false, error: String(e && e.stack || e) + (e && e.text ? " " + e.text : "") };
  }
  writeFileSync(join(box, "res-" + n + ".json.tmp"), JSON.stringify(out));
  renameSync(join(box, "res-" + n + ".json.tmp"), join(box, "res-" + n + ".json"));
}
`;

function iso(epoch: number): string {
  return new Date(Math.floor(epoch) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface Db { issues: IssueRow[] }

function loadDb(db: string): Db {
  return JSON.parse(read(db)) as Db;
}

/** The key=value pairs of an agent issue's hidden marker. */
function marker(db: string, n: number): Record<string, string> {
  const body = (loadDb(db).issues.find((i) => i.number === n) as IssueRow).body;
  const inner = (/<!--\s*factory-agent\s+([\s\S]*?)\s*-->/.exec(body) as RegExpExecArray)[1] as string;
  return Object.fromEntries(inner.split(/\s+/).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
}

function issueOf(db: string, n: number): IssueRow {
  return loadDb(db).issues.find((i) => i.number === n) as IssueRow;
}

interface Loop { pid: number; kill(): void }

/** One project with a fake gh, a fake tmux, this machine's config, and a clock that moves by hand. */
class World {
  static AGENT_ISSUE = 99;
  readonly d: string;
  readonly db: string;
  readonly env: Env;
  readonly repo: string;
  clock: number;
  readonly logDir = tmp();
  readonly tmuxDir = tmp();
  readonly stateHome = tmp();
  readonly configDir = tmp();
  readonly agent: string;
  procs: Loop[] = [];

  constructor({ issues = [] as IssueRow[], agent = "taytu", tasks = {} as Record<string, unknown>, status = "idle", agentIssue = true } = {}) {
    const [d, db, env] = setup(issues);
    this.d = d;
    this.db = db;
    const real = join(d, "bin", "gh");
    renameSync(real, real + ".real");
    writeExe(real, GH_LOGGER);
    writeExe(join(d, "bin", "tmux"), FAKE_TMUX);
    this.repo = basename(d);
    this.clock = Math.floor(Date.now() / 1000);
    write(join(this.configDir, this.repo + ".json"), JSON.stringify({ agents: [agent] }));
    write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues", ...tasks }, agents: ["menelik", "taytu", "haile"] }));
    sh(["git", "init", "-q", d]); // the Python test's project had its .git from the claims file folder; git rev-parse needs one
    this.env = { ...env, FACTORY_MACHINE_ID: "aaaa1111", FACTORY_CONFIG_DIR: this.configDir, XDG_STATE_HOME: this.stateHome,
      FAKE_LOG: this.logDir, FAKE_TMUX_DIR: this.tmuxDir, FACTORY_NOW: String(this.clock), FACTORY_HEARTBEAT_SECONDS: "20" };
    for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"]) delete this.env[k];
    this.agent = agent;
    if (agentIssue) this.addAgentIssue(World.AGENT_ISSUE, agent, status, null, "aaaa1111", true);
  }

  // --- the clock -------------------------------------------------------------------------------------------
  advance(seconds: number): void {
    this.clock += seconds;
    this.env.FACTORY_NOW = String(this.clock);
  }

  // --- GitHub ----------------------------------------------------------------------------------------------
  addAgentIssue(n: number, name: string, status: string, ping: number | null = null, machineId: string | null = "aaaa1111",
    hb = false, fields: Record<string, string> = {}): void {
    const pairs: Record<string, string> = { name, status, ping: iso(ping ?? this.clock), ...(machineId ? { machine: machineId } : {}),
      ...(hb ? { hb: "1" } : {}), ...fields };
    const body = "<!-- factory-agent " + Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(" ") + " -->\n**Status:** x";
    const db = loadDb(this.db);
    db.issues.push({ number: n, title: `Agent: ${name} · ${status}`, body, state: "open", labels: [{ name: "factory:agent" }],
      milestone: null, updated_at: "2020-01-01T00:00:00Z" });
    write(this.db, JSON.stringify(db));
  }

  ghCalls(): string[] {
    try {
      return read(join(this.logDir, "gh.log")).split("\n").filter((l) => l);
    } catch {
      return [];
    }
  }

  /** The PATCH calls made on GitHub (all issues, or issue n). */
  patches(n: number | null = null): string[] {
    return this.ghCalls().filter((l) => l.includes("-X PATCH") && (n === null || (l + " ").includes(`/issues/${n} `)));
  }

  // --- a loop and what it waits for -------------------------------------------------------------------------
  /** A live process that `ps` shows as a factory-loop.sh, with a `factory_wait.py <args>` child when `wait`. */
  startLoop(agent: string | null = null, wait: string | null = null): Loop {
    const name = agent ?? this.agent;
    const folder = tmp();
    writeExe(join(folder, "factory_wait.py"), "#!/bin/sh\nsleep 600\n");
    const child = wait ? `"$D/factory_wait.py" ${wait} &\n` : "";
    const script = writeExe(join(folder, "factory-loop.sh"), `#!/bin/sh\nD=$(dirname "$0")\n${child}sleep 600 &\nwait\n`);
    const p = Bun.spawn(["setsid", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const loop: Loop = { pid: p.pid, kill: () => {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        // gone already
      }
    } };
    this.procs.push(loop);
    this.claimCheckout(name, p.pid);
    Bun.sleepSync(300); // let the shell start its children
    return loop;
  }

  close(): void {
    for (const p of this.procs) p.kill();
    this.worker?.kill();
  }

  claimsFile(): string {
    return join(this.d, ".git", "factory", "claims.json");
  }

  claims(): { checkouts: Record<string, Record<string, unknown>>; tasks: Record<string, Record<string, unknown>> } {
    try {
      return JSON.parse(read(this.claimsFile()));
    } catch {
      return { checkouts: {}, tasks: {} };
    }
  }

  saveClaims(data: unknown): void {
    write(this.claimsFile(), JSON.stringify(data));
  }

  claimCheckout(agent: string, pid: number): void {
    const data = this.claims();
    data.checkouts[agent] = { agent, pid, host: hostname(), at: Date.now() / 1000, path: this.d };
    this.saveClaims(data);
  }

  claimTask(task: string, agent: string | null = null): void {
    const data = this.claims();
    const name = agent ?? this.agent;
    data.tasks[task] = { agent: name, pid: data.checkouts[name]?.pid, host: hostname(), at: Date.now() / 1000 };
    this.saveClaims(data);
  }

  dropTask(task: string): void {
    const data = this.claims();
    delete data.tasks[task];
    this.saveClaims(data);
  }

  // --- tmux ------------------------------------------------------------------------------------------------
  tmuxSession(agent: string | null = null, activity: number | null = null, pane = ""): void {
    const name = `${this.repo}-${agent ?? this.agent}`;
    const f = join(this.tmuxDir, "sessions");
    write(f, (existsSync(f) ? read(f) : "") + `${name} ${Math.floor(activity ?? this.clock)}\n`);
    write(join(this.tmuxDir, name + ".pane"), pane);
  }

  // --- running the code in the project's environment ---------------------------------------------------------
  // The Python test ran the daemon's cycle in its own process with the world's environment and folder. Here one Bun
  // worker per world plays that part: the same process for every cycle (so the daemon's boot happens once, as in a
  // real daemon), with the environment and folder set before each call. Calls go through files, so the test stays
  // synchronous.
  private worker: { kill(): void } | null = null;
  private calls = 0;
  private readonly box = tmp();

  /** Run a function body in the worker with H (factory_heartbeat), FA (factory_agents) and load in scope; its return value. */
  here(code: string): unknown {
    if (!this.worker) {
      const script = write(join(this.box, "worker.ts"), WORKER.replace("__HOOKS__", JSON.stringify(HOOKS)));
      const p = Bun.spawn([process.execPath, "--no-env-file", script, this.box], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
      this.worker = { kill: () => p.kill(9) };
    }
    const n = ++this.calls;
    write(join(this.box, `req-${n}.json.tmp`), JSON.stringify({ env: this.env, cwd: this.d, code }));
    renameSync(join(this.box, `req-${n}.json.tmp`), join(this.box, `req-${n}.json`));
    const res = join(this.box, `res-${n}.json`);
    const deadline = Date.now() + 120_000;
    while (!existsSync(res)) {
      if (Date.now() > deadline) throw new Error(`the worker did not answer call ${n}`);
      Bun.sleepSync(5);
    }
    const got = JSON.parse(read(res)) as { ok: boolean; value?: unknown; error?: string };
    if (!got.ok) throw new Error(got.error);
    return got.value;
  }

  cycle(): void {
    this.here("H.cycle(load());");
  }

  runFor(seconds: number, step = 20): void {
    for (let i = 0; i < Math.floor(seconds / step); i++) {
      this.advance(step);
      this.cycle();
    }
  }

  sweep(): string[] {
    return this.here("return FA.sweep(load());") as string[];
  }

  stateFile(): string {
    return join(this.stateHome, this.repo + "-factory", "heartbeat.json");
  }

  cli(script: string, args: string[], stdin?: string, extra: Env = {}): Proc {
    return runHook(script, args, { cwd: this.d, env: { ...this.env, ...extra }, input: stdin, timeoutMs: 120_000 });
  }
}

const worlds: World[] = [];
afterEach(() => {
  while (worlds.length) (worlds.pop() as World).close();
});

function world(opts: ConstructorParameters<typeof World>[0] = {}): World {
  const w = new World(opts);
  worlds.push(w);
  return w;
}

// --- reading what is running: waits, and the follow link ----------------------------------------------------------

test("what an agent waits for is read from the command it runs", () => {
  const cases: Record<string, [string, string]> = {
    "python3 /p/.claude/hooks/factory_wait.py ci 12": ["ci:12", "CI on PR #12"],
    "python3 /p/.claude/hooks/factory_wait.py answer 7 45": ["answer:7", "an answer on PR #7"],
    "python3 /p/.claude/hooks/factory_wait.py slot": ["slot", "a free PR slot"],
    "python3 /p/.claude/hooks/factory_wait.py ready 20": ["ready", "a ready task"],
    "bash /p/.claude/hooks/wait_for_merge.sh 33 30": ["merge:33", "the merge of PR #33"],
    "bash /p/factory wait 33": ["merge:33", "the merge of PR #33"],
    "bash /p/factory wait ci 5 10": ["ci:5", "CI on PR #5"],
    "bash /p/factory wait slot": ["slot", "a free PR slot"],
  };
  for (const [args, [on, text]] of Object.entries(cases)) {
    const got = H.parseWait(args);
    expect([got?.on, got?.text], args).toEqual([on, text]);
  }
  for (const args of ["python3 factory_wait.py precheck", "bash /p/factory next", "sleep 30", "python3 factory_agents.py ping"]) {
    expect(H.parseWait(args), args).toBeNull();
  }
});

test("a wait counts only below the agents own process", () => {
  const procs: H.Procs = new Map([[100, [1, "bash factory-loop.sh"]], [101, [100, "claude --remote-control haile 42"]],
    [102, [101, "bash -c factory wait ci 12"]], [103, [102, "python3 factory_wait.py ci 12"]],
    [200, [1, "bash factory-loop.sh"]], [201, [200, "python3 factory_wait.py slot"]]]);
  expect(H.waitsInTree(procs, 100)?.on).toBe("ci:12");
  expect(H.waitsInTree(procs, 200)?.on).toBe("slot");
  expect(H.waitsInTree(new Map([[100, [1, "bash factory-loop.sh"]], [101, [100, "claude"]]]), 100)).toBeNull();
  expect(H.waitsInTree(procs, 999)).toBeNull();
});

test("the remote control link is read from the pane", () => {
  const pane = "Claude Code\n/remote-control is active · https://claude.ai/code/session_01AbC-xyz_9\nmore text\n";
  expect(H.followUrl(pane)).toBe("https://claude.ai/code/session_01AbC-xyz_9");
  expect(H.followUrl("see https://evil.example/code/session_1 and https://claude.ai.evil.example/code/x")).toBeNull();
  expect(H.followUrl("")).toBeNull();
});

// --- the state ------------------------------------------------------------------------------------------------

test("state comes from the process the task and the wait", () => {
  expect(H.derive({ alive: false, task: "issue-42", wait: null }).state).toBe("down");
  expect(H.derive({ alive: false, task: null, wait: { on: "slot", text: "a free PR slot" } }).state).toBe("down");
  let got = H.derive({ alive: true, task: null, wait: null });
  expect([got.state, got.detail]).toEqual(["idle", "idle"]);
  got = H.derive({ alive: true, task: "issue-42", wait: null });
  expect([got.state, got.detail, got.task]).toEqual(["working", "working on #42", "42"]);
  got = H.derive({ alive: true, task: "3.2", wait: null });
  expect([got.detail, got.task]).toEqual(["working on 3.2", "3.2"]);
  got = H.derive({ alive: true, task: "issue-42", wait: { on: "ci:12", text: "CI on PR #12" } });
  expect([got.state, got.detail, got.on, got.task]).toEqual(["waiting", "waiting for CI on PR #12", "ci:12", "42"]);
});

// --- when to write ----------------------------------------------------------------------------------------------

function rep(key = "idle", ping = 0, writes: number[] = [], cand: H.Candidate | null = null) {
  return { key, ping, writes: [...writes], cand };
}

test("an unchanged state is written only as a keepalive", () => {
  const cfg = { tasks: { pingMinutes: 5 } };
  expect(H.plan("idle", rep("idle", 1000), 1000 + 299, cfg, 15).write).toBe(false);
  const got = H.plan("idle", rep("idle", 1000), 1000 + 300, cfg, 15);
  expect([got.write, got.why]).toEqual([true, "keepalive"]);
});

test("a change is written once it has lasted a few seconds", () => {
  const cfg = { tasks: { pingMinutes: 5 } };
  const first = H.plan("waiting", rep("idle", 1000), 1010, cfg, 15);
  expect(first.write).toBe(false);
  expect(first.cand).toEqual({ key: "waiting", at: 1010 });
  const second = H.plan("waiting", rep("idle", 1000, [], first.cand), 1030, cfg, 15);
  expect([second.write, second.why]).toEqual([true, "change"]);
  const flicker = H.plan("idle", rep("idle", 1000, [], first.cand), 1030, cfg, 15); // it went away again
  expect([flicker.write, flicker.cand]).toEqual([false, null]);
});

test("flapping never writes more than twelve times an hour but down always goes out", () => {
  const cfg = { tasks: { pingMinutes: 5 } };
  const r = rep("idle", 0);
  const writes: number[] = [];
  let now = 0;
  for (let step = 0; step < (3 * 3600) / 20; step++) { // three hours, a cycle every 20 s, the state changes every 60 s
    now += 20;
    const key = Math.floor(step / 3) % 2 ? "working" : "waiting";
    const got = H.plan(key, r, now, cfg, 15);
    r.cand = got.cand;
    if (got.write) {
      writes.push(now);
      Object.assign(r, { key, ping: now, writes: [...r.writes.filter((t) => now - t < 3600), now], cand: null });
    }
  }
  expect(writes.length).toBeGreaterThan(12); // it never wrote enough to test the cap
  for (const t of writes) expect(writes.filter((w) => t - 3600 < w && w <= t).length).toBeLessThanOrEqual(12);
  let down = H.plan("down", r, now + 20, cfg, 15);
  down = H.plan("down", { ...r, cand: down.cand }, now + 40, cfg, 15);
  expect(down.write).toBe(true); // even when the hour's budget is spent
});

// --- the daemon, end to end -------------------------------------------------------------------------------------

test("an agent waiting in a wait for forty five minutes shows waiting and is not swept", () => {
  const w = world({ issues: [issue(1, ["factory:in-progress", "agent:taytu"])] });
  w.startLoop(null, "slot");
  w.claimTask("issue-1");
  w.runFor(45 * 60);
  const m = marker(w.db, World.AGENT_ISSUE);
  expect([m.status, m.on, m.task, m.hb]).toEqual(["waiting", "slot", "1", "1"]);
  expect(issueOf(w.db, World.AGENT_ISSUE).title).toBe("Agent: taytu · waiting for a free PR slot");
  expect(w.sweep()).toEqual([]); // a live, waiting agent was swept
  expect(issueOf(w.db, 1).labels.map((l) => l.name)).toEqual(["factory:in-progress", "agent:taytu"]);
  const out = w.cli("factory_agents", ["list"]).stdout;
  expect(out).toContain(" waiting ");
  expect(out).not.toContain("silent");
  expect(w.patches(World.AGENT_ISSUE).length).toBeLessThanOrEqual(11); // one change, then keepalives
});

test("killing the session shows down within two minutes and then stays quiet", () => {
  const w = world();
  const p = w.startLoop();
  w.claimTask("issue-5");
  w.runFor(120);
  expect(marker(w.db, World.AGENT_ISSUE).status).toBe("working");
  const died = w.clock;
  p.kill();
  Bun.sleepSync(200);
  let seen: number | null = null;
  for (let i = 0; i < 6; i++) {
    w.advance(20);
    w.cycle();
    if (marker(w.db, World.AGENT_ISSUE).status === "down") {
      seen = w.clock - died;
      break;
    }
  }
  expect(seen).not.toBeNull();
  expect(seen as number).toBeLessThanOrEqual(120);
  expect(issueOf(w.db, World.AGENT_ISSUE).labels.map((l) => l.name)).toContain("factory:agent-down");
  const before = w.patches().length;
  w.runFor(600);
  expect(w.patches().length).toBe(before); // kept writing after down
});

test("working and idle follow the task claim and a write is one patch", () => {
  const w = world();
  w.startLoop();
  w.runFor(60);
  expect(marker(w.db, World.AGENT_ISSUE).status).toBe("idle");
  w.claimTask("issue-8");
  const n = w.ghCalls().length;
  w.runFor(60);
  const m = marker(w.db, World.AGENT_ISSUE);
  expect([m.status, m.task, "since" in m]).toEqual(["working", "8", true]);
  expect(issueOf(w.db, World.AGENT_ISSUE).title).toBe("Agent: taytu · working on #8");
  const added = w.ghCalls().slice(n);
  expect(added.length, added.join("\n")).toBe(1); // no label calls for a change between live states
  expect(added[0]).toContain("-X PATCH");
});

test("a state that lasts less than the confirm time is not written", () => {
  const w = world();
  w.startLoop();
  w.runFor(40);
  const n = w.patches().length;
  w.claimTask("issue-8");
  w.advance(5);
  w.cycle(); // seen once, just now: not yet
  expect(w.patches().length).toBe(n);
  w.dropTask("issue-8");
  w.runFor(60);
  expect(w.patches().length).toBe(n);
  expect(marker(w.db, World.AGENT_ISSUE).status).toBe("idle");
});

test("writes per agent stay within twelve an hour even when the agent changes state all the time", () => {
  const w = world();
  w.startLoop();
  const history: [number, number][] = []; // (clock, patches so far)
  for (let step = 0; step < (2 * 3600) / 20; step += 6) {
    if (Math.floor(step / 6) % 2) w.claimTask("issue-3");
    else w.dropTask("issue-3");
    for (let k = 0; k < 6; k++) {
      w.advance(20);
      w.cycle();
      history.push([w.clock, w.patches(World.AGENT_ISSUE).length]);
    }
  }
  expect((history[history.length - 1] as [number, number])[1]).toBeGreaterThan(12); // it never changed state often enough
  for (const [t, count] of history) {
    const then = Math.max(0, ...history.filter(([tt]) => tt <= t - 3600).map(([, c]) => c));
    expect(count - then).toBeLessThanOrEqual(12);
  }
}, 600_000);

test("a boot marks this machines dead agents down at once and leaves other machines alone", () => {
  const w = world({ agentIssue: false });
  w.addAgentIssue(50, "taytu", "working", w.clock - 3600, "aaaa1111");
  w.addAgentIssue(51, "haile", "working", w.clock - 60, "bbbb2222");
  w.cycle();
  expect(marker(w.db, 50).status).toBe("down");
  expect(marker(w.db, 51).status).toBe("working");
  const before = w.patches().length;
  w.runFor(120);
  expect(w.patches().length).toBe(before);
});

test("a machine that never ran an agent writes nothing", () => {
  const w = world({ agentIssue: false });
  w.runFor(120);
  expect(w.patches()).toEqual([]);
  expect(w.ghCalls().filter((l) => l.includes("-X POST"))).toEqual([]);
  expect(w.ghCalls().length).toBeLessThanOrEqual(1); // at most the one look at the agent issues when it starts
});

test("reach information goes to github only with show where", () => {
  const pane = "/remote-control is active · https://claude.ai/code/session_01Q\n";
  for (const show of [false, true]) {
    const w = world({ tasks: { showWhere: show } });
    w.startLoop();
    w.tmuxSession(null, null, pane);
    w.runFor(60);
    const m = marker(w.db, World.AGENT_ISSUE);
    if (show) {
      expect([m.session, m.follow]).toEqual([`${w.repo}-taytu`, "https://claude.ai/code/session_01Q"]);
    } else {
      expect("session" in m || "follow" in m || "where" in m).toBe(false);
      expect(issueOf(w.db, World.AGENT_ISSUE).body).not.toContain("claude.ai");
    }
    const local = (JSON.parse(read(w.stateFile())) as { agents: Record<string, Record<string, unknown>> }).agents.taytu;
    expect([local?.follow, local?.session]).toEqual(["https://claude.ai/code/session_01Q", `${w.repo}-taytu`]);
    w.close();
  }
});

test("the local file says what the daemon saw", () => {
  const w = world();
  w.startLoop(null, "ci 12");
  w.claimTask("issue-4");
  w.tmuxSession(null, w.clock - 30);
  w.runFor(40);
  const data = JSON.parse(read(w.stateFile())) as Record<string, unknown> & { agents: Record<string, Record<string, unknown>> };
  expect([data.machine, data.updated, data.interval]).toEqual(["aaaa1111", w.clock, 20]);
  const a = data.agents.taytu as Record<string, unknown>;
  expect([a.state, a.task, a.on, a.kind]).toEqual(["waiting", "4", "ci:12", "coding-agent"]);
  expect(a.activity as number).toBeGreaterThanOrEqual(w.clock - 80);
});

test("the daemon runs once per project and a second copy says so", async () => {
  const w = world();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...w.env, FACTORY_HEARTBEAT_SECONDS: "5" })) if (v !== undefined) env[k] = v;
  const first = Bun.spawn([process.execPath, "--no-env-file", join(HOOKS, "factory_heartbeat.ts"), "run"],
    { cwd: w.d, env, stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 100 && !existsSync(w.stateFile()); i++) await Bun.sleep(100);
    expect(existsSync(w.stateFile())).toBe(true); // the daemon wrote no state file
    const second = runHook("factory_heartbeat", ["run"], { cwd: w.d, env, timeoutMs: 30_000 });
    expect(second.code, second.out).toBe(1);
    const lines = second.stderr.trim().split("\n");
    const err = JSON.parse(lines[lines.length - 1] as string) as Record<string, string>;
    expect(err.code).toBe("heartbeat-running");
    expect(err.fix).toBeTruthy();
  } finally {
    first.kill("SIGTERM");
    await first.exited;
  }
});

test("a github failure is retried later and never stops the daemon", () => {
  const w = world();
  w.startLoop();
  w.claimTask("issue-2");
  renameSync(w.db, w.db + ".gone"); // the fake gh now fails
  w.runFor(60);
  expect((JSON.parse(read(w.stateFile())) as { agents: Record<string, { state: string }> }).agents.taytu?.state).toBe("working");
  renameSync(w.db + ".gone", w.db);
  w.runFor(120);
  expect(marker(w.db, World.AGENT_ISSUE).status).toBe("working");
});

// --- the other writers step aside -------------------------------------------------------------------------------

function hook(w: World, event: string, agent = "taytu"): Proc {
  return w.cli("factory_agents", ["hook"], JSON.stringify({ hook_event_name: event }), { FACTORY_AGENT: agent });
}

test("hooks leave idle to the daemon while it runs but session end still says down", () => {
  const w = world();
  w.startLoop();
  w.claimTask("issue-2");
  w.runFor(60);
  expect(marker(w.db, World.AGENT_ISSUE).status).toBe("working");
  const n = w.patches().length;
  expect(hook(w, "PostToolUse").code).toBe(0);
  expect(hook(w, "Stop").code).toBe(0); // a turn ends mid-task: the daemon knows it is still working
  Bun.sleepSync(500);
  expect(w.patches().length).toBe(n); // a hook wrote while the daemon is running
  expect(hook(w, "SessionEnd").code).toBe(0);
  expect(marker(w.db, World.AGENT_ISSUE).status).toBe("down");
});

test("hooks write as before when no daemon runs", () => {
  const w = world();
  w.startLoop();
  w.claimTask("issue-2");
  w.runFor(60);
  w.advance(600); // the daemon's file is old now: nobody is running it
  const n = w.patches().length;
  expect(hook(w, "Stop").code).toBe(0);
  expect(w.patches().length).toBe(n + 1);
  expect(marker(w.db, World.AGENT_ISSUE).status).toBe("idle");
});

// --- the sweep uses real liveness -------------------------------------------------------------------------------

test("a silent looking agent that is alive here is not swept", () => {
  const w = world({ issues: [issue(1, ["factory:in-progress", "agent:taytu"])] });
  w.startLoop(null, "ci 3");
  w.claimTask("issue-1");
  w.runFor(60);
  const db = loadDb(w.db);
  const a = db.issues.find((i) => i.number === World.AGENT_ISSUE) as IssueRow;
  a.body = a.body.replace(/ping=\S+/, `ping=${iso(w.clock - 25 * 60)}`);
  write(w.db, JSON.stringify(db));
  const st = w.here(`return FA.stateOf({ tasks: {} }, ${JSON.stringify(issueOf(w.db, World.AGENT_ISSUE))});`) as unknown[];
  expect(st[1]).toBe("silent");
  expect(w.sweep()).toEqual([]); // swept an agent whose process is alive and waiting
  expect(issueOf(w.db, 1).labels.map((l) => l.name)).toEqual(["factory:in-progress", "agent:taytu"]);
});

test("a missed keepalive counts as silent within minutes for a daemon managed agent", () => {
  const w = world({ agentIssue: false });
  w.addAgentIssue(60, "taytu", "working", w.clock - 13 * 60, "aaaa1111", true);
  w.addAgentIssue(61, "haile", "working", w.clock - 13 * 60, "bbbb2222");
  w.addAgentIssue(62, "menelik", "working", w.clock - 11 * 60, "aaaa1111", true);
  const st = (n: number) => (w.here(`return FA.stateOf({ tasks: {} }, ${JSON.stringify(issueOf(w.db, n))});`) as unknown[])[1];
  expect(st(60)).toBe("silent");
  expect(st(61)).toBe("working"); // no daemon: the old 30 minutes
  expect(st(62)).toBe("working");
});

test("sweep gives a down agents task back after a grace period and not before", () => {
  for (const [minutes, released] of [[3, false], [11, true]] as const) {
    const w = world({ issues: [issue(1, ["factory:in-progress", "agent:taytu"])], agentIssue: false });
    w.addAgentIssue(70, "taytu", "down", w.clock - minutes * 60);
    const out = w.sweep();
    const labels = issueOf(w.db, 1).labels.map((l) => l.name);
    if (released) {
      expect(labels).toEqual(["factory:ready"]);
      expect(out[0]).toContain("released #1");
    } else {
      expect(labels).toEqual(["factory:in-progress", "agent:taytu"]);
      expect(out).toEqual([]);
    }
  }
});

test("a cloud agent reports its kind place and link with every ping", () => {
  const w = world({ agentIssue: false });
  const link = "https://claude.ai/code/session_01DEV";
  const p = w.cli("factory_agents", ["register", "--agent", "dev-manager", "--kind", "dev-manager", "--cloud", "--follow", link]);
  expect(p.code, p.out).toBe(0);
  const n = Number(p.stdout.trim().replace(/^#/, ""));
  let m = marker(w.db, n);
  expect([m.kind, m.where, m.follow]).toEqual(["dev-manager", "cloud", link]);
  w.cli("factory_agents", ["ping", "--agent", "dev-manager", "--status", "working on #9", "--force"]);
  m = marker(w.db, n);
  expect([m.follow, m.where, m.status]).toEqual([link, "cloud", "working"]);
  const bad = w.cli("factory_agents", ["register", "--agent", "po", "--cloud", "--follow", "https://evil.example/x --> <b>"]);
  expect(bad.code).not.toBe(0);
  expect(bad.stderr).toContain("follow");
});

// --- factory agents ls ------------------------------------------------------------------------------------------

function ls(w: World, ...args: string[]): Proc {
  return w.cli("factory_agents", ["ls", ...args]);
}

function fleet(w: World): void {
  w.addAgentIssue(80, "haile", "waiting", w.clock - 120, "bbbb2222", true, { kind: "coding-agent", task: "31", on: "ci:44",
    since: iso(w.clock - 900) });
  w.addAgentIssue(81, "dev-manager", "working", w.clock - 60, "", false, { kind: "dev-manager", where: "cloud",
    follow: "https://claude.ai/code/session_01DEV", since: iso(w.clock - 7200) });
}

test("ls shows local agents from the state file and the others from github", () => {
  const w = world();
  fleet(w);
  w.startLoop(null, "ci 12");
  w.claimTask("issue-4");
  w.tmuxSession(null, null, "/remote-control is active · https://claude.ai/code/session_01Q\n");
  w.runFor(60);
  const p = ls(w, "--json");
  expect(p.code, p.out).toBe(0);
  const rows = Object.fromEntries((JSON.parse(p.stdout) as { agents: Record<string, unknown>[] }).agents.map((r) => [r.name, r]));
  const t = rows.taytu as Record<string, unknown>;
  expect([t.state, t.kind, t.where, t.task, t.on]).toEqual(["waiting", "coding agent", "this machine", "4", "ci:12"]);
  expect([t.follow, t.session]).toEqual(["https://claude.ai/code/session_01Q", `${w.repo}-taytu`]);
  expect(Boolean(t.since && t.lastSeen)).toBe(true);
  expect(t.source).toBe("local");
  const h = rows.haile as Record<string, unknown>;
  expect([h.state, h.where, h.task, h.on, h.source]).toEqual(["waiting", "machine bbbb2222", "31", "ci:44", "github"]);
  const c = rows["dev-manager"] as Record<string, unknown>;
  expect([c.kind, c.where, c.follow]).toEqual(["dev manager", "cloud", "https://claude.ai/code/session_01DEV"]);
  const text = ls(w).stdout;
  for (const word of ["taytu", "haile", "dev-manager", "waiting", "cloud", "this machine", "session_01DEV", "session_01Q"]) {
    expect(text).toContain(word);
  }
  expect(text).not.toContain("STATE"); // sentence case, no all-caps labels
  expect(text).toContain("State");
});

test("ls reads this machine without asking github and caches the others", () => {
  const w = world();
  fleet(w);
  w.startLoop();
  w.runFor(40);
  const before = w.ghCalls().length;
  const local = ls(w, "--local");
  expect(local.code, local.out).toBe(0);
  expect(local.stdout).toContain("taytu");
  expect(local.stdout).not.toContain("haile");
  expect(w.ghCalls().length).toBe(before); // --local asked GitHub
  ls(w);
  const asked = w.ghCalls().length;
  expect(asked).toBeGreaterThan(before);
  ls(w);
  expect(w.ghCalls().length).toBe(asked); // a second ls within the cache time asked GitHub again
  w.advance(90);
  ls(w);
  expect(w.ghCalls().length).toBeGreaterThan(asked); // the cache never expired
  const n = w.ghCalls().length;
  ls(w, "--fresh");
  expect(w.ghCalls().length).toBeGreaterThan(n); // --fresh used the cache
});

test("ls still lists this machine when github cannot be reached", () => {
  const w = world();
  w.startLoop();
  w.runFor(40);
  renameSync(w.db, w.db + ".gone");
  const p = ls(w, "--fresh");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("taytu");
  expect(p.stdout).toContain("GitHub");
  const data = JSON.parse(ls(w, "--fresh", "--json").stdout) as { github: { error: string }; agents: { name: string }[] };
  expect(data.github.error).toBeTruthy();
  expect(data.agents.map((r) => r.name)).toEqual(["taytu"]);
});

test("ls without a daemon derives this machine on the spot and says how to start it", () => {
  const w = world({ agentIssue: false });
  w.startLoop();
  w.claimTask("issue-6");
  const p = ls(w, "--local");
  expect(p.stdout).toContain("working");
  expect(p.stdout).toContain("factory heartbeat install");
  expect(existsSync(w.stateFile())).toBe(false); // ls must not write the daemon's file
});

test("ls marks a missed keepalive as silent", () => {
  const w = world({ agentIssue: false });
  w.addAgentIssue(90, "haile", "working", w.clock - 15 * 60, "bbbb2222", true);
  const rows = Object.fromEntries((JSON.parse(ls(w, "--json").stdout) as { agents: { name: string; state: string }[] }).agents
    .map((r) => [r.name, r]));
  expect(rows.haile?.state).toBe("silent");
});

// --- installing the daemon with autostart -----------------------------------------------------------------------

function unitPath(env: Env, name: string): string {
  return join(env.XDG_CONFIG_HOME as string, "systemd", "user", name);
}

test("heartbeat install on linux writes a restarting user service and starts it", () => {
  const clone = project();
  const env = machine(clone);
  let p = autostartHook("factory_heartbeat", clone, env, "install");
  expect(p.code, p.out).toBe(0);
  const text = read(unitPath(env, "proj-factory-heartbeat.service"));
  for (const w of ["Type=simple", "Restart=always", "WantedBy=default.target", `WorkingDirectory=${clone}`]) expect(text).toContain(w);
  expect(text).toMatch(/^ExecStart=\/bin\/bash ".*\/factory" heartbeat run$/m);
  expect(aLog(env, "systemctl")).toContain("--user enable --now proj-factory-heartbeat.service");
  expect(autostartHook("factory_heartbeat", clone, env, "status").stdout).toContain("service: installed");
  expect(aLog(env, "loginctl")).toContain("enable-linger");
  p = autostartHook("factory_heartbeat", clone, env, "uninstall");
  expect(p.code, p.out).toBe(0);
  expect(existsSync(unitPath(env, "proj-factory-heartbeat.service"))).toBe(false);
  expect(aLog(env, "systemctl")).toContain("disable --now proj-factory-heartbeat.service");
});

test("heartbeat restart restarts an installed service and does nothing without one", () => {
  const clone = project();
  const env = machine(clone);
  let p = autostartHook("factory_heartbeat", clone, env, "restart");
  expect([p.code, p.stdout]).toEqual([0, ""]);
  expect(aLog(env, "systemctl")).not.toContain("restart");
  expect(autostartHook("factory_heartbeat", clone, env, "install").code).toBe(0);
  p = autostartHook("factory_heartbeat", clone, env, "restart");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Restarted proj-factory-heartbeat.service");
  expect(aLog(env, "systemctl")).toContain("--user restart proj-factory-heartbeat.service");
});

test("heartbeat install on macos writes a keep alive launch agent", () => {
  const clone = project();
  const env = machine(clone, { FACTORY_AUTOSTART_PLATFORM: "mac" });
  const p = autostartHook("factory_heartbeat", clone, env, "install");
  expect(p.code, p.out).toBe(0);
  const plist = join(env.HOME as string, "Library", "LaunchAgents", "dev.software-factory.proj-heartbeat.plist");
  const data = parsePlist(read(plist)) as Record<string, unknown>;
  expect((data.ProgramArguments as string[]).slice(-3)).toEqual([join(clone, "factory"), "heartbeat", "run"]);
  expect([data.RunAtLoad, data.KeepAlive, data.WorkingDirectory]).toEqual([true, true, clone]);
  expect(aLog(env, "launchctl")).toContain("bootstrap");
  expect(autostartHook("factory_heartbeat", clone, env, "uninstall").code).toBe(0);
  expect(existsSync(plist)).toBe(false);
});

test("autostart installs and removes the heartbeat with the boot service unless told not to", () => {
  let clone = project();
  let env = machine(clone);
  let p = autostartHook("factory_autostart", clone, env, "install", "--agents", "haile");
  expect(p.code, p.out).toBe(0);
  expect(existsSync(unitPath(env, "proj-factory-resume.service"))).toBe(true);
  expect(existsSync(unitPath(env, "proj-factory-heartbeat.service"))).toBe(true);
  expect(p.stdout).toContain("heartbeat");
  expect(autostartHook("factory_autostart", clone, env, "status").stdout).toContain("heartbeat: installed");
  autostartHook("factory_autostart", clone, env, "uninstall");
  expect(existsSync(unitPath(env, "proj-factory-heartbeat.service"))).toBe(false);
  expect(existsSync(unitPath(env, "proj-factory-resume.service"))).toBe(false);

  clone = project();
  env = machine(clone);
  p = autostartHook("factory_autostart", clone, env, "install", "--agents", "haile", "--no-heartbeat");
  expect(p.code, p.out).toBe(0);
  expect(existsSync(unitPath(env, "proj-factory-heartbeat.service"))).toBe(false);
  expect(autostartHook("factory_autostart", clone, env, "status").stdout).toContain("factory heartbeat install");
});

test("help and settings know the heartbeat", () => {
  const d = tmp();
  sh(["git", "init", "-q", "-b", "main", d]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "taytu"] }));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  const env: Env = { ...process.env, FACTORY_CONFIG_DIR: join(d, "machine-config") };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE", "CLAUDE_PROJECT_DIR"]) delete env[k];
  const out = sh(["bash", join(SF, "factory"), "help"], { cwd: d, env }).stdout;
  expect(out).toContain("heartbeat");
  expect(out).toContain("agents ls");
  const shown = sh(["bash", join(SF, "factory"), "settings"], { cwd: d, env }).stdout;
  for (const key of ["tasks.heartbeatSeconds", "tasks.heartbeatMissMinutes", "tasks.releaseDownMinutes"]) expect(shown).toContain(key);
});
