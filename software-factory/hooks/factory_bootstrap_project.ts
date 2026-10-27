// The project part of `factory bootstrap` (#105): what the dedicated user sets up for itself, no root needed.
//
// Rootless Docker, the shell profile, the secrets folder, Node (nvm, corepack), Claude Code, the checkout with its
// submodules, `.env.local`, the install and the dev stack, the `factory` shim, the machine's agent names, and, once
// the person has done the three human steps, the CI runners and autostart. The human steps are never done here:
// `gh auth login`, the Claude login and copying the age key. `humanSteps()` says which are still open, from the
// state only: it never reads, prints or stores a token or a key.
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BootstrapError, Call, Mkdir, probe, Run, Step } from "./factory_bootstrap_core.ts";
import type { MachineOptions } from "./factory_bootstrap_machine.ts";
import type { Config } from "./factory_config.ts";
import { repoKey } from "./factory_machine.ts";
import { run, which } from "./factory_lib.ts";

export const PROFILE_MARK = "# --- software factory";
export const NVM_URL = "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh";
export const CLAUDE_URL = "https://claude.ai/install.sh";
export const SETUPTOOL_DIRS = ["/usr/bin", "/usr/local/bin", "/usr/share/docker.io/contrib", "/opt/docker/bin"];

/** Everything `factory bootstrap` takes (the machine part's options and the project part's). */
export interface Options extends MachineOptions {
  runners?: number | null;
  agents: string[];
  repo?: string | null;
  dir?: string | null;
}

/** The settings bootstrap reads ({} when there is no project). */
export type ProjectConfig = Partial<Config> | Record<string, unknown>;

/** os.path.expanduser("~"): $HOME, else the account's home. */
export function home(): string {
  return process.env.HOME || homedir();
}

function expandUser(p: string): string {
  return p === "~" ? home() : p.startsWith("~/") ? join(home(), p.slice(2)) : p;
}

export function read(path: string, dflt = ""): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return dflt;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function profileBlock(): string {
  return `\n${PROFILE_MARK}\n` +
    "export XDG_RUNTIME_DIR=/run/user/$(id -u)\n" +
    "export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock\n" +
    "export SOPS_AGE_KEY_FILE=~/.secrets/sops/age/keys.txt\n" +
    'export PATH="$HOME/.local/bin:$PATH"\n';
}

export function findSetuptool(): string {
  const found = which("dockerd-rootless-setuptool.sh");
  if (found) return found;
  for (const d of SETUPTOOL_DIRS) {
    const p = join(d, "dockerd-rootless-setuptool.sh");
    if (existsSync(p)) return p;
  }
  return "";
}

export function dockerRootlessOk(): boolean {
  const [rc, out] = probe(["docker", "info", "--format", "{{json .SecurityOptions}}"]);
  return rc === 0 && out.includes("rootless");
}

/** The Node major the project asks for in .nvmrc, else 24. */
export function nodeMajor(project: string): string {
  const m = read(join(project, ".nvmrc")).trim().replace(/^v+/, "").split(".")[0] as string;
  return /^\d+$/.test(m) ? m : "24";
}

