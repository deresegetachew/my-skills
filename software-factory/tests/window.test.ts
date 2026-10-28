// Every factory session runs in its own tmux window, started by one step (#300, PRD US-3): `factory loop -i` on a
// terminal, `factory resume` (what `factory autostart`'s boot service runs) and the cockpit all use it.
// tmux is a fake on PATH (it logs every call and keeps sessions as files); a real tmux never runs.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { hook, log, machine, machineFile, project as cloneProject } from "./autostart_support.ts";
import { claudeCalls, type Env, factory, project } from "./roles_support.ts";
import { sh, SF, write, writeExe } from "./support.ts";

const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/tmux.log"
d="$FAKE_TMUX"; mkdir -p "$d"
case "$1" in
  -V) echo "\${FAKE_TMUX_VERSION:-tmux 3.4}" ;;
  has-session) name="\${3#=}"; [ -f "$d/$name" ] ;;
  new-session)
    shift; name=""
    while [ $# -gt 0 ]; do
      case "$1" in -s) name="$2"; shift 2 ;; -c) echo "$2" >"$d/$name.dir"; shift 2 ;; -n) shift 2 ;; -d) shift ;; *) break ;; esac
    done
    printf '%s\\n' "$*" >"$d/$name" ;;
  *) ;;
esac
`;

/** A role project (real factory, fake claude and gh) with the fake tmux first on PATH, or no tmux at all. */
function withTmux(tmux = true, extra: Env = {}): [string, Env] {
  const [d, work, env] = project();
  const bin = join(d, "bin");
  const log = join(d, "tmuxlog");
  mkdirSync(log, { recursive: true });
  if (tmux) writeExe(join(bin, "tmux"), FAKE_TMUX);
  else {
    for (const t of ["git", "bun", "bash", "sh", "env", "sleep", "hostname", "cat", "uname", "ps", "dirname", "basename", "mkdir",
      "rm", "touch", "readlink", "tr", "sed", "grep", "awk", "date", "mktemp", "cut", "head", "tail", "sort", "wc", "id", "ls",
      "cp", "mv", "chmod", "ln", "realpath", "tput", "stty", "flock", "uniq", "xargs", "find", "tee", "printf", "test"]) {
      const real = Bun.which(t);
      try {
        if (real) symlinkSync(real, join(bin, t));
      } catch {
        // already there
      }
    }
    env.PATH = bin;
  }
  delete env.TMUX;
  delete env.FACTORY_WINDOW;
  Object.assign(env, { FAKE_LOG: log, FAKE_TMUX: join(d, "tmux-sessions") }, extra);
  return [work, env];
}

const calls = (env: Env): string[] => {
  const f = join(env.FAKE_LOG as string, "tmux.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};
const starts = (env: Env) => calls(env).filter((l) => l.startsWith("new-session"));

/** Runs `factory <args>` on a pseudo-terminal: [exit code, everything it showed]. */
async function onATerminal(work: string, env: Env, args: string[]): Promise<[number, string]> {
  let shown = "";
  const p = Bun.spawn(["bash", "./factory", ...args], {
    cwd: work, env: env as Record<string, string>,
    terminal: { cols: 200, rows: 50, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => p.kill(9), 60_000);
  const code = await p.exited;
  clearTimeout(timer);
  await Bun.sleep(50);
  p.terminal?.close();
  return [code, shown];
}

/** The part of a new-session call that every caller must share: session, folder and window. */
function shape(line: string): { session: string; dir: string; window: string; command: string } {
  const m = /^new-session -d -s (\S+) -c (\S+) -n (\S+) (.+)$/.exec(line);
  expect(m, line).not.toBeNull();
  const [, session, dir, window, command] = m as RegExpExecArray;
  return { session: session as string, dir: dir as string, window: window as string, command: command as string };
}

test("loop dash i on a terminal starts the role in its own tmux window and attaches", async () => {
  const [work, env] = withTmux();
  const [rc, shown] = await onATerminal(work, env, ["dev-manager", "lead", "loop", "-i"]);
  expect(rc, shown).toBe(0);
  const all = starts(env);
  expect(all.length, calls(env).join("\n")).toBe(1);
  const s = shape(all[0] as string);
  expect([s.session, s.window]).toEqual(["work-lead", "dev-manager-lead"]);
  expect(all[0]).toStartWith("new-session -d -s work-lead -c ");
  for (const w of ["FACTORY_WINDOW=dev-manager-lead", "FACTORY_ROLE=dev-manager", "FACTORY_NAME=lead", join(work, "factory"), "loop", "-i"]) {
    expect(s.command).toContain(w);
  }
  expect(calls(env)).toContain("attach-session -t =work-lead");
  expect(calls(env).findIndex((l) => l.startsWith("attach-session"))).toBeGreaterThan(calls(env).findIndex((l) => l.startsWith("new-session")));
  expect(shown).toContain("Started dev-manager-lead in tmux session work-lead");
  expect(claudeCalls(env), "the loop runs in the window, not here").toEqual([]);
}, 90_000);

test("the loop in its window keeps the PATH and the FACTORY settings it was started with", async () => {
  // A running tmux server gives a new window its own environment, not the caller's: the step must carry them over.
  const [work, env] = withTmux(true, { FACTORY_REMOTE_CONTROL: "0", FACTORY_TEST_NOTE: "lead's $(x)" });
  const [rc, shown] = await onATerminal(work, env, ["dev-manager", "lead", "loop", "-i"]);
  expect(rc, shown).toBe(0);
  const s = shape(starts(env)[0] as string);
  expect(s.command).toContain(`PATH=${env.PATH}`);
  expect(s.command).toContain("FACTORY_REMOTE_CONTROL=0");
  expect(s.command).toContain(`'FACTORY_TEST_NOTE=lead'"'"'s $(x)'`); // quoted for the shell, never run
}, 90_000);

test("inside tmux it switches the client; given a role only it takes the first free name", async () => {
  const [work, env] = withTmux(true, { TMUX: "/tmp/tmux-1000/default,1,0" });
  const [rc, shown] = await onATerminal(work, env, ["loop", "-i", "dev-manager"]);
  expect(rc, shown).toBe(0);
  expect(starts(env).length).toBe(1);
  expect(shape(starts(env)[0] as string).window).toBe("dev-manager-lead");
  expect(calls(env)).toContain("switch-client -t =work-lead");
  expect(calls(env).some((l) => l.startsWith("attach-session"))).toBe(false);
}, 90_000);

test("a session that is already running is not started twice, and is still attached", async () => {
  const [work, env] = withTmux();
  mkdirSync(env.FAKE_TMUX as string, { recursive: true });
  write(join(env.FAKE_TMUX as string, "work-lead"), "running\n");
  const [rc, shown] = await onATerminal(work, env, ["dev-manager", "lead", "loop", "-i"]);
  expect(rc, shown).toBe(0);
  expect(shown).toContain("already running");
  expect(shown).toContain("work-lead");
  expect(starts(env)).toEqual([]);
  expect(calls(env)).toContain("attach-session -t =work-lead");
}, 90_000);

test("inside a window (FACTORY_WINDOW) or without a terminal the loop runs in place", async () => {
  const [work, env] = withTmux(true, { FACTORY_WINDOW: "dev-manager-lead" });
  const [rc, shown] = await onATerminal(work, env, ["dev-manager", "lead", "loop", "-i", "--once"]);
  expect(rc, shown).toBe(0);
  expect(starts(env)).toEqual([]);
  const [work2, env2] = withTmux();
  const p = factory(work2, env2, ["dev-manager", "lead", "loop", "-i", "--once"]); // stdin is not a terminal
  expect(p.code, p.out).toBe(0);
  expect(starts(env2)).toEqual([]);
  expect(calls(env2).some((l) => l.startsWith("attach-session"))).toBe(false);
}, 150_000);

test("without tmux loop dash i on a terminal runs in place, with a note that tmux would give it a window", async () => {
  // tmux is needed for the cockpit, not for the factory (#295): the owner's machine may have none.
  const [work, env] = withTmux(false);
  const [rc, shown] = await onATerminal(work, env, ["dev-manager", "lead", "loop", "-i", "--once"]);
  expect(rc, shown).toBe(0);
  const notes = shown.split(/\r?\n/).filter((l) => /tmux is not installed/i.test(l));
  expect(notes.length, shown).toBe(1);
  expect(notes[0]).toMatch(/own tmux window/);
  expect(shown).not.toContain('"no-tmux"');
}, 90_000);

test("a tmux older than 3.2 still starts the session with a note about 3.2", async () => {
  const [work, env] = withTmux(true, { FAKE_TMUX_VERSION: "tmux 3.0a" });
  const [rc, shown] = await onATerminal(work, env, ["dev-manager", "lead", "loop", "-i"]);
  expect(rc, shown).toBe(0);
  expect(starts(env).length).toBe(1);
  expect(shown).toContain("3.2");
  const [work2, env2] = withTmux(); // a new enough tmux says nothing about versions
  const [, shown2] = await onATerminal(work2, env2, ["dev-manager", "lead", "loop", "-i"]);
  expect(shown2).not.toContain("3.2");
}, 150_000);

test("resume starts each agent in its window through the same step as loop dash i and autostart", async () => {
  const clone = cloneProject();
  const env = machine(clone);
  writeExe(join(dirname(clone), "bin", "tmux"), FAKE_TMUX); // answers -V as well
  machineFile(env, { autostart: true, autostartAgents: ["haile"] });
  // autostart's boot service runs `factory resume`
  const inst = hook("factory_autostart", clone, env, "install", "--agents", "haile");
  expect(inst.code, inst.out).toBe(0);
  const unit = readFileSync(join(env.XDG_CONFIG_HOME as string, "systemd", "user", "proj-factory-resume.service"), "utf8");
  expect(unit).toMatch(/^ExecStart=.*\/factory"? resume$/m);
  const r = hook("factory_resume", clone, env);
  expect(r.code, r.out).toBe(0);
  const resumed = starts(env);
  expect(resumed.length, log(env, "tmux")).toBe(1);
  expect(resumed[0]).toStartWith("new-session -d -s proj-haile -c ");
  const a = shape(resumed[0] as string);
  expect(a.window).toBe("coding-agent-haile");
  expect(a.command).toContain("FACTORY_WINDOW=coding-agent-haile");
  expect(a.command).toContain("FACTORY_AGENTS=haile");

  const [work, env2] = withTmux();
  await onATerminal(work, env2, ["dev-manager", "lead", "loop", "-i"]);
  const b = shape(starts(env2)[0] as string);
  expect(b.command).toContain(`FACTORY_WINDOW=${b.window}`);
  // the same shape: new-session -d -s <session> -c <folder> -n <role>-<name> <command starting exec env FACTORY_WINDOW=...>
  for (const s of [a, b]) {
    expect(s.session).toBe(`${s.dir.includes("proj") ? "proj" : "work"}-${s.window.replace(/^(coding-agent|dev-manager)-/, "")}`);
    expect(s.command).toMatch(/^exec env\b.*FACTORY_WINDOW=/);
  }
}, 150_000);

test("factory help says the loop starts in a tmux window", () => {
  const [work, env] = withTmux();
  const p = sh(["bash", join(SF, "factory"), "help"], { cwd: work, env });
  expect(p.code, p.out).toBe(0);
  const entry = p.stdout.split("\n").findIndex((l) => /^\s*loop \[-i\]/.test(l));
  expect(entry).toBeGreaterThanOrEqual(0);
  const lines = p.stdout.split("\n");
  let end = entry + 1;
  while (end < lines.length && /^\s{10,}\S/.test(lines[end] as string)) end++;
  expect(lines.slice(entry, end).join(" ")).toContain("tmux window");
});
