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
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { config as ciConfig, runnerSetting, sourceText } from "../ci/ci_names.ts";
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
export function plain(v: unknown): string {
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
    { key: "4", title: "CI", commands: [["cockpit", "--ci"]] }, // drawn after its board (#339)
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

// --- the CI view (#339, PRD US-13) -----------------------------------------------------------------------------------
//
// `factory cockpit --ci`, drawn after its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VCi.dc.html). Three cards (where
// jobs run, the heavy runners on this machine, the leftovers), the runners, the queue and recent runs, and the commands
// that act on them. Its data is the `ci` part of the cockpit's cache (`factory ci status --json`, #304), so it makes no
// GitHub call; the heavy runner count is this machine's setting (ci_names.ts). Read-only: it names the commands, the
// owner runs them. A plain terminal: it fits COLUMNS (else the terminal's width, else 80), stacks the cards under 96
// columns, and the glyphs and words carry every state, so NO_COLOR (or TERM=dumb) only drops the colours.

function listOrNull(v: unknown): Obj[] | null {
  return Array.isArray(v) ? v.map(obj) : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The board's colours, as 256-colour codes. */
const STYLE = { bold: "1", dim: "38;5;247", amber: "38;5;215", blue: "38;5;75", green: "38;5;71", red: "38;5;210" } as const;
type Style = keyof typeof STYLE | "";
type Seg = [string, Style];

let COLOR = false;

function paint(text: string, style: Style): string {
  return COLOR && style && text ? `\x1b[${STYLE[style]}m${text}\x1b[0m` : text;
}

function len(s: string): number {
  return [...s].length;
}

function cut(s: string, w: number): string {
  const cs = [...s];
  return cs.length <= w ? s : `${cs.slice(0, Math.max(w - 1, 0)).join("")}…`;
}

function pad(s: string, w: number): string {
  const t = cut(s, w);
  return t + " ".repeat(Math.max(w - len(t), 0));
}

/** One line of segments, cut to `w` visible characters, coloured after cutting. */
function line(segs: Seg[], w: number): string {
  let left = w;
  let out = "";
  for (const [text, style] of segs) {
    if (left <= 0) break;
    const t = len(text) > left ? cut(text, left) : text;
    out += paint(t, style);
    left -= len(t);
  }
  return out;
}

/** Words (or the parts between `sep`) wrapped to `w` columns; one longer than that is cut. */
function wrap(text: string, w: number, sep = " "): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(sep).filter(Boolean)) {
    if (cur && len(cur) + len(sep) + len(word) > w) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}${sep}${word}` : cut(word, w);
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

function width(): number {
  const given = Number(process.env.COLUMNS) || process.stdout.columns;
  if (given) return Math.max(given, 20);
  if (process.stdin.isTTY) {
    // In the cockpit's popup stdout is less's pipe, but stdin is the popup's terminal.
    const p = Bun.spawnSync(["stty", "size"], { stdin: "inherit", stdout: "pipe", stderr: "ignore" });
    const cols = Number(p.stdout.toString().trim().split(/\s+/)[1]);
    if (cols) return Math.max(cols, 20);
  }
  return 80;
}

function ago(minutes: number): string {
  const m = Math.max(Math.floor(minutes), 0);
  return m < 120 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

interface Card { title: string; lines: Array<[string, Style]>; warn: boolean }

function host(): string {
  return plain(hostname().split(".")[0]) || "this machine";
}

function whereJobsRun(ci: Obj): Card {
  const mode = plain(ci.mode);
  const light = obj(ci.light);
  const lane = plain(light.label) ? ` · light lane ${plain(light.label)}` : "";
  if (mode === "local") {
    return { title: "WHERE JOBS RUN", warn: false, lines: [["local · self-hosted", "bold"],
      [`CI_RUNS_ON ${plain(ci.label)}${lane}`, "dim"], ["switch to GitHub's runners:", "dim"], ["factory ci use github", "dim"]] };
  }
  if (mode === "github") {
    return { title: "WHERE JOBS RUN", warn: false, lines: [["GitHub's runners", "bold"], ["CI_RUNS_ON is not set", "dim"],
      ["switch to this machine's runners:", "dim"], ["factory ci use local", "dim"]] };
  }
  return { title: "WHERE JOBS RUN", warn: true, lines: [["unknown", "bold"],
    ["gh can't read CI_RUNS_ON; it needs admin on the repository", "dim"]] };
}

function heavyRunners(ci: Obj): Card {
  const lines: Array<[string, Style]> = [];
  try {
    const { raw, source } = runnerSetting(ciConfig());
    lines.push([`${plain(raw)} wanted · from ${sourceText(source)}`, "bold"]);
  } catch {
    lines.push([".claude/factory.json can't be read", "red"]);
  }
  const here = (listOrNull(ci.instances) ?? []).filter((i) => plain(i.id) !== "light");
  const installed = here.filter((i) => plain(i.state) !== "not_running");
  const down = here.filter((i) => ["loop_down", "not_loaded"].includes(plain(i.state))).length;
  lines.push([installed.length ? `${installed.length} installed here${down ? `, ${down} loop down` : ""}` : "none installed here",
    down ? "amber" : "dim"]);
  lines.push(["change, then reinstall:", "dim"], ["factory ci runners N", "dim"], ["factory ci install", "dim"]);
  return { title: `HEAVY RUNNERS ON ${host().toUpperCase()}`, warn: down > 0, lines };
}

function leftovers(ci: Obj): Card {
  const all = listOrNull(ci.runners);
  if (all === null) {
    return { title: "LEFTOVERS", warn: false, lines: [["the runners can't be read", "dim"], ["factory ci clean lists them", "dim"]] };
  }
  const offline = [...all, ...(listOrNull(obj(ci.light).runners) ?? [])].filter((r) => plain(r.status) === "offline").length;
  return { title: "LEFTOVERS", warn: offline > 0, lines: [[offline ? plural(offline, "offline runner") : "no offline runner", "bold"],
    ["list, then clean on yes:", "dim"], ["factory ci clean", "dim"], ["runner files up to date?", "dim"], ["factory ci stale", "dim"]] };
}

/** The cards side by side (one row of boxes), or stacked when the terminal is narrow. */
function drawCards(cards: Card[], w: number): string[] {
  const side = w >= 96;
  const gap = 2;
  const cw = side ? Math.floor((w - gap * (cards.length - 1)) / cards.length) : w;
  const inner = cw - 4;
  const boxes = cards.map((c) => {
    const body: Array<[string, Style]> = [[c.title, "dim"]];
    for (const [text, style] of c.lines) for (const l of wrap(text, inner)) body.push([l, style]);
    return { c, body };
  });
  const tall = Math.max(...boxes.map((b) => b.body.length));
  const drawn = boxes.map(({ c, body }) => {
    const edge: Style = c.warn ? "amber" : "dim";
    const rows = [paint(`┌${"─".repeat(cw - 2)}┐`, edge)];
    for (let i = 0; i < (side ? tall : body.length); i++) {
      const [text, style] = body[i] ?? ["", ""];
      rows.push(paint("│", edge) + " " + paint(pad(text, inner), style) + " " + paint("│", edge));
    }
    rows.push(paint(`└${"─".repeat(cw - 2)}┘`, edge));
    return rows;
  });
  if (!side) return drawn.flat();
  return (drawn[0] ?? []).map((_, i) => drawn.map((d) => d[i] ?? "").join(" ".repeat(gap)));
}

const GLYPH: Record<string, [string, Style]> = { working: ["●", "blue"], idle: ["○", "dim"], down: ["✕", "red"] };

function drawRunners(ci: Obj, w: number): string[] {
  const heavy = listOrNull(ci.runners);
  if (heavy === null) return [line([["The runners can't be read: see below.", "dim"]], w)];
  const rows = [...heavy.map((r) => ({ r, lane: "heavy" })), ...(listOrNull(obj(ci.light).runners) ?? []).map((r) => ({ r, lane: "light" }))];
  if (!rows.length) {
    const text = plain(ci.mode) === "local"
      ? `No runner has the label ${plain(ci.label)}: factory ci install registers this machine's.`
      : "No self-hosted runner: CI runs on GitHub's runners.";
    return wrap(text, w).map((l) => line([[l, "dim"]], w));
  }
  const nameW = Math.min(Math.max(...rows.map(({ r }) => len(plain(r.name)))), 32);
  const out: string[] = [];
  for (const { r, lane } of rows) {
    const st = plain(r.status) !== "online" ? "down" : r.busy ? "working" : "idle";
    const [g, gs] = GLYPH[st] as [string, Style];
    const job = st === "down" ? "offline" : st === "working" ? "running a job" : "waiting for a job";
    if (w >= 60) {
      out.push(line([[`${g} `, gs], [`${pad(plain(r.name), nameW)}  `, ""], [`${pad(lane, 6)}  `, "dim"], [job, "dim"]], w));
    } else {
      out.push(line([[`${g} `, gs], [plain(r.name), ""]], w), line([[`  ${lane} · ${job}`, "dim"]], w));
    }
  }
  return out;
}

