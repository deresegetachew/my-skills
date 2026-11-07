// Open preview on a sign-off item (#582), served by factory_ui_server.ts:
//
//   GET    /api/projects/:p/signoff/:id/preview   the item's preview: {state, enabled, configured, port, commit, pr, path,
//                                                 output, error, reason}; state is none, starting, running, stopping,
//                                                 failed or stopped
//   POST   /api/projects/:p/signoff/:id/preview   starts it (202), or answers with the one already running (200)
//   DELETE /api/projects/:p/signoff/:id/preview   stops it
//   POST   /api/projects/:p/signoff/:id/preview/link
//                                                 a one-time link to the running preview: {port, path} (path ends in
//                                                 ?code=..., good once, for a minute)
//
// WHAT THIS IS NOT: a sandbox. The preview runs the pull request's code as this machine's user, with that user's rights:
// it can read the web UI's token in .git/factory/ui-token, `gh auth token`, ~/.ssh and every other file the owner can,
// and call the web UI's API with them. That is why `preview.enabled` is off by default and the page says so before it
// starts one; isolating previews (another OS user, a container) is the follow-up the owner decides on (see #599). What
// follows only keeps mistakes and a curious page from going further: the small environment, the separate origin, the
// per-preview cookie and the exposure check are mistake-catchers, not a boundary.
//
// Starting: `preview.*` in .claude/factory.json as committed on the main branch (refs/remotes/origin/<main>, else
// refs/heads/<main>: never a tag of that name, the working copy, the request or the pull request under test). The item's
// commit is the head of its task's open pull request (a `task/<task>-...` branch in the views' snapshot), else that same
// main ref. It is checked out in a temporary worktree under the project's state folder (previews/), and the command runs
// there with `bash -c`, in its own process group, with PATH, a fresh empty HOME of its own, PORT (a free port, or
// preview.port), HOST=127.0.0.1 and the project's agentEnv (as for the first agent; GitHub, Anthropic, board and UI
// variable names left out). It counts as running once preview.health answers below 400 within preview.startSeconds and
// the app can't be reached on this machine's other addresses (checked again every 30 seconds while it runs).
//
// Each running preview is served on its own port (preview.listenPort .. preview.listenPort + preview.max - 1, on the
// UI's addresses), so previews are different origins from the UI and from each other. Only /preview/:p/:id/... is
// answered there, with that preview's own random token as an HttpOnly, SameSite=Strict cookie, set through the one-time
// link. The web UI's token is never accepted, set or sent there.
//
// Stopping (Stop, a result on the item, preview.idleMinutes with no request, or the web UI stopping) kills the process
// group (TERM, then KILL), then any process still working in the worktree (one that left the group), stops its port and
// removes the worktree and HOME. Each preview's process group is written next to its worktree, so what a crashed web UI
// left behind is killed and removed when it starts again. At most one preview per item, and preview.max at once.
import { type ChildProcess, spawn as spawnChild, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { SETTINGS } from "./factory_settings_schema.ts";
import { type ActionResult, type Obj, type Problem, readJson, stateDirOf, type UiProject } from "./factory_ui_data.ts";
import { signoffOf } from "./factory_ui_signoff.ts";

export const COOKIE = "factory_preview";
const CODE_MS = 60_000;
const EXPOSURE_EVERY_MS = 30_000;
/** Never passed to a preview, even when agentEnv names them. */
const SECRET = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|MB_URL|ANTHROPIC_.*|CLAUDE_CODE_OAUTH_TOKEN|FACTORY_UI_.*|.*_UI_TOKEN)$/;
const ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9][\w./-]{0,200}$/;
const OUTPUT_LINES = 200;
const GIT_MS = 120_000;
const KILL_WAIT_MS = 3000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
  "host", "cookie", "accept-encoding", "content-length", "origin", "referer"];

/** What the page says before it starts a preview, and the refusal while previews are off. */
export const RISK = "This runs the pull request's code on this machine with this machine user's rights (it can read your tokens and files).";

