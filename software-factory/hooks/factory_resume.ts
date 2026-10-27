#!/usr/bin/env -S bun --no-env-file
// `factory resume`: what a machine does after a reboot (#88). `factory autostart install` runs it at every boot.
//
//   factory resume              wait for Docker and the network, run `commands.stackUp`, then start this machine's
//                               agents (autostartAgents) in detached tmux sessions, each in its own worktree
//   factory resume --dry-run    say what it would do, change nothing
//   factory resume --force      run although autostart is off on this machine
//
// Unfinished work is never touched. Before an agent starts, a worktree with uncommitted changes or unpushed commits is
// saved to <state>/backups/<agent>-<branch>-<time>/ (changes.patch, status.txt, unpushed.txt, untracked/), nothing is
// reset or cleaned, and the agent's first prompt says it is resuming after an unexpected restart (branch, files,
// backup path). An agent starts only when its worktree's settings resolve, so its hooks and deny rules are on (#46).
// Agents already running are left alone, so running it by hand is safe.
//
// The boot report is one line per component in <state>/boot.log (`$XDG_STATE_HOME/<repo>-factory`, else
// `~/.local/state/<repo>-factory`) and, in issues mode, a comment on the first started agent's issue unless the
// machine file says "autostartReport": false. A GitHub failure is only a line in the log.
//
// Settings: `commands.stackUp` and `commands.stackHealth` in .claude/factory.json; the machine's own "autostart",
// "autostartAgents" and "autostartReport" (factory_machine.ts); variables in <config>/<repo>.env reach the agents.
// FACTORY_RESUME_WAIT (seconds, default 300) is how long it waits for Docker, the network and the stack's health;
// FACTORY_RESUME_POLL (seconds, default 5) how often it asks.
// Exit 1 when anything could not be started.
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, utimesSync,
  writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentName, agentSlot, type Config, load, taskLabels, taskSource, toFloat } from "./factory_config.ts";
import { findIssue } from "./factory_agents.ts";
import { comment, taskIssues } from "./factory_issues.ts";
import { autostartSettings, configDir, machineId, repoKey, stateDir } from "./factory_machine.ts";
import { bunCmd, Exit, type RunResult, run as runProc, runMain, shQuote, sleepSync, splitLines, which } from "./factory_lib.ts";

const HOOKS = import.meta.dir;
export const SETTINGS_FIX = "run `git submodule update --init` there, or `bash vendor/my-skills/software-factory/install.sh . " +
  "--link`, then `factory resume`";

function number(name: string, dflt: string): number {
  return toFloat(process.env[name] ?? dflt) ?? Number(dflt);
}

export function mainTop(): string {
  const p = runProc(["git", "rev-parse", "--git-common-dir"]);
  if (p.code !== 0) {
    process.stderr.write("factory resume: run it inside the project's git repo.\n");
    throw new Exit(1);
  }
  return dirname(resolve(p.stdout.trim()));
}

