// The one table that describes every factory setting (#49): key, type, default, section, short and long help,
// examples, who reads it, who must approve a change, and how a value is checked.
//
// `factory settings` (list, help, validate, set, the interactive menu) and the settings table in the wiki's settings
// page are all generated from it, so they can't drift apart. Defaults are not repeated here: they come from `DEFAULTS`
// in factory_config.ts, except for settings that have none there (the explicit `default` below).
//
// A setting is in the project scope (a key of .claude/factory.json, committed through a pull request) or in the machine
// scope (this machine's own file outside the repo, see factory_machine.ts; `factory settings --local`).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, safeAgent } from "./factory_config.ts";
import { render } from "./factory_env.ts";
import { Exit, pyDumps, pyRepr } from "./factory_lib.ts";
import { ModelsError, validate as validateModels } from "./factory_models.ts";

export { DEFAULTS };

// (Help text that starts "Empty" and then the word any is split in two, so tools/check_skills.ts does not take it for a type.)

// slug, title, who reads the settings in it (the default for "Read by" in the long help)
export const SECTIONS: [string, string, string][] = [
  ["paths", "Paths & docs", "next_task.ts (the task source), the PR gate, factory_numbers.ts and the agents"],
  ["commands", "Commands", "the Stop check (check.ts), `factory verify`, factory-loop.sh and `factory resume`"],
  ["tests", "Tests & protected paths", "the PR gate (pr-gate.ts) and the CI Factory guard (factory_guard.ts)"],
  ["gate", "PR gate & reviews", "the PR gate (pr-gate.ts), the CI guard, factory_reviews.ts and factory_rereview.ts"],
  ["agents", "Agents & loops", "factory-loop.sh, factory_claims.ts and factory_models.ts"],
  ["issues", "Issues mode", "factory_issues.ts, factory_agents.ts and next_task.ts"],
  ["ports", "Ports & per-agent env", "factory_env.ts (the environment of each loop)"],
  ["ci", "CI", "`factory ci` (ci.sh) and `factory status`"],
  ["design", "Design & eval", "the eval and design-check skills and factory_reviews.ts"],
  ["machine", "Machine (local)", "factory_machine.ts, `factory autostart`, `factory resume` and `factory loop`"],
];
export const SECTION_TITLE: Record<string, string> = Object.fromEntries(SECTIONS.map(([slug, title]) => [slug, title]));
export const SECTION_READERS: Record<string, string> = Object.fromEntries(SECTIONS.map(([slug, , readers]) => [slug, readers]));

export const KINDS = ["str", "int", "bool", "list", "dict", "enum"] as const;
export type Kind = (typeof KINDS)[number];
// #247 (owner's decision): a change under .claude/ is merged by the owner, never by the dev manager or an agent.
export const DEFAULT_REVIEW = "Any change to .claude/factory.json is under `.claude/`, which is protected: it goes through a pull " +
  "request that the owner merges.";

// Settings whose change needs more than that: the review label or decision they trigger.
export const NEEDS: Record<string, string> = {
  testPaths: "the dev manager's `tests-reviewed` label (changing what counts as a test after implementation)",
  goldenPaths: "the dev manager's `tests-reviewed` label (changing what counts as an expected output)",
  dependencyManifests: "the dev manager's `deps-reviewed` label (it decides what counts as a new dependency)",
  protected: "the owner's decision: it changes which files an agent may merge",
  alwaysAllowed: "the owner's decision: it changes which files an agent may merge",
  trustedReviewers: "the owner's decision: it changes whose approvals count",
  permissionMode: "the owner's decision: it changes what an unattended agent may do without asking",
  "permissions.allow": "the owner's decision: it changes what an unattended agent may run without asking",
  "roles.product-owner.artifacts": "the owner's decision: it lets a role's interactive sessions read claude.ai artifacts",
  mainBranch: "the owner's decision: the PR gate reads the branch from GitHub, so keep it the same",
  "reviews.safety-auditor.paths": "the owner's decision: it changes which changes get the safety auditor",
  "reviews.security-reviewer.paths": "the owner's decision: it changes which changes get the security reviewer",
};

/** A value that doesn't fit its setting; the message says what is wrong. */
export class SettingError extends Error {}

/** The "not set here" marker (Python's MISSING sentinel). */
export const MISSING: unique symbol = Symbol("MISSING");
export type Missing = typeof MISSING;

interface More {
  scope?: "project" | "machine";
  options?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number | null;
  items?: "str" | "json";
  regex?: boolean;
  long?: string;
  examples?: string[];
  read_by?: string;
  needs?: string;
}

export class Setting {
  key: string;
  kind: Kind;
  section: string;
  short: string;
  options: string[] | null;
  explicitDefault: unknown;
  scope: "project" | "machine";
  minimum: number;
  maximum: number | null;
  items: "str" | "json"; // what a list holds: text, or any JSON value
  regex: boolean; // a list of regexes: each one must compile
  long: string;
  examples: string[];
  readBy: string;
  needs: string;

  constructor(key: string, kind: Kind, section: string, short: string, more: More = {}) {
    this.key = key;
    this.kind = kind;
    this.section = section;
    this.short = short;
    this.options = more.options ?? null;
    this.explicitDefault = more.default ?? null;
    this.scope = more.scope ?? "project";
    this.minimum = more.minimum ?? 1;
    this.maximum = more.maximum ?? null;
    this.items = more.items ?? "str";
    this.regex = more.regex ?? false;
    this.long = more.long ?? "";
    this.examples = more.examples ?? [];
    this.readBy = more.read_by ?? (SECTION_READERS[section] as string);
    this.needs = more.needs ?? NEEDS[key] ?? "";
  }

