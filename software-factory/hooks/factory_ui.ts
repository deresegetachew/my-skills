#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory ui [--port N] [--host]` (#421, decision 0005): the factory's web UI on this machine. A Bun server serves one
// page (the app, factory_ui_build.ts) and a JSON API (factory_ui_server.ts) over this project and those in
// `ui.projects`: on the left each project with its channels, one per agent and one per view; on the right the channel.
//
// It listens on 127.0.0.1 only, at `ui.port` (4747; `--port` wins, 0 picks a free one). `--host` adds this machine's
// Tailscale address (`tailscale ip -4`), so the owner's other devices on the tailnet reach it, and nothing else does.
// A token is required on every API call and the WebSocket: it is kept in .git/factory/ui-token (mode 600, made the first
// time, the same at each start so an open page keeps working) and printed with the address. The owner's: an agent
// session is refused. Errors are one JSON line {code, message, fix} on stderr.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, load, toFloat } from "./factory_config.ts";
import { FactoryError, pyDumps, run, runMain, which } from "./factory_lib.ts";
import { appMissing, appScript, findApp } from "./factory_ui_build.ts";
import { projects, uiSetting } from "./factory_ui_data.ts";
import { serve } from "./factory_ui_server.ts";

const USAGE = `usage: factory ui [--port N] [--host]

  The factory's web UI on this machine: each project with its agents and views, live.
  --port N   listen on port N (default ui.port, 4747; 0 picks a free one)
  --host     also listen on this machine's Tailscale address (tailscale ip -4)`;

const DEFAULT_PORT = 4747;
const DEFAULT_POLL = 5;

interface Args {
  port: number | null;
  host: boolean;
}

function fail(code: string, message: string, fix: string): never {
  throw new FactoryError(code, message, fix);
}

function usage(error: string): number {
  process.stderr.write(`${USAGE}\nfactory ui: ${error}\n`);
  return 2;
}

function parse(argv: string[]): Args | string {
  const a: Args = { port: null, host: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i] as string;
    const [flag, inline] = x.startsWith("--port=") ? ["--port", x.slice(7)] : [x, null];
    if (flag === "--host") a.host = true;
    else if (flag === "--port") {
      const v = inline ?? argv[++i];
      if (v === undefined || !/^\d+$/.test(v) || Number(v) > 65535) return `--port takes a number from 0 to 65535, not ${v ?? "nothing"}`;
      a.port = Number(v);
    } else return `unknown option ${x}`;
  }
  return a;
}

/** The whole number setting `key` of `ui`, else `dflt`. */
function intSetting(cfg: Config, key: "port" | "pollSeconds", dflt: number): number {
  const n = toFloat(uiSetting(cfg, key));
  return n !== null && Number.isInteger(n) && n >= 0 ? n : dflt;
}

/** The port the previews are served on (#582): preview.listenPort, else the UI's port + 1 (0, a free one, with port 0). */
function previewListenPort(cfg: Config, port: number): number {
  const v = toFloat((cfg.preview as { listenPort?: unknown } | undefined)?.listenPort);
  if (v !== null && Number.isInteger(v) && v > 0 && v < 65536 && v !== port) return v;
  return port === 0 ? 0 : port + 1;
}

function top(): string {
  const p = run(["git", "rev-parse", "--show-toplevel"]);
  if (p.code !== 0 || !p.stdout.trim()) fail("not_a_project", "factory ui runs inside a project's git repo.", "cd into the project, then run it again.");
  return p.stdout.trim();
}

/** The token in .git/factory/ui-token (the git common dir, so every worktree shares it): kept when it is there, made
 * the first time; the file is mode 600 either way. */
