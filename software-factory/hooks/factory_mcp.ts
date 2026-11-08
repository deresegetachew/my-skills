#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The MCP config a factory session starts with (#55): the project's `.mcp.json` as the main branch has it on the
// remote, never this worktree's copy. With the message board on (#501), the board's server instead, and nothing else.
//
// `claude --mcp-config <file>` starts the stdio servers in that file without asking, so the file must be one an agent
// can't change: an uncommitted, untracked or branch-only `.mcp.json` is never used. This fetches the remote's default branch
// (asked of the remote, never `mainBranch` in the worktree's .claude/factory.json) from origin, writes its `.mcp.json` to this worktree's git folder
// (`.git/factory-mcp.json`, out of the working tree) and prints that path. When main has none, or the fetch fails,
// it prints the empty config `{"mcpServers":{}}`, so nothing starts. `.mcp.json` is protected, so a change to it
// needs a person to merge.
//
// The board is on when main's `.claude/factory.json` has `tasks.source` board or `messaging.transport` board (unset:
// board on a machine with a board set up, as core/compose.ts decides). Then the session gets exactly one server,
// `board`: `bun message-board/bin.ts mcp --as <agent> --role <builder|manager> --session <id>`, printed inline. A
// coding agent is the board's builder; the dev manager and the product owner are its managers. The board's URL (with
// its password) reaches the server through its environment, MB_URL or this machine's url file, never a command line.
// An actor the board can't take starts no server, with the reason on stderr.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_mcp.ts [--as <agent>] [--role <factory role>] [--session <id>]
//       prints the value for `--mcp-config`
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_mcp.ts board-on
//       exit 0 when main's settings turn the board on (the dev manager's loop then runs `factory board mirror`), else 1
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pyDumps, runMain } from "./factory_lib.ts";

export const EMPTY = '{"mcpServers":{}}';

/** The board's command, beside the hooks folder (my-skills, a linked project, and a release's .claude/). */
export const BOARD_BIN = join(import.meta.dir, "..", "message-board", "bin.ts");

/** The board tools each board role's server offers (message-board/src/mcp.ts), as the agents' rules allow them. */
export const BOARD_TOOLS = {
  builder: ["board_prime", "board_ready", "board_claim", "board_heartbeat", "board_release", "board_close", "board_show",
    "board_post", "board_thread", "board_note", "board_on_me", "board_delegated", "board_attach"],
  manager: ["board_move", "board_create", "board_assign", "board_link", "board_unlink", "board_comment", "board_signoff_add"],
};

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface Out {
  code: number;
  stdout: Buffer;
}

function git(...args: string[]): Out {
  try {
    const p = Bun.spawnSync(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    if (p.exitCode === null) throw new Error("timeout");
    return { code: p.exitCode, stdout: p.stdout };
  } catch {
    throw new Error("git could not run");
  }
}

/** The remote's default branch, asked of the remote itself (`git ls-remote --symref origin HEAD`). Never the
 * worktree's `.claude/factory.json` (`mainBranch`) or a local ref: an agent can change those, and could point them
 * at a branch with its own `.mcp.json` (#77 review). null when the remote can't say: then no servers start. */
export function mainBranch(): string | null {
  const p = git("ls-remote", "--symref", "origin", "HEAD");
  const m = p.code === 0 ? /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(p.stdout.toString()) : null;
  const name = m ? (m[1] as string) : null;
  return name && /^[\w./-]+$/.test(name) && !name.startsWith("-") ? name : null;
}

/** The board role for a factory role: a coding agent builds; the dev manager and the product owner manage. */
export function boardRole(role: string): "builder" | "manager" {
  return role === "dev-manager" || role === "product-owner" ? "manager" : "builder";
}

/** Whether this machine has a message board set up: MB_URL, or the url file in its settings folder (as compose.ts). */
function boardSetUp(): boolean {
  if (process.env.MB_URL) return true;
  const base = process.env.FACTORY_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "software-factory");
  return existsSync(join(base, "message-board", "url"));
}

function field(o: unknown, a: string, b: string): unknown {
  const x = typeof o === "object" && o !== null ? (o as Record<string, unknown>)[a] : undefined;
  return typeof x === "object" && x !== null ? (x as Record<string, unknown>)[b] : undefined;
}

