// `factory follow`, `factory say`, `factory remote` and `factory agent --detach` (#106), with a fake ssh and a fake tmux.
//
// The fake ssh runs the remote command on this machine, with the state of the remote it was asked for (a folder per host:
// its tmux sessions, their screens, whether the account has sudo). The fake tmux keeps sessions in files and logs what it
// was asked. Whether a real tmux shows the same screen to everyone is not tested here.
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import * as F from "../hooks/factory_follow.ts";
import * as R from "../hooks/factory_remotes.ts";
import { HOOKS, type Proc, read, readJson, readmeAndWiki, runHook, sh, SF, tmp, write, writeExe } from "./support.ts";

const FAKE_SSH = `#!/bin/bash
# fake ssh: skip the options, take the target, run the rest as the remote command on "that host"
echo "$*" >>"$FAKE_LOG/ssh.log"
while [ $# -gt 0 ]; do
  case "$1" in -o) shift 2 ;; -t|-tt|-T) shift ;; *) break ;; esac
done
target="$1"; shift; host="\${target#*@}"
case "$host" in down*) echo "ssh: connect to host $host port 22: No route to host" >&2; exit 255 ;; esac
export FAKE_REMOTE="$host" SSH_CLIENT="10.0.0.9 5555 22"
exec bash -c "$*"
`;

const FAKE_TMUX = `#!/bin/bash
host="\${FAKE_REMOTE:-local}"; d="$FAKE_STATE/$host"; mkdir -p "$d"
echo "$host: $*" >>"$FAKE_LOG/tmux.log"
case "$1" in
  list-sessions) cat "$d/sessions" 2>/dev/null ;;
  capture-pane) name=""; while [ $# -gt 0 ]; do [ "$1" = -t ] && name="$2"; shift; done
                name="\${name#=}"; name="\${name%:}"; cat "$d/pane-$name" 2>/dev/null ;;
  has-session) name="\${3#=}"; grep -qx -- "$name" "$d/sessions" 2>/dev/null ;;
  new-session) shift; name=""; while [ $# -gt 0 ]; do case "$1" in -s) name="$2"; shift 2 ;; -c) shift 2 ;; -d) shift ;; *) break ;; esac; done
               echo "$name" >>"$d/sessions"; echo "$*" >"$d/cmd-$name" ;;
  send-keys) shift; echo "keys: $*" >>"$d/keys" ;;
esac
`;

const FAKE_SUDO = '#!/bin/bash\n[ -f "$FAKE_STATE/${FAKE_REMOTE:-local}/has-sudo" ]\n';

type Env = Record<string, string | undefined>;

class World {
  base = tmp();
  bin = join(this.base, "bin");
  state = join(this.base, "state");
  log = join(this.base, "log");
  cfg = join(this.base, "config");
  repo = join(this.base, "app");
  env: Env;

  constructor(hosts: string[] = ["pc"], agents: string[] = ["haile", "tewodros"]) {
    for (const d of [this.bin, this.state, this.log, this.cfg]) mkdirSync(d, { recursive: true });
    for (const tool of ["bash", "sh", "env", "cat", "grep", "sed", "tail", "mkdir", "date", "printf", "dirname", "git", "uname", "id", "tr"]) {
      const found = Bun.which(tool);
      if (found) symlinkSync(found, join(this.bin, tool));
    }
    writeExe(join(this.bin, "ssh"), FAKE_SSH);
    writeExe(join(this.bin, "tmux"), FAKE_TMUX);
    writeExe(join(this.bin, "sudo"), FAKE_SUDO);
    mkdirSync(join(this.repo, ".claude"), { recursive: true });
    sh(["git", "init", "-q", "-b", "main", this.repo]);
    write(join(this.repo, ".claude", "factory.json"), JSON.stringify({ agents }));
    writeExe(join(this.repo, "factory"), '#!/bin/bash\necho "factory $*" >>"$FAKE_LOG/factory.log"\n');
    this.env = { PATH: `${this.bin}:${dirname(process.execPath)}`, FAKE_STATE: this.state, FAKE_LOG: this.log,
      FACTORY_CONFIG_DIR: this.cfg, HOME: this.base, XDG_CACHE_HOME: join(this.base, "cache"),
      XDG_STATE_HOME: join(this.base, "xstate"), USER: "owner", CLAUDE_PROJECT_DIR: this.repo, TMPDIR: process.env.TMPDIR };
    for (const h of hosts) mkdirSync(join(this.state, h), { recursive: true });
  }

