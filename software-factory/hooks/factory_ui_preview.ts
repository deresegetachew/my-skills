// Open preview on a sign-off item (#582), served by factory_ui_server.ts:
//
//   GET    /api/projects/:p/signoff/:id/preview   the item's preview: {state, configured, commit, pr, path, output, error,
//                                                 reason}; state is none, starting, running, stopping, failed or stopped
//   POST   /api/projects/:p/signoff/:id/preview   starts it (202), or answers with the one already running (200)
//   DELETE /api/projects/:p/signoff/:id/preview   stops it
//   POST   /api/projects/:p/signoff/:id/preview/link
//                                                 a one-time link to the running preview: {port, path} (path ends in
//                                                 ?code=..., good once, for a minute)
//
// The previews are served on their own origin (#582): a second listener, on `preview.listenPort` (the UI's port + 1)
// on the same addresses as the UI, answers only /preview/:p/:id/... (HTTP and WebSockets) and never /api/. Each preview
// has its own random token, for that one item, dead when the preview stops. The one-time link's code is swapped for it
// as an HttpOnly, SameSite=Strict cookie (factory_preview) for /preview/:p/:id/ on the preview origin. The web UI's token
// is never accepted, set or sent there, and the UI's API refuses requests from another origin, so a preview's page can
// neither read the UI's token nor act with it.
//
// Starting: the command, port, health path and limits are `preview.*` in .claude/factory.json as committed on the main
// branch (never from the request, nor from the pull request under test). The item's commit is the head of its task's
// open pull request (a `task/<task>-...` branch in the views' snapshot), else the main branch. It is checked out in a
// temporary worktree under the project's state folder (previews/), and the command runs there with `bash -c`, in its own
// process group, with a small environment: PATH, HOME, PORT (a free port, or preview.port), HOST=127.0.0.1 and the
// project's agentEnv (as for the first agent), never GitHub, Anthropic, board or UI secrets. The preview counts as running
// once preview.health answers below 400 within preview.startSeconds, and only if the app can't be reached on this
// machine's other addresses. Otherwise it fails with its output and a fix.
//
// Stopping (Stop, a result on the item, preview.idleMinutes with no request, or the web UI stopping) kills the whole
// process group (TERM, then KILL) and removes the worktree. At most one preview per item, and preview.max at once.
import { type ChildProcess, spawn as spawnChild, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { SETTINGS } from "./factory_settings_schema.ts";
import { type ActionResult, type Obj, type Problem, readJson, stateDirOf, type UiProject } from "./factory_ui_data.ts";
import { signoffOf } from "./factory_ui_signoff.ts";

export const COOKIE = "factory_preview";
const CODE_MS = 60_000;
/** Never passed to a preview, even when agentEnv names them. */
const SECRET = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|MB_URL|ANTHROPIC_.*|CLAUDE_CODE_OAUTH_TOKEN|FACTORY_UI_.*|.*_UI_TOKEN)$/;
const ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
const OUTPUT_LINES = 200;
const GIT_MS = 120_000;
const KILL_WAIT_MS = 3000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
  "host", "cookie", "accept-encoding", "content-length", "origin", "referer"];

export interface PreviewSettings {
  command: string;
  port: number | null;
  health: string;
  startSeconds: number;
  idleMinutes: number;
  max: number;
  /** The project's agentEnv as the first agent gets it (secrets left out). */
  env: Record<string, string>;
}

type State = "starting" | "running" | "stopping" | "failed" | "stopped";

interface Preview {
  key: string;
  project: string;
  item: string;
  root: string;
  state: State;
  commit: string;
  pr: number | null;
  port: number;
  dir: string;
  child: ChildProcess | null;
  pgid: number | null;
  output: string[];
  partial: string;
  lastUsed: number;
  idleMs: number;
  error: Problem | null;
  reason: string;
  path: string;
  /** The preview's own token (its cookie's value): "" once it stops. */
  token: string;
  /** The one-time link's code and until when it is good. */
  code: string;
  codeUntil: number;
}