export function sessionName(agent: string): string {
  return `${repoKey()}-${agent}`.replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** Where agent `agent` works: the project folder for the first name, else <project>-agents/<name>. */
export function agentPath(cfg: Config, top: string, agent: string): string {
  const slot = agentSlot(cfg, agent);
  return slot === 1 ? top : join(top + "-agents", agentName(cfg, slot || 0));
}

function git(path: string, ...a: string[]): string {
  const p = runProc(["git", "-C", path, ...a]);
  return p.code === 0 ? p.stdout : "";
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface WorkInfo {
  branch: string;
  changes: string[];
  unpushed: string[];
}

/** What a worktree holds: {branch: "" when detached, changes: status lines, unpushed: commit lines}. */
export function inspect(path: string): WorkInfo {
  if (!isDir(path)) return { branch: "", changes: [], unpushed: [] };
  return { branch: git(path, "branch", "--show-current").trim(),
    changes: splitLines(git(path, "status", "--porcelain")).filter((l) => l.trim()),
    unpushed: splitLines(git(path, "log", "--branches", "--not", "--remotes", "--format=%h %s")).filter((l) => l.trim()) };
}

/** Saves a worktree's unfinished work outside it and returns the folder. Reads the worktree, never writes to it. */
function backup(agent: string, path: string, info: WorkInfo, stamp: string): string {
  const branch = (info.branch || "detached").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "detached";
  const base = join(stateDir(), "backups", `${agent}-${branch}-${stamp}`);
  let dest = base;
  for (let n = 1; existsSync(dest);) dest = `${base}-${++n}`;
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "changes.patch"), git(path, "diff", "HEAD", "--binary"));
  writeFileSync(join(dest, "status.txt"), git(path, "status", "--short", "--branch") + "\n" + git(path, "status"));
  writeFileSync(join(dest, "unpushed.txt"), info.unpushed.join("\n") + (info.unpushed.length ? "\n" : ""));
  let copied = 0;
  for (const rel of git(path, "ls-files", "--others", "--exclude-standard", "-z").split("\0")) {
    const src = join(path, rel);
    if (!rel || copied >= 200) continue;
    let st;
    try {
      if (lstatSync(src).isSymbolicLink()) continue;
      st = statSync(src);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > 1 << 20) continue; // small regular files only; the list is in status.txt either way
    const to = join(dest, "untracked", rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(src, to);
    utimesSync(to, st.atime, st.mtime);
    copied++;
  }
  return dest;
}

function s(n: number, word: string): string {
  return `${word}${n !== 1 ? "s" : ""}`;
}

function noteText(agent: string, path: string, info: WorkInfo, backupDir: string, when: string): string {
  const files = info.changes.map((l) => (l.length > 3 ? l.slice(3) : l));
  const shown = files.slice(0, 20).map((f) => `  - ${f}`).join("\n") + (files.length > 20 ? `\n  - ... and ${files.length - 20} more` : "");
  const where = info.branch ? `on branch \`${info.branch}\`` : "on a detached HEAD";
  const lines = [`You are resuming after an unexpected restart of this machine (${when}). You are ${agent}; your worktree is ` +
    `${path}, ${where}.`];
  if (files.length) lines.push(`${files.length} ${s(files.length, "file")} had uncommitted changes, and they are still there:\n${shown}`);
  if (info.unpushed.length) {
    lines.push(`${info.unpushed.length} ${s(info.unpushed.length, "commit")} had not been pushed:\n` +
      info.unpushed.slice(0, 10).map((l) => `  - ${l}`).join("\n"));
  }
  if (backupDir) {
    lines.push(`A backup of that work is in ${backupDir} (changes.patch, status.txt, unpushed.txt, untracked/). ` +
      "Nothing was reset or cleaned.");
  }
  lines.push("Continue your own in-progress issue or pull request on this branch first, and do not claim new work " +
    "until it is done. Run `git status` and read the changes before you edit anything. If the work does " +
    "not match any issue of yours, say so in your first message instead of discarding it.");
  return lines.join("\n\n") + "\n";
}

/** KEY=value lines (# comments, optional quotes) -> an object. */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/(?<=\n)/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) {
      const v = m[2] as string;
      out[m[1] as string] = v.length > 1 && v[0] === v[v.length - 1] && `"'`.includes(v[0] as string) ? v.slice(1, -1) : v;
    }
  }
  return out;
}

