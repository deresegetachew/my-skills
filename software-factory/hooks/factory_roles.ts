#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Factory roles (#102): the small per-role definition the shared loop runner (factory-loop.sh) reads, and the
// project's role folder.
//
// A role is started the same way, `factory <role> [name] loop [-i] [--once] [--dry-run]`, and runs the same loop; what
// differs is written here:
//
//   coding-agent   claims a task and runs /next-task on it (today's `factory loop`)
//   dev-manager    the orchestrator (factory_orchestrator.ts), no model: it reads GitHub (factory_watch.ts) and starts
//                  one-item sub-managers, each a fresh `claude -p /manage-pass <item>`
//   product-owner  runs /product-pass when an issue or pull request carries `roles.product-owner.workLabel`
//
// The project's role folder (`roles.dir`, default `.claude/factory/roles`, committed in the project) holds, per role,
// `README.md` (the project's own instructions for the role) and `reads.md` (the documents it reads, one per line with
// a reason). A project without the folder falls back to its `notes` (`<notes>/manager.md` and so on).
//
//   factory_roles.ts vars <role>                 shell assignments for the loop runner (kind, skill, waits ...)
//   factory_roles.ts names <role>                the role's names, one per line
//   factory_roles.ts nth <role> <N>              the Nth name (so `factory dev-manager 2 loop` means the second)
//   factory_roles.ts work <role> [--name N]      exit 0 and one line per thing to do, or exit 3 "nothing to do"
//   factory_roles.ts prompt <role> <name> [arg]  the prompt a pass starts with (ends with a marker for factory usage)
//   factory_roles.ts permission-flags            the flags that give a headless run its permissions, one per line
//   factory_roles.ts claude-flags <role>         the settings flags for the role's sessions, one per line
//   factory_roles.ts choose                      ask for a role and a name (factory loop -i); prints "role name"
//   factory_roles.ts init [--force]              scaffold the role folders (factory init-roles)
//   factory_roles.ts digest <role>               the role folder and its reads.md, one line (the dry run prints it)
//   factory_roles.ts reads [role]                every path in reads.md that does not exist (exit 1 when any)
import { existsSync, mkdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, DEFAULTS, load, ROLE_NAMES, roleNames, roleSetting, roleWait, rolesDir, safeAgent, toFloat } from "./factory_config.ts";
import { ARTIFACT_TOOLS } from "./factory_agent_settings.ts";
import { mainBranch } from "./factory_mcp.ts";
import { flags as modelFlags, ModelsError, validate } from "./factory_models.ts";
// What reads GitHub is loaded when a command needs it, so `vars`, `prompt`, `permission-flags` and `claude-flags` (the
// loop asks for them every pass) need only the settings, and the orchestrator can import this module.
import { bunCmd, die, Exit, pyDumps, pyRepr, run, runMain, shQuote, splitLines } from "./factory_lib.ts";

const DOC = `Factory roles (#102): the small per-role definition the shared loop runner (factory-loop.sh) reads, and the
project's role folder.

  factory_roles.ts vars <role>                 shell assignments for the loop runner (kind, skill, waits ...)
  factory_roles.ts names <role>                the role's names, one per line
  factory_roles.ts nth <role> <N>              the Nth name (so \`factory dev-manager 2 loop\` means the second)
  factory_roles.ts work <role> [--name N]      exit 0 and one line per thing to do, or exit 3 "nothing to do"
  factory_roles.ts prompt <role> <name> [arg]  the prompt a pass starts with (ends with a marker for factory usage)
  factory_roles.ts permission-flags            the flags that give a headless run its permissions, one per line
  factory_roles.ts claude-flags <role>         the settings flags for the role's sessions, one per line
  factory_roles.ts choose                      ask for a role and a name (factory loop -i); prints "role name"
  factory_roles.ts init [--force]              scaffold the role folders (factory init-roles)
  factory_roles.ts digest <role>               the role folder and its reads.md, one line (the dry run prints it)
  factory_roles.ts reads [role]                every path in reads.md that does not exist (exit 1 when any)
`;

export interface RoleDef {
  title: string;
  kind: string;
  skill: string;
  model: string;
  notes: string;
}

