// `factory cockpit` (#308, PRD US-10, decision 0001): the read-only cockpit, one terminal window built on tmux.
//
//   factory cockpit              open it (or come back to it): sessions and views on the left, the selected session on
//                                the right, the counts on top (`factory cockpit --status`), the keys at the bottom
//
// It runs on its own tmux server (socket factory-cockpit-<repo>), so its prefix (C-a) and keys never change the owner's
// own tmux, and a tmux nested over ssh keeps C-b. The config is written to this machine's state folder each time it
// opens. The right pane runs `factory follow <name>`, which attaches to the agent's real Claude Code session (on this
// machine with its tmux, elsewhere over ssh). Views are popups, each drawn by the Ink UI (#367, cockpit/views/).
// The owner's actions (#309, US-11) run the factory commands the command line runs (`factory owner merge|label|answer|
// release|start|stop`, `factory say`), each after a y/N question; the commands that agents and the gate use are never
// offered. A new owner ask rings the bell from the list, once (#310, US-12). The panes and popups run these, which are
// not for typing:
//
//   factory cockpit --sidebar    the list on the left (off a terminal: one frame, sized by COLUMNS and LINES); on a
//                                session s says, x stops it, n starts one (the bar, with the action typed in). On Ink
//                                (#366, cockpit/sidebar.tsx) when its UI is installed, else drawn here
//   factory cockpit --sidebar-data
//                                what the Ink list draws: the cached snapshot, the views, the new asks to ring for
//   factory cockpit --sidebar-open session <name> | view <key> | bar [<words>] | leave
//                                a key of the Ink list, done in the cockpit's tmux
//   factory cockpit --bar [<words>]
//                                the `:` command bar: type to pick a factory command, the words typed in already (on
//                                Ink, cockpit/command-bar.tsx; off a terminal: the words, else one line on stdin, and the
//                                next line answers an action's question)
//   factory cockpit --bar-resolve <typed> [<picked>]
//                                what the Ink bar's line runs, as JSON, or the refusal
//   factory cockpit --needs      the "Needs you" view, from the cache
//   factory cockpit --prs [<n>]  the Pull requests view (#338), from `factory prs --json`
//   factory cockpit --prs-data [--fresh]
//                                what the Pull requests view reads: `factory prs --json`, and when GitHub's limit stopped
//                                it, when the limit is back (#383)
//   factory cockpit --tasks      the Tasks & PRD view, from the task tracker
//   factory cockpit --ci         the CI view (#339), from the cache
//   factory cockpit --agents     the Agents & machines view, from the cache
//   factory cockpit --settings   the Settings view (#340)
//   factory cockpit --health     the Health & releases view, from the cache
//   factory cockpit --usage      the Usage and lessons view (#341), from this machine's logs
//   factory cockpit --view-data <settings|usage|tasks>
//                                what that view reads, as JSON (r in the view runs it)
// Each view is drawn by the Ink UI (#367, decision 0002, cockpit/views/); this file says what it reads.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { config as ciConfig, runnerSetting, sourceText } from "../ci/ci_names.ts";
import { load, taskSource } from "./factory_config.ts";
import { ACTION_NAMES, ACTIONS_OFFERED, matches, OFFERED, rank } from "./factory_cockpit_match.ts";
import { inkUi, LIMITED, limitSentence, readCache, refreshIfOld, runUi, UI_MISSING, uiPackagesProblem } from "./factory_cockpit.ts";
import { run, which } from "./factory_lib.ts";
import { refuse, repoKey, stateDir } from "./factory_machine.ts";
import { asText, lookup, MACHINE, MISSING, SECTIONS, SETTINGS, type Setting } from "./factory_settings_schema.ts";
import { loadStaged, type Staged } from "./factory_settings_staged.ts";
import * as store from "./factory_settings_store.ts";
import { limitStatus } from "./factory_views_cache.ts";
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
  /** Draws its own screen and reads keys (#338): runs in the popup as it is, not through `less -R`. */
  live?: boolean;
}