function localStamp(withSeconds: boolean, compact: boolean): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const date = compact ? `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = compact ? `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` :
    `${p(d.getHours())}:${p(d.getMinutes())}` + (withSeconds ? `:${p(d.getSeconds())}` : "");
  return compact ? `${date}-${time}` : `${date} ${time}`;
}

/** One line per component: printed, and appended to the boot log (unless it is a dry run). */
class Report {
  lines: string[] = [];
  failed = 0;
  constructor(readonly logPath: string, readonly dry: boolean) {}

  add(line: string, failed = false): void {
    if (failed) this.failed++;
    this.lines.push(line);
    console.log(line);
    if (!this.dry) {
      try {
        mkdirSync(dirname(this.logPath), { recursive: true });
        appendFileSync(this.logPath, `${localStamp(true, false)} ${line}\n`);
      } catch {
        // the log is best effort
      }
    }
  }
}

/** True as soon as check() is true, polling until `seconds` have passed (always at least one try). */
function waitUntil(check: () => boolean, seconds: number, poll: number): boolean {
  const end = Date.now() / 1000 + seconds;
  for (;;) {
    if (check()) return true;
    if (Date.now() / 1000 >= end) return false;
    sleepSync(Math.min(poll, Math.max(end - Date.now() / 1000, 0.01)));
  }
}

/** A command (a list, or a string for the shell) in `cwd`, with a timeout in seconds. */
function run(cmd: string[] | string, cwd: string, timeout: number, env?: Record<string, string | undefined>): RunResult {
  const argv = typeof cmd === "string" ? ["/bin/sh", "-c", cmd] : cmd;
  const p = runProc(argv, { cwd, env, timeoutMs: timeout * 1000 });
  if (p.timedOut) return { code: 124, stdout: "", stderr: `timed out after ${Math.trunc(timeout)} s`, timedOut: true };
  return p;
}

function lastLine(text: string | null | undefined, fallback = ""): string {
  const lines = splitLines((text || "").trim()).map((l) => l.trim()).filter((l) => l);
  return lines.length ? (lines[lines.length - 1] as string).slice(0, 200) : fallback;
}

function startStack(cfg: Config, top: string, report: Report, wait: number, poll: number, dry: boolean): void {
  const cmds = (cfg.commands || {}) as Record<string, string>;
  const up = cmds.stackUp || "";
  const health = cmds.stackHealth || "";
  if (!up) {
    report.add("stack: no commands.stackUp is set, nothing to start");
    return;
  }
  if (dry) {
    report.add(`stack: would wait for Docker, run \`${up}\`` + (health ? ` and wait until \`${health}\` passes` : ""));
    return;
  }
  if (which("docker")) {
    const t = Date.now() / 1000;
    if (!waitUntil(() => run(["docker", "info"], top, 30).code === 0, wait, poll)) {
      report.add(`stack: NOT started: Docker did not answer within ${Math.trunc(wait)} s. Start Docker, then run ` +
        "`factory resume`.", true);
      return;
    }
    report.add(`docker: ready after ${Math.trunc(Date.now() / 1000 - t)} s`);
  }
  const p = run(up, top, number("FACTORY_RESUME_STACK_TIMEOUT", "1200"));
  if (p.code !== 0) {
    report.add(`stack: failed (exit ${p.code}): ${lastLine(p.stderr || p.stdout, "no output")}. ` +
      `Run \`${up}\` by hand to see why.`, true);
    return;
  }
  if (health && !waitUntil(() => run(health, top, 60).code === 0, wait, poll)) {
    report.add(`stack: started but \`${health}\` did not pass within ${Math.trunc(wait)} s`, true);
    return;
  }
  report.add("stack: up" + (health ? " and healthy" : ""));
}

function errText(e: unknown): string {
  if (e instanceof Exit) return e.text ?? String(e.exitCode);
  return e instanceof Error ? e.message : String(e);
}

/** Issues mode: if the agent still holds an in-progress issue, ping its agent issue as working on it, so the dev
 * manager does not hand the issue to another agent while the agent is coming back. */
