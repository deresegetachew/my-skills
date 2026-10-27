#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// What belongs to this machine and not to the project (#45): its id, and the agent names it runs.
//
// Two machines on one project must never share an agent name. Both live outside the repo, in the config folder
// (`$FACTORY_CONFIG_DIR`, else `$XDG_CONFIG_HOME/software-factory`, else `~/.config/software-factory`):
//
//   machine-id        a random id made the first time it is needed (never the hostname). It goes into claims and agent
//                     pings, so two machines that use the same name can still be told apart. `FACTORY_MACHINE_ID` overrides it.
//   <repo>.json       {"agents": ["haile", "tewodros"]}: the names this machine runs for that project (<repo> is the
//                     folder name of the main clone). `FACTORY_AGENTS` (comma-separated) overrides it. With neither,
//                     every name in `agents` in .claude/factory.json is used, as before. The same file holds what
//                     `factory autostart` needs (#88): "autostart" (true/false), "autostartAgents" (names; default:
//                     the names above) and "autostartReport" (false: no boot report on the agent's issue), and
//                     "remoteControl" (false: sessions start without Remote Control; FACTORY_REMOTE_CONTROL wins).
//                     `factory settings --local` shows and changes all of them.
//   <repo>.env        KEY=value lines `factory resume` loads for the agents it starts at boot (SOPS_AGE_KEY_FILE ...).
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_machine.ts id                     print this machine's id
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_machine.ts show                   the id and the names this machine runs
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_machine.ts setup haile,tewodros   write the names file (issues mode: refuses a
//                                                                             name another machine has live)
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_machine.ts remote                 1 or 0: whether sessions start with Remote Control
// Errors are `{code, message, fix}` on stderr.
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Config, load, safeAgent, taskSource } from "./factory_config.ts";
import { heldElsewhere } from "./factory_agents.ts";
import { Exit, git, pyDumps, pyRepr, runMain } from "./factory_lib.ts";

const ID_OK = /^[A-Za-z0-9][A-Za-z0-9-]{3,39}$/;

/** Print a {code, message, fix} error on stderr and stop (Python's refuse: SystemExit(exit_code)). */
export function refuse(code: string, message: string, fix: string, exitCode = 1): never {
  process.stderr.write(pyDumps({ code, message, fix }) + "\n");
  throw new Exit(exitCode);
}

export function configDir(): string {
  let d = process.env.FACTORY_CONFIG_DIR;
  if (!d) {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    d = join(base, "software-factory");
  }
  return d;
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** This machine's id; made and saved on first use. '' when it can't be saved (a read-only home): claims then
 * carry no machine, exactly as before. */
export function machineId(): string {
  const given = (process.env.FACTORY_MACHINE_ID ?? "").trim();
  if (given) {
    return ID_OK.test(given) ? given : refuse("bad-machine-id", `FACTORY_MACHINE_ID ${pyRepr(given)} isn't a valid id.`,
      "Use 4 to 40 letters, digits or dashes, or unset it.");
  }
  const path = join(configDir(), "machine-id");
  const found = readTrimmed(path);
  if (found !== null && ID_OK.test(found)) return found;
  const fresh = randomUUID().replace(/-/g, "").slice(0, 12);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx");
    writeSync(fd, fresh + "\n");
    closeSync(fd);
    return fresh;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") { // another process made it a moment ago
      const again = readTrimmed(path);
      return again !== null && ID_OK.test(again) ? again : "";
    }
    return "";
  }
}

/** The folder name of the project's main clone (the same for every worktree of it). */
export function repoKey(): string {
  const p = git(["rev-parse", "--git-common-dir"]);
  const out = p.stdout.trim();
  const common = resolve(p.code === 0 && out ? out : ".git");
  return basename(dirname(common));
}

/** Where this machine keeps what it writes about the project (the boot log, the backups):
 * `$XDG_STATE_HOME/<repo>-factory`, else `~/.local/state/<repo>-factory`. */
export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, `${repoKey()}-factory`);
}

export function namesFile(): string {
  return join(configDir(), `${repoKey()}.json`);
}

export type MachineSettings = Record<string, unknown>;

