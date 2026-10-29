// `factory cockpit` (#308, PRD US-10, decision 0001): the read-only cockpit, one terminal window built on tmux.
//
//   factory cockpit              open it (or come back to it): sessions and views on the left, the selected session on
//                                the right, the counts on top (`factory cockpit --status`), the keys at the bottom
//
// It runs on its own tmux server (socket factory-cockpit-<repo>), so its prefix (C-a) and keys never change the owner's
// own tmux, and a tmux nested over ssh keeps C-b. The config is written to this machine's state folder each time it
// opens. The right pane runs `factory follow <name>`, which attaches to the agent's real Claude Code session (on this
// machine with its tmux, elsewhere over ssh). Views are popups that run the existing commands through `less -R`.
// Read-only in this step: the commands that change GitHub or the machine come with US-11, and the commands that agents
// and the gate use are never offered. A new owner ask rings the bell from the list, once (#310, US-12). The panes and
// popups run these, which are not for typing:
//
//   factory cockpit --sidebar    the list on the left (off a terminal: one frame, sized by COLUMNS and LINES)
//   factory cockpit --bar        the `:` command bar: type to pick a factory command (off a terminal: one line on stdin)
//   factory cockpit --needs      the "Needs you" view, from the cache
//   factory cockpit --prs [<n>]  the Pull requests view (#338), from `factory prs --json`
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { load } from "./factory_config.ts";
import { readCache, refreshIfOld } from "./factory_cockpit.ts";
import { run, which } from "./factory_lib.ts";
import { refuse, repoKey, stateDir } from "./factory_machine.ts";
import { sessionName, tmuxTooOld } from "./factory_window.ts";

type Obj = { [key: string]: unknown };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** `str`, without escape sequences or control characters: a PR title or session name can't drive the terminal. */
function plain(v: unknown): string {
  return str(v)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "") // OSC: a window title, a link
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI: colours, cursor moves, clearing the screen
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

// --- what the cockpit offers -----------------------------------------------------------------------------------------

export interface View {
  key: string;
  title: string;
  commands: string[][];
  /** Draws its own screen and reads keys (#338): runs in the popup as it is, not through `less -R`. */
  live?: boolean;
}

/** The views of US-10, each the existing commands it runs; US-13 moves them towards their boards one by one. */
export function views(): View[] {
  const issues = str(obj(obj(load()).tasks).source) === "issues";
  return [
    { key: "1", title: "Needs you", commands: [["cockpit", "--needs"]] },
    { key: "2", title: "Pull requests", commands: [["cockpit", "--prs"]], live: true },
    { key: "3", title: "Tasks & PRD", commands: [issues ? ["issues", "list"] : ["next"]] },
    { key: "4", title: "CI", commands: [["ci", "status"]] },
    { key: "5", title: "Agents & machines", commands: [["agents", "ls"], ["machine", "show"]] },
    { key: "6", title: "Settings", commands: [["settings", "list"]] },
    { key: "7", title: "Health & releases", commands: [["doctor"], ["version"]] },
    { key: "8", title: "Usage & lessons", commands: [["usage"], ["lessons", "show"]] },
  ];
}

/** The read-only commands the `:` bar offers. */
export const OFFERED = ["status", "prs", "next", "claims list", "agents ls", "messages ls", "issues list", "issues show",
  "ci status", "ci log", "ci runners", "settings list", "settings show", "settings get", "settings help", "settings diff",
  "usage", "report", "lessons show", "doctor", "version", "env", "machine show", "remote list", "help"];

/** The offered commands that take words after them (an issue, a run, a setting), never a flag: `factory <cmd>` passes
 *  the rest of the line on, and flags such as `next --claim` or `usage --record` change things. */
const TAKES_WORDS = ["issues show", "ci log", "settings show", "settings get", "settings help", "help"];

/** The offered command the words start with, when the rest is allowed after it; else undefined. */
function offeredLine(words: string[]): string | undefined {
  const text = words.join(" ");
  const n = OFFERED.filter((o) => text === o || text.startsWith(`${o} `)).sort((a, b) => b.length - a.length)[0];
  if (n === undefined) return undefined;
  const rest = words.slice(n.split(" ").length);
  return !rest.length || (TAKES_WORDS.includes(n) && rest.every((w) => !w.startsWith("-"))) ? n : undefined;
}

/** What agents and the gate use: never in the cockpit (US-10). */
const FOR_AGENTS = ["review-pass", "wait", "run-check", "guard", "rereview", "manager-claims"];

/** Commands that change GitHub or the machine: from the cockpit with US-11, not in this read-only step. */
const ACTIONS = ["loop", "coding-agent", "dev-manager", "product-owner", "init", "init-roles", "agent", "autostart",
  "resume", "heartbeat", "reset-run", "worktree", "say", "verify", "fix", "check", "turbo", "bootstrap", "update",
  "release", "rollback", "migrate-to-release", "cockpit", "follow", "lessons", "settings", "remote", "issues", "ci",
  "machine", "agents", "messages", "alerts", "claims", "next", "usage"];

