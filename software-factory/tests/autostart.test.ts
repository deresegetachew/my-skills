// `factory autostart` and `factory resume` (#88): a machine brings the stack and its agents back after a reboot,
// without losing unfinished work. tmux, docker, systemctl, loginctl, launchctl, plutil and gh are fakes on PATH; HOME
// and the config and state folders are temp folders. What systemd and launchd do at a real boot can't be tested here.
// (test_help_doctor_and_settings_know_about_autostart stays in test_autostart.py until factory_doctor and
// factory_settings are ported.)
import { expect, test } from "bun:test";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Env, GIT, hook, log, machine, machineFile, NAMES, parsePlist, project, sessions, shOk, state } from "./autostart_support.ts";
import { FAKE_GH, issue } from "./issues_support.ts";
import { loopRepo } from "./loop_support.ts";
import { KIT, read, sh, write, writeExe } from "./support.ts";

function bootLog(env: Env): string {
  try {
    return read(state(env, "boot.log"));
  } catch {
    return "";
  }
}

function writeConfig(clone: string, env: Env, withStack = true, extra: Record<string, unknown> = {}): void {
  const stack = join(env.FAKE_LOG as string, "stack.log");
  const cfg: Record<string, unknown> = { agents: NAMES, ...extra };
  if (withStack) cfg.commands = { stackUp: `echo up >>${stack}`, stackHealth: `test -s ${stack}` };
  write(join(clone, ".claude", "factory.json"), JSON.stringify(cfg));
}

function worktreeOf(clone: string, env: Env, name: string): string {
  const p = hook("factory_claims", clone, env, "worktree", name);
  expect(p.code, p.out).toBe(0);
  const lines = p.stdout.trim().split("\n");
  return lines[lines.length - 1] as string;
}

/** A worktree like the one in the issue: on task/412-manual-page with one unpushed commit, a modified file and an
 * untracked one. Returns its path. */
function unfinishedWork(clone: string, env: Env, name = "haile"): string {
  const wt = worktreeOf(clone, env, name);
  shOk(["git", "checkout", "-q", "-b", "task/412-manual-page"], wt);
  write(join(wt, "docs", "a.txt"), "one\nsaved in a commit\n");
  shOk(["git", "commit", "-qam", "Add the manual page intro"], wt);
  write(join(wt, "docs", "a.txt"), "one\nsaved in a commit\nhalf-written line\n");
  write(join(wt, "docs", "b.txt"), "two\nmore\n");
  write(join(wt, "docs", "new.txt"), "not added yet\n");
  return wt;
}

function porcelain(wt: string): string {
  return shOk(["git", "status", "--porcelain"], wt).stdout;
}

const autostart = (clone: string, env: Env, ...a: string[]) => hook("factory_autostart", clone, env, ...a);
const resume = (clone: string, env: Env, ...a: string[]) => hook("factory_resume", clone, env, ...a);
const unit = (env: Env, name: string) => join(env.XDG_CONFIG_HOME as string, "systemd", "user", name);
const lastJson = (text: string) => {
  const lines = text.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] as string) as Record<string, string>;
};

// --- status and the machine's own settings -------------------------------------------------------------------------

test("status shows what would start without starting anything", () => {
  const clone = project();
  const env = machine(clone);
  machineFile(env, { autostart: true, autostartAgents: ["haile", "tewodros"] });
  writeConfig(clone, env);
  const p = autostart(clone, env, "status");
  expect(p.code, p.out).toBe(0);
  for (const w of ["autostart: on", "haile", "tewodros", "echo up", "not installed"]) expect(p.stdout).toContain(w);
  expect(p.stdout).not.toContain("menelik"); // not this machine's
  expect(p.stdout).not.toContain("taytu");
  expect(sessions(env)).toEqual([]); // status changed things
  expect(existsSync(join(clone + "-agents", "haile"))).toBe(false);
});

test("status describes unfinished work and a running session", () => {
  const clone = project();
  const env = machine(clone);
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  unfinishedWork(clone, env);
  write(join(env.FAKE_TMUX as string, "proj-haile"), "x\n");
  const out = autostart(clone, env, "status").stdout;
  for (const w of ["task/412-manual-page", "uncommitted", "unpushed", "backup", "running"]) expect(out).toContain(w);
});

