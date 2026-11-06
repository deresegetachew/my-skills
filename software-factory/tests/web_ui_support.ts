// Shared helpers for the web UI's tests (`factory ui`, #421 and #422). Not a test file.
//
// A test project is a git repo with a .claude/factory.json, a fake `gh` (fakegh.ts) first on PATH, a fake `factory`
// script at its top that logs what it was asked (the server runs `factory owner start|stop` through it), and its own
// state and config folders. `startUi` runs the real server (hooks/factory_ui.ts) on a free port and reads the address
// and the token it prints.
import { afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFakeGh } from "./fakegh.ts";
import { BUN, envWith, gitRepo, HOOKS, tmp, write, writeExe } from "./support.ts";

export type Env = Record<string, string | undefined>;
export type Row = Record<string, unknown>;

export interface Project {
  root: string;
  d: string;
  env: Env;
  /** This project's state folder ($XDG_STATE_HOME/<repo>-factory): heartbeat.json, snapshot.json. */
  state: string;
  /** What the fake `factory` script was asked, one line per call. */
  factoryLog: string;
  ghLog: string;
}

export const CONFIG = {
  tasks: { source: "issues" },
  agents: ["menelik", "taytu"],
  roles: { "dev-manager": { names: ["fasil"] }, "product-owner": { names: ["mentewab"] } },
  ui: { pollSeconds: 1 },
};

const FAKE_FACTORY = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
case "$1 $2" in
  "owner stop") echo "Stopped $3." ;;
  "owner start") echo "Started $3 $4 in tmux session work-$4." ;;
  *) echo "fake factory: $*" ;;
esac
`;

/** A project named `work` (its folder), with `cfg` as its factory.json. */
export function project(cfg: Row = CONFIG, name = "work"): Project {
  const root = tmp("factory-ui-");
  const d = join(root, name);
  mkdirSync(d);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  writeExe(join(d, "factory"), FAKE_FACTORY);
  const bin = installFakeGh(root);
  write(join(root, "db.json"), JSON.stringify({ issues: [] }));
  const factoryLog = join(root, "factory.log");
  const ghLog = join(root, "gh.log");
  writeFileSync(factoryLog, "");
  writeFileSync(ghLog, "");
  const xdg = join(root, "state");
  mkdirSync(join(root, "home"));
  const env = envWith(bin, { FAKE_DB: join(root, "db.json"), LOOP_LOG: ghLog, FAKE_FACTORY_LOG: factoryLog,
    XDG_STATE_HOME: xdg, XDG_CONFIG_HOME: join(root, "config"), HOME: join(root, "home"), FACTORY_AGENT: undefined,
    FACTORY_LOOP: undefined, FACTORY_ROLE: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENTS: undefined,
    FACTORY_CONFIG_DIR: undefined, FACTORY_SELF: undefined, FACTORY_NOW: undefined, NO_COLOR: "1" });
  return { root, d, env, state: join(xdg, `${name}-factory`), factoryLog, ghLog };
}

/** One heartbeat row, as the daemon writes it. */
export function hbRow(name: string, more: Row = {}): Row {
  return { name, kind: "coding-agent", machine: "m-here", path: null, pid: 4242, session: `work-${name}`, follow: null,
    activity: null, state: "idle", detail: "idle", task: null, on: null, runs: "tmux", log: null, since: "2026-11-05T10:00:00Z",
    ...more };
}

/** Writes this machine's heartbeat file, fresh now, with `rows`. */
export function heartbeat(p: Project, rows: Row[]): void {
  const agents: Record<string, Row> = {};
  for (const r of rows) agents[String(r.name)] = r;
  write(join(p.state, "heartbeat.json"), JSON.stringify({ machine: "m-here", pid: 1, updated: Date.now() / 1000, interval: 20,
    agents, errors: [] }));
}

export interface Running {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  token: string;
  out: string;
  stop: () => Promise<void>;
}

/** Reads `stream` until `done(text)` says so or `ms` pass; returns what it read. */
async function readUntil(stream: ReadableStream<Uint8Array>, done: (text: string) => boolean, ms: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (!done(text) && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), Bun.sleep(Math.max(deadline - Date.now(), 1)).then(() => null)]);
      if (next === null || next.done) break;
      text += decoder.decode(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

// Every server startUi starts, until its stop() (#476). A test that fails or times out before it calls stop() would
// leave its server running; these stop when the file's tests end, or when the test process exits.
const RUNNING = new Set<ReturnType<typeof Bun.spawn>>();
function stopAll(): void {
  for (const p of RUNNING) p.kill(9);
  RUNNING.clear();
}
// After the tests, wait until each server has really exited, so nothing is left even for a moment.
afterAll(async () => {
  const left = [...RUNNING];
  stopAll();
  await Promise.all(left.map((p) => p.exited));
});
process.on("exit", stopAll);

/** Runs `factory ui` (the hook itself, or through `cmd`) in the project and waits for its address and token. */
export async function startUi(p: Project, args: string[] = ["--port", "0"], cmd: string[] | null = null, env: Env = {}): Promise<Running> {
  const full = { ...p.env, ...env };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(full)) if (v !== undefined) clean[k] = v;
  const proc = Bun.spawn([...(cmd ?? [...BUN, join(HOOKS, "factory_ui.ts")]), ...args], { cwd: p.d, env: clean, stdin: "ignore",
    stdout: "pipe", stderr: "pipe" });
  RUNNING.add(proc);
  const out = await readUntil(proc.stdout as ReadableStream<Uint8Array>, (t) => t.includes("Ctrl-C stops it."), 20_000);
  const url = /(http:\/\/127\.0\.0\.1:\d+)\//.exec(out)?.[1] ?? "";
  const token = /token: (\S+)/.exec(out)?.[1] ?? "";
  const stop = async (): Promise<void> => {
    proc.kill();
    await proc.exited;
    RUNNING.delete(proc);
  };
  if (!url || !token) {
    await stop();
    const err = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    throw new Error(`factory ui did not start: ${out}\n${err}`);
  }
  return { proc, url, token, out, stop };
}

/** A GET or POST to the running server with the token, as JSON. */
export async function api(ui: Running, path: string, init: { method?: string; body?: unknown; token?: string | null } = {}):
  Promise<{ status: number; type: string; json: Row }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = init.token === undefined ? ui.token : init.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const r = await fetch(ui.url + path, { method: init.method ?? "GET", headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await r.text();
  let json: Row = {};
  try {
    json = JSON.parse(text) as Row;
  } catch {
    json = { text };
  }
  return { status: r.status, type: r.headers.get("content-type") ?? "", json };
}