/** How well `name` matches what was typed: lower is better, null for no match (start, then letters in order). */
export function rank(name: string, typed: string): number | null {
  if (!typed) return 0;
  if (name.startsWith(typed)) return name.length - typed.length;
  let at = 0;
  for (const ch of typed) {
    at = name.indexOf(ch, at) + 1;
    if (at === 0) return null;
  }
  return 1000 + at;
}

export function matches(typed: string): string[] {
  const ranked = OFFERED.map((n) => [n, rank(n, typed)] as const).filter((x): x is readonly [string, number] => x[1] !== null);
  return ranked.sort((a, b) => a[1] - b[1]).map((x) => x[0]);
}

/** What the typed line runs: its words when it starts with an offered command, else the best match. Refuses the rest. */
export function resolve(line: string): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const text = words.join(" ");
  if (offeredLine(words)) return words;
  const first = words[0] ?? "";
  if (FOR_AGENTS.includes(first)) {
    refuse("cockpit_not_offered", `\`factory ${first}\` is for the agents and the gate, so the cockpit does not offer it.`,
      "Leave it to them; to look at the factory, type `status`, `prs` or `ci status`.", 2);
  }
  // An action word is refused, not matched to some other command; alone it may still start one (`ci` runs `ci log`, the shortest).
  // So is a flag, or more words after an offered command than it takes (`claims list x`, `next --claim taytu`).
  const startsOne = words.length === 1 && OFFERED.some((n) => n.startsWith(first));
  const extra = words.some((w) => w.startsWith("-")) || OFFERED.some((n) => text.startsWith(`${n} `));
  if (extra || (ACTIONS.includes(first) && !startsOne)) {
    refuse("cockpit_not_offered", `\`factory ${text}\` changes things, and the cockpit is read-only in this step.`,
      `Run \`factory ${text}\` in a shell; type \`help\` here to see every command.`, 2);
  }
  const best = matches(text)[0];
  if (best === undefined) {
    refuse("cockpit_no_match", `No factory command the cockpit offers matches "${text}".`,
      `Type part of one of: ${OFFERED.join(", ")}.`, 2);
  }
  return best.split(" ");
}

// --- how panes and popups run the factory ----------------------------------------------------------------------------

function top(): string {
  const p = run(["git", "rev-parse", "--show-toplevel"]);
  return p.code === 0 && p.stdout.trim() ? p.stdout.trim() : process.cwd();
}

/** The factory script that started us (FACTORY_SELF), else the project's own. */
function factoryScript(root: string): string {
  const self = process.env.FACTORY_SELF;
  return self && existsSync(self) ? self : join(root, "factory");
}

/** Double quotes for sh, so a command can sit inside a single-quoted tmux string. */
function dq(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

function factoryCall(script: string, args: string[]): string {
  return ["bash", dq(script), ...args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : dq(a)))].join(" ");
}

/** A view as one sh command: a heading, each command's output, through `less -R`; a live view runs as it is. */
export function viewCommand(script: string, v: View): string {
  const parts = v.commands.map((c) => factoryCall(script, c));
  if (v.live) return parts.join("; ");
  return `{ echo ${dq(v.title)}; echo; ${parts.join("; echo; ")}; } 2>&1 | less -R`;
}

/** Single quotes for tmux's config: nothing inside is expanded. */
function tq(s: string): string {
  if (s.includes("'")) {
    refuse("cockpit_path_quote", `The path ${s} has a single quote, which the cockpit's tmux config can't hold.`,
      "Move the project (or the factory) to a folder without a ' in its name.", 2);
  }
  return `'${s}'`;
}

/** The pane on the right when no session is picked, and after one closes. */
function idleCommand(text: string): string {
  return `echo; echo ${dq(text)}; exec tail -f /dev/null`;
}

const IDLE_TEXT = "Pick a session on the left and press Enter to see it here. C-a C-a comes back to the list.";

