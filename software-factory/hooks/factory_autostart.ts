#!/usr/bin/env -S bun --no-env-file
// `factory autostart`: make this machine bring the factory back after every boot (#88).
//
//   factory autostart status                        what is set up here and what would start; read-only
//   factory autostart install [--agents a,b] [--no-heartbeat]
//                                                   turn it on for this machine and install the boot service:
//                                                   a systemd user unit (with linger) on Linux, a LaunchAgent on macOS.
//                                                   It also installs the heartbeat daemon (factory_heartbeat_service.ts,
//                                                   #108), which tells GitHub what each agent is really doing
//   factory autostart uninstall                     remove the services and turn it off; running agents keep running
//
// At boot the service runs `factory resume` (factory_resume.ts): it waits for Docker and the network, runs
// `commands.stackUp`, saves any unfinished work of this machine's agents, and starts them in detached tmux sessions
// with the settings and hooks loaded. Opt-in per machine: the names, "autostart", "autostartAgents" and "autostartReport"
// live in this machine's file (`factory machine show` prints where), never in the project. Errors are
// `{code, message, fix}` on stderr.
//
// The service is named <repo>-factory-resume.service (Linux) or dev.software-factory.<repo>-resume (macOS), where <repo>
// is the folder name of the main clone, so projects on one machine do not collide.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { type Config, load } from "./factory_config.ts";
import * as heartbeat from "./factory_heartbeat_service.ts";
import { autostartSettings, checkedNames, namesFile, refuse, repoKey, saveMachineSettings, stateDir } from "./factory_machine.ts";
import { agentPath, inspect, mainTop, SETTINGS_FIX, sessionName } from "./factory_resume.ts";
import { plistDumps, pyRepr, run as runProc, runMain, splitLines, which } from "./factory_lib.ts";

export function platform(): "mac" | "linux" {
  const given = process.env.FACTORY_AUTOSTART_PLATFORM || process.env.FACTORY_CI_PLATFORM;
  if (given === "mac" || given === "linux") return given;
  return process.platform === "darwin" || which("launchctl") ? "mac" : "linux";
}

/** [exit code, stdout, stderr] of a command, both stripped; never throws. */
export function run(...a: string[]): [number, string, string] {
  const p = runProc(a, { timeoutMs: 60_000 });
  if (p.timedOut) return [1, "", `Command '${JSON.stringify(a)}' timed out after 60 seconds`];
  return [p.code, p.stdout.trim(), p.stderr.trim()];
}

export function getuser(): string {
  return process.env.LOGNAME || process.env.USER || process.env.LNAME || process.env.USERNAME || userInfo().username;
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

export function unitName(): string {
  return `${repoKey()}-factory-resume.service`;
}

export function agentLabel(): string {
  return `dev.software-factory.${repoKey()}-resume`;
}

export function unitFile(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "systemd", "user", unitName());
}

function plistFile(): string {
  return join(homedir(), "Library", "LaunchAgents", agentLabel() + ".plist");
}

export function domain(): string {
  return `gui/${uid()}`;
}

/** A PATH for the boot service: the folders of the tools the agents use, then the usual system ones. A service
 * starts with a short PATH, and `claude`, `gh`, `tmux` and `docker` are often in the user's own folders. */
export function servicePath(): string {
  const dirs: string[] = [];
  for (const tool of ["tmux", "claude", "gh", "docker", "git", "node", "pnpm", "bun", "sops"]) {
    const found = which(tool);
    const d = found ? dirname(found) : "";
    if (d.startsWith("/") && !dirs.includes(d)) dirs.push(d);
  }
  const extra = platform() === "mac" ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] :
    ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
  return [...dirs, ...extra.filter((d) => !dirs.includes(d))].join(":");
}

/** The rootless Docker socket when this user has one (a service does not inherit DOCKER_HOST). */
function dockerHost(): string {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  const sock = join(process.env.XDG_RUNTIME_DIR || `/run/user/${uid()}`, "docker.sock");
  return existsSync(sock) ? `unix://${sock}` : "";
}

export function userManagerOk(): boolean {
  return which("systemctl") !== null && run("systemctl", "--user", "show-environment")[0] === 0;
}

/** 'enabled' | 'not installed' | 'unknown' (can't ask: no systemctl or no user manager). */
function serviceState(): "enabled" | "not installed" | "unknown" {
  if (platform() === "mac") {
    if (!which("launchctl")) return "unknown";
    return run("launchctl", "print", `${domain()}/${agentLabel()}`)[0] === 0 ? "enabled" : "not installed";
  }
  if (!userManagerOk()) return "unknown";
  return run("systemctl", "--user", "is-enabled", "--quiet", unitName())[0] === 0 ? "enabled" : "not installed";
}