/** What the WebSocket proxy keeps for one browser socket. */
export interface PreviewSocket {
  target: string;
  protocols: string[];
  key: string;
  upstream: WebSocket | null;
  queue: Array<string | Uint8Array<ArrayBuffer>>;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** agentEnv as slot 1 renders it ({slot} 1, {suffix} "", {port:N} N); a template with another placeholder, or a
 * secret's name, is left out. */
function agentEnvOf(cfg: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(obj(cfg).agentEnv))) {
    if (k.startsWith("_") || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || SECRET.test(k)) continue;
    const t = typeof v === "string" ? v : JSON.stringify(v);
    let ok = true;
    const out = t.replace(/\{([a-z]+)(?::(\d+))?\}/g, (_all, key: string, arg?: string) => {
      if (key === "slot") return "1";
      if (key === "suffix") return "";
      if (key === "port" && arg) return arg;
      ok = false;
      return "";
    });
    if (ok) env[k] = out;
  }
  return env;
}

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function problem(status: number, code: string, message: string, fix: string): ActionResult {
  return { status, body: { code, message, fix } };
}

function whole(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : dflt;
}

function dflt(key: string): number {
  const v = SETTINGS[key]?.default;
  return typeof v === "number" ? v : 1;
}

/** The `preview` settings in `cfg`, with their defaults. */
export function previewSettingsOf(cfg: unknown): PreviewSettings {
  const p = obj(obj(cfg).preview);
  const port = typeof p.port === "number" && Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? p.port : null;
  const health = typeof p.health === "string" && p.health.startsWith("/") ? p.health : "/";
  return { command: typeof p.command === "string" ? p.command.trim() : "", port, health,
    startSeconds: whole(p.startSeconds, dflt("preview.startSeconds")), idleMinutes: whole(p.idleMinutes, dflt("preview.idleMinutes")),
    max: whole(p.max, dflt("preview.max")), env: agentEnvOf(cfg) };
}

function git(root: string, args: string[], ms = GIT_MS): { code: number; out: string } {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: ms, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function mainOf(p: UiProject): string {
  const m = p.config?.mainBranch;
  return typeof m === "string" && m ? m : "main";
}

/** The settings committed on the main branch: the command never comes from the working copy or a pull request. */
function committedSettings(p: UiProject): PreviewSettings {
  const r = git(p.path, ["show", `${mainOf(p)}:.claude/factory.json`], 10_000);
  if (r.code !== 0) return previewSettingsOf({});
  try {
    return previewSettingsOf(JSON.parse(r.out) as unknown);
  } catch {
    return previewSettingsOf({});
  }
}

function hasOrigin(root: string): boolean {
  return git(root, ["remote", "get-url", "origin"], 10_000).code === 0;
}

function commitOf(root: string, ref: string): string | null {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 10_000);
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(r.out) ? r.out : null;
}

/** The open pull request for `task` in the views' snapshot: its number, branch and head. */
function pullFor(p: UiProject, task: string): { number: number; branch: string; head: string } | null {
  const pulls = obj(readJson(join(stateDirOf(p), "snapshot.json"))).pulls;
  if (!Array.isArray(pulls)) return null;
  for (const x of pulls.map(obj)) {
    const branch = typeof x.branch === "string" ? x.branch : "";
    if (branch === `task/${task}` || branch.startsWith(`task/${task}-`)) {
      return { number: typeof x.number === "number" ? x.number : Number(x.number), branch, head: typeof x.head === "string" ? x.head : "" };
    }
  }
  return null;
}

/** The commit an item is tried on: its task's open pull request's head, else the main branch (fetched first when
 * there is an origin). */
