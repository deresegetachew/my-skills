// Where agents run, and how to reach them (#106): the machine's remotes, the ssh calls, and finding sessions by name.
//
// A remote is only "how to reach a machine": a name and an ssh target (`factory@192.168.2.45`, or a Tailscale name), kept in
// this machine's own file (`factory machine show` prints where), never in the project and never on GitHub. A cloud agent is
// a name with the Remote Control link of its session. There is no role field: an agent is found by its name.
//
// Sessions are tmux sessions on the remote, one per agent, or on this machine (#301): its own tmux is asked directly, with no
// ssh and no sudo check (the name `local` is kept for it, so `--on local` picks this machine). A session belongs to an agent when its name is the agent's name or
// `<repo>-<agent>` (what `factory autostart` and `factory agent --detach` start). A one-item sub-manager that the dev manager's
// orchestrator starts (#97) is a session called `<manager>-<item>`, for example `dev-manager-pr-42`; it is listed too.
//
// Every ssh call reuses one connection per target (ControlMaster), uses keys only (BatchMode) and talks to the sandbox user:
// a target on which `sudo -n true` succeeds is refused. Errors are `{code, message, fix}`.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { machineSettings, saveMachineSettings } from "./factory_machine.ts";
import { FactoryError, pyDumps, pyRepr, run, shQuote, shSplit, splitLines, which } from "./factory_lib.ts";

const TARGET_OK = /^[A-Za-z0-9._-]+@[A-Za-z0-9.:\[\]_-]+$/;
const NAME_OK = /^[a-z][a-z0-9-]*$/;
const URL_OK = /^https:\/\/claude\.ai\/\S+$/;
export const LOCAL = "local";
export const HERE = "this machine";
export const MANAGER_ROLES = ["dev-manager", "manager", "product-owner", "po"];

export class RemoteError extends FactoryError {
  /** The error as Python's json.dumps wrote it. */
  asJson(): string {
    return pyDumps({ code: this.code, message: this.message, fix: this.fix });
  }
}

export interface Remote {
  kind?: string;
  target?: string;
  url?: string;
  [key: string]: unknown;
}

// ---- the remotes (machine scope) -----------------------------------------------------------------------------------

/** {name: {"kind": "ssh", "target": ...} | {"kind": "cloud", "url": ...}} from this machine's file. */
export function remotes(): Record<string, Remote> {
  const data = machineSettings().remotes;
  const out: Record<string, Remote> = {};
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) if (v && typeof v === "object" && !Array.isArray(v)) out[k] = v as Remote;
  }
  return out;
}

export function saveRemotes(data: Record<string, Remote>): void {
  saveMachineSettings({ remotes: data });
}

export function addSsh(name: string, target: string): void {
  if (!NAME_OK.test(name)) throw new RemoteError("bad-name", `${pyRepr(name)} is not a usable remote name.`, "Use lowercase letters, digits and dashes.");
  if (name === LOCAL) throw new RemoteError("bad-name", `${pyRepr(name)} is kept for ${HERE} (\`--on local\`).`, "Give the machine its own name, for example dev-pc.");
  if (!TARGET_OK.test(target)) {
    throw new RemoteError("bad-target", `${pyRepr(target)} is not user@host.`, "Give the sandbox user and the address, for example factory@192.168.2.45.");
  }
  if (["root", "admin"].includes(target.split("@")[0] as string)) {
    throw new RemoteError("admin-target", `${target} is an admin account.`, "Follow through the sandbox user that runs the agents (see factory bootstrap).");
  }
  const data = remotes();
  data[name] = { kind: "ssh", target };
  saveRemotes(data);
}

export function addCloud(agent: string, url: string): void {
  if (!NAME_OK.test(agent)) throw new RemoteError("bad-name", `${pyRepr(agent)} is not a usable agent name.`, "Use lowercase letters, digits and dashes.");
  if (!URL_OK.test(url)) {
    throw new RemoteError("bad-url", `${pyRepr(url)} is not a claude.ai link.`, "Copy the session's Remote Control link (https://claude.ai/code/...).");
  }
  const data = remotes();
  data[agent] = { kind: "cloud", url };
  saveRemotes(data);
}

export function remove(name: string): void {
  const data = remotes();
  if (!(name in data)) throw new RemoteError("no-such-remote", `There is no remote called ${name}.`, "factory remote list shows them.");
  delete data[name];
  saveRemotes(data);
}

// ---- ssh ---------------------------------------------------------------------------------------------------------------

export function controlDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(process.env.HOME || homedir(), ".cache");
  const d = join(base, "software-factory", "ssh");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** The ssh program and options: keys only, no prompts, one shared connection per target. */