export function socket(): string {
  return `factory-cockpit-${repoKey()}`.replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** The cockpit's tmux config. */
export function config(root: string, script: string): string {
  const popup = (size: string, cmd: string) => `display-popup -E ${size} -d ${tq(root)} ${tq(cmd)}`;
  const lines = [
    "# The factory cockpit (#308). `factory cockpit` writes this file each time it opens: edits here are lost.",
    "# Its own prefix, so a tmux nested over ssh keeps C-b. Only prefixed keys are bound: / and : stay the session's.",
    "set -g prefix C-a",
    "unbind C-b",
    "set -g prefix2 None",
    "set -g escape-time 10",
    "set -g base-index 0",
    "set -g pane-base-index 0",
    "# C-a C-a (or C-a Left) back to the list; C-a Right to the session; C-a d leaves the cockpit, everything keeps running.",
    "bind C-a select-pane -t :.0",
    "bind Left select-pane -t :.0",
    "bind Right select-pane -t :.1",
    "bind d detach-client",
    "bind q detach-client",
    "# : the command bar over the factory's read-only commands.",
    `bind : ${popup("-w 80% -h 60%", factoryCall(script, ["cockpit", "--bar"]))}`,
    "# The views, as popups running the existing commands through less -R (q closes).",
  ];
  for (const v of views()) {
    lines.push(`# ${v.key} ${v.title}`, `bind ${v.key} ${popup("-w 90% -h 90%", viewCommand(script, v))}`);
  }
  const status = `cd ${dq(root)} && ${factoryCall(script, ["cockpit", "--status"])}`;
  lines.push(
    "# On top, the counts and \"N need you\"; at the bottom of each pane, the keys that work there.",
    "set -g status on",
    "set -g status-position top",
    "set -g status-interval 15",
    "set -g status-left '#[bold] cockpit #[default]'",
    "set -g status-left-length 12",
    "set -g status-right-length 200",
    `set -g status-right ${tq(`#(${status}) `)}`,
    "set -g window-status-format ''",
    "set -g window-status-current-format ''",
    "# A new owner ask rings the bell in the list (#310); tmux passes it on to the owner's terminal from any pane.",
    "set -g monitor-bell on",
    "set -g bell-action any",
    "set -g visual-bell off",
    "set -g pane-border-status bottom",
    "set -g pane-border-format '#{?#{==:#{pane_index},0}, the list ,"
      + " C-a C-a the list · C-a : commands · C-a 1-8 views · C-a d leave }'",
  );
  return lines.join("\n") + "\n";
}

// --- factory cockpit: open it ----------------------------------------------------------------------------------------

function tmux(sock: string, args: string[]): { code: number; stderr: string } {
  const p = run(["tmux", "-L", sock, ...args], { timeoutMs: 30_000 });
  return { code: p.code, stderr: p.stderr };
}

function writeConfig(text: string): string {
  const path = join(stateDir(), "cockpit.tmux.conf");
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  chmodSync(tmp, 0o644); // the umask must not decide: only this user writes it
  renameSync(tmp, path);
  return path;
}

export function open(): number {
  delete process.env.TMUX; // its own server, even inside another tmux: never a nested switch-client
  if (!which("tmux")) {
    refuse("no-tmux", "The cockpit runs in tmux, and tmux is not installed.",
      "Install tmux 3.2 or newer (for example `sudo apt install tmux` or `brew install tmux`), then run `factory cockpit` again.", 2);
  }
  const old = tmuxTooOld();
  if (old) {
    refuse("tmux-too-old", `The cockpit needs tmux 3.2 or newer, and this is tmux ${old}.`,
      "Upgrade tmux (for example `sudo apt install tmux` on a recent release, or `brew upgrade tmux`), then run `factory cockpit` again.", 2);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    refuse("cockpit_needs_terminal", "The cockpit is a terminal window, and this is not a terminal.",
      "Run `factory cockpit` in a terminal (over ssh: `ssh -t <host>`); for the data, `factory cockpit --json`.", 2);
  }
  const root = top();
  const script = factoryScript(root);
  const conf = writeConfig(config(root, script));
  const sock = socket();
  const session = sessionName("cockpit");
  if (tmux(sock, ["has-session", "-t", `=${session}`]).code === 0) {
    tmux(sock, ["source-file", conf]);
  } else {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    const sidebar = `exec env FACTORY_COCKPIT=${dq(session)} ${factoryCall(script, ["cockpit", "--sidebar"])}`;
    const made = tmux(sock, ["-f", conf, "new-session", "-d", "-s", session, "-n", "cockpit", "-x", String(cols),
      "-y", String(rows), "-c", root, sidebar]);
    if (made.code !== 0) {
      refuse("tmux-failed", `tmux could not start the cockpit: ${(made.stderr.trim().split("\n").pop() || "no session").slice(0, 160)}`,
        `Run \`tmux -L ${sock} ls\` to see what is there, then run \`factory cockpit\` again.`, 2);
    }
    tmux(sock, ["source-file", conf]); // a server that was already up kept its old config
    const right = String(Math.max(cols - 34, Math.floor(cols * 0.6)));
    tmux(sock, ["split-window", "-h", "-t", `=${session}:0`, "-l", right, "-c", root, idleCommand(IDLE_TEXT)]);
    tmux(sock, ["select-pane", "-t", `=${session}:0.0`]);
  }
  const p = Bun.spawnSync(["tmux", "-L", sock, "attach-session", "-t", `=${session}`],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, TMUX: undefined } });
  return p.exitCode ?? 1;
}

// --- the list on the left --------------------------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*m/g;

/** Cuts a line to `cols` visible characters. */
function fit(line: string, cols: number): string {
  const plain = line.replace(ANSI, "");
  return plain.length <= cols ? line : `${plain.slice(0, Math.max(cols - 1, 0))}…`;
}

function taskNumber(v: unknown): number | null {
  const m = /#?(\d+)/.exec(str(v));
  return m ? Number(m[1]) : null;
}

/** A session needs the owner when it waits on a question, or an owner ask is on its task. */
export function needsYou(row: Obj, needs: Obj[]): boolean {
  if (str(row.state) === "input-required") return true;
  const task = taskNumber(row.task);
  return task !== null && needs.some((n) => n.kind === "owner-ask" && Number(n.issue) === task);
}

export interface Entry {
  kind: "session" | "view";
  label: string;
  name: string;
}

