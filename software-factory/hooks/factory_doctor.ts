#!/usr/bin/env -S bun --no-env-file
// `factory doctor`: check this machine and project for what the factory needs, and say how to fix each gap (#63).
//
// Read-only: it runs version and status commands, never installs, logs in, decrypts or prints a secret. Each line is
// `ok`, `fix` (the factory won't work until it's fixed, with the fix) or `note` (worth a look). Exit 1 when any `fix`.
// Checks that don't apply to the project (Node without a package.json, sops without a .sops.yaml) are left out.
//
//   bun --no-env-file .claude/hooks/factory_doctor.ts [--sandbox]
//
// `--sandbox` adds the checks of a sandboxed factory machine (factory_sandbox.ts): run it as the dedicated user that
// `factory bootstrap` made. It runs a few network probes and one container, so it takes longer.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as fa from "./factory_artifacts.ts";
import * as autostart from "./factory_autostart.ts";
import { missingOriginMain } from "./factory_claims.ts";
import { type Config, load, roleNames, rolesDir } from "./factory_config.ts";
import * as doctorCi from "./factory_doctor_ci.ts";
import * as heartbeat from "./factory_heartbeat_service.ts";
import { Exit, FactoryError, fnmatch, run as runProc, runMain, splitLines, which } from "./factory_lib.ts";
import { machineNames } from "./factory_machine.ts";
import { ModelsError, resolvedDefault, table, validate } from "./factory_models.ts";
import * as fr from "./factory_release.ts";
import * as roleDefs from "./factory_roles.ts";
import { run as sandbox } from "./factory_sandbox.ts";
import { allowRules } from "./factory_stack.ts";
import * as factoryTrust from "./factory_trust.ts";
import { explain, probe, settings as turboSettings, TurboSettingError, turboJsonSigns } from "./factory_turbo.ts";

const LINUX = process.platform === "linux";

/** Where the checks report (the shape factory_doctor_ci.ts and factory_sandbox.ts take). */
export interface Reporter {
  ok(what: string): void;
  fix(what: string, how: string): void;
  note(what: string, how: string): void;
}

/** The doctor's report: one line per check. */
export class Report implements Reporter {
  fixes = 0;

  ok(what: string): void {
    console.log(`ok    ${what}`);
  }

  fix(what: string, how: string): void {
    this.fixes += 1;
    console.log(`fix   ${what}: ${how}`);
  }

  note(what: string, how: string): void {
    console.log(`note  ${what}: ${how}`);
  }
}