export function sshCommand(tty = false): string[] {
  const base = shSplit(process.env.FACTORY_SSH ?? "ssh");
  const opts = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(controlDir(), "%C")}`, "-o", "ControlPersist=120"];
  return [...base, ...(tty ? ["-t"] : []), ...opts];
}

/** [returncode, stdout, stderr] of `bash -c script` on the target. */
export function sshRun(target: string, script: string, stdin: string | null = null, timeout = 30): [number, string, string] {
  const argv = [...sshCommand(), target, "bash -c " + shQuote(script)];
  const p = run(argv, { input: stdin ?? undefined, timeoutMs: timeout * 1000 });
  if (p.timedOut) return [255, "", `Command '${argv.join(" ")}' timed out after ${timeout} seconds`];
  return [p.code, p.stdout, p.stderr];
}

/** [returncode, stdout, stderr] of `bash -c script` on the target, or on this machine when the target is "". */
export function runOn(target: string, script: string, stdin: string | null = null, timeout = 30): [number, string, string] {
  if (target) return sshRun(target, script, stdin, timeout);
  const p = run(["bash", "-c", script], { input: stdin ?? undefined, timeoutMs: timeout * 1000 });
  if (p.timedOut) return [255, "", `tmux did not answer within ${timeout} seconds`];
  return [p.code, p.stdout, p.stderr];
}

function lastLine(text: string, dflt: string): string {
  const lines = splitLines(text.trim());
  return lines.length ? (lines[lines.length - 1] as string) : dflt;
}

/** Throws unless `target` is reachable and is not an account with sudo. */
export function ensureSandboxTarget(target: string): void {
  const [rc, out, err] = sshRun(target, "command -v tmux >/dev/null || echo NOTMUX; sudo -n true >/dev/null 2>&1 && echo SUDO; echo OK", null, 20);
  if (rc !== 0 || !out.includes("OK")) {
    throw new RemoteError("unreachable", `Could not reach ${target} (${lastLine(err, "no answer").slice(0, 120)}).`,
      "Check the address, that ssh keys work (`ssh " + target + "`), and that the machine is on.");
  }
  const words = out.split(/\s+/);
  if (words.includes("SUDO")) {
    throw new RemoteError("sudo-target", `${target} can run sudo, so it is not the sandbox user.`,
      "Follow through the unprivileged user that `factory bootstrap` made, never an admin account.");
  }
  if (words.includes("NOTMUX")) {
    throw new RemoteError("no-tmux", `${target} has no tmux, so no agent session can be there.`, "Install tmux on that machine.");
  }
}

// ---- finding sessions --------------------------------------------------------------------------------------------------

export const LIST_SCRIPT = String.raw`
if ! command -v tmux >/dev/null 2>&1; then echo NOTMUX; exit 0; fi
sudo -n true >/dev/null 2>&1 && echo SUDO
tmux list-sessions -F '#{session_name}' 2>/dev/null | while IFS= read -r s; do
  echo "S $s"
  tmux capture-pane -p -t "=$s:" -S -300 2>/dev/null | grep -Eo 'https://claude\.ai/code/[A-Za-z0-9_./?=&%-]+' | tail -n 1 | sed 's/^/U /'