export function entries(snap: Obj | null, vs: View[]): Entry[] {
  const needs = list(snap?.needsYou);
  const out: Entry[] = list(snap?.sessions).map((r) => ({ kind: "session", name: str(r.name),
    label: `${plain(r.name)}  ${plain(r.state) || "unknown"}${needsYou(r, needs) ? "  ● needs you" : ""}` }));
  const n = needs.length;
  for (const v of vs) out.push({ kind: "view", name: v.key, label: `${v.key} ${v.title}${v.key === "1" && n ? ` (${n})` : ""}` });
  return out;
}

/** One screen of the list, `rows` lines at most, each at most `cols` wide. */
export function frame(snap: Obj | null, vs: View[], selected: number, cols: number, rows: number, color: boolean): string[] {
  const all = entries(snap, vs);
  const body: string[] = [];
  let selLine = 0;
  const mark = (e: Entry, i: number) => {
    if (i === selected) selLine = body.length;
    const text = `${i === selected ? "›" : " "} ${e.label}`;
    return color && i === selected ? `\x1b[7m${text}\x1b[0m` : text;
  };
  body.push("SESSIONS");
  const sessions = all.filter((e) => e.kind === "session");
  if (!sessions.length) body.push("  No sessions running.", "  Start one: factory loop -i");
  all.forEach((e, i) => {
    if (e.kind === "session") body.push(mark(e, i));
  });
  body.push("", "VIEWS");
  all.forEach((e, i) => {
    if (e.kind === "view") body.push(mark(e, i));
  });
  const keys = rows < 16 ? ["↑↓ Enter · 1-8 · : · q"] :
    ["", all[selected]?.kind === "session" ? "Enter shows the session" : "Enter opens the view", "↑↓ move · 1-8 views", ": commands · q leave"];
  const room = Math.max(rows - keys.length, 1);
  const start = Math.min(Math.max(selLine - room + 1, 0), Math.max(body.length - room, 0));
  const shown = body.slice(start, start + room);
  while (shown.length < room) shown.push("");
  return [...shown, ...keys].slice(0, Math.max(rows, 1)).map((l) => fit(l, Math.max(cols, 1)));
}

// --- the bell (#310, PRD US-12) --------------------------------------------------------------------------------------
//
// The alerts of US-7 (#303) in the cockpit: a new owner ask in the cache rings the terminal bell from the list, once,
// and the badge and the count show it at the same look. Never a desktop notice: `factory alerts` gives that one, so it
// is not doubled. Each ask rung is a marker file in `cockpit-rung/` in the state folder, made with O_EXCL, so of several
// cockpits (or lists) looking at once only one rings. The first look with a snapshot only records the asks already
// open: they are not new.

const BEL = "\x07";

function rungDir(): string {
  return join(stateDir(), "cockpit-rung");
}

