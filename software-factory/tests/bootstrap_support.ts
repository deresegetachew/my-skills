// The fake machine `factory bootstrap` runs on in tests (#105): fake system tools on PATH that keep their state in
// files, system paths under a temp root, this process's environment swapped for the machine's, and `factory bootstrap`
// run in this process with its output captured. Shared by bootstrap.test.ts (and the doctor's --sandbox tests). Not a
// test file.
import { expect } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import * as B from "../hooks/factory_bootstrap.ts";
import * as M from "../hooks/factory_bootstrap_machine.ts";
import type * as S from "../hooks/factory_sandbox.ts";
import { sh, tmp, write, writeExe } from "./support.ts";

export const USER = "sbxuser";
export const MUTATING = ["apt-get", "adduser", "usermod", "gpasswd", "chmod", "loginctl", "systemctl", "nft", "sshd"];

export const FAKES: Record<string, string> = {
  "dpkg-query": String.raw`pkg="${"$"}{!#}"; if [ -f "$FAKE_STATE/pkg-$pkg" ]; then printf 'install ok installed'; else printf 'unknown ok not-installed'; exit 1; fi`,
  "apt-get": String.raw`echo "$*" >>"$FAKE_LOG/apt-get.log"; [ "$1" = install ] || exit 0
for a in "$@"; do case "$a" in -*|install) ;; *) touch "$FAKE_STATE/pkg-$a" ;; esac; done`,
  adduser: String.raw`echo "$*" >>"$FAKE_LOG/adduser.log"; touch "$FAKE_STATE/user-${"$"}{!#}"`,
  id: String.raw`case "$1" in
  -u) [ -f "$FAKE_STATE/user-$2" ] && echo 4242 || exit 1 ;;
  -nG) n="${"$"}{2:-$USER}"; echo "$n $(cat "$FAKE_STATE/groups-$n" 2>/dev/null)" ;;
  -un) echo "${"$"}{USER:-sbxuser}" ;;
esac`,
  usermod: String.raw`echo "$*" >>"$FAKE_LOG/usermod.log"; u="${"$"}{!#}"
mkdir -p "$FAKE_ROOT/etc"; echo "$u:100000:65536" >>"$FAKE_ROOT/etc/subuid"; echo "$u:100000:65536" >>"$FAKE_ROOT/etc/subgid"`,
  gpasswd: String.raw`echo "$*" >>"$FAKE_LOG/gpasswd.log"; rm -f "$FAKE_STATE/groups-$2"`,
  chmod: String.raw`echo "$*" >>"$FAKE_LOG/chmod.log"`,
  loginctl: String.raw`case "$1" in
  enable-linger) echo "$*" >>"$FAKE_LOG/loginctl.log"; touch "$FAKE_STATE/linger" ;;
  show-user) [ -f "$FAKE_STATE/linger" ] && echo yes || echo no ;;
esac`,
  systemctl: String.raw`if [ "$1" = --user ]; then shift
  case "$1" in
    list-units|list-unit-files) cat "$FAKE_STATE/userunits" 2>/dev/null ;;
    *) echo "user $*" >>"$FAKE_LOG/systemctl-user.log" ;;
  esac; exit 0; fi
case "$1" in
  daemon-reload|reload|mask|unmask) echo "$*" >>"$FAKE_LOG/systemctl.log" ;;
  enable) echo "$*" >>"$FAKE_LOG/systemctl.log"; touch "$FAKE_STATE/enabled-$2" ;;
  restart|start) echo "$*" >>"$FAKE_LOG/systemctl.log"; touch "$FAKE_STATE/active-$2" ;;
  disable) echo "$*" >>"$FAKE_LOG/systemctl.log"; rm -f "$FAKE_STATE/enabled-${"$"}{3:-$2}" "$FAKE_STATE/active-${"$"}{3:-$2}" ;;
  is-active) [ -f "$FAKE_STATE/active-${"$"}{3:-$2}" ] ;;
  is-enabled) [ -f "$FAKE_STATE/enabled-${"$"}{3:-$2}" ] ;;
esac`,
  nft: String.raw`echo "$*" >>"$FAKE_LOG/nft.log"`,
  sops: "exit 0",
  sshd: String.raw`echo "$*" >>"$FAKE_LOG/sshd.log"`,
  ss: String.raw`cat "$FAKE_STATE/ss.txt" 2>/dev/null`,
  resolvectl: String.raw`echo "Link 2 (eth0): 192.168.2.1"`,
  ip: String.raw`echo "default via 192.168.2.1 dev eth0"`,
  journalctl: String.raw`[ -f "$FAKE_STATE/nolog" ] && exit 1; echo "kernel: FACTORY-BLOCK IN= OUT=eth0 DST=192.168.2.1"`,
  sudo: String.raw`[ -f "$FAKE_STATE/has-sudo" ]`,
  ls: String.raw`[ -f "$FAKE_STATE/admin-readable" ]`,
  // curl: succeeds for the internet, fails for what the guard blocks (unless FAKE_OPEN lists it)
  curl: String.raw`url="${"$"}{!#}"
case "$url" in
  https://github.com|https://registry.npmjs.org|https://api.anthropic.com) printf 200 ;;
  *) if grep -qF "$url" "$FAKE_STATE/open" 2>/dev/null; then printf 200; else printf 000; exit 28; fi ;;
esac`,
  docker: String.raw`case "$1" in
  info) cat "$FAKE_STATE/dockerinfo" 2>/dev/null || { echo "x" >&2; exit 1; } ;;
  run) [ -f "$FAKE_STATE/container-open" ] && exit 0 || exit 1 ;;
esac`,
};

export type Env = Record<string, string>;