function registerWorking(cfg: Config, top: string, agent: string, report: Report): void {
  if (taskSource(cfg) !== "issues") return;
  try {
    const L = taskLabels(cfg);
    const held = taskIssues("open", L.agentPrefix + agent).filter((i) => i.labels.some((x) => x.name === L.inProgress)).map((i) => i.number);
    if (!held.length) return;
    const p = runProc([...bunCmd(join(HOOKS, "factory_agents.ts")), "ping", "--agent", agent,
      "--status", `working on #${held[0]} (resumed)`], { cwd: top, timeoutMs: 120_000 });
    if (p.code !== 0) throw new Error(lastLine(p.stderr, "ping failed"));
    report.add(`agent ${agent}: registered ${agent} as working on #${held[0]}`);
  } catch (e) {
    report.add(`agent ${agent}: GitHub: could not mark ${agent} as working: ${errText(e).slice(0, 160)}`);
  }
}

/** Issues mode: the boot report as a comment on the agent's issue. Never fails the resume. */
function postReport(agent: string, report: Report, machine: string): void {
  try {
    const issue = findIssue(agent);
    if (!issue) {
      report.add(`report: ${agent} has no agent issue to post to`);
      return;
    }
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const when = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
    const body = `Boot report: this machine (machine ${machine || "unknown"}) rebooted and ran \`factory resume\` at ` +
      `${when}.\n\n` + report.lines.map((l) => `- ${l}`).join("\n");
    comment(issue.number, body);
    report.add(`report: posted to #${issue.number}`);
  } catch (e) {
    report.add(`report: GitHub: could not post the boot report: ${errText(e).slice(0, 160)}`);
  }
}

interface Ctx {
  dry: boolean;
  network: boolean;
  state: string;
  carry: Record<string, string>;
  started: string[];
  stamp: string;
  when: string;
}

function startAgent(cfg: Config, top: string, agent: string, report: Report, ctx: Ctx): void {
  const name = sessionName(agent);
  if (runProc(["tmux", "has-session", "-t", `=${name}`]).code === 0) {
    report.add(`agent ${agent}: already running (tmux session ${name}), left alone`);
    return;
  }
  let path = agentPath(cfg, top, agent);
  if (ctx.dry) {
    const info = inspect(path);
    const extra = info.changes.length || info.unpushed.length ? `; ${info.changes.length} uncommitted files and ` +
      `${info.unpushed.length} unpushed commits on ${info.branch || "a detached HEAD"} would be backed up first` : "";
    report.add(`agent ${agent}: would start tmux session ${name} in ${path}${extra}`);
    return;
  }
  if (!ctx.network) {
    report.add(`agent ${agent}: NOT started: origin is not reachable (no network, or git cannot sign in). ` +
      "Fix that, then run `factory resume`.", true);
    return;
  }
  const made = run([...bunCmd(join(HOOKS, "factory_claims.ts")), "worktree", agent], top, 300);
  if (made.code !== 0) {
    report.add(`agent ${agent}: NOT started: could not make its worktree: ${lastLine(made.stderr, "unknown error")}`, true);
    return;
  }
  path = lastLine(made.stdout) || path;
  const info = inspect(path);
  const protect = Boolean(info.changes.length || info.unpushed.length);
  let backupDir = "";
  if (protect) { // first of all, before anything else looks at the folder
    try {
      backupDir = backup(agent, path, info, ctx.stamp);
      report.add(`backup ${agent}: ${info.changes.length} changed files and ${info.unpushed.length} unpushed ` +
        `commits on ${info.branch || "a detached HEAD"} saved to ${backupDir}`);
    } catch (e) {
      report.add(`backup ${agent}: FAILED (${errText(e)}); the worktree is not touched either way`, true);
    }
  }
  // The kit's files in .claude/ are links into a submodule: without it the hooks and deny rules would not load (#46).
  if (existsSync(join(path, ".gitmodules"))) {
    const p = run(["git", "-C", path, "submodule", "update", "--init", "-q"], top, 600);
    if (p.code !== 0) {
      report.add(`agent ${agent}: NOT started: \`git submodule update --init\` failed in ${path}: ` +
        `${lastLine(p.stderr)}. ${SETTINGS_FIX}.`, true);
      return;
    }
  }
  if (!existsSync(join(path, ".claude", "settings.json"))) {
    report.add(`agent ${agent}: NOT started: ${path}/.claude/settings.json does not resolve, so the factory's hooks ` +
      `and deny rules would not load. ${SETTINGS_FIX}.`, true);
    return;
  }
  const env: Record<string, string> = { FACTORY_AGENTS: agent };
  if (protect) env.FACTORY_RESUME = "1"; // the loop leaves this folder as it is for its first task
  if (protect || info.branch) {
    mkdirSync(ctx.state, { recursive: true });
    const note = join(ctx.state, `resume-${agent}.md`);
    writeFileSync(note, noteText(agent, path, info, backupDir, ctx.when));
    env.FACTORY_RESUME_NOTE = note;
  }
  Object.assign(env, ctx.carry);
  const command = "exec env " + Object.entries(env).map(([k, v]) => shQuote(`${k}=${v}`)).join(" ") + " " +
    shQuote(join(top, "factory")) + " loop -i";
  const p = run(["tmux", "new-session", "-d", "-s", name, "-c", top, command], top, 60);
  if (p.code !== 0 || runProc(["tmux", "has-session", "-t", `=${name}`]).code !== 0) {
    report.add(`agent ${agent}: NOT started: tmux could not start the session: ${lastLine(p.stderr, "no session")}`, true);
    return;
  }
  ctx.started.push(agent);
  report.add(`agent ${agent}: started (tmux session ${name}, folder ${path})` +
    (protect ? `, resuming ${info.branch || "unfinished work"} with its changes intact` : info.branch ? `, on ${info.branch}` : ""));
  registerWorking(cfg, top, agent, report);
}

