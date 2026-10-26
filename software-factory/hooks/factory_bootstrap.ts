#!/usr/bin/env -S bun --no-env-file
// `factory bootstrap`: take a fresh Linux machine to a sandboxed, factory-ready state (#105). HELP below is what
// `factory bootstrap help` prints. It runs from where this script lives (the factory's dispatcher calls it before
// there is a checkout).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as M from "./factory_bootstrap_machine.ts";
import * as PR from "./factory_bootstrap_project.ts";
import { BootstrapError, Context, Executor, isRootUser, probe, refuse, shellOf, type Step } from "./factory_bootstrap_core.ts";
import * as G from "./factory_netguard.ts";
import { load } from "./factory_config.ts";
import { bunCmd, Exit, isoUtc, now, pyDumps, pyRepr, run, runMain, shQuote } from "./factory_lib.ts";

const HERE = import.meta.dir;
const USER_OK = /^[a-z_][a-z0-9_-]{0,30}$/;

export const HELP = `\`factory bootstrap\`: take a fresh Linux machine to a sandboxed, factory-ready state (#105).

  factory bootstrap machine [options]      the steps that need root: packages, the dedicated user, subuid/subgid, linger,
                                           the network guard (and, if you ask, key-only SSH and a machine that stays awake)
  factory bootstrap project [options]      what the dedicated user sets up for itself (never as root): rootless Docker,
                                           Node, Claude Code, the checkout, the stack, CI runners, autostart; ends with
                                           \`factory doctor --sandbox\`
  factory bootstrap all [options]          the machine plan, then how to continue as the dedicated user
  factory bootstrap status                 what bootstrap set up (its manifest) against what is there now
  factory bootstrap uninstall [--apply]    remove the system parts; the user and its home stay unless you type a confirmation

Nothing privileged runs by itself. \`machine\` and \`uninstall\` print the plan and change nothing; \`--apply\`, as root
(\`sudo factory bootstrap machine --apply\`), runs it, and \`--script [FILE]\` writes the same steps as a bash script you can
read first. \`--dry-run\` is accepted everywhere and is the default for the privileged steps. Every step is checked first, so
a second run changes nothing. Errors are \`{code, message, fix}\` on stderr.

Options: --user NAME (factory)  --egress internet|none  --allow-host ADDR[:PORT] (repeat)  --block-loopback-port PORT (repeat)
         --block-inbound-port PORT (repeat)  --authorized-keys FILE  --harden-ssh  --keep-awake | --no-keep-awake
         --runners N  --agents a,b  --repo URL  --dir PATH  --yes

The human steps are never done here: \`gh auth login\`, the Claude login (and its folder-trust prompt) and copying the age
key. Bootstrap checks that they exist (it never reads, prints or stores a token or the key) and tells you what to run.
`;

const USAGE = `usage: factory bootstrap [--user USER] [--egress EGRESS]
                         [--allow-host ALLOW_HOST]
                         [--block-loopback-port BLOCK_LOOPBACK_PORT]
                         [--block-inbound-port BLOCK_INBOUND_PORT]
                         [--authorized-keys AUTHORIZED_KEYS] [--harden-ssh]
                         [--keep-awake] [--no-keep-awake] [--runners RUNNERS]
                         [--agents AGENTS] [--repo REPO] [--dir DIR] [--apply]
                         [--dry-run] [--yes] [--script [SCRIPT]]
                         [--remove-user] [--delete-home] [--confirm CONFIRM]
                         [-h]
                         [what]`;

/** Everything printed goes through here (process.stdout, so a caller in the same process can capture it). */
function out(line = ""): void {
  process.stdout.write(line + "\n");
}

/** Is this process root? Tests replace it (Python's `B.is_root = ...`). */
let isRootFn: () => boolean = isRootUser;
export function isRoot(): boolean {
  return isRootFn();
}
export function setIsRoot(f?: () => boolean): void {
  isRootFn = f ?? isRootUser;
}

export interface Args {
  what: string;
  user: string;
  egress: string;
  allowHost: string[];
  blockLoopbackPort: string[];
  blockInboundPort: string[];
  authorizedKeys: string | null;
  hardenSsh: boolean;
  keepAwake: boolean | null;
  runners: number | null;
  agents: string | null;
  repo: string | null;
  dir: string | null;
  apply: boolean;
  dryRun: boolean;
  yes: boolean;
  script: string | null;
  removeUser: boolean;
  deleteHome: boolean;
  confirm: string | null;
  help: boolean;
}

function argError(text: string): never {
  process.stderr.write(`${USAGE}\nfactory bootstrap: error: ${text}\n`);
  throw new Exit(2);
}