  session(host: string, name: string, screen = ""): void {
    const d = join(this.state, host);
    mkdirSync(d, { recursive: true });
    write(join(d, "sessions"), this.read(join("state", host, "sessions")) + name + "\n");
    write(join(d, `pane-${name}`), screen);
  }

  factory(argv: string[], o: { env?: Env; input?: string } = {}): Proc {
    return runHook("factory_follow", argv, { cwd: this.repo, env: { ...this.env, ...(o.env ?? {}) }, input: o.input, timeoutMs: 60_000 });
  }

  read(rel: string): string {
    try {
      return read(join(this.base, rel));
    } catch {
      return "";
    }
  }

  logged(name: string): string[] {
    return this.read(join("log", name + ".log")).split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
  }

  keys(host: string): string[] {
    return this.read(join("state", host, "keys")).split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
  }
}

const RC = "claude.ai/code/session_01ABCdef";
const SCREEN = `Claude Code\n /remote-control is active · https://${RC}\n> working\n`;

function error(p: Proc): { code: string; message: string; fix: string } {
  const lines = p.stderr.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] as string);
}

/** Run `fn` with the world's environment and folder in this process (Python's os.environ.update + os.chdir). */
function within<T>(w: World, fn: () => T): T {
  const saved = { ...process.env };
  const cwd = process.cwd();
  Object.assign(process.env, w.env);
  process.chdir(w.repo);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    process.chdir(cwd);
  }
}

const attaches = (w: World): string[] => w.logged("tmux").filter((l) => l.includes(" attach "));

test("remotes are added listed and removed in the machine file not the project", () => {
  const w = new World();
  expect(w.factory(["remote", "list"]).stdout).toContain("No remotes");
  const p = w.factory(["remote", "add", "dev-pc", "factory@192.168.2.45"]);
  expect(p.code, p.stderr).toBe(0);
  expect(w.factory(["remote", "list"]).stdout).toContain("dev-pc  ssh  factory@192.168.2.45");
  const machineFile = join(w.cfg, "app.json");
  expect(readJson<{ remotes: Record<string, unknown> }>(machineFile).remotes["dev-pc"]).toEqual({ kind: "ssh", target: "factory@192.168.2.45" });
  expect(read(join(w.repo, ".claude", "factory.json"))).not.toContain("dev-pc");
  expect(w.factory(["remote", "remove", "dev-pc"]).code).toBe(0);
  expect(w.factory(["remote", "list"]).stdout).toContain("No remotes");
  expect(error(w.factory(["remote", "remove", "dev-pc"])).code).toBe("no-such-remote");
});

test("a bad name target or an admin account is refused with a fix", () => {
  const w = new World();
  for (const [argv, code] of [[["add", "Dev PC", "factory@host"], "bad-name"], [["add", "dev-pc", "host-only"], "bad-target"],
    [["add", "dev-pc", "root@host"], "admin-target"], [["cloud", "haile", "http://example.com/x"], "bad-url"]] as [string[], string][]) {
    const e = error(w.factory(["remote", ...argv]));
    expect(e.code, argv.join(" ")).toBe(code);
    expect(e.fix, argv.join(" ")).toBeTruthy();
  }
});