test("status off says how to turn it on", () => {
  const clone = project();
  const out = autostart(clone, machine(clone), "status").stdout;
  expect(out).toContain("autostart: off");
  expect(out).toContain("factory autostart install");
});

test("machine setup keeps the autostart settings", () => {
  const clone = project();
  const env = machine(clone);
  machineFile(env, { autostart: true, autostartAgents: ["haile"], agents: ["menelik"] });
  const p = hook("factory_machine", clone, env, "setup", "haile,tewodros");
  expect(p.code, p.out).toBe(0);
  expect(JSON.parse(read(join(env.FACTORY_CONFIG_DIR as string, "proj.json")))).toEqual(
    { agents: ["haile", "tewodros"], autostart: true, autostartAgents: ["haile"] });
});

// --- install and uninstall -----------------------------------------------------------------------------------------

test("install on linux writes a user unit enables it and turns linger on", () => {
  const clone = project();
  const env = machine(clone);
  const p = autostart(clone, env, "install", "--agents", "haile,tewodros");
  expect(p.code, p.out).toBe(0);
  const text = read(unit(env, "proj-factory-resume.service"));
  for (const w of ["Type=oneshot", "RemainAfterExit=yes", "KillMode=process", `WorkingDirectory=${clone}`,
    "WantedBy=default.target", "TimeoutStartSec="]) expect(text).toContain(w); // KillMode: the tmux sessions outlive the oneshot
  expect(text).toMatch(/^ExecStart=.*\/factory"? resume$/m);
  const sc = log(env, "systemctl");
  expect(sc).toContain("--user daemon-reload");
  expect(sc).toContain("--user enable proj-factory-resume.service");
  expect(log(env, "loginctl")).toContain("enable-linger");
  const data = JSON.parse(read(join(env.FACTORY_CONFIG_DIR as string, "proj.json"))) as Record<string, unknown>;
  expect(data.autostart).toBe(true);
  expect(data.autostartAgents).toEqual(["haile", "tewodros"]);
  expect(p.stdout).not.toContain("Note: linger");
  const status = autostart(clone, env, "status").stdout;
  expect(status).toContain("installed");
  expect(status).not.toContain("not installed");
});

test("install says how to turn linger on when it may not", () => {
  const clone = project();
  const env = machine(clone, { FAKE_LINGER_DENIED: "1" });
  const p = autostart(clone, env, "install", "--agents", "haile");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("sudo loginctl enable-linger");
});

test("install refuses a name that is not an agent and changes nothing", () => {
  const clone = project();
  const env = machine(clone);
  const p = autostart(clone, env, "install", "--agents", "nobody");
  expect(p.code, p.out).toBe(1);
  const err = lastJson(p.stderr);
  expect(err.code).toBe("unknown-agent");
  expect(err.message).toContain("nobody");
  expect(err.fix).toBeTruthy();
  expect(existsSync(join(env.XDG_CONFIG_HOME as string, "systemd"))).toBe(false); // wrote a unit
  expect(existsSync(join(env.FACTORY_CONFIG_DIR as string, "proj.json"))).toBe(false);
});

test("install without a user manager stops before changing anything", () => {
  const clone = project();
  const env = machine(clone, { FAKE_NO_BUS: "1" });
  const p = autostart(clone, env, "install", "--agents", "haile");
  expect(p.code, p.out).toBe(1);
  const err = lastJson(p.stderr);
  expect(err.code).toBe("no-user-manager");
  expect(err.fix).toContain("linger");
  expect(existsSync(join(env.FACTORY_CONFIG_DIR as string, "proj.json"))).toBe(false);
});

test("install without tmux says to install it", () => {
  const clone = project();
  const env = machine(clone, {}, false);
  const p = autostart(clone, env, "install", "--agents", "haile");
  expect(p.code, p.out).toBe(1);
  const err = lastJson(p.stderr);
  expect(err.code).toBe("no-tmux");
  expect(err.fix).toContain("install tmux");
  expect(existsSync(join(env.FACTORY_CONFIG_DIR as string, "proj.json"))).toBe(false);
});

test("install on macos writes a launch agent and loads it", () => {
  const clone = project();
  const env = machine(clone, { FACTORY_AUTOSTART_PLATFORM: "mac" });
  let p = autostart(clone, env, "install", "--agents", "haile");
  expect(p.code, p.out).toBe(0);
  const plist = join(env.HOME as string, "Library", "LaunchAgents", "dev.software-factory.proj-resume.plist");
  const data = parsePlist(read(plist)) as Record<string, unknown>;
  expect(data.Label).toBe("dev.software-factory.proj-resume");
  expect((data.ProgramArguments as string[]).slice(-2)).toEqual([join(clone, "factory"), "resume"]);
  expect(data.RunAtLoad).toBe(true);
  expect(data.WorkingDirectory).toBe(clone);
  expect(data.KeepAlive).toBeFalsy(); // it resumes once per boot, it isn't a daemon
  expect(data.AbandonProcessGroup).toBe(true); // the tmux sessions must outlive the job
  expect(log(env, "launchctl")).toContain("bootstrap");
  expect(log(env, "loginctl")).toBe("");
  expect(log(env, "systemctl")).toBe("");
  expect(autostart(clone, env, "status").stdout).toContain("installed");
  p = autostart(clone, env, "uninstall");
  expect(p.code, p.out).toBe(0);
  expect(existsSync(plist)).toBe(false);
  expect(log(env, "launchctl")).toContain("bootout");
});

test("uninstall removes the unit turns autostart off and leaves agents running", () => {
  const clone = project();
  const env = machine(clone);
  autostart(clone, env, "install", "--agents", "haile");
  write(join(env.FAKE_TMUX as string, "proj-haile"), "x\n");
  const p = autostart(clone, env, "uninstall");
  expect(p.code, p.out).toBe(0);
  expect(existsSync(unit(env, "proj-factory-resume.service"))).toBe(false); // unit left behind
  expect(log(env, "systemctl")).toContain("disable --now proj-factory-resume.service");
  const data = JSON.parse(read(join(env.FACTORY_CONFIG_DIR as string, "proj.json"))) as Record<string, unknown>;
  expect(data.autostart).toBe(false);
  expect(data.autostartAgents).toEqual(["haile"]);
  expect(sessions(env)).toEqual(["proj-haile"]); // uninstall must not stop running agents
  expect(log(env, "tmux")).not.toContain("kill");
});

// --- resume: the boot step -----------------------------------------------------------------------------------------

test("resume waits for docker starts the stack then the agents in detached sessions", () => {
  const clone = project();
  const env = machine(clone, { FAKE_DOCKER_FAILS: "3" });
  writeConfig(clone, env);
  machineFile(env, { autostart: true, autostartAgents: ["haile", "tewodros"] });
  const p = resume(clone, env);
  expect(p.code, p.out).toBe(0);
  expect(log(env, "docker").split("info").length - 1).toBeGreaterThanOrEqual(4); // it asked until Docker answered
  expect(read(join(env.FAKE_LOG as string, "stack.log")).trim()).toBe("up");
  expect(sessions(env)).toEqual(["proj-haile", "proj-tewodros"]);
  const calls = log(env, "tmux");
  expect(calls).toContain("new-session -d -s proj-haile");
  expect(calls).toContain("new-session -d -s proj-tewodros");
  const cmd = read(join(env.FAKE_TMUX as string, "proj-haile"));
  for (const w of ["FACTORY_AGENTS=haile", "loop -i", join(clone, "factory")]) expect(cmd).toContain(w);
  expect(cmd).not.toContain("FACTORY_RESUME"); // a clean agent starts normally
  for (const name of ["haile", "tewodros"]) { // each in its own worktree, with the settings resolving
    expect(existsSync(join(clone + "-agents/" + name, ".claude", "settings.json"))).toBe(true);
  }
  const out = bootLog(env);
  expect(out).toMatch(/stack: up/);
  for (const name of ["haile", "tewodros"]) expect(out).toMatch(new RegExp(`agent ${name}: started`));
  expect(p.stdout).toContain("stack: up");
  expect(p.stdout).toContain("agent haile: started");
  expect(existsSync(state(env, "backups"))).toBe(false); // nothing to back up
});

test("a second resume leaves running sessions alone", () => {
  const clone = project();
  const env = machine(clone);
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  expect(resume(clone, env).code).toBe(0);
  expect(log(env, "tmux").split("new-session").length - 1).toBe(1);
  const p = resume(clone, env);
  expect(p.code, p.out).toBe(0);
  expect(log(env, "tmux").split("new-session").length - 1).toBe(1);
  expect(p.stdout).toContain("agent haile: already running");
});

test("resume with autostart off does nothing unless forced", () => {
  const clone = project();
  const env = machine(clone);
  machineFile(env, { autostart: false, autostartAgents: ["haile"] });
  let p = resume(clone, env);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("autostart is off");
  expect(sessions(env)).toEqual([]);
  p = resume(clone, env, "--force");
  expect(p.code, p.out).toBe(0);
  expect(sessions(env)).toEqual(["proj-haile"]);
});

test("resume dry run starts nothing", () => {
  const clone = project();
  const env = machine(clone);
  writeConfig(clone, env);
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  const p = resume(clone, env, "--dry-run");
  expect(p.code, p.out).toBe(0);
  expect(sessions(env)).toEqual([]); // a dry run must not touch anything
  expect(log(env, "docker")).toBe("");
  expect(existsSync(join(env.FAKE_LOG as string, "stack.log"))).toBe(false);
  expect(p.stdout).toContain("would");
  expect(p.stdout).toContain("haile");
});

test("unfinished work is backed up left in place and the agent is told", () => {
  const clone = project();
  const env = machine(clone);
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  const wt = unfinishedWork(clone, env);
  const before = porcelain(wt);
  const head = shOk(["git", "rev-parse", "HEAD"], wt).stdout;
  const p = resume(clone, env);
  expect(p.code, p.out).toBe(0);
  // nothing reset, cleaned or switched
  expect(porcelain(wt)).toBe(before);
  expect(shOk(["git", "rev-parse", "HEAD"], wt).stdout).toBe(head);
  expect(shOk(["git", "branch", "--show-current"], wt).stdout.trim()).toBe("task/412-manual-page");
  expect(read(join(wt, "docs", "new.txt"))).toBe("not added yet\n");
  // one backup, named for the agent, the branch and the time
  const root = state(env, "backups");
  const found = readdirSync(root);
  expect(found.length).toBe(1);
  expect(found[0]).toMatch(/^haile-task-412-manual-page-\d{8}-\d{6}$/);
  const b = join(root, found[0] as string);
  const patch = read(join(b, "changes.patch"));
  expect(patch).toContain("half-written line");
  expect(patch).toContain("+more");
  const status = read(join(b, "status.txt"));
  expect(status).toContain("docs/a.txt");
  expect(status).toContain("docs/new.txt");
  expect(read(join(b, "unpushed.txt"))).toContain("Add the manual page intro");
  expect(read(join(b, "untracked", "docs", "new.txt"))).toBe("not added yet\n");
  // the session is started so the loop leaves the folder alone, and the first prompt says what happened
  const cmd = read(join(env.FAKE_TMUX as string, "proj-haile"));
  expect(cmd).toContain("FACTORY_RESUME=1");
  expect(cmd).toContain("FACTORY_RESUME_NOTE=");
  const notePath = ((/FACTORY_RESUME_NOTE=(\S+)/.exec(cmd) as RegExpExecArray)[1] as string).replace(/^['"]+|['"]+$/g, "");
  const note = read(notePath);
  for (const w of ["unexpected restart", "task/412-manual-page", "docs/a.txt", "docs/b.txt", b, "own in-progress"]) {
    expect(note).toContain(w); // own in-progress: resume, don't start something new
  }
  const out = bootLog(env);
  expect(out).toMatch(new RegExp("backup haile: .*" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(out).toMatch(/agent haile: started .*resuming/);
});

test("a clean worktree gets no backup and no note", () => {
  const clone = project();
  const env = machine(clone);
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  worktreeOf(clone, env, "haile");
  expect(resume(clone, env).code).toBe(0);
  expect(!existsSync(state(env, "backups")) || readdirSync(state(env, "backups")).length === 0).toBe(true);
});

test("an agent whose settings do not resolve is not started", () => {
  const clone = project();
  const env = machine(clone);
  machineFile(env, { autostart: true, autostartAgents: ["haile", "tewodros"] });
  const wt = clone + "-agents/haile";
  shOk(["git", "worktree", "add", "-q", "--detach", wt, "origin/main"], clone); // by hand: no submodule
  renameSync(join(wt, ".gitmodules"), join(wt, ".gitmodules.off"));
  const p = resume(clone, env);
  expect(p.code, p.out).toBe(1);
  expect(sessions(env)).toEqual(["proj-tewodros"]); // the other agent is not held back
  const out = bootLog(env);
  expect(out).toMatch(/agent haile: NOT started.*settings\.json/);
  expect(out).toContain("git submodule update --init");
  expect(out).toMatch(/agent tewodros: started/);
});

test("without network the stack still starts but no agent does", () => {
  const clone = project();
  const env = machine(clone, { FACTORY_RESUME_WAIT: "1" });
  writeConfig(clone, env);
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  shOk(["git", "remote", "set-url", "origin", "/nonexistent/origin.git"], clone);
  const p = resume(clone, env);
  expect(p.code, p.out).toBe(1);
  expect(existsSync(join(env.FAKE_LOG as string, "stack.log"))).toBe(true);
  expect(sessions(env)).toEqual([]);
  expect(bootLog(env)).toMatch(/agent haile: NOT started.*network/);
});

test("a stack that fails is reported and the agents still start", () => {
  const clone = project();
  const env = machine(clone);
  write(join(clone, ".claude", "factory.json"), JSON.stringify({ agents: NAMES, commands: { stackUp: "echo no database >&2; exit 7" } }));
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  const p = resume(clone, env);
  expect(p.code, p.out).toBe(1);
  expect(bootLog(env)).toMatch(/stack: .*failed.*7.*no database/);
  expect(sessions(env)).toEqual(["proj-haile"]);
});

test("environment file values reach the agents", () => {
  const clone = project();
  const env = machine(clone);
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  write(join(env.FACTORY_CONFIG_DIR as string, "proj.env"), "# keys\nSOPS_AGE_KEY_FILE=/home/x/age.txt\n");
  expect(resume(clone, env).code).toBe(0);
  expect(read(join(env.FAKE_TMUX as string, "proj-haile"))).toContain("SOPS_AGE_KEY_FILE");
});

function issuesProject(): [string, Env, string] {
  const clone = project({ agents: NAMES, tasks: { source: "issues" } });
  const env = machine(clone);
  writeExe(join((env.PATH as string).split(":")[0] as string, "gh"), FAKE_GH);
  const db = join(dirname(clone), "db.json");
  const marker = "<!-- factory-agent name=haile status=down ping=2026-10-24T20:16:00Z machine=aaaa1111 -->";
  const agentIssue = { ...issue(7, ["factory:agent", "factory:agent-down"]), title: "Agent: haile · down",
    body: marker + "\n**Status:** down\n**Last ping:** 2026-10-24T20:16:00Z\n**Started:** x\n**Where:** slot 3" };
  write(db, JSON.stringify({ issues: [agentIssue, issue(412, ["factory:in-progress", "agent:haile"])] }));
  env.FAKE_GH_DB = db;
  return [clone, env, db];
}

test("issues mode marks the agent working on its issue and posts the boot report", () => {
  const [clone, env, db] = issuesProject();
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  const p = resume(clone, env);
  expect(p.code, p.out).toBe(0);
  const data = JSON.parse(read(db)) as { issues: { number: number; title: string; body: string; labels: { name: string }[] }[];
    comments?: Record<string, { body: string }[]> };
  const agentIssue = data.issues.find((i) => i.number === 7) as (typeof data.issues)[number];
  expect(agentIssue.body).toContain("status=working");
  expect(agentIssue.title).toContain("#412");
  expect(agentIssue.labels.map((l) => l.name)).not.toContain("factory:agent-down");
  const comments = (data.comments?.["7"] ?? []).map((c) => c.body);
  expect(comments.length).toBe(1);
  for (const w of ["rebooted", "agent haile: started", "aaaa1111"]) expect(comments[0]).toContain(w); // which machine
  expect(bootLog(env)).toContain("registered haile as working on #412");
});

test("the boot report post can be turned off and never breaks a resume", () => {
  let [clone, env, db] = issuesProject();
  machineFile(env, { autostart: true, autostartAgents: ["haile"], autostartReport: false });
  expect(resume(clone, env).code).toBe(0);
  expect((JSON.parse(read(db)) as { comments?: unknown }).comments).toBeFalsy(); // posted although autostartReport is false
  // and a GitHub that refuses everything is only lines in the log
  [clone, env, db] = issuesProject();
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  writeExe(join((env.PATH as string).split(":")[0] as string, "gh"), "#!/bin/sh\necho 'HTTP 403' >&2\nexit 1\n");
  const p = resume(clone, env);
  expect(p.code, p.out).toBe(0);
  expect(sessions(env)).toEqual(["proj-haile"]);
  expect(bootLog(env)).toContain("GitHub");
});

// --- the loop: resuming never moves a worktree off its work -------------------------------------------------------

function loopSetup(resuming: boolean): [string, string, string, string, Env] {
  const [d, work] = loopRepo(["factory_claims.ts", "factory_env.ts", "factory_agents.ts", "next_task.ts", "factory_remote.ts"],
    { "docs/a.txt": "one\n" });
  const wt = join(d, "work-agents", "haile");
  shOk(["git", "worktree", "add", "-q", "--detach", wt, "origin/main"], work);
  shOk(["git", "checkout", "-q", "-b", "task/412-manual-page"], wt);
  write(join(wt, "docs", "a.txt"), "one\nhalf-written line\n");
  writeExe(join(d, "bin", "claude"), '#!/usr/bin/env bash\nprintf "claude %s\\n" "$*" >>"$LOOP_LOG"\n');
  const note = write(join(d, "resume-haile.md"), "You are resuming after an unexpected restart of this machine. Branch task/412-manual-page.\n");
  const env: Env = { ...process.env, ...GIT, PATH: `${d}/bin:${process.env.PATH}`, LOOP_LOG: join(d, "log"),
    LOOP_STATE: join(d, "state"), LOOP_WT: wt, STUB_AGENT: "haile", STUB_TASK: "issue-412 Manual page", FACTORY_REMOTE_CONTROL: "0" };
  for (const k of ["FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_RESUME", "FACTORY_RESUME_NOTE"]) delete env[k];
  if (resuming) Object.assign(env, { FACTORY_RESUME: "1", FACTORY_RESUME_NOTE: note });
  return [d, work, wt, note, env];
}

test("a resumed loop keeps the branch and the changes and puts the note in the first prompt", () => {
  const [, work, wt, note, env] = loopSetup(true);
  const p = sh(["bash", "./factory-loop.sh", "-i", "1"], { cwd: work, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  expect(shOk(["git", "branch", "--show-current"], wt).stdout.trim()).toBe("task/412-manual-page");
  expect(read(join(wt, "docs", "a.txt"))).toContain("half-written line");
  const logText = read(env.LOOP_LOG as string);
  const claude = logText.split("\n").filter((l) => l.startsWith("claude"));
  expect(claude.length, logText).toBe(1);
  expect(claude[0]).toContain("/next-task issue-412");
  expect(logText).toContain("unexpected restart");
  expect(logText).toContain("task/412-manual-page");
  expect(existsSync(note)).toBe(false); // the note is used once
  expect(p.stdout).toContain("resuming");
});

test("a loop that is not resuming still moves to main as before", () => {
  const [, work, wt, , env] = loopSetup(false);
  shOk(["git", "checkout", "--", "."], wt); // clean, so the checkout can happen
  sh(["bash", "./factory-loop.sh", "-i", "1"], { cwd: work, env, timeoutMs: 60_000 });
  expect(shOk(["git", "branch", "--show-current"], wt).stdout.trim()).toBe(""); // expected a detached main
  expect(read(env.LOOP_LOG as string)).not.toContain("unexpected restart");
});

// --- the deny rules -------------------------------------------------------------------------------------------------

test("agents cannot install or run autostart", () => {
  const deny = (JSON.parse(read(join(KIT, ".claude", "settings.json"))) as { permissions: { deny: string[] } }).permissions.deny;
  for (const rule of ["Bash(factory autostart install*)", "Bash(factory autostart uninstall*)", "Bash(./factory autostart install*)",
    "Bash(*factory_autostart*)", "Bash(factory resume*)", "Bash(./factory resume*)", "Bash(*factory_resume*)"]) {
    expect(deny).toContain(rule);
  }
});