/** argparse, by hand: the same options, usage and errors (exit 2). */
export function parse(argv: string[]): Args {
  const a: Args = { what: "help", user: "factory", egress: "internet", allowHost: [], blockLoopbackPort: [], blockInboundPort: [],
    authorizedKeys: null, hardenSsh: false, keepAwake: null, runners: null, agents: null, repo: null, dir: null, apply: false,
    dryRun: false, yes: false, script: null, removeUser: false, deleteHome: false, confirm: null, help: false };
  const valued = ["--user", "--egress", "--allow-host", "--block-loopback-port", "--block-inbound-port", "--authorized-keys",
    "--runners", "--agents", "--repo", "--dir", "--confirm"];
  const isOption = (x: string | undefined): boolean => x !== undefined && x.startsWith("-") && x !== "-" && !/^-\d/.test(x) && !x.includes(" ");
  const pos: string[] = [];
  const extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i] as string;
    const eq = x.startsWith("--") ? x.indexOf("=") : -1;
    const key = eq > 0 ? x.slice(0, eq) : x;
    if (valued.includes(key)) {
      const v = eq > 0 ? x.slice(eq + 1) : argv[++i];
      if (v === undefined || (eq < 0 && isOption(v))) argError(`argument ${key}: expected one argument`);
      switch (key) {
        case "--user": a.user = v; break;
        case "--egress": a.egress = v; break;
        case "--allow-host": a.allowHost.push(v); break;
        case "--block-loopback-port": a.blockLoopbackPort.push(v); break;
        case "--block-inbound-port": a.blockInboundPort.push(v); break;
        case "--authorized-keys": a.authorizedKeys = v; break;
        case "--runners":
          if (!/^\s*[+-]?\d+\s*$/.test(v)) argError(`argument --runners: invalid int value: '${v}'`);
          a.runners = Number(v);
          break;
        case "--agents": a.agents = v; break;
        case "--repo": a.repo = v; break;
        case "--dir": a.dir = v; break;
        case "--confirm": a.confirm = v; break;
      }
    } else if (key === "--script") {
      if (eq > 0) a.script = x.slice(eq + 1);
      else if (i + 1 < argv.length && !isOption(argv[i + 1])) a.script = argv[++i] as string;
      else a.script = "-";
    } else if (x === "--harden-ssh") a.hardenSsh = true;
    else if (x === "--keep-awake") a.keepAwake = true;
    else if (x === "--no-keep-awake") a.keepAwake = false;
    else if (x === "--apply") a.apply = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--yes") a.yes = true;
    else if (x === "--remove-user") a.removeUser = true;
    else if (x === "--delete-home") a.deleteHome = true;
    else if (x === "-h" || x === "--help") a.help = true;
    else if (isOption(x)) extra.push(x);
    else pos.push(x);
  }
  if (pos.length > 1) extra.push(...pos.slice(1));
  if (extra.length) argError(`unrecognized arguments: ${extra.join(" ")}`);
  if (pos.length) a.what = pos[0] as string;
  return a;
}

export function options(a: Args): PR.Options {
  if (!USER_OK.test(a.user) || a.user === "root") {
    throw new BootstrapError("bad-user", `${pyRepr(a.user)} is not a usable account name.`, "Use lowercase letters, digits, - and _, not root.");
  }
  if (!["internet", "none"].includes(a.egress)) {
    throw new BootstrapError("bad-egress", `--egress ${pyRepr(a.egress)} is not internet or none.`, "Use --egress internet or --egress none.");
  }
  try {
    for (const h of a.allowHost) G.parseAllowHost(h);
    for (const p of [...a.blockLoopbackPort, ...a.blockInboundPort]) G.parsePort(p);
  } catch (e) {
    throw new BootstrapError("bad-option", e instanceof Error ? e.message : String(e), "Fix the option and run it again.");
  }
  const agents = (a.agents || "").split(",").filter(Boolean);
  if (agents.some((x) => !/^[a-z][a-z0-9-]*$/.test(x))) {
    throw new BootstrapError("bad-agents", `--agents ${pyRepr(a.agents ?? "")}: names are lowercase letters, digits and dashes.`,
      "For example --agents haile,tewodros.");
  }
  return { user: a.user, egress: a.egress, allow_hosts: a.allowHost, block_loopback_ports: a.blockLoopbackPort,
    block_inbound_ports: a.blockInboundPort, authorized_keys: a.authorizedKeys, harden_ssh: a.hardenSsh,
    keep_awake: a.keepAwake, runners: a.runners, agents, repo: a.repo, dir: a.dir };
}