/** The views of US-10, each drawn by the Ink UI after its board (#367). Settings is paged by `less -R`, whose `/`
 *  searches it; the others read their own keys. */
export function views(): View[] {
  return [
    { key: "1", title: "Needs you", commands: [["cockpit", "--needs"]], live: true },
    { key: "2", title: "Pull requests", commands: [["cockpit", "--prs"]], live: true },
    { key: "3", title: "Tasks & PRD", commands: [["cockpit", "--tasks"]], live: true },
    { key: "4", title: "CI", commands: [["cockpit", "--ci"]], live: true },
    { key: "5", title: "Agents & machines", commands: [["cockpit", "--agents"]], live: true },
    { key: "6", title: "Settings", commands: [["cockpit", "--settings", "--color"]] },
    { key: "7", title: "Health & releases", commands: [["cockpit", "--health"]], live: true },
    { key: "8", title: "Usage & lessons", commands: [["cockpit", "--usage"]], live: true },
  ];
}

export { ACTIONS_OFFERED, matches, OFFERED, rank };

/** The offered commands that take words after them (an issue, a run, a setting), never a flag: `factory <cmd>` passes
 *  the rest of the line on, and flags such as `next --claim` or `usage --record` change things. */
const TAKES_WORDS = ["issues show", "ci log", "settings show", "settings get", "settings help", "help"];

/** The offered command the words start with, when the rest is allowed after it; else undefined. */
function offeredLine(words: string[]): string | undefined {
  const text = words.join(" ");
  const n = [...OFFERED, ...ACTION_NAMES].filter((o) => text === o || text.startsWith(`${o} `)).sort((a, b) => b.length - a.length)[0];
  if (n === undefined) return undefined;
  if (ACTION_NAMES.includes(n)) return n;
  const rest = words.slice(n.split(" ").length);
  return !rest.length || (TAKES_WORDS.includes(n) && rest.every((w) => !w.startsWith("-"))) ? n : undefined;
}

/** The action the words run, or undefined for a read-only command. */
export function actionOf(words: string[]): string | undefined {
  const n = offeredLine(words);
  return n !== undefined && ACTION_NAMES.includes(n) ? n : undefined;
}

/** What agents and the gate use: never in the cockpit (US-10). */
const FOR_AGENTS = ["review-pass", "wait", "run-check", "guard", "rereview", "manager-claims"];