done
echo END
`;

export interface Session {
  session: string;
  url: string;
}

/** [[{session, url}], flags (SUDO, NOTMUX, END)] from the list script's output. */
export function parseSessions(text: string): [Session[], Set<string>] {
  const sessions: Session[] = [];
  const flags = new Set<string>();
  let current: Session | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith("S ")) {
      current = { session: line.slice(2), url: "" };
      sessions.push(current);
    } else if (line.startsWith("U ") && current !== null) {
      current.url = line.slice(2).trim();
    } else if (["SUDO", "NOTMUX", "END"].includes(line)) {
      flags.add(line);
    }
  }
  return [sessions, flags];
}

export function knownNames(cfg: Record<string, unknown>): string[] {
  const names = [...((cfg.agents as string[] | undefined) ?? [])];
  const roles = cfg.roles;
  if (roles && typeof roles === "object") {
    for (const role of Object.values(roles as Record<string, unknown>)) {
      if (role && typeof role === "object" && !Array.isArray(role)) {
        const list = (role as Record<string, unknown>).names;
        if (Array.isArray(list)) names.push(...list.filter((n): n is string => typeof n === "string"));
      }
    }
  }
  return names;
}

/** [kind, name, item] for a tmux session name, or null when it is not the factory's.
 * kind is 'agent' (name is the agent) or 'sub-manager' (name is the manager, item the thing it works on). */
export function classify(session: string, names: string[], repo: string): [string, string, string] | null {
  for (const n of names) if (session === n || session === `${repo}-${n}`) return ["agent", n, ""];
  const bare = session.startsWith(repo + "-") ? session.slice(repo.length + 1) : session;
  for (const role of [...MANAGER_ROLES].sort((a, b) => b.length - a.length)) {
    if (bare.startsWith(role + "-") && bare.length > role.length + 1) return ["sub-manager", role, bare.slice(role.length + 1)];
  }
  return null;
}

export interface Found {
  kind: string;
  name: string;
  item: string;
  session: string;
  url: string;
}

export interface Discovered {
  remote: string;
  target: string;
  reachable: boolean;
  error: string;
  entries: Found[];
}

function entries(text: string, cfg: Record<string, unknown>, repo: string): Found[] {
  const names = knownNames(cfg);
  const out: Found[] = [];
  for (const s of parseSessions(text)[0]) {
    const found = classify(s.session, names, repo);
    if (found) out.push({ kind: found[0], name: found[1], item: found[2], session: s.session, url: s.url });
  }
  return out;
}

/** What this machine's own tmux has: no ssh, and no sudo check (that is for the sandbox user on a remote). */
export function discoverLocal(cfg: Record<string, unknown>, repo: string): Discovered {
  const out: Discovered = { remote: HERE, target: "", reachable: true, error: "", entries: [] };
  if (!which("tmux")) return out;
  const [rc, text] = runOn("", LIST_SCRIPT.replace(/^sudo .*\n/m, ""), null, 25);
  if (rc === 0) out.entries = entries(text, cfg, repo);
  return out;
}

/** What one ssh remote has. */
export function discoverOne(name: string, remote: Remote, cfg: Record<string, unknown>, repo: string): Discovered {
  const out: Discovered = { remote: name, target: remote.target as string, reachable: true, error: "", entries: [] };
  const [rc, text, err] = sshRun(remote.target as string, LIST_SCRIPT, null, 25);
  if (rc !== 0 || (!text.includes("END") && !text.includes("NOTMUX"))) {
    out.reachable = false;
    out.error = lastLine(err, "no answer").slice(0, 140);
    return out;
  }
  const flags = parseSessions(text)[1];
  if (flags.has("SUDO")) {
    out.reachable = false;
    out.error = "the account can run sudo: not the sandbox user";
    return out;
  }
  out.entries = entries(text, cfg, repo);
  return out;
}

/** Asks this machine and every ssh remote which sessions they have (`only`: one remote, or `local` for this machine).
 * Returns a list of per-machine results, this machine first, one after the other, each with its own timeout. */
export function discover(cfg: Record<string, unknown>, repo: string, only: string | null = null): Discovered[] {
  if (only === LOCAL) return [discoverLocal(cfg, repo)];
  const chosen = Object.entries(remotes()).filter(([k, v]) => v.kind === "ssh" && (only === null || k === only));
  if (only && !chosen.length) throw new RemoteError("no-such-remote", `There is no ssh remote called ${only}.`, "factory remote list shows them.");
  const here = only === null ? [discoverLocal(cfg, repo)] : [];
  return [...here, ...chosen.map(([k, v]) => discoverOne(k, v, cfg, repo))];
}

export interface CloudEntry {
  kind: "cloud";
  name: string;
  url: string;
  remote: "cloud";
}

export function cloudEntries(): CloudEntry[] {
  return Object.entries(remotes()).filter(([, v]) => v.kind === "cloud")
    .map(([k, v]) => ({ kind: "cloud" as const, name: k, url: (v.url as string) ?? "", remote: "cloud" as const }));
}

export type Hit = [kind: string, remote: string, target: string, session: string, url: string];

/** Where `agent` runs: ['ssh', remote name, target, session, url], ['local', 'this machine', '', session, url] or
 * ['cloud', 'cloud', '', '', url].
 * Throws when it is nowhere, or on more than one remote (then --on names the one). */
export function find(agent: string, cfg: Record<string, unknown>, repo: string, on: string | null = null): Hit {
  const hits: Hit[] = [];
  for (const r of discover(cfg, repo, on)) {
    for (const e of r.entries) {
      if ((e.kind === "agent" && e.name === agent) || e.session === agent) hits.push([r.target ? "ssh" : LOCAL, r.remote, r.target, e.session, e.url]);
    }
  }
  if (!on) for (const c of cloudEntries()) if (c.name === agent) hits.push(["cloud", "cloud", "", "", c.url]);
  if (hits.length > 1) {
    throw new RemoteError("ambiguous", `${agent} answers on ${hits.map((h) => h[1]).sort().join(", ")}: agent names must be unique.`,
      `Say which one: factory follow ${agent} --on <remote> (--on local for ${HERE}). (Two machines running one name is a setup error: ` +
      "see factory machine setup.)");
  }
  if (!hits.length) {
    const names = knownNames(cfg);
    const all = remotes();
    const reach = Object.keys(all).filter((r) => all[r]?.kind === "ssh");
    const looked = on === LOCAL ? [HERE] : on ? [on] : [HERE, ...reach];
    let hint = `It is not running on ${looked.join(", ")}. ` + (!reach.length && !on
      ? "`factory remote add <name> <user@host>` tells factory where the other machines are."
      : "`factory follow` lists what is.");
    if (names.length) hint = `Known names: ${names.join(", ")}. ` + hint;
    throw new RemoteError("no-such-agent", `No agent called ${agent} was found.`, hint);
  }
  return hits[0] as Hit;
}