function itemCommit(p: UiProject, task: string | null): { commit: string; pr: number | null } | Problem {
  const origin = hasOrigin(p.path);
  const pull = task ? pullFor(p, task) : null;
  if (pull) {
    let sha = pull.head && commitOf(p.path, pull.head) ? pull.head : null;
    if (!sha && origin && git(p.path, ["fetch", "-q", "origin", pull.branch]).code === 0) sha = commitOf(p.path, "FETCH_HEAD");
    sha ??= commitOf(p.path, pull.branch);
    if (sha) return { commit: sha, pr: pull.number };
    return { code: "preview_no_commit", message: `The head of pull request #${pull.number} (${pull.branch}) isn't on this machine.`,
      fix: "Check that this machine reaches GitHub (the Machines page shows it), then open the preview again." };
  }
  const main = mainOf(p);
  if (origin) git(p.path, ["fetch", "-q", "origin", main]);
  const sha = (origin ? commitOf(p.path, `origin/${main}`) : null) ?? commitOf(p.path, main);
  if (sha) return { commit: sha, pr: null };
  return { code: "preview_no_commit", message: `The main branch (${main}) can't be found in ${p.path}.`,
    fix: "Check the project's main branch setting (mainBranch), then open the preview again." };
}

/** A port nothing listens on, on 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Whether something answers a TCP connect to host:port within `ms`. */
function answers(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (v: boolean): void => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(ms, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** This machine's addresses other than loopback (IPv4), where an app listening everywhere would be reachable. */
function otherAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => (i as { address: string }).address);
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
}

function idleMsOf(s: PreviewSettings): number {
  const given = Number(process.env.FACTORY_PREVIEW_IDLE_MS ?? ""); // tests only: a shorter idle time
  return Number.isInteger(given) && given > 0 ? given : s.idleMinutes * 60_000;
}

function cookieOf(header: string | null, name: string): { value: string; rest: string } {
  let value = "";
  const rest: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith(`${name}=`)) value = t.slice(name.length + 1);
    else rest.push(t);
  }
  return { value, rest: rest.join("; ") };
}

export class Previews {
  private all = new Map<string, Preview>();
  private swept = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private servers: Server<PreviewSocket>[] = [];
  private byId: (id: string) => UiProject | undefined = () => undefined;
  /** The preview origin's port (0 until listen). */
  port = 0;

  /** Starts the preview origin on `hosts` at `port` (0: a free one); returns the port. */
  listen(hosts: string[], port: number, byId: (id: string) => UiProject | undefined): number {
    this.byId = byId;
    let at = port;
    try {
      for (const hostname of hosts) {
        const s = Bun.serve<PreviewSocket>({ hostname, port: at, idleTimeout: 60, fetch: (req, server) => this.originFetch(req, server),
          websocket: { open: (ws) => this.wsOpen(ws), message: (ws, m) => this.wsMessage(ws, m), close: (ws) => this.wsClose(ws) } });
        at = s.port ?? at;
        this.servers.push(s);
      }
    } catch (e) {
      for (const s of this.servers) s.stop(true);
      this.servers = [];
      throw e;
    }
    this.port = at;
    return at;
  }

  private keyOf(p: UiProject, id: string): string {
    return `${p.id}\n${id}`;
  }

  private active(): Preview[] {
    return [...this.all.values()].filter((x) => x.state === "starting" || x.state === "running" || x.state === "stopping");
  }

  private view(p: UiProject, id: string): Obj {
    const x = this.all.get(this.keyOf(p, id));
    const configured = committedSettings(p).command !== "";
    if (!x) return { state: "none", configured, port: this.port, path: null, output: [], error: null };
    return { state: x.state, configured, port: this.port, commit: x.commit, pr: x.pr, path: x.state === "running" ? x.path : null,
      output: [...x.output, ...(x.partial ? [x.partial] : [])], error: x.error, reason: x.reason };
  }

  /** A one-time link to the running preview: a fresh code, good once for a minute (an older one is dead). */
  private link(p: UiProject, id: string): ActionResult {
    const x = this.all.get(this.keyOf(p, id));
    if (!x || x.state !== "running") {
      return problem(409, "preview_not_running", "This item's preview isn't running.", "Use Open preview on the item, then open the app when it runs.");
    }
    x.code = randomBytes(24).toString("base64url");
    x.codeUntil = Date.now() + CODE_MS;
    return { status: 200, body: { port: this.port, path: `${x.path}?code=${x.code}` } };
  }