/** Commands that change GitHub or the machine and are not among the owner's actions: run in a shell, not here. */
const ACTIONS = ["loop", "coding-agent", "dev-manager", "product-owner", "init", "init-roles", "agent", "autostart",
  "resume", "heartbeat", "reset-run", "worktree", "verify", "fix", "check", "turbo", "bootstrap", "update",
  "release", "rollback", "migrate-to-release", "cockpit", "follow", "lessons", "settings", "remote", "issues", "ci",
  "machine", "agents", "messages", "alerts", "claims", "next", "usage"];

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
    refuse("cockpit_not_offered", `\`factory ${text}\` goes past what the cockpit offers.`,
      `Run \`factory ${text}\` in a shell. Here: the read-only commands, and ${ACTION_NAMES.join(", ")} (each asks first).`, 2);
  }
  const best = matches(text)[0];
  if (best === undefined) {
    refuse("cockpit_no_match", `No factory command the cockpit offers matches "${text}".`,
      `Type part of one of: ${[...OFFERED, ...ACTION_NAMES].join(", ")}.`, 2);
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

const LIST_FAILED = "The list stopped with the error above. Fix it, then leave with C-a d and run `factory cockpit` again " +
  "(`factory doctor` checks the cockpit's UI).";

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
    "# : the command bar over the factory's read-only commands and the owner's actions (each asks first).",
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
  const ui = inkUi();
  const bad = ui ? uiPackagesProblem(ui, root) : null; // without the UI the list is drawn here (#391)
  if (bad) refuse(bad.code, bad.message, bad.fix, 1);
  const script = factoryScript(root);
  const conf = writeConfig(config(root, script));
  const sock = socket();
  const session = sessionName("cockpit");
  if (tmux(sock, ["has-session", "-t", `=${session}`]).code === 0) {
    tmux(sock, ["source-file", conf]);
  } else {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    // A list that fails keeps its error on screen (#391), not an empty pane.
    const sidebar = `env FACTORY_COCKPIT=${dq(session)} ${factoryCall(script, ["cockpit", "--sidebar"])} || ` +
      `{ echo; echo ${dq(LIST_FAILED)}; exec tail -f /dev/null; }`;
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
  const onSession = all[selected]?.kind === "session";
  const keys = rows < 16 ? [onSession ? "↑↓ Enter · s say · x stop · q" : "↑↓ Enter · 1-8 · : · q"] :
    ["", onSession ? "Enter shows it · s say · x stop" : "Enter opens the view", "↑↓ move · 1-8 views · n start",
      ": commands · q leave"];
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

/** Where the list's actions go: the cockpit's tmux server and session (FACTORY_COCKPIT, set by `factory cockpit`). */
interface Pane {
  sock: string;
  session: string;
  root: string;
  script: string;
}

function pane(): Pane {
  const root = top();
  return { sock: socket(), session: process.env.FACTORY_COCKPIT ?? "", root, script: factoryScript(root) };
}

// display-popup waits until the popup closes, so it has no timeout: a view stays open as long as the owner reads it.
function popup(p: Pane, size: string[], cmd: string): void {
  Bun.spawnSync(["tmux", "-L", p.sock, "display-popup", "-E", ...size, "-d", p.root, cmd], { stdout: "ignore", stderr: "ignore" });
}

function openView(p: Pane, v: View): void {
  popup(p, ["-w", "90%", "-h", "90%"], viewCommand(p.script, v));
}

/** The bar, with `words` typed in already (an action such as `say taytu`, or nothing). */
function openBar(p: Pane, words: string[]): void {
  popup(p, ["-w", "80%", "-h", "60%"], factoryCall(p.script, ["cockpit", "--bar", ...words]));
}

/** The session `name` in the right pane, through `factory follow`, and the focus there. */
function showSession(p: Pane, name: string): void {
  const after = idleCommand(`The session ${plain(name)} closed here. C-a C-a comes back to the list.`);
  tmux(p.sock, ["respawn-pane", "-k", "-t", `=${p.session}:0.1`, `${factoryCall(p.script, ["follow", name])}; ${after}`]);
  tmux(p.sock, ["select-pane", "-t", `=${p.session}:0.1`]);
}

async function sidebarLoop(): Promise<number> {
  const p = pane();
  const vs = views();
  let snap = readCache();
  let selected = 0;
  const draw = () => {
    const lines = frame(snap, vs, selected, process.stdout.columns || 32, process.stdout.rows || 30, true);
    process.stdout.write(BEL.repeat(newAsks(snap)) + "\x1b[H\x1b[2J" + lines.join("\r\n"));
  };
  const act = () => {
    const e = entries(snap, vs)[selected];
    if (!e) return;
    if (e.kind === "view") {
      const v = vs.find((x) => x.key === e.name);
      if (v) openView(p, v);
      return;
    }
    showSession(p, e.name);
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
      if (v) openView(p, v);
    } else if (key === ":") openBar(p, []);
    else if (key === "s" || key === "x" || key === "n") {
      // The bar, with the action typed in already: the owner adds the message or the name, then answers its question.
      const e = entries(snap, vs)[selected];
      const name = e?.kind === "session" ? e.name : "";
      const words = key === "n" ? ["owner", "start"] : name ? (key === "s" ? ["say", name] : ["owner", "stop", name]) : [];
      if (words.length) openBar(p, words);
    } else if (key === "q") tmux(p.sock, ["detach-client"]);
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

/** `factory cockpit --sidebar`: the list on Ink (#366) when its UI is installed (the release's bundle, or the source in
 *  my-skills); else the list drawn here, for a release without the bundle. */
export function sidebar(): Promise<number> | number {
  const ui = inkUi();
  if (ui) {
    const bad = uiPackagesProblem(ui, top());
    if (bad) {
      process.stderr.write(JSON.stringify(bad) + "\n");
      return 1;
    }
    // --no-install: offline, as the rest of the factory; Bun never fetches a package the bundle doesn't hold
    const p = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", "--no-install", ui, "--sidebar",
      "--factory", factoryScript(top())], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return p.exitCode ?? 1;
  }
  return process.stdin.isTTY && process.stdout.isTTY ? sidebarLoop() : sidebarOnce();
}

/** `factory cockpit --sidebar-data`: what the Ink list draws, as JSON: the cached snapshot (a refresh starts when it is
 *  old), the views, and how many new owner asks ring the bell (each rings once, as in the list drawn here). */
export function sidebarData(): number {
  refreshIfOld();
  const snap = readCache();
  console.log(JSON.stringify({ snapshot: snap, views: views().map((v) => ({ key: v.key, title: v.title })), bell: newAsks(snap) }));
  return 0;
}

/** `factory cockpit --sidebar-open session <name> | view <key> | bar [<words>] | leave`: a key of the Ink list, done in
 *  the cockpit's tmux. */
export function sidebarOpen(args: string[]): number {
  const [what, ...rest] = args;
  const p = pane();
  const v = views().find((x) => x.key === rest[0]);
  if (what === "session" && rest.length === 1 && rest[0]) showSession(p, rest[0]);
  else if (what === "view" && rest.length === 1 && v) openView(p, v);
  else if (what === "bar") openBar(p, rest);
  else if (what === "leave" && !rest.length) tmux(p.sock, ["detach-client"]);
  else {
    refuse("cockpit_usage", `factory cockpit --sidebar-open takes session <name>, view <key>, bar [<words>] or leave, not "${plain(args.join(" "))}".`,
      "The cockpit's list runs it for its keys; to open the cockpit, run `factory cockpit`.", 2);
  }
  return 0;
}

// --- the command bar -------------------------------------------------------------------------------------------------

function runOffered(args: string[]): number {
  const p = Bun.spawnSync(["bash", factoryScript(top()), ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return p.exitCode ?? 1;
}

// --- the owner's actions (#309, PRD US-11) ---------------------------------------------------------------------------
//
// Each runs the factory command the command line runs (`factory owner ...`, `factory say`), and only after the owner
// answers y to a question that names the command and what it changes. Any other answer, an empty one or none at all
// runs nothing. They run on this machine's tmux, never the cockpit's own server, so TMUX is dropped.

export const NOT_RUN = "Not run: nothing changed.";

/** The question asked before an action runs. */
export function question(words: string[]): string {
  const what = ACTIONS_OFFERED[actionOf(words) ?? ""] ?? "things";
  return `Run \`factory ${words.join(" ")}\`? It changes ${what}. [y/N] `;
}

export function yes(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer);
}

/** The arguments an action's words become: `say [--on R] <name>` takes the rest of the line as one message. */
export function actionArgs(words: string[]): string[] {
  if (words[0] !== "say") return words;
  const at = words[1] === "--on" ? 3 : 1;
  const message = words.slice(at + 1).join(" ");
  return [...words.slice(0, at + 1), ...(message ? [message] : [])];
}

/** Runs the action's factory command here, its output on this terminal; returns its exit code. */
export function runAction(words: string[]): number {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TMUX;
  const p = Bun.spawnSync(["bash", factoryScript(top()), ...actionArgs(words)], { stdin: "ignore", stdout: "inherit", stderr: "inherit", env });
  return p.exitCode ?? 1;
}

/** What the bar runs for the line typed and the command picked: the typed line as it is when it starts with an offered
 *  command (`ci log 12`), else the pick. A line with a flag or extra words is left as typed, so resolve() refuses it
 *  rather than running the pick. */
export function barLine(typed: string, pick: string): string {
  const words = typed.trim().split(/\s+/).filter(Boolean);
  const asTyped = offeredLine(words) || words.some((w) => w.startsWith("-")) || OFFERED.some((n) => words.join(" ").startsWith(`${n} `));
  return asTyped || !pick ? typed : pick;
}

/** `factory cockpit --bar-resolve <typed> [<picked>]`: what the Ink bar's line runs, as JSON (`words`, `action` or null,
 *  its `question`, and `run`, the command), or the refusal on stderr. */
export function barResolve(args: string[]): number {
  if (args.length < 1 || args.length > 2) {
    refuse("cockpit_usage", "factory cockpit --bar-resolve takes the typed line and the command picked.",
      "The command bar runs it; to open the bar, run `factory cockpit --bar`.", 2);
  }
  const typed = args[0] ?? "";
  // The typed line must pass on its own first: a word refused when typed (`release`) is not run as the match picked.
  if (typed.trim()) resolve(typed);
  const words = resolve(barLine(typed, args[1] ?? ""));
  const action = actionOf(words) ?? null;
  const script = factoryScript(top());
  console.log(JSON.stringify({ words, action, question: action ? question(words) : "",
    run: ["bash", script, ...(action ? actionArgs(words) : words)] }));
  return 0;
}

/** `factory cockpit --bar [<words>]`: on a terminal the Ink bar, with the words typed in already; off one, the command
 *  is the words (else the first line on stdin) and the next line on stdin answers an action's question. */
export async function bar(words: string[] = []): Promise<number> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return view("bar", { prefill: words.length ? `${words.join(" ")} ` : "",
      resolve: [process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "factory_cockpit.ts"), "--bar-resolve"] });
  }
  const lines = (await new Response(Bun.stdin.stream()).text()).split(/\r?\n/);
  const line = words.length ? words.join(" ") : lines.shift() ?? "";
  const resolved = resolve(line);
  if (!actionOf(resolved)) return runOffered(resolved);
  console.log(question(resolved));
  if (!yes(lines[0] ?? "")) {
    console.log(NOT_RUN);
    return 0;
  }
  return runAction(resolved);
}

