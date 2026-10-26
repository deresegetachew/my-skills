// Where agents run, and how to reach them (#106): the machine's remotes, the ssh calls, and finding sessions by name.
//
// A remote is only "how to reach a machine": a name and an ssh target (`factory@192.168.2.45`, or a Tailscale name), kept in
// this machine's own file (`factory machine show` prints where), never in the project and never on GitHub. A cloud agent is
// a name with the Remote Control link of its session. There is no role field: an agent is found by its name.
//
// Sessions are tmux sessions on the remote, one per agent. A session belongs to an agent when its name is the agent's name or
// `<repo>-<agent>` (what `factory autostart` and `factory agent --detach` start). A one-item sub-manager that the dev manager's
// orchestrator starts (#97) is a session called `<manager>-<item>`, for example `dev-manager-pr-42`; it is listed too.
//
// Every ssh call reuses one connection per target (ControlMaster), uses keys only (BatchMode) and talks to the sandbox user:
// a target on which `sudo -n true` succeeds is refused. Errors are `{code, message, fix}`.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { machineSettings, saveMachineSettings } from "./factory_machine.ts";
import { FactoryError, pyDumps, pyRepr, run, shQuote, shSplit, splitLines } from "./factory_lib.ts";

const TARGET_OK = /^[A-Za-z0-9._-]+@[A-Za-z0-9.:\[\]_-]+$/;
const NAME_OK = /^[a-z][a-z0-9-]*$/;
const URL_OK = /^https:\/\/claude\.ai\/\S+$/;
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

/** What one ssh remote has. */
export function discoverOne(name: string, remote: Remote, cfg: Record<string, unknown>, repo: string): Discovered {
  const out: Discovered = { remote: name, target: remote.target as string, reachable: true, error: "", entries: [] };
  const [rc, text, err] = sshRun(remote.target as string, LIST_SCRIPT, null, 25);
  if (rc !== 0 || (!text.includes("END") && !text.includes("NOTMUX"))) {
    out.reachable = false;
    out.error = lastLine(err, "no answer").slice(0, 140);
    return out;
  }
  const [sessions, flags] = parseSessions(text);
  if (flags.has("SUDO")) {
    out.reachable = false;
    out.error = "the account can run sudo: not the sandbox user";
    return out;
  }
  const names = knownNames(cfg);
  for (const s of sessions) {
    const found = classify(s.session, names, repo);
    if (found) out.entries.push({ kind: found[0], name: found[1], item: found[2], session: s.session, url: s.url });
  }
  return out;
}

/** Asks every ssh remote which sessions it has. Returns a list of per-remote results. (The Python asked them in
 * parallel threads; here one after the other, each with its own timeout.) */
export function discover(cfg: Record<string, unknown>, repo: string, only: string | null = null): Discovered[] {
  const chosen = Object.entries(remotes()).filter(([k, v]) => v.kind === "ssh" && (only === null || k === only));
  if (only && !chosen.length) throw new RemoteError("no-such-remote", `There is no ssh remote called ${only}.`, "factory remote list shows them.");
  return chosen.map(([k, v]) => discoverOne(k, v, cfg, repo));
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

/** Where `agent` runs: ['ssh', remote name, target, session, url] or ['cloud', 'cloud', '', '', url].
 * Throws when it is nowhere, or on more than one remote (then --on names the one). */
export function find(agent: string, cfg: Record<string, unknown>, repo: string, on: string | null = null): Hit {
  const hits: Hit[] = [];
  for (const r of discover(cfg, repo, on)) {
    for (const e of r.entries) {
      if ((e.kind === "agent" && e.name === agent) || e.session === agent) hits.push(["ssh", r.remote, r.target, e.session, e.url]);
    }
  }
  if (!on) for (const c of cloudEntries()) if (c.name === agent) hits.push(["cloud", "cloud", "", "", c.url]);
  if (hits.length > 1) {
    throw new RemoteError("ambiguous", `${agent} answers on ${hits.map((h) => h[1]).sort().join(", ")}: agent names must be unique.`,
      `Say which one: factory follow ${agent} --on <remote>. (Two machines running one name is a setup error: ` +
      "see factory machine setup.)");
  }
  if (!hits.length) {
    const names = knownNames(cfg);
    const all = remotes();
    const reach = Object.keys(all).filter((r) => all[r]?.kind === "ssh");
    let hint = !reach.length ? "`factory remote add <name> <user@host>` tells factory where the machines are."
      : `It is not running on ${reach.join(", ")}. \`factory follow\` lists what is.`;
    if (names.length && !names.includes(agent)) hint = `Known names: ${names.join(", ")}. ` + hint;
    throw new RemoteError("no-such-agent", `No agent called ${agent} was found.`, hint);
  }
  return hits[0] as Hit;
}