/** Everything in this machine's file for the project (an object; {} when there is none or it can't be read). */
export function machineSettings(): MachineSettings {
  try {
    const data = JSON.parse(readFileSync(namesFile(), "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as MachineSettings) : {};
  } catch {
    return {};
  }
}

/** Replaces the machine's file with `data` (atomically). Returns the file's path. */
export function writeMachineSettings(data: MachineSettings): string {
  const path = namesFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, pyDumps(data, { indent: 2 }) + "\n");
  renameSync(tmp, path);
  return path;
}

/** Writes `updates` into the machine's file, keeping every other key. Returns the file's path. */
export function saveMachineSettings(updates: MachineSettings): string {
  return writeMachineSettings({ ...machineSettings(), ...updates });
}

/** True when sessions should start with Remote Control: FACTORY_REMOTE_CONTROL (1 or 0) wins, else this machine's
 * `remoteControl` setting (`factory settings --local set remoteControl off`), else on. */
export function remoteControl(): boolean {
  const given = process.env.FACTORY_REMOTE_CONTROL ?? "";
  if (given) return given === "1";
  return machineSettings().remoteControl !== false;
}

/** A name as Python's str(n).strip() shows it. */
function shown(n: unknown): string {
  return (n === null ? "None" : n === true ? "True" : n === false ? "False" : typeof n === "object" ? JSON.stringify(n) : String(n)).trim();
}

/** (on, agent names, post the boot report) for `factory autostart`. The names are `autostartAgents`, else the
 * names this machine runs. */
export function autostartSettings(): [boolean, string[], boolean] {
  const data = machineSettings();
  const listed = data.autostartAgents;
  const names = Array.isArray(listed) ? listed.map(shown).filter((n) => n) : machineNames();
  return [data.autostart === true, names, data.autostartReport !== false];
}

/** The names this machine runs: FACTORY_AGENTS, else the names file; [] when neither is set. */
export function machineNames(): string[] {
  const env = (process.env.FACTORY_AGENTS ?? "").split(",").map((n) => n.trim()).filter((n) => n);
  if (env.length) return env;
  let listed: unknown;
  try {
    const data = JSON.parse(readFileSync(namesFile(), "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    listed = (data as Record<string, unknown>).agents || [];
  } catch {
    return [];
  }
  return Array.isArray(listed) ? listed.map(shown).filter((n) => n) : [];
}

/** `names` (comma-separated) as a list, each one an agent in factory.json and, in issues mode, not live on another
 * machine. Anything else stops with a `{code, message, fix}`. */
export function checkedNames(cfg: Config, names: string, example: string): string[] {
  const known = (cfg.agents || []) as string[];
  const mine = names.split(",").filter((n) => n.trim()).map((n) => safeAgent(n.trim()));
  if (!mine.length) {
    refuse("no-names", "No agent names were given.", "Pass names from `agents` in .claude/factory.json, " +
      "for example: " + example + " " + known.slice(0, 2).join(","));
  }
  const unknown = mine.filter((n) => !known.includes(n));
  if (unknown.length) {
    refuse("unknown-agent", `${unknown.join(", ")} aren't agents in .claude/factory.json (${known.join(", ")}).`,
      "Choose from that list, or add the names to `agents` there in a pull request first.");
  }
  if (taskSource(cfg) === "issues") {
    const me = machineId();
    for (const n of mine) {
      if (heldElsewhere(cfg, n, me)) {
        refuse("agent-name-in-use", `${n} is live on another machine right now.`,
          "Choose a name no other machine uses, or stop that agent first.");
      }
    }
  }
  return mine;
}

function setup(names: string): void {
  const mine = checkedNames(load(), names, "factory machine setup");
  const path = saveMachineSettings({ agents: mine }); // keeps the autostart settings in the same file
  console.log(`${path}: ${mine.join(", ")}`);
}

function main(argv: string[]): void {
  const cmd = argv[0] ?? "show";
  if (cmd === "id") console.log(machineId());
  else if (cmd === "show") {
    console.log(`machine id: ${machineId() || "(could not be saved)"}`);
    console.log(`agents on this machine: ${machineNames().join(", ") || "every name in factory.json"}`);
    console.log(`names file: ${namesFile()}`);
    const [on, auto] = autostartSettings();
    console.log(`autostart: ${on ? "on" : "off"}` + (on && auto.length ? ` (${auto.join(", ")})` : "") +
      "  (factory autostart status)");
  } else if (cmd === "remote") console.log(remoteControl() ? "1" : "0");
  else if (cmd === "setup") {
    if (argv.length < 2) refuse("no-names", "No agent names were given.", "factory machine setup haile,tewodros");
    setup(argv[1] as string);
  } else refuse("unknown-command", `unknown command ${pyRepr(cmd)}.`, "Use id, show or setup <names>.");
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