// --- the views drawn by the Ink UI (#367, decision 0002) -------------------------------------------------------------
//
// A view is a component in cockpit/views/, run by the Ink UI (`ui.tsx --view <name>`). This side says only what it
// reads and what it may run: the commands, the cache, the action's question. The UI does the rest, on a terminal or off.

function view(name: string, data: Obj): number {
  const ui = inkUi(true);
  if (!ui) refuse(UI_MISSING.code, UI_MISSING.message, UI_MISSING.fix, 1);
  const bad = uiPackagesProblem(ui, top());
  if (bad) refuse(bad.code, bad.message, bad.fix, 1);
  // Off a terminal Ink colours nothing unless told: a view coloured there (`color`) sets FORCE_COLOR.
  return runUi(ui, ["--view", name], { repo: basename(top()), ...data }, data.color === true ? { FORCE_COLOR: "1" } : {});
}

/** The command a view runs to read its data again: `factory cockpit --json` (the snapshot) or `--view-data <name>`. */
function readCommand(name: string | null): string[] {
  return name === null ? ["bash", factoryScript(top()), "cockpit", "--json"]
    : [process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "factory_cockpit.ts"), "--view-data", name];
}

/** Colour off a terminal, as the CI and usage views always had it: unless NO_COLOR, or a dumb (or no) TERM. */
function termColor(): boolean {
  return !process.env.NO_COLOR && !["", "dumb"].includes(process.env.TERM ?? "");
}

