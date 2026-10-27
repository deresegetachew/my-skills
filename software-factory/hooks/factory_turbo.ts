#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory turbo`: the shared self-hosted Turborepo remote cache for the agents and CI (#59).
//
// Every agent worktree, every machine and every CI job used to build, type-check and test the same unchanged packages
// from scratch. One small cache server per project (ducktors/turborepo-remote-cache, ci/compose-turbo.yaml) on the
// factory machine, reachable only on the local network or Tailscale, lets them share the results.
//
//   factory turbo status            what is set, where each part comes from, and whether the cache answers (no secrets)
//   factory turbo install [--no-github]
//                                   start the server on this machine (docker compose, restart unless-stopped), wait until it
//                                   answers, and give CI the same cache (repo variables TURBO_API and TURBO_TEAM, secrets
//                                   TURBO_TOKEN and TURBO_REMOTE_CACHE_SIGNATURE_KEY, sent on stdin). Run it again to update.
//   factory turbo down [--purge]    stop it (--purge also removes the stored artifacts)
//   factory turbo env               export lines for an agent session (used by factory-loop.sh and the session hook);
//                                   prints the token, so only eval it. Prints nothing while the cache is not set up.
//   factory turbo ci-env            KEY=value lines for $GITHUB_ENV in the CI workflow, from the job's environment only
//
// Settings (the `turbo` block of .claude/factory.json; `factory settings` lists them): api (the address agents and CI
// use, for example http://100.64.0.7:3335; empty: the cache is off), team (default: the repository's name), bind and
// port (where the server listens on this machine; 127.0.0.1 unless you choose a Tailscale or LAN address), and
// secretsCommand (a command that prints TURBO_TOKEN=... and TURBO_REMOTE_CACHE_SIGNATURE_KEY=... lines, for example
// `sops -d --output-type dotenv secrets/factory.yaml`). The environment wins over the command, and the code works
// without any of it: no token or an unreachable cache means the local Turborepo cache only, with a note saying why.
//
// The token and the signature key are never written to a file, never put in an argument and never printed, except by
// `env` and `ci-env`, whose output is meant for the shell and for $GITHUB_ENV.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { type Config, load } from "./factory_config.ts";
import { Exit, git, now, pyRepr, run, runMain, shQuote, sleepSync, splitLines, which } from "./factory_lib.ts";

const HERE = import.meta.dir;
export const DEFAULTS = { api: "", team: "", bind: "127.0.0.1", port: 3335, secretsCommand: "" };
export const SECRET_KEYS = ["TURBO_TOKEN", "TURBO_REMOTE_CACHE_SIGNATURE_KEY"] as const;
// Seconds Turborepo waits for the cache before it builds locally. Its default is much longer.
const CACHE_TIMEOUT = "10";
const VALUE = /^[A-Za-z0-9._~+/=:-]{8,512}$/;
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];
const SETUP_HINT = "Make a token once with `openssl rand -hex 32` and keep it where only you can read it, for example in " +
  "your sops secrets file. Then either export TURBO_TOKEN in your shell profile, or set " +
  "turbo.secretsCommand to a command that prints TURBO_TOKEN=<token> (and, for signed artifacts, " +
  "TURBO_REMOTE_CACHE_SIGNATURE_KEY=<32 or more characters>), for example " +
  "`factory settings set turbo.secretsCommand 'sops -d --output-type dotenv secrets/factory.yaml'`.";
const LOCAL_ONLY = "Builds use the local cache only.";

type Env = Record<string, string | undefined>;
export type Secrets = Partial<Record<(typeof SECRET_KEYS)[number], string>>;

export interface TurboSettings {
  api: string;
  team: string;
  bind: string;
  port: number;
  secretsCommand: string;
  fromEnvApi: boolean;
}

/** A setting that is no use (Python's ValueError from settings()). */
export class TurboSettingError extends Error {}

function say(text: string, toStdout = false): void {
  (toStdout ? process.stdout : process.stderr).write(`factory turbo: ${text}\n`);
}

function die(text: string): never {
  say(text);
  throw new Exit(1);
}

