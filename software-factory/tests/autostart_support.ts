// `factory autostart` and `factory resume` test machines: a clone with a submodule-linked settings.json, and fake
// tmux, docker, systemctl, loginctl, launchctl and plutil on PATH with their own HOME and config and state folders.
// Shared by autostart.test.ts and heartbeat.test.ts. Not a test file.
import { mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Proc, runHook, sh, tmp, write, writeExe } from "./support.ts";

export const GIT: Record<string, string> = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
export const NAMES = ["menelik", "taytu", "haile", "tewodros"];

const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/tmux.log"
d="$FAKE_TMUX"; mkdir -p "$d"
case "$1" in
  has-session) name="\${3#=}"; [ -f "$d/$name" ] ;;
  new-session)
    shift; name=""
    while [ $# -gt 0 ]; do
      case "$1" in -s) name="$2"; shift 2 ;; -c) echo "$2" >"$d/$name.dir"; shift 2 ;; -d) shift ;; *) break ;; esac
    done
    printf '%s\\n' "$*" >"$d/$name" ;;
esac
`;

// Fails \`docker info\` the first $FAKE_DOCKER_FAILS times it is asked (a Docker that is still starting).
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/docker.log"
n="$FAKE_LOG/docker.fails"; [ -f "$n" ] || echo "\${FAKE_DOCKER_FAILS:-0}" >"$n"
left="$(cat "$n")"
if [ "$left" -gt 0 ]; then echo $((left - 1)) >"$n"; echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
exit 0
`;

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/systemctl.log"
d="$FAKE_SYSTEMD"; mkdir -p "$d"
[ "$1" = "--user" ] || { echo "only --user" >&2; exit 1; }
shift
case "$1" in
  show-environment) [ -z "\${FAKE_NO_BUS:-}" ] || { echo "Failed to connect to bus" >&2; exit 1; } ;;
  daemon-reload) ;;
  enable) u="$2"; [ "$2" = "--now" ] && u="$3"; echo 1 >"$d/$u" ;;
  disable) u="$2"; [ "$2" = "--now" ] && u="$3"; rm -f "$d/$u" ;;
  is-enabled) [ -f "$d/\${3:-$2}" ] ;;
esac
`;

// Linger is a file: \`enable-linger\` creates it, \`show-user\` answers yes or no from it.
const FAKE_LOGINCTL = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/loginctl.log"
case "$1" in
  show-user) [ -f "$FAKE_LOG/linger" ] && echo yes || echo no ;;
  enable-linger) [ -z "\${FAKE_LINGER_DENIED:-}" ] || { echo "Access denied" >&2; exit 1; }; touch "$FAKE_LOG/linger" ;;
esac
`;

const FAKE_LAUNCHCTL = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/launchctl.log"
d="$FAKE_LOG/launchd"; mkdir -p "$d"
case "$1" in
  print) l="\${2##*/}"; [ -f "$d/$l" ] ;;
  bootout) l="\${2##*/}"; [ -f "$d/$l" ] || exit 3; rm -f "$d/$l" ;;
  bootstrap) touch "$d/$(basename "$3" .plist)" ;;
esac
`;

// plutil -lint: the file must be a well-formed plist (XML with a <plist> root).
const FAKE_PLUTIL = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const t = readFileSync(process.argv[3] as string, "utf8");
if (!/^<\\?xml[^>]*\\?>\\s*(<!DOCTYPE[^>]*>\\s*)?<plist version="1.0">[\\s\\S]*<\\/plist>\\s*$/.test(t)) process.exit(1);
`;

export type Env = Record<string, string | undefined>;

export function shOk(cmd: string[], cwd?: string): Proc {
  const p = sh(cmd, { cwd, env: { ...process.env, ...GIT } });
  if (p.code !== 0) throw new Error(`${cmd.join(" ")}: ${p.out}`);
  return p;
}

/** A clone (named proj) of a bare origin; .claude/factory/settings.json (the agents' rules) is a link into a submodule, as in a real project. */
export function project(cfg: unknown = null): string {
  const top = tmp();
  const [kit, origin, work, seedKit] = ["kit.git", "origin.git", "seed", "kit-seed"].map((n) => join(top, n)) as [string, string, string, string];
  write(join(seedKit, "kit", "settings.json"), JSON.stringify({ hooks: {} }));
  shOk(["git", "init", "-q", "-b", "main", seedKit]);
  shOk(["git", "add", "-A"], seedKit);
  shOk(["git", "commit", "-qm", "kit"], seedKit);
  shOk(["git", "clone", "-q", "--bare", seedKit, kit]);
  shOk(["git", "init", "-q", "-b", "main", work]);
  shOk(["git", "submodule", "add", "-q", kit, "vendor/my-skills"], work);
  write(join(work, "docs", "a.txt"), "one\n");
  write(join(work, "docs", "b.txt"), "two\n");
  write(join(work, ".claude", "factory.json"), JSON.stringify(cfg ?? { agents: NAMES }));
  mkdirSync(join(work, ".claude", "factory"), { recursive: true });
  symlinkSync("../../vendor/my-skills/kit/settings.json", join(work, ".claude", "factory", "settings.json"));
  shOk(["git", "add", "-A"], work);
  shOk(["git", "commit", "-qm", "project"], work);
  shOk(["git", "clone", "-q", "--bare", work, origin]);
  const clone = join(top, "proj");
  shOk(["git", "clone", "-q", "--recurse-submodules", origin, clone]);
  return clone;
}