function askKey(n: Obj): string {
  return `ask-${str(n.issue)}-${str(n.id)}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Marks the snapshot's owner asks as seen; returns how many were new, and so ring. None on the first look. */
export function newAsks(snap: Obj | null): number {
  if (snap === null) return 0; // no snapshot yet: the first one is the first look
  const asks = list(snap.needsYou).filter((n) => n.kind === "owner-ask");
  const dir = rungDir();
  if (!existsSync(dir)) {
    // The first look, made whole in a folder of its own and renamed into place: of two at once, one wins.
    const tmp = `${dir}.${process.pid}.tmp`;
    try {
      mkdirSync(tmp, { recursive: true });
      for (const a of asks) writeFileSync(join(tmp, askKey(a)), "");
      renameSync(tmp, dir);
      return 0;
    } catch {
      rmSync(tmp, { recursive: true, force: true }); // another look was first: go on as a later one
    }
  }
  let fresh = 0;
  for (const a of asks) {
    try {
      writeFileSync(join(dir, askKey(a)), "", { flag: "wx" });
      fresh += 1;
    } catch {
      // rung already, by this cockpit or another just now
    }
  }
  return fresh;
}

function sidebarOnce(): number {
  const cols = Number(process.env.COLUMNS) || 32;
  const rows = Number(process.env.LINES) || 30;
  const snap = readCache();
  console.log(BEL.repeat(newAsks(snap)) + frame(snap, views(), 0, cols, rows, false).join("\n"));
  return 0;
}

async function sidebarLoop(): Promise<number> {
  const session = process.env.FACTORY_COCKPIT ?? "";
  const sock = socket();
  const root = top();
  const script = factoryScript(root);
  const vs = views();
  let snap = readCache();
  let selected = 0;
  const draw = () => {
    const lines = frame(snap, vs, selected, process.stdout.columns || 32, process.stdout.rows || 30, true);
    process.stdout.write(BEL.repeat(newAsks(snap)) + "\x1b[H\x1b[2J" + lines.join("\r\n"));
  };
  // display-popup waits until the popup closes, so it has no timeout: a view stays open as long as the owner reads it.
  const popup = (size: string[], cmd: string) =>
    Bun.spawnSync(["tmux", "-L", sock, "display-popup", "-E", ...size, "-d", root, cmd], { stdout: "ignore", stderr: "ignore" });
  const openView = (v: View) => popup(["-w", "90%", "-h", "90%"], viewCommand(script, v));
  const act = () => {
    const e = entries(snap, vs)[selected];
    if (!e) return;
    if (e.kind === "view") {
      const v = vs.find((x) => x.key === e.name);
      if (v) openView(v);
      return;
    }
    const after = idleCommand(`The session ${plain(e.name)} closed here. C-a C-a comes back to the list.`);
    tmux(sock, ["respawn-pane", "-k", "-t", `=${session}:0.1`, `${factoryCall(script, ["follow", e.name])}; ${after}`]);
    tmux(sock, ["select-pane", "-t", `=${session}:0.1`]);
  };
  process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?25l");
  process.stdout.on("resize", draw);
  const timer = setInterval(() => {
    refreshIfOld();
    snap = readCache();
    selected = Math.min(selected, Math.max(entries(snap, vs).length - 1, 0));
    draw();
  }, 5_000);
  refreshIfOld();
  draw();
  for await (const chunk of process.stdin) {
    const key = String(chunk);
    const count = entries(snap, vs).length;
    if (key === "\x1b[A" || key === "k") selected = Math.max(selected - 1, 0);
    else if (key === "\x1b[B" || key === "j") selected = Math.min(selected + 1, count - 1);
    else if (key === "\r" || key === "\n") act();
    else if (/^[1-8]$/.test(key)) {
      const v = vs.find((x) => x.key === key);
      if (v) openView(v);
    } else if (key === ":") popup(["-w", "80%", "-h", "60%"], factoryCall(script, ["cockpit", "--bar"]));
    else if (key === "q") tmux(sock, ["detach-client"]);
    else if (key === "r") {
      snap = readCache();
    } else if (key === "\x03") break;
    draw();
  }
  clearInterval(timer); // else the timer keeps the pane's process alive after C-c
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?25h\r\n");
  return 0;
}

export function sidebar(): Promise<number> | number {
  return process.stdin.isTTY && process.stdout.isTTY ? sidebarLoop() : sidebarOnce();
}

// --- the command bar -------------------------------------------------------------------------------------------------

function runOffered(args: string[], paged: boolean): number {
  const script = factoryScript(top());
  if (!paged) {
    const p = Bun.spawnSync(["bash", script, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    return p.exitCode ?? 1;
  }
  const p = Bun.spawnSync(["sh", "-c", `${factoryCall(script, args)} 2>&1 | less -R`],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return p.exitCode ?? 1;
}

async function barLoop(): Promise<number> {
  let typed = "";
  let at = 0;
  const draw = () => {
    const rows = Math.max((process.stdout.rows || 20) - 3, 1);
    const found = matches(typed).slice(0, rows);
    const lines = [`factory ${typed}`, "Type to pick · ↑↓ · Enter runs it · Esc closes", "",
      ...found.map((m, i) => (i === at ? `\x1b[7m› ${m}\x1b[0m` : `  ${m}`))];
    if (!found.length) lines.push("  no command the cockpit offers matches");
    process.stdout.write("\x1b[H\x1b[2J" + lines.join("\r\n"));
  };
  process.stdin.setRawMode(true);
  draw();
  for await (const chunk of process.stdin) {
    const key = String(chunk);
    if (key === "\x1b" || key === "\x03") return 0;
    if (key === "\r" || key === "\n") {
      const pick = matches(typed)[at];
      const words = typed.trim().split(/\s+/).filter(Boolean);
      // What was typed runs as it is when it starts with an offered command (`ci log 12`); else the line picked.
      // A line with a flag or extra words is left as typed, so resolve() refuses it rather than running the pick.
      const asTyped = offeredLine(words) || words.some((w) => w.startsWith("-")) || OFFERED.some((n) => words.join(" ").startsWith(`${n} `));
      const line = asTyped ? typed : pick ?? typed;
      process.stdin.setRawMode(false);
      process.stdout.write("\x1b[H\x1b[2J");
      try {
        return runOffered(resolve(line), true);
      } catch (e) {
        await Bun.sleep(4_000); // the refusal stays on screen a moment before the popup closes
        throw e;
      }
    }
    if (key === "\x7f" || key === "\b") typed = typed.slice(0, -1);
    else if (key === "\x1b[A") at = Math.max(at - 1, 0);
    else if (key === "\x1b[B") at = Math.min(at + 1, Math.max(matches(typed).length - 1, 0));
    else if (/^[\x20-\x7e]+$/.test(key)) typed += key;
    if (key !== "\x1b[A" && key !== "\x1b[B") at = 0;
    draw();
  }
  return 0;
}

export async function bar(): Promise<number> {
  if (process.stdin.isTTY && process.stdout.isTTY) return barLoop();
  const line = (await new Response(Bun.stdin.stream()).text()).split(/\r?\n/)[0] ?? "";
  return runOffered(resolve(line), false);
}

// --- the Needs you view ----------------------------------------------------------------------------------------------

export function needs(): number {
  const snap = readCache();
  const items = list(snap?.needsYou);
  if (snap === null) console.log("No snapshot yet: `factory cockpit --json` reads one now.");
  else if (!items.length) console.log("Nothing needs you.");
  for (const n of items) {
    if (n.kind === "owner-ask") console.log(`Owner ask ${plain(n.id)} on #${plain(n.issue)}: ${plain(n.url)}`);
    else if (n.kind === "owner-merges") console.log(`PR #${plain(n.number)} ${plain(n.title)} is yours to merge: ${plain(n.url)}`);
    else console.log(JSON.stringify(n)); // JSON escapes control characters itself
  }
  return 0;
}

// --- the Pull requests view (#338, PRD US-13) ------------------------------------------------------------------------
//
// `factory cockpit --prs [<n>]`, the view `C-a 2` runs, towards its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/
// VPrs.dc.html). One row per open PR (number, title and " · protected", by, CI, the dev manager's word, who acts,
// next), and the selected PR's detail below it: branch, head, the newest marker, any review claim, CI job by job, open
// questions, protected paths and the next action. The keys that work are at the bottom. Its data is `factory prs
// --json` (the views cache keeps it, #305), so CI is judged by the manager's one rule. On a terminal: j k (or ↑ ↓)
// move, r reads again from GitHub, q closes; NO_COLOR turns the colour off. Off a terminal it prints one frame sized
// by COLUMNS and LINES, with <n> selected (else the first PR), and no colour. Read-only: actions come with US-11.

/** `factory prs --json`, or null when it printed no JSON. */
function readPrs(fresh: boolean): Obj | null {
  const hook = join(import.meta.dir, "factory_prs.ts");
  const p = run([process.execPath, "--no-env-file", "--config=/dev/null", hook, "--json", ...(fresh ? ["--fresh"] : [])],
    { timeoutMs: 120_000 });
  try {
    const data: unknown = JSON.parse(p.stdout);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Obj) : null;
  } catch {
    return null;
  }
}