export function lingerOn(): boolean {
  return run("loginctl", "show-user", getuser(), "-p", "Linger", "--value")[1] === "yes";
}

/** A systemd command-line word: quoted, with \ and " escaped and % and $ doubled. */
export function sdQuote(value: string): string {
  const v = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return `"${v}"`;
}

export function sdEnv(key: string, value: string): string {
  const v = `${key}=${value}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `Environment="${v}"`;
}

function writeUnit(top: string): string {
  const path = unitFile();
  const lines = ["[Unit]",
    `Description=${repoKey()}: bring the software factory back after a reboot (factory resume)`,
    "After=docker.service", "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "# The agents run in tmux sessions started by this job: stopping or finishing it must not kill them.",
    "KillMode=process",
    "# Waiting for Docker, the network and the stack can take a while.",
    "TimeoutStartSec=infinity",
    `WorkingDirectory=${top.replace(/%/g, "%%")}`,
    `ExecStart=/bin/bash ${sdQuote(join(top, "factory"))} resume`,
    sdEnv("PATH", servicePath())];
  if (dockerHost()) lines.push(sdEnv("DOCKER_HOST", dockerHost()));
  lines.push("", "[Install]", "WantedBy=default.target", "");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", lines.join("\n"));
  renameSync(path + ".tmp", path);
  return path;
}

function writePlist(top: string): string {
  const path = plistFile();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(stateDir(), { recursive: true });
  const data = { Label: agentLabel(), ProgramArguments: [join(top, "factory"), "resume"], WorkingDirectory: top,
    EnvironmentVariables: { PATH: servicePath() }, RunAtLoad: true,
    AbandonProcessGroup: true, // the tmux sessions must outlive this job
    StandardOutPath: join(stateDir(), "launchd.log"), StandardErrorPath: join(stateDir(), "launchd.log") };
  writeFileSync(path + ".tmp", plistDumps(data));
  if (run("plutil", "-lint", path + ".tmp")[0] !== 0) {
    unlinkSync(path + ".tmp");
    refuse("bad-plist", "The LaunchAgent file did not pass plutil -lint.", "Report this as a bug; nothing was installed.");
  }
  renameSync(path + ".tmp", path);
  return path;
}

function needTools(): void {
  if (!which("tmux")) {
    refuse("no-tmux", "tmux is not installed, and the agents are started in detached tmux sessions.",
      "Install tmux (for example `sudo apt install tmux` or `brew install tmux`), then run `factory autostart install` again.");
  }
  if (platform() === "mac") {
    for (const tool of ["launchctl", "plutil"]) {
      if (!which(tool)) {
        refuse("no-launchctl", `${tool} was not found, so the LaunchAgent cannot be installed.`,
          "Run this on the Mac itself, or set FACTORY_AUTOSTART_PLATFORM=linux for a systemd machine.");
      }
    }
  } else {
    if (!which("systemctl")) {
      refuse("no-systemd", "systemctl was not found, so the boot service cannot be installed.",
        "This needs systemd. On another init system, run `factory resume` from your own boot script.");
    }
    if (!userManagerOk()) {
      const user = getuser();
      refuse("no-user-manager", `systemd's user manager for ${user} is not reachable (\`systemctl --user\` cannot ` +
        "connect to its bus), so the service cannot be installed. Nothing was changed.",
      `Log in as ${user} directly (ssh ${user}@<host>, or \`machinectl shell ${user}@\`), or run ` +
        `\`sudo loginctl enable-linger ${user}\` and \`export XDG_RUNTIME_DIR=/run/user/${uid()}\` here, ` +
        "and try again.");
    }
  }
}