/** `factory cockpit --needs`: the Needs you view, from the cache; r reads the snapshot again. */
export function needs(): number {
  return view("needs", { snapshot: readCache(), read: readCommand(null) });
}

/** `factory cockpit --prs [<n>]`: the Pull requests view (#338), from `factory prs --json`, with <n> selected; m merges
 *  through `factory owner merge <n> --head <the head shown>` after its question. */
export function prsView(args: string[]): number {
  const word = args[0];
  if (args.length > 1 || (word !== undefined && !/^#?\d+$/.test(word))) {
    refuse("cockpit_usage", "factory cockpit --prs takes no argument, or the number of an open pull request.",
      "Run `factory cockpit --prs` for every open PR, or `factory cockpit --prs 12` to open #12's detail.", 2);
  }
  const read = [process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "factory_cockpit.ts"), "--prs-data"];
  return view("prs", { select: word === undefined ? null : Number(word.replace("#", "")), read, fresh: [...read, "--fresh"],
    act: ["bash", factoryScript(top())], changes: ACTIONS_OFFERED["owner merge"] });
}

/** `factory cockpit --prs-data [--fresh]`: what `factory prs --json` printed (nothing when it printed no JSON object), with
 *  `limit` saying when GitHub's limit is back when that limit stopped it (#383). */