/** A bin folder of fakes, a state folder and a root folder. */
export function newMachine(state: Record<string, string>): { env: Env; root: string; state: string; log: string } {
  const base = tmp();
  const [bin, st, log, root] = ["bin", "state", "log", "root"].map((n) => join(base, n)) as [string, string, string, string];
  for (const d of [bin, st, log, join(root, "etc")]) mkdirSync(d, { recursive: true });
  for (const tool of ["bash", "sh", "env", "cat", "grep", "mkdir", "touch", "rm", "echo", "dirname", "git", "uname", "head", "tail"]) {
    const found = Bun.which(tool);
    if (found) symlinkSync(found, join(bin, tool));
  }
  for (const [name, body] of Object.entries(FAKES)) writeExe(join(bin, name), "#!/bin/bash\n" + body + "\n");
  // a machine where Bun is already installed for every user (the "bun" step is then done; netguard.test.ts tests it)
  symlinkSync(process.execPath, join(bin, "bun"));
  write(join(root, "etc", "os-release"), 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04"\n');
  write(join(root, "etc", "resolv.conf"), "nameserver 127.0.0.53\n");
  const env: Env = { PATH: `${bin}:${dirname(process.execPath)}`, FAKE_STATE: st, FAKE_LOG: log, FAKE_ROOT: root,
    HOME: join(base, "home"), USER, TMPDIR: process.env.TMPDIR ?? "/tmp" };
  mkdirSync(env.HOME as string);
  for (const [k, v] of Object.entries(state)) write(join(st, k), v);
  return { env, root, state: st, log };
}

let active: Machine | null = null;
/** Put the process back as it was before the last Machine (call it after each test). */
export function closeMachine(): void {
  active?.close();
  active = null;
}

/** Applies the fake machine's environment to this process for the length of a test. */
export class Machine {
  env: Env;
  root: string;
  state: string;
  log: string;
  rootUser = true;
  private saved: { env: Record<string, string | undefined>; root: string; cwd: string };

  constructor(state: Record<string, string> = {}) {
    const m = newMachine(state);
    this.env = m.env;
    this.root = m.root;
    this.state = m.state;
    this.log = m.log;
    this.saved = { env: { ...process.env }, root: M.ROOT, cwd: process.cwd() };
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, this.env);
    M.setRoot(this.root);
    B.setIsRoot(() => this.rootUser);
    active = this;
  }

  close(): void {
    process.chdir(this.saved.cwd);
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, this.saved.env);
    M.setRoot(this.saved.root);
    B.setIsRoot();
  }

  async run(...argv: string[]): Promise<[number, string, string]> {
    let out = "";
    let err = "";
    const so = process.stdout.write;
    const se = process.stderr.write;
    process.stdout.write = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => { err += String(s); return true; }) as typeof process.stderr.write;
    try {
      const rc = await B.main(argv);
      return [rc, out, err];
    } finally {
      process.stdout.write = so;
      process.stderr.write = se;
    }
  }

  logged(tool: string): string[] {
    try {
      return readFileSync(join(this.log, tool + ".log"), "utf8").split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
    } catch {
      return [];
    }
  }

  mutations(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const t of MUTATING) if (this.logged(t).length) out[t] = this.logged(t);
    return out;
  }

  file(path: string): string {
    return readFileSync(M.P(path), "utf8");
  }
}

export function machineArgs(...extra: string[]): string[] {
  return ["machine", "--user", USER, ...extra];
}

export function projectRepo(m: Machine, factoryJson: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  const repo = join(m.state, "proj");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  expect(sh(["git", "init", "-q", "-b", "main", repo], { env: process.env }).code).toBe(0);
  write(join(repo, ".claude", "factory.json"), JSON.stringify(factoryJson));
  for (const [name, text] of Object.entries(files)) write(join(repo, name), text);
  writeExe(join(repo, "factory"), '#!/bin/bash\necho "factory $*" >>"$FAKE_LOG/factory.log"\n' +
    '[ "$1" = install-shim ] && { mkdir -p "$HOME/.local/bin"; touch "$HOME/.local/bin/factory"; }\n' +
    '[ "$1 $2" = "ci install" ] && echo "proj-ci.service enabled" >>"$FAKE_STATE/userunits"\n' +
    '[ "$1 $2" = "machine setup" ] && echo "$3" >"$FAKE_STATE/names"\n[ "$1 $2" = "machine show" ] && cat "$FAKE_STATE/names"\n' +
    '[ "$1 $2" = "autostart status" ] && grep -q "autostart install" "$FAKE_LOG/factory.log" && echo "autostart: on"\nexit 0\n');
  return repo;
}

export function addUserTools(m: Machine, node = "v24.1.0"): void {
  const bin = (m.env.PATH as string).split(":")[0] as string;
  const tools: Record<string, string> = { node: `echo ${node}`, claude: "echo 2.1.0", gh: '[ -f "$FAKE_STATE/gh-login" ]',
    "dockerd-rootless-setuptool.sh": 'echo "$*" >>"$FAKE_LOG/setuptool.log"; echo rootless >"$FAKE_STATE/dockerinfo-rootless"' };
  for (const [name, body] of Object.entries(tools)) writeExe(join(bin, name), "#!/bin/bash\n" + body + "\n");
  write(join(m.state, "dockerinfo"), '["name=seccomp,profile=builtin","name=rootless"]');
}

export class Rep implements S.Report {
  lines: [string, string, string][] = [];
  fixes = 0;
  ok(what: string): void {
    this.lines.push(["ok", what, ""]);
  }
  fix(what: string, how: string): void {
    this.fixes += 1;
    this.lines.push(["fix", what, how]);
  }
  note(what: string, how: string): void {
    this.lines.push(["note", what, how]);
  }
  text(): string {
    return this.lines.map(([k, w, h]) => `${k} ${w} ${h}`).join("\n");
  }
}
