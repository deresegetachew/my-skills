// `factory cockpit` (#308, PRD US-10, decision 0001): the read-only cockpit, one terminal window built on tmux.
//
//   factory cockpit              open it (or come back to it): sessions and views on the left, the selected session on
//                                the right, the counts on top (`factory cockpit --status`), the keys at the bottom
//
// It runs on its own tmux server (socket factory-cockpit-<repo>), so its prefix (C-a) and keys never change the owner's
// own tmux, and a tmux nested over ssh keeps C-b. The config is written to this machine's state folder each time it
// opens. The right pane runs `factory follow <name>`, which attaches to the agent's real Claude Code session (on this
// machine with its tmux, elsewhere over ssh). Views are popups that run the existing commands through `less -R`.
// The owner's actions (#309, US-11) run the factory commands the command line runs (`factory owner merge|label|answer|
// release|start|stop`, `factory say`), each after a y/N question; the commands that agents and the gate use are never
// offered. A new owner ask rings the bell from the list, once (#310, US-12). The panes and popups run these, which are
// not for typing:
//
//   factory cockpit --sidebar    the list on the left (off a terminal: one frame, sized by COLUMNS and LINES); on a
//                                session s says, x stops it, n starts one (the bar, with the action typed in)
//   factory cockpit --bar [<words>]
//                                the `:` command bar: type to pick a factory command, the words typed in already (off a
//                                terminal: the words, else one line on stdin, and the next line answers an action's question)
//   factory cockpit --needs      the "Needs you" view, from the cache
//   factory cockpit --prs [<n>]  the Pull requests view (#338), from `factory prs --json`
//   factory cockpit --ci         the CI view (#339), from the cache
//   factory cockpit --usage      the Usage and lessons view (#341), from this machine's logs
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
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
    { key: "4", title: "CI", commands: [["cockpit", "--ci"]] }, // drawn after its board (#339)
    { key: "5", title: "Agents & machines", commands: [["agents", "ls"], ["machine", "show"]] },
    { key: "6", title: "Settings", commands: [["settings", "list"]] },
    { key: "7", title: "Health & releases", commands: [["doctor"], ["version"]] },
    { key: "8", title: "Usage & lessons", commands: [["cockpit", "--usage"]] }, // drawn after its board (#341)
  ];
}

/** The read-only commands the `:` bar offers (the owner's actions are ACTIONS_OFFERED). */
export const OFFERED = ["status", "prs", "next", "claims list", "agents ls", "messages ls", "issues list", "issues show",
  "ci status", "ci log", "ci runners", "settings list", "settings show", "settings get", "settings help", "settings diff",
  "usage", "report", "lessons show", "doctor", "version", "env", "machine show", "remote list", "help"];

/** The owner's actions (#309, US-11), each the factory command the command line runs, and what it changes. The bar asks
 *  before it runs one; the rest of the line (flags too, such as `--remove` or `--head`) goes to that command as typed. */
export const ACTIONS_OFFERED: Record<string, string> = {
  "owner merge": "GitHub: it merges the pull request",
  "owner label": "GitHub: it adds or removes a label",
  "owner answer": "GitHub: it posts the answer in the owner queue",
  "owner release": "GitHub: it tags main and pushes the tag, which publishes a release",
  "owner start": "this machine: it starts a session in tmux",
  "owner stop": "this machine: it ends that session",
  say: "a session: it types the message into it",
};

const ACTION_NAMES = Object.keys(ACTIONS_OFFERED);

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
  const ranked = [...OFFERED, ...ACTION_NAMES].map((n) => [n, rank(n, typed)] as const).filter((x): x is readonly [string, number] => x[1] !== null);
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
    else if (key === "s" || key === "x" || key === "n") {
      // The bar, with the action typed in already: the owner adds the message or the name, then answers its question.
      const e = entries(snap, vs)[selected];
      const name = e?.kind === "session" ? e.name : "";
      const words = key === "n" ? ["owner", "start"] : name ? (key === "s" ? ["say", name] : ["owner", "stop", name]) : [];
      if (words.length) popup(["-w", "80%", "-h", "60%"], factoryCall(script, ["cockpit", "--bar", ...words]));
    } else if (key === "q") tmux(sock, ["detach-client"]);
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

