#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The names a project's self-hosted CI runner uses, as shell assignments for `factory ci` (ci.sh).
//
// Every name comes from the project, so two projects can run their runners side by side on one Mac:
//
//   CI_REPO      owner/name on GitHub                  "ci.repo" in .claude/factory.json, else `gh repo view`,
//                                                      else the origin remote
//   CI_NAME      the runner's name                     "ci.name", else "<repo name>-ci"         (remanual-ci)
//   CI_LABEL     the label jobs ask for                "ci.label", else "<repo name>-local"     (remanual-local)
//   CI_AGENT     the LaunchAgent's label               dev.software-factory.<name>
//   CI_PLIST     ~/Library/LaunchAgents/<agent>.plist
//   CI_INSTALLED ~/Library/Application Support/<name>  the private copy launchd runs (never the checkout)
//   CI_STATE     ~/.local/state/<name>                 the log and the pid of a loop started by hand
//   CI_REPLACES  "ci.replaces": LaunchAgent labels of an older install to unload first
//   CI_RUNNERS   "ci.runners": heavy runner loops on this machine (default 1); FACTORY_CI_RUNNERS overrides it here
//   CI_LIGHT     1 unless "ci.light" is false: one more, small loop without Docker for light jobs
//   CI_LIGHT_LABEL "ci.lightLabel", else "<repo name>-light"                                  (remanual-light)
//   CI_IMAGE     "ci.image": "build" (default: build runner.Dockerfile with the project's Node, pnpm and Playwright)
//                or "base" (GitHub's plain runner image)
//   CI_CACHES    1 unless "ci.caches" is false: a pull-through Docker Hub mirror outlives a job
// On Linux (FACTORY_CI_PLATFORM=linux, set by ci.sh) a systemd --user service runs it instead of launchd:
//   CI_UNIT      <name>.service
//   CI_UNIT_FILE ~/.config/systemd/user/<name>.service  ($XDG_CONFIG_HOME)
//   CI_INSTALLED ~/.local/share/<name>                   ($XDG_DATA_HOME), the private copy systemd runs
//
//   bun ci_names.ts            prints them as `NAME=value` lines, quoted for `eval` in bash
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Self-contained (no import from ../hooks): ci.sh runs it from wherever its own folder is, alone.

/** Stop with a message on stderr and exit 1 (Python's SystemExit("text")). */
function die(text: string): never {
  process.stderr.write(text + "\n");
  process.exit(1);
}