  get default(): unknown {
    let node: unknown = DEFAULTS;
    for (const part of this.key.split(".")) {
      if (!isObject(node) || !(part in node)) return this.explicitDefault;
      node = node[part];
    }
    return this.scope === "project" ? node : this.explicitDefault;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function S(key: string, kind: Kind, section: string, short: string, more: More = {}): Setting {
  return new Setting(key, kind, section, short, more);
}

function table(list: Setting[]): Record<string, Setting> {
  return Object.fromEntries(list.map((s) => [s.key, s]));
}

export const SETTINGS: Record<string, Setting> = table([
  S("prd", "str", "paths", "Where the PRD lives. Agents read the sections a task points to."),
  S("plan", "str", "paths", "The build plan (plan mode: its unticked lines are the tasks)."),
  S("blocked", "str", "paths", "The blocked list (plan mode): `- 1.3: needs ...` lines are skipped."),
  S("decisions", "str", "paths", "The folder of numbered decision records."),
  S("numberedDirs", "list", "paths", "More folders of numbered files (migrations): a new file takes a free number."),
  S("mainBranch", "str", "paths", "The main branch."),
  S("commands.install", "str", "commands", "Installs dependencies in a new worktree (start it with `git submodule update --init`).", { default: "" }),
  S("commands.typecheck", "str", "commands", "The typecheck CI and the Stop check run."),
  S("commands.lint", "str", "commands", "The lint command."),
  S("commands.test", "str", "commands", "The full test command."),
  S("commands.build", "str", "commands", "The build command."),
  S("commands.smoke", "str", "commands", "A quick command proving main still works."),
  S("commands.stackUp", "str", "commands", "Brings the dev stack up (Postgres, MinIO ...); `factory resume` runs it at boot. Should return once the stack is started. Empty: no stack at boot."),
  S("commands.stackHealth", "str", "commands", "Passes (exit 0) once the stack is healthy; `factory resume` asks until it does. Empty: stackUp is enough."),
  S("commands.agentSetup", "str", "commands", "Runs once per loop after the env is set, e.g. to create the slot's database.", { default: "" }),
  S("commands.typecheckChanged", "str", "commands", "The Stop check's typecheck, for the changed packages only (saves time and tokens). Empty: use commands.typecheck."),
  S("commands.ci", "str", "commands", "What CI runs (typecheck, lint, test, build), for `factory verify`; `{base}` is origin/<main>. When set on main, a ready PR needs it passed for its commit."),
  S("commands.fix", "str", "commands", "Formats and auto-fixes the files this branch changed, e.g. `prettier --write {files} && eslint --fix {files}` (`{files}` is the quoted list; without it the list is appended). The Stop check and `factory verify` run it first, so agents never spend a turn on style."),
  S("fixPaths", "list", "commands", "Regexes: commands.fix gets only changed files matching one of them. Empty: every changed file."),
  S("commands.testChanged", "str", "commands", "The Stop check's tests, for the changed packages only. Empty: use commands.test."),
  S("codePaths", "list", "commands", "Folders with code: the Stop check runs only when they changed."),
  S("checkRequires", "list", "commands", 'Paths that must exist before the Stop check runs, e.g. ["node_modules"].'),
  S("checkOutputLines", "int", "commands", "How many lines of a failing check the agent is shown (failures first)."),
  S("checkLogDir", "str", "commands", "Where a check's full output is saved; the agent sees a capped summary and this path."),
  S("protected", "list", "tests", "Regexes of files an agent may not merge."),
  S("alwaysAllowed", "list", "tests", "Files that are never protected (the plan, the blocked list)."),
  S("testPaths", "list", "tests", "Regexes the Factory guard treats as tests."),
  S("goldenPaths", "list", "tests", "Regexes the guard treats as expected outputs."),
  S("dependencyManifests", "list", "tests", "Regexes of dependency manifests (a new dependency needs deps-reviewed)."),
  S("maxOpenPRs", "int", "gate", "Ready PRs the account may have open at once. About the number of agents + 1."),
  S("prSizeWarn", "int", "gate", "The guard warns above this many changed lines."),
  S("reviewMarkers", "str", "gate", "Where the re-review history (`<branch>.reviews.json`) is kept. Review passes are not: they are in the git folder (`factory-reviews`, #260)."),
  S("reReviewPercent", "int", "gate", "A reviewer's second round reads only what changed since its last round, unless that is more than this percent of the branch diff (or touches a new file): then it is a full review. 0: always a full review."),
  S("lessons", "str", "gate", "The curated lessons file: one-line rules the builder and the reviewers read first (`factory lessons`)."),
  S("lessonsCap", "int", "gate", "The most lessons the file may hold; `factory lessons check` fails above it and add refuses. Prune what a check enforces now."),
  S("manager.flakes", "list", "gate", "Names of CI jobs known to fail now and then for no reason. `factory prs` says `rerun flake` for a PR whose only red jobs are these, failing for the first time on that commit; a second failure goes back to the agent.", { default: [] }),
  S("artifacts.manifest", "str", "paths", "Where `factory artifacts` records each artifact copy kept in the repo: where it came from, when, by whom, and a hash of each file."),
  S("artifacts.dir", "str", "paths", "The default folder for an artifact's repo copy: <dir>/<artifact id>."),
  S("artifacts.fetch", "str", "paths", "A command that exports the artifact `{url}` into the folder `{out}`, for `factory artifacts pull`. Empty: pull takes an export made by hand (`--from`). Unattended sessions have no artifact tool (#104), so this is your own exporter."),
  S("artifacts.info", "str", "paths", "A command that prints JSON {title, updated, version} for the artifact `{url}`, for `factory artifacts status` and `factory doctor`. Empty: they say they can't tell whether a copy is older."),
  S("roles.dir", "str", "agents", "The project's role folder: <dir>/<role>/README.md (the project's own instructions for the role) and reads.md (what it reads, one per line). Committed in the project. A project without it falls back to `notes`. `factory init-roles` creates it."),
  S("roles.dev-manager.names", "list", "agents", "The dev managers' names: `factory dev-manager [name|N] loop`. Lowercase letters, digits, dashes; none may be a coding agent's name."),
  S("roles.dev-manager.profile", "str", "agents", "The Claude settings file the dev manager's sessions run on (read only when it exists)."),
  S("roles.product-owner.names", "list", "agents", "The product owners' names: `factory product-owner [name|N] loop`."),
  S("roles.product-owner.profile", "str", "agents", "The Claude settings file the product owner's sessions run on (read only when it exists)."),
  S("roles.product-owner.workLabel", "str", "agents", "An open issue or pull request with this label is work for the product owner. Empty: it never has any."),
  S("roles.product-owner.busyMinutes", "int", "agents", "Minutes the product owner's loop waits after a pass that had work."),
  S("roles.product-owner.idleMinutes", "int", "agents", "Minutes it waits when there was none. 0: it exits instead."),
  S("roles.product-owner.escalateMinutes", "int", "agents", "A question addressed `to=po` that nobody answered moves up one level after this many minutes: product owner, then dev manager, then the owner. With no product owner running it starts at the dev manager."),
  S("roles.product-owner.logins", "list", "agents", "GitHub logins whose answers count for the product owner. Empty: " + "any login. An answer from another login is ignored."),
  S("roles.product-owner.artifacts", "bool", "agents", "Let the product owner's interactive (`-i`) sessions use the `Artifact` and `DesignSync` tools to read claude.ai artifacts live. Off: its sessions deny them. The dev manager and the coding agents never get them. Read from main."),
  S("manager.busyMinutes", "int", "agents", "Minutes the dev manager's loop waits after a cycle that had work."),
  S("manager.idleMinutes", "int", "agents", "Minutes it waits when there was none. 0: it exits instead."),
  S("manager.maxSubManagers", "int", "agents", "How many one-item sub-managers the dev-manager orchestrator runs at once. Items beyond the cap wait for the next cycle."),
  S("manager.claimMinutes", "int", "agents", "How long a dev manager's lease on an item lasts: a sub-manager's, or a review or answer claim on a PR or question (it ends sooner when the review marker or the answer is posted). A manager that dies leaves a claim that expires on its own."),
  S("manager.deadManMinutes", "int", "agents", "Work that has waited this long with no dev-manager activity (no marker, answer, merge or working heartbeat) is reported to the owner: the dead-man's switch."),
  S("manager.notify", "str", "agents", "The GitHub login mentioned in an owner-queue comment, so GitHub notifies the owner's phone. Empty: the repository's owner."),
  S("manager.quietMinutes", "int", "agents", "A pull request whose head commit has no review marker is left this long before the watcher counts it (check 1)."),
  S("manager.staleMinutes", "int", "agents", "A must-fix, failing CI or merge conflict with no new commit for this long is the manager's (check 3)."),
  S("manager.ownerWaitMinutes", "int", "agents", "A pull request labelled for the product owner or the owner that has waited this long is reported (check 5)."),
  S("manager.agentIdleMinutes", "int", "agents", "A coding agent idle this long while tasks are ready is reported to the owner (check 6)."),
  S("manager.ciQueuedMinutes", "int", "agents", "A CI run queued this long is reported (check 7)."),
  S("manager.subManagerMinutes", "int", "agents", "A sub-manager session is stopped after this many minutes."),
  S("trustedReviewers", "list", "gate", "GitHub logins whose approvals count. Empty: " + "any.", { default: [] }),
  S("holdLabel", "str", "gate", "The label the dev manager puts on a PR it is reviewing."),
  S("agents", "list", "agents", "The agents' names, in order (lowercase letters, digits, dashes)."),
  S("agentEnv", "dict", "ports", 'Per-loop variables: {"API_PORT": "{port:4100}", "DATABASE_URL": "...{suffix}"}.'),
  S("portStep", "int", "ports", "How far each agent's ports move from the previous agent's."),
  S("claimStaleHours", "int", "agents", "How long a local claim or a pushed task branch holds a task."),
  S("permissionMode", "enum", "agents", "How unattended `claude -p` runs get their permissions: acceptEdits (the default) or default (your own Claude Code settings decide).", { options: ["acceptEdits", "default"] }),
  S("waitMinutes", "int", "agents", "How often an idle loop looks for work. 0: it exits instead.", { default: 1 }),
  S("models", "dict", "agents", 'The model per role (builder, manager, product-owner, test-writer, reviewer, architecture-reviewer, safety-auditor, security-reviewer): {"builder": {"model": "opus", "effort": "high"}, "reviewer": {"model": "sonnet", "escalateTo": "opus"}}. effort (low, medium, high, xhigh, max) is for builder and manager only. A role with no entry keeps today\'s model: the agent file\'s, or Claude Code\'s default.', { default: {} }),
  S("budget.builder", "int", "agents", "The token budget of a task whose issue has no `Budget:` line, counting fresh input (input + cache writes) + output as `factory usage` reports them. Advisory: shown and compared, a warning at 80%, never a stop. Empty: no budget.", { default: null }),
  S("tasks.source", "enum", "issues", "Where tasks come from.", { options: ["plan", "issues"] }),
  S("tasks.staleHours", "int", "issues", "An in-progress issue with no activity this long counts as stale."),
  S("tasks.pingMinutes", "int", "issues", "How often a working agent pings its agent issue, at most."),
  S("tasks.downMinutes", "int", "issues", "No ping for this long: the agent counts as down."),
  S("tasks.heartbeatSeconds", "int", "issues", "How often the heartbeat daemon (`factory heartbeat`) looks at this machine's agents. It writes to GitHub only on a change, and every pingMinutes as a keepalive."),
  S("tasks.heartbeatMissMinutes", "int", "issues", "An agent the daemon writes for counts as silent after this many minutes without a keepalive (instead of downMinutes)."),
  S("tasks.releaseDownMinutes", "int", "issues", "An agent that is plainly down (its loop or the daemon said so) gets its in-progress issues back to ready by the sweep after this long."),
  S("tasks.showWhere", "bool", "issues", "Post the machine, folder, tmux session and Remote Control link on agent issues (anyone who can read the repo sees them).", { default: false }),
  // #251, #258: the factory adds main's rules to the agents' settings each time it starts one.
  S("permissions.allow", "list", "agents", 'Extra Claude Code allow rules for this project\'s agents, like "Edit(src/**)". A rule applies on an agent\'s next run once the pull request from `factory settings pr` is merged: the factory adds them to the agents\' settings, after the release\'s own.'),
  S("reviews.safety-auditor.paths", "list", "gate", "Regexes of paths that need the safety auditor."),
  S("reviews.security-reviewer.paths", "list", "gate", "Regexes of paths that need the security reviewer."),
  S("eval.command", "str", "design", "The eval command (e.g. `pnpm golden`). Empty: no eval yet.", { default: "" }),
  S("eval.baseline", "str", "design", "The eval's baseline file.", { default: "" }),
  S("design.references", "str", "design", "The folder of design references. Empty: no design check.", { default: "" }),
  S("notes", "str", "paths", "The folder of project notes for the shared agents and skills."),
  S("usageLog", "str", "paths", "Where `factory usage --record` appends its rows (commit it to keep the history).", { default: "docs/factory-usage.md" }),
  S("release.repo", "str", "paths", "The GitHub repository whose releases `factory update` installs (owner/name). Default: the factory's own, deresegetachew/my-skills."),
  S("styles", "list", "commands", 'Style guides per path: [{"paths": [...], "skills": [...], "check": "..."}].'),
  S("ci.name", "str", "ci", "The self-hosted runner's name (default `<repo>-ci`).", { default: "" }),
  S("ci.label", "str", "ci", "The runner label CI jobs ask for (default `<repo>-local`).", { default: "" }),
  S("ci.runners", "int", "ci", "Heavy runner loops per machine (each with its own Docker); a machine's own count (`factory ci runners <n>`) and FACTORY_CI_RUNNERS win over it.", { default: 1 }),
  S("ci.light", "bool", "ci", "Also run one small runner without Docker for light jobs (the Factory guard), label `<repo>-light`.", { default: true }),
  S("ci.image", "str", "ci", "The heavy runners' image: build (with the project's Node, pnpm and Playwright, faster jobs) or base.", { options: ["build", "base"], default: "build" }),
  S("ci.caches", "bool", "ci", "Keep a pull-through Docker Hub mirror between jobs (heavy runners; read-only to jobs, no workspace or secrets).", { default: true }),
  S("turbo.api", "str", "ci", "The shared Turborepo cache's address, as agents and CI reach it: http://<Tailscale or LAN address>:3335. Empty: no shared cache. `factory turbo install` starts it.", { default: "" }),
  S("turbo.team", "str", "ci", "The cache's team name (default: the repository's name).", { default: "" }),
  S("turbo.bind", "str", "ci", "The address the cache server listens on, on the machine that runs it. 127.0.0.1 reaches only that machine; use its Tailscale or LAN address for others.", { default: "127.0.0.1" }),
  S("turbo.port", "int", "ci", "The port the cache server listens on.", { default: 3335 }),
  S("turbo.secretsCommand", "str", "ci", "A command that prints TURBO_TOKEN=... (and TURBO_REMOTE_CACHE_SIGNATURE_KEY=...) lines, for example `sops -d --output-type dotenv secrets/factory.yaml`. The token is never stored in factory.json; TURBO_TOKEN in the environment wins.", { default: "" }),
  S("ci.lightLabel", "str", "ci", "The light runner's label (default `<repo>-light`).", { default: "" }),
  S("tasks.labels", "dict", "issues", "The GitHub labels that mark a task: ready, inProgress, inReview, blocked and the agentPrefix."),
  S("structure.roots", "list", "commands", "Folders the structure check (the hexagonal skill's check_structure script) looks at, when a style uses it.", { default: [] }),
  S("structure.legacy", "str", "commands", "The list of legacy files the structure check leaves alone (it only shrinks).", { default: "" }),
  S("eval.skill", "str", "design", "The skill that runs the eval.", { default: "eval" }),
  S("eval.metrics", "list", "design", "The metrics the eval reports.", { default: [] }),
  S("eval.mustNotDrop", "list", "design", 'Metrics that must not drop against the baseline, e.g. ["warning recall 100%"].', { default: [] }),
  S("eval.paths", "list", "design", "Regexes of changed paths that need the eval.", { default: [], regex: true }),
  S("design.skill", "str", "design", "The skill that runs the design check.", { default: "design-check" }),
  S("design.renders", "str", "design", "The folder of reference renders (images) the design check compares with.", { default: "" }),
  S("design.preview", "str", "design", "The command that serves a preview of the built screens.", { default: "" }),
  S("design.paths", "list", "design", "Regexes of changed paths that need the design check.", { default: [], regex: true }),
]);

// Machine scope: this machine's own file (factory_machine.ts), never the project's.
export const MACHINE: Record<string, Setting> = table([
  S("agents", "list", "machine", "The agent names this machine runs. Two machines must never share a name.", { scope: "machine", default: [] }),
  S("remoteControl", "bool", "machine", "Start loop and agent sessions with Remote Control, so you can reach them from claude.ai/code or your phone.", { scope: "machine", default: true }),
  S("autostart", "bool", "machine", "Bring the stack and this machine's agents back after a reboot (`factory autostart`).", { scope: "machine", default: false }),
  S("autostartAgents", "list", "machine", "The agents it starts at boot. Empty: the names this machine runs.", { scope: "machine", default: [] }),
  S("autostartReport", "bool", "machine", "Post the boot report on the first started agent's issue (issues mode).", { scope: "machine", default: true }),
  S("ci.runners", "int", "machine", "Heavy CI runners for this project on this machine (`factory ci runners <n>`); wins over the project's `ci.runners`. Empty: the project's.", { scope: "machine", default: null, minimum: 1, maximum: 16 }),
]);

function setting(key: string, local = false): Setting {
  return (local ? MACHINE : SETTINGS)[key] as Setting;
}

for (const key of ["protected", "testPaths", "goldenPaths", "dependencyManifests", "reviews.safety-auditor.paths",
  "reviews.security-reviewer.paths"]) setting(key).regex = true;
for (const key of ["alwaysAllowed"]) setting(key).regex = false;
setting("styles").items = "json";
setting("waitMinutes").minimum = 0;
setting("reReviewPercent").minimum = 0;
setting("reReviewPercent").maximum = 100;
for (const key of ["maxOpenPRs", "portStep", "claimStaleHours", "prSizeWarn", "checkOutputLines", "tasks.staleHours",
  "tasks.pingMinutes", "tasks.downMinutes", "ci.runners"]) setting(key).minimum = 1;

// Long help, examples and who reads a setting, for the ones that need more than the short line.
const MORE: Record<string, More> = {
  prd: { long: "The product requirements document. Agents read the sections a task points to, and the dev manager " +
    "checks scope against it. Changing it is the owner's call, so it is usually in `protected`.",
  examples: ["factory settings set prd docs/PRD.md"] },
  plan: { long: "Plan mode (`tasks.source` is `plan`): every unticked `- [ ] **1.3 Title**` line is a task, taken in " +
    "order. In issues mode the plan is only an overview.",
  examples: ["factory settings set plan docs/build-plan.md"] },
  blocked: { long: "Plan mode: a `- 1.3: needs the owner's API key` line takes task 1.3 out of the queue until the " +
    "line is removed.", examples: ["factory settings set blocked docs/blocked.md"] },
  decisions: { long: "The folder of numbered decision records (`0001-title.md`). A new file must take a number that " +
    "neither main nor another open PR has; the gate names the next free one.",
  examples: ["factory settings set decisions docs/decisions"] },
  numberedDirs: { long: "More folders of numbered files besides `decisions`, for example database migrations. The PR " +
    "gate gives each new file a number no other open PR uses.",
  examples: ["factory settings set numberedDirs '[\"db/migrations\"]'"] },
  mainBranch: { long: "The branch PRs merge into. The PR gate does not trust this file for it: it asks GitHub for " +
    "the default branch.", examples: ["factory settings set mainBranch main"] },
  notes: { long: "A folder of `<agent or skill name>.md` files with this project's additions to the shared agents " +
    "and skills. Each agent reads its own file first, if present.",
  read_by: "the shared agents and skills", examples: ["factory settings set notes .claude/factory/notes"] },
  usageLog: { long: "`factory usage --record LABEL` appends a row of token numbers per task here. Commit the file " +
    "to keep the history.", read_by: "factory_usage.ts" },
  "commands.typecheck": { long: "Run by CI and by the Stop check after the agent's turn. Empty: skipped.",
    examples: ["factory settings set commands.typecheck 'pnpm -s typecheck'"] },
  "commands.test": { long: "The full test command, run by CI and by the Stop check when files under `codePaths` " +
    "changed. Use `commands.testChanged` to run only the changed packages in the Stop check.",
  examples: ["factory settings set commands.test 'pnpm -s test'"] },
  "commands.ci": { long: "Everything CI runs, as one command, for `factory verify`. When it is set on main, a ready " +
    "PR needs `factory verify` to have passed for its commit, so errors are caught locally. " +
    "`{base}` stands for origin/<main>.",
  examples: ["factory settings set commands.ci 'pnpm -s turbo run typecheck lint test build --filter=...[{base}]'"] },
  "commands.stackUp": { long: "`factory resume` runs it at boot to bring the dev stack back (Postgres, MinIO ...). It " +
    "should return once the stack is started, not stay in the foreground.",
  examples: ["factory settings set commands.stackUp 'pnpm stack:up'"] },
  codePaths: { long: "The Stop check (typecheck and tests) runs only when a file under one of these folders " +
    "changed, so a docs-only turn costs nothing.",
  examples: ["factory settings set codePaths '[\"apps\", \"packages\"]'"] },
  styles: { long: "Style guides per path. Each entry has `paths` (globs), `skills` (the style-guide skills to apply) " +
    "and an optional `check` command that CI runs. The architecture reviewer reviews diffs on " +
    "those paths and the PR gate needs its pass.",
  examples: ['factory settings set styles \'[{"paths": ["apps/api/**"], "skills": ["nestjs-best-practices"], "check": "pnpm -s check:structure"}]\''] },
  protected: { long: "Regexes on file paths. A PR that changes a protected file is never merged by an agent: the " +
    "owner merges it. Keep `^\\.claude/` here: it protects the factory's " +
    "own settings. Loosening this list is the most sensitive change in the file.",
  examples: ['factory settings set protected \'["^CLAUDE\\\\.md$", "^\\\\.claude/", "^\\\\.github/"]\''] },
  alwaysAllowed: { long: "Files that are never counted as protected even if a `protected` regex matches, typically " +
    "the plan and the blocked list that agents tick off.",
  examples: ['factory settings set alwaysAllowed \'["docs/build-plan.md"]\''] },
  testPaths: { long: "Regexes for test files. The Factory guard in CI fails a PR that weakens tests (deleted " +
    "assertions, `.skip`, `.only`) unless the dev manager labelled it `tests-reviewed`. " +
    "Changing this list after implementation is itself a change to what the guard sees.",
  examples: ['factory settings set testPaths \'["(^|/)tests?/", "\\\\.test\\\\.[jt]sx?$"]\''] },
  goldenPaths: { long: "Regexes for expected outputs (snapshots, fixtures, golden sets). The guard fails a PR that " +
    "changes them without the `tests-reviewed` label.",
  examples: ['factory settings set goldenPaths \'["(^|/)golden[^/]*/"]\''] },
  dependencyManifests: { long: "Regexes for dependency manifests. A PR that adds a dependency to one needs the " +
    "dev manager's `deps-reviewed` label.",
  examples: ['factory settings set dependencyManifests \'["(^|/)package\\\\.json$"]\''] },
  maxOpenPRs: { long: "The PR gate refuses to open another ready PR while this many are open for the account. " +
    "Set it to about the number of agents plus one, so the dev manager can keep up.",
  examples: ["factory settings set maxOpenPRs 4"] },
  prSizeWarn: { long: "The guard warns (it does not fail) when a PR changes more lines than this. Small PRs are " +
    "reviewed faster.", examples: ["factory settings set prSizeWarn 600"] },
  reviewMarkers: { long: "The reviewers' round history (`<branch>.reviews.json`, for incremental re-review) lives in " +
    "this folder (git-ignored). Review passes used to live here too; they are now in the git folder " +
    "(`<git common dir>/factory-reviews/`), which agents can't write, and a pass left here no longer counts (#260).",
  examples: ["factory settings set reviewMarkers tmp/reviews"] },
  reReviewPercent: { long: "A reviewer's second round reads only what changed since its own last round, unless that " +
    "delta is more than this percent of the branch diff or touches a new file: then it is " +
    "a full review. 0: always a full review.",
  examples: ["factory settings set reReviewPercent 30"] },
  trustedReviewers: { long: "Only approvals from these GitHub logins count at the merge gate. Empty: " + "any approval " +
    "counts. Use it when the repository has other collaborators.",
  examples: ['factory settings set trustedReviewers \'["your-login"]\''] },
  holdLabel: { long: "While the dev manager reviews a PR it puts this label on it. Agents skip held PRs (no " +
    "rework) and can't merge them.", examples: ["factory settings set holdLabel factory-hold"] },
  "permissions.allow": { long: "The agents' rules are in .claude/factory/settings.json, which the release owns, so a rule added there by " +
    "hand is drift and the next `factory update` replaces it. List the project's extra allow rules here instead. Each time " +
    "the factory starts an agent it adds these rules, as main has them, after the release's own (#258), so a rule applies " +
    "once the pull request from `factory settings pr` is merged, on the agent's next run; nothing else to run. They " +
    "apply to the agents only: your own Claude sessions in the project use your own settings. " +
    "Use `Edit(path/**)` for files (Claude Code never matches `Write(path)` rules) and `Bash(command *)` for commands. " +
    "Deny rules still win. Review each rule: an unattended loop can run what it allows.",
  examples: ['factory settings set permissions.allow \'["Edit(src/**)", "Bash(make test*)"]\''] },
  "reviews.safety-auditor.paths": { long: "A diff touching these paths needs the safety auditor's pass before the PR " +
    "gate opens. Use it for the rules your CLAUDE.md says must never break.",
  examples: ['factory settings set reviews.safety-auditor.paths \'["^packages/warnings/"]\''] },
  "reviews.security-reviewer.paths": { long: "A diff touching these paths needs the security reviewer's pass: auth, " +
    "payments, public endpoints, uploads, storage, tenancy, secrets.",
  examples: ['factory settings set reviews.security-reviewer.paths \'["^apps/api/src/auth/"]\''] },
  agents: { long: "The agents' names, in order. The first works in the project folder, the others in " +
    "`<project>-agents/<name>`. Names become folder names and `agent:<name>` labels, so use " +
    "lowercase letters, digits and dashes. Each name is a slot, which decides its ports.",
  examples: ['factory settings set agents \'["ada", "grace", "haile"]\''] },
  claimStaleHours: { long: "A loop's claim on a task (and a pushed task branch) lapses after this many hours, or " +
    "when its process exits, so a crashed agent doesn't hold work for ever.",
  examples: ["factory settings set claimStaleHours 6"] },
  "roles.product-owner.artifacts": { long: "Interactive Claude Code sessions have the built-in `Artifact` tool (list " +
    "artifacts, read a page or a published file) and `DesignSync`; unattended `claude -p` passes have no artifact tool at " +
    "all, so they read the repo copies (`factory artifacts pull`, `factory artifacts status`). Off (the default): every " +
    "role session denies both tools, which also keeps their definitions out of every turn. On: the product owner's sessions " +
    "do not deny them, so `factory product-owner loop -i` may read artifacts; publishing to one still needs the owner's yes. " +
    "The value is read from `.claude/factory.json` on the main branch, so a role can't turn it on for itself. The dev " +
    "manager and the coding agents are always denied them. Standalone Claude Design closes on 2026-12-14 (designs are " +
    "Artifact types now), so nothing is built on `DesignSync`.",
  examples: ["factory settings set roles.product-owner.artifacts true"] },
  permissionMode: { long: "Nobody can answer a permission prompt in an unattended run, so every headless `claude -p` the loops and the dev " +
    "manager start gets `--permission-mode acceptEdits`: edits inside the project need no answer, and the allow list in " +
    ".claude/factory/settings.json (plus `permissions.allow` here) covers the commands. Anything not allowed or denied stops the run, " +
    "so the allow list is the real limit. `default` passes no flag and leaves it to your own Claude Code settings; " +
    "`factory doctor` says `fix` unless they set a mode. Interactive sessions (`-i`) are not given a mode, since a person answers.",
  examples: ["factory settings set permissionMode default"] },
  waitMinutes: { long: "An idle loop looks for work this often (a token-free wait). 0: it exits instead of waiting.",
    examples: ["factory settings set waitMinutes 1"] },
  models: { long: "The model per role: builder, manager, test-writer, reviewer, architecture-reviewer, " +
    "safety-auditor, security-reviewer. `effort` (low, medium, high, xhigh, max) is for builder and " +
    "manager only; the reviewer may `escalateTo` a stronger model. A role with no entry keeps " +
    "today's model.",
  examples: ['factory settings set models \'{"builder": {"model": "opus", "effort": "high"}, "reviewer": {"model": "sonnet", "escalateTo": "opus"}}\''] },
  "budget.builder": { long: "A task's token budget is the `Budget: 300k` line of its issue (300k, 1.2m or 300000), as it " +
    "was when the task was claimed; a task without one gets this number. A budget counts one task's sessions and " +
    "subagents on this machine: fresh input (input + cache writes) + output. Cache reads are not counted, and there is " +
    "no money: prices differ per model. It is advice: the loop's prompt states it, `factory usage --task <n> --budget` " +
    "compares it and warns at 80%, the PR's usage comment shows used against budget, and the dev manager decides about an " +
    "overrun. Nothing stops at the limit, and CI never fails on it. The first budgets are guesses: record real numbers " +
    "with `factory usage --record` and read `factory report` before tightening them.",
  read_by: "`factory usage` (factory_budget.ts) and factory-loop.sh (the task's prompt)",
  examples: ["factory settings set budget.builder 300000"] },
  "tasks.source": { long: "`plan`: the unticked lines of the build plan are the tasks. `issues`: open GitHub issues " +
    "labelled ready are the tasks, claimed with labels and a claim comment.",
  examples: ["factory settings set tasks.source issues"] },
  "tasks.labels": { long: "Rename the labels the factory puts on issues. Keys: ready, inProgress, inReview, blocked, " +
    "agentPrefix. Keys you leave out keep their defaults.",
  examples: ['factory settings set tasks.labels \'{"ready": "ready-for-agent"}\''] },
  "tasks.staleHours": { long: "An in-progress issue with no activity for this long goes back to ready (the dev manager " +
    "does it).", examples: ["factory settings set tasks.staleHours 3"] },
  agentEnv: { long: "Variables that differ per parallel loop, so loops don't share ports, databases or queues. " +
    "Placeholders: `{slot}` (1, 2, ...), `{suffix}` (empty in slot 1, `_N` after) and " +
    "`{port:N}` (N in slot 1, N + portStep * (slot - 1) after). `validate` checks that no two " +
    "ports collide across slots.",
  examples: ['factory settings set agentEnv \'{"API_PORT": "{port:4100}", "DATABASE_URL": "postgres://app:app@localhost:5432/app{suffix}"}\''] },
  portStep: { long: "How far each agent's ports move from the previous agent's. Make it larger than the number of " +
    "ports a loop uses.", examples: ["factory settings set portStep 10"] },
  "ci.runners": { long: "Heavy runner loops per machine, each with its own Docker: the project's default. A machine's " +
    "own count (`factory ci runners <n>`, saved outside the repo) wins over it, and `FACTORY_CI_RUNNERS` wins over both " +
    "for one shell. Run `factory ci install` again after changing it.",
  examples: ["factory settings set ci.runners 3"] },
  "ci.runners@machine": { long: "How many heavy CI runners this machine runs for this project (#282). `factory ci runners " +
    "<n>` saves it and reinstalls the runners; `factory ci install` and `factory update` keep it. `FACTORY_CI_RUNNERS` " +
    "wins over it for one shell. Unset: the project's `ci.runners`, else 1.",
  examples: ["factory ci runners 4", "factory settings --local set ci.runners 4"],
  read_by: "`factory ci` (ci_names.ts), `factory update` and `factory doctor --sandbox`",
  needs: "nothing: it is this machine's file, not committed. Run `factory ci install` after `settings --local set` (`factory ci runners <n>` does it)" },
  "eval.command": { long: "What the eval skill runs, e.g. `pnpm golden`. Empty: no eval yet.",
    examples: ["factory settings set eval.command 'pnpm golden'"] },
  "design.references": { long: "The folder of design reference screens the design-check skill compares a built " +
    "screen with. Empty: no design check.",
  examples: ["factory settings set design.references design/screens"] },
  "agents@machine": { long: "The names this machine runs for the project, each one an agent in the project's `agents`. " +
    "`FACTORY_AGENTS` (comma-separated) overrides it. Empty: every name in the project's " +
    "`agents`. In issues mode a name another machine has live is refused.",
  examples: ["factory settings --local set agents haile,tewodros"],
  needs: "nothing: it is this machine's file, not committed" },
  "remoteControl@machine": { long: "Whether `factory loop -i` and `factory agent` start Claude with Remote Control, so " +
    "you can reach the session from claude.ai/code or your phone. " +
    "`FACTORY_REMOTE_CONTROL=0` or `1` overrides it for one run.",
  examples: ["factory settings --local set remoteControl off"],
  needs: "nothing: it is this machine's file, not committed" },
};
for (const [key, more] of Object.entries(MORE)) {
  const s = setting(key.split("@")[0] as string, key.endsWith("@machine"));
  if (more.long !== undefined) s.long = more.long;
  if (more.examples !== undefined) s.examples = more.examples;
  if (more.read_by !== undefined) s.readBy = more.read_by;
  if (more.needs !== undefined) s.needs = more.needs;
}
for (const s of [...Object.values(SETTINGS), ...Object.values(MACHINE)]) {
  if (s.scope === "machine" && !s.needs) s.needs = "nothing: it is this machine's file, not committed";
}

/** The project's settings, or this machine's with `local`. */
export function tableOf(local = false): Record<string, Setting> {
  return local ? MACHINE : SETTINGS;
}

export function freeFormKeys(): Set<string> {
  return new Set(Object.entries(SETTINGS).filter(([, s]) => s.kind === "dict").map(([k]) => k));
}

/** True when `path` is a setting that holds an object whose keys are the person's own (agentEnv, models ...). */
export function isFreeForm(path: string): boolean {
  return freeFormKeys().has(path);
}

/** True when `path` is a setting, a group of settings (`tasks`), or inside a free-form setting. */
export function isKnownPath(path: string): boolean {
  const parts = path.split(".");
  for (let i = 1; i <= parts.length; i++) {
    const head = parts.slice(0, i).join(".");
    const s = SETTINGS[head];
    if (s && (s.kind === "dict" || i === parts.length)) return true;
  }
  return Object.keys(SETTINGS).some((k) => k.startsWith(path + "."));
}

/** The slug for a section given as its slug, its title or the start of either (case-insensitive); else null. */
export function sectionOf(name: string | null | undefined): string | null {
  const n = (name ?? "").trim().toLowerCase();
  for (const [slug, title] of SECTIONS) if (n === slug || n === title.toLowerCase()) return slug;
  const matches = SECTIONS.filter(([slug, title]) => n && (slug.startsWith(n) || title.toLowerCase().startsWith(n)));
  return matches.length === 1 ? (matches[0] as [string, string, string])[0] : null;
}

/** A value as JSON text, the way the Python version showed it (json.dumps, non-ASCII kept). */
export function asText(value: unknown): string {
  return pyDumps(value, { ensureAscii: false });
}

/** Python's repr() of a JSON value, for messages that quoted a value with !r. */
export function pyReprValue(v: unknown): string {
  if (typeof v === "string") return pyRepr(v);
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map(pyReprValue).join(", ") + "]";
  return "{" + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyRepr(k)}: ${pyReprValue(x)}`).join(", ") + "}";
}

/** Python's == on JSON values: dicts compare without regard to key order, and True == 1. */
export function pyEqual(a: unknown, b: unknown): boolean {
  if ((typeof a === "number" || typeof a === "boolean") && (typeof b === "number" || typeof b === "boolean")) {
    return Number(a) === Number(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => pyEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && pyEqual(a[k], b[k]));
  }
  return a === b;
}

// --- checking values ------------------------------------------------------------------------------------------

function agentNames(names: unknown[], known: string[] | null = null): void {
  const seen = new Set<unknown>();
  for (const name of names) {
    try {
      safeAgent(typeof name === "string" ? name : "");
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      throw new SettingError(`${pyReprValue(name)} isn't a valid agent name: use lowercase letters, digits and dashes.`);
    }
    if (seen.has(name)) throw new SettingError(`${String(name)} is listed twice: each agent name must be used once.`);
    seen.add(name);
    if (known !== null && !known.includes(name as string)) {
      throw new SettingError(`${String(name)} isn't an agent in \`agents\` of the project (${known.join(", ")}).`);
    }
  }
}