function runtimeDir(): string {
  return process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 0}`;
}

function lastChars(text: string, n: number): string {
  return text.length > n ? text.slice(text.length - n) : text;
}

/** Downloads an installer to a private file and runs it with bash (never `curl | bash`), so a failed download is
 * an error, not a half-run script. */
export function fetchAndRun(url: string, label: string, args: string[] = []): Call {
  const go = (): void => {
    const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "factory-install-"));
    try {
      const path = join(d, "install.sh");
      if (run(["curl", "-fsSL", "-o", path, url]).code !== 0) {
        throw new BootstrapError("download", `Could not download the ${label} installer (${url}).`,
          "Check the internet (and that the network guard lets this user out), then run it again.");
      }
      const q = run(["bash", path, ...args]);
      if (q.code !== 0) {
        throw new BootstrapError("installer", `The ${label} installer failed: ${lastChars((q.stderr || q.stdout).trim(), 160)}`,
          "Run it by hand to see why, then run `factory bootstrap project` again.");
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  return new Call(go, `install ${label}`);
}

/** [[title, command, done]] for what only the person can do. `done` is a check of state, not of contents. */
export function humanSteps(project: string): [string, string, boolean][] {
  const key = expandUser(process.env.SOPS_AGE_KEY_FILE || join(home(), ".secrets", "sops", "age", "keys.txt"));
  const steps: [string, string, boolean][] = [
    ["Sign in to GitHub", "gh auth login", probe(["gh", "auth", "status"])[0] === 0],
    ["Sign in to Claude Code (accept the folder-trust prompt for the project)", "claude",
      existsSync(join(home(), ".claude", ".credentials.json")) || existsSync(join(home(), ".claude.json"))],
  ];
  if (project && existsSync(join(project, ".sops.yaml"))) {
    const sdir = join(project, "secrets");
    const files = isDir(sdir) ? readdirSync(sdir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort() : [];
    const enc = files.length ? join(sdir, files[0] as string) : "";
    const ok = isFile(key) && (!enc || probe(["sops", "-d", enc], { SOPS_AGE_KEY_FILE: key })[0] === 0);
    steps.push([`Copy the age key to ${key} (mode 600)`, `install -m 600 /path/to/keys.txt ${key}`, ok]);
  }
  return steps;
}

function commandsOf(cfg: ProjectConfig): Record<string, unknown> {
  const c = (cfg as Record<string, unknown>).commands;
  return c && typeof c === "object" ? (c as Record<string, unknown>) : {};
}

/** The steps that need no human. `project` is the checkout's folder ('' when there is none yet). */
export function steps(opts: Options, project: string, cfg: ProjectConfig): Step[] {
  const out: Step[] = [];
  const h = home();
  out.push(new Step("rootless-docker", "Set up rootless Docker for this user", [
    new Run([findSetuptool() || "dockerd-rootless-setuptool.sh", "install"], { env: { XDG_RUNTIME_DIR: runtimeDir() } }),
    new Run(["systemctl", "--user", "enable", "--now", "docker"], { env: { XDG_RUNTIME_DIR: runtimeDir() } })],
  { done: dockerRootlessOk,
    manual: findSetuptool() ? "" : "dockerd-rootless-setuptool.sh was not found: install Docker Engine's rootless extras " +
      "(docker-ce-rootless-extras, https://docs.docker.com/engine/security/rootless/), then run this again." }));
  const rc = join(h, ".bashrc");
  out.push(new Step("profile", "Add DOCKER_HOST, SOPS_AGE_KEY_FILE and PATH to ~/.bashrc",
    [new Call(() => appendFileSync(rc, profileBlock()), "append the profile block")],
    { done: () => read(rc).includes(PROFILE_MARK) }));
  const sec = join(h, ".secrets");
  const dirs = [sec, join(sec, "sops"), join(sec, "sops", "age")];
  out.push(new Step("secrets-dir", "Make ~/.secrets (mode 700), empty: you copy the age key in yourself",
    dirs.map((d) => new Mkdir(d, 0o700)),
    { done: () => dirs.every((d) => isDir(d) && (statSync(d).mode & 0o777) === 0o700) }));
  const want = nodeMajor(project);
  const nvmDir = join(h, ".nvm");
  const nodeOk = (): boolean => {
    const [code, o] = probe(["node", "--version"]);
    return code === 0 && o.trim().replace(/^v+/, "").split(".")[0] === want;
  };
  out.push(new Step("node", `Install Node ${want} with nvm, and enable corepack`,
    [...(existsSync(join(nvmDir, "nvm.sh")) ? [] : [fetchAndRun(NVM_URL, "nvm")]),
      new Run(["bash", "-c", `. "$HOME/.nvm/nvm.sh" && nvm install ${want} && nvm alias default ${want} && corepack enable`])],
    { done: nodeOk }));
  out.push(new Step("claude", "Install Claude Code (the official installer)", [fetchAndRun(CLAUDE_URL, "Claude Code")],
    { done: () => which("claude") !== null || existsSync(join(h, ".local", "bin", "claude")) }));
  if (!project) {
    const repo = opts.repo;
    if (!repo) {
      throw new BootstrapError("no-project", "There is no project checkout here and no --repo was given.",
        "Run it inside the project's checkout, or give --repo <url> [--dir <folder>].");
    }
    const name = basename(repo.replace(/\/+$/, ""));
    const target = opts.dir || join(h, name.endsWith(".git") ? name.slice(0, -4) : name);
    out.push(new Step("clone", `Clone ${repo} with its submodules into ${target}`,
      [new Run(["git", "clone", "--recurse-submodules", repo, target])], { done: () => isDir(target) }));
    return [...out, new Step("next", "Run `factory bootstrap project` again from inside the checkout", [],
      { done: () => false, manual: `cd ${target} && ./factory bootstrap project` })];
  }
  out.push(new Step("submodules", "Check out the submodules", [new Run(["git", "submodule", "update", "--init"])],
    { done: () => !probe(["git", "submodule", "status"])[1].split(/\r\n|\r|\n/).filter((l, i, all) => i < all.length - 1 || l !== "")
      .some((l) => "-+U".includes(l.slice(0, 1))) }));
  const envExample = join(project, ".env.example");
  const envLocal = join(project, ".env.local");
  if (existsSync(envExample)) {
    out.push(new Step("env-local", "Copy .env.example to .env.local (fill it in yourself)",
      [new Call(() => {
        copyFileSync(envExample, envLocal);
        chmodSync(envLocal, 0o600);
      }, "copy")], { done: () => existsSync(envLocal) }));
  }
  const install = (commandsOf(cfg).install as string) || "";
  if (install && !isDir(join(project, "node_modules"))) {
    out.push(new Step("install", `Install the project's dependencies (\`${install}\`)`, [new Run(["bash", "-c", install])],
      { done: () => isDir(join(project, "node_modules")), trust: true }));
  }
  out.push(new Step("shim", "Put `factory` on PATH (factory install-shim)", [new Run(["./factory", "install-shim"])],
    { done: () => existsSync(join(h, ".local", "bin", "factory")) }));
  if (opts.agents.length) {
    out.push(new Step("agent-names", `Set this machine's agent names to ${opts.agents.join(",")}`,
      [new Run(["./factory", "machine", "setup", opts.agents.join(",")])],
      { done: () => opts.agents.every((a) => probe(["./factory", "machine", "show"])[1].includes(a)) }));
  }
  return out;
}