export function token(root: string): string {
  const g = run(["git", "-C", root, "rev-parse", "--git-common-dir"]);
  const dir = join(resolve(root, g.code === 0 && g.stdout.trim() ? g.stdout.trim() : ".git"), "factory");
  const file = join(dir, "ui-token");
  if (existsSync(file)) {
    const kept = readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(kept)) {
      chmodSync(file, 0o600);
      return kept;
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const made = randomBytes(32).toString("base64url");
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, made + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return made;
}

/** This machine's Tailscale IPv4 address. */
function tailscale(): string {
  if (!which("tailscale")) {
    fail("tailscale_missing", "--host listens on this machine's Tailscale address, and tailscale isn't installed here.",
      "Install Tailscale and run `tailscale up`, or run `factory ui` without --host (localhost only).");
  }
  const p = run(["tailscale", "ip", "-4"], { timeoutMs: 10_000 });
  const ip = p.stdout.split(/\s+/).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
  if (p.code !== 0 || !ip) {
    fail("tailscale_down", `\`tailscale ip -4\` gave no address (${(p.stderr.trim() || `exit ${p.code}`).slice(0, 200)}).`,
      "Run `tailscale up`, then `factory ui --host` again.");
  }
  return ip;
}

function link(host: string, port: number, t: string): string {
  return `http://${host}:${port}/?token=${t}`;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const args = parse(argv);
  if (typeof args === "string") return usage(args);
  if (process.env.FACTORY_AGENT || process.env.FACTORY_LOOP) {
    fail("owner_only", `factory ui is the owner's; ${process.env.FACTORY_AGENT || "this session"} is a factory session.`,
      "Leave it to the owner: they run `factory ui` in their own terminal.");
  }
  const root = top();
  const cfg = load();
  const hosts = ["127.0.0.1"];
  const tail = args.host ? tailscale() : null;
  if (tail && !hosts.includes(tail)) hosts.push(tail);
  const app = findApp();
  if (!app) throw appMissing();
  const script = await appScript(app);
  const t = token(root);
  const list = projects(cfg, root);
  const port = args.port ?? intSetting(cfg, "port", DEFAULT_PORT);
  const previewPort = previewListenPort(cfg, port);
  let server: ReturnType<typeof serve>;
  try {
    server = serve({ hosts, port, previewPort, token: t, pollSeconds: Math.max(intSetting(cfg, "pollSeconds", DEFAULT_POLL), 1), projects: list,
      app: new TextDecoder().decode(script) });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (why.startsWith("preview listener:")) { // the previews' own origin (#582)
      fail("ui_preview_port_busy", `factory ui could not listen for previews on port ${previewPort} (${why.slice(17, 200).trim()}).`,
        `Set preview.listenPort to a free port (factory settings set preview.listenPort ${previewPort + 1}), or pick another --port.`);
    }
    if (/EADDRINUSE|in use/i.test(why)) {
      fail("ui_port_busy", `Port ${port} is in use on this machine.`, `Pick another: factory ui --port ${port + 1} (or set ui.port).`);
    }
    fail("ui_listen_failed", `factory ui could not listen on ${hosts.join(" and ")} port ${port} (${why.slice(0, 200)}).`,
      "Pick another port with --port, or run it without --host.");
  }
  const others = list.length - 1;
  // one write, so a reader that waits for the token line has the whole message
  process.stdout.write([`factory ui: serving ${list[0]?.name}${others ? ` and ${others} other project${others > 1 ? "s" : ""}` : ""}`,
    `  open: ${link("127.0.0.1", server.port, t)}`, ...(tail ? [`  tailscale: ${link(tail, server.port, t)}`] : []),
    `  previews: port ${server.previewPort} (their own origin; each sign-off item gives its link)`,
    `  token: ${t} (kept in .git/factory/ui-token)`, "Ctrl-C stops it.", ""].join("\n"));
  await new Promise<void>((done) => {
    const stop = (): void => {
      server.stop();
      done();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

/** main, with a refusal printed as one JSON line {code, message, fix} on stderr, as `factory owner` prints its own. */
async function cli(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (e) {
    if (!(e instanceof FactoryError)) throw e;
    process.stderr.write(pyDumps(e.toJSON()) + "\n");
    return 1;
  }
}

if (import.meta.main) await runMain(() => cli(process.argv.slice(2)));