/** A Python-style repr of a string ('text'). */
function pyRepr(s: string): string {
  return s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The shell-safe form of a word (shlex.quote). */
function shQuote(s: string): string {
  if (s === "") return "''";
  return /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

const SAFE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export type CiSettings = { [key: string]: unknown };

function run(...a: string[]): [number, string] {
  try {
    const p = Bun.spawnSync(a, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    if (p.exitCode === null) return [1, ""];
    return [p.exitCode, p.stdout.toString().trim()];
  } catch {
    return [1, ""];
  }
}

function isObject(v: unknown): v is { [key: string]: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** "ci" from .claude/factory.json ({} when there is none). */
export function config(): CiSettings {
  let text: string;
  try {
    text = readFileSync(join(".claude", "factory.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const data = JSON.parse(text) as unknown;
  const ci = isObject(data) ? data.ci : undefined;
  return isObject(ci) ? ci : {};
}

function repoFromRemote(): string | null {
  const [rc, url] = run("git", "config", "--get", "remote.origin.url");
  const m = rc === 0 ? /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url) : null;
  return m ? (m[1] as string) : null;
}

function repr(v: unknown): string {
  if (typeof v === "string") return pyRepr(v);
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Python's int() for a setting: a whole number, a bool, a float (truncated) or a numeric string; null otherwise. */
function toInt(raw: unknown): number | null {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.trunc(raw) : null;
  if (typeof raw === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(raw)) return Number(raw.trim().replace(/_/g, ""));
  return null;
}

/** The names, from the "ci" settings. Stops with a message when one is missing or unsafe. */
export function names(cfg: CiSettings): Record<string, string> {
  let repo = cfg.repo ? String(cfg.repo) : "";
  if (!repo) {
    const [rc, out] = run("gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");
    repo = (rc === 0 && REPO.test(out) ? out : repoFromRemote()) ?? "";
  }
  if (!repo || !REPO.test(repo)) {
    die("factory ci: can't tell this project's GitHub repository. Set \"ci\": {\"repo\": " +
      "\"owner/name\"} in .claude/factory.json, or log in with `gh auth login`.");
  }
  const base = (repo.split("/")[1] as string).toLowerCase();
  const name = cfg.name ? String(cfg.name) : `${base}-ci`;
  const label = cfg.label ? String(cfg.label) : `${base}-local`;
  const lightLabel = cfg.lightLabel ? String(cfg.lightLabel) : `${base}-light`;
  const raw: unknown = process.env.FACTORY_CI_RUNNERS || ("runners" in cfg ? cfg.runners : 1);
  const runners = toInt(raw);
  if (runners === null) die(`factory ci: ci.runners (or FACTORY_CI_RUNNERS) must be a whole number, not ${repr(raw)}.`);
  if (!(runners >= 1 && runners <= 16)) die(`factory ci: ci.runners is ${runners}; use 1 to 16.`);
  if (lightLabel === label) {
    die(`factory ci: ci.lightLabel must differ from ci.label (${pyRepr(label)}): with one label, light jobs ` +
      "would wait behind heavy ones again.");
  }
  const light = cfg.light !== false;
  const image = cfg.image ? String(cfg.image) : "build";
  if (image !== "build" && image !== "base") die(`factory ci: ci.image is ${pyRepr(image)}; use "build" or "base".`);
  const caches = cfg.caches !== false;
  for (const [what, value] of [["name", name], ["label", label], ["lightLabel", lightLabel]] as const) {
    if (!SAFE.test(value)) {
      die(`factory ci: the ${what} ${pyRepr(value)} must be lowercase letters, digits, dots, dashes or ` +
        "underscores (up to 48), starting with a letter or digit.");
    }
  }
  // LaunchAgents of an older install under other names (a project's own runner from before `factory ci`):
  // `factory ci install` unloads them first, so two loops never compete for the same jobs.
  const replaces = (Array.isArray(cfg.replaces) ? cfg.replaces : []).filter((a): a is string => typeof a === "string");
  for (const a of replaces) {
    if (!/^[\w.-]{1,128}$/.test(a)) die(`factory ci: ${pyRepr(a)} in ci.replaces isn't a LaunchAgent label.`);
  }
  const home = process.env.HOME || homedir();
  const stateHome = process.env.XDG_STATE_HOME || join(home, ".local", "state");
  const agent = `dev.software-factory.${name}`;
  const linux = process.env.FACTORY_CI_PLATFORM === "linux";
  const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const dataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share");
  return {
    CI_REPO: repo,
    CI_NAME: name,
    CI_LABEL: label,
    CI_AGENT: agent,
    CI_PLIST: join(home, "Library", "LaunchAgents", `${agent}.plist`),
    CI_INSTALLED: linux ? join(dataHome, name) : join(home, "Library", "Application Support", name),
    CI_UNIT: `${name}.service`,
    CI_UNIT_FILE: join(configHome, "systemd", "user", `${name}.service`),
    CI_STATE: join(stateHome, name),
    CI_REPLACES: replaces.join(" "),
    CI_RUNNERS: String(runners),
    CI_LIGHT: light ? "1" : "0",
    CI_LIGHT_LABEL: lightLabel,
    CI_IMAGE: image,
    CI_CACHES: caches ? "1" : "0",
  };
}

function main(): void {
  for (const [k, v] of Object.entries(names(config()))) console.log(`${k}=${shQuote(v)}`);
}

if (import.meta.main) main();