export const ROLE_DEFS: Record<string, RoleDef> = {
  "coding-agent": { title: "coding agent", kind: "task", skill: "next-task", model: "builder", notes: "next-task" },
  "dev-manager": { title: "dev manager", kind: "orchestrator", skill: "manage-pass", model: "manager", notes: "manager" },
  "product-owner": { title: "product owner", kind: "claude", skill: "product-pass", model: "product-owner", notes: "product-owner" },
};
export const MARK = "factory-role";
export { ROLE_NAMES };

export function need(role: string): RoleDef {
  const d = ROLE_DEFS[role];
  if (!d) die(`factory: '${role}' isn't a role. The roles are ${ROLE_NAMES.join(", ")}.`);
  return d;
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

/** The project's folder for `role` when it exists, else null. */
export function roleDir(cfg: Config, role: string): string | null {
  const path = join(rolesDir(cfg), role);
  return isDir(path) ? path : null;
}

/** The old-style note (`<notes>/<name>.md`) for the role when it exists, else null. */
export function notesFile(cfg: Config, role: string): string | null {
  const folder = cfg.notes || DEFAULTS.notes;
  const path = join(folder, `${need(role).notes}.md`);
  return isFile(path) ? path : null;
}

/** The sentence a pass starts with so it reads the project's instructions first, and nothing else up front. */
export function contextLine(cfg: Config, role: string): string {
  const folder = roleDir(cfg, role);
  if (folder) {
    return `Read ${folder}/README.md first, then ${folder}/reads.md, and open only the documents it lists ` +
      "that this work needs.";
  }
  const note = notesFile(cfg, role);
  if (note) return `Read ${note} first (this project's additions for the ${need(role).title}).`;
  return "";
}

/** The first line of a role session's prompt. A role session reads only the user's settings and its profile
 * (`--setting-sources user`, profileFlags), and then Claude Code does not load the project's skills: a prompt that
 * starts with `/manage-pass` is an unknown command. So the line names the skill's file, which works whether or not the
 * skill is loaded. */
export function skillLine(skill: string, item = ""): string {
  const call = `/${skill}` + (item ? ` ${item}` : "");
  return `Follow the ${skill} skill${item ? ` for ${item}` : ""}: read .claude/skills/${skill}/SKILL.md and run it as ` +
    `\`${call}\` (this session does not load the project's skills, so ${call} is not a command here).`;
}

/** The prompt a pass starts with: the skill (and the item), `extra` (the dev manager's fact sheet and thread note),
 * the line telling it to read the project's instructions, and the marker `factory usage --by role` reads. */
export function prompt(cfg: Config, role: string, name: string, item = "", extra = ""): string {
  const first = skillLine(need(role).skill, item);
  const ctx = contextLine(cfg, role);
  return [first, extra.trim(), ctx, `<!-- ${MARK} role=${role} name=${name} -->`].filter((x) => x).join("\n\n");
}

// --- reads.md ------------------------------------------------------------------------------------------------------

export type ReadRow = [path: string, section: string, reason: string];

/** [(path, section, reason)] from a reads.md: `- path#section - why` or `path  why`, `#` lines are comments. */
export function parseReads(text: string): ReadRow[] {
  const out: ReadRow[] = [];
  for (const raw of splitLines(text)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("<!--")) continue;
    line = line.replace(/^[-*]\s+/, "");
    const m = /^`([^`]+)`\s*(?:[-:–—]\s*)?(.*)$/.exec(line) || /^(\S+)\s*(?:[-:–—]\s+)?(.*)$/.exec(line);
    if (!m) continue;
    const target = m[1] as string;
    const why = (m[2] as string).trim();
    const at = target.indexOf("#");
    out.push(at < 0 ? [target, "", why] : [target.slice(0, at), target.slice(at + 1), why]);
  }
  return out;
}

function globMatches(pattern: string): boolean {
  try {
    for (const _ of new Bun.Glob(pattern).scanSync({ cwd: ".", onlyFiles: false })) return true;
  } catch {
    return false;
  }
  return false;
}

/** The paths in the role's reads.md that don't exist (a glob must match something), or null without a file. */
export function missingReads(cfg: Config, role: string): string[] | null {
  const folder = roleDir(cfg, role);
  const reads = folder ? join(folder, "reads.md") : "";
  if (!folder || !isFile(reads)) return null;
  const bad: string[] = [];
  for (const [path] of parseReads(readFileSync(reads, "utf8"))) {
    if (path.includes("://")) continue;
    if (!(/[*?[]/.test(path) ? globMatches(path) : existsSync(path))) bad.push(path);
  }
  return bad;
}

// --- scaffolding ---------------------------------------------------------------------------------------------------

export const README: Record<string, string> = {
  "coding-agent": `# Coding agent: this project's instructions