function checkAgentEnv(value: Record<string, unknown>): void {
  for (const [name, template] of Object.entries(value)) {
    if (name.startsWith("_")) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new SettingError(`${pyRepr(name)} isn't a valid variable name: letters, digits and _ only.`);
    }
    if (typeof template !== "string") {
      throw new SettingError(`${name} takes text such as "{port:4100}"; got ${pyReprValue(template)}.`);
    }
    try {
      render(template, 1, 10);
    } catch (e) {
      if (e instanceof Exit) throw new SettingError(e.text ?? String(e.exitCode));
      throw e;
    }
  }
}

function checkStyles(value: unknown[]): void {
  value.forEach((entry, n) => {
    const i = n + 1;
    if (!isObject(entry)) throw new SettingError(`item ${i} takes an object: {"paths": [...], "skills": [...]}.`);
    for (const [field, kind] of [["paths", "list"], ["skills", "list"], ["check", "string"]] as const) {
      if (field in entry && (kind === "list" ? !Array.isArray(entry[field]) : typeof entry[field] !== "string")) {
        throw new SettingError(`item ${i}: \`${field}\` takes a ${kind}.`);
      }
    }
  });
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** The value, or SettingError when `value` doesn't fit the setting `s`. */
export function checkValue(s: Setting, value: unknown, projectAgents: string[] | null = null): unknown {
  const kind = s.kind;
  if (kind === "str") {
    if (typeof value !== "string") throw new SettingError(`takes text; got ${asText(value)}.`);
  } else if (kind === "enum") {
    if (!(s.options ?? []).includes(value as string)) {
      throw new SettingError(`takes one of ${(s.options ?? []).join(", ")}; got ${asText(value)}.`);
    }
  } else if (kind === "bool") {
    if (typeof value !== "boolean") throw new SettingError(`takes true or false; got ${asText(value)}.`);
  } else if (kind === "int") {
    if (!isInt(value)) throw new SettingError(`takes a whole number; got ${asText(value)}.`);
    if (value < s.minimum) {
      throw new SettingError(`must be at least ${s.minimum} (got ${value})` +
        (s.minimum ? ". 0 would mean off, which this setting doesn't have." : "."));
    }
    if (s.maximum !== null && value > s.maximum) throw new SettingError(`must be at most ${s.maximum} (got ${value}).`);
  } else if (kind === "list") {
    if (!Array.isArray(value)) throw new SettingError(`takes a JSON list, e.g. '["a", "b"]'; got ${asText(value)}.`);
    if (s.items === "str") {
      for (const item of value) if (typeof item !== "string") throw new SettingError(`every item takes text; got ${asText(item)}.`);
    }
    if (s.regex) {
      for (const item of value) {
        try {
          new RegExp(item as string);
        } catch (e) {
          throw new SettingError(`${pyReprValue(item)} isn't a valid regex (${e instanceof Error ? e.message : String(e)}).`);
        }
      }
    }
    if (s.key === "styles") checkStyles(value);
    if (s.key === "agents") agentNames(value, s.scope === "machine" ? projectAgents : null);
    if (s.key === "autostartAgents") agentNames(value, projectAgents);
  } else {
    if (!isObject(value)) throw new SettingError(`takes a JSON object, e.g. '{"KEY": "value"}'; got ${asText(value)}.`);
    if (s.key === "models") {
      try {
        validateModels(value);
      } catch (e) {
        if (e instanceof ModelsError) throw new SettingError(e.message);
        throw e;
      }
    }
    if (s.key === "agentEnv") checkAgentEnv(value);
    if (s.key === "tasks.labels") {
      const allowed = Object.keys(DEFAULTS.tasks.labels);
      for (const [k, v] of Object.entries(value)) {
        if (!allowed.includes(k)) throw new SettingError(`${pyRepr(k)} isn't a label name. Names: ${[...allowed].sort().join(", ")}.`);
        if (typeof v !== "string" || !v) throw new SettingError(`${k} takes a label as text.`);
      }
    }
  }
  return value;
}

/** The value for `raw` (what a person typed) as the setting's type; throws SettingError. */
export function parse(s: Setting, raw: string, projectAgents: string[] | null = null): unknown {
  const kind = s.kind;
  let value: unknown;
  if (kind === "str" || kind === "enum") value = raw;
  else if (kind === "int") {
    if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(raw)) throw new SettingError(`takes a whole number; got ${pyRepr(raw)}.`);
    value = Number(raw.replace(/_/g, ""));
  } else if (kind === "bool") {
    const low = raw.toLowerCase();
    if (["true", "yes", "on", "1"].includes(low)) value = true;
    else if (["false", "no", "off", "0"].includes(low)) value = false;
    else throw new SettingError(`takes true or false; got ${pyRepr(raw)}.`);
  } else {
    try {
      value = JSON.parse(raw);
    } catch {
      const t = raw.trim();
      if (kind === "list" && s.scope === "machine" && s.items === "str" && t && !t.startsWith("[") && !t.startsWith("{")) {
        value = raw.split(",").map((n) => n.trim()).filter((n) => n); // `agents haile,tewodros`
      } else {
        const example = kind === "list" ? '["a","b"]' : '{"KEY": "value"}';
        throw new SettingError(`takes a JSON ${kind}, e.g. '${example}'; got ${pyRepr(raw)}.`);
      }
    }
  }
  return checkValue(s, value, projectAgents);
}

