// Reads .claude/factory.json for the factory hooks and scripts. Missing keys fall back to these defaults.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { die, fnmatch, pyRepr, run } from "./factory_lib.ts";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface Commands {
  typecheck: string;
  lint: string;
  test: string;
  build: string;
  smoke: string;
  typecheckChanged: string;
  testChanged: string;
  ci: string;
  fix: string;
  stackUp: string;
  stackHealth: string;
  [key: string]: string;
}

export interface Style {
  paths?: string[];
  skills?: string[];
  check?: string;
  [key: string]: Json | undefined;
}

export interface TaskLabels {
  ready: string;
  inProgress: string;
  inReview: string;
  blocked: string;
  agentPrefix: string;
  [key: string]: string;
}

/** The settings. The fields the factory defines are typed; a project may add others (unknown until checked). */
export interface Config {
  prd: string;
  plan: string;
  blocked: string;
  decisions: string;
  numberedDirs: string[];
  mainBranch: string;
  permissionMode: string;
  commands: Commands;
  codePaths: string[];
  fixPaths: string[];
  checkOutputLines: number;
  checkLogDir: string;
  protected: string[];
  alwaysAllowed: string[];
  testPaths: string[];
  goldenPaths: string[];
  dependencyManifests: string[];
  maxOpenPRs: number;
  agents: string[];
  artifacts: { manifest: string; dir: string; fetch: string; info: string; [key: string]: Json };
  roles: { [key: string]: Json };
  manager: { [key: string]: Json };
  tasks: { source: string; labels: Partial<TaskLabels>; [key: string]: Json | Partial<TaskLabels> };
  claimStaleHours: number;
  prSizeWarn: number;
  reviewMarkers: string;
  reReviewPercent: number;
  lessons: string;
  lessonsCap: number;
  styles: Style[];
  checkRequires: string[];
  holdLabel: string;
  agentEnv: { [key: string]: Json };
  portStep: number;
  notes: string;
  reviews: { [key: string]: { paths?: string[]; [key: string]: Json | undefined } };
  eval: JsonObject;
  permissions: { allow: string[]; [key: string]: Json };
  turbo: { api: string; team: string; bind: string; port: number; secretsCommand: string; [key: string]: Json };
  design: JsonObject;
  release: { repo: string; [key: string]: Json };
  [key: string]: unknown;
}