const ACTIVE = ["queued", "in_progress", "waiting", "pending", "requested"];
const RUN_STYLE: Record<string, Style> = { queued: "amber", waiting: "amber", pending: "amber", requested: "amber",
  running: "blue", success: "green", skipped: "dim", neutral: "dim" };

function drawRuns(ci: Obj, w: number): string[] {
  const runs = listOrNull(ci.runs);
  if (runs === null) return [line([["The runs can't be read: see below.", "dim"]], w)];
  if (!runs.length) return [line([["No runs on main or an open pull request.", "dim"]], w)];
  const active = runs.filter((r) => ACTIVE.includes(plain(r.state))).sort((a, b) => num(b.minutesAgo) - num(a.minutesAgo));
  const done = runs.filter((r) => !ACTIVE.includes(plain(r.state))).sort((a, b) => num(a.minutesAgo) - num(b.minutesAgo));
  const out: string[] = [];
  for (const r of [...active, ...done]) {
    const state = plain(r.state) === "in_progress" ? "running" : plain(r.state);
    const style = RUN_STYLE[state] ?? "red";
    const title = `${plain(r.name) || "CI"} on ${plain(r.branch)}`;
    const age = ago(num(r.minutesAgo));
    if (w >= 60) {
      const titleW = w - 10 - 10 - len(age) - 2;
      out.push(line([[pad(state, 10), style], [pad(plain(r.ref), 10), "dim"], [pad(title, titleW), ""], [`  ${age}`, "dim"]], w));
    } else {
      out.push(line([[pad(state, 10), style], [`${plain(r.ref)}  `, "dim"], [age, "dim"]], w), line([[`  ${title}`, ""]], w));
    }
  }
  const q = obj(ci.queuedLong);
  if (num(q.count)) {
    out.push(...wrap(`${plural(num(q.count), "run")} queued over ${num(q.thresholdMinutes)} min (the longest ${num(q.longestMinutes)} min)`, w)
      .map((l) => line([[l, "amber"]], w)));
  }
  if (q.noRunnerOnline === true) {
    out.push(...wrap(`No runner with the label ${plain(ci.label)} is online, so they wait: factory ci install`, w).map((l) => line([[l, "red"]], w)));
  }
  return out;
}