export interface PreviewSettings {
  enabled: boolean;
  command: string;
  port: number | null;
  health: string;
  startSeconds: number;
  idleMinutes: number;
  max: number;
  /** The project's agentEnv as the first agent gets it (secret names left out). */
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
  /** The app's own port, on 127.0.0.1. */
  port: number;
  /** The port this preview is served on (its own origin), and its listeners. */
  listenPort: number;
  servers: Server<PreviewSocket>[];
  dir: string;
  /** The worktree's real path (processes working in it are found by it), its HOME and its pgid file. */
  real: string;
  home: string;
  child: ChildProcess | null;
  pgid: number | null;
  output: string[];
  partial: string;
  lastUsed: number;
  idleMs: number;
  checkedAt: number;
  checking: boolean;
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

/** The `preview` settings in `cfg`, with their defaults. */
export function previewSettingsOf(cfg: unknown): PreviewSettings {
  const p = obj(obj(cfg).preview);
  const port = typeof p.port === "number" && Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? p.port : null;
  const health = typeof p.health === "string" && p.health.startsWith("/") ? p.health : "/";
  return { enabled: p.enabled === true, command: typeof p.command === "string" ? p.command.trim() : "", port, health,
    startSeconds: whole(p.startSeconds, dflt("preview.startSeconds")), idleMinutes: whole(p.idleMinutes, dflt("preview.idleMinutes")),
    max: whole(p.max, dflt("preview.max")), env: agentEnvOf(cfg) };
}

/** git in `root`: its exit code, its stdout alone, and both (for a message). */
function git(root: string, args: string[], ms = GIT_MS): { code: number; stdout: string; out: string } {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: ms, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function mainOf(p: UiProject): string {
  const m = p.config?.mainBranch;
  return typeof m === "string" && BRANCH.test(m) ? m : "main";
}

function commitOf(root: string, ref: string): string | null {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 10_000);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** The main branch's full ref: refs/remotes/origin/<main> when there is one, else refs/heads/<main>. Never a tag or
 * any other ref that happens to have the branch's name. */
function mainRef(p: UiProject): string | null {
  const main = mainOf(p);
  for (const ref of [`refs/remotes/origin/${main}`, `refs/heads/${main}`]) if (commitOf(p.path, ref)) return ref;
  return null;
}

/** The settings committed on the main branch: the command never comes from the working copy or a pull request. */
function committedSettings(p: UiProject): PreviewSettings {
  const ref = mainRef(p);
  const r = ref ? git(p.path, ["show", `${ref}:.claude/factory.json`], 10_000) : null;
  if (!r || r.code !== 0) return previewSettingsOf({});
  try {
    return previewSettingsOf(JSON.parse(r.stdout) as unknown);
  } catch {
    return previewSettingsOf({});
  }
}

function hasOrigin(root: string): boolean {
  return git(root, ["remote", "get-url", "origin"], 10_000).code === 0;
}

/** The open pull request for `task` in the views' snapshot: its number, branch and head. */
function pullFor(p: UiProject, task: string): { number: number; branch: string; head: string } | null {
  const pulls = obj(readJson(join(stateDirOf(p), "snapshot.json"))).pulls;
  if (!Array.isArray(pulls)) return null;
  for (const x of pulls.map(obj)) {
    const branch = typeof x.branch === "string" ? x.branch : "";
    if (BRANCH.test(branch) && (branch === `task/${task}` || branch.startsWith(`task/${task}-`))) {
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
    let sha = /^[0-9a-f]{40,64}$/.test(pull.head) && commitOf(p.path, pull.head) ? pull.head : null;
    if (!sha && origin && git(p.path, ["fetch", "-q", "origin", `refs/heads/${pull.branch}`]).code === 0) sha = commitOf(p.path, "FETCH_HEAD");
    sha ??= commitOf(p.path, `refs/heads/${pull.branch}`);
    if (sha) return { commit: sha, pr: pull.number };
    return { code: "preview_no_commit", message: `The head of pull request #${pull.number} (${pull.branch}) isn't on this machine.`,
      fix: "Check that this machine reaches GitHub (the Machines page shows it), then open the preview again." };
  }
  const main = mainOf(p);
  if (origin) git(p.path, ["fetch", "-q", "origin", `refs/heads/${main}:refs/remotes/origin/${main}`]);
  const ref = mainRef(p);
  const sha = ref ? commitOf(p.path, ref) : null;
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

/** This machine's addresses other than loopback, IPv4 and IPv6 (link-local IPv6 left out: it needs a zone), where an
 * app listening everywhere would be reachable. A mistake-catcher: it tells an app that forgot HOST, it isn't a fence. */
function otherAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((i): i is NonNullable<typeof i> => Boolean(i) && !(i as { internal: boolean }).internal)
    .filter((i) => i.family === "IPv4" || (i.family === "IPv6" && !/^fe80:/i.test(i.address)))
    .map((i) => i.address);
}

async function exposedOn(port: number): Promise<string | null> {
  for (const host of otherAddresses()) if (await answers(host, port, 500)) return host.includes(":") ? `[${host}]` : host;
  return null;
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

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The processes (other than this one) whose working folder is inside one of `dirs` (real paths): /proc on Linux,
 * lsof elsewhere. Finds what left the process group (setsid) but stayed in the worktree. */
function processesIn(dirs: string[]): number[] {
  const inside = (cwd: string): boolean => dirs.some((d) => cwd === d || cwd.startsWith(`${d}/`));
  const found: number[] = [];
  if (existsSync("/proc/self/cwd")) {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        if (inside(readlinkSync(`/proc/${name}/cwd`))) found.push(Number(name));
      } catch {
        // gone, or not ours
      }
    }
    return found;
  }
  const r = spawnSync("lsof", ["-a", "-d", "cwd", "-F", "pn", "-u", String(process.getuid?.() ?? "")], { encoding: "utf8", timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"] });
  let pid = 0;
  for (const line of (r.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid && pid !== process.pid && inside(line.slice(1))) found.push(pid);
  }
  return found;
}

/** Kills every process working inside `dirs`, and the recorded process groups whose leader is one of them. */
function killIn(dirs: string[], pgids: number[] = []): void {
  if (!dirs.length) return;
  const pids = processesIn(dirs);
  for (const g of pgids) if (pids.includes(g)) killGroup(g, "SIGKILL");
  for (const pid of pids) killPid(pid);
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private hosts: string[] = ["127.0.0.1"];
  private byId: (id: string) => UiProject | undefined = () => undefined;
  /** The first port of the previews' range (0: each takes a free one). */
  basePort = 0;

  /** Where previews are served: the UI's addresses, from `basePort` up; `byId` finds a project by its id. */
  configure(hosts: string[], basePort: number, byId: (id: string) => UiProject | undefined): void {
    this.hosts = hosts;
    this.basePort = basePort;
    this.byId = byId;
  }

  private keyOf(p: UiProject, id: string): string {
    return `${p.id}\n${id}`;
  }

  private active(): Preview[] {
    return [...this.all.values()].filter((x) => x.state === "starting" || x.state === "running" || x.state === "stopping");
  }

  private view(p: UiProject, id: string): Obj {
    const x = this.all.get(this.keyOf(p, id));
    const s = committedSettings(p);
    const base = { enabled: s.enabled, configured: s.command !== "", risk: RISK };
    if (!x) return { state: "none", ...base, port: null, path: null, output: [], error: null };
    return { state: x.state, ...base, port: x.state === "running" ? x.listenPort : null, commit: x.commit, pr: x.pr,
      path: x.state === "running" ? x.path : null, output: [...x.output, ...(x.partial ? [x.partial] : [])], error: x.error, reason: x.reason };
  }

  /** A one-time link to the running preview: a fresh code, good once for a minute (an older one is dead). */
  private link(p: UiProject, id: string): ActionResult {
    const x = this.all.get(this.keyOf(p, id));
    if (!x || x.state !== "running") {
      return problem(409, "preview_not_running", "This item's preview isn't running.", "Use Open preview on the item, then open the app when it runs.");
    }
    x.code = randomBytes(24).toString("base64url");
    x.codeUntil = Date.now() + CODE_MS;
    return { status: 200, body: { port: x.listenPort, path: `${x.path}?code=${x.code}` } };
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
    if (!s.enabled) {
      return problem(403, "preview_disabled", `Previews are off in ${p.name}. ${RISK}`,
        "If you accept that, turn on preview.enabled in the project's settings on Factory settings and merge that change; it is off until you do.");
    }
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
    const x: Preview = { key, project: p.id, item: id, root: p.path, state: "starting", commit: "", pr: null, port: 0, listenPort: 0, servers: [],
      dir: "", real: "", home: "", child: null, pgid: null, output: [], partial: "", lastUsed: Date.now(), idleMs: idleMsOf(s), checkedAt: Date.now(),
      checking: false, error: null, reason: "", path: `/preview/${encodeURIComponent(p.id)}/${encodeURIComponent(id)}/`,
      token: randomBytes(32).toString("base64url"), code: "", codeUntil: 0 };
    this.all.set(key, x);
    const refuse = (r: ActionResult): ActionResult => {
      this.cleanUp(x);
      this.all.delete(key);
      if (had) this.all.set(key, had);
      return r;
    };
    const at = itemCommit(p, typeof item.task === "string" ? item.task : null);
    if ("code" in at) return refuse({ status: 500, body: { ...at } });
    x.commit = at.commit;
    x.pr = at.pr;
    if (s.port !== null && (await answers("127.0.0.1", s.port, 500))) {
      return refuse(problem(409, "preview_port_busy", `Port ${s.port} (preview.port) is already in use on this machine.`,
        "Stop what uses it, or leave preview.port unset so each preview gets a free port in PORT."));
    }
    x.port = s.port ?? (await freePort());
    if (!this.serve(x, s.max)) {
      return refuse(problem(409, "preview_listen_busy", `No port from ${this.basePort} to ${this.basePort + s.max - 1} (preview.listenPort and the next ones) is free to serve the preview on.`,
        "Stop what uses those ports, or set preview.listenPort to the start of a free range, then open the preview again."));
    }
    const base = join(stateDirOf(p), "previews");
    mkdirSync(base, { recursive: true });
    const name = `${id}-${randomBytes(4).toString("hex")}`;
    x.dir = join(base, name);
    x.home = join(base, `${name}.home`);
    const wt = git(p.path, ["worktree", "add", "--detach", "-q", x.dir, x.commit]);
    if (wt.code !== 0) {
      return refuse(problem(500, "preview_worktree_failed", `The commit ${x.commit.slice(0, 7)} couldn't be checked out for the preview (${wt.out.slice(0, 300)}).`,
        "Free some disk space or remove stale worktrees on the Factory settings page's clean-ups, then open the preview again."));
    }
    x.real = real(x.dir);
    mkdirSync(x.home, { recursive: true, mode: 0o700 });
    this.run(x, s, join(base, `${name}.pgid`));
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 1000);
      this.timer.unref?.();
    }
    return { status: 202, body: { project: p.id, item: id, ...this.view(p, id), path: x.path } };
  }

  /** Serves `x` on its own port: the first free one of the range, or a free one when the range starts at 0. */
  private serve(x: Preview, max: number): boolean {
    const taken = new Set(this.active().map((y) => y.listenPort).filter((n) => n > 0));
    const tries = this.basePort === 0 ? [0] : Array.from({ length: max }, (_, i) => this.basePort + i).filter((n) => n < 65536 && !taken.has(n));
    for (const first of tries) {
      const servers: Server<PreviewSocket>[] = [];
      try {
        let at = first;
        for (const hostname of this.hosts) {
          const s = Bun.serve<PreviewSocket>({ hostname, port: at, idleTimeout: 60, fetch: (req, server) => this.originFetch(req, server, x),
            websocket: { open: (ws) => this.wsOpen(ws), message: (ws, m) => this.wsMessage(ws, m), close: (ws) => this.wsClose(ws) } });
          at = s.port ?? at;
          servers.push(s);
        }
        x.servers = servers;
        x.listenPort = at;
        return true;
      } catch {
        for (const s of servers) s.stop(true);
      }
    }
    return false;
  }

  /** Runs the command in the worktree, in its own process group, and waits for it to answer. */
  private run(x: Preview, s: PreviewSettings, pgidFile: string): void {
    // a small environment, so secrets in the hub's own aren't handed over by mistake (it is no fence: see the top)
    const env: Record<string, string> = { ...s.env, PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: x.home, PORT: String(x.port), HOST: "127.0.0.1" };
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
    if (x.pgid !== null) writeFileSync(pgidFile, `${x.pgid}\n`); // a web UI that crashes leaves this for its next start
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
    if (await this.exposed(x)) return;
    if (x.state === "starting") {
      x.state = "running";
      x.lastUsed = Date.now();
      x.checkedAt = Date.now();
    }
  }

  /** Stops `x` when its app answers on another address than 127.0.0.1 (a mistake-catcher, see otherAddresses). */
  private async exposed(x: Preview): Promise<boolean> {
    const host = await exposedOn(x.port);
    if (!host) return false;
    await this.end(x, "failed", { code: "preview_exposed", message: `The app also answers on ${host}:${x.port}, so others on the network could reach it.`,
      fix: "Make the app listen on HOST (127.0.0.1) only, then open the preview again." }, "");
    return true;
  }

  /** Kills the preview's processes, stops its port and removes its worktree and HOME, then marks it `state`. */
  private async end(x: Preview, state: "failed" | "stopped", error: Problem | null, reason: string): Promise<void> {
    if (x.state === "stopping" || x.state === "failed" || x.state === "stopped") return;
    x.state = "stopping";
    x.token = ""; // its cookie and link are dead from now on
    x.code = "";
    for (const s of x.servers) s.stop(true);
    x.servers = [];
    if (x.pgid !== null) {
      killGroup(x.pgid, "SIGTERM");
      const until = Date.now() + KILL_WAIT_MS;
      while (groupAlive(x.pgid) && Date.now() < until) await Bun.sleep(100);
      if (groupAlive(x.pgid)) killGroup(x.pgid, "SIGKILL");
    }
    this.cleanUp(x);
    x.error = error;
    x.reason = reason || error?.message || "";
    x.state = state;
  }

  /** What a preview leaves on this machine: processes still in its worktree (one that left the group), its port, its
   * worktree, HOME and pgid file. Safe to run twice. */
  private cleanUp(x: Preview): void {
    for (const s of x.servers) s.stop(true);
    x.servers = [];
    if (x.real) killIn([x.real], x.pgid !== null ? [x.pgid] : []);
    if (x.dir) {
      git(x.root, ["worktree", "remove", "--force", x.dir]);
      rmSync(x.dir, { recursive: true, force: true });
      rmSync(`${x.dir}.pgid`, { force: true });
      git(x.root, ["worktree", "prune"]);
    }
    if (x.home) rmSync(x.home, { recursive: true, force: true });
  }

  /** At the web UI's start: what an earlier run left in each project's previews/ (it crashed, or was killed) goes: the
   * processes still working in those worktrees, their recorded process groups, the worktrees and their HOMEs. */
  sweep(projects: UiProject[]): void {
    for (const p of projects) {
      if (p.problem) continue;
      const base = join(stateDirOf(p), "previews");
      if (!existsSync(base)) continue;
      const names = readdirSync(base);
      const trees = names.filter((n) => !n.endsWith(".pgid") && !n.endsWith(".home")).map((n) => join(base, n));
      const pgids = names.filter((n) => n.endsWith(".pgid")).map((n) => Number(readFileSync(join(base, n), "utf8").trim())).filter((n) => Number.isInteger(n) && n > 1);
      killIn(trees.map(real), pgids);
      for (const dir of trees) git(p.path, ["worktree", "remove", "--force", dir]);
      for (const n of names) rmSync(join(base, n), { recursive: true, force: true });
      git(p.path, ["worktree", "prune"]);
    }
  }

  /** Each second: idle previews stop, and a running one is checked again for exposure every 30 seconds. */
  private tick(): void {
    const now = Date.now();
    for (const x of this.all.values()) {
      if (x.state !== "running") continue;
      if (now - x.lastUsed >= x.idleMs) {
        const m = Math.max(1, Math.round(x.idleMs / 60_000));
        void this.end(x, "stopped", null, `Stopped after ${m} idle minute${m === 1 ? "" : "s"} with no request.`);
      } else if (!x.checking && now - x.checkedAt >= EXPOSURE_EVERY_MS) {
        x.checking = true;
        void this.exposed(x).finally(() => {
          x.checking = false;
          x.checkedAt = Date.now();
        });
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

  /** The web UI stops: every preview goes now (KILL after a short TERM), with its port, worktree and HOME. */
  stopAll(): void {
    const live = this.active();
    for (const x of live) {
      x.token = "";
      x.code = "";
      if (x.pgid !== null) killGroup(x.pgid, "SIGTERM");
    }
    if (live.some((x) => x.pgid !== null && groupAlive(x.pgid))) Bun.sleepSync(300);
    for (const x of live) {
      if (x.pgid !== null) killGroup(x.pgid, "SIGKILL");
      this.cleanUp(x);
      x.state = "stopped";
      x.reason = "The web UI stopped.";
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  /** Everything preview `own`'s port answers: /preview/<project>/<item>/... of that preview, with its own cookie. */
  private async originFetch(req: Request, server: Server<PreviewSocket>, own: Preview): Promise<Response | undefined> {
    const url = new URL(req.url);
    const answer = (r: ActionResult): Response => new Response(JSON.stringify(r.body), { status: r.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    if (!url.pathname.startsWith("/preview/")) {
      return answer(problem(404, "preview_not_found", "This address serves one sign-off preview only.", "Open the web UI on its own port."));
    }
    const t = this.target(url);
    if (!("x" in t) || t.x !== own) {
      return answer("x" in t ? problem(404, "preview_not_found", "This port serves another preview.", "Open the app from its own sign-off item.") : t);
    }
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
    x.lastUsed = Date.now();
    const path = t.rest + url.search;
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
      const sock: PreviewSocket = { target: `ws://127.0.0.1:${x.port}${path}`, protocols, key: x.key, upstream: null, queue: [] };
      if (server.upgrade(req, { data: sock })) return undefined;
      return new Response("WebSocket upgrade failed\n", { status: 400 });
    }
    let r: Response;
    try {
      r = await fetch(`http://127.0.0.1:${x.port}${path}`, { method: req.method, headers, redirect: "manual",
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer() });
    } catch (e) {
      return answer(problem(502, "preview_unreachable", `The app didn't answer (${e instanceof Error ? e.message : String(e)}).`,
        "Look at the preview's output on its sign-off item, then open the preview again."));
    }
    const out = new Headers(r.headers);
    for (const k of ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]) out.delete(k);
    const loc = out.get("location");
    if (loc) {
      const mine = [`http://127.0.0.1:${x.port}`, `http://localhost:${x.port}`].find((o) => loc.startsWith(o));
      const rel = mine ? loc.slice(mine.length) || "/" : loc;
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