export const DEFAULTS: Config = {
  prd: "docs/PRD.md",
  plan: "docs/build-plan.md",
  blocked: "docs/blocked.md",
  decisions: "docs/decisions",
  // More folders of numbered files besides `decisions` (for example ["db/migrations"]): a new file there must take a
  // number neither main nor another open PR has (factory_numbers.ts, checked by the PR gate).
  numberedDirs: [],
  mainBranch: "main",
  // How an unattended run (`claude -p`, started by the loops and the dev manager's sub-managers) gets its permissions
  // (#179): "acceptEdits" passes --permission-mode acceptEdits, so edits inside the project need no answer and the
  // allow list in .claude/factory/settings.json covers the commands. "default" passes nothing: your own Claude Code settings
  // decide (`factory doctor` says when a run would then stall).
  permissionMode: "acceptEdits",
  // typecheckChanged / testChanged: the Stop check runs these instead of typecheck / test when set, for the changed
  // packages only. fix: a formatter and auto-fixer for the files this branch changed (#69). ci: what CI runs, for
  // `factory verify`; when set on main, the PR gate needs it passed for the PR's commit. stackUp / stackHealth: what
  // `factory resume` runs at boot to bring the dev stack back, and a command that passes once it is healthy (#88).
  commands: {
    typecheck: "", lint: "", test: "", build: "", smoke: "",
    typecheckChanged: "", testChanged: "", ci: "", fix: "", stackUp: "", stackHealth: "",
  },
  codePaths: ["src"],
  // Regexes: when set, `commands.fix` gets only changed files matching one of them (empty: every changed file).
  fixPaths: [],
  // How many lines of a failing Stop check the agent sees: the failing lines first, then the end of the output.
  checkOutputLines: 40,
  // Where the full output of a failed check is saved (the agent sees only a capped summary and this path).
  checkLogDir: "tmp/checks",
  // The loop script and the CLI too: factory-loop.sh runs main's copy, so a merged change runs in every loop (#260). A bunfig.toml
  // can preload code into every Bun the project starts (#259).
  protected: ["^CLAUDE\\.md$", "^\\.claude/", "^\\.github/", "^\\.mcp\\.json$", "^factory$", "^factory-loop\\.sh$", "\\.env",
    "(^|/)(pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|bun\\.lockb?)$", "(^|/)\\.?bunfig\\.toml$"],
  alwaysAllowed: ["docs/build-plan.md", "docs/blocked.md"],
  // Tests and expected outputs: the implementer must not quietly change them (factory_guard.ts).
  testPaths: ["(^|/)__tests__/", "\\.(test|spec)\\.[cm]?[jt]sx?$", "(^|/)e2e/", "(^|/)tests?/",
    "_test\\.(py|go)$", "(^|/)test_[^/]*\\.py$"],
  goldenPaths: ["(^|/)__snapshots__/", "(^|/)fixtures?/", "(^|/)golden[^/]*/"],
  dependencyManifests: ["(^|/)package\\.json$"],
  maxOpenPRs: 3,
  // The agents' names, one per loop: the first works in the project folder, the others in <project>-agents/<name>.
  // Labels (`agent:<name>`), claims and logs use them.
  agents: ["menelik", "taytu", "haile", "tewodros", "yohannes", "zewditu", "lalibela", "ezana", "alula", "abebe"],
  // Artifacts and designs kept as reviewed copies in the repo (#104, `factory artifacts`).
  artifacts: { manifest: "docs/artifacts.json", dir: "docs/artifacts", fetch: "", info: "" },
  // Roles other than the coding agent (#102): `factory dev-manager [name] loop`, `factory product-owner [name] loop`.
  roles: {
    dir: ".claude/factory/roles",
    "dev-manager": { names: ["fasil", "yekuno", "amda", "sarsa", "susenyos"], profile: ".claude/manager/settings.json" },
    "product-owner": {
      names: ["mentewab", "eleni", "sabla"], busyMinutes: 30, idleMinutes: 60,
      profile: ".claude/product-owner/settings.json", workLabel: "factory:needs-product",
      escalateMinutes: 120, logins: [], artifacts: false,
    },
  },
  // The dev manager (#97, #109): an orchestrator with no model, starting one-item sub-managers.
  manager: {
    busyMinutes: 2, idleMinutes: 5, maxSubManagers: 2, claimMinutes: 20, deadManMinutes: 30,
    notify: "", quietMinutes: 5, staleMinutes: 15, ownerWaitMinutes: 120, agentIdleMinutes: 45,
    ciQueuedMinutes: 10, subManagerMinutes: 30,
  },
  // Where tasks live. "plan": unticked lines of the build plan. "issues": open GitHub issues with the `ready` label.
  tasks: {
    source: "plan",
    labels: { ready: "factory:ready", inProgress: "factory:in-progress", inReview: "factory:in-review",
      blocked: "factory:blocked", agentPrefix: "agent:" },
    staleHours: 3, // an in-progress issue with no activity for this long goes back to ready (dev manager)
    pingMinutes: 5, // an agent pings its agent issue at most this often while it works
    downMinutes: 30, // no ping for this long: the agent counts as down, and the sweep releases its issues
    // The heartbeat daemon (#108).
    heartbeatSeconds: 20,
    heartbeatMissMinutes: 12,
    releaseDownMinutes: 10,
  },
  claimStaleHours: 6, // a loop's task claim lapses after this (or when its process exits)
  prSizeWarn: 600,
  reviewMarkers: "tmp/reviews",
  // A reviewer's second round reads only the delta since its last round (factory_rereview.ts): the limit, as a percent
  // of the branch diff's changed lines, above which it is a full review. 0: always a full review.
  reReviewPercent: 30,
  // The curated lessons file (factory_lessons.ts) and the most lessons it may hold.
  lessons: ".claude/factory/lessons.md",
  lessonsCap: 40,
  // Style guides per path: [{"paths": ["apps/api/**"], "skills": [...], "check": "..."}].
  styles: [],
  // The Stop check skips while any of these is missing, e.g. ["node_modules"] before the first install.
  checkRequires: [],
  // The label the dev manager puts on a PR it is reviewing: agents skip it (no rework) and can't merge it.
  holdLabel: "factory-hold",
  // Per-loop environment for parallel loops (factory_env.ts).
  agentEnv: {},
  portStep: 10,
  // Project additions for the shared agents and skills: <notes>/<agent or skill name>.md, read first if present.
  notes: ".claude/factory/notes",
  // Which changes need which extra review or check (regexes on changed paths, like `protected`).
  reviews: {
    "safety-auditor": { paths: [] }, // the rules CLAUDE.md says must never break
    "security-reviewer": { paths: [] }, // auth, payments, public endpoints, uploads, storage, tenancy, secrets
  },
  // The eval skill. Empty command: no eval yet.
  eval: {},
  // Allow rules the project adds to the agents' settings (#198, #258).
  permissions: { allow: [] },
  // The shared Turborepo remote cache (factory_turbo.ts, `factory turbo`, #59).
  turbo: { api: "", team: "", bind: "127.0.0.1", port: 3335, secretsCommand: "" },
  // The design-check skill. Empty references: no design check.
  design: {},
  // Where `factory update` finds releases of the factory (#113).
  release: { repo: "deresegetachew/my-skills" },
};