The factory's \`next-task\` skill says how a task is built. This file is what the skill cannot know about this
project: known flaky tests, protected paths, numbering rules for decisions and migrations, who the owner is, the
product's voice. Keep it short; the agent reads it before every task.

- Protected paths (a person merges these): see \`protected\` in \`.claude/factory.json\`.
- Known flakes:
- Numbering rules:
- Who the owner is:
`,
  "dev-manager": `# Dev manager: this project's instructions

The factory's \`manage-pass\` skill holds the standing rules (what the manager does on its own, what it asks the owner,
the markers, the merge command). This file is what is specific to this project. It is read before every item.

- Known flaky CI jobs (the only ones a manager may re-run):
- Protected paths (the owner merges these):
- Decision and migration number rules:
- Who the owner is, and how to reach them (the login to mention in a question):
- Watch items for review:
`,
  "product-owner": `# Product owner: this project's instructions

The factory's \`product-pass\` skill says how a pass runs. This file is what is specific to this project: the product,
who it is for, the voice, what the owner decides alone, and where the PRD and the designs live (see \`reads.md\`).

- The product in one paragraph:
- The owner decides alone:
- Voice and wording rules:
- Where open product questions are asked (the owner queue):
`,
};

/** The reads.md a new role folder starts with: the project's own documents that exist, each with a reason. */
export function defaultReads(cfg: Config, role: string): string {
  const rows: Record<string, [string | undefined, string][]> = {
    "coding-agent": [["CLAUDE.md", "the project's rules"], [cfg.plan, "the build plan: the task's section"],
      [cfg.prd, "the PRD: only the sections a task points to"], [cfg.decisions, "decision records the task names"]],
    "dev-manager": [["CLAUDE.md", "the project's rules, the review checklist"], [cfg.plan, "the build plan, to place a task"],
      [cfg.blocked, "what is blocked and why"], [cfg.decisions, "the decisions index, for the numbering rule"],
      [".claude/hooks/pr-gate.ts", "the PR gate: what an agent may merge"]],
    "product-owner": [["CLAUDE.md", "the project's rules"], [cfg.prd, "the PRD: user stories and decisions"],
      ["design", "design references, STYLE.md first"], [cfg.decisions, "decision records"], ["research", "research notes"]],
  };
  const lines = (rows[role] ?? []).filter(([path]) => path && existsSync(path)).map(([path, why]) => `- ${path} - ${why}`);
  const head = "# What this role reads\n#\n" +
    "# One document per line: `path` or `path#section`, then a dash and why. The role's skill reads this list\n" +
    "# first and nothing else up front, so a pass does not load the whole PRD or the repo's docs. A section lets\n" +
    "# the role `grep -n` for it. `factory doctor` checks that every path exists. Lines starting with # are notes.\n\n";
  return head + (lines.length ? lines.join("\n") + "\n" : "- CLAUDE.md - the project's rules\n");
}

/** Creates <roles.dir>/<role>/README.md and reads.md for every role; never overwrites unless force. */
export function init(cfg: Config, force = false): string[] {
  const made: string[] = [];
  for (const role of ROLE_NAMES) {
    const folder = join(rolesDir(cfg), role);
    mkdirSync(folder, { recursive: true });
    for (const [name, text] of [["README.md", README[role] as string], ["reads.md", defaultReads(cfg, role)]] as const) {
      const path = join(folder, name);
      if (force || !existsSync(path)) {
        writeFileSync(path, text);
        made.push(path);
      }
    }
  }
  return made;
}

// --- the loop runner's questions -----------------------------------------------------------------------------------