export function showPlan(steps: Step[], ctx: Context): number {
  let todo = 0;
  for (const s of steps) {
    if (s.done()) {
      out(`ok    ${s.title}`);
      continue;
    }
    todo += 1;
    out(`plan  ${s.title}`);
    if (s.manual) out(`      by hand: ${s.manual}`);
    for (const act of s.actions) for (const line of shellOf(act, ctx).split("\n")) out(`      ${line}`);
  }
  return todo;
}

export function scriptOf(steps: Step[], ctx: Context, user: string): string {
  const lines = ["#!/usr/bin/env bash", "# Generated by `factory bootstrap` (read it before you run it, as root).",
    "set -euo pipefail", "export DEBIAN_FRONTEND=noninteractive",
    '[ "$(id -u)" = 0 ] || { echo "run this as root (sudo bash <this file>)" >&2; exit 1; }', ""];
  for (const s of steps) {
    if (s.done()) {
      lines.push(`# already done: ${s.title}`);
      continue;
    }
    lines.push(`echo '== ${s.title.replaceAll("'", "")}'`);
    if (s.actions.some((a) => shellOf(a, ctx).includes("$UID_F"))) lines.push(`UID_F=$(id -u ${shQuote(user)})`);
    for (const act of s.actions) lines.push(shellOf(act, ctx));
    lines.push("");
  }
  lines.push('echo "Done. Next, as the sandbox user: factory bootstrap project"');
  return lines.join("\n") + "\n";
}

type Manifest = { [key: string]: unknown; steps?: Record<string, { at?: string; record?: Record<string, unknown> }> };

function readManifest(): Manifest | null {
  try {
    const data = JSON.parse(readFileSync(M.manifestPath(), "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Manifest) : null;
  } catch {
    return null;
  }
}

export function saveManifest(opts: PR.Options, done: Step[]): void {
  const path = M.manifestPath();
  const data: Manifest = readManifest() ?? {};
  Object.assign(data, { version: 1, user: opts.user, uid: M.userUid(opts.user) });
  data.steps ??= {};
  for (const s of done) data.steps[s.id] = { at: isoUtc(now()), record: s.record };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", pyDumps(data, { indent: 2, sortKeys: true }) + "\n");
  renameSync(path + ".tmp", path);
}

function ask(question: string): string {
  return (prompt(question) ?? "").trim();
}

function confirm(question: string, yes: boolean): boolean {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new BootstrapError("needs-yes", "This would change the machine and there is no terminal to ask on.",
      "Read the plan, then run it again with --yes.");
  }
  return ["y", "yes"].includes(ask(`${question} [y/N]`).toLowerCase());
}

/** Runs the steps that are not done, in order, verifying each. Returns 0, or 1 at the first failure. */
export async function execute(steps: Step[], ctx: Context, opts: PR.Options, recordManifest: boolean): Promise<number> {
  const ex = new Executor(ctx);
  const done: Step[] = [];
  const stop = (): number => {
    if (recordManifest && done.length) saveManifest(opts, done);
    return 1;
  };
  for (const s of steps) {
    if (s.done()) {
      out(`ok    ${s.title}`);
      continue;
    }
    if (s.manual && !s.actions.length) {
      out(`fix   ${s.title}: ${s.manual}`);
      return 1;
    }
    if (s.manual) out(`note  ${s.title}: ${s.manual}`);
    out(`run   ${s.title}`);
    try {
      for (const act of s.actions) await ex.do(act);
    } catch (e) {
      if (!(e instanceof BootstrapError)) throw e;
      out(`fix   ${s.title}: ${e.message} ${e.fix}`);
      return stop();
    }
    if (!s.trust && !s.done()) {
      out(`fix   ${s.title}: it ran, but the check afterwards still fails. Read the step's output above, fix it, ` +
        "and run the command again.");
      return stop();
    }
    done.push(s);
    out(`done  ${s.title}`);
  }
  if (recordManifest && done.length) saveManifest(opts, done);
  return 0;
}

async function cmdMachine(a: Args, opts: PR.Options): Promise<number> {
  const steps = M.steps(opts);
  const ctx = new Context(opts.user, a.apply && !a.dryRun && !a.script);
  if (a.script) {
    const text = scriptOf(steps, new Context(opts.user, false), opts.user);
    if (a.script === "-") {
      process.stdout.write(text);
    } else {
      writeFileSync(a.script, text);
      chmodSync(a.script, 0o700);
      out(`Wrote ${a.script}. Read it, then run it as root: sudo bash ${a.script}`);
    }
    return 0;
  }
  if (!(a.apply && !a.dryRun)) {
    const todo = showPlan(steps, ctx);
    out();
    out(!todo ? "Everything is in place."
      : `${todo} step(s) to do. Nothing was changed. To run them: \`sudo factory bootstrap machine --apply\` ` +
        "(or `--script FILE` to read them as a bash script first).");
    return 0;
  }
  if (!isRoot()) {
    return refuse(new BootstrapError("not-root", "These steps change the system and need root.", "Run: sudo factory bootstrap machine --apply"));
  }
  const todo = steps.filter((s) => !s.done());
  if (todo.length && !confirm(`Run ${todo.length} privileged step(s) as root?`, a.yes)) {
    out("Nothing was changed.");
    return 0;
  }
  const rc = await execute(steps, ctx, opts, true);
  if (rc === 0) {
    out();
    out(`The machine part is done. Next, as ${opts.user} (ssh in, or \`sudo -u ${opts.user} -i\`), from the project's ` +
      "checkout: factory bootstrap project");
  }
  return rc;
}

function projectRoot(): string {
  const [rc, o] = probe(["git", "rev-parse", "--show-toplevel"]);
  return rc === 0 ? o.trim() : "";
}

function loadProjectCfg(root: string): PR.ProjectConfig {
  if (!root) return {};
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    return load();
  } catch {
    return {};
  }
}

