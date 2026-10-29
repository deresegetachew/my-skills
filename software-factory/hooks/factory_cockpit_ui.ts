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
//   factory cockpit --settings   the Settings view (#340), at the end of this file
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { load } from "./factory_config.ts";
import { readCache, refreshIfOld } from "./factory_cockpit.ts";
import { run, which } from "./factory_lib.ts";
import { refuse, repoKey, stateDir } from "./factory_machine.ts";
import { asText, lookup, MACHINE, MISSING, SECTIONS, SETTINGS, type Setting } from "./factory_settings_schema.ts";
import { loadStaged, type Staged } from "./factory_settings_staged.ts";
import * as store from "./factory_settings_store.ts";
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
}

/** The views of US-10, each the existing commands it runs. */
export function views(): View[] {
  const issues = str(obj(obj(load()).tasks).source) === "issues";
  return [
    { key: "1", title: "Needs you", commands: [["cockpit", "--needs"]] },
    { key: "2", title: "Pull requests", commands: [["prs"]] },
    { key: "3", title: "Tasks & PRD", commands: [issues ? ["issues", "list"] : ["next"]] },
    { key: "4", title: "CI", commands: [["ci", "status"]] },
    { key: "5", title: "Agents & machines", commands: [["agents", "ls"], ["machine", "show"]] },
    { key: "6", title: "Settings", commands: [["cockpit", "--settings", "--color"]] },
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

/** A view as one sh command: a heading, each command's output, through `less -R`. */
export function viewCommand(script: string, v: View): string {
  const parts = v.commands.map((c) => factoryCall(script, c));
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

// --- the Settings view (#340, PRD US-13) -----------------------------------------------------------------------------
//
// `factory cockpit --settings [--color]`, towards its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VSettings.dc.html).
// The settings as a table: setting, value, from (main, your change, this machine, default), what it does. Project
// settings by section under PROJECT (via PR), this machine's own under THIS MACHINE (direct). A ◆ marks a setting whose
// change needs a sign-off (the owner's, or a dev manager's label: the schema's `needs`). Staged project changes (#306) show as "(pending)" in the table and together in a box,
// as the one pull request `factory settings pr` opens. The keys line names the commands that edit: the view itself only
// reads. Plain text unless `--color` (and no NO_COLOR); a terminal narrower than the table gets two lines per setting.
// Agents can't open it: it refuses in an agent session, as `factory settings` refuses their changes.

interface Paint {
  amber: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  grey: (s: string) => string;
  bold: (s: string) => string;
}

function paint(on: boolean): Paint {
  const c = (code: string) => (s: string) => (on && s ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { amber: c("33"), red: c("31"), green: c("32"), grey: c("90"), bold: c("1") };
}

function width(s: string): number {
  return [...s.replace(ANSI, "")].length;
}

/** Plain text cut to `n` characters, with … when cut. */
function cut(s: string, n: number): string {
  const chars = [...s];
  if (n <= 0) return "";
  return chars.length <= n ? s : `${chars.slice(0, n - 1).join("")}…`;
}

function pad(s: string, n: number): string {
  const shown = cut(s, n);
  return shown + " ".repeat(Math.max(n - [...shown].length, 0));
}

/** Words wrapped to `n` columns, each line starting with `lead`. */
function wrap(text: string, n: number, lead = ""): string[] {
  const out: string[] = [];
  let line = lead;
  for (const w of text.split(" ")) {
    const next = line === lead ? lead + w : `${line} ${w}`;
    if ([...next].length <= n || line === lead) line = next;
    else {
      out.push(line);
      line = lead + w;
    }
  }
  out.push(line);
  return out.map((l) => cut(l, n));
}

/** The terminal's width: COLUMNS, the terminal on stdout, the one on stdin (a popup pipes stdout to less), else 100. */
function columns(): number {
  const given = Number(process.env.COLUMNS);
  if (given > 0) return given;
  if (process.stdout.columns) return process.stdout.columns;
  if (process.stdin.isTTY) {
    const p = Bun.spawnSync(["stty", "size"], { stdin: "inherit", stdout: "pipe", stderr: "ignore" });
    const n = Number(p.stdout.toString().trim().split(/\s+/)[1]);
    if (n > 0) return n;
  }
  return 100;
}

interface SettingRow {
  key: string;
  owner: boolean;
  value: string;
  from: string;
  pending: boolean;
  help: string;
}

function projectRow(data: store.Data, staged: Staged, s: Setting): SettingRow {
  const here = lookup(data, s.key);
  const change = Object.hasOwn(staged, s.key) ? staged[s.key] : undefined;
  const base = { key: s.key, owner: Boolean(s.needs), help: plain(s.short) };
  if (change) {
    const v = "value" in change ? change.value : s.default;
    return { ...base, value: plain(asText(v)), from: "your change", pending: true };
  }
  return { ...base, value: plain(asText(here === MISSING ? s.default : here)), from: here === MISSING ? "default" : "main",
    pending: false };
}

function machineRow(data: store.Data, s: Setting): SettingRow {
  const set = Object.hasOwn(data, s.key);
  // No ◆ here: a machine setting is saved at once, with no pull request to sign off (its `needs` says so).
  return { key: s.key, owner: false, help: plain(s.short), value: plain(asText(set ? data[s.key] : s.default)),
    from: set ? "this machine" : "default", pending: false };
}

const KEY_W = 34;
const VALUE_W = 20;
const FROM_W = 13;
const WIDE = KEY_W + VALUE_W + FROM_W + 23; // the table needs this much to keep a useful "what it does"

/** The value in `n` columns; a pending one keeps its "(pending)" however much of the value is cut. */
function valueText(r: SettingRow, n: number): string {
  return r.pending ? `${cut(r.value, Math.max(n - 10, 1))} (pending)` : cut(r.value, n);
}

function tableLines(rows: SettingRow[], cols: number, c: Paint): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const mark = r.owner ? " ◆" : "";
    const value = r.pending ? c.amber : (s: string) => s;
    if (cols >= WIDE) {
      const key = pad(cut(r.key, KEY_W - 2 - mark.length) + mark, KEY_W - 2);
      const keyShown = r.owner ? key.replace(" ◆", c.amber(" ◆")) : key;
      const help = cut(r.help, cols - KEY_W - VALUE_W - FROM_W - 2);
      out.push(`  ${keyShown}${value(pad(valueText(r, VALUE_W - 2), VALUE_W - 1))} ${pad(r.from, FROM_W - 1)} ${c.grey(help)}`);
    } else {
      out.push(cut(`  ${r.key}${mark}`, cols).replace(" ◆", c.amber(" ◆")));
      out.push(`    ${value(valueText(r, Math.max(cols - 4 - [...r.from].length - 3, 12)))} · ${c.grey(cut(r.from, cols - 4))}`);
      for (const l of wrap(r.help, cols, "    ").slice(0, 2)) out.push(c.grey(l));
    }
  }
  return out.map((l) => (width(l) > cols ? cut(l.replace(ANSI, ""), cols) : l));
}

/** The box of staged changes: what `factory settings pr` would open. */
function stagedBox(staged: Staged | null, problem: string, data: store.Data, cols: number, c: Paint): string[] {
  const inner = Math.max(cols - 4, 10);
  const body: string[] = [];
  if (problem) {
    body.push(...wrap(`The staged changes can't be read (${plain(problem)}).`, inner));
    body.push(...wrap("Run `factory settings unstage` to drop them, then stage again with `factory settings set --stage <key> <value>`.", inner).map(c.grey));
  } else if (!staged || !Object.keys(staged).length) {
    body.push(...wrap("No project changes waiting.", inner));
    body.push(...wrap("`factory settings set --stage <key> <value>` stages one; they go to main together as one pull request.", inner).map(c.grey));
  } else {
    const keys = Object.keys(staged);
    body.push(...wrap(`${keys.length} project change${keys.length === 1 ? "" : "s"} waiting · they go to main as one pull request`, inner).map(c.bold));
    for (const key of keys) {
      const change = staged[key] as Staged[string];
      const was = lookup(data, key);
      if (was !== MISSING) body.push(...wrap(`- ${plain(JSON.stringify(key))}: ${plain(JSON.stringify(was))}`, inner).map(c.red));
      if ("value" in change) body.push(...wrap(`+ ${plain(JSON.stringify(key))}: ${plain(JSON.stringify(change.value))}`, inner).map(c.green));
      else if (was === MISSING) body.push(...wrap(`  ${plain(JSON.stringify(key))}: back to its default`, inner).map(c.grey));
    }
    body.push(...wrap("`factory settings pr` opens the PR · `factory settings unstage [<key>]` discards · " +
      "`factory settings validate` checks · .claude/factory.json is protected: you merge it", inner).map(c.grey));
  }
  const edge = c.amber;
  const line = "─".repeat(Math.max(cols - 2, 0));
  return [edge(`┌${line}┐`), ...body.map((b) => `${edge("│")} ${b}${" ".repeat(Math.max(inner - width(b), 0))} ${edge("│")}`),
    edge(`└${line}┘`)];
}

const SETTINGS_KEYS = "edit: `factory settings set --stage <key> <value>` · full help: `factory settings help <key>` · " +
  "back to default: `factory settings unset --stage <key>` · search: / here · open the PR: `factory settings pr` · " +
  "this machine: `factory settings --local set <key> <value>`, saved at once · agents can't open this view";

/** The Settings view as lines, each at most `cols` wide. */
export function settingsLines(cols: number, color: boolean): string[] {
  const c = paint(color);
  const [data] = store.readProject();
  const machine = store.readMachine();
  const found = loadStaged();
  const staged = "changes" in found ? found.changes : {};
  const problem = "problem" in found ? found.problem : "";
  const repo = plain(repoKey());
  const title = `${c.amber(c.bold("factory"))} ${c.grey(`${repo} · Settings`)}`;
  const source = "factory settings · values from main, this machine's file, defaults";
  const out: string[] = [];
  if (cols >= width(title) + source.length + 4) out.push(title + " ".repeat(cols - width(title) - source.length) + c.grey(source));
  else out.push(cut(title, cols), ...wrap(source, cols).map(c.grey));
  out.push(...wrap("◆ a change to it needs a sign-off: the owner's, or a dev manager's label (`factory settings help <key>`) · " +
    "(pending) staged, not on main yet", cols).map(c.grey), "");
  if (cols >= WIDE) {
    out.push(c.grey(`  ${pad("setting", KEY_W - 2)}${pad("value", VALUE_W - 1)} ${pad("from", FROM_W - 1)} what it does`));
  }
  out.push(c.bold("PROJECT (via PR)"));
  for (const [slug, name] of SECTIONS) {
    const rows = Object.values(SETTINGS).filter((s) => s.section === slug).map((s) => projectRow(data, staged, s));
    if (!rows.length) continue;
    out.push(c.amber(cut(`── ${name} `.padEnd(Math.min(cols, 60), "─"), cols)), ...tableLines(rows, cols, c));
  }
  out.push("", c.bold(cut(`THIS MACHINE (direct) · ${plain(hostname())} · ${repo}`, cols)));
  out.push(...tableLines(Object.values(MACHINE).map((s) => machineRow(machine, s)), cols, c), "");
  out.push(...stagedBox(problem ? null : staged, problem, data, cols, c), "");
  out.push(...wrap(SETTINGS_KEYS, cols).map(c.grey));
  return out;
}

export function settingsView(args: string[]): number {
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    if (name in process.env) {
      refuse("cockpit_agent_session", `The Settings view is the owner's, and ${name} is set, so this looks like an agent session.`,
        "Open it from the cockpit in your own terminal (`factory cockpit`, then 6), or run `factory cockpit --settings` there.");
    }
  }
  const color = args.includes("--color") && !("NO_COLOR" in process.env);
  console.log(settingsLines(columns(), color).join("\n"));
  return 0;
}