export function ciUnitsInstalled(): boolean {
  const key = repoKey();
  const [rc, out] = probe(["systemctl", "--user", "list-unit-files", "--no-legend", `${key}-ci*.service`]);
  return rc === 0 && out.includes(`${key}-ci`);
}

/** Steps that need GitHub, so they come after the human steps: the dev stack, the CI runners, autostart. */
export function afterHuman(opts: Options, _project: string, cfg: ProjectConfig): Step[] {
  const out: Step[] = [];
  const stack = (commandsOf(cfg).stackUp as string) || "";
  if (stack) {
    out.push(new Step("stack", `Start the dev stack (\`${stack}\`)`, [new Run(["bash", "-c", stack])],
      { done: () => probe(["bash", "-c", (commandsOf(cfg).stackHealth as string) || "false"])[0] === 0 }));
  }
  const env: Record<string, string> = opts.runners !== null && opts.runners !== undefined ? { FACTORY_CI_RUNNERS: String(opts.runners) } : {};
  out.push(new Step("ci", "Install the CI runners as user services (factory ci install)",
    [new Run(["./factory", "ci", "install"], { env })], { done: ciUnitsInstalled }));
  if (opts.agents.length) {
    out.push(new Step("autostart", "Bring the stack and agents back after a reboot (factory autostart install)",
      [new Run(["./factory", "autostart", "install", "--agents", opts.agents.join(",")])],
      { done: () => probe(["./factory", "autostart", "status"])[1].includes("autostart: on") }));
  }
  return out;
}