test("follow without a name lists the agents on every remote with state and the remote control link", () => {
  const w = new World(["pc", "nuc"]);
  w.session("pc", "haile", SCREEN);
  w.session("pc", "app-tewodros", "plain screen\n");
  w.session("pc", "unrelated-shell", "x");
  w.session("nuc", "dev-manager-pr-42", `https://${RC}-mgr\n`);
  for (const [name, target] of [["dev-pc", "factory@pc"], ["nuc", "factory@nuc"]] as const) w.factory(["remote", "add", name, target]);
  const p = w.factory(["follow"]);
  expect(p.code, p.stderr).toBe(0);
  const lines: Record<string, string> = {};
  for (const l of p.stdout.split("\n")) {
    const first = l.split(/\s+/)[0] as string;
    if (l && ["haile", "tewodros", "dev-manager-pr-42"].includes(first)) lines[first] = l;
  }
  expect(new Set(Object.keys(lines)), p.stdout).toEqual(new Set(["haile", "tewodros", "dev-manager-pr-42"]));
  expect(lines.haile).toContain("dev-pc");
  expect(lines.haile).toContain(`https://${RC}`);
  expect(lines.tewodros).toContain("dev-pc");
  expect(lines["dev-manager-pr-42"]).toContain("nuc");
  expect(lines["dev-manager-pr-42"]).toContain("dev-manager on pr-42");
  expect(p.stdout).not.toContain("unrelated-shell");
  const data = JSON.parse(w.factory(["follow", "--json"]).stdout) as { agents: { name: string; kind: string }[]; unreachable: unknown[] };
  expect(new Set(data.agents.map((a) => a.name))).toEqual(new Set(["haile", "tewodros", "dev-manager-pr-42"]));
  expect(data.unreachable).toEqual([]);
  expect(data.agents.find((a) => a.name === "dev-manager-pr-42")?.kind).toBe("sub-manager");
});

test("the list uses github for state task and last ping when it can", () => {
  const w = new World();
  w.session("pc", "haile", SCREEN);
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  F.setGithubStates(() => ({ haile: ["working", 3, "working on #42"], tewodros: ["silent", 95, "idle"] }));
  try {
    const [rows] = within(w, () => F.rows({ agents: ["haile", "tewodros"] }, "app"));
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.haile?.state).toBe("alive");
    expect(by.haile?.task).toBe("working on #42");
    expect(by.haile?.lastPing).toBe("3 min ago");
    expect(by.haile?.remoteControl).toBe(`https://${RC}`);
    expect(by.tewodros?.state).toBe("silent");
    expect(by.tewodros?.where).toBe("not on a remote");
  } finally {
    F.setGithubStates();
  }
});

