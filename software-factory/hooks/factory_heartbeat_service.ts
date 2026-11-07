#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Keeps the heartbeat daemon (factory_heartbeat.ts, #108) running: a systemd user service on Linux, a LaunchAgent on
// macOS. It is the long-running sibling of the boot job `factory autostart` installs (factory_autostart.ts): that one
// runs `factory resume` once per boot, this one runs `factory heartbeat run` for as long as the machine is up and
// restarts it if it stops.
//
//   factory heartbeat install      write the service and start it now (Linux: enable --now, linger on; macOS: bootstrap)
//   factory heartbeat uninstall    stop it and remove the service; agents keep running, they just stop being watched
//   factory heartbeat restart      restart the installed service so it runs the files now on disk (`factory update` does this);
//                                  says nothing and does nothing when no service is installed
//
//   factory heartbeat ensure       install it if it is missing, start it if it is installed but not running, else nothing
//
// `factory autostart install` calls install too (unless --no-heartbeat), and `factory autostart uninstall` removes it.
// The setup paths ensure it (`factory init`, `factory owner start`, the web UI's add-project steps), except in an agent
// session or with FACTORY_SETUP_HEARTBEAT=off (the factory's own tests set it, so they never touch a real service).
// Names: <repo>-factory-heartbeat.service (Linux) and dev.software-factory.<repo>-heartbeat (macOS), where <repo> is
// the folder name of the main clone. Errors are `{code, message, fix}` on stderr.
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, taskSource } from "./factory_config.ts";
import * as AS from "./factory_autostart.ts";
import { refuse, repoKey, stateDir } from "./factory_machine.ts";
import { mainTop } from "./factory_resume.ts";
import { plistDumps, runMain, which } from "./factory_lib.ts";

