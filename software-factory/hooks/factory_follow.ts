#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory follow`, `factory say`, `factory remote` and `factory agent <name> --detach` (#106): watch and talk to an
// agent by its name, wherever it runs. The text below (HELP) is what `help` prints.
//
// Remotes live in this machine's own file, never in the project and never on GitHub. Errors are `{code, message, fix}`.
import { hostname } from "node:os";
import { join } from "node:path";
import { type Config, load } from "./factory_config.ts";
import * as A from "./factory_agents.ts";
import { repoKey } from "./factory_machine.ts";
import * as R from "./factory_remotes.ts";
import { RemoteError } from "./factory_remotes.ts";
import { Exit, pyDumps, run, runMain, shQuote, sleepSync, splitLines, which } from "./factory_lib.ts";

export const HELP = `\`factory follow\`, \`factory say\`, \`factory remote\` and \`factory agent <name> --detach\` (#106): watch and talk to an
agent by its name, wherever it runs: on this machine (its own tmux, no remote needed), on a remote, or in the cloud.

  factory remote add <name> <user@host>     how to reach a machine (the sandbox user, never an admin account)
  factory remote cloud <agent> <url>        a cloud agent: the Remote Control link of its session
  factory remote list | remove <name>
  factory follow [--json]                   every agent and one-item sub-manager we can find: name, where, state, task,
                                            last ping, Remote Control link
  factory follow <agent> [--read] [--on R]  attach to its session: type, answer prompts, Esc to interrupt. --read cannot type.
                                            A cloud agent prints its Remote Control link instead
  factory follow <agent> --log [--polls N]  stream the session's output without a terminal (Ctrl-C stops)
  factory follow --all [--on R]             one read-only pane per session (tiled), in a local tmux
  factory say <agent> "message" [--on R]    send one message, as if typed; the use is logged on that machine (no text)
  --on R                                    only remote R; --on local is this machine (the name local is kept for it)
  factory agent <name> --detach             start that agent in a detached tmux session (what the commands above find)

Remotes live in this machine's own file, never in the project and never on GitHub. Errors are \`{code, message, fix}\`.
Detach with Ctrl-b d. Closing the terminal or losing the connection only detaches; the agent keeps working. Ctrl+C is not
"detach": it interrupts Claude, and quitting Claude ends the session and drops its claims.
`;

export const DETACH_NOTE = "Detach with Ctrl-b d: the agent keeps working. Ctrl+C is not detach, it interrupts Claude, and quitting Claude " +
  "ends the session and drops its claims. Everyone attached sees one screen, sized to the smallest terminal; " +
  "use --read for extra viewers.";

type Cfg = Record<string, unknown>;

function inAgentSession(): boolean {
  return ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"].some((k) => process.env[k]);
}

/** Agents may read the list, but not type into other sessions or change where machines are. */
function agentsMayNot(what: string): void {
  if (inAgentSession()) {
    throw new RemoteError("agent-session", `An agent session can't ${what}.`,
      "A person runs this from their own terminal (the agent variables are set here).");
  }
}

function refuse(err: RemoteError): number {
  process.stderr.write(err.asJson() + "\n");
  return 1;
}

function project(): [Config, string] {
  const cfg = load();
  return [cfg, repoKey()];
}

export type States = Record<string, [state: string, minutes: number, task: string]>;

/** {agent name: [state, minutes since the last ping, task text]} from the agent issues; {} when issues mode is off or
 * GitHub can't be asked (then the list shows what the remotes see, without a state from GitHub). */