// ---------- settings ----------
function repoName(): string {
  const p = git(["config", "--get", "remote.origin.url"]);
  const m = p.code === 0 ? /github\.com[:/][\w.-]+\/([\w.-]+?)(?:\.git)?\/?$/.exec(p.stdout.trim()) : null;
  return m ? (m[1] as string).toLowerCase() : "";
}

function hostOf(api: string): string | null {
  try {
    const h = new URL(api).hostname;
    return h.replace(/^\[(.*)\]$/, "$1") || null;
  } catch {
    return null;
  }
}

/** The turbo settings, the environment over factory.json. Throws TurboSettingError for an address that is no use. */
export function settings(cfg: Partial<Config> | Record<string, unknown>, environ: Env = process.env): TurboSettings {
  const mine = (cfg as Record<string, unknown>).turbo;
  const s: Record<string, unknown> = { ...DEFAULTS, ...(mine && typeof mine === "object" ? mine : {}) };
  const api = String(environ.TURBO_API || s.api || "").trim().replace(/\/+$/, "");
  const team = String(environ.TURBO_TEAM || s.team || repoName() || "factory");
  if (api) {
    const bad = () => new TurboSettingError(`the cache address ${pyRepr(api)} must be http:// or https:// with a host, and no ` +
      "user, password or spaces in it. Set it with `factory settings set turbo.api http://<host>:<port>`.");
    let u: URL;
    try {
      u = new URL(api);
    } catch {
      if (/^https?:\/\/[^/\s@]+:[^/\s]*/i.test(api) && !/\s/.test(api)) {
        throw new TurboSettingError(`the cache address ${pyRepr(api)} has an invalid port.`);
      }
      throw bad();
    }
    if (/\s/.test(api) || !["http:", "https:"].includes(u.protocol) || !u.hostname || u.username || u.password) throw bad();
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(team)) {
    throw new TurboSettingError(`the team ${pyRepr(team)} must be letters, digits, dots, dashes or underscores. ` +
      "Set it with `factory settings set turbo.team <name>`.");
  }
  return { api, team, bind: String(s.bind), port: Math.trunc(Number(s.port)), secretsCommand: String(s.secretsCommand || ""),
    fromEnvApi: Boolean(environ.TURBO_API) };
}

// ---------- secrets ----------
function scrub(text: string, secrets: Iterable<string | undefined>): string {
  for (const value of secrets) if (value) text = text.split(value).join("***");
  return text;
}

function parseDotenv(text: string): Secrets {
  const found: Secrets = {};
  for (let line of splitLines(text)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((SECRET_KEYS as readonly string[]).includes(key)) {
      if (value.length >= 2 && value[0] === value[value.length - 1] && `'"`.includes(value[0] as string)) value = value.slice(1, -1);
      found[key as keyof Secrets] = value;
    }
  }
  return found;
}

/** [secrets, where, notes]: TURBO_TOKEN and TURBO_REMOTE_CACHE_SIGNATURE_KEY from the environment first, then from
 * the owner's secrets command. `where` says which. Never throws; a bad value is left out and noted (not shown). */
export function resolveSecrets(s: TurboSettings, environ: Env = process.env, runCommand = true):
  [Secrets, Record<string, string>, string[]] {
  const found: Secrets = {};
  const where: Record<string, string> = {};
  const notes: string[] = [];
  for (const key of SECRET_KEYS) {
    if (environ[key]) {
      found[key] = environ[key];
      where[key] = "the environment";
    }
  }
  if (runCommand && s.secretsCommand && SECRET_KEYS.some((k) => !(k in found))) {
    const p = run(["/bin/sh", "-c", s.secretsCommand], { timeoutMs: 60_000 });
    if (p.timedOut) notes.push("turbo.secretsCommand didn't finish (TimeoutExpired).");
    else {
      const parsed = parseDotenv(p.stdout);
      if (p.code !== 0) {
        const err = scrub(splitLines(p.stderr.trim())[0] ?? "", Object.values(parsed)).slice(0, 160);
        notes.push(`turbo.secretsCommand failed (exit ${p.code})` + (err ? `: ${err}` : "") + ".");
      }
      for (const [key, value] of Object.entries(parsed) as [keyof Secrets, string][]) {
        if (!(key in found) && value) {
          found[key] = value;
          where[key] = "turbo.secretsCommand";
        }
      }
    }
  }
  for (const key of Object.keys(found) as (keyof Secrets)[]) {
    if (!VALUE.test(found[key] as string)) {
      notes.push(`${key} is left out: a value must be 8 to 512 letters, digits or . _ ~ + / = : - (no ` +
        "spaces, quotes or newlines).");
      delete found[key];
      delete where[key];
    }
  }
  return [found, where, notes];
}