function reportHuman(project: string): boolean {
  const open = PR.humanSteps(project).filter(([, , ok]) => !ok);
  if (!open.length) {
    out("ok    GitHub, Claude and the age key are in place");
    return true;
  }
  out();
  out("These steps are yours. Bootstrap never signs in for you and never reads or stores a token or the key:");
  open.forEach(([title, cmd], i) => out(`  ${i + 1}. ${title}:  ${cmd}`));
  out("Then run `factory bootstrap project` again; it carries on from here and ends with `factory doctor --sandbox`.");
  return false;
}

async function cmdProject(a: Args, opts: PR.Options): Promise<number> {
  if (isRoot()) {
    return refuse(new BootstrapError("root-refused", "The project part must not run as root.",
      `Run it as the sandbox user: sudo -u ${opts.user} -i, then \`factory bootstrap project\`.`));
  }
  const root = projectRoot();
  const cfg = loadProjectCfg(root);
  const ctx = new Context(opts.user, false);
  const steps = PR.steps(opts, root, cfg);
  if (a.dryRun) {
    showPlan(steps, ctx);
    if (root) showPlan(PR.afterHuman(opts, root, cfg), ctx);
    return 0;
  }
  let rc = await execute(steps, ctx, opts, false);
  if (rc || !root) return rc;
  if (!reportHuman(root)) return 2;
  rc = await execute(PR.afterHuman(opts, root, cfg), ctx, opts, false);
  if (rc) return rc;
  out();
  // factory_doctor.ts: the doctor family (#252); it ends the project part with the sandbox checks.
  const p = run([...bunCmd(join(HERE, "factory_doctor.ts")), "--sandbox"], { env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  process.stdout.write(p.stdout);
  process.stderr.write(p.stderr);
  return p.code;
}

function cmdStatus(): number {
  const data = readManifest();
  if (data === null) {
    out("Bootstrap has not been run on this machine (no manifest at " + M.manifestPath() + ").");
    return 0;
  }
  let bad = 0;
  out(`Sandbox user: ${String(data.user ?? "None")} (uid ${String(data.uid ?? "None")})`);
  const steps = data.steps ?? {};
  for (const sid of Object.keys(steps).sort()) {
    const entry = steps[sid] ?? {};
    const rec = (entry.record ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    for (const f of (rec.files as string[] | undefined) ?? []) {
      if (!existsSync(f)) problems.push(`${f} is missing`);
    }
    for (const u of (rec.units as string[] | undefined) ?? []) {
      if (probe(["systemctl", "is-enabled", "--quiet", u])[0] !== 0) problems.push(`${u} is not enabled`);
    }
    if (rec.user && !M.userExists(rec.user as string)) problems.push(`user ${String(rec.user)} is gone`);
    out((problems.length ? "fix   " : "ok    ") + `${sid} (${entry.at ?? "?"})` + (problems.length ? ": " + problems.join("; ") : ""));
    if (problems.length) bad += 1;
  }
  if (bad) out(`\n${bad} step(s) differ from what bootstrap recorded: \`sudo factory bootstrap machine --apply\` puts them back.`);
  return bad ? 1 : 0;
}

/** What to remove, from the manifest: only things bootstrap recorded. */
export function uninstallSteps(data: Manifest): [string, string[]][] {
  const outList: [string, string[]][] = [];
  const steps = data.steps ?? {};
  for (const sid of Object.keys(steps).sort().reverse()) {
    const rec = (steps[sid]?.record ?? {}) as Record<string, unknown>;
    for (const u of (rec.units as string[] | undefined) ?? []) outList.push([`stop and disable ${u}`, ["systemctl", "disable", "--now", u]]);
    if (rec.table) outList.push([`delete the nft table ${String(rec.table)}`, ["nft", "delete", "table", "inet", String(rec.table)]]);
    for (const t of (rec.masked as string[] | undefined) ?? []) outList.push([`unmask ${t}`, ["systemctl", "unmask", t]]);
    for (const f of (rec.files as string[] | undefined) ?? []) {
      if (sid !== "sops") outList.push([`remove ${f}`, ["rm", "-f", f]]); // tools stay: other things may use them
    }
  }
  outList.push(["reload systemd", ["systemctl", "daemon-reload"]]);
  return outList;
}

function cmdUninstall(a: Args, opts: PR.Options): number {
  const data = readManifest();
  if (data === null) {
    out("Nothing to uninstall: bootstrap has no manifest on this machine.");
    return 0;
  }
  const user = (data.user as string) || opts.user;
  const actions = uninstallSteps(data);
  const created = Boolean(data.steps?.user?.record?.created);
  if (a.removeUser || a.deleteHome) {
    if (!created) {
      out(`note  ${user} existed before bootstrap, so it is not removed.`);
    } else {
      actions.push([`remove the user ${user}` + (a.deleteHome ? " and its home" : " (the home folder stays)"),
        ["deluser", ...(a.deleteHome ? ["--remove-home"] : []), user]]);
    }
  }
  for (const [title, argv] of actions) out((a.apply && !a.dryRun ? "run   " : "plan  ") + title + "   # " + argv.join(" "));
  if (!a.apply || a.dryRun) {
    out("\nNothing was changed. The home folder, the backups and the installed packages are never removed by default.");
    return 0;
  }
  if (!isRoot()) return refuse(new BootstrapError("not-root", "Removing system parts needs root.", "Run: sudo factory bootstrap uninstall --apply"));
  if ((a.removeUser || a.deleteHome) && created) {
    const typed = a.confirm !== null ? a.confirm : process.stdin.isTTY ? ask(`Type the user name (${user}) to confirm:`) : "";
    if (typed !== user) {
      return refuse(new BootstrapError("not-confirmed", `The user is only removed after you type its name (${user}).`,
        `Run it again with --confirm ${user}, or type the name when asked.`));
    }
  } else if (!confirm("Remove these system parts?", a.yes)) {
    out("Nothing was changed.");
    return 0;
  }
  for (const [title, argv] of actions) {
    if (argv[0] === "deluser" && !((a.removeUser || a.deleteHome) && created)) continue;
    const [rc, , err] = probe(argv);
    if (rc !== 0 && argv[0] !== "nft") {
      const lines = err.trim().split(/\r\n|\r|\n/).filter(Boolean);
      out(`fix   ${title}: ${(lines.length ? lines[lines.length - 1] as string : "failed").slice(0, 140)}`);
    }
  }
  rmSync(M.manifestPath(), { force: true });
  out("done  system parts removed; the manifest is gone.");
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const a = parse(argv);
  if (a.help || a.what === "help" || a.what === "-h") {
    out(HELP);
    return 0;
  }
  try {
    if (["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"].some((k) => process.env[k]) && a.what !== "status") {
      throw new BootstrapError("agent-session", "An agent session can't set up or remove a machine.",
        "A person runs `factory bootstrap` from their own terminal (the agent variables are set here).");
    }
    const opts = options(a);
    if (a.what === "machine") return await cmdMachine(a, opts);
    if (a.what === "project") return await cmdProject(a, opts);
    if (a.what === "all") {
      const rc = await cmdMachine(a, opts);
      if (rc === 0 && !(a.apply && !a.dryRun)) out(`\nThen, as ${opts.user}: factory bootstrap project`);
      return rc;
    }
    if (a.what === "status") return cmdStatus();
    if (a.what === "uninstall") return cmdUninstall(a, opts);
    return refuse(new BootstrapError("unknown-command", `\`factory bootstrap ${a.what}\` is not a command.`,
      "Use machine, project, all, status or uninstall (factory bootstrap help)."));
  } catch (e) {
    if (e instanceof BootstrapError) return refuse(e);
    throw e;
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