/** [code, stdout, stderr], stripped; a missing program or a timeout is a failure, never an exception. */
function run(cmd: string[], timeout = 20): [number, string, string] {
  const p = runProc(cmd, { timeoutMs: timeout * 1000 });
  if (p.timedOut) return [1, "", `Command '${cmd.join(" ")}' timed out after ${timeout} seconds`];
  return [p.code, p.stdout.trim(), p.stderr.trim()];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstLine(text: string): string {
  return splitLines(text)[0] ?? "";
}

export function version(text: string | null | undefined): [number, number] | null {
  const m = /(\d+)(?:\.(\d+))?/.exec(text || "");
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

const BUN_FIX = "install Bun (`curl -fsSL https://bun.sh/install | bash`), open a new terminal, then run `factory doctor` again";

/** git, Bun (every factory command and hook runs with it, #252), Claude Code and GitHub access. */
export function tools(r: Reporter): void {
  if (which("git")) r.ok("git");
  else r.fix("git", "install git");
  if (!which("bun")) {
    r.fix("bun_missing", `bun is not on the PATH, and every factory command and hook runs with it. Fix: ${BUN_FIX}`);
  } else {
    const [rc, out] = run(["bun", "--version"]);
    if (rc !== 0) r.fix("bun_missing", `\`bun --version\` fails, and every factory command and hook runs with Bun. Fix: ${BUN_FIX}`);
    else r.ok(`bun ${firstLine(out) || "(version unknown)"}`);
  }
  if (!which("claude")) {
    r.fix("Claude Code", "install it (`npm install -g @anthropic-ai/claude-code`), then run `claude` once to log in");
  } else {
    const words = run(["claude", "--version"])[1].split(/\s+/).filter(Boolean);
    r.ok("Claude Code " + (words[0] ?? "(version unknown)"));
  }
  if (!which("gh")) r.fix("GitHub CLI", "install gh (https://cli.github.com), then `gh auth login`");
  else ghAccess(r);
}

/** Why a `gh api` call failed, in a few words, from what gh printed. */
export function ghFailure(text: string | null | undefined): string {
  const t = (text || "").toLowerCase();
  if (/bad credentials|http 401|requires authentication|token.*(expired|invalid|revoked)/.test(t)) {
    return "the token was refused (bad or expired); make a new one and run `gh auth login`, or reset GH_TOKEN";
  }
  if (/could not resolve|no such host|dial tcp|timed out|timeout|connection|network|unreachable|proxy|tls|certificate/.test(t)) {
    return "can't reach github.com (no network or a proxy in the way); check the connection, then run `factory doctor` again";
  }
  if (/gh auth login|gh_token|not logged|no token|authentication/.test(t) || !t) {
    return "no token; run `gh auth login`, or set GH_TOKEN";
  }
  return "`gh api user` failed (" + firstLine(t).slice(0, 100) + "); run `gh auth login` or check GH_TOKEN";
}

/** GitHub access is judged by a real call (#157): `gh auth status` checks more than the factory needs. */
function ghAccess(r: Reporter): void {
  let [rc, out, err] = run(["gh", "api", "user"]);
  if (rc !== 0 && run(["gh", "api", "repos/{owner}/{repo}"])[0] === 0) rc = 0; // an app's token can't read /user
  if (rc !== 0) {
    r.fix("GitHub CLI", "gh can't call the GitHub API: " + ghFailure(err || out));
    return;
  }
  r.ok("gh is signed in");
  if (run(["gh", "auth", "status"])[0] !== 0) {
    r.note("gh auth status", "it reports a problem, but `gh api` works, so the factory is fine (common with GH_TOKEN)");
  }
}

/** One main branch (#196): the PR gate reads GitHub's default branch, the loop reads the file's `mainBranch`.
 * They must agree, or the loop checks out a branch that has no factory files. Skipped when gh can't say. */
export function mainBranch(r: Reporter, cfg: Config): void {
  const [rc, out] = run(["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
  const dflt = rc === 0 && out ? firstLine(out).trim() : "";
  if (!/^[\w./-]+$/.test(dflt)) return;
  const mine = cfg.mainBranch || "main";
  if (mine === dflt) r.ok(`mainBranch ${mine} is GitHub's default branch`);
  else {
    r.fix("main-branch-differs", `mainBranch in .claude/factory.json is ${mine}, but GitHub's default branch is ` +
      `${dflt}, and the PR gate reads ${dflt}. Fix: run \`factory settings set mainBranch ${dflt}\`, ` +
      `or change the default branch in the repository's settings on GitHub to ${mine}`);
  }
}

/** origin/<mainBranch> exists (#181): a clone of an empty repo has no fetch setting, so it never does. */
export function originMain(r: Reporter, cfg: Pick<Config, "mainBranch">): void {
  const main = cfg.mainBranch || "main";
  const err = missingOriginMain(main);
  if (err) r.fix(err.code, `${err.message} ${err.fix}`);
  else if (run(["git", "remote", "get-url", "origin"])[0] === 0) r.ok(`origin/${main} exists`);
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function node(r: Reporter): void {
  if (!existsSync("package.json")) return;
  const nvmrc = existsSync(".nvmrc") ? readText(".nvmrc").trim() : null;
  if (!which("node")) {
    r.fix("Node", "install Node" + (nvmrc !== null ? ` ${nvmrc} (see .nvmrc)` : ""));
    return;
  }
  const have = run(["node", "--version"])[1];
  if (nvmrc !== null) {
    const w = version(nvmrc);
    const h = version(have);
    if (w && h && h[0] !== w[0]) r.fix("Node", `${have} here, ${nvmrc} in .nvmrc: run \`nvm install && nvm use\` (or install Node ${w[0]})`);
    else r.ok(`Node ${have}`);
  } else r.ok(`Node ${have}`);
  let manager = "";
  try {
    const data = JSON.parse(readText("package.json")) as unknown;
    const pm = isObject(data) ? data.packageManager : "";
    manager = typeof pm === "string" ? pm : "";
  } catch {
    manager = "";
  }
  const tool = manager ? (manager.split("@")[0] as string) : "";
  if (tool && !which(tool)) r.fix(tool, `package.json wants ${manager}: run \`corepack enable\``);
  else if (tool) {
    const [rc, out, err] = run([tool, "--version"], 60);
    if (rc !== 0) { // corepack may fail to fetch the wanted version
      const why = err || out ? firstLine(err || out).slice(0, 120) : "no output";
      r.fix(tool, `\`${tool} --version\` fails (${why}): run \`corepack enable\` and \`corepack prepare ${manager} --activate\``);
    } else r.ok(`${tool} ${out ? firstLine(out) : ""}`.trim());
  }
}

export function docker(r: Reporter): void {
  if (!["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].some((f) => existsSync(f))) return;
  if (!which("docker")) {
    r.fix("Docker", "the project has a compose file: install Docker" + (LINUX ? " (rootless Docker is safer)" : ""));
    return;
  }
  const [rc, out] = run(["docker", "info", "--format", "{{json .SecurityOptions}}"]);
  if (rc !== 0) {
    r.fix("Docker", "installed but not reachable: start Docker" +
      (LINUX ? " (rootless: `systemctl --user start docker`, and set DOCKER_HOST)" : ""));
  } else r.ok("Docker is running" + (out.includes("rootless") ? " (rootless)" : ""));
}

/** The hook command lines of a settings file: every `command` under `hooks`. */
function hookCommands(data: unknown): string[] {
  const out: string[] = [];
  const hooks = isObject(data) ? data.hooks : null;
  if (!isObject(hooks)) return out;
  for (const group of Object.values(hooks)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      const list = isObject(entry) ? entry.hooks : null;
      if (!Array.isArray(list)) continue;
      for (const h of list) if (isObject(h) && typeof h.command === "string") out.push(h.command);
    }
  }
  return out;
}

/** The hooks .claude/settings.json runs are the factory's Bun scripts (#252): each `.claude/hooks/<name>.ts` exists
 * and is run with `bun --no-env-file`, and no line still runs a Python hook. Quiet when it runs no factory hook. */
export function hookLines(r: Reporter): void {
  let data: unknown;
  try {
    data = JSON.parse(readText(".claude/settings.json"));
  } catch {
    return; // missing (reported above) or not JSON (Claude Code and `factory update` say so)
  }
  const python = new Set<string>();
  const missing = new Set<string>();
  const notBun = new Set<string>();
  let seen = 0;
  for (const command of hookCommands(data)) {
    for (const m of command.matchAll(/\.claude\/hooks\/[\w.-]+\.py\b/g)) python.add(m[0]);
    const scripts = [...command.matchAll(/\.claude\/hooks\/[\w.-]+\.ts\b/g)].map((m) => m[0]);
    if (scripts.length) seen += 1;
    for (const script of scripts) if (!isFile(script)) missing.add(script);
    if (scripts.length && !/^\s*bun --no-env-file\s/.test(command)) notBun.add(command);
  }
  for (const script of [...python].sort()) {
    r.fix(`.claude/settings.json runs ${script}`, "the factory runs on Bun now and has no Python hooks: run `factory update` " +
      "(it writes the hook lines as `bun --no-env-file \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/<name>.ts`)");
  }
  for (const script of [...missing].sort()) {
    r.fix(`.claude/settings.json runs ${script}`, "the hook script is missing: run `factory update`");
  }
  for (const command of [...notBun].sort()) {
    r.fix(".claude/settings.json hook line", `\`${command}\` does not start with \`bun --no-env-file\`, so Bun would load the ` +
      "project's .env into the factory: run `factory update`");
  }
  if (seen && !python.size && !missing.size && !notBun.size) r.ok("the hooks in .claude/settings.json run with Bun");
}

/** The project's own workflows run factory scripts that exist (#254): after the update from the Python releases a
 * workflow could still run `python3 .claude/hooks/<name>.py`, so CI failed on every pull request. A workflow that runs
 * `bun` needs the setup-bun step too. Quiet when no workflow runs a factory script. */
export function workflows(r: Reporter): void {
  let names: string[];
  try {
    names = readdirSync(join(".github", "workflows")).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    return;
  }
  let seen = 0;
  let bad = 0;
  for (const name of names) {
    const rel = `.github/workflows/${name}`;
    const text = readText(rel);
    const scripts = new Set([...text.matchAll(/\.claude\/(?:hooks|ci)\/[\w-]+\.(?:ts|py|sh)\b/g)].map((m) => m[0]));
    if (scripts.size) seen += 1;
    for (const script of [...scripts].sort()) {
      if (script.endsWith(".py") && isFile(script.slice(0, -3) + ".ts")) {
        bad += 1;
        r.fix(`${rel} runs ${script}`, `the factory runs on Bun now: run \`factory update\` (it moves the factory's steps to ` +
          `\`bun --no-env-file ${script.slice(0, -3)}.ts\` and adds setup-bun), then commit the workflow in the update's pull request`);
      } else if (!isFile(script)) {
        bad += 1;
        r.fix(`${rel} runs ${script}`, "that script is not in this project: remove the step, or run the factory command it " +
          "stood for (`./factory <command>`)");
      }
    }
    if (/\bbun\s+--no-env-file\b/.test(text) && !text.includes("oven-sh/setup-bun")) {
      bad += 1;
      r.fix(`${rel} runs bun`, "the runner has no Bun: add `- uses: oven-sh/setup-bun@v2` after the checkout step " +
        "(after its `with:` lines), or run `factory update`");
    }
  }
  if (seen && !bad) r.ok("the workflows in .github/workflows run the factory's scripts with Bun");
}

export function project(r: Reporter, cfg: Config): void {
  const [rc, out] = run(["git", "submodule", "status"]);
  if (rc === 0 && out) {
    const bad = splitLines(out)
      .filter((l) => "-+U".includes(l.slice(0, 1)) && l.split(/\s+/).filter(Boolean).length > 1)
      .map((l) => l.split(/\s+/).filter(Boolean)[1] as string);
    if (bad.length) r.fix("submodules", `${bad.join(", ")} not at the commit main pins: run \`git submodule update --init\``);
    else r.ok("submodules");
  }
  if (existsSync(".claude/settings.json")) {
    r.ok(".claude/settings.json");
    hookLines(r);
    workflows(r);
  } else {
    r.fix(".claude/settings.json", "it doesn't resolve, so the hooks and deny rules won't load: run " +
      "`factory update` (a project on releases), or `git submodule update --init` / " +
      "`bash vendor/my-skills/software-factory/install.sh . --link` (a project on the submodule)");
  }
  if (existsSync(".env.example") && !existsSync(".env.local")) {
    r.note(".env.local", "missing; copy .env.example to .env.local and fill it in");
  }
  if (existsSync(".sops.yaml")) {
    const key = process.env.SOPS_AGE_KEY_FILE ?? "";
    if (!which("sops")) r.fix("sops", "the project keeps secrets with sops: install sops and age");
    else if (!key || !isFile(expandUser(key))) r.fix("SOPS_AGE_KEY_FILE", "set it to your age private key file, in your shell profile");
    else r.ok("sops and its age key");
  }
  const install = cfg.commands.install || "";
  if (install.includes("pnpm") && !isDir("node_modules")) r.note("node_modules", `not installed yet: run \`${install}\``);
}

function home(): string {
  return process.env.HOME || homedir();
}

function expandUser(path: string): string {
  return path === "~" || path.startsWith("~/") ? home() + path.slice(1) : path;
}

// What an unattended coding-agent run does on every task; each needs an allow rule or it stops and waits for an answer.
export const LOOP_COMMANDS = ["git fetch origin", "git add .", "git commit -m x", "git push origin task/x", "gh pr create"];
export const STALL_FREE_MODES = ["acceptEdits", "bypassPermissions", "dontAsk"];

function readJsonFile(path: string): Record<string, unknown> {
  try {
    const data = JSON.parse(readText(expandUser(path))) as unknown;
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function bashPattern(rule: unknown): string | null {
  if (typeof rule !== "string") return null;
  const m = /^Bash\((.*)\)$/.exec(rule);
  return m ? (m[1] as string) : null;
}

export function allows(rules: unknown[], command: string): boolean {
  return rules.some((rule) => {
    const pat = bashPattern(rule);
    return pat !== null && fnmatch(command, pat);
  });
}

/** Is this the factory's settings.json (it runs the PR gate)? Only then is there an allow list to judge. */
function factorySettingsText(): string | null {
  const text = existsSync(".claude/settings.json") ? readText(".claude/settings.json") : "";
  return /\.claude\/hooks\/pr-gate\.(ts|py)\b/.test(text) ? text : null;
}

/** The allow rules an unattended run gets: .claude/settings.json's and `permissions.allow` in factory.json. */
function allowList(cfg: Config): string[] {
  const settings = readJsonFile(".claude/settings.json");
  const perms = isObject(settings.permissions) ? settings.permissions : {};
  const mine = isObject(cfg.permissions) ? cfg.permissions.allow : [];
  return [...strings(perms.allow), ...strings(mine)];
}

/** How an unattended run gets its permissions (#179): the mode its `claude -p` starts with, and whether the allow
 * list covers the commands every task runs. A headless run cannot answer a prompt, so anything missing stalls it. */
export function permissions(r: Reporter, cfg: Config): void {
  const mode = cfg.permissionMode ?? "acceptEdits";
  if (mode === "acceptEdits") r.ok("permissions for unattended runs: --permission-mode acceptEdits (permissionMode)");
  else {
    const user = readJsonFile("~/.claude/settings.json");
    const mine = isObject(user.permissions) ? user.permissions.defaultMode : undefined;
    if (typeof mine === "string" && STALL_FREE_MODES.includes(mine)) {
      r.ok(`permissions for unattended runs: no flag is passed; your Claude Code settings set ${mine}`);
    } else {
      r.fix("permissionMode in .claude/factory.json", "it is `default` and your own Claude Code settings set no permission mode, so " +
        "an unattended run stops at the first edit it needs approved: run `factory settings set permissionMode acceptEdits`");
    }
  }
  if (factorySettingsText() === null) return; // not the factory's settings.json (or none): there is no allow list to judge
  const have = allowList(cfg);
  const missing = LOOP_COMMANDS.filter((c) => !allows(have, c));
  if (missing.length) {
    r.fix("allow list for unattended runs", `no rule allows ${missing.map((c) => "`" + c + "`").join(", ")}, so a headless run stops there ` +
      "waiting for an answer: add rules such as `Bash(git commit*)` to `permissions.allow` in .claude/factory.json " +
      "(or to .claude/settings.json in a project that takes the kit by link)");
  }
}

/** An unattended agent can run commands.test (#249), alone and through `./factory run-check`, which is how the
 * next-task skill runs it: the same allow-list match as the loop's commands. A headless run that would be asked stops
 * there, so the first task never gets past its tests. */
export function testAllowed(r: Reporter, cfg: Config): void {
  const test = (cfg.commands.test || "").trim();
  if (!test || factorySettingsText() === null) return;
  const have = allowList(cfg);
  const prompts = [test, `./factory run-check ${test}`].filter((c) => !allows(have, c));
  if (!prompts.length) {
    r.ok("an unattended agent can run commands.test (alone and through `./factory run-check`)");
    return;
  }
  const rules = allowRules({ stack: "python", reason: "", commands: { test }, notes: [] });
  const mine = isObject(cfg.permissions) ? strings(cfg.permissions.allow) : [];
  const wanted = [...new Set([...mine, ...rules])];
  r.fix("test-command-prompts", `no rule in permissions.allow lets an unattended agent run ${prompts.map((c) => "`" + c + "`").join(" or ")}, ` +
    "so a headless run stops there asking for approval and never gets past the tests. Fix: run " +
    `\`factory settings set permissions.allow '${JSON.stringify(wanted)}'\`, then \`factory update\``);
}

/** Claude Code ignores the whole allow list in a folder it has not been told to trust (#180). Reads the flag in
 * ~/.claude.json for the project folder and each agent worktree that exists; never writes it or prints the file.
 * A git worktree of a trusted main working tree counts as trusted, and the line says so (#246, #248). */
export function trust(r: Reporter, cfg: Config): void {
  const common = run(["git", "rev-parse", "--git-common-dir"])[1];
  let top = dirname(resolve(common));
  try {
    top = realpathSync(top);
  } catch {
    // keep it as it is
  }
  const names = [...(Array.isArray(cfg.agents) ? cfg.agents : [])].filter((n): n is string => typeof n === "string").sort();
  const paths = [top, ...names.map((n) => join(top + "-agents", n))];
  for (const path of paths.filter(isDir)) {
    const found = factoryTrust.state(path);
    if (found === "trusted") {
      const main = factoryTrust.inheritedFrom(path);
      r.ok(`Claude Code trusts ${path}` +
        (main ? ` (a git worktree of ${main}, which is trusted; Claude Code writes no entry for a worktree)` : ""));
    } else if (found === "untrusted") {
      r.fix(`Claude Code does not trust ${path}`, "it would ignore the allow list in .claude/settings.json and an unattended " +
        `run would stop at its first command: run \`cd ${path} && claude\` yourself and answer yes to the trust question ` +
        "(the factory never sets the flag)");
    } else {
      r.note("Claude Code trust", "~/.claude.json has no folder list to check yet: run `claude` in the project once and answer " +
        "the trust question; do the same in each agent worktree");
      return;
    }
  }
}

/** CI, the runners and the agents' leftovers (#205): factory_doctor_ci.ts. Read-only; needs GitHub to answer. */
export function ci(r: Reporter, cfg: Config): void {
  doctorCi.checks(r, cfg);
}

export const ZERO_TESTS = /NO TESTS RAN|Ran 0 tests|collected 0 items|no tests ran/i;

/** commands.test runs at least one test (#244). Only a Python test command (unittest or pytest) is run, once, with a
 * short timeout, so doctor stays quick and offline-safe; a command that fails for another reason is left to CI. */
export function testCommand(r: Reporter, cfg: Config): void {
  const command = cfg.commands.test || "";
  if (!/unittest|pytest/.test(command)) return;
  let out: string;
  try {
    const p = Bun.spawnSync(["/bin/sh", "-c", command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    if (p.exitCode === null) {
      r.note("commands.test", "skipped: it took more than 30 seconds, so doctor did not wait for it");
      return;
    }
    out = p.stdout.toString() + p.stderr.toString();
  } catch (e) {
    r.note("commands.test", `skipped: could not run it (${errText(e)})`);
    return;
  }
  if (ZERO_TESTS.test(out)) {
    r.fix("no-tests-ran", `\`${command}\` ran 0 tests (NO TESTS RAN), so CI would be red on the first pull request. ` +
      "Fix: point commands.test at the folder the tests are in, for example " +
      "`factory settings set commands.test \"python3 -m unittest discover -s tests\"`, or add an empty " +
      "tests/__init__.py");
  } else r.ok("commands.test runs tests");
}

function report(r: Reporter, lines: autostart.DoctorLine[]): void {
  for (const [level, what, how] of lines) {
    if (level === "ok") r.ok(what + (how ? `: ${how}` : ""));
    else if (level === "fix") r.fix(what, how);
    else r.note(what, how);
  }
}

export function factory(r: Reporter, cfg: Config): void {
  if (which("factory")) r.ok("`factory` is on your PATH");
  else r.note("`factory` command", "run `./factory install-shim` once, and add ~/.local/bin to PATH");
  const names = Array.isArray(cfg.agents) ? cfg.agents.map(String) : [];
  const only = machineNames();
  const unknown = only.filter((n) => !names.includes(n));
  if (unknown.length) {
    r.fix("FACTORY_AGENTS / machine names file", `${unknown.join(", ")} aren't in \`agents\` in .claude/factory.json (${names.join(", ")})`);
  } else if (only.length) r.ok(`this machine runs ${only.join(", ")} (FACTORY_AGENTS or the machine names file)`);
  else {
    r.note("FACTORY_AGENTS", "not set; fine on one machine. With several, give each its own names, for example " +
      `\`export FACTORY_AGENTS=${names.slice(0, 2).join(",")}\``);
  }
  for (const doctor of [autostart.doctor, heartbeat.doctor]) {
    try {
      report(r, doctor(cfg));
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
    }
  }
  if (process.platform === "darwin") r.note("sleep", "keep the Mac awake while agents run (`caffeinate -d` in another tab)");
}

/** The shared Turborepo cache (#59): only when turbo.api is set. Never runs turbo.secretsCommand (that decrypts). */
export async function turbo(r: Reporter, cfg: Config): Promise<void> {
  let s;
  try {
    s = turboSettings(cfg);
  } catch (e) {
    if (!(e instanceof TurboSettingError)) throw e;
    r.note("shared build cache", e.message);
    return;
  }
  if (!s.api) return;
  if (process.env.TURBO_TOKEN) r.ok("shared build cache token: TURBO_TOKEN is set");
  else if (s.secretsCommand) r.ok("shared build cache token: from turbo.secretsCommand (not run here; `factory turbo status` runs it)");
  else {
    r.note("shared build cache token", "TURBO_TOKEN isn't set and turbo.secretsCommand is empty, so builds use the " +
      "local cache only. `factory turbo status` says how to supply one");
  }
  const [state, detail] = await probe(s.api, s.team, ""); // no token: an answer, even a refusal, proves it is there
  if (state === "ok" || state === "rejected") r.ok(`shared build cache answers at ${s.api}`);
  else r.note("shared build cache", explain(s.api, state, detail));
  if (process.env.TURBO_REMOTE_CACHE_SIGNATURE_KEY && turboJsonSigns() === false) {
    r.note("shared build cache signatures", "TURBO_REMOTE_CACHE_SIGNATURE_KEY is set, but turbo.json has no " +
      "\"remoteCache\": {\"signature\": true}, so nothing is signed or checked");
  }
}

/** A project that takes the factory from releases (#113): the installed files are the pinned release's, and this
 * machine is ready (hooks exist, scripts parse, runner files readable). The same checks `factory update` ends with. */
export function release(r: Reporter): void {
  let pin: fr.Pin | null;
  try {
    pin = fr.readPin(process.cwd());
  } catch (e) {
    if (!(e instanceof FactoryError)) throw e;
    r.fix(fr.PIN_PATH, `${e.message} ${e.fix}`);
    return;
  }
  if (pin === null) return;
  const problems = fr.verifyMachine(process.cwd(), pin);
  if (problems.length) {
    for (const p of problems) {
      r.fix(`factory ${pin.tag}`, `${p}: run \`factory update\` (it repairs the files and the services, and checks again)`);
    }
  } else r.ok(`factory ${pin.tag}: the files match the pin and this machine is ready`);
}

export function models(r: Reporter, cfg: Config): void {
  const value = cfg.models ?? {};
  try {
    validate(value);
  } catch (e) {
    if (!(e instanceof ModelsError)) throw e;
    r.fix("models in .claude/factory.json", `${e.message} Fix it with \`factory settings set models '<json>'\``);
    return;
  }
  for (const [role, model, source] of table(validate(value))) {
    if (model === "Claude Code default" && (role === "builder" || role === "manager")) {
      const found = resolvedDefault();
      if (found) r.ok(`model for ${role}: Claude Code default, which resolves to ${found[0]} (${found[1]}; no call was made)`);
      else {
        r.note(`model for ${role}`, "Claude Code default, and I can't tell which model that is without a call (no ANTHROPIC_MODEL and no `model` " +
          "in its settings), so the cost of a run can change between runs: pin one with " +
          `\`factory settings set models '{"${role}":{"model":"<name>"}}'\` (it sets the whole \`models\` setting)`);
      }
      continue;
    }
    r.ok(`model for ${role}: ${model} (${source})`);
  }
}

/** The role folders (#102): every path in a role's reads.md exists; the names don't clash with coding agents'. */
export function roles(r: Reporter, cfg: Config): void {
  const defs = Object.keys(roleDefs.ROLE_DEFS);
  if (!defs.some((role) => roleDefs.roleDir(cfg, role))) {
    r.note("role folders", `${rolesDir(cfg)}/ doesn't exist, so the roles read their \`notes\` instead: run ` +
      "`factory init-roles` to create it, then commit it");
  } else {
    for (const role of defs) {
      const folder = roleDefs.roleDir(cfg, role);
      if (!folder) {
        r.note(`role folder for ${role}`, `${rolesDir(cfg)}/${role}/ is missing: run \`factory init-roles\``);
        continue;
      }
      const reads = join(folder, "reads.md");
      if (!isFile(reads)) {
        r.fix(reads, "missing: run `factory init-roles`, or write one (a document per line, with a reason)");
        continue;
      }
      const missing = roleDefs.missingReads(cfg, role) ?? [];
      for (const path of missing) r.fix(`${reads}: ${path}`, "does not exist: fix the path, or remove the line");
      if (!missing.length) r.ok(`${role} reads.md: every path exists`);
    }
  }
  const agents = new Set(Array.isArray(cfg.agents) ? cfg.agents : []);
  const clash = [...new Set([...roleNames(cfg, "dev-manager"), ...roleNames(cfg, "product-owner")])].filter((n) => agents.has(n)).sort();
  if (clash.length) r.fix("role names", `${clash.join(", ")} is also a coding agent's name: change \`roles.<role>.names\``);
}

/** The artifact copies in the repo (#104): each one exists, is not edited by hand, and is not older than its artifact
 * when the project can say (`artifacts.info`). */
export function artifacts(r: Reporter, cfg: Config): void {
  let entries: fa.Entry[];
  try {
    entries = fa.readManifest(cfg).artifacts;
  } catch (e) {
    if (e instanceof Exit) return;
    throw e;
  }
  for (const e of entries) {
    const [state, detail] = fa.judge(cfg, e);
    const what = `artifact ${e.id} (${e.dest})`;
    if (state === "current" || state === "unknown") r.ok(`${what}: ${detail}`);
    else if (state === "edited") r.note(what, detail + "; put the change in the artifact, or pull again with --force");
    else r.fix(what, detail + `; run \`factory artifacts pull ${e.url} ${e.dest}\``);
  }
}

/** What fixes a missing manager profile. `factory update` at a release that does not carry the file answers "nothing
 * to install" (#172), so a project on such a release is told to look for a newer one. */
export function managerProfileFix(path: string): string {
  let pin: fr.Pin | null;
  try {
    pin = fr.readPin(process.cwd());
  } catch (e) {
    if (!(e instanceof FactoryError)) throw e;
    pin = null;
  }
  if (pin && !(path in (pin.files || {}))) {
    return `the installed release ${pin.tag} doesn't carry it: see \`factory releases\` for a newer one and take it with ` +
      "`factory update <version>`, or set `roles.dev-manager.profile`";
  }
  return "run `factory update`, or set `roles.dev-manager.profile`";
}

/** The dev-manager orchestrator (#97): its settings profile resolves and every hook script the profile runs exists. */
export function manager(r: Reporter, cfg: Config): void {
  const roleCfg = isObject(cfg.roles) ? cfg.roles["dev-manager"] : null;
  const set = isObject(roleCfg) ? roleCfg.profile : null;
  const path = String(set || ".claude/manager/settings.json");
  if (!isFile(path)) {
    r.note("manager profile", `${path} doesn't exist, so sub-managers use the project's settings (which deny \`gh api\`): ` +
      managerProfileFix(path));
    return;
  }
  let profile: Record<string, unknown>;
  try {
    const data = JSON.parse(readText(path)) as unknown;
    profile = isObject(data) ? data : {};
  } catch (e) {
    r.fix(path, `isn't valid JSON (${errText(e)})`);
    return;
  }
  const missing: string[] = [];
  for (const command of hookCommands(profile)) {
    for (const m of command.matchAll(/[\w./$"-]+\.(?:ts|py)\b/g)) {
      const script = m[0].replace(/"/g, "").replace("$CLAUDE_PROJECT_DIR/", "");
      if (!script.includes("$") && !existsSync(script)) missing.push(script);
    }
  }
  const unique = [...new Set(missing)].sort();
  for (const script of unique) r.fix(`${path}: ${script}`, "the hook script is missing: run `factory update`");
  if (!unique.length) r.ok("manager profile: it resolves and its hooks exist");
  skillCommands(r, profile, path);
}

/** True when Claude Code would ask before running `command` under `profile` (a headless run cannot answer): a deny
 * rule matches, or no allow rule does. Matching is the rules' own: Bash(prefix*) globs on the whole command. */
export function wouldPrompt(profile: Record<string, unknown>, command: string): boolean {
  const rules = isObject(profile.permissions) ? profile.permissions : {};
  const hit = (list: unknown, cmd: string): boolean => (Array.isArray(list) ? list : []).some((x) => {
    const pat = bashPattern(x);
    return pat !== null && fnmatch(cmd, pat);
  });
  // `gh api` in prose stands for `gh api <path>`
  return hit(rules.deny, command) || !(hit(rules.allow, command) || hit(rules.allow, command + " x"));
}

/** Replays each command the dev manager's skill names against the profile (#202): one the profile would prompt for
 * stalls a headless sub-manager, which is how a verdict never got posted. Spans in a line that says "never" are the
 * commands the skill forbids, and are left out. */
export function skillCommands(r: Reporter, profile: Record<string, unknown>, path: string): void {
  const skill = ".claude/skills/manage-pass/SKILL.md";
  if (!isFile(skill)) return;
  const stuck: string[] = [];
  for (const line of splitLines(readText(skill))) {
    if (/\bnever\b/i.test(line)) continue;
    for (const m of line.matchAll(/`((?:gh|git|factory|\.\/factory) [^`]+)`/g)) {
      const cmd = m[1] as string;
      if (cmd.startsWith("factory dev-manager") || cmd.startsWith("factory loop")) continue; // started by the orchestrator
      if (!/[;|&]|\$\(/.test(cmd) && wouldPrompt(profile, cmd) && !stuck.includes(cmd)) stuck.push(cmd);
    }
  }
  for (const cmd of stuck) {
    r.fix(`${path}: \`${cmd}\``, "the manage-pass skill names this command but the profile would ask before running it, and a headless " +
      "sub-manager cannot answer, so its verdict never lands: run `factory update` (or add the rule to the profile)");
  }
  if (!stuck.length) r.ok("manager profile: every command the manage-pass skill names is allowed without a prompt");
}

export async function main(argv: string[]): Promise<number> {
  if (run(["git", "rev-parse", "--show-toplevel"])[0] !== 0) {
    process.stderr.write("factory doctor: run it inside the project's git repo.\n");
    return 1;
  }
  process.chdir(run(["git", "rev-parse", "--show-toplevel"])[1]);
  const r = new Report();
  tools(r);
  let cfg: Config | null;
  try {
    cfg = load();
  } catch (e) {
    r.fix(".claude/factory.json", `can't read it (${errText(e)})`);
    cfg = null;
  }
  node(r);
  docker(r);
  if (cfg) {
    project(r, cfg);
    originMain(r, cfg);
    mainBranch(r, cfg);
    factory(r, cfg);
    models(r, cfg);
    permissions(r, cfg);
    testAllowed(r, cfg);
    trust(r, cfg);
    ci(r, cfg);
    testCommand(r, cfg);
    roles(r, cfg);
    manager(r, cfg);
    await turbo(r, cfg);
    artifacts(r, cfg);
    release(r);
  }
  if (argv.includes("--sandbox")) {
    console.log();
    console.log("Sandbox (#105)");
    sandbox(r, cfg);
  }
  console.log();
  console.log(r.fixes ? `${r.fixes} to fix.` : "All the checks pass.");
  return r.fixes ? 1 : 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