/** Python's f"{x:g}". */
export function pyG(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (x === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split("e") as [string, string];
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const n = Number(e);
    return `${mant}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const s = x.toPrecision(6);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function shellVars(cfg: Config, role: string): string {
  const d = need(role);
  const wait = (kind: "busy" | "idle"): number => roleWait(cfg, role, kind);
  const pairs: [string, string][] = [["kind", d.kind], ["skill", d.skill], ["model_role", d.model], ["title", d.title],
    ["busy", role !== "coding-agent" ? pyG(wait("busy")) : "0"],
    ["idle", role !== "coding-agent" ? pyG(wait("idle")) : "0"],
    ["profile", String(roleSetting(cfg, role, "profile", "") || "")]];
  return pairs.map(([k, v]) => `role_${k}=${shQuote(v)}`).join("\n");
}

/** JSON as Python's json.dumps(x, separators=(",", ":")) wrote it: compact, non-ASCII escaped. */
function compactJson(x: unknown): string {
  return JSON.stringify(x).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Whether `role` may use the artifact tools (#104): only the product owner, and only when
 * `roles.product-owner.artifacts` is true in `.claude/factory.json` as main has it on origin, never this folder's copy
 * (a role must not turn it on for itself). When main can't be read: no. */
export function artifactsAllowed(role: string): boolean {
  if (role !== "product-owner") return false;
  const branch = mainBranch();
  if (!branch || run(["git", "fetch", "-q", "origin", `refs/heads/${branch}`], { timeoutMs: 60_000 }).code !== 0) return false;
  const shown = run(["git", "show", "FETCH_HEAD:.claude/factory.json"], { timeoutMs: 60_000 });
  if (shown.code !== 0) return false;
  try {
    const roles = (JSON.parse(shown.stdout) as { roles?: Record<string, { artifacts?: unknown } | undefined> }).roles;
    return roles?.[role]?.artifacts === true;
  } catch {
    return false;
  }
}

/** `settings` with the artifact tools denied, or, when `allowed`, with no deny rule for them (a profile's own too). */
export function withArtifacts(settings: Record<string, unknown>, allowed: boolean): Record<string, unknown> {
  const { permissions, ...rest } = settings;
  const perms = typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)
    ? { ...permissions as Record<string, unknown> } : {};
  const deny = (Array.isArray(perms.deny) ? perms.deny : []).filter((d) => !ARTIFACT_TOOLS.includes(d as string));
  if (!allowed) deny.push(...ARTIFACT_TOOLS);
  if (deny.length) perms.deny = deny;
  else delete perms.deny;
  return Object.keys(perms).length ? { permissions: perms, ...rest } : rest;
}

/** The settings flags for a role's sessions. With a profile file, the session reads only the user's settings and
 * that profile (the project's own settings deny `gh api`, and the profile has to allow it): `--setting-sources user
 * --settings <profile + no claude.ai connectors>`. Without one, today's flags. Either way the artifact tools are
 * denied unless the role may use them (artifactsAllowed). */
export function profileFlags(cfg: Config, role: string): string[] {
  const off = { disableClaudeAiConnectors: true };
  const path = String(roleSetting(cfg, role, "profile", "") || "");
  const allowed = artifactsAllowed(role);
  if (role === "coding-agent" || !path || !isFile(path)) return ["--settings", pyDumps(withArtifacts(off, allowed))];
  let profile: unknown;
  try {
    profile = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`factory: the ${role} profile ${path} isn't valid JSON (${e instanceof Error ? e.message : String(e)}). Fix it, or set ` +
      `\`roles.${role}.profile\` to another file.`);
  }
  const base = typeof profile === "object" && profile !== null && !Array.isArray(profile) ? profile as Record<string, unknown> : {};
  return ["--setting-sources", "user", "--settings", compactJson(withArtifacts({ ...base, ...off }, allowed))];
}

/** The flags that give an unattended (`claude -p`) run its permissions (#179): `--permission-mode <permissionMode>`,
 * or none when the setting is `default` (the user's own Claude Code settings decide). A value that is not a mode
 * falls back to the default one; `factory settings validate` names it. */
export function permissionFlags(cfg: Config): string[] {
  const mode = cfg.permissionMode ?? DEFAULTS.permissionMode;
  if (mode === "default") return [];
  return ["--permission-mode", mode === "acceptEdits" ? mode : DEFAULTS.permissionMode];
}

/** The `claude` arguments for a session of `role` started from a script (the orchestrator's sub-managers), the same
 * the loop script builds: only the project's MCP servers as main has them, the role's profile, and the model. */