test("an unreachable remote is named and the others still list", () => {
  const w = new World(["pc", "down1"]);
  w.session("pc", "haile", SCREEN);
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  w.factory(["remote", "add", "far", "factory@down1"]);
  const p = w.factory(["follow"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("haile");
  expect(p.stdout).toContain("far: unreachable");
  expect(p.stdout).toContain("No route to host");
});

test("follow by name attaches to that session interactively with the detach note", () => {
  const w = new World(["pc", "nuc"]);
  w.session("pc", "haile", SCREEN);
  w.session("nuc", "tewodros", "");
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  w.factory(["remote", "add", "nuc", "factory@nuc"]);
  const p = w.factory(["follow", "haile"]);
  expect(p.code, p.stderr).toBe(0);
  expect(attaches(w)).toEqual(["pc: attach -t =haile"]);
  const ssh = w.logged("ssh").filter((l) => l.includes("attach"));
  expect(ssh.length, ssh.join("\n")).toBe(1);
  expect(ssh[0]).toContain("factory@pc");
  expect(" " + ssh[0]).toContain(" -t "); // a terminal is requested
  expect(p.stderr).toContain("Ctrl-b d");
  expect(p.stderr).toContain("Ctrl+C is not detach");
  expect(p.stderr).toContain(`https://${RC}`);
  for (const part of ["BatchMode=yes", "ControlMaster=auto", "ControlPersist"]) expect(ssh[0]).toContain(part);
});

test("read attaches with the read only flag so nothing can be typed", () => {
  const w = new World();
  w.session("pc", "haile", SCREEN);
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  const p = w.factory(["follow", "haile", "--read"]);
  expect(p.code).toBe(0);
  expect(attaches(w)).toEqual(["pc: attach -r -t =haile"]);
  expect(p.stderr).toContain("Watching only");
});

test("a name on two remotes is refused and on picks one", () => {
  const w = new World(["pc", "nuc"]);
  w.session("pc", "haile", SCREEN);
  w.session("nuc", "app-haile", "");
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  w.factory(["remote", "add", "nuc", "factory@nuc"]);
  const e = error(w.factory(["follow", "haile"]));
  expect(e.code).toBe("ambiguous");
  expect(e.fix).toContain("--on");
  expect(e.message).toContain("dev-pc");
  expect(e.message).toContain("nuc");
  expect(attaches(w)).toEqual([]);
  expect(w.factory(["follow", "haile", "--on", "nuc"]).code).toBe(0);
  expect(attaches(w)).toEqual(["nuc: attach -t =app-haile"]);
});

test("an unknown agent an unreachable remote and a missing tmux each say what to do", () => {
  const w = new World(["pc", "down1"]);
  w.session("pc", "haile", SCREEN);
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  let e = error(w.factory(["follow", "menelik"]));
  expect(e.code).toBe("no-such-agent");
  expect(e.fix).toContain("dev-pc");
  expect(e.fix).toContain("factory follow");
  e = error(w.factory(["follow", "zzz"]));
  expect(e.fix).toContain("Known names: haile, tewodros");
  w.factory(["remote", "add", "far", "factory@down1"]);
  expect(["no-such-agent", "unreachable"]).toContain(error(w.factory(["follow", "haile", "--on", "far"])).code);
  const w2 = new World();
  e = error(w2.factory(["follow", "haile"]));
  expect(e.code).toBe("no-such-agent");
  expect(e.fix).toContain("factory remote add");
  rmSync(join(w.bin, "tmux"));
  expect(error(w.factory(["follow", "haile"])).code).toBe("no-such-agent"); // no tmux there: no sessions
});

test("a target with sudo is refused for every command", () => {
  const w = new World();
  w.session("pc", "haile", SCREEN);
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  write(join(w.state, "pc", "has-sudo"), "");
  const p = w.factory(["follow"]);
  expect(p.stdout).toContain("unreachable (the account can run sudo");
  for (const argv of [["follow", "haile"], ["say", "haile", "hello"]]) {
    const e = error(w.factory(argv));
    expect(["no-such-agent", "sudo-target"], argv.join(" ")).toContain(e.code);
  }
  expect(attaches(w)).toEqual([]);
  expect(w.keys("pc")).toEqual([]);
  let caught: unknown = null;
  within(w, () => {
    try {
      R.ensureSandboxTarget("factory@pc");
    } catch (err) {
      caught = err;
    }
  });
  expect(caught, "a sudo target was accepted").toBeInstanceOf(R.RemoteError);
  expect((caught as R.RemoteError).code).toBe("sudo-target");
});

test("a cloud agent prints its remote control link instead of attaching", () => {
  const w = new World();
  expect(w.factory(["remote", "cloud", "abebe", "https://claude.ai/code/session_01CLOUD"]).code).toBe(0);
  const listing = w.factory(["follow"]).stdout;
  expect(listing).toContain("abebe");
  expect(listing).toContain("cloud");
  expect(listing).toContain("https://claude.ai/code/session_01CLOUD");
  const p = w.factory(["follow", "abebe"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("runs in the cloud");
  expect(p.stdout).toContain("https://claude.ai/code/session_01CLOUD");
  expect(w.logged("ssh").filter((l) => l.includes("attach"))).toEqual([]);
  const e = error(w.factory(["say", "abebe", "hello"]));
  expect(e.code).toBe("cloud-agent");
  expect(e.fix).toContain("Remote Control");
});

test("say sends the text to that session only and logs who when and which agent without the text", () => {
  const w = new World(["pc", "nuc"]);
  w.session("pc", "haile", SCREEN);
  w.session("pc", "app-tewodros", "");
  w.session("nuc", "menelik", "");
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  w.factory(["remote", "add", "nuc", "factory@nuc"]);
  const msg = '-t please check the "failing" test $(rm -rf /) and carry on';
  const p = w.factory(["say", "haile", msg]);
  expect(p.code, p.stderr).toBe(0);
  const sends = w.logged("tmux").filter((l) => l.includes("send-keys"));
  expect(sends).toEqual([`pc: send-keys -t =haile: -l -- ${msg}`, "pc: send-keys -t =haile: Enter"]);
  expect(w.keys("nuc")).toEqual([]);
  expect(sends.some((l) => l.includes("tewodros"))).toBe(false);
  const log = w.read("xstate/software-factory/say.log");
  for (const part of ["agent=haile", "from=owner@", "via=10.0.0.9"]) expect(log).toContain(part);
  expect(log).not.toContain("failing");
  expect(log).not.toContain("rm -rf");
});

test("say refuses empty multi line and control character messages and a missing session", () => {
  const w = new World();
  w.session("pc", "haile", SCREEN);
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  for (const bad of ["", "  ", "line one\nline two", "tab\there", "x".repeat(2001)]) {
    expect(error(w.factory(["say", "haile", bad])).code).toBe("bad-message");
  }
  expect(w.keys("pc")).toEqual([]);
  rmSync(join(w.state, "pc", "sessions"));
  w.session("pc", "elsewhere", "");
  expect(error(w.factory(["say", "haile", "hi"])).code).toBe("no-such-agent");
});

test("an agent session cannot say or change the remotes but can list", () => {
  const w = new World();
  w.session("pc", "haile", SCREEN);
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  for (const env of [{ FACTORY_AGENT: "haile" }, { FACTORY_LOOP: "1" }, { CLAUDECODE: "1" }]) {
    expect(error(w.factory(["say", "haile", "hi"], { env })).code).toBe("agent-session");
    expect(error(w.factory(["remote", "add", "x", "factory@y"], { env })).code).toBe("agent-session");
    expect(w.factory(["remote", "list"], { env }).code).toBe(0);
    expect(w.factory(["follow"], { env }).code).toBe(0);
  }
  expect(w.keys("pc")).toEqual([]);
});

test("log streams only new lines without a terminal", () => {
  expect(F.newLines(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual(["d", "e"]);
  expect(F.newLines(["a", "b"], ["a", "b"])).toEqual([]);
  expect(F.newLines(["a", "b"], ["x", "y"])).toEqual(["x", "y"]);
  const w = new World();
  w.session("pc", "haile", "line 1\nline 2\n");
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  const p = w.factory(["follow", "haile", "--log", "--polls", "1"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toBe("line 1\nline 2\n");
  expect(attaches(w)).toEqual([]);
  expect(w.logged("ssh").filter((l) => l.startsWith("-t "))).toEqual([]);
});

test("all opens one read only pane per session in a local tmux", () => {
  const w = new World(["pc", "nuc", "local"]);
  w.session("pc", "haile", SCREEN);
  w.session("nuc", "tewodros", "");
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  w.factory(["remote", "add", "nuc", "factory@nuc"]);
  const p = w.factory(["follow", "--all"]);
  expect(p.code, p.stderr).toBe(0);
  const local = w.logged("tmux").filter((l) => l.startsWith("local:"));
  expect(local.some((l) => l.includes("new-session -d -s factory-follow-") && l.includes("attach -r -t =haile")) ||
    local.some((l) => l.includes("attach -r -t =haile")), local.join("\n")).toBe(true);
  expect(local.some((l) => l.includes("split-window") && l.includes("attach -r -t =tewodros")) ||
    local.some((l) => l.includes("attach -r -t =tewodros"))).toBe(true);
  expect(local.some((l) => l.includes("select-layout") && l.includes("tiled"))).toBe(true);
  expect(local.filter((l) => l.includes("attach")).every((l) => !l.includes("attach -t =") || l.endsWith(" -t factory-follow") ||
    l.includes("factory-follow-"))).toBe(true);
  expect(error(new World().factory(["follow", "--all"])).code).toBe("nothing-to-follow");
});

test("agent detach starts a named tmux session the follow commands find", () => {
  const w = new World(["local"]);
  const p = w.factory(["detach", "haile"]);
  expect(p.code, p.stderr).toBe(0);
  const session = "app-haile";
  const sessions = (): string[] => read(join(w.state, "local", "sessions")).split(/\s+/).filter(Boolean);
  expect(sessions()).toContain(session);
  const cmd = read(join(w.state, "local", `cmd-${session}`));
  expect(cmd.trim().endsWith(`exec ${join(w.repo, "factory")} agent haile`), cmd).toBe(true);
  expect(p.stdout).toContain("factory follow haile");
  const again = w.factory(["detach", "haile"]);
  expect(again.code).toBe(0);
  expect(again.stdout).toContain("already running");
  expect(sessions().filter((s) => s === session).length).toBe(1);
  expect(w.factory(["detach", "1"]).code).toBe(0);
  expect(read(join(w.state, "local", "sessions"))).toContain("app-haile");
  expect(error(w.factory(["detach", "9"])).code).toBe("no-such-agent");
  expect(error(w.factory(["detach"])).code).toBe("usage");
  // and the session it made is found by name from a remote that is this machine
  w.factory(["remote", "add", "me", "factory@local"]);
  expect(w.factory(["follow"]).stdout).toContain("haile");
});

test("the factory command wires the new commands and detach", () => {
  const w = new World(["local"]);
  sh(["git", "-C", w.repo, "add", "-A"]);
  mkdirSync(join(w.repo, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) {
    if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(w.repo, ".claude", "hooks", f));
  }
  const cli = join(SF, "factory");
  const run = (...a: string[]): Proc => sh(["bash", cli, ...a], { cwd: w.repo, env: w.env });
  const p = run("help");
  for (const part of ["follow [<agent>]", "say <agent>", "remote [add|cloud|list|remove]", "--detach"]) expect(p.stdout).toContain(part);
  expect(run("remote", "add", "dev-pc", "factory@pc").code).toBe(0);
  expect(run("remote", "list").stdout).toContain("dev-pc");
  w.session("pc", "haile", SCREEN);
  expect(run("follow").stdout).toContain("haile");
  const d = run("agent", "haile", "--detach");
  expect(d.code, d.stderr).toBe(0);
  expect(read(join(w.state, "local", "sessions"))).toContain("app-haile");
});

test("the scripts are bun scripts with no forwarder and are documented", () => {
  // #252: a .ts gets no forwarder in kit/.claude/hooks; projects link hooks/ directly.
  for (const name of ["factory_follow", "factory_remotes"]) {
    expect(Bun.file(join(HOOKS, name + ".ts")).size).toBeGreaterThan(0);
    expect(sh(["test", "-e", join(SF, "kit", ".claude", "hooks", name + ".py")]).code, name).not.toBe(0);
  }
  const readme = readmeAndWiki();
  for (const part of ["factory follow", "factory say", "factory remote add", "--detach", "Remote Control", "sub-manager", "sudo",
    "ControlMaster", "Ctrl-b d"]) expect(readme).toContain(part);
});

// ---- factory follow on this machine (#301): a tmux session here is found directly, with no ssh remote ----

const sshAttaches = (w: World): string[] => w.logged("ssh").filter((l) => l.includes("attach"));

test("follow attaches to a session on this machine with no remote and no ssh", () => {
  const w = new World([]);
  w.session("local", "app-haile", SCREEN);
  const p = w.factory(["follow", "haile"]);
  expect(p.code, p.stderr).toBe(0);
  expect(attaches(w)).toEqual(["local: attach -t =app-haile"]);
  expect(sshAttaches(w)).toEqual([]);
  expect(p.stderr).toContain("Ctrl-b d");
  expect(p.stderr).toContain("this machine");
  const r = w.factory(["follow", "haile", "--read"]);
  expect(r.code, r.stderr).toBe(0);
  expect(attaches(w)).toEqual(["local: attach -t =app-haile", "local: attach -r -t =app-haile"]);
  expect(r.stderr).toContain("Watching only");
});

test("the list shows a session on this machine as this machine and asks for a remote only when there is nothing", () => {
  const w = new World([]);
  w.session("local", "app-haile", SCREEN);
  const p = w.factory(["follow"]);
  expect(p.code, p.stderr).toBe(0);
  const line = p.stdout.split("\n").find((l) => l.split(/\s+/)[0] === "haile") ?? "";
  expect(line, p.stdout).toContain("this machine");
  expect(p.stdout).not.toContain("No remotes yet");
  const data = JSON.parse(w.factory(["follow", "--json"]).stdout) as { agents: { name: string; where: string }[] };
  expect(data.agents.find((a) => a.name === "haile")?.where).toBe("this machine");
  const q = new World([]).factory(["follow"]);
  expect(q.code, q.stderr).toBe(0);
  expect(q.stdout + q.stderr).toContain("factory remote add");
});

test("an unknown name or an ended session is no-such-agent and the fix lists the known names and this machine", () => {
  const w = new World([]);
  w.session("local", "app-haile", SCREEN);
  let e = error(w.factory(["follow", "zzz"]));
  expect(e.code).toBe("no-such-agent");
  expect(e.fix).toContain("Known names: haile, tewodros");
  expect(e.fix).toContain("this machine");
  e = error(w.factory(["follow", "tewodros"]));
  expect(e.code).toBe("no-such-agent");
  expect(e.fix).toContain("Known names: haile, tewodros");
  expect(attaches(w)).toEqual([]);
});

test("log and say work on this machine without ssh", () => {
  const w = new World([]);
  w.session("local", "app-haile", "line 1\nline 2\n");
  const l = w.factory(["follow", "haile", "--log", "--polls", "1"]);
  expect(l.code, l.stderr).toBe(0);
  expect(l.stdout).toBe("line 1\nline 2\n");
  const p = w.factory(["say", "haile", "hello"]);
  expect(p.code, p.stderr).toBe(0);
  const sends = w.logged("tmux").filter((x) => x.includes("send-keys"));
  expect(sends).toEqual(["local: send-keys -t =app-haile: -l -- hello", "local: send-keys -t =app-haile: Enter"]);
  expect(p.stdout).toContain("this machine");
  expect(w.logged("ssh")).toEqual([]);
});

test("the same name here and on a remote is ambiguous and on local or the remote name picks one", () => {
  const w = new World(["pc"]);
  w.session("local", "app-haile", SCREEN);
  w.session("pc", "haile", SCREEN);
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  const e = error(w.factory(["follow", "haile"]));
  expect(e.code).toBe("ambiguous");
  expect(e.message).toContain("this machine");
  expect(e.message).toContain("dev-pc");
  expect(e.fix).toContain("--on local");
  expect(attaches(w)).toEqual([]);
  expect(w.factory(["follow", "haile", "--on", "local"]).code).toBe(0);
  expect(attaches(w)).toEqual(["local: attach -t =app-haile"]);
  expect(w.factory(["follow", "haile", "--on", "dev-pc"]).code).toBe(0);
  expect(attaches(w)).toEqual(["local: attach -t =app-haile", "pc: attach -t =haile"]);
});

test("a remote session still attaches over ssh when nothing runs on this machine", () => {
  const w = new World(["pc"]);
  w.session("pc", "haile", SCREEN);
  w.factory(["remote", "add", "dev-pc", "factory@pc"]);
  expect(w.factory(["follow", "haile"]).code).toBe(0);
  expect(attaches(w)).toEqual(["pc: attach -t =haile"]);
});

test("this machine is not refused for having sudo", () => {
  const w = new World([]);
  w.session("local", "app-haile", SCREEN);
  write(join(w.state, "local", "has-sudo"), "");
  const p = w.factory(["follow", "haile"]);
  expect(p.code, p.stderr).toBe(0);
  expect(attaches(w)).toEqual(["local: attach -t =app-haile"]);
});

test("a remote cannot be named local because that name is kept for this machine", () => {
  const w = new World([]);
  const e = error(w.factory(["remote", "add", "local", "factory@host"]));
  expect(e.code).toBe("bad-name");
  expect(e.fix).toBeTruthy();
});

test("help and the docs explain following on this machine", () => {
  const w = new World([]);
  const help = w.factory(["help"]).stdout;
  expect(help).toContain("this machine");
  expect(help).toContain("--on local");
  expect(readmeAndWiki()).toContain("--on local");
});