/** The environment of a machine: fake tools first on PATH, and its own HOME, config and state folders. With
 * tmux false the PATH holds only the fakes and the few real tools the scripts need, so there is no tmux at all. */
export function machine(clone: string, extra: Env = {}, tmux = true): Env {
  const top = dirname(clone);
  const bin = join(top, "bin");
  const log = join(top, "log");
  mkdirSync(log, { recursive: true });
  const fakes: [string, string][] = [["docker", FAKE_DOCKER], ["systemctl", FAKE_SYSTEMCTL], ["loginctl", FAKE_LOGINCTL],
    ["launchctl", FAKE_LAUNCHCTL], ["plutil", FAKE_PLUTIL], ["claude", "#!/bin/sh\necho claude\n"]];
  if (tmux) fakes.push(["tmux", FAKE_TMUX]);
  for (const [name, body] of fakes) writeExe(join(bin, name), body);
  let pathVar = `${bin}:${process.env.PATH}`;
  if (!tmux) {
    for (const tool of ["git", "bun", "bash", "sh", "env", "sleep", "hostname", "cat", "uname", "ps", "dirname", "basename",
      "mkdir", "rm", "touch"]) {
      const real = Bun.which(tool);
      try {
        if (real) symlinkSync(real, join(bin, tool));
      } catch {
        // already there
      }
    }
    pathVar = bin;
  }
  const env: Env = { ...process.env, ...GIT, PATH: pathVar, HOME: join(top, "home"), FACTORY_CONFIG_DIR: join(top, "config"),
    XDG_STATE_HOME: join(top, "state"), XDG_CONFIG_HOME: join(top, "home", ".config"), XDG_RUNTIME_DIR: join(top, "run"),
    FAKE_LOG: log, FAKE_TMUX: join(top, "tmux"), FAKE_SYSTEMD: join(top, "systemd"), FACTORY_AUTOSTART_PLATFORM: "linux",
    FACTORY_MACHINE_ID: "aaaa1111", FACTORY_RESUME_WAIT: "3", FACTORY_RESUME_POLL: "0.1" };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR", "CLAUDECODE", "DOCKER_HOST",
    "FACTORY_CI_PLATFORM"]) delete env[k];
  mkdirSync(env.XDG_RUNTIME_DIR as string, { recursive: true });
  return { ...env, ...extra };
}

export function machineFile(env: Env, data: Record<string, unknown>): void {
  write(join(env.FACTORY_CONFIG_DIR as string, "proj.json"), JSON.stringify(data));
}

export function state(env: Env, ...parts: string[]): string {
  return join(env.XDG_STATE_HOME as string, "proj-factory", ...parts);
}

/** A hook (by name, without .ts) run in the clone with the machine's environment. */
export function hook(name: string, clone: string, env: Env, ...args: string[]): Proc {
  return runHook(name, args, { cwd: clone, env, timeoutMs: 120_000 });
}

export function log(env: Env, name: string): string {
  try {
    return readFileSync(join(env.FAKE_LOG as string, name + ".log"), "utf8");
  } catch {
    return "";
  }
}

export function sessions(env: Env): string[] {
  try {
    return readdirSync(env.FAKE_TMUX as string).filter((f) => !f.endsWith(".dir")).sort();
  } catch {
    return [];
  }
}

/** The values of an XML plist (what plistlib.load gave the Python tests): dict, array, string, integer, real, true/false. */
export function parsePlist(text: string): unknown {
  const tokens = [...text.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, "").matchAll(/<(\/?)(\w+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g)];
  let i = 0;
  const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const skipText = () => {
    while (i < tokens.length && tokens[i]?.[2] === undefined && !(tokens[i]?.[4] ?? "").trim()) i++;
  };
  const value = (): unknown => {
    skipText();
    const t = tokens[i++] as RegExpMatchArray;
    const tag = t[2];
    if (t[3]) return tag === "true" ? true : tag === "false" ? false : tag === "dict" ? {} : tag === "array" ? [] : "";
    if (tag === "plist") {
      const v = value();
      skipText();
      i++;
      return v;
    }
    if (tag === "string" || tag === "integer" || tag === "real" || tag === "key") {
      let s = "";
      if (tokens[i]?.[4] !== undefined) s = tokens[i++]?.[4] as string;
      i++; // the closing tag
      return tag === "string" || tag === "key" ? unesc(s) : Number(s);
    }
    if (tag === "array") {
      const out: unknown[] = [];
      for (;;) {
        skipText();
        if (tokens[i]?.[1] === "/") { i++; return out; }
        out.push(value());
      }
    }
    if (tag === "dict") {
      const out: Record<string, unknown> = {};
      for (;;) {
        skipText();
        if (tokens[i]?.[1] === "/") { i++; return out; }
        const k = value() as string;
        out[k] = value();
      }
    }
    throw new Error(`plist: unexpected <${tag}>`);
  };
  return value();
}