// ---------- the cache ----------
export type ProbeState = "ok" | "rejected" | "down" | "http";
export type Probe = (api: string, team: string, token: string, timeout?: number) => Promise<[ProbeState, string]>;

function errorName(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  const names: Record<string, string> = { ECONNREFUSED: "ConnectionRefusedError", ECONNRESET: "ConnectionResetError",
    ETIMEDOUT: "TimeoutError", ENOTFOUND: "gaierror", EAI_AGAIN: "gaierror", EHOSTUNREACH: "OSError",
    ENETUNREACH: "OSError" };
  return (code && names[code]) || (e instanceof Error && e.name !== "Error" ? e.name : "OSError");
}

/** [state, detail]: ok, rejected, down or http. The machine's own proxy settings are ignored: the cache is private. */
export function probe(api: string, team: string, token: string, timeout = 3): Promise<[ProbeState, string]> {
  return new Promise((done) => {
    let url: URL;
    try {
      url = new URL(`${api}/v8/artifacts/status?slug=${encodeURIComponent(team)}`);
    } catch {
      done(["down", "ValueError"]);
      return;
    }
    const make = url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: [ProbeState, string]): void => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        done(r);
      }
    };
    try {
      const req = make(url, { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: timeout * 1000 }, (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        if (status >= 200 && status < 300) finish(["ok", ""]);
        else if (status === 401 || status === 403) finish(["rejected", ""]);
        else finish(["http", `HTTP ${status}`]);
      });
      req.on("timeout", () => {
        req.destroy();
        finish(["down", "TimeoutError"]);
      });
      req.on("error", (e) => finish(["down", errorName(e)]));
      // The socket timeout does not cover every connect (an address nothing answers): a hard limit too.
      timer = setTimeout(() => {
        req.destroy();
        finish(["down", "TimeoutError"]);
      }, timeout * 1000);
      req.end();
    } catch (e) {
      finish(["down", errorName(e)]);
    }
  });
}

export function explain(api: string, state: ProbeState, detail: string): string {
  if (state === "rejected") {
    return `the cache at ${api} rejected the token (the token in use differs from the one the server was started ` +
      `with). ${LOCAL_ONLY} Run \`factory turbo install\` again after changing the token.`;
  }
  if (state === "http") return `the cache at ${api} answered ${detail}, not what a cache says. ${LOCAL_ONLY}`;
  return `the cache at ${api} can't be reached (${detail || "no answer"}). Is \`factory turbo install\` done on the ` +
    `cache machine, and is this machine on the same network or Tailscale? ${LOCAL_ONLY}`;
}

/** [env, unset, notes] for an agent session. All empty while the cache is not set up (turbo.api empty). When it is
 * set up but unusable, `unset` names the variables to clear, so a stale value from an earlier shell is not left. */