const PAINT: Record<string, string> = { green: "32", red: "31", amber: "33", dim: "90" };

function paint(text: string, colour: string, color: boolean): string {
  return color && text ? `\x1b[${PAINT[colour]}m${text}\x1b[0m` : text;
}

function ciColour(state: string): string {
  return state === "green" ? "green" : state === "red" ? "red" : "amber";
}

function isProtected(p: Obj): boolean {
  return p.protected === true || obj(p.next).reason === "protected";
}

/** The dev manager's word on the head, short: ✓ approved, ✕ must-fix, or what else the gate reads. */
function reviews(p: Obj): string {
  const gate = plain(p.gate);
  if (gate === "approved") return "✓ approved";
  if (gate.startsWith("must-fix")) return `✕ ${gate}`;
  if (gate) return gate;
  return p.headMarker === "pr-watch" ? "watching" : "—";
}

/** Who acts next, from the next action. */
function whoActs(p: Obj): string {
  const next = obj(p.next);
  const action = plain(next.action);
  if (["merge", "review", "rerun-flake"].includes(action)) return "manager";
  if (action === "held") return plain(next.by) || "manager";
  if (action === "waiting-for-agent") return plain(p.agent) || "author";
  if (action === "wait-ci") return "CI";
  if (action === "owner-merges") return "you";
  return "—";
}

function nextText(p: Obj): string {
  const next = obj(p.next);
  const text = plain(next.text) || plain(next.action) || "—";
  return next.error !== undefined ? `${text} (${plain(next.error)})` : text;
}

function width(s: string): number {
  return [...s.replace(ANSI, "")].length;
}

/** Cuts `s` to `n` visible characters (an ellipsis when cut), dropping colour when it has to cut. */
function cut(s: string, n: number): string {
  if (width(s) <= n) return s;
  const chars = [...s.replace(ANSI, "")];
  return n <= 0 ? "" : `${chars.slice(0, n - 1).join("")}…`;
}

function pad(s: string, n: number): string {
  const c = cut(s, n);
  return c + " ".repeat(Math.max(n - width(c), 0));
}

/** `left` and `right` on one line of `cols`, the right one dropped when both don't fit. */
function spread(left: string, right: string, cols: number): string {
  const gap = cols - width(left) - width(right);
  return gap >= 2 ? left + " ".repeat(gap) + right : cut(left, cols);
}

interface Column {
  head: string;
  size: number;
  cell: (p: Obj, color: boolean) => string;
}

const BY: Column = { head: "by", size: 10, cell: (p) => plain(p.agent) || "—" };
const CI: Column = { head: "CI", size: 8, cell: (p, color) => {
  const state = plain(obj(p.ci).state) || "—";
  return paint(state, ciColour(state), color);
} };
const REVIEWS: Column = { head: "reviews", size: 12, cell: (p) => reviews(p) };
const WHO: Column = { head: "who acts", size: 10, cell: (p) => whoActs(p) };
const NEXT: Column = { head: "next", size: 26, cell: (p) => nextText(p) };