/** Whether the board is on for a project file's settings: tasks on the board, or messages (unset: a board set up here). */
export function boardOn(cfg: unknown): boolean {
  if (field(cfg, "tasks", "source") === "board") return true;
  const t = field(cfg, "messaging", "transport");
  return typeof t === "string" && t ? t === "board" : boardSetUp();
}

/** `--attach-limits <file MB>,<project MB>,<days>` for board_attach (#637) when main's settings set any of
 *  `attachments.maxFileMb`, `maxProjectMb` or `retentionDays`, else nothing (the board's defaults are the settings'). */
export function attachLimitsArgs(cfg: unknown): string[] {
  const a = typeof cfg === "object" && cfg !== null ? (cfg as Record<string, unknown>).attachments : undefined;
  if (typeof a !== "object" || a === null) return [];
  const o = a as Record<string, unknown>;
  const whole = (v: unknown, d: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : d);
  if (o.maxFileMb === undefined && o.maxProjectMb === undefined && o.retentionDays === undefined) return [];
  return ["--attach-limits", `${whole(o.maxFileMb, 25)},${whole(o.maxProjectMb, 2000)},${whole(o.retentionDays, 30)}`];
}

/** The config with only the board's server, for `as` in its board role and session (`cfg`: main's settings). */
export function boardConfig(as: string, role: string, session: string, cfg: unknown = {}): string {
  const args = ["--no-env-file", "--config=/dev/null", BOARD_BIN, "mcp", "--as", as, "--role", boardRole(role), "--session", session,
    ...attachLimitsArgs(cfg)];
  return JSON.stringify({ mcpServers: { board: { type: "stdio", command: process.execPath, args } } });
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v === undefined || v.startsWith("--") ? (i >= 0 ? "" : undefined) : v;
}

/** The board's config for this session, or EMPTY with the reason on stderr when it can't be had. */
function boardFor(args: string[], cfg: unknown): string {
  const as = option(args, "--as") ?? "";
  if (!ACTOR.test(as)) {
    process.stderr.write(pyDumps({ code: "board_actor", message: `The board's server needs the agent it serves, and ${JSON.stringify(as)} isn't a name it takes; this session starts without it.`,
      fix: "Start the session with `factory loop` or `factory agent <name>`, which name the agent." }) + "\n");
    return EMPTY;
  }
  if (!existsSync(BOARD_BIN)) {
    process.stderr.write(pyDumps({ code: "board_missing", message: `This install has no message board: ${BOARD_BIN} is missing; this session starts without it.`,
      fix: "Run `factory update` to a release that ships it, or `factory settings set tasks.source issues`." }) + "\n");
    return EMPTY;
  }
  const given = option(args, "--session");
  return boardConfig(as, option(args, "--role") || "coding-agent", given && ACTOR.test(given) ? given : `${as}-${randomUUID()}`, cfg);
}

function mainFile(path: string): Buffer | null {
  const shown = git("show", `FETCH_HEAD:${path}`);
  return shown.code === 0 ? shown.stdout : null;
}

/** Fetch main from origin (FETCH_HEAD, straight from the remote: a local ref named origin/<main> can't stand in for
 * it) and return its .claude/factory.json; null when main can't be fetched. */
function fetchMainSettings(): unknown {
  const branch = mainBranch();
  if (!branch || git("fetch", "-q", "origin", `refs/heads/${branch}`).code !== 0) return null;
  const settings = mainFile(".claude/factory.json");
  try {
    return settings ? JSON.parse(settings.toString()) : {};
  } catch {
    return {}; // a broken file on main: the board is on only where this machine has one
  }
}

export function main(args: string[] = []): number {
  if (args[0] === "board-on") {
    try {
      const cfg = fetchMainSettings();
      return cfg !== null && boardOn(cfg) ? 0 : 1;
    } catch {
      return 1;
    }
  }
  try {
    const cfg = fetchMainSettings();
    if (cfg === null) {
      console.log(EMPTY);
      return 0;
    }
    if (boardOn(cfg)) {
      console.log(boardFor(args, cfg));
      return 0;
    }
    const shown = mainFile(".mcp.json");
    if (!shown) {
      console.log(EMPTY); // main has no .mcp.json
      return 0;
    }
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(shown)); // a broken file on main: start without servers rather than fail
    const path = resolve(git("rev-parse", "--git-path", "factory-mcp.json").stdout.toString().trim());
    writeFileSync(path, shown);
    console.log(path);
  } catch {
    console.log(EMPTY);
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