/** A service step that could not be done (Python's ValueError((code, message, fix))). */
export class ServiceError extends Error {
  readonly code: string;
  readonly fix: string;
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

export function unitName(): string {
  return `${repoKey()}-factory-heartbeat.service`;
}

export function agentLabel(): string {
  return `dev.software-factory.${repoKey()}-heartbeat`;
}

function unitFile(): string {
  return join(dirname(AS.unitFile()), unitName());
}

function plistFile(): string {
  return join(homedir(), "Library", "LaunchAgents", agentLabel() + ".plist");
}

/** 'enabled' | 'not installed' | 'unknown' (can't ask: no systemctl or launchctl). */
export function serviceState(): "enabled" | "not installed" | "unknown" {
  if (AS.platform() === "mac") {
    if (!which("launchctl")) return "unknown";
    return AS.run("launchctl", "print", `${AS.domain()}/${agentLabel()}`)[0] === 0 ? "enabled" : "not installed";
  }
  if (!AS.userManagerOk()) return "unknown";
  return AS.run("systemctl", "--user", "is-enabled", "--quiet", unitName())[0] === 0 ? "enabled" : "not installed";
}

export function serviceText(): string {
  const name = AS.platform() === "mac" ? "LaunchAgent " + agentLabel() : "systemd user unit " + unitName();
  return { enabled: `installed (${name}, enabled)`,
    "not installed": `not installed (${name}); \`factory heartbeat install\` adds it`,
    unknown: `cannot tell (${name}): no usable ` + (AS.platform() === "mac" ? "launchctl" : "systemctl --user") }[serviceState()];
}

function writeUnit(top: string): string {
  const path = unitFile();
  const lines = ["[Unit]", `Description=${repoKey()}: software factory heartbeat (what each agent is really doing)`,
    "After=network-online.target", "",
    "[Service]", "Type=simple",
    `WorkingDirectory=${top.replace(/%/g, "%%")}`,
    `ExecStart=/bin/bash ${AS.sdQuote(join(top, "factory"))} heartbeat run`,
    "Restart=always", "RestartSec=10",
    AS.sdEnv("PATH", AS.servicePath()), "",
    "[Install]", "WantedBy=default.target", ""];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", lines.join("\n"));
  renameSync(path + ".tmp", path);
  return path;
}

function writePlist(top: string): string {
  const path = plistFile();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(stateDir(), { recursive: true });
  const log = join(stateDir(), "heartbeat.log");
  const data = { Label: agentLabel(), ProgramArguments: [join(top, "factory"), "heartbeat", "run"], WorkingDirectory: top,
    EnvironmentVariables: { PATH: AS.servicePath() }, RunAtLoad: true, KeepAlive: true, StandardOutPath: log,
    StandardErrorPath: log };
  writeFileSync(path + ".tmp", plistDumps(data));
  if (AS.run("plutil", "-lint", path + ".tmp")[0] !== 0) {
    unlinkSync(path + ".tmp");
    throw new ServiceError("bad-plist", "The LaunchAgent file did not pass plutil -lint.", "Report this as a bug; nothing was installed.");
  }
  renameSync(path + ".tmp", path);
  return path;
}

/** Throws a ServiceError when the service cannot be installed here. */
function checkTools(): void {
  if (AS.platform() === "mac") {
    for (const tool of ["launchctl", "plutil"]) {
      if (!which(tool)) {
        throw new ServiceError("no-launchctl", `${tool} was not found, so the LaunchAgent cannot be installed.`,
          "Run this on the Mac itself, or set FACTORY_AUTOSTART_PLATFORM=linux for a systemd machine.");
      }
    }
  } else if (!which("systemctl")) {
    throw new ServiceError("no-systemd", "systemctl was not found, so the service cannot be installed.",
      "This needs systemd. On another init system, run `factory heartbeat run` from your own service manager.");
  } else if (!AS.userManagerOk()) {
    const user = AS.getuser();
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    throw new ServiceError("no-user-manager", `systemd's user manager for ${user} is not reachable (\`systemctl --user\` ` +
      "cannot connect to its bus), so the service cannot be installed. Nothing was changed.",
    `Log in as ${user} directly (ssh ${user}@<host>, or \`machinectl shell ${user}@\`), or run ` +
      `\`sudo loginctl enable-linger ${user}\` and \`export XDG_RUNTIME_DIR=/run/user/${uid}\` ` +
      "here, and try again.");
  }
}

/** Installs and starts the service. Returns the lines to tell the person; throws a ServiceError. */
export function install(top: string): string[] {
  checkTools();
  const out: string[] = [];
  if (AS.platform() === "mac") {
    const path = writePlist(top);
    AS.run("launchctl", "bootout", `${AS.domain()}/${agentLabel()}`);
    const [rc, , err] = AS.run("launchctl", "bootstrap", AS.domain(), path);
    if (rc !== 0) {
      throw new ServiceError("launchctl-failed", `launchctl could not load ${path}: ${err.slice(0, 200)}`,
        "Log in to the Mac's desktop session as this user, then run `factory heartbeat install` again.");
    }
    out.push(`Installed ${path}: the heartbeat daemon runs while you are logged in, and launchd restarts it if it stops.`);
  } else {
    const path = writeUnit(top);
    AS.run("systemctl", "--user", "daemon-reload");
    const [rc, , err] = AS.run("systemctl", "--user", "enable", "--now", unitName());
    if (rc !== 0) {
      throw new ServiceError("systemctl-failed", `systemctl could not start ${unitName()}: ${err.slice(0, 200)}`,
        "Check `systemctl --user status " + unitName() + "`, then run `factory heartbeat install` again.");
    }
    out.push(`Installed ${path} and started ${unitName()}: it runs from boot and restarts if it stops.`);
    const user = AS.getuser();
    if (!AS.lingerOn()) AS.run("loginctl", "enable-linger", user);
    if (!AS.lingerOn()) {
      out.push(`Note: linger is off for ${user}, so the service does not start at boot (only after you log in).\n` +
        `  Turn it on once: sudo loginctl enable-linger ${user}`);
    }
  }
  out.push("Check it with `factory heartbeat status`; `factory agents ls` shows what it sees.");
  return out;
}

/** Why a setup path leaves the service alone, or null: FACTORY_SETUP_HEARTBEAT=off (the factory's own tests set it, so
 *  they never touch this machine's services), or an agent session (agents can't install or stop it). */
export function setupSkipped(): string | null {
  if (process.env.FACTORY_SETUP_HEARTBEAT === "off") return "left alone (FACTORY_SETUP_HEARTBEAT=off)";
  if (process.env.FACTORY_AGENT || process.env.FACTORY_LOOP) return "left alone: this is an agent session; the owner runs `factory heartbeat install`";
  return null;
}

/** Makes sure the service is installed and the daemon runs, for the setup paths (`factory init`, `factory owner start`,
 *  the web UI's add-project steps); safe to run twice. `running`: the daemon wrote its state file lately. Returns the
 *  lines to tell the person; throws a ServiceError. */
export function ensure(top: string, running: boolean): string[] {
  const mac = AS.platform() === "mac";
  const name = mac ? agentLabel() : unitName();
  if (serviceState() !== "enabled") return install(top);
  if (running) return [`The heartbeat daemon already runs (${name}).`];
  const [rc, , err] = mac ? AS.run("launchctl", "kickstart", `${AS.domain()}/${agentLabel()}`)
    : AS.run("systemctl", "--user", "start", unitName());
  if (rc !== 0) {
    throw new ServiceError("start-failed", `${name} is installed but could not be started: ${err.slice(0, 200)}`,
      "Run `factory heartbeat install` to write the service again and start it.");
  }
  return [`Started ${name}: the heartbeat daemon was installed but not running.`];
}

/** ensure(), for a setup path: lines prefixed `heartbeat: `, and a failure told with its fix, never thrown. */
export function ensureLines(running: boolean): string[] {
  const skipped = setupSkipped();
  if (skipped) return [`heartbeat: ${skipped}`];
  try {
    return ensure(mainTop(), running).map((l) => `heartbeat: ${l}`);
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    return [`heartbeat: NOT running (${e.code}): ${e.message}`, `  Fix: ${e.fix}`,
      "  Until then `factory agents ls` works out each agent's state when asked."];
  }
}

/** `factory heartbeat ensure`: what the web UI's add-project step runs. Refuses with {code, message, fix} on a failure. */
export function ensureCli(running: boolean): void {
  const skipped = setupSkipped();
  if (skipped) {
    console.log(`The heartbeat daemon was ${skipped}.`);
    return;
  }
  const top = topOfProject();
  try {
    for (const line of ensure(top, running)) console.log(line);
  } catch (e) {
    refuseWith(e);
  }
}

/** Restarts the installed service so a daemon started before an update runs the new code. Returns the lines to
 * tell the person: none when no service is installed here. Throws a ServiceError. */
export function restart(): string[] {
  if (serviceState() !== "enabled") return [];
  let rc: number;
  let err: string;
  let name: string;
  if (AS.platform() === "mac") {
    [rc, , err] = AS.run("launchctl", "kickstart", "-k", `${AS.domain()}/${agentLabel()}`);
    name = agentLabel();
  } else {
    [rc, , err] = AS.run("systemctl", "--user", "restart", unitName());
    name = unitName();
  }
  if (rc !== 0) {
    throw new ServiceError("restart-failed", `could not restart ${name}: ${err.slice(0, 200)}`,
      "Run `factory heartbeat install` to write the service again and start it.");
  }
  return [`Restarted ${name}: it runs the files now on disk.`];
}

/** Stops and removes the service (a no-op when it is not installed). Throws a ServiceError. */
export function uninstall(): void {
  if (AS.platform() === "mac") {
    if (existsSync(plistFile()) || serviceState() === "enabled") AS.run("launchctl", "bootout", `${AS.domain()}/${agentLabel()}`);
    if (existsSync(plistFile())) unlinkSync(plistFile());
  } else if (existsSync(unitFile()) || serviceState() === "enabled") {
    if (!AS.userManagerOk()) {
      throw new ServiceError("no-user-manager", "systemd's user manager is not reachable, so the service cannot be removed.",
        `Log in as ${AS.getuser()} directly, then run \`factory heartbeat uninstall\` again.`);
    }
    AS.run("systemctl", "--user", "disable", "--now", unitName());
    if (existsSync(unitFile())) unlinkSync(unitFile());
    AS.run("systemctl", "--user", "daemon-reload");
  }
}

function topOfProject(): string {
  const top = mainTop();
  process.chdir(top);
  return top;
}

function refuseWith(e: unknown): never {
  if (e instanceof ServiceError) refuse(e.code, e.message, e.fix);
  throw e;
}

export function installCli(): void {
  const top = topOfProject();
  try {
    for (const line of install(top)) console.log(line);
  } catch (e) {
    refuseWith(e);
  }
}

export function restartCli(): void {
  try {
    for (const line of restart()) console.log(line);
  } catch (e) {
    refuseWith(e);
  }
}

export function uninstallCli(): void {
  topOfProject();
  try {
    uninstall();
  } catch (e) {
    refuseWith(e);
  }
  console.log("The heartbeat service is removed. Running agents were not stopped; they are just not watched any more, so " +
    "pings and `silent` work as before.");
}

/** [[level, what, how]] for `factory doctor`. In issues mode and with the message board, where agents report their
 *  state; not with a plan file. */
export function doctor(cfg: Config): AS.DoctorLine[] {
  if (taskSource(cfg) !== "issues" && taskSource(cfg) !== "board") return [];
  const state = serviceState();
  const name = AS.platform() === "mac" ? `LaunchAgent ${agentLabel()}` : `systemd user unit ${unitName()}`;
  if (state === "enabled") return [["ok", "heartbeat daemon", `installed (${name})`]];
  const why = state === "unknown" ? `can't tell whether ${name} is installed here (no usable systemctl --user or launchctl)`
    : `${name} is not installed`;
  return [["note", "heartbeat daemon", `${why}: an agent waiting in \`factory wait\` then looks silent, and a crashed one ` +
    "keeps saying working for 30 minutes. Fix: run `factory heartbeat install` (or `factory autostart install`)."]];
}

function main(argv: string[]): void {
  const cmd = argv[0] ?? "";
  if (cmd === "install") installCli();
  else if (cmd === "uninstall") uninstallCli();
  else if (cmd === "restart") restartCli();
  else refuse("unknown-command", "unknown command.", "Use install, uninstall or restart (or `factory heartbeat ...`).");
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