export async function agentEnv(cfg: Partial<Config> | Record<string, unknown>, environ: Env = process.env,
  probeFn: Probe = probe): Promise<[Record<string, string>, string[], string[]]> {
  let s: TurboSettings;
  try {
    s = settings(cfg, environ);
  } catch (e) {
    if (e instanceof TurboSettingError) return [{}, [], [`${e.message} ${LOCAL_ONLY}`]];
    throw e;
  }
  if (!s.api) return [{}, [], []];
  const everything = ["TURBO_API", "TURBO_TEAM", ...SECRET_KEYS, "TURBO_REMOTE_CACHE_TIMEOUT"];
  const [secrets, , notes] = resolveSecrets(s, environ);
  const token = secrets.TURBO_TOKEN;
  if (!token) {
    return [{}, everything, [...notes, `TURBO_TOKEN isn't set, so the cache at ${s.api} isn't used. ${LOCAL_ONLY} ` +
      `${SETUP_HINT}`]];
  }
  const [state, detail] = await probeFn(s.api, s.team, token);
  if (state !== "ok") return [{}, everything, [...notes, explain(s.api, state, detail)]];
  const env: Record<string, string> = { TURBO_API: s.api, TURBO_TEAM: s.team, TURBO_TOKEN: token };
  if (secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY) env.TURBO_REMOTE_CACHE_SIGNATURE_KEY = secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY;
  env.TURBO_REMOTE_CACHE_TIMEOUT = CACHE_TIMEOUT;
  return [env, [], notes];
}

async function cmdEnv(cfg: Config): Promise<number> {
  const [env, unset, notes] = await agentEnv(cfg);
  for (const n of notes) say(n);
  for (const k of unset) console.log(`unset ${k}`);
  for (const [k, v] of Object.entries(env)) console.log(`export ${k}=${shQuote(v)}`);
  return 0;
}

/** From the job's environment only. A job never runs the project's secrets command: it is code from the branch. */
async function cmdCiEnv(): Promise<number> {
  const environ = process.env;
  const api = (environ.TURBO_API ?? "").trim();
  if (!api) return 0; // no repository variable: the cache is not set up for CI, and that is fine
  let s: TurboSettings;
  try {
    s = settings({}, environ);
  } catch (e) {
    if (!(e instanceof TurboSettingError)) throw e;
    say(`${e.message} ${LOCAL_ONLY}`);
    return 0;
  }
  const token = environ.TURBO_TOKEN ?? "";
  if (!token) {
    say(`no token in this job (a pull request from another repository gets no secrets), so the cache isn't used. ` +
      LOCAL_ONLY);
    return 0;
  }
  const [secrets, , notes] = resolveSecrets(s, environ, false);
  for (const n of notes) say(n);
  if (!secrets.TURBO_TOKEN) return 0;
  const [state, detail] = await probe(s.api, s.team, secrets.TURBO_TOKEN);
  if (state !== "ok") {
    say(explain(s.api, state, detail));
    return 0;
  }
  const lines: Record<string, string> = { TURBO_API: s.api, TURBO_TEAM: s.team, TURBO_TOKEN: secrets.TURBO_TOKEN };
  if (secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY) lines.TURBO_REMOTE_CACHE_SIGNATURE_KEY = secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY;
  lines.TURBO_REMOTE_CACHE_TIMEOUT = CACHE_TIMEOUT;
  for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
  return 0;
}