export function sessionFlags(cfg: Config, role: string): string[] {
  const mcp = run(bunCmd(join(import.meta.dir, "factory_mcp.ts"))).stdout.trim() || '{"mcpServers":{}}';
  const flags = ["--mcp-config", mcp, "--strict-mcp-config", ...profileFlags(cfg, role)];
  try {
    flags.push(...modelFlags(need(role).model, validate(cfg.models === undefined ? {} : cfg.models)));
  } catch (e) {
    if (!(e instanceof ModelsError)) throw e;
    die(`factory: ${e.message} Fix it with \`factory settings set models '<json>'\`.`);
  }
  return flags;
}

/** What `role` has to do now, one line each, empty when nothing. Reads GitHub only. */
export async function work(cfg: Config, role: string, _name = ""): Promise<string[]> {
  if (role === "product-owner") {
    const { ghAll } = await import("./factory_issues.ts");
    const { digest: signoffDigest } = await import("./factory_signoff.ts");
    const lines: string[] = [];
    const label = String(roleSetting(cfg, role, "workLabel", "") || "");
    if (label) {
      const items = ghAll(`repos/{owner}/{repo}/issues?state=open&labels=${label}`);
      lines.push(...items.map((i) => `${i.pull_request ? "PR" : "issue"} #${i.number}: ${i.title} (${label})`));
    }
    return [...lines, ...await poQuestions(cfg), ...await productAsks(cfg), ...signoffDigest(cfg)];
  }
  if (role === "dev-manager") return (await import("./factory_wait.ts")).precheck(cfg);
  die("factory: a coding agent's work is `factory next`.");
}

/** One line per question addressed `to=po` that is the product owner's to answer now (#110): not yet moved up to the
 * dev manager. Oldest first. This pass is a product owner running, so one is assumed to run. */
export async function poQuestions(cfg: Config): Promise<string[]> {
  const { questions } = await import("./factory_po.ts");
  return questions(cfg, { poRunning: true }).filter((q) => q.level === "po")
    .map((q) => `question ${q.id} (to=po) on ${q.what} #${q.number} from ${q.frm}, waiting ${(q.age / 60).toFixed(1)} h: ${q.summary}`);
}

/** One line per owner-queue ask tagged `for=product` that nobody has answered: scope, order, PRD and wording
 * questions the dev manager sends the product owner (`<!-- factory-owner-ask id=<slug> for=product -->`). */
export async function productAsks(cfg: Config): Promise<string[]> {
  const { ghAll } = await import("./factory_issues.ts");
  const { ownerQueue } = await import("./factory_orchestrator.ts");
  const { openOwnerAsks, trustedOf } = await import("./factory_prs.ts");
  const queue = ownerQueue(cfg, false);
  if (!queue) return [];
  const out: string[] = [];
  const comments = ghAll<Record<string, unknown>>(`repos/{owner}/{repo}/issues/${queue}/comments`);
  for (const [slug, c] of openOwnerAsks(comments, trustedOf(cfg))) {
    const body = typeof c.body === "string" ? c.body : "";
    if (/<!--\s*factory-owner-ask\b[^>]*\bfor=product\b/.test(body)) {
      const text = splitLines(body.replace(/<!--[\s\S]*?-->/g, "").trim());
      out.push(`owner queue #${queue}, ask ${slug} for product: ${(text[0] ?? "").slice(0, 100)}`);
    }
  }
  return out;
}

/** What `factory <role> loop --dry-run` prints besides the work: where the role's instructions are, and whether
 * every document in its reads.md exists. Reads the working tree only. */
export function digest(cfg: Config, role: string, _name = ""): string[] {
  const folder = roleDir(cfg, role);
  if (!folder) {
    const note = notesFile(cfg, role);
    return [`reads: no role folder at ${rolesDir(cfg)}/${role}/` + (note ? `; falls back to ${note}` : "") + " (factory init-roles adds it)"];
  }
  const miss = missingReads(cfg, role);
  const reads = join(folder, "reads.md");
  const n = isFile(reads) ? parseReads(readFileSync(reads, "utf8")).length : 0;
  const line = `reads: ${folder}/ (README.md, reads.md: ${n} document${n !== 1 ? "s" : ""}`;
  return [line + (miss && miss.length ? `, ${miss.length} missing: ${miss.join(", ")})` : ")")];
}