function install(args: string[], cfg: Config, top: string): void {
  needTools();
  let given: string | null = null;
  const i = args.indexOf("--agents");
  if (i >= 0) given = args[i + 1] ?? "";
  const [, currentNames] = autostartSettings();
  const names = checkedNames(cfg, given !== null ? given : currentNames.join(","), "factory autostart install --agents");
  saveMachineSettings({ autostart: true, autostartAgents: names });
  if (platform() === "mac") {
    const path = writePlist(top);
    run("launchctl", "bootout", `${domain()}/${agentLabel()}`);
    const [rc, , err] = run("launchctl", "bootstrap", domain(), path);
    if (rc !== 0) {
      refuse("launchctl-failed", `launchctl could not load ${path}: ${err.slice(0, 200)}`,
        "Log in to the Mac's desktop session as this user, then run `factory autostart install` again.");
    }
    console.log(`Installed ${path}. It runs \`factory resume\` each time you log in (launchd runs it once now, too; ` +
      "agents that are already running are left alone).");
    console.log("A LaunchAgent starts at login, not at power-on: turn on automatic login for this user, or keep the " +
      "Mac logged in, if it must come back by itself.");
  } else {
    const path = writeUnit(top);
    run("systemctl", "--user", "daemon-reload");
    const [rc, , err] = run("systemctl", "--user", "enable", unitName());
    if (rc !== 0) {
      refuse("systemctl-failed", `systemctl could not enable ${unitName()}: ${err.slice(0, 200)}`,
        "Check `systemctl --user status`, then run `factory autostart install` again.");
    }
    console.log(`Installed ${path} and enabled ${unitName()}. It runs \`factory resume\` at every boot.`);
    const user = getuser();
    if (!lingerOn()) run("loginctl", "enable-linger", user);
    if (!lingerOn()) {
      console.log(`Note: linger is off for ${user}, so the service does not start at boot (only after you log in).\n` +
        `  Turn it on once: sudo loginctl enable-linger ${user}`);
    }
  }
  console.log(`This machine starts: ${names.join(", ")}. Change the names with \`factory autostart install --agents a,b\`.`);
  console.log("Check it with `factory autostart status`; bring everything up now, without a reboot, with `factory resume`.");
  if (args.includes("--no-heartbeat")) {
    console.log("The heartbeat daemon was not installed (--no-heartbeat): add it with `factory heartbeat install`.");
  } else installHeartbeat(top);
}

/** The heartbeat daemon next to the boot service. A failure here is told, not fatal: the boot service is in. */
function installHeartbeat(top: string): void {
  try {
    for (const line of heartbeat.install(top)) console.log("heartbeat: " + line);
  } catch (e) {
    if (!(e instanceof heartbeat.ServiceError)) throw e;
    console.log(`heartbeat: NOT installed (${e.code}): ${e.message}\n  Fix: ${e.fix}\n  Then: factory heartbeat install`);
  }
}

function uninstallHeartbeat(): void {
  try {
    heartbeat.uninstall();
  } catch (e) {
    if (!(e instanceof heartbeat.ServiceError)) throw e;
    console.log(`heartbeat: could not remove it: ${e.message}\n  Fix: ${e.fix}`);
  }
}

function uninstall(): void {
  uninstallHeartbeat();
  if (platform() === "mac") {
    if (existsSync(plistFile()) || serviceState() === "enabled") run("launchctl", "bootout", `${domain()}/${agentLabel()}`);
    if (existsSync(plistFile())) unlinkSync(plistFile());
  } else if (existsSync(unitFile()) || serviceState() === "enabled") {
    if (!userManagerOk()) {
      refuse("no-user-manager", "systemd's user manager is not reachable, so the service cannot be removed.",
        `Log in as ${getuser()} directly, then run \`factory autostart uninstall\` again.`);
    }
    run("systemctl", "--user", "disable", "--now", unitName());
    if (existsSync(unitFile())) unlinkSync(unitFile());
    run("systemctl", "--user", "daemon-reload");
  }
  saveMachineSettings({ autostart: false });
  console.log("Autostart is off on this machine and the boot service is removed. Running agents and the stack were not " +
    "stopped. The names stay in the machine file, so `factory autostart install` brings it back.");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}

function describe(cfg: Config, top: string, agent: string): void {
  const path = agentPath(cfg, top, agent);
  const info = inspect(path);
  const where = isDir(path) ? path : `${path} (made at boot)`;
  const work: string[] = [];
  if (info.branch) work.push(`on ${info.branch}`);
  if (info.changes.length) work.push(plural(info.changes.length, "uncommitted file"));
  if (info.unpushed.length) work.push(plural(info.unpushed.length, "unpushed commit"));
  const running = which("tmux") ? runProc(["tmux", "has-session", "-t", `=${sessionName(agent)}`]).code === 0 : false;
  console.log(`  ${agent}: ${where}`);
  console.log(`    ${work.length ? work.join(", ") : "clean, nothing to protect"}` +
    (info.changes.length || info.unpushed.length ? " -> a backup is saved first, then it resumes in place" : ""));
  const kitOk = existsSync(join(path, ".claude", "factory", "settings.json")) || !isDir(path);
  if (!kitOk) console.log(`    .claude/factory/settings.json does not resolve here: it would NOT start (${SETTINGS_FIX})`);
  console.log(`    session ${sessionName(agent)}: ${running ? "running, left alone" : "not running, would start"}`);
}