function drawProblems(problems: Obj[], w: number): string[] {
  const out: string[] = [];
  for (const p of problems) {
    out.push(...wrap(plain(p.message), w).map((l) => line([[l, "red"]], w)));
    if (plain(p.fix)) out.push(...wrap(`fix: ${plain(p.fix)}`, w).map((l) => line([[l, "dim"]], w)));
  }
  return out;
}

const KEYS = "job log: factory ci log <pr or run> · runner logs: factory ci logs · runners: factory ci runners N · " +
  "clean: factory ci clean · reinstall: factory ci install · local or GitHub: factory ci use local|github · " +
  "shared build cache: factory turbo status";

/** The CI view of a snapshot (the cockpit's cache), as lines at most `w` wide. */
export function renderCi(snap: Obj | null, w: number, nowMs: number): string[] {
  if (snap === null) return wrap("No snapshot yet: `factory cockpit --json` reads one now.", w);
  const ci = snap.ci === null || snap.ci === undefined ? null : obj(snap.ci);
  const repo = plain(ci?.repo);
  const right = `factory ci status · this machine: ${host()}`;
  const left: Seg[] = [["factory", "amber"], [`  ${repo ? `${repo} · ` : ""}CI`, "dim"]];
  const leftW = len("factory") + 2 + len(repo ? `${repo} · CI` : "CI");
  const out = [w - leftW >= len(right) + 2 ? line([...left, [" ".repeat(w - leftW - len(right)), ""], [right, "dim"]], w) : line(left, w), ""];
  if (ci === null) {
    const missing = (listOrNull(snap.missing) ?? []).filter((m) => plain(m.code) === "ci_unreadable");
    out.push(...drawProblems(missing.length ? missing : [{ message: "The snapshot has no CI part.", fix: "Run `factory ci status`." }], w));
  } else {
    out.push(...drawCards([whereJobsRun(ci), heavyRunners(ci), leftovers(ci)], w), "");
    out.push(line([["Runners", "bold"]], w), ...drawRunners(ci, w), "");
    out.push(line([["Queue and recent runs", "bold"]], w), ...drawRuns(ci, w));
    const errors = listOrNull(ci.errors) ?? [];
    if (errors.length) out.push("", ...drawProblems(errors, w));
  }
  const at = Date.parse(plain(snap.generatedAt));
  const mins = (nowMs - at) / 60_000;
  const age = Number.isNaN(at) ? "age unknown" : mins < 1 ? "as of now" : `as of ${ago(mins)} ago`;
  // Wrapped between the commands, so none is split over two lines.
  out.push("", ...wrap(`${KEYS} · ${age}`, w, " · ").map((l) => line([[l, "dim"]], w)));
  return out;
}

export function ciView(): number {
  COLOR = !process.env.NO_COLOR && !["", "dumb"].includes(process.env.TERM ?? "");
  console.log(renderCi(readCache(), width(), Date.now()).join("\n"));
  return 0;
}