export function prsData(args: string[]): number {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "--fresh")) {
    refuse("cockpit_usage", "factory cockpit --prs-data takes no argument, or --fresh.",
      "The Pull requests view runs it; to open the view, run `factory cockpit --prs`.", 2);
  }
  const hook = join(import.meta.dir, "factory_prs.ts");
  const p = run([process.execPath, "--no-env-file", "--config=/dev/null", hook, "--json", ...args], { timeoutMs: 120_000 });
  let data: unknown;
  try {
    data = JSON.parse(p.stdout);
  } catch {
    return 0;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return 0;
  const pulls = (data as Obj).pulls;
  if (!Array.isArray(pulls) && LIMITED.test(str(obj(pulls).error))) {
    (data as Obj).limit = limitSentence(limitStatus(), Date.now() / 1000);
  }
  console.log(JSON.stringify(data));
  return 0;
}

// --- the views that are one document (#367) --------------------------------------------------------------------------
//
// CI, Settings, Usage & lessons, Agents & machines, Health & releases: each a document the Ink UI draws (cockpit/views/),
// from data this side reads. On a terminal it scrolls (j k), r reads again and q closes; off one it is printed whole,
// sized by COLUMNS (else the terminal on stdin: in a popup, stdout may be a pager's pipe).

/** The terminal's width: COLUMNS, the terminal on stdout, the one on stdin (a popup pipes stdout to less), else 100. */
function termColumns(): number {
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

/** A document view: its data, the command that reads it again, and its width off a terminal. */
function docView(name: string, data: Obj): number {
  if (!process.stdout.isTTY) process.env.COLUMNS = String(Math.max(termColumns(), 20));
  return view(name, data);
}

function host(): string {
  return plain(hostname().split(".")[0]) || "this machine";
}

// --- the Settings view (#340, PRD US-13) -----------------------------------------------------------------------------
//
// `factory cockpit --settings [--color]` (cockpit/views/settings.tsx). In the cockpit's popup it is paged by `less -R`,
// whose `/` searches it. Plain text unless `--color` (and no NO_COLOR). Agents can't open it: it refuses in an agent
// session, as `factory settings` refuses their changes.

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

/** What the Settings view draws: the project's settings by section, this machine's, and the staged changes. */
function settingsData(): Obj {
  const [data] = store.readProject();
  const machine = store.readMachine();
  const found = loadStaged();
  const staged = "changes" in found ? found.changes : {};
  const problem = "problem" in found ? found.problem : "";
  const sections = SECTIONS.map(([slug, name]) => ({ name,
    rows: Object.values(SETTINGS).filter((s) => s.section === slug).map((s) => projectRow(data, staged, s)) }));
  const changes = problem ? [] : Object.keys(staged).map((key) => {
    const change = staged[key] as Staged[string];
    const was = lookup(data, key);
    return { key: plain(JSON.stringify(key)), was: was === MISSING ? null : plain(JSON.stringify(was)),
      now: "value" in change ? plain(JSON.stringify(change.value)) : null };
  });
  return { repo: plain(repoKey()), host: plain(hostname()), sections, machine: Object.values(MACHINE).map((s) => machineRow(machine, s)),
    staged: { problem: plain(problem), changes } };
}

function ownerOnly(): void {
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    if (name in process.env) {
      refuse("cockpit_agent_session", `The Settings view is the owner's, and ${name} is set, so this looks like an agent session.`,
        "Open it from the cockpit in your own terminal (`factory cockpit`, then 6), or run `factory cockpit --settings` there.");
    }
  }
}