/** The columns after the title that fit in `cols`: the board's, dropping reviews, by, next and who acts in turn. */
function columns(cols: number): Column[] {
  const all = [BY, CI, REVIEWS, WHO, NEXT];
  for (const drop of [REVIEWS, BY, NEXT, WHO]) {
    if (2 + 6 + 16 + all.reduce((n, c) => n + c.size, 0) <= cols) break;
    all.splice(all.indexOf(drop), 1);
  }
  return all;
}

function tableRow(cells: string[], sizes: number[]): string {
  return cells.map((c, i) => pad(c, sizes[i] as number)).join("");
}

function prTable(pulls: Obj[], selected: number, cols: number, color: boolean): string[] {
  const rest = columns(cols);
  const titleSize = Math.max(cols - 2 - 6 - rest.reduce((n, c) => n + c.size, 0), 8);
  const sizes = [6, titleSize, ...rest.map((c) => c.size)];
  const head = "  " + tableRow(["PR", "title", ...rest.map((c) => c.head)], sizes);
  const rows = pulls.map((p, i) => {
    const prot = isProtected(p) ? " · protected" : "";
    const room = titleSize - 1; // a space before the next column
    const title = cut(plain(p.title), Math.max(room - prot.length, 1)) + paint(prot, "amber", color);
    const line = (i === selected ? "› " : "  ") + tableRow([`#${plain(p.number)}`, title, ...rest.map((c) => c.cell(p, color))], sizes);
    return color && i === selected ? `\x1b[1m${line}\x1b[0m` : line;
  });
  return [paint(head, "dim", color), ...rows];
}

function short(sha: unknown): string {
  return plain(sha).slice(0, 7);
}

function age(minutes: unknown): string {
  const m = typeof minutes === "number" ? minutes : null;
  if (m === null) return "age unknown";
  return m < 120 ? `${Math.round(m)} min old` : m < 2880 ? `${Math.round(m / 60)} h old` : `${Math.round(m / 1440)} days old`;
}

/** The selected PR's detail, as on the board's card. */
export function prDetail(p: Obj, questions: Obj[], cols: number, color: boolean): string[] {
  const head = obj(p.head);
  const ci = obj(p.ci);
  const ok = (s: string) => paint(s, "green", color);
  const bad = (s: string) => paint(s, "red", color);
  const n = plain(p.number);
  const who = [plain(p.branch), plain(p.agent)].filter(Boolean).join(" · ");
  const labels = Array.isArray(p.labels) ? p.labels.map(plain).filter(Boolean) : [];
  const facts = [`head ${short(head.sha) || "unknown"}`, age(head.ageMinutes), ...(p.draft ? ["draft"] : []),
    ...(labels.length ? [`labels ${labels.join(", ")}`] : [])];

  const word = reviews(p);
  const marked = word.startsWith("✓") ? ok(word) : word.startsWith("✕") ? bad(word) : word;
  let manager = `dev manager ${word === "—" ? "no marker for the head" : marked}`;
  const marks = list(p.markers);
  const last = marks[marks.length - 1];
  if (!p.headMarker && last) manager += ` (older: ${plain(last.kind).replace(/^factory-/, "")} ${short(last.sha) || "no commit"})`;
  const claim = obj(p.claim);
  if (plain(claim.manager)) manager += `   ${plain(claim.manager)} holds the review until ${plain(claim.until)}`;

  const state = plain(ci.state) || "unknown";
  const notGreen = list(ci.notGreen);
  const jobs = notGreen.map((j) => `${plain(j.name)} ${plain(j.state) === "red" ? bad("✕") : paint(plain(j.state), "amber", color)}`);
  const others = Math.max(Number(ci.jobs ?? 0) - notGreen.length, 0); // jobs, not runs: re-runs and skipped don't count
  if (others) jobs.push(`${others} other check${others === 1 ? "" : "s"} ${ok("✓")}`);
  const ciLine = `CI ${paint(state, ciColour(state), color)}${jobs.length ? `   ${jobs.join("   ")}` : ""}`;

  const open = questions.filter((q) => q.kind === "pr" && plain(q.number) === n).length;
  const prot = isProtected(p) ? paint("yes, a person merges it", "amber", color)
    : p.protected === false ? "none" : "checked once it could merge";
  const lines = [
    spread(`#${n} · ${plain(p.title)}`, who, cols),
    facts.join(" · "),
    manager,
    ciLine,
    `questions ${open ? paint(`${open} open`, "amber", color) : "none open"}   protected paths ${prot}`,
    `next ${nextText(p)}   who acts ${whoActs(p)}`,
  ];
  if (plain(p.url)) lines.push(paint(plain(p.url), "dim", color));
  return lines.map((l) => cut(l, cols));
}

const PR_KEYS = "j k move · r read again · q close";