/** On a terminal: answers the question with one key, runs the action on y, and leaves its output on screen. Returns
 *  the exit code, or null when the answer was no. The caller waits for the next key before closing. */
function answerAction(words: string[], key: string): number | null {
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[H\x1b[2J");
  const code = yes(key) ? runAction(words) : null;
  if (code === null) console.log(NOT_RUN);
  process.stdout.write("\r\nPress a key to go on.");
  process.stdin.setRawMode(true);
  return code;
}

async function barLoop(prefill: string): Promise<number> {
  let typed = prefill;
  let at = 0;
  let asking: string[] | null = null;
  let finished: number | null = null;
  const draw = () => {
    if (asking) {
      process.stdout.write("\x1b[H\x1b[2J" + question(asking) + "\r\ny runs it · any other key does nothing");
      return;
    }
    const rows = Math.max((process.stdout.rows || 20) - 3, 1);
    const found = matches(typed).slice(0, rows);
    const lines = [`factory ${typed}`, "Type to pick · ↑↓ · Enter runs it (an action asks first) · Esc closes", "",
      ...found.map((m, i) => (i === at ? `\x1b[7m› ${m}\x1b[0m` : `  ${m}`))];
    if (!found.length) lines.push("  no command the cockpit offers matches");
    process.stdout.write("\x1b[H\x1b[2J" + lines.join("\r\n"));
  };
  process.stdin.setRawMode(true);
  draw();
  for await (const chunk of process.stdin) {
    const key = String(chunk);
    if (finished !== null) break;
    if (asking) {
      finished = answerAction(asking, key) ?? 0;
      continue;
    }
    if (key === "\x1b" || key === "\x03") return 0;
    if (key === "\r" || key === "\n") {
      const pick = matches(typed)[at];
      const words = typed.trim().split(/\s+/).filter(Boolean);
      // What was typed runs as it is when it starts with an offered command (`ci log 12`); else the line picked.
      // A line with a flag or extra words is left as typed, so resolve() refuses it rather than running the pick.
      const asTyped = offeredLine(words) || words.some((w) => w.startsWith("-")) || OFFERED.some((n) => words.join(" ").startsWith(`${n} `));
      const line = asTyped ? typed : pick ?? typed;
      let resolved: string[];
      try {
        resolved = resolve(line);
      } catch (e) {
        process.stdin.setRawMode(false);
        process.stdout.write("\x1b[H\x1b[2J");
        await Bun.sleep(4_000); // the refusal stays on screen a moment before the popup closes
        throw e;
      }
      if (actionOf(resolved)) {
        asking = resolved;
        draw();
        continue;
      }
      process.stdin.setRawMode(false);
      process.stdout.write("\x1b[H\x1b[2J");
      return runOffered(resolved, true);
    }
    if (key === "\x7f" || key === "\b") typed = typed.slice(0, -1);
    else if (key === "\x1b[A") at = Math.max(at - 1, 0);
    else if (key === "\x1b[B") at = Math.min(at + 1, Math.max(matches(typed).length - 1, 0));
    else if (/^[\x20-\x7e]+$/.test(key)) typed += key;
    if (key !== "\x1b[A" && key !== "\x1b[B") at = 0;
    draw();
  }
  process.stdin.setRawMode(false);
  return finished ?? 0;
}

/** `factory cockpit --bar [<words>]`: on a terminal the words are typed in already; off one, the command is the words
 *  (else the first line on stdin) and the next line on stdin answers an action's question. */
export async function bar(words: string[] = []): Promise<number> {
  if (process.stdin.isTTY && process.stdout.isTTY) return barLoop(words.length ? `${words.join(" ")} ` : "");
  const lines = (await new Response(Bun.stdin.stream()).text()).split(/\r?\n/);
  const line = words.length ? words.join(" ") : lines.shift() ?? "";
  const resolved = resolve(line);
  if (!actionOf(resolved)) return runOffered(resolved, false);
  console.log(question(resolved));
  if (!yes(lines[0] ?? "")) {
    console.log(NOT_RUN);
    return 0;
  }
  return runAction(resolved);
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
// by COLUMNS and LINES, with <n> selected (else the first PR), and no colour. m merges the selected PR after a y/N
// question, through `factory owner merge <n> --head <the head shown>` (#309), so one that moved since is not merged.

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

function prPaint(text: string, colour: string, color: boolean): string {
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

function prWidth(s: string): number {
  return [...s.replace(ANSI, "")].length;
}

/** Cuts `s` to `n` visible characters (an ellipsis when cut), dropping colour when it has to cut. */
function prCut(s: string, n: number): string {
  if (prWidth(s) <= n) return s;
  const chars = [...s.replace(ANSI, "")];
  return n <= 0 ? "" : `${chars.slice(0, n - 1).join("")}…`;
}

function prPad(s: string, n: number): string {
  const c = prCut(s, n);
  return c + " ".repeat(Math.max(n - prWidth(c), 0));
}

/** `left` and `right` on one line of `cols`, the right one dropped when both don't fit. */
function spread(left: string, right: string, cols: number): string {
  const gap = cols - prWidth(left) - prWidth(right);
  return gap >= 2 ? left + " ".repeat(gap) + right : prCut(left, cols);
}

interface Column {
  head: string;
  size: number;
  cell: (p: Obj, color: boolean) => string;
}

const BY: Column = { head: "by", size: 10, cell: (p) => plain(p.agent) || "—" };
const CI: Column = { head: "CI", size: 8, cell: (p, color) => {
  const state = plain(obj(p.ci).state) || "—";
  return prPaint(state, ciColour(state), color);
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
  return cells.map((c, i) => prPad(c, sizes[i] as number)).join("");
}

function prTable(pulls: Obj[], selected: number, cols: number, color: boolean): string[] {
  const rest = columns(cols);
  const titleSize = Math.max(cols - 2 - 6 - rest.reduce((n, c) => n + c.size, 0), 8);
  const sizes = [6, titleSize, ...rest.map((c) => c.size)];
  const head = "  " + tableRow(["PR", "title", ...rest.map((c) => c.head)], sizes);
  const rows = pulls.map((p, i) => {
    const prot = isProtected(p) ? " · protected" : "";
    const room = titleSize - 1; // a space before the next column
    const title = prCut(plain(p.title), Math.max(room - prot.length, 1)) + prPaint(prot, "amber", color);
    const line = (i === selected ? "› " : "  ") + tableRow([`#${plain(p.number)}`, title, ...rest.map((c) => c.cell(p, color))], sizes);
    return color && i === selected ? `\x1b[1m${line}\x1b[0m` : line;
  });
  return [prPaint(head, "dim", color), ...rows];
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
  const ok = (s: string) => prPaint(s, "green", color);
  const bad = (s: string) => prPaint(s, "red", color);
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
  const jobs = notGreen.map((j) => `${plain(j.name)} ${plain(j.state) === "red" ? bad("✕") : prPaint(plain(j.state), "amber", color)}`);
  const others = Math.max(Number(ci.jobs ?? 0) - notGreen.length, 0); // jobs, not runs: re-runs and skipped don't count
  if (others) jobs.push(`${others} other check${others === 1 ? "" : "s"} ${ok("✓")}`);
  const ciLine = `CI ${prPaint(state, ciColour(state), color)}${jobs.length ? `   ${jobs.join("   ")}` : ""}`;

  const open = questions.filter((q) => q.kind === "pr" && plain(q.number) === n).length;
  const prot = isProtected(p) ? prPaint("yes, a person merges it", "amber", color)
    : p.protected === false ? "none" : "checked once it could merge";
  const lines = [
    spread(`#${n} · ${plain(p.title)}`, who, cols),
    facts.join(" · "),
    manager,
    ciLine,
    `questions ${open ? prPaint(`${open} open`, "amber", color) : "none open"}   protected paths ${prot}`,
    `next ${nextText(p)}   who acts ${whoActs(p)}`,
  ];
  if (plain(p.url)) lines.push(prPaint(plain(p.url), "dim", color));
  return lines.map((l) => prCut(l, cols));
}

const PR_KEYS = "j k move · m merge · r read again · q close";

/** What `m` runs for a PR: `factory owner merge` pinned to the head this view showed (#309), or null when the view has
 *  no head for it. A PR that moved since is refused by that command (`pr_changed`), never merged at a newer head. */
export function mergeWords(p: Obj): string[] | null {
  const sha = plain(obj(p.head).sha);
  const n = plain(p.number);
  return /^[0-9a-f]{7,40}$/i.test(sha) && /^\d+$/.test(n) ? ["owner", "merge", n, "--head", sha] : null;
}

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
  const out = [heading, ...body.map((l) => prCut(l, cols))];
  const keys = prPaint(prCut(PR_KEYS, cols), "dim", color);
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
  let asking: string[] | null = null;
  let shown = false; // an action's output is on screen: the next key goes back to the list
  // A pending question stays on screen through a resize, and so does an action's output.
  process.stdout.on("resize", () => {
    if (asking) draw(`${question(asking)}\r\ny runs it · any other key does nothing`);
    else if (!shown) draw();
  });
  try {
    draw();
    // No Esc to close: over a slow ssh link an arrow key can come in two pieces, and its first is a lone Esc.
    for await (const chunk of process.stdin) {
      const key = String(chunk);
      const count = openPulls(data).length;
      if (shown) {
        shown = false;
        draw("Reading the pull requests from GitHub…");
        data = readPrs(true);
        selected = Math.min(selected, Math.max(openPulls(data).length - 1, 0));
      } else if (asking) {
        answerAction(asking, key);
        asking = null;
        shown = true;
        continue;
      } else if (key === "q" || key === "\x03") break;
      else if (key === "m") {
        const p = openPulls(data)[selected];
        const words = p ? mergeWords(p) : null;
        if (words) {
          asking = words;
          draw(`${question(words)}\r\ny runs it · any other key does nothing`);
          continue;
        }
        draw("This view has no head commit for that pull request: press r to read it again.");
        continue;
      } else if (key === "j" || key === "\x1b[B") selected = Math.min(selected + 1, Math.max(count - 1, 0));
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

// --- the usage view (#341, PRD US-13) --------------------------------------------------------------------------------
//
// `factory cockpit --usage`, drawn after its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VUsage.dc.html): each task of
// the last 7 days against its budget as a bar, with its agent and the subagent that spent most, a few figures, and the
// lessons. Its data is on this machine, so it makes no GitHub call: the tokens from Claude Code's logs (as `factory
// usage` counts them: fresh input + output), the budget from the `Budget for this task:` line the loop puts in the
// task's first prompt (else `budget.builder`), the agent from its worktree (`<project>-agents/<name>`), and the lessons
// file. Rework rounds and CI runs are on GitHub, so it names `factory report` for them. A plain terminal, as the CI view.

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

function median(xs: number[]): number | null {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function tokensShort(n: number): string {
  return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}m` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function barStyle(pct: number): Style {
  return pct >= 100 ? "red" : pct >= 80 ? "amber" : "blue";
}

/** `cells` wide: filled for what is used (full at 100% and over), the rest light. */
function usageBar(t: TaskUse, cells: number): Seg[] {
  if (t.budget === null) return [["░".repeat(cells), "dim"]];
  const pct = Math.round((t.used / t.budget) * 100);
  const full = Math.min(Math.round((pct / 100) * cells), cells);
  return [["█".repeat(full), barStyle(pct)], ["░".repeat(cells - full), "dim"]];
}

function percentText(t: TaskUse): [string, Style] {
  if (t.budget === null) return ["—", "dim"];
  const pct = Math.round((t.used / t.budget) * 100);
  return [pct >= 100 ? `${pct}% over` : `${pct}%`, barStyle(pct)];
}

function drawTasks(tasks: TaskUse[], w: number): string[] {
  if (!tasks.length) return wrap("No task on this machine in the last 7 days.", w).map((l) => line([[l, "dim"]], w));
  const out: string[] = [];
  if (w >= 80) {
    const cells = 20;
    out.push(line([[`${pad("task", 8)}${pad("agent", 12)}${pad("budget", 9)}${pad("used", cells + 11)}spent most`, "dim"]], w));
    for (const t of tasks) {
      const [p, ps] = percentText(t);
      const budget = t.budget === null ? "none" : tokensShort(t.budget);
      out.push(line([[pad(`#${plain(t.task)}`, 8), "dim"], [pad(t.agent, 12), ""], [pad(budget, 9), ""], ...usageBar(t, cells),
        [` ${pad(p, 10)}`, ps], [t.top, "dim"]], w));
    }
    return out;
  }
  for (const t of tasks) {
    const [p, ps] = percentText(t);
    out.push(line([[`#${plain(t.task)}  `, "dim"], [`${t.agent}  `, ""], [t.budget === null ? "none" : tokensShort(t.budget), ""]], w));
    out.push(line([["  ", ""], ...usageBar(t, 10), [` ${p}  `, ps], [t.top, "dim"]], w));
  }
  return out;
}

function drawFigures(tasks: TaskUse[], w: number): string[] {
  const budgeted = tasks.filter((t) => t.budget !== null);
  const ratio = median(budgeted.map((t) => t.used / (t.budget as number)));
  const per = median(tasks.map((t) => t.used));
  const figures: Array<[string, string]> = [["tasks", String(tasks.length)],
    ["budget vs used, median", ratio === null ? "—" : ratio.toFixed(2)],
    ["over budget", String(budgeted.filter((t) => t.used > (t.budget as number)).length)],
    ["per task, median", per === null ? "—" : tokensShort(per)]];
  const out = w >= 96
    ? drawCards(figures.map(([label, value]) => ({ title: label, warn: false, lines: [[value, "bold"]] })), w)
    : figures.map(([label, value]) => line([[`${label}: `, "dim"], [value, "bold"]], w));
  out.push(...wrap("Rework rounds and CI runs per task are on GitHub: factory report. Logs are per machine: a task built " +
    "on another machine shows in its own factory usage.", w).map((l) => line([[l, "dim"]], w)));
  return out;
}

function drawLessons(w: number): string[] {
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
  const out = [line([["Lessons", "bold"], [`  ${lessons.length} of ${cap}`, "dim"]], w)];
  out.push(...wrap(`${plain(path)}, read first by builders and reviewers`, w).map((l) => line([[l, "dim"]], w)));
  if (!lessons.length) out.push(line([["No lessons yet.", "dim"]], w));
  for (const l of lessons) out.push(...wrap(l, w - 2).map((x, i) => line([[i ? "  " : "- ", "dim"], [x, ""]], w)));
  const keys = "suggest from recent must-fixes: factory lessons suggest · add: factory lessons add \"<rule>\" (dev manager) · " +
    "prune: factory lessons prune (dev manager)";
  out.push(...wrap(keys, w, " · ").map((l) => line([[l, "dim"]], w)));
  return out;
}

const USAGE_KEYS = "by task, role, agent or model: factory usage --by agent · a period: factory usage --since <date> · " +
  "one task: factory usage --task <n> --budget · rework and CI runs: factory report";

/** The usage view of the project at `root`, as lines at most `w` wide. */
export async function renderUsage(root: string, w: number, nowMs: number): Promise<string[]> {
  const title = `${plain(basename(root))} · Usage and lessons`;
  const left: Seg[] = [["factory", "amber"], [`  ${title}`, "dim"]];
  const right = "factory usage (this machine's logs) · last 7 days";
  const leftW = len("factory") + 2 + len(title);
  const out = w - leftW >= len(right) + 2
    ? [line([...left, [" ".repeat(w - leftW - len(right)), ""], [right, "dim"]], w)]
    : [line(left, w), ...wrap(right, w).map((l) => line([[l, "dim"]], w))];
  out.push("", ...wrap("Tasks against their budget · fresh input + output, cache reads not counted", w, " · ")
    .map((l, i) => line([[l, i ? "dim" : "bold"]], w)));
  const tasks = await taskUse(root, nowMs);
  out.push(...drawTasks(tasks, w), "", ...drawFigures(tasks, w), "", ...drawLessons(w));
  out.push("", ...wrap(USAGE_KEYS, w, " · ").map((l) => line([[l, "dim"]], w)));
  return out;
}

export async function usageView(): Promise<number> {
  COLOR = !process.env.NO_COLOR && !["", "dumb"].includes(process.env.TERM ?? "");
  console.log((await renderUsage(process.cwd(), width(), Date.now())).join("\n"));
  return 0;
}