export function settingsView(args: string[]): number {
  ownerOnly();
  const color = args.includes("--color") && !("NO_COLOR" in process.env);
  return docView("settings", { data: settingsData(), read: readCommand("settings"), color });
}

// --- the CI view (#339, PRD US-13) -----------------------------------------------------------------------------------
//
// `factory cockpit --ci` (cockpit/views/ci.tsx), from the `ci` part of the cockpit's cache, so it makes no GitHub call;
// the heavy runner count is this machine's setting (ci_names.ts). Coloured unless NO_COLOR or a dumb terminal.

export function ciView(): number {
  let heavy: Obj | null = null;
  try {
    const { raw, source } = runnerSetting(ciConfig());
    heavy = { raw: plain(raw), source: sourceText(source) };
  } catch {
    // .claude/factory.json can't be read: the card says so
  }
  return docView("ci", { data: readCache(), read: readCommand(null), color: termColor(), heavy, host: host() });
}

// --- the usage view (#341, PRD US-13) --------------------------------------------------------------------------------
//
// `factory cockpit --usage` (cockpit/views/usage.tsx). Its data is on this machine, so it makes no GitHub call: the
// tokens from Claude Code's logs (as `factory usage` counts them: fresh input + output), the budget from the `Budget for
// this task:` line the loop puts in the task's first prompt (else `budget.builder`), the agent from its worktree
// (`<project>-agents/<name>`), and the lessons file.

const DAY_MS = 86_400_000;
const PROMPT_BUDGET = /Budget for this task:\s*([0-9][0-9.,_]*\s*[km]?)\s+tokens/i;

interface TaskUse { task: string; agent: string; budget: number | null; used: number; top: string }

/** What a session's log says before its first reply: the budget in its first prompt, and the folder it ran in. */
function sessionStart(path: string): { budget: string; cwd: string } {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { budget: "", cwd: "" };
  }
  let cwd = "";
  for (const raw of text.split("\n")) {
    let d: Obj;
    try {
      d = obj(JSON.parse(raw));
    } catch {
      continue;
    }
    cwd ||= str(d.cwd);
    if (d.type !== "user") continue;
    const c = obj(d.message).content;
    const said = Array.isArray(c) ? c.map((b) => str(obj(b).text)).join(" ") : str(c);
    return { budget: PROMPT_BUDGET.exec(said)?.[1] ?? "", cwd };
  }
  return { budget: "", cwd };
}

function agentOf(cwd: string, root: string): string {
  const rest = cwd.startsWith(`${root}-agents/`) ? cwd.slice(root.length + 8) : "";
  return plain(rest.split("/")[0]) || "—";
}

/** The tasks of the last 7 days on this machine, newest task number first. */
async function taskUse(root: string, nowMs: number): Promise<TaskUse[]> {
  const { collect, counted, projectDirs, summarise } = await import("./factory_usage.ts");
  const { parseBudget, roleDefault } = await import("./factory_budget.ts");
  const base = join(process.env.HOME || homedir(), ".claude", "projects");
  const until = Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS; // the same period as `factory usage`
  const sessions = collect(root, base, until - 8 * DAY_MS, until);
  const starts = new Map<string, { budget: string; cwd: string }>();
  for (const d of projectDirs(root, base)) {
    for (const f of readdirSync(d).filter((n) => n.endsWith(".jsonl"))) starts.set(f.slice(0, -6), sessionStart(join(d, f)));
  }
  let builder: number | null = null;
  try {
    builder = roleDefault(load());
  } catch {
    // no readable factory.json: no default budget
  }
  const tasks = [...new Set([...sessions.values()].map((s) => s.task))].filter((t) => t !== "-");
  const out: TaskUse[] = [];
  for (const task of tasks) {
    const mine = new Map([...sessions].filter(([, s]) => s.task === task));
    const [groups, total] = summarise(mine, "agent");
    const begun = [...mine.keys()].map((sid) => starts.get(sid) ?? { budget: "", cwd: "" });
    const said = begun.map((b) => (b.budget ? parseBudget(`Budget: ${b.budget}`) : null)).find((b) => b !== null);
    const subs = [...groups].filter(([k]) => k !== "main").map(([k, g]): [string, number] => [k, counted(g.tokens)])
      .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    out.push({ task, agent: begun.map((b) => agentOf(b.cwd, root)).find((a) => a !== "—") ?? "—", budget: said ?? builder,
      used: counted(total.tokens), top: plain(subs[0]?.[0]) || "—" });
  }
  const n = (t: string) => Number(t.split(".")[0]) || 0;
  return out.sort((a, b) => n(b.task) - n(a.task) || b.task.localeCompare(a.task));
}