/** What a person may type for this setting, in a few words. */
export function hint(s: Setting): string {
  if (s.kind === "int") return `a whole number, at least ${s.minimum}` + (s.maximum !== null ? `, at most ${s.maximum}` : "");
  if (s.kind === "enum") return "one of " + (s.options ?? []).join(", ");
  if (s.kind === "bool") return "true or false";
  if (s.kind === "list") return "a JSON list";
  if (s.kind === "dict") return "a JSON object";
  return "text";
}

// --- looking things up and validating a whole file ----------------------------------------------------------------

export function lookup(data: unknown, key: string): unknown {
  let node = data;
  for (const part of key.split(".")) {
    if (!isObject(node) || !(part in node)) return MISSING;
    node = node[part];
  }
  return node;
}

export function effective(data: unknown, key: string): unknown {
  const here = lookup(data, key);
  return here !== MISSING ? here : (SETTINGS[key] as Setting).default;
}

/** Dotted paths in the project file that are not settings (probably typos); `_about`-style keys are skipped. */
export function unknownKeys(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("_")) continue;
      const path = prefix + k;
      if (!isKnownPath(path)) out.push(path);
      else if (isObject(v) && !(path in SETTINGS)) walk(v, path + ".");
    }
  };
  walk(data, "");
  return out;
}