function isObject(v: unknown): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function copy<T>(v: T): T {
  return structuredClone(v);
}

/** A nested setting (`roles`, `manager`) with the defaults under it: a project that sets one field of one role keeps
 * the rest. */
export function mergedSection(name: "roles" | "manager", user: unknown): { [key: string]: Json } {
  const base = DEFAULTS[name];
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(base)) out[k] = isObject(v) ? { ...copy(v) } : copy(v);
  if (isObject(user)) {
    for (const [key, value] of Object.entries(user)) {
      const have = out[key];
      if (isObject(value) && isObject(have)) Object.assign(have, value);
      else out[key] = value;
    }
  }
  return out;
}

export function mergedRoles(user: unknown): { [key: string]: Json } {
  return mergedSection("roles", user);
}

function apply(user: unknown): Config {
  const cfg: Config = copy(DEFAULTS);
  if (!isObject(user)) return cfg;
  for (const [k, v] of Object.entries(user)) if (!k.startsWith("_")) (cfg as Record<string, unknown>)[k] = v;
  const commands = isObject(user.commands) ? user.commands : {};
  cfg.commands = { ...DEFAULTS.commands, ...(commands as Partial<Commands>) } as Commands;
  cfg.roles = mergedRoles(user.roles);
  cfg.manager = mergedSection("manager", user.manager);
  return cfg;
}

/** The settings of the project in CLAUDE_PROJECT_DIR (default: here), with the defaults under them. Changes into the
 * project folder, as the hooks expect. */