  /** The answer to `/api/projects/:p/signoff/:id/preview[/link]`. */
  async api(req: Request, p: UiProject, id: string, sub?: string): Promise<ActionResult> {
    if (!ID.test(id)) return problem(400, "signoff_bad_input", `'${id.slice(0, 64)}' is not an item's id.`, "Open the item from the sign-off list.");
    if (sub === "link") {
      return req.method === "POST" ? this.link(p, id) : problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST.");
    }
    if (req.method === "GET") return { status: 200, body: { project: p.id, item: id, ...this.view(p, id) } };
    if (req.method === "POST") return this.start(p, id);
    if (req.method === "DELETE") {
      await this.stop(p, id, "Stopped by you.");
      return { status: 200, body: { ok: true, project: p.id, item: id, ...this.view(p, id) } };
    }
    return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET, POST to start the preview or DELETE to stop it.");
  }

  /** Starts the item's preview: 202 while it starts, 200 with the one already there. */
  async start(p: UiProject, id: string): Promise<ActionResult> {
    const key = this.keyOf(p, id);
    const had = this.all.get(key);
    if (had && (had.state === "starting" || had.state === "running")) return { status: 200, body: { project: p.id, item: id, ...this.view(p, id) } };
    if (had?.state === "stopping") {
      return problem(409, "preview_stopping", "The last preview of this item is still stopping.", "Wait a moment, then open the preview again.");
    }
    const s = committedSettings(p);
    if (!s.command) {
      return problem(400, "preview_not_set", `${p.name} doesn't say how to run its app for a preview.`,
        `Set preview.command (and preview.health) in the project's settings on Factory settings, for example bun run src/server.ts, and merge that change.`);
    }
    const q = await signoffOf(p);
    const item = q.items.find((it) => it.id === id);
    if (!item) {
      const why = q.problems[0];
      return why ? { status: 502, body: { ...why } } : problem(404, "preview_no_item", `There is no item ${id} in the sign-off queue.`,
        "Reload the page to see the queue as it is now.");
    }
    // from here to the reservation nothing waits, so a second click or another item can't pass these checks too
    const again = this.all.get(key);
    if (again && again !== had) return again.state === "starting" || again.state === "running"
      ? { status: 200, body: { project: p.id, item: id, ...this.view(p, id) } }
      : problem(409, "preview_stopping", "The last preview of this item is still stopping.", "Wait a moment, then open the preview again.");
    const now = this.active();
    if (now.length >= s.max) {
      return problem(429, "preview_limit", `${now.length} preview${now.length === 1 ? " is" : "s are"} running, the most at once (preview.max ${s.max}).`,
        "Stop one: sign its item off, send it back, or use Stop preview on it. Then open this one again.");
    }
    const x: Preview = { key, project: p.id, item: id, root: p.path, state: "starting", commit: "", pr: null, port: 0, dir: "", child: null,
      pgid: null, output: [], partial: "", lastUsed: Date.now(), idleMs: idleMsOf(s), error: null, reason: "",
      path: `/preview/${encodeURIComponent(p.id)}/${encodeURIComponent(id)}/`, token: randomBytes(32).toString("base64url"), code: "", codeUntil: 0 };
    this.all.set(key, x);
    const refuse = (r: ActionResult): ActionResult => {
      this.all.delete(key);
      if (had) this.all.set(key, had);
      return r;
    };
    const at = itemCommit(p, typeof item.task === "string" ? item.task : null);
    if ("code" in at) return refuse({ status: 500, body: { ...at } });
    x.commit = at.commit;
    x.pr = at.pr;
    this.sweep(p);
    if (s.port !== null && (await answers("127.0.0.1", s.port, 500))) {
      return refuse(problem(409, "preview_port_busy", `Port ${s.port} (preview.port) is already in use on this machine.`,
        "Stop what uses it, or leave preview.port unset so each preview gets a free port in PORT."));
    }
    x.port = s.port ?? (await freePort());
    const base = join(stateDirOf(p), "previews");
    mkdirSync(base, { recursive: true });
    x.dir = join(base, `${id}-${randomBytes(4).toString("hex")}`);
    const wt = git(p.path, ["worktree", "add", "--detach", "-q", x.dir, x.commit]);
    if (wt.code !== 0) {
      this.removeWorktree(x);
      return refuse(problem(500, "preview_worktree_failed", `The commit ${x.commit.slice(0, 7)} couldn't be checked out for the preview (${wt.out.slice(0, 300)}).`,
        "Free some disk space or remove stale worktrees on the Factory settings page's clean-ups, then open the preview again."));
    }
    this.run(p, x, s);
    if (!this.timer) {
      this.timer = setInterval(() => this.idle(), 1000);
      this.timer.unref?.();
    }
    return { status: 202, body: { project: p.id, item: id, ...this.view(p, id), path: x.path } };
  }