/** What the usage view draws for the project at `root`: the tasks against their budgets and the lessons. */
async function usageData(root: string, nowMs: number): Promise<Obj> {
  const cfg = obj(load());
  const path = str(cfg.lessons) || ".claude/factory/lessons.md";
  const cap = Math.max(Math.trunc(Number(cfg.lessonsCap ?? 40)) || 40, 1);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // no lessons file yet
  }
  const lessons = text.split("\n").filter((l) => l.startsWith("- ")).map((l) => plain(l.slice(2)));
  return { repo: plain(basename(root)), tasks: await taskUse(root, nowMs), lessons, cap, path: plain(path) };
}

export async function usageView(): Promise<number> {
  return docView("usage", { data: await usageData(process.cwd(), Date.now()), read: readCommand("usage"), color: termColor() });
}

// --- the Tasks & PRD, Agents & machines and Health & releases views (#367) -------------------------------------------

/** What the Tasks & PRD view draws: the project's tasks from its task tracker (#377), the GitHub issues in issues mode
 *  and the build plan otherwise, or the error that stopped the read. */
async function tasksData(): Promise<Obj> {
  const cfg = load();
  const source = taskSource(cfg);
  const base = { source, prd: plain(obj(cfg).prd) };
  try {
    const { taskTracker } = await import("./core/compose.ts");
    const tasks = taskTracker(cfg).list().map((t) => ({ id: plain(t.id), title: plain(t.title), state: t.state,
      holders: t.holders.map(plain), group: plain(t.group), todos: t.todos.map((d) => ({ done: d.done })) }));
    return { ...base, tasks };
  } catch (e) {
    return { ...base, error: plain(e instanceof Error ? e.message : String(e)) || "the tracker gave no tasks" };
  }
}

/** `factory cockpit --tasks`: the Tasks & PRD view; it reads the tasks itself, within its time limit. */
export function tasksView(): number {
  return view("tasks", { read: readCommand("tasks") });
}

/** `factory cockpit --agents`: the Agents & machines view, from the cache's sessions. */
export function agentsView(): number {
  return docView("agents", { data: readCache(), read: readCommand(null), host: host() });
}

/** `factory cockpit --health`: the Health & releases view, from the cache's doctor and version. */
export function healthView(): number {
  return docView("health", { data: readCache(), read: readCommand(null) });
}

/** `factory cockpit --view-data <settings|usage|tasks>`: what that view reads, as JSON. The views run it for r. */
export async function viewData(args: string[]): Promise<number> {
  const name = args[0] ?? "";
  if (args.length !== 1 || !["settings", "usage", "tasks"].includes(name)) {
    refuse("cockpit_usage", "factory cockpit --view-data takes settings, usage or tasks.",
      "The cockpit's views run it; to open one, run `factory cockpit --settings`, `--usage` or `--tasks`.", 2);
  }
  if (name === "settings") ownerOnly();
  const data = name === "settings" ? settingsData() : name === "usage" ? await usageData(process.cwd(), Date.now()) : await tasksData();
  console.log(JSON.stringify(data));
  return 0;
}
