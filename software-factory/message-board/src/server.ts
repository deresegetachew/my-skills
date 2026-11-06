// The board's own Postgres on this machine: a container from the official image, run with `docker compose`, published
// only on 127.0.0.1 and this machine's Tailscale address (decision 0007 point 8). Its files live in the machine's
// settings folder, <settings>/message-board/: compose.yaml, db.env and password (mode 600), url (mode 600), state.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BoardError } from "./errors.ts";

export const IMAGE = "postgres:17-alpine";
export const COMPOSE_PROJECT = "factory-message-board";
export const DB_USER = "factory";
export const DB_NAME = "board";
/** The host port on 127.0.0.1; other machines use the next one on the Tailscale address (Docker won't publish one port
 * on two addresses). */
export const DEFAULT_PORT = 5433;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export interface State {
  port: number;
  tailnetPort: number;
  address: string; // the Tailscale address, or "" for localhost only
  image: string;
}

/** <machine settings folder>/message-board: FACTORY_CONFIG_DIR, else $XDG_CONFIG_HOME or ~/.config, /software-factory. */
export function boardDir(): string {
  const base = process.env.FACTORY_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "software-factory");
  return join(base, "message-board");
}

/** The board's URL: MB_URL, else the url file (made mode 600 if it was readable by others). Null when there is none. */
export function boardUrl(): string | null {
  if (process.env.MB_URL) return process.env.MB_URL;
  const file = join(boardDir(), "url");
  if (!existsSync(file)) return null;
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  const url = readFileSync(file, "utf8").trim();
  return url || null;
}

/** A URL with its password hidden. */
export function masked(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@\s]*@/, "//***@");
  }
}

export function readState(): State | null {
  try {
    return JSON.parse(readFileSync(join(boardDir(), "state.json"), "utf8")) as State;
  } catch {
    return null;
  }
}

/** A file write that can be undone: the old content (or none) is kept until the command ends. */
export class Writes {
  private before: [string, string | null][] = [];
  changed = false;

  put(path: string, text: string, mode: number): void {
    let old: string | null = null;
    try {
      old = readFileSync(path, "utf8");
    } catch {
      old = null;
    }
    if (old !== text) {
      this.before.push([path, old]);
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, text, { mode });
      chmodSync(tmp, mode);
      renameSync(tmp, path);
      this.changed = true;
    }
    chmodSync(path, mode);
  }

  undo(): void {
    for (const [path, old] of this.before.reverse()) {
      if (old === null) rmSync(path, { force: true });
      else writeFileSync(path, old);
    }
    this.before = [];
  }
}

export function ensureDir(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

export function sh(cmd: string[], opts: { cwd?: string; timeoutMs?: number; stdout?: number } = {}): { code: number; stdout: string; stderr: string } {
  try {
    const p = Bun.spawnSync(cmd, { cwd: opts.cwd, stdin: "ignore", stdout: opts.stdout ?? "pipe", stderr: "pipe", timeout: opts.timeoutMs ?? 120_000 });
    return { code: p.exitCode ?? 124, stdout: p.stdout?.toString() ?? "", stderr: p.stderr?.toString() ?? "" };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

export function which(name: string): boolean {
  return Bun.which(name) !== null;
}

export function dockerReady(): void {
  if (!which("docker")) {
    throw new CommandError("docker-missing", "Docker isn't installed or isn't on your PATH; the board's Postgres runs in Docker.",
      "Install Docker (Docker Desktop or Colima on macOS, rootless Docker on a factory machine), then run this again.");
  }
  if (sh(["docker", "info"], { timeoutMs: 30_000 }).code !== 0) {
    throw new CommandError("docker-down", "Docker isn't running (or this user can't reach it).", "Start Docker, then run this again.");
  }
}

/** This machine's Tailscale IPv4 address, or "" when Tailscale is missing or not up. */
export function tailscaleAddress(): string {
  if (!which("tailscale")) return "";
  const p = sh(["tailscale", "ip", "-4"], { timeoutMs: 10_000 });
  const first = (p.stdout.trim().split("\n")[0] ?? "").trim();
  return p.code === 0 && IPV4.test(first) ? first : "";
}

export function compose(args: string[], opts: { stdout?: number; timeoutMs?: number } = {}): { code: number; stdout: string; stderr: string } {
  const dir = boardDir();
  return sh(["docker", "compose", "--file", join(dir, "compose.yaml"), "--project-name", COMPOSE_PROJECT, ...args],
    { cwd: dir, timeoutMs: opts.timeoutMs ?? 300_000, stdout: opts.stdout });
}

/** The compose file: the pinned image, the credentials from db.env, the data volume, and the host ports on localhost
 * and the Tailscale address only. */
export function composeYaml(s: State): string {
  const ports = [`127.0.0.1:${s.port}:5432`];
  if (s.address) ports.push(`${s.address}:${s.tailnetPort}:5432`);
  return [
    "# Written by `factory board up` (decision 0007). Run it again to change this file; edits here are overwritten.",
    `name: ${COMPOSE_PROJECT}`,
    "services:",
    "  db:",
    `    image: ${s.image}`,
    "    restart: unless-stopped",
    "    env_file: db.env",
    "    ports:",
    ...ports.map((p) => `      - "${p}"`),
    "    volumes:",
    "      - data:/var/lib/postgresql/data",
    "volumes:",
    "  data:",
    "",
  ].join("\n");
}

export function urlFor(password: string, port: number, host = "127.0.0.1"): string {
  return `postgres://${DB_USER}:${encodeURIComponent(password)}@${host}:${port}/${DB_NAME}`;
}

/** An error the command prints as {code, message, fix}, for the command's own codes (Docker, files, verbs). */
export class CommandError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
  }
}

export function isCommandError(e: unknown): e is CommandError | BoardError {
  return e instanceof CommandError || e instanceof BoardError;
}