/** One screen of the Pull requests view, `rows` lines at most, each at most `cols` wide. */
export function prsFrame(data: Obj | null, selected: number, cols: number, rows: number, color: boolean, repo: string): string[] {
  const at0 = data?.generatedAt;
  const when = typeof at0 === "string" ? Math.max(Date.now() - Date.parse(at0), 0) / 1000 : null;
  const ago = when === null || Number.isNaN(when) ? "" : when < 120 ? ` · ${Math.floor(when)} s ago` : ` · ${Math.floor(when / 60)} min ago`;
  const heading = spread(`factory  ${repo} · Pull requests`, `factory prs · CI judged by the manager's rule${ago}`, cols);
  const pulls = data?.pulls;
  let body: string[];
  if (data === null) {
    body = ["Can't read the pull requests: `factory prs --json` printed no data.",
      "Run `factory prs` to see the whole error; if it is about GitHub, `gh auth status`."];
  } else if (!Array.isArray(pulls)) {
    body = [`Can't read the pull requests from GitHub (${plain(obj(pulls).error).slice(0, 200)}).`,
      "Run `gh auth status` (and `gh auth login` if it says so), then press r."];
  } else if (!pulls.length) {
    body = ["No open pull requests."];
  } else {
    const all = pulls.map(obj);
    const at = Math.min(Math.max(selected, 0), all.length - 1);
    const card = prDetail(all[at] as Obj, list(data.questions), cols, color);
    const fixed = 3; // the top line, a blank line before the card, the keys
    const want = Math.min(all.length, 3) + 1; // at least a few rows and their heads
    const cardRoom = Math.max(Math.min(card.length, rows - fixed - want), 0);
    const [head, ...rowLines] = prTable(all, at, cols, color);
    const room = Math.max(rows - fixed - cardRoom - 1, 1);
    const start = Math.min(Math.max(at - room + 1, 0), Math.max(rowLines.length - room, 0));
    body = [head as string, ...rowLines.slice(start, start + room)];
    const fill = Math.max(rows - fixed - cardRoom - body.length, 0);
    body.push(...Array<string>(fill).fill(""), "", ...card.slice(0, cardRoom));
  }
  const out = [heading, ...body.map((l) => cut(l, cols))];
  const keys = paint(cut(PR_KEYS, cols), "dim", color);
  return [...out.slice(0, Math.max(rows - 1, 0)), keys].slice(-Math.max(rows, 1));
}

function openPulls(data: Obj | null): Obj[] {
  return list(data?.pulls);
}

/** The index of PR `n`, refused when it is not open; 0 when no number is given. */
function selectedOf(data: Obj | null, n: number | null): number {
  if (n === null) return 0;
  const at = openPulls(data).findIndex((p) => Number(p.number) === n);
  if (at < 0 && Array.isArray(data?.pulls)) {
    refuse("cockpit_no_pr", `#${n} is not an open pull request.`,
      "Run `factory cockpit --prs` to see the open ones, or `factory prs` for the list.", 2);
  }
  return Math.max(at, 0);
}

async function prsLoop(n: number | null): Promise<number> {
  const color = !process.env.NO_COLOR;
  const repo = basename(top());
  let data: Obj | null = null;
  let selected = 0;
  const draw = (note = "") => {
    const lines = note ? [note] : prsFrame(data, selected, process.stdout.columns || 100, process.stdout.rows || 30, color, repo);
    process.stdout.write("\x1b[H\x1b[2J" + lines.join("\r\n"));
  };
  process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?25l");
  draw("Reading the pull requests…");
  data = readPrs(false);
  try {
    selected = selectedOf(data, n);
  } catch (e) {
    process.stdin.setRawMode(false); // the refusal prints on a normal terminal
    process.stdout.write("\x1b[?25h\r\n");
    throw e;
  }
  process.stdout.on("resize", () => draw());
  try {
    draw();
    // No Esc to close: over a slow ssh link an arrow key can come in two pieces, and its first is a lone Esc.
    for await (const chunk of process.stdin) {
      const key = String(chunk);
      const count = openPulls(data).length;
      if (key === "q" || key === "\x03") break;
      if (key === "j" || key === "\x1b[B") selected = Math.min(selected + 1, Math.max(count - 1, 0));
      else if (key === "k" || key === "\x1b[A") selected = Math.max(selected - 1, 0);
      else if (key === "r") {
        draw("Reading the pull requests from GitHub…");
        data = readPrs(true);
        selected = Math.min(selected, Math.max(openPulls(data).length - 1, 0));
      }
      draw();
    }
  } finally {
    process.stdin.setRawMode(false); // the terminal is given back however the view ends
    process.stdout.write("\x1b[?25h\x1b[H\x1b[2J");
  }
  return 0;
}

/** `factory cockpit --prs [<n>]`. */
export function prsView(args: string[]): Promise<number> | number {
  const word = args[0];
  if (args.length > 1 || (word !== undefined && !/^#?\d+$/.test(word))) {
    refuse("cockpit_usage", "factory cockpit --prs takes no argument, or the number of an open pull request.",
      "Run `factory cockpit --prs` for every open PR, or `factory cockpit --prs 12` to open #12's detail.", 2);
  }
  const n = word === undefined ? null : Number(word.replace("#", ""));
  if (process.stdin.isTTY && process.stdout.isTTY) return prsLoop(n);
  const data = readPrs(false);
  const selected = selectedOf(data, n);
  const cols = Number(process.env.COLUMNS) || 100;
  const rows = Number(process.env.LINES) || 30;
  console.log(prsFrame(data, selected, cols, rows, false, basename(top())).join("\n"));
  return 0;
}