/** [errors, warnings] for a project file's data. Every message starts with the key it is about. */
export function validateAll(data: Record<string, unknown>, root = "."): [string[], string[]] {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [key, s] of Object.entries(SETTINGS)) {
    const here = lookup(data, key);
    if (here === MISSING) continue;
    try {
      checkValue(s, here);
    } catch (e) {
      if (!(e instanceof SettingError)) throw e;
      errors.push(`${key}: ${e.message}`);
    }
  }
  for (const key of unknownKeys(data)) {
    warnings.push(`${key}: not a factory setting (a typo?). It is kept and ignored. \`factory settings\` lists the settings.`);
  }
  const source = effective(data, "tasks.source");
  for (const key of ["prd", "decisions", "plan"]) {
    const here = lookup(data, key);
    if (typeof here === "string" && here && !(key === "plan" && source === "issues")) {
      if (!existsSync(join(root, here))) errors.push(`${key}: ${here} doesn't exist. Fix the path, or \`factory settings unset ${key}\`.`);
    }
  }
  errors.push(...portCollisions(data));
  return [errors, warnings];
}

function portCollisions(data: Record<string, unknown>): string[] {
  const env = lookup(data, "agentEnv");
  if (!isObject(env)) return [];
  const agents = lookup(data, "agents");
  const slots = Array.isArray(agents) && agents.length ? agents.length : DEFAULTS.agents.length;
  const step = effective(data, "portStep");
  if (!isInt(step)) return [];
  const seen = new Map<string, [string, number]>();
  const errors: string[] = [];
  for (const [name, template] of Object.entries(env)) {
    if (name.startsWith("_") || typeof template !== "string" || !template.includes("{port:")) continue;
    for (let slot = 1; slot <= slots; slot++) {
      let rendered: string;
      try {
        rendered = render(template, slot, step);
      } catch (e) {
        if (e instanceof Exit) continue;
        throw e;
      }
      for (const port of rendered.match(/(?<!\d)\d{2,5}(?!\d)/g) ?? []) {
        const first = seen.get(port);
        if (first && first[0] !== name) {
          errors.push(`agentEnv: port ${port} is used by ${first[0]} (slot ${first[1]}) and by ` +
            `${name} (slot ${slot}). Raise portStep or move one base port.`);
        }
        if (!first) seen.set(port, [name, slot]);
      }
    }
  }
  return errors;
}

// --- generated documentation --------------------------------------------------------------------------------------

export const README_BEGIN = "<!-- settings:begin -->";
export const README_END = "<!-- settings:end -->";

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The settings tables for the wiki's settings page, one per section, generated from this metadata. */
export function markdown(): string {
  const out = ["(Generated by `factory settings docs --write` from the settings table in `hooks/factory_settings_schema.ts`:",
    "change the table there, not here. `factory settings help <key>` has the long help for each setting.)", ""];
  for (const [slug, title] of SECTIONS) {
    const rows = [...Object.values(SETTINGS), ...Object.values(MACHINE)].filter((s) => s.section === slug);
    out.push(`**${title}**` + (slug === "machine" ? " (`factory settings --local`, not in the project file)" : ""),
      "", "| Key | Type | Default | What it sets |", "|---|---|---|---|");
    for (const s of rows) {
      const kind = s.kind !== "enum" ? s.kind : "one of " + (s.options ?? []).join("/");
      let dflt = asText(s.default);
      if ([...dflt].length > 60) dflt = "see `factory settings help " + s.key + "`";
      out.push(`| \`${cell(s.key)}\` | ${kind} | \`${cell(dflt)}\` | ${cell(s.short)} |`);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "");
}