function main(argv: string[]): number {
  const dry = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const top = mainTop();
  process.chdir(top);
  const cfg = load();
  const [on, names, post] = autostartSettings();
  let agents = names;
  const report = new Report(join(stateDir(), "boot.log"), dry);
  if (!on && !force) {
    console.log("factory resume: autostart is off on this machine (factory autostart install turns it on; " +
      "--force runs it anyway).");
    return 0;
  }
  for (const [k, v] of Object.entries(readEnvFile(join(configDir(), `${repoKey()}.env`)))) if (!(k in process.env)) process.env[k] = v;
  const wait = number("FACTORY_RESUME_WAIT", "300");
  const poll = number("FACTORY_RESUME_POLL", "5");
  report.add(`resume: ${dry ? "dry run, " : ""}autostart on ${repoKey()} (machine ${machineId() || "unknown"}), ` +
    `agents: ${agents.join(", ") || "none"}`);
  if (!dry && agents.length && !which("tmux")) {
    report.add("resume: tmux is not installed, so no agent can start in a detached session. Install tmux.", true);
    agents = [];
  }
  startStack(cfg, top, report, wait, poll, dry);
  const network = dry || !agents.length ||
    waitUntil(() => run(["git", "ls-remote", "origin", "HEAD"], top, 30).code === 0, wait, poll);
  const carry: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ["PATH", "DOCKER_HOST", "XDG_RUNTIME_DIR"].includes(k)) carry[k] = v;
  Object.assign(carry, readEnvFile(join(configDir(), `${repoKey()}.env`)));
  const ctx: Ctx = { dry, network, state: stateDir(), carry, started: [], stamp: localStamp(true, true), when: localStamp(false, false) };
  for (const agent of agents) startAgent(cfg, top, agent, report, ctx);
  if (!dry) {
    if (ctx.started.length && post) postReport(ctx.started[0] as string, report, machineId());
    report.add(`resume: done, ${ctx.started.length} of ${agents.length} agents started` +
      (report.failed ? `, ${report.failed} problem${report.failed !== 1 ? "s" : ""}` : ""));
  }
  return report.failed ? 1 : 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