// ---------- status ----------
/** Whether turbo.json signs remote artifacts; null when there is no readable turbo.json here. */
export function turboJsonSigns(): boolean | null {
  try {
    const data = JSON.parse(readFileSync("turbo.json", "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const rc = (data as Record<string, unknown>).remoteCache ?? {};
    if (!rc || typeof rc !== "object" || Array.isArray(rc)) return null;
    return Boolean((rc as Record<string, unknown>).signature);
  } catch {
    return null; // no turbo.json here
  }
}

async function cmdStatus(cfg: Config): Promise<number> {
  let s: TurboSettings;
  try {
    s = settings(cfg);
  } catch (e) {
    if (!(e instanceof TurboSettingError)) throw e;
    console.log(`address     invalid: ${e.message}`);
    return 1;
  }
  if (!s.api) {
    console.log("The shared build cache is off: turbo.api is empty.");
    console.log("Turn it on: pick the address agents and CI will use (this machine's Tailscale or LAN address and port " +
      `${s.port}), \`factory settings set turbo.api http://<address>:${s.port}\`, \`factory settings set ` +
      "turbo.bind <address>`, then `factory turbo install`. docs/wiki/ci.md, \"A shared build cache\".");
    return 0;
  }
  const [secrets, where, notes] = resolveSecrets(s);
  let bad = 0;
  console.log(`address     ${s.api}` + (s.fromEnvApi ? "  (from the environment)" : "  (turbo.api)"));
  console.log(`team        ${s.team}`);
  console.log(`listens     ${s.bind}:${s.port} on the machine that runs the server`);
  if (secrets.TURBO_TOKEN) console.log(`token       found, from ${where.TURBO_TOKEN}`);
  else {
    bad = 1;
    console.log("token       missing. " + SETUP_HINT);
  }
  if (secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY) {
    const signs = turboJsonSigns();
    console.log(`signature   key found, from ${where.TURBO_REMOTE_CACHE_SIGNATURE_KEY}` +
      (signs !== false ? "" : "; but turbo.json has no remoteCache.signature, so nothing is signed"));
  } else console.log("signature   no key (artifacts are not signed). Optional: docs/wiki/ci.md, \"A shared build cache\".");
  for (const n of notes) console.log(`note        ${n}`);
  if (secrets.TURBO_TOKEN) {
    const [state, detail] = await probe(s.api, s.team, secrets.TURBO_TOKEN);
    if (state === "ok") console.log("cache       answers, and accepts the token");
    else {
      bad = 1;
      console.log("cache       " + explain(s.api, state, detail));
    }
  }
  return bad;
}

// ---------- install and down ----------
function composeFile(): string {
  return join(HERE, "..", "ci", "compose-turbo.yaml");
}

function projectName(s: TurboSettings): string {
  return s.team.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[-_]+|[-_]+$/g, "") + "-turbo-cache";
}

function compose(s: TurboSettings, args: string[], env: Env) {
  return run(["docker", "compose", "--file", composeFile(), "--project-name", projectName(s), ...args], { env });
}

function reachNotes(s: TurboSettings): string[] {
  const host = hostOf(s.api);
  if (s.bind === "0.0.0.0" || s.bind === "::") {
    return ["turbo.bind listens on every network interface of this machine. Prefer this machine's Tailscale or LAN " +
      "address, so only that network can reach the cache."];
  }
  if (LOOPBACK.includes(s.bind) && !LOOPBACK.includes(host ?? "")) {
    return [`turbo.api points at ${host}, but the cache listens on ${s.bind} only, so other machines and the CI ` +
      "runner containers can't reach it. Set turbo.bind to this machine's Tailscale or LAN address " +
      "(`factory settings set turbo.bind <address>`) and run `factory turbo install` again."];
  }
  return [];
}

function settingsOrDie(cfg: Config): TurboSettings {
  try {
    return settings(cfg);
  } catch (e) {
    if (e instanceof TurboSettingError) die(e.message);
    throw e;
  }
}

async function cmdInstall(cfg: Config, args: string[]): Promise<number> {
  const github = !args.includes("--no-github");
  const unknown = args.filter((a) => a !== "--no-github");
  if (unknown.length) die(`unknown option ${unknown[0]} (factory turbo install [--no-github])`);
  const s = settingsOrDie(cfg);
  if (!s.api) {
    die("turbo.api is empty, so there is no address to serve. Fix: pick this machine's Tailscale or LAN address and " +
      `run \`factory settings set turbo.api http://<address>:${s.port}\` and \`factory settings set turbo.bind ` +
      "<address>`, commit .claude/factory.json in a PR, then run this again.");
  }
  const [secrets, , notes] = resolveSecrets(s);
  for (const n of notes) say(n);
  if (!secrets.TURBO_TOKEN) die("there is no cache token. " + SETUP_HINT);
  if (!which("docker")) die("Docker isn't installed or isn't on your PATH. Fix: install Docker, then run this again.");
  if (run(["docker", "info"]).code !== 0) {
    die("Docker isn't running (or isn't reachable by this user). Fix: start Docker, then run this again.");
  }
  // The token goes to docker compose in its environment, so it is in no argument and no file.
  const env = { ...process.env, TURBO_TOKEN: secrets.TURBO_TOKEN, TURBO_CACHE_BIND: s.bind, TURBO_CACHE_PORT: String(s.port) };
  const p = compose(s, ["up", "-d"], env);
  if (p.code !== 0) die("docker compose couldn't start the cache: " + scrub(p.stderr.trim().slice(-400), Object.values(secrets)));
  console.log(`Started ${projectName(s)} (listens on ${s.bind}:${s.port}; restarts with Docker).`);
  for (const n of reachNotes(s)) console.log(`note: ${n}`);
  const deadline = now() + Number(process.env.FACTORY_TURBO_WAIT ?? "30");
  let state: ProbeState;
  let detail: string;
  for (;;) {
    [state, detail] = await probe(s.api, s.team, secrets.TURBO_TOKEN, 2);
    if (state === "ok" || now() >= deadline) break;
    sleepSync(1);
  }
  if (state === "ok") console.log(`The cache answers at ${s.api}. Agents started from now on use it (factory turbo status).`);
  else console.log(`note: ${explain(s.api, state, detail)}`);
  let failed = 0;
  if (github) failed = shareWithGithub(s, secrets);
  else {
    console.log("CI was left alone (--no-github): set the repo variables TURBO_API and TURBO_TEAM and the secrets " +
      "TURBO_TOKEN (and TURBO_REMOTE_CACHE_SIGNATURE_KEY) yourself.");
  }
  return failed;
}

function shareWithGithub(s: TurboSettings, secrets: Secrets): number {
  const steps: [string[], string | undefined, string][] = [
    [["variable", "set", "TURBO_API", "--body", s.api], undefined, "variable TURBO_API"],
    [["variable", "set", "TURBO_TEAM", "--body", s.team], undefined, "variable TURBO_TEAM"]];
  for (const key of SECRET_KEYS) if (key in secrets) steps.push([["secret", "set", key, "--app", "actions"], secrets[key], `secret ${key}`]);
  const done: string[] = [];
  const failed: string[] = [];
  for (const [args, stdin, what] of steps) {
    const p = run(["gh", ...args], stdin !== undefined ? { input: stdin } : {});
    (p.code === 0 ? done : failed).push(what);
  }
  if (done.length) console.log("CI now has: " + done.join(", ") + ".");
  if (failed.length) {
    console.log("note: GitHub didn't take " + failed.join(", ") + ". Setting repository variables and secrets needs " +
      "admin on the repository: ask an admin to run this, or set them under Settings > Secrets and variables " +
      "> Actions (the values: `factory turbo env` prints them, carefully).");
    return 1;
  }
  console.log("Jobs from pull requests in this repository use the cache; those from forks get no secrets and don't.");
  return 0;
}

function cmdDown(cfg: Config, args: string[]): number {
  const purge = args.includes("--purge");
  if (args.some((a) => a !== "--purge")) die("usage: factory turbo down [--purge]");
  const s = settingsOrDie(cfg);
  if (!which("docker")) die("Docker isn't installed or isn't on your PATH.");
  const p = compose(s, ["down", "--remove-orphans", ...(purge ? ["--volumes"] : [])], { ...process.env, TURBO_TOKEN: "x" });
  if (p.code !== 0) die("docker compose couldn't stop the cache: " + p.stderr.trim().slice(-400));
  console.log(`Stopped ${projectName(s)}` + (purge ? " and removed the stored artifacts." : ". Its artifacts are kept."));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (process.env.CLAUDE_PROJECT_DIR === undefined) {
    const root = git(["rev-parse", "--show-toplevel"]);
    if (root.code === 0) process.env.CLAUDE_PROJECT_DIR = root.stdout.trim();
  }
  const cfg = load();
  const cmd = argv[0] ?? "status";
  const args = argv.slice(1);
  if (cmd === "env") return cmdEnv(cfg);
  if (cmd === "ci-env") return cmdCiEnv();
  if (cmd === "status") return cmdStatus(cfg);
  if (cmd === "install") return cmdInstall(cfg, args);
  if (cmd === "down") return cmdDown(cfg, args);
  die("usage: factory turbo status | install [--no-github] | down [--purge] | env | ci-env");
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