function status(cfg: Config, top: string): void {
  const [on, agents, post] = autostartSettings();
  const state = serviceState();
  console.log(`autostart: ${on ? "on" : "off"}   (this machine's file: ${namesFile()})`);
  if (!on) {
    console.log("  Turn it on for this machine: factory autostart install --agents " +
      (((cfg.agents || []) as string[]).slice(0, 2).join(",") || "<names>"));
  }
  const service = platform() === "linux" ? "systemd user unit " + unitName() : "LaunchAgent " + agentLabel();
  console.log("service: " + { enabled: `installed (${service}, enabled)`,
    "not installed": `not installed (${service}); \`factory autostart install\` adds it`,
    unknown: `cannot tell (${service}): no usable ` + (platform() === "mac" ? "launchctl" : "systemctl --user") }[state]);
  if (platform() === "linux") {
    console.log("linger: " + (lingerOn() ? "on" : "off (the service would not start at boot: " +
      `sudo loginctl enable-linger ${getuser()})`));
  }
  console.log("tmux: " + (which("tmux") ? "found" : "NOT found (install it; agents run in tmux sessions)"));
  const cmds = (cfg.commands || {}) as Record<string, string>;
  const up = cmds.stackUp || "";
  const health = cmds.stackHealth || "";
  console.log("stack: " + (up ? `\`${up}\`` + (health ? `, healthy when \`${health}\` passes` : "") :
    "no commands.stackUp is set, so no stack is started (`factory settings set commands.stackUp ...`)"));
  const beat = heartbeat.serviceState();
  console.log("heartbeat: " + { enabled: "installed (tells GitHub what each agent is really doing; `factory heartbeat status`)",
    "not installed": "not installed (`factory heartbeat install` adds it; `factory autostart install` does too)",
    unknown: "cannot tell (no usable systemctl --user or launchctl)" }[beat]);
  console.log(`boot report on the agent's issue: ${post ? "yes" : "no"} (issues mode only)`);
  console.log(`agents it would start${on ? "" : " once it is on"}: ${agents.length ? agents.join(", ") : "none"}`);
  for (const agent of agents) describe(cfg, top, agent);
  let last: string[];
  try {
    last = splitLines(readFileSync(join(stateDir(), "boot.log"), "utf8"));
  } catch {
    last = [];
  }
  const starts = last.map((l, i) => (l.includes(" resume: ") && l.includes("autostart on") ? i : -1)).filter((i) => i >= 0);
  if (starts.length) {
    console.log(`last boot (${join(stateDir(), "boot.log")}):`);
    for (const l of last.slice(starts[starts.length - 1]).slice(0, 20)) console.log("  " + l);
  } else console.log("last boot: none yet");
}

export type DoctorLine = [level: "ok" | "fix" | "note", what: string, how: string];

/** [[level, what, how]] for `factory doctor`: level is ok, fix or note. */
export function doctor(cfg: Config): DoctorLine[] {
  const [on, agents] = autostartSettings();
  if (!on) {
    return [["note", "autostart", "off on this machine: after a reboot the stack and the agents do not come back. " +
      "Run `factory autostart install --agents <names>` (see `factory autostart status`)."]];
  }
  const out: DoctorLine[] = [];
  const known = (cfg.agents || []) as string[];
  const unknown = agents.filter((n) => !known.includes(n));
  if (!agents.length) {
    out.push(["fix", "autostart agents", "autostart is on but no agent names are set: run " +
      "`factory autostart install --agents <names>`"]);
  } else if (unknown.length) {
    out.push(["fix", "autostart agents", `${unknown.join(", ")} aren't in \`agents\` in .claude/factory.json ` +
      `(${known.join(", ")}): run \`factory autostart install --agents <names>\``]);
  } else out.push(["ok", "autostart agents", agents.join(", ")]);
  out.push(which("tmux") ? ["ok", "tmux", ""] : ["fix", "tmux", "autostart starts agents in tmux sessions: install tmux"]);
  if (serviceState() === "enabled") out.push(["ok", "autostart service", "installed"]);
  else {
    out.push(["fix", "autostart service", "autostart is on but nothing runs `factory resume` at boot: run " +
      "`factory autostart install`"]);
  }
  if (platform() === "linux" && which("loginctl") && !lingerOn()) {
    out.push(["fix", "linger", `off, so the service does not start at boot: sudo loginctl enable-linger ${getuser()}`]);
  }
  if (!((cfg.commands || {}) as Record<string, string>).stackUp) {
    out.push(["note", "commands.stackUp", "not set, so the dev stack is not started at boot " +
      "(`factory settings set commands.stackUp 'pnpm stack:up'`)"]);
  }
  return out;
}

function main(argv: string[]): void {
  const cmd = argv[0] ?? "status";
  const top = mainTop();
  process.chdir(top);
  const cfg = load();
  if (cmd === "status") status(cfg, top);
  else if (cmd === "install") install(argv.slice(1), cfg, top);
  else if (cmd === "uninstall") uninstall();
  else refuse("unknown-command", `unknown command ${pyRepr(cmd)}.`, "Use status, install [--agents a,b] or uninstall.");
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