/** One line from stdin (sys.stdin.readline), read a byte at a time so nothing past it is taken. */
function readLine(): string {
  const buf = Buffer.alloc(1);
  let out = "";
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      if ((e as { code?: string }).code === "EAGAIN") continue;
      return out;
    }
    if (n === 0) return out;
    const c = buf.toString("utf8", 0, 1);
    out += c;
    if (c === "\n") return out;
  }
}

/** Asks which role and which name (factory loop -i with no role). Returns [role, name]. */
export async function choose(): Promise<[string, string]> {
  const { freeNames } = await import("./factory_claims.ts");
  const write = (s: string): void => {
    process.stderr.write(s);
  };
  const cfg = load();
  const roles = [...ROLE_NAMES] as string[];
  write("Which role?\n" + roles.map((r, i) => `  ${i + 1}) ${(ROLE_DEFS[r] as RoleDef).title}\n`).join("") + "[1]: ");
  const pick = readLine().trim();
  let role: string;
  if (!pick) role = roles[0] as string;
  else if (/^\d+$/.test(pick) && Number(pick) >= 1 && Number(pick) <= roles.length) role = roles[Number(pick) - 1] as string;
  else if (roles.includes(pick)) role = pick;
  else die(`factory: '${pick}' isn't one of the roles (1 to ${roles.length}, or ${roles.join(", ")}).`);
  let free: string[];
  try {
    free = freeNames(role, toFloat(cfg.claimStaleHours ?? 6) ?? 6);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    free = [];
  }
  write(`Which name? Free names: ${free.join(", ") || "(none; type a new one)"}\n` +
    `Press Enter for ${free.length ? free[0] : "the first"}, or type one: `);
  let name = readLine().trim();
  if (name) name = safeAgent(name);
  else if (free.length) name = free[0] as string;
  return [role, name];
}

export async function main(argv: string[]): Promise<number | void> {
  if (!argv.length) die(DOC);
  const [cmd, ...rest] = argv as [string, ...string[]];
  const cfg = load();
  if (cmd === "permission-flags") {
    console.log(permissionFlags(cfg).join("\n"));
    return;
  }
  if (cmd === "choose") {
    const [role, name] = await choose();
    console.log(role, name);
  } else if (cmd === "init") {
    const made = init(cfg, rest.includes("--force"));
    for (const p of made) console.log(`added    ${p}`);
    console.log(made.length ? `The role folders are in ${rolesDir(cfg)}/.` : `${rolesDir(cfg)}/ already has them.`);
  } else if (cmd === "reads") {
    const roles = rest.length ? rest : [...ROLE_NAMES];
    let bad = 0;
    for (const role of roles) {
      need(role);
      const miss = missingReads(cfg, role);
      if (miss === null) continue;
      for (const p of miss) {
        bad += 1;
        console.log(`${role}: ${p} (listed in ${rolesDir(cfg)}/${role}/reads.md) does not exist`);
      }
    }
    return bad ? 1 : 0;
  } else if (["vars", "names", "nth", "work", "prompt", "claude-flags", "digest"].includes(cmd)) {
    if (!rest.length) die(`usage: factory_roles.ts ${cmd} <role>`);
    const role = rest[0] as string;
    need(role);
    if (cmd === "vars") console.log(shellVars(cfg, role));
    else if (cmd === "names") console.log(roleNames(cfg, role).join("\n"));
    else if (cmd === "nth") {
      const names = roleNames(cfg, role);
      const n = rest.length > 1 && /^\d+$/.test(rest[1] as string) ? Number(rest[1]) : 0;
      if (!(n >= 1 && n <= names.length)) {
        const shown = rest.length > 1 ? "[" + rest.slice(1).map(pyRepr).join(", ") + "]" : "";
        die(`factory: there is no ${role} number ${shown}; the names are ${names.join(", ")}.`);
      }
      console.log(names[n - 1]);
    } else if (cmd === "work") {
      const lines = await work(cfg, role);
      console.log(lines.length ? lines.join("\n") : "nothing to do");
      return lines.length ? 0 : 3;
    } else if (cmd === "digest") console.log(digest(cfg, role).join("\n"));
    else if (cmd === "prompt") console.log(prompt(cfg, role, rest[1] ?? "", rest.slice(2).join(" ")));
    else console.log(profileFlags(cfg, role).join("\n"));
  } else {
    die(`factory_roles.ts: unknown command '${cmd}'.\n${DOC}`);
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