export function load(): Config {
  const root = process.env.CLAUDE_PROJECT_DIR || ".";
  process.chdir(root);
  let text: string;
  try {
    text = readFileSync(join(".claude", "factory.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return copy(DEFAULTS);
    throw e;
  }
  return apply(JSON.parse(text) as unknown);
}

/** The settings as the repository's default branch has them on GitHub, never this machine's copy or refs.
 *
 * The PR gate enforces these settings, so an agent must not be able to change them from its worktree (#51): not by
 * editing `.claude/factory.json`, not by setting `mainBranch`, and not by planting a local ref or tag named
 * `origin/<main>`. So the branch comes from GitHub (`gh repo view`) and the file is read through the API at that
 * branch. A 404 (no file on main yet) gives the defaults; any other failure throws, so the gate fails closed. */
export function loadFromMain(_local?: unknown): Config {
  let p = run(["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
  const main = p.stdout.trim();
  if (p.code !== 0 || !/^[\w./-]+$/.test(main)) {
    throw new Error("could not ask GitHub for the default branch (gh repo view): " + p.stderr.trim().slice(0, 200));
  }
  p = run(["gh", "api", `repos/{owner}/{repo}/contents/.claude/factory.json?ref=${main}`, "-H", "Accept: application/vnd.github.raw"]);
  if (p.code !== 0) {
    if (p.stderr.includes("404") || p.stderr.includes("Not Found")) {
      const cfg = copy(DEFAULTS);
      cfg.mainBranch = main;
      return cfg; // main has no factory.json yet: the defaults
    }
    throw new Error(`could not read .claude/factory.json on ${main} from GitHub: ` + p.stderr.trim().slice(0, 200));
  }
  const cfg = apply(JSON.parse(p.stdout) as unknown);
  cfg.mainBranch = main; // GitHub's default branch wins over the file's own `mainBranch`
  return cfg;
}

/** Does `path` match one of the regexes (Python re.search)? */
export function matches(path: string, patterns: readonly string[]): boolean {
  return patterns.some((rx) => new RegExp(rx).test(path));
}

export type PlanTask = [id: string, done: boolean, title: string];

/** [(id, done, title)] in plan order. Title is the bold text after the id. */
export function tasks(planText: string): PlanTask[] {
  const out: PlanTask[] = [];
  for (const m of planText.matchAll(/^[^\S\n]*- \[( |x|X)\] \*\*(\d+(?:\.\d+)*)\s*([^*]*)\*\*/gm)) {
    out.push([m[2] as string, (m[1] as string).toLowerCase() === "x", (m[3] as string).trim().replace(/\.+$/, "")]);
  }
  return out;
}

export function blockedIds(blockedText: string): Set<string> {
  return new Set([...blockedText.matchAll(/^\s*-\s*(\d+(?:\.\d+)*)\s*:/gm)].map((m) => m[1] as string));
}

/** task/1-3-validators or task/1.3-validators -> '1.3'; anything else -> null. */
export function branchTask(branch: string): string | null {
  const m = /^task\/(\d+(?:[.-]\d+)*?)-[a-z]/.exec(branch) ?? /^task\/(\d+(?:[.-]\d+)*)$/.exec(branch);
  return m ? (m[1] as string).replace(/-/g, ".") : null;
}

/** The style entries whose `paths` globs match any of `paths` (fnmatch; `**` matches across folders). */
export function styled(paths: readonly string[], cfg: Config): Style[] {
  return (cfg.styles ?? []).filter((style) => {
    const globs = style.paths ?? [];
    return paths.some((p) => globs.some((g) => fnmatch(p, g)));
  });
}

/** `name` if it's a valid agent name (lowercase letters, digits, dashes), else stop. Names become folder and file
 * names and labels, so a name like ../x must never reach a path. */
export function safeAgent(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    const shown = typeof name === "string" ? pyRepr(name) : name === null || name === undefined ? "None" : String(name);
    die(`${shown} isn't a valid agent name: use lowercase letters, digits and dashes ` +
      "(`agents` in .claude/factory.json, or FACTORY_AGENT).");
  }
  return name;
}

/** The name of the agent in slot `slot` (1 = the project folder). */
export function agentName(cfg: Config, slot: number): string {
  const names = cfg.agents ?? [];
  return slot > 0 && slot <= names.length ? safeAgent(names[slot - 1]) : `agent-${slot}`;
}

/** The slot of agent `name` ("taytu", or the old "agent-2"); null when it isn't one. */
export function agentSlot(cfg: Config, name: string | null | undefined): number | null {
  const names = cfg.agents ?? [];
  if (name && names.includes(name)) return names.indexOf(name) + 1;
  const m = /^agent-(\d+)$/.exec(name ?? "");
  return m ? Number(m[1]) : null;
}

export function taskSource(cfg: Config): string {
  return (isObject(cfg.tasks) && typeof cfg.tasks.source === "string" ? cfg.tasks.source : "plan") || "plan";
}

export function taskLabels(cfg: Config): TaskLabels {
  const mine = isObject(cfg.tasks) && isObject(cfg.tasks.labels) ? (cfg.tasks.labels as Partial<TaskLabels>) : {};
  return { ...(DEFAULTS.tasks.labels as TaskLabels), ...mine } as TaskLabels;
}

export const ROLE_NAMES = ["coding-agent", "dev-manager", "product-owner"] as const;

/** The project's role folder (`roles.dir`), relative to the project root. */
export function rolesDir(cfg: Config): string {
  const dir = isObject(cfg.roles) ? cfg.roles.dir : undefined;
  return String(dir || DEFAULTS.roles.dir).replace(/\/+$/, "");
}

/** One field of a role's `roles.<role>` setting, else its default. */
export function roleSetting(cfg: Config, role: string, key: string, dflt: Json = null): Json {
  const mine = isObject(cfg.roles) ? cfg.roles[role] : undefined;
  if (isObject(mine) && key in mine) return mine[key] as Json;
  const base = DEFAULTS.roles[role];
  return isObject(base) ? (key in base ? (base[key] as Json) : dflt) : dflt;
}

/** The names a role's loops take, in order: `agents` for the coding agent, `roles.<role>.names` for the others. */
export function roleNames(cfg: Config, role: string): string[] {
  const names = (role === "coding-agent" ? cfg.agents : roleSetting(cfg, role, "names", [])) as unknown;
  return (Array.isArray(names) ? names : []).map((n) => safeAgent(typeof n === "string" ? n : ""));
}

/** One field of the `manager` setting (#97), else its default. */
export function managerSetting(cfg: Config, key: string): Json {
  const mine = cfg.manager;
  return isObject(mine) && key in mine ? (mine[key] as Json) : (DEFAULTS.manager[key] as Json);
}

/** Python's float(): a number, a bool, or a numeric string; null when it is none of those. */
export function toFloat(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^\s*[+-]?(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?|inf(inity)?|nan)\s*$/i.test(value)) {
    const v = value.trim().toLowerCase().replace(/^([+-]?)inf(inity)?$/, "$1Infinity");
    return v === "nan" ? Number.NaN : Number(v);
  }
  return null;
}

/** Minutes a loop of `role` waits after a pass: kind is "busy" (the pass had work) or "idle" (it had none; 0 means
 * the loop exits instead). The dev manager's are `manager.busyMinutes` / `manager.idleMinutes`, the product owner's
 * `roles.product-owner.*`; the coding agent waits `waitMinutes` inside its own loop. */
export function roleWait(cfg: Config, role: string, kind: "busy" | "idle"): number {
  const key = `${kind}Minutes`;
  const value = role === "dev-manager" ? managerSetting(cfg, key) : roleSetting(cfg, role, key, 1);
  const f = toFloat(value);
  if (f === null) return role === "dev-manager" ? Number(DEFAULTS.manager[key]) : 1.0;
  return Math.max(0.0, f);
}