function githubStatesFromIssues(cfg: Cfg): States {
  const tasks = cfg.tasks as Record<string, unknown> | undefined;
  if ((tasks ?? {}).source !== "issues") return {};
  try {
    const out: States = {};
    for (const issue of A.current(A.agentIssues())) {
      const st = A.stateOf(cfg, issue);
      if (st) {
        const title = issue.title || "";
        const i = title.indexOf("·");
        out[st[0]] = [st[1], Math.trunc(st[3]), i >= 0 ? title.slice(i + 1).trim() : ""];
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Replaceable for tests (Python's `F.github_states = ...`). */
export let githubStates: (cfg: Cfg) => States = githubStatesFromIssues;
export function setGithubStates(f?: (cfg: Cfg) => States): void {
  githubStates = f ?? githubStatesFromIssues;
}

function ago(minutes: number): string {
  return minutes < 1 ? "just now" : minutes < 120 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

export interface Row {
  name: string;
  kind: string;
  where: string;
  state: string;
  task: string;
  lastPing: string;
  remoteControl: string;
}

const shownState = (s: string): string => (["working", "idle"].includes(s) ? "alive" : s);

/** The listing as rows, and the unreachable remotes. */
export function rows(cfg: Cfg, repo: string, on: string | null = null): [Row[], R.Discovered[]] {
  const found = R.discover(cfg, repo, on);
  const states = githubStates(cfg);
  const out: Row[] = [];
  const down: R.Discovered[] = [];
  const seen = new Set<string>();
  for (const r of found) {
    if (!r.reachable) down.push(r);
    for (const e of r.entries) {
      const st = e.kind === "agent" ? states[e.name] : undefined;
      seen.add(e.name);
      out.push({ name: e.kind === "sub-manager" ? e.session : e.name, kind: e.kind, where: r.remote,
        state: st ? shownState(st[0]) : "running",
        task: st ? st[2] : e.kind === "sub-manager" ? `${e.name} on ${e.item}` : "",
        lastPing: st ? ago(st[1]) : "", remoteControl: e.url });
    }
  }
  if (!on) {
    for (const c of R.cloudEntries()) {
      const st = states[c.name];
      seen.add(c.name);
      out.push({ name: c.name, kind: "agent", where: "cloud", state: st ? shownState(st[0]) : "cloud",
        task: st ? st[2] : "", lastPing: st ? ago(st[1]) : "", remoteControl: c.url });
    }
    for (const name of Object.keys(states).sort()) {
      if (!seen.has(name)) {
        const st = states[name] as [string, number, string];
        out.push({ name, kind: "agent", where: "not on a remote", state: st[0], task: st[2], lastPing: ago(st[1]), remoteControl: "" });
      }
    }
  }
  return [out, down];
}

interface FollowArgs {
  on: string | null;
  agent: string | null;
  read: boolean;
  all: boolean;
  log: boolean;
  json: boolean;
  polls: number | null;
}

function cmdList(args: FollowArgs): number {
  const [cfg, repo] = project();
  const [out, down] = rows(cfg as unknown as Cfg, repo, args.on);
  if (!out.length && !args.json && !Object.keys(R.remotes()).length) {
    console.log(`No agent sessions on ${R.HERE}, and no remotes yet. ` +
      "`factory remote add dev-pc factory@192.168.2.45` tells factory where another machine is.");
    return 0;
  }
  if (args.json) {
    console.log(pyDumps({ agents: out, unreachable: down.map((d) => ({ remote: d.remote, error: d.error })) }, { indent: 2 }));
    return 0;
  }
  if (out.length) {
    const head = ["NAME", "WHERE", "STATE", "TASK", "LAST PING", "REMOTE CONTROL"];
    const table = [head, ...out.map((r) => [r.name, r.where, r.state, r.task, r.lastPing, r.remoteControl || "-"])];
    const widths = [0, 1, 2, 3, 4].map((i) => Math.max(...table.map((row) => (row[i] as string).length)));
    for (const row of table) console.log(row.slice(0, 5).map((c, i) => c.padEnd(widths[i] as number)).join("  ") + "  " + row[5]);
  } else {
    console.log(`No agent sessions found on ${R.HERE} or the configured remotes.`);
  }
  for (const d of down) console.log(`${d.remote}: unreachable (${d.error})`);
  console.log("\nfactory follow <name> to attach (--read to watch only). Remote Control links open in the Claude app.");
  return 0;
}

/** How to attach to a session: over ssh, or with this machine's tmux when the target is "". */
export function attachArgv(target: string, session: string, read: boolean): string[] {
  if (!target) return ["tmux", "attach", ...(read ? ["-r"] : []), "-t", "=" + session];
  return [...R.sshCommand(true), target, `tmux attach ${read ? "-r " : ""}-t ${shQuote("=" + session)}`];
}

/** The environment without TMUX, so this machine's tmux attaches even from inside a tmux session. */
function outsideTmux(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TMUX;
  return env;
}

function gone(session: string, where: string): RemoteError {
  return new RemoteError("session-gone", `The session ${session} on ${where} is gone.`, "factory follow lists what is running.");
}

/** Run a program in this terminal and end with its exit code (Python's os.execvp). */
function exec(argv: string[], env?: Record<string, string | undefined>): number {
  const p = Bun.spawnSync(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: (env ?? process.env) as Record<string, string> });
  return p.exitCode ?? 1;
}

function cmdFollowOne(args: FollowArgs): number {
  const [cfg, repo] = project();
  const agent = args.agent as string;
  const [kind, remote, target, session, url] = R.find(agent, cfg as unknown as Cfg, repo, args.on);
  if (kind === "cloud") {
    console.log(`${agent} runs in the cloud. Open it from the Claude app or claude.ai/code:\n  ${url}`);
    return 0;
  }
  if (target) R.ensureSandboxTarget(target);
  if (args.log) return stream(target, session, args.polls);
  if (!target && run(["tmux", "has-session", "-t", `=${session}`]).code !== 0) throw gone(session, R.HERE);
  const note = `Following ${agent} on ${remote}${target ? ` (${target})` : ""}, tmux session ${session}.` +
    (args.read ? " Watching only: you cannot type." : "");
  process.stderr.write(note + "\n");
  if (url) process.stderr.write(`Remote Control: ${url}\n`);
  process.stderr.write(DETACH_NOTE + "\n");
  return exec(attachArgv(target, session, args.read), target ? undefined : outsideTmux());
}

function capture(target: string, session: string): string[] {
  const [rc, out, err] = R.runOn(target, `tmux capture-pane -p -t ${shQuote("=" + session + ":")} -S -200`, null, 20);
  if (rc !== 0) {
    const lines = splitLines(err.trim());
    throw new RemoteError("session-gone", `The session ${session} on ${target || R.HERE} is gone (${(lines.length ? lines[lines.length - 1] as string : "no answer").slice(0, 100)}).`,
      "factory follow lists what is running.");
  }
  return out.replace(/\n+$/, "").split("\n").filter((_, i, all) => !(all.length === 1 && all[0] === ""));
}

/** The lines of `now` that `prev` did not already have, when the screen only scrolled forward. */
export function newLines(prev: string[], now: string[]): string[] {
  for (let k = Math.min(prev.length, now.length); k > 0; k--) {
    const tail = prev.slice(prev.length - k);
    if (tail.every((l, i) => l === now[i])) return now.slice(k);
  }
  return now;
}

function stream(target: string, session: string, polls: number | null = null): number {
  let prev: string[] | null = null;
  let n = 0;
  while (polls === null || n < polls) {
    const now = capture(target, session);
    const lines = prev === null ? now : newLines(prev, now);
    if (lines.length) process.stdout.write(lines.map((l) => l + "\n").join(""));
    prev = now;
    n += 1;
    if (polls === null || n < polls) sleepSync(2);
  }
  return 0;
}

function cmdFollowAll(args: FollowArgs): number {
  const [cfg, repo] = project();
  const found = R.discover(cfg as unknown as Cfg, repo, args.on).flatMap((r) => r.entries.map((e) => [r, e] as const));
  if (!found.length) {
    return refuse(new RemoteError("nothing-to-follow", "No agent session was found on the remotes.",
      "Start agents with `factory agent <name> --detach` on those machines, or check `factory remote list`."));
  }
  if (!which("tmux")) return refuse(new RemoteError("no-tmux", "--all needs tmux on this machine to tile the panes.", "Install tmux, or follow one agent at a time."));
  for (const [r] of found) if (r.target) R.ensureSandboxTarget(r.target);
  const session = `factory-follow-${process.pid}`;
  const cmds = found.map(([r, e]) => (r.target ? "" : "TMUX= ") + attachArgv(r.target, e.session, true).map(shQuote).join(" "));
  const steps: string[][] = [["tmux", "new-session", "-d", "-s", session, cmds[0] as string]];
  for (const c of cmds.slice(1)) steps.push(["tmux", "split-window", "-t", session, c]);
  steps.push(["tmux", "select-layout", "-t", session, "tiled"], ["tmux", "set-option", "-t", session, "destroy-unattached", "on"]);
  const env = outsideTmux();
  for (const s of steps) run(s, { env, inherit: true });
  process.stderr.write("Read-only panes. Detach with Ctrl-b d.\n");
  return exec(["tmux", "attach", "-t", session], env);
}

function cmdSay(agent: string, message: string, on: string | null): number {
  agentsMayNot("send messages to other sessions (`factory say`)");
  if (!message.trim() || message.length > 2000 || /[\x00-\x1f\x7f]/.test(message)) {
    return refuse(new RemoteError("bad-message", "A message must be one line of text, up to 2000 characters.",
      "Send one line at a time. Never put a secret in it."));
  }
  const [cfg, repo] = project();
  const [kind, remote, target, session] = R.find(agent, cfg as unknown as Cfg, repo, on);
  if (kind === "cloud") {
    return refuse(new RemoteError("cloud-agent", `${agent} runs in the cloud, so there is no session to type into from here.`,
      "Open its Remote Control link (`factory follow " + agent + "`) in the Claude app and type there."));
  }
  if (target) R.ensureSandboxTarget(target);
  const who = `${process.env.USER || process.env.LOGNAME || "unknown"}@${hostname()}`;
  const s = shQuote(session);
  const script = `S=${s}; tmux has-session -t "=$S" 2>/dev/null || { echo NOSESSION; exit 3; }; msg=$(cat); ` +
    `tmux send-keys -t "=$S:" -l -- "$msg" && tmux send-keys -t "=$S:" Enter || exit 4; ` +
    `d="\${XDG_STATE_HOME:-$HOME/.local/state}/software-factory"; mkdir -p "$d"; ` +
    `printf '%s from=%s via=%s agent=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${shQuote(who)} "\${SSH_CLIENT%% *}" "$S" >>"$d/say.log"`;
  const [rc, out, err] = R.runOn(target, script, message);
  if (rc === 3 || out.includes("NOSESSION")) return refuse(gone(session, remote));
  if (rc !== 0) {
    const lines = splitLines(err.trim());
    return refuse(new RemoteError("say-failed", `Could not send the message to ${session} on ${remote}.`,
      (lines.length ? lines[lines.length - 1] as string : "Try again.").slice(0, 140)));
  }
  console.log(`Sent to ${agent} on ${remote} (logged there, without the text).`);
  return 0;
}

function agentSession(agent: string, cfg: Config): [string, string] {
  if (/^\d+$/.test(agent)) {
    const names = cfg.agents ?? [];
    const n = Number(agent);
    if (!(n >= 1 && n <= names.length)) throw new RemoteError("no-such-agent", `There is no agent number ${agent}.`, `Names: ${names.join(", ")}.`);
    agent = names[n - 1] as string;
  }
  return [agent, `${repoKey()}-${agent}`.replace(/[^A-Za-z0-9_-]+/g, "-")];
}

function cmdDetach(argv: string[]): number {
  if (!argv.length) return refuse(new RemoteError("usage", "factory agent <name> --detach needs an agent name.", "For example: factory agent haile --detach"));
  const [cfg] = project();
  let agent: string;
  let session: string;
  try {
    [agent, session] = agentSession(argv[0] as string, cfg);
  } catch (e) {
    if (e instanceof RemoteError) return refuse(e);
    throw e;
  }
  if (!which("tmux")) return refuse(new RemoteError("no-tmux", "tmux is not installed, so the agent cannot run detached.", "Install tmux, then run this again."));
  if (run(["tmux", "has-session", "-t", `=${session}`]).code === 0) {
    console.log(`${agent} is already running (tmux session ${session}). Follow it: factory follow ${agent}`);
    return 0;
  }
  const top = run(["git", "rev-parse", "--show-toplevel"]).stdout.trim();
  const command = "exec " + [join(top, "factory"), "agent", ...argv].map(shQuote).join(" ");
  const p = run(["tmux", "new-session", "-d", "-s", session, "-c", top, command]);
  if (p.code !== 0) {
    const lines = splitLines(p.stderr.trim());
    return refuse(new RemoteError("tmux-failed", `tmux could not start the session: ${(lines.length ? lines[lines.length - 1] as string : "no reason").slice(0, 120)}`,
      "Run `tmux ls` to see what is there."));
  }
  console.log(`Started ${agent} in the tmux session ${session}.\n` +
    `  here:        tmux attach -t ${session}   (detach with Ctrl-b d)\n` +
    `  from afar:   factory follow ${agent}     (after \`factory remote add <name> <user@host>\` on your own machine)`);
  return 0;
}

function cmdRemote(argv: string[]): number {
  try {
    const sub = argv[0] ?? "list";
    if (!["list", "ls"].includes(sub)) agentsMayNot("change the list of remotes");
    if (sub === "add" && argv.length === 3) {
      R.addSsh(argv[1] as string, argv[2] as string);
      console.log(`Added ${argv[1]} -> ${argv[2]}. \`factory follow\` lists the agents there.`);
    } else if (sub === "cloud" && argv.length === 3) {
      R.addCloud(argv[1] as string, argv[2] as string);
      console.log(`Added the cloud agent ${argv[1]}. \`factory follow ${argv[1]}\` prints its Remote Control link.`);
    } else if (["remove", "rm"].includes(sub) && argv.length === 2) {
      R.remove(argv[1] as string);
      console.log(`Removed ${argv[1]}.`);
    } else if (["list", "ls"].includes(sub) && argv.length <= 1) {
      const data = R.remotes();
      if (!Object.keys(data).length) console.log("No remotes. factory remote add <name> <user@host> | factory remote cloud <agent> <url>");
      for (const k of Object.keys(data).sort()) {
        const v = data[k] as R.Remote;
        console.log(`${k}  ${v.kind === "cloud" ? "cloud" : "ssh"}  ${v.url || v.target}`);
      }
    } else {
      process.stderr.write("usage: factory remote add <name> <user@host> | cloud <agent> <url> | list | remove <name>\n");
      return 1;
    }
  } catch (e) {
    if (e instanceof RemoteError) return refuse(e);
    throw e;
  }
  return 0;
}

const SAY_USAGE = "usage: factory say [--on ON] agent message";
const FOLLOW_USAGE = "usage: factory follow [--on ON] [--read] [--all] [--log] [--json]\n" +
  "                      [--polls POLLS]\n" +
  "                      [agent]";

function argError(usage: string, prog: string, text: string): never {
  process.stderr.write(`${usage}\n${prog}: error: ${text}\n`);
  throw new Exit(2);
}

/** argparse for `follow` and `say`, by hand: --on (and for follow its flags), then the positionals. */
function parseCommand(cmd: "say" | "follow", rest: string[]): { on: string | null; flags: Set<string>; polls: number | null; pos: string[] } {
  const usage = cmd === "say" ? SAY_USAGE : FOLLOW_USAGE;
  const prog = `factory ${cmd}`;
  const flags = new Set<string>();
  let on: string | null = null;
  let polls: number | null = null;
  const pos: string[] = [];
  const extra: string[] = [];
  const valued = cmd === "say" ? ["--on"] : ["--on", "--polls"];
  const boolFlags = cmd === "say" ? [] : ["--read", "--all", "--log", "--json"];
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i] as string;
    const eq = x.startsWith("--") ? x.indexOf("=") : -1;
    const key = eq > 0 ? x.slice(0, eq) : x;
    if (valued.includes(key)) {
      const v = eq > 0 ? x.slice(eq + 1) : rest[++i];
      if (v === undefined || (eq < 0 && v.startsWith("-") && v !== "-" && !/^-\d/.test(v))) argError(usage, prog, `argument ${key}: expected one argument`);
      if (key === "--on") on = v;
      else {
        if (!/^\s*[+-]?\d+\s*$/.test(v)) argError(usage, prog, `argument --polls: invalid int value: '${v}'`);
        polls = Number(v);
      }
    } else if (boolFlags.includes(x)) flags.add(x.slice(2));
    else if (x.startsWith("-") && x !== "-" && !/^-\d/.test(x) && !x.includes(" ")) extra.push(x); // argparse: a word with a space is a value
    else pos.push(x);
  }
  const want = cmd === "say" ? 2 : 1;
  if (cmd === "say" && pos.length < 2) {
    argError(usage, prog, `the following arguments are required: ${["agent", "message"].slice(pos.length).join(", ")}`);
  }
  if (pos.length > want) extra.push(...pos.splice(want));
  if (extra.length) argError(usage, prog, `unrecognized arguments: ${extra.join(" ")}`);
  return { on, flags, polls, pos };
}

export function main(argv: string[]): number {
  if (!argv.length || ["help", "-h", "--help"].includes(argv[0] as string)) {
    console.log(HELP);
    return 0;
  }
  const [cmd, ...rest] = argv as [string, ...string[]];
  try {
    if (cmd === "remote") return cmdRemote(rest);
    if (cmd === "detach") return cmdDetach(rest);
    if (cmd === "say") {
      const a = parseCommand("say", rest);
      return cmdSay(a.pos[0] as string, a.pos[1] as string, a.on);
    }
    if (cmd === "follow") {
      const a = parseCommand("follow", rest);
      const f: FollowArgs = { on: a.on, agent: a.pos[0] ?? null, read: a.flags.has("read"), all: a.flags.has("all"),
        log: a.flags.has("log"), json: a.flags.has("json"), polls: a.polls };
      if (f.all) return cmdFollowAll(f);
      return f.agent ? cmdFollowOne(f) : cmdList(f);
    }
    process.stderr.write(`factory_follow.ts: unknown command ${cmd}\n`);
    return 1;
  } catch (e) {
    if (e instanceof RemoteError) return refuse(e);
    throw e;
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