  /** Runs the command in the worktree, in its own process group, and waits for it to answer. */
  private run(p: UiProject, x: Preview, s: PreviewSettings): void {
    // a small environment: no GitHub, Anthropic, board or UI secrets reach the app under test
    const env: Record<string, string> = { ...s.env, PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? x.dir,
      PORT: String(x.port), HOST: "127.0.0.1" };
    let child: ChildProcess;
    try {
      child = spawnChild("bash", ["-c", s.command], { cwd: x.dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      void this.end(x, "failed", { code: "preview_start_failed", message: `The preview couldn't be started (${e instanceof Error ? e.message : String(e)}).`,
        fix: "Check preview.command in the project's settings." }, "");
      return;
    }
    x.child = child;
    x.pgid = child.pid ?? null;
    const take = (chunk: Buffer): void => {
      const text = x.partial + chunk.toString("utf8").replace(ANSI, "");
      const lines = text.split(/\r?\n/);
      x.partial = lines.pop() ?? "";
      x.output.push(...lines);
      if (x.output.length > OUTPUT_LINES) x.output.splice(0, x.output.length - OUTPUT_LINES);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => undefined);
    child.on("exit", (code, signal) => {
      x.child = null;
      const how = code !== null ? `exit ${code}` : `signal ${signal ?? "?"}`;
      if (x.state === "starting") {
        void this.end(x, "failed", { code: "preview_start_failed", message: `The app stopped before it answered (${how}).`,
          fix: "Read its output below, fix what it says (often a missing dependency: put the install in preview.command), then open the preview again." }, "");
      } else if (x.state === "running") {
        void this.end(x, "failed", { code: "preview_exited", message: `The app stopped by itself (${how}).`,
          fix: "Read its output below, then open the preview again." }, "");
      }
    });
    void this.waitHealthy(x, s);
  }

  private async waitHealthy(x: Preview, s: PreviewSettings): Promise<void> {
    const deadline = Date.now() + s.startSeconds * 1000;
    const url = `http://127.0.0.1:${x.port}${s.health}`;
    let ok = false;
    while (x.state === "starting" && Date.now() < deadline) {
      try {
        const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
        await r.arrayBuffer().catch(() => undefined);
        ok = r.status < 400;
        if (ok) break;
      } catch {
        // not yet
      }
      await Bun.sleep(250);
    }
    if (x.state !== "starting") return;
    if (!ok) {
      await this.end(x, "failed", { code: "preview_health_timeout", message: `The app didn't answer ${s.health} on port ${x.port} within ${s.startSeconds} seconds.`,
        fix: "Read its output below. Check that it listens on PORT and that preview.health is a path it answers, or give it more time with preview.startSeconds." }, "");
      return;
    }
    for (const host of otherAddresses()) {
      if (await answers(host, x.port, 500)) {
        await this.end(x, "failed", { code: "preview_exposed", message: `The app also answers on ${host}:${x.port}, so others on the network could reach it.`,
          fix: "Make the app listen on HOST (127.0.0.1) only, then open the preview again." }, "");
        return;
      }
    }
    if (x.state === "starting") {
      x.state = "running";
      x.lastUsed = Date.now();
    }
  }

  /** Kills the preview's process group and removes its worktree, then marks it `state`. */
  private async end(x: Preview, state: "failed" | "stopped", error: Problem | null, reason: string): Promise<void> {
    if (x.state === "stopping" || x.state === "failed" || x.state === "stopped") return;
    x.state = "stopping";
    x.token = ""; // its cookie and link are dead from now on
    x.code = "";
    if (x.pgid !== null) {
      killGroup(x.pgid, "SIGTERM");
      const until = Date.now() + KILL_WAIT_MS;
      while (groupAlive(x.pgid) && Date.now() < until) await Bun.sleep(100);
      if (groupAlive(x.pgid)) killGroup(x.pgid, "SIGKILL");
    }
    this.removeWorktree(x);
    x.error = error;
    x.reason = reason || error?.message || "";
    x.state = state;
  }

  private removeWorktree(x: Preview): void {
    if (!x.dir) return;
    git(x.root, ["worktree", "remove", "--force", x.dir]);
    rmSync(x.dir, { recursive: true, force: true });
    git(x.root, ["worktree", "prune"]);
  }

  /** Once per project: worktrees an earlier run of the web UI left in previews/ go. */
  private sweep(p: UiProject): void {
    if (this.swept.has(p.id)) return;
    this.swept.add(p.id);
    const base = join(stateDirOf(p), "previews");
    if (!existsSync(base)) return;
    const mine = new Set(this.active().map((x) => x.dir));
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (mine.has(dir)) continue;
      git(p.path, ["worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
    git(p.path, ["worktree", "prune"]);
  }

  private idle(): void {
    const now = Date.now();
    for (const x of this.all.values()) {
      if (x.state === "running" && now - x.lastUsed >= x.idleMs) {
        const m = Math.max(1, Math.round(x.idleMs / 60_000));
        void this.end(x, "stopped", null, `Stopped after ${m} idle minute${m === 1 ? "" : "s"} with no request.`);
      }
    }
    if (!this.active().length && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Stops the item's preview, if it has one (Stop, or a result on the item). */
  async stop(p: UiProject, id: string, reason: string): Promise<void> {
    const x = this.all.get(this.keyOf(p, id));
    if (x && (x.state === "starting" || x.state === "running")) await this.end(x, "stopped", null, reason);
  }

  /** The web UI stops: every preview goes now (KILL after a short TERM), with its worktree. */
  stopAll(): void {
    const live = this.active();
    for (const x of live) if (x.pgid !== null) killGroup(x.pgid, "SIGTERM");
    if (live.some((x) => x.pgid !== null && groupAlive(x.pgid))) Bun.sleepSync(300);
    for (const x of live) {
      if (x.pgid !== null) killGroup(x.pgid, "SIGKILL");
      this.removeWorktree(x);
      x.state = "stopped";
      x.token = "";
      x.code = "";
      x.reason = "The web UI stopped.";
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.servers) s.stop(true);
    this.servers = [];
  }

  /** The running preview `/preview/<project>/<item>/` names, or the answer when there is none. */
  private target(url: URL): { x: Preview; prefix: string; rest: string } | ActionResult {
    const m = /^\/preview\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const notRunning = problem(404, "preview_not_running", "This preview isn't running (it stopped, or was never started).",
      "Open the sign-off item and use Open preview again.");
    if (!m) return notRunning;
    let pid: string;
    let id: string;
    try {
      pid = decodeURIComponent(m[1] as string);
      id = decodeURIComponent(m[2] as string);
    } catch {
      return notRunning;
    }
    const p = this.byId(pid);
    const x = p ? this.all.get(this.keyOf(p, id)) : undefined;
    if (!x || x.state !== "running") return notRunning;
    return { x, prefix: `/preview/${m[1]}/${m[2]}`, rest: m[3] ?? "" };
  }

  /** Everything the preview origin answers: /preview/<project>/<item>/... with that preview's own cookie, else nothing. */
  private async originFetch(req: Request, server: Server<PreviewSocket>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const answer = (r: ActionResult): Response => new Response(JSON.stringify(r.body), { status: r.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    if (!url.pathname.startsWith("/preview/")) {
      return answer(problem(404, "preview_not_found", "This address serves sign-off previews only.", "Open the web UI on its own port."));
    }
    const t = this.target(url);
    if (!("x" in t)) return answer(t);
    const x = t.x;
    if (!t.rest) return new Response(null, { status: 308, headers: { location: `${t.prefix}/${url.search}` } }); // the cookie's path ends in /
    const refused = problem(401, "preview_token_wrong", "This needs this preview's own link.",
      "Open the app from its sign-off item (Open the app): each link works once, and only for that item's preview.");
    const code = url.searchParams.get("code");
    if (code !== null) {
      // the one-time link: its code is swapped for the preview's own cookie, for this item's path, and taken out of the address
      if (!x.code || Date.now() > x.codeUntil || !sameText(code, x.code)) return answer(refused);
      x.code = "";
      const clean = new URL(url);
      clean.searchParams.delete("code");
      return new Response(null, { status: 303, headers: { location: clean.pathname + clean.search, "cache-control": "no-store", "referrer-policy": "no-referrer",
        "set-cookie": `${COOKIE}=${x.token}; Path=${x.path}; HttpOnly; SameSite=Strict` } });
    }
    const cookie = cookieOf(req.headers.get("cookie"), COOKIE);
    if (!sameText(cookie.value, x.token)) return answer(refused);
    const clean = new URL(url);
    x.lastUsed = Date.now();
    const path = t.rest + clean.search;
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!HOP.includes(k.toLowerCase()) && !k.toLowerCase().startsWith("sec-websocket")) headers.set(k, v);
    });
    if (cookie.rest) headers.set("cookie", cookie.rest);
    headers.set("accept-encoding", "identity");
    headers.set("x-forwarded-prefix", t.prefix);
    headers.set("x-forwarded-host", req.headers.get("host") ?? "");
    headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const sock: PreviewSocket = { target: `ws://127.0.0.1:${t.x.port}${path}`, protocols, key: t.x.key, upstream: null, queue: [] };
      if (server.upgrade(req, { data: sock })) return undefined;
      return new Response("WebSocket upgrade failed\n", { status: 400 });
    }
    let r: Response;
    try {
      r = await fetch(`http://127.0.0.1:${t.x.port}${path}`, { method: req.method, headers, redirect: "manual",
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer() });
    } catch (e) {
      return new Response(JSON.stringify({ code: "preview_unreachable", message: `The app didn't answer (${e instanceof Error ? e.message : String(e)}).`,
        fix: "Look at the preview's output on its sign-off item, then open the preview again." }), { status: 502, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    const out = new Headers(r.headers);
    for (const k of ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]) out.delete(k);
    const loc = out.get("location");
    if (loc) {
      const own = [`http://127.0.0.1:${t.x.port}`, `http://localhost:${t.x.port}`].find((o) => loc.startsWith(o));
      const rel = own ? loc.slice(own.length) || "/" : loc;
      if (rel.startsWith("/") && !rel.startsWith("//")) out.set("location", t.prefix + rel);
    }
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
  }

  // --- WebSockets: the browser's socket and one to the app, each passing on what the other sends --------------------

  private wsOpen(ws: ServerWebSocket<PreviewSocket>): void {
    const sock = ws.data;
    let up: WebSocket;
    try {
      up = new WebSocket(sock.target, sock.protocols);
    } catch {
      ws.close(1011, "preview unreachable");
      return;
    }
    up.binaryType = "arraybuffer";
    sock.upstream = up;
    up.onopen = () => {
      for (const m of sock.queue) up.send(m);
      sock.queue = [];
    };
    up.onmessage = (e: MessageEvent) => {
      this.touch(sock.key);
      ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
    };
    up.onclose = (e: CloseEvent) => ws.close(e.code === 1005 || e.code === 1006 ? 1000 : e.code, e.reason);
    up.onerror = () => ws.close(1011, "preview error");
  }

  private wsMessage(ws: ServerWebSocket<PreviewSocket>, message: string | Buffer): void {
    const sock = ws.data;
    this.touch(sock.key);
    const m = typeof message === "string" ? message : new Uint8Array(message);
    if (sock.upstream?.readyState === WebSocket.OPEN) sock.upstream.send(m);
    else sock.queue.push(m);
  }

  private wsClose(ws: ServerWebSocket<PreviewSocket>): void {
    const up = ws.data.upstream;
    if (up && (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING)) up.close();
  }

  private touch(key: string): void {
    const x = this.all.get(key);
    if (x) x.lastUsed = Date.now();
  }
}
