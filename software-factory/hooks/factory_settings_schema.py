#!/usr/bin/env python3
"""The one table that describes every factory setting (#49): key, type, default, section, short and long help,
examples, who reads it, who must approve a change, and how a value is checked.

`factory settings` (list, help, validate, set, the interactive menu) and the settings table in the README are all
generated from it, so they can't drift apart. Defaults are not repeated here: they come from `DEFAULTS` in
factory_config.py, except for settings that have none there (the explicit `default=` below).

A setting is in the project scope (a key of .claude/factory.json, committed through a pull request) or in the machine
scope (this machine's own file outside the repo, see factory_machine.py; `factory settings --local`).
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import DEFAULTS  # noqa: E402

# slug, title, who reads the settings in it (the default for "Read by" in the long help)
SECTIONS = [
    ("paths", "Paths & docs", "next_task.py (the task source), the PR gate, factory_numbers.py and the agents"),
    ("commands", "Commands", "the Stop check (check.py), `factory verify`, factory-loop.sh and `factory resume`"),
    ("tests", "Tests & protected paths", "the PR gate (pr-gate.py) and the CI Factory guard (factory_guard.py)"),
    ("gate", "PR gate & reviews", "the PR gate (pr-gate.py), the CI guard, factory_reviews.py and factory_rereview.py"),
    ("agents", "Agents & loops", "factory-loop.sh, factory_claims.py and factory_models.py"),
    ("issues", "Issues mode", "factory_issues.py, factory_agents.py and next_task.py"),
    ("ports", "Ports & per-agent env", "factory_env.py (the environment of each loop)"),
    ("ci", "CI", "`factory ci` (ci.sh) and `factory status`"),
    ("design", "Design & eval", "the eval and design-check skills and factory_reviews.py"),
    ("machine", "Machine (local)", "factory_machine.py, `factory autostart`, `factory resume` and `factory loop`"),
]
SECTION_TITLE = {slug: title for slug, title, _ in SECTIONS}
SECTION_READERS = {slug: readers for slug, _, readers in SECTIONS}

KINDS = ("str", "int", "bool", "list", "dict", "enum")
DEFAULT_REVIEW = ("Any change to .claude/factory.json is under `.claude/`, which is protected: it goes through a pull "
                  "request that the dev manager (or the owner) merges.")

# Settings whose change needs more than that: the review label or decision they trigger.
NEEDS = {
    "testPaths": "the dev manager's `tests-reviewed` label (changing what counts as a test after implementation)",
    "goldenPaths": "the dev manager's `tests-reviewed` label (changing what counts as an expected output)",
    "dependencyManifests": "the dev manager's `deps-reviewed` label (it decides what counts as a new dependency)",
    "protected": "the owner's decision: it changes which files an agent may merge",
    "alwaysAllowed": "the owner's decision: it changes which files an agent may merge",
    "trustedReviewers": "the owner's decision: it changes whose approvals count",
    "mainBranch": "the owner's decision: the PR gate reads the branch from GitHub, so keep it the same",
    "reviews.safety-auditor.paths": "the owner's decision: it changes which changes get the safety auditor",
    "reviews.security-reviewer.paths": "the owner's decision: it changes which changes get the security reviewer",
}


class SettingError(ValueError):
    """A value that doesn't fit its setting; the message says what is wrong."""


class Setting:
    def __init__(self, key, kind, section, short, options=None, default=None, **more):
        self.key, self.kind, self.section, self.short = key, kind, section, short
        self.options, self.explicit_default = options, default
        self.scope = more.get("scope", "project")
        self.minimum = more.get("minimum", 1)
        self.maximum = more.get("maximum")
        self.items = more.get("items", "str")  # what a list holds: "str" or "any"
        self.regex = more.get("regex", False)  # a list of regexes: each one must compile
        self.long = more.get("long", "")
        self.examples = more.get("examples", [])
        self.read_by = more.get("read_by", SECTION_READERS[section])
        self.needs = more.get("needs", NEEDS.get(key, ""))

    @property
    def default(self):
        node = DEFAULTS
        for part in self.key.split("."):
            if not isinstance(node, dict) or part not in node:
                return self.explicit_default
            node = node[part]
        return node if self.scope == "project" else self.explicit_default


def S(*a, **kw):
    return Setting(*a, **kw)


SETTINGS = {s.key: s for s in [
    S('prd', 'str', 'paths', 'Where the PRD lives. Agents read the sections a task points to.'),
    S('plan', 'str', 'paths', 'The build plan (plan mode: its unticked lines are the tasks).'),
    S('blocked', 'str', 'paths', 'The blocked list (plan mode): `- 1.3: needs ...` lines are skipped.'),
    S('decisions', 'str', 'paths', 'The folder of numbered decision records.'),
    S('numberedDirs', 'list', 'paths', 'More folders of numbered files (migrations): a new file takes a free number.'),
    S('mainBranch', 'str', 'paths', 'The main branch.'),
    S('commands.install', 'str', 'commands', 'Installs dependencies in a new worktree (start it with `git submodule update --init`).', default=''),
    S('commands.typecheck', 'str', 'commands', 'The typecheck CI and the Stop check run.'),
    S('commands.lint', 'str', 'commands', 'The lint command.'),
    S('commands.test', 'str', 'commands', 'The full test command.'),
    S('commands.build', 'str', 'commands', 'The build command.'),
    S('commands.smoke', 'str', 'commands', 'A quick command proving main still works.'),
    S('commands.stackUp', 'str', 'commands', 'Brings the dev stack up (Postgres, MinIO ...); `factory resume` runs it at boot. Should return once the stack is started. Empty: no stack at boot.'),
    S('commands.stackHealth', 'str', 'commands', 'Passes (exit 0) once the stack is healthy; `factory resume` asks until it does. Empty: stackUp is enough.'),
    S('commands.agentSetup', 'str', 'commands', "Runs once per loop after the env is set, e.g. to create the slot's database.", default=''),
    S('commands.typecheckChanged', 'str', 'commands', "The Stop check's typecheck, for the changed packages only (saves time and tokens). Empty: use commands.typecheck."),
    S('commands.ci', 'str', 'commands', 'What CI runs (typecheck, lint, test, build), for `factory verify`; `{base}` is origin/<main>. When set on main, a ready PR needs it passed for its commit.'),
    S('commands.fix', 'str', 'commands', "Formats and auto-fixes the files this branch changed, e.g. `prettier --write {files} && eslint --fix {files}` (`{files}` is the quoted list; without it the list is appended). The Stop check and `factory verify` run it first, so agents never spend a turn on style."),
    S('fixPaths', 'list', 'commands', 'Regexes: commands.fix gets only changed files matching one of them. Empty: every changed file.'),
    S('commands.testChanged', 'str', 'commands', "The Stop check's tests, for the changed packages only. Empty: use commands.test."),
    S('codePaths', 'list', 'commands', 'Folders with code: the Stop check runs only when they changed.'),
    S('checkRequires', 'list', 'commands', 'Paths that must exist before the Stop check runs, e.g. ["node_modules"].'),
    S('checkOutputLines', 'int', 'commands', 'How many lines of a failing check the agent is shown (failures first).'),
    S('checkLogDir', 'str', 'commands', "Where a check's full output is saved; the agent sees a capped summary and this path."),
    S('protected', 'list', 'tests', 'Regexes of files an agent may not merge.'),
    S('alwaysAllowed', 'list', 'tests', 'Files that are never protected (the plan, the blocked list).'),
    S('testPaths', 'list', 'tests', 'Regexes the Factory guard treats as tests.'),
    S('goldenPaths', 'list', 'tests', 'Regexes the guard treats as expected outputs.'),
    S('dependencyManifests', 'list', 'tests', 'Regexes of dependency manifests (a new dependency needs deps-reviewed).'),
    S('maxOpenPRs', 'int', 'gate', 'Ready PRs the account may have open at once. About the number of agents + 1.'),
    S('prSizeWarn', 'int', 'gate', 'The guard warns above this many changed lines.'),
    S('reviewMarkers', 'str', 'gate', 'Where review passes are written.'),
    S('reReviewPercent', 'int', 'gate', "A reviewer's second round reads only what changed since its last round, unless that is more than this percent of the branch diff (or touches a new file): then it is a full review. 0: always a full review."),
    S('lessons', 'str', 'gate', 'The curated lessons file: one-line rules the builder and the reviewers read first (`factory lessons`).'),
    S('lessonsCap', 'int', 'gate', 'The most lessons the file may hold; `factory lessons check` fails above it and add refuses. Prune what a check enforces now.'),
    S('manager.flakes', 'list', 'gate', 'Names of CI jobs known to fail now and then for no reason. `factory prs` says `rerun flake` for a PR whose only red jobs are these, failing for the first time on that commit; a second failure goes back to the agent.', default=[]),
    S('trustedReviewers', 'list', 'gate', 'GitHub logins whose approvals count. Empty: any.', default=[]),
    S('holdLabel', 'str', 'gate', 'The label the dev manager puts on a PR it is reviewing.'),
    S('agents', 'list', 'agents', "The agents' names, in order (lowercase letters, digits, dashes)."),
    S('agentEnv', 'dict', 'ports', 'Per-loop variables: {"API_PORT": "{port:4100}", "DATABASE_URL": "...{suffix}"}.'),
    S('portStep', 'int', 'ports', "How far each agent's ports move from the previous agent's."),
    S('claimStaleHours', 'int', 'agents', 'How long a local claim or a pushed task branch holds a task.'),
    S('waitMinutes', 'int', 'agents', 'How often an idle loop looks for work. 0: it exits instead.', default=1),
    S('models', 'dict', 'agents', 'The model per role (builder, manager, test-writer, reviewer, architecture-reviewer, safety-auditor, security-reviewer): {"builder": {"model": "opus", "effort": "high"}, "reviewer": {"model": "sonnet", "escalateTo": "opus"}}. effort (low, medium, high, xhigh, max) is for builder and manager only. A role with no entry keeps today\'s model: the agent file\'s, or Claude Code\'s default.', default={}),
    S('tasks.source', 'enum', 'issues', 'Where tasks come from.', options=['plan', 'issues']),
    S('tasks.staleHours', 'int', 'issues', 'An in-progress issue with no activity this long counts as stale.'),
    S('tasks.pingMinutes', 'int', 'issues', 'How often a working agent pings its agent issue, at most.'),
    S('tasks.downMinutes', 'int', 'issues', 'No ping for this long: the agent counts as down.'),
    S('tasks.heartbeatSeconds', 'int', 'issues', "How often the heartbeat daemon (`factory heartbeat`) looks at this machine's agents. It writes to GitHub only on a change, and every pingMinutes as a keepalive."),
    S('tasks.heartbeatMissMinutes', 'int', 'issues', 'An agent the daemon writes for counts as silent after this many minutes without a keepalive (instead of downMinutes).'),
    S('tasks.releaseDownMinutes', 'int', 'issues', 'An agent that is plainly down (its loop or the daemon said so) gets its in-progress issues back to ready by the sweep after this long.'),
    S('tasks.showWhere', 'bool', 'issues', 'Post the machine, folder, tmux session and Remote Control link on agent issues (anyone who can read the repo sees them).', default=False),
    S('reviews.safety-auditor.paths', 'list', 'gate', 'Regexes of paths that need the safety auditor.'),
    S('reviews.security-reviewer.paths', 'list', 'gate', 'Regexes of paths that need the security reviewer.'),
    S('eval.command', 'str', 'design', 'The eval command (e.g. `pnpm golden`). Empty: no eval yet.', default=''),
    S('eval.baseline', 'str', 'design', "The eval's baseline file.", default=''),
    S('design.references', 'str', 'design', 'The folder of design references. Empty: no design check.', default=''),
    S('notes', 'str', 'paths', 'The folder of project notes for the shared agents and skills.'),
    S('usageLog', 'str', 'paths', 'Where `factory usage --record` appends its rows (commit it to keep the history).', default='docs/factory-usage.md'),
    S('release.repo', 'str', 'paths', 'The GitHub repository whose releases `factory update` installs (owner/name). Default: the factory\'s own, deresegetachew/my-skills.'),
    S('styles', 'list', 'commands', 'Style guides per path: [{"paths": [...], "skills": [...], "check": "..."}].'),
    S('ci.name', 'str', 'ci', "The self-hosted runner's name (default `<repo>-ci`).", default=''),
    S('ci.label', 'str', 'ci', 'The runner label CI jobs ask for (default `<repo>-local`).', default=''),
    S('ci.runners', 'int', 'ci', 'Heavy runner loops per machine (each with its own Docker); FACTORY_CI_RUNNERS overrides it on one machine.', default=1),
    S('ci.light', 'bool', 'ci', 'Also run one small runner without Docker for light jobs (the Factory guard), label `<repo>-light`.', default=True),
    S('ci.image', 'str', 'ci', "The heavy runners' image: build (with the project's Node, pnpm and Playwright, faster jobs) or base.", options=['build', 'base'], default='build'),
    S('ci.caches', 'bool', 'ci', 'Keep a pull-through Docker Hub mirror between jobs (heavy runners; read-only to jobs, no workspace or secrets).', default=True),
    S('turbo.api', 'str', 'ci', "The shared Turborepo cache's address, as agents and CI reach it: http://<Tailscale or LAN address>:3335. Empty: no shared cache. `factory turbo install` starts it.", default=""),
    S('turbo.team', 'str', 'ci', "The cache's team name (default: the repository's name).", default=""),
    S('turbo.bind', 'str', 'ci', "The address the cache server listens on, on the machine that runs it. 127.0.0.1 reaches only that machine; use its Tailscale or LAN address for others.", default="127.0.0.1"),
    S('turbo.port', 'int', 'ci', "The port the cache server listens on.", default=3335),
    S('turbo.secretsCommand', 'str', 'ci', "A command that prints TURBO_TOKEN=... (and TURBO_REMOTE_CACHE_SIGNATURE_KEY=...) lines, for example `sops -d --output-type dotenv secrets/factory.yaml`. The token is never stored in factory.json; TURBO_TOKEN in the environment wins.", default=""),
    S('ci.lightLabel', 'str', 'ci', "The light runner's label (default `<repo>-light`).", default=''),
    S('tasks.labels', 'dict', 'issues', 'The GitHub labels that mark a task: ready, inProgress, inReview, blocked and the agentPrefix.'),
    S('structure.roots', 'list', 'commands', 'Folders the structure check (check_structure.py) looks at, when a style uses it.', default=[]),
    S('structure.legacy', 'str', 'commands', 'The list of legacy files the structure check leaves alone (it only shrinks).', default=''),
    S('eval.skill', 'str', 'design', 'The skill that runs the eval.', default='eval'),
    S('eval.metrics', 'list', 'design', 'The metrics the eval reports.', default=[]),
    S('eval.mustNotDrop', 'list', 'design', 'Metrics that must not drop against the baseline, e.g. ["warning recall 100%"].', default=[]),
    S('eval.paths', 'list', 'design', 'Regexes of changed paths that need the eval.', default=[], regex=True),
    S('design.skill', 'str', 'design', 'The skill that runs the design check.', default='design-check'),
    S('design.renders', 'str', 'design', 'The folder of reference renders (images) the design check compares with.', default=''),
    S('design.preview', 'str', 'design', 'The command that serves a preview of the built screens.', default=''),
    S('design.paths', 'list', 'design', 'Regexes of changed paths that need the design check.', default=[], regex=True),
]}
# Machine scope: this machine's own file (factory_machine.py), never the project's.
MACHINE = {s.key: s for s in [
    S('agents', 'list', 'machine', 'The agent names this machine runs. Two machines must never share a name.', scope='machine', default=[]),
    S('remoteControl', 'bool', 'machine', 'Start loop and agent sessions with Remote Control, so you can reach them from claude.ai/code or your phone.', scope='machine', default=True),
    S('autostart', 'bool', 'machine', 'Bring the stack and this machine\'s agents back after a reboot (`factory autostart`).', scope='machine', default=False),
    S('autostartAgents', 'list', 'machine', 'The agents it starts at boot. Empty: the names this machine runs.', scope='machine', default=[]),
    S('autostartReport', 'bool', 'machine', 'Post the boot report on the first started agent\'s issue (issues mode).', scope='machine', default=True),
]}

for _key in ("protected", "testPaths", "goldenPaths", "dependencyManifests", "reviews.safety-auditor.paths",
             "reviews.security-reviewer.paths"):
    SETTINGS[_key].regex = True
for _key in ("alwaysAllowed",):
    SETTINGS[_key].regex = False
SETTINGS["styles"].items = "any"
SETTINGS["waitMinutes"].minimum = 0
SETTINGS["reReviewPercent"].minimum, SETTINGS["reReviewPercent"].maximum = 0, 100
for _key in ("maxOpenPRs", "portStep", "claimStaleHours", "prSizeWarn", "checkOutputLines", "tasks.staleHours",
             "tasks.pingMinutes", "tasks.downMinutes", "ci.runners"):
    SETTINGS[_key].minimum = 1

# Long help, examples and who reads a setting, for the ones that need more than the short line.
MORE = {
    "prd": dict(long="The product requirements document. Agents read the sections a task points to, and the dev manager "
                     "checks scope against it. Changing it is the owner's call, so it is usually in `protected`.",
                examples=["factory settings set prd docs/PRD.md"]),
    "plan": dict(long="Plan mode (`tasks.source` is `plan`): every unticked `- [ ] **1.3 Title**` line is a task, taken in "
                      "order. In issues mode the plan is only an overview.",
                 examples=["factory settings set plan docs/build-plan.md"]),
    "blocked": dict(long="Plan mode: a `- 1.3: needs the owner's API key` line takes task 1.3 out of the queue until the "
                         "line is removed.", examples=["factory settings set blocked docs/blocked.md"]),
    "decisions": dict(long="The folder of numbered decision records (`0001-title.md`). A new file must take a number that "
                           "neither main nor another open PR has; the gate names the next free one.",
                      examples=["factory settings set decisions docs/decisions"]),
    "numberedDirs": dict(long="More folders of numbered files besides `decisions`, for example database migrations. The PR "
                              "gate gives each new file a number no other open PR uses.",
                         examples=["factory settings set numberedDirs '[\"db/migrations\"]'"]),
    "mainBranch": dict(long="The branch PRs merge into. The PR gate does not trust this file for it: it asks GitHub for "
                            "the default branch.", examples=["factory settings set mainBranch main"]),
    "notes": dict(long="A folder of `<agent or skill name>.md` files with this project's additions to the shared agents "
                       "and skills. Each agent reads its own file first, if present.",
                  read_by="the shared agents and skills", examples=["factory settings set notes .claude/factory/notes"]),
    "usageLog": dict(long="`factory usage --record LABEL` appends a row of token numbers per task here. Commit the file "
                          "to keep the history.", read_by="factory_usage.py"),
    "commands.typecheck": dict(long="Run by CI and by the Stop check after the agent's turn. Empty: skipped.",
                               examples=["factory settings set commands.typecheck 'pnpm -s typecheck'"]),
    "commands.test": dict(long="The full test command, run by CI and by the Stop check when files under `codePaths` "
                               "changed. Use `commands.testChanged` to run only the changed packages in the Stop check.",
                          examples=["factory settings set commands.test 'pnpm -s test'"]),
    "commands.ci": dict(long="Everything CI runs, as one command, for `factory verify`. When it is set on main, a ready "
                             "PR needs `factory verify` to have passed for its commit, so errors are caught locally. "
                             "`{base}` stands for origin/<main>.",
                        examples=["factory settings set commands.ci 'pnpm -s turbo run typecheck lint test build --filter=...[{base}]'"]),
    "commands.stackUp": dict(long="`factory resume` runs it at boot to bring the dev stack back (Postgres, MinIO ...). It "
                                  "should return once the stack is started, not stay in the foreground.",
                             examples=["factory settings set commands.stackUp 'pnpm stack:up'"]),
    "codePaths": dict(long="The Stop check (typecheck and tests) runs only when a file under one of these folders "
                           "changed, so a docs-only turn costs nothing.",
                      examples=["factory settings set codePaths '[\"apps\", \"packages\"]'"]),
    "styles": dict(long="Style guides per path. Each entry has `paths` (globs), `skills` (the style-guide skills to apply) "
                        "and an optional `check` command that CI runs. The architecture reviewer reviews diffs on "
                        "those paths and the PR gate needs its pass.",
                   examples=['factory settings set styles \'[{"paths": ["apps/api/**"], "skills": ["nestjs-best-practices"], "check": "python3 tools/check_structure.py"}]\'']),
    "protected": dict(long="Regexes on file paths. A PR that changes a protected file is never merged by an agent: the "
                           "dev manager or the owner merges it. Keep `^\\.claude/` here: it protects the factory's "
                           "own settings. Loosening this list is the most sensitive change in the file.",
                      examples=['factory settings set protected \'["^CLAUDE\\\\.md$", "^\\\\.claude/", "^\\\\.github/"]\'']),
    "alwaysAllowed": dict(long="Files that are never counted as protected even if a `protected` regex matches, typically "
                               "the plan and the blocked list that agents tick off.",
                          examples=['factory settings set alwaysAllowed \'["docs/build-plan.md"]\'']),
    "testPaths": dict(long="Regexes for test files. The Factory guard in CI fails a PR that weakens tests (deleted "
                           "assertions, `.skip`, `.only`) unless the dev manager labelled it `tests-reviewed`. "
                           "Changing this list after implementation is itself a change to what the guard sees.",
                      examples=['factory settings set testPaths \'["(^|/)tests?/", "\\\\.test\\\\.[jt]sx?$"]\'']),
    "goldenPaths": dict(long="Regexes for expected outputs (snapshots, fixtures, golden sets). The guard fails a PR that "
                             "changes them without the `tests-reviewed` label.",
                        examples=['factory settings set goldenPaths \'["(^|/)golden[^/]*/"]\'']),
    "dependencyManifests": dict(long="Regexes for dependency manifests. A PR that adds a dependency to one needs the "
                                     "dev manager's `deps-reviewed` label.",
                                examples=['factory settings set dependencyManifests \'["(^|/)package\\\\.json$"]\'']),
    "maxOpenPRs": dict(long="The PR gate refuses to open another ready PR while this many are open for the account. "
                            "Set it to about the number of agents plus one, so the dev manager can keep up.",
                       examples=["factory settings set maxOpenPRs 4"]),
    "prSizeWarn": dict(long="The guard warns (it does not fail) when a PR changes more lines than this. Small PRs are "
                            "reviewed faster.", examples=["factory settings set prSizeWarn 600"]),
    "reviewMarkers": dict(long="Review passes are small marker files named after the branch and commit. They live in "
                               "this folder (git-ignored), and the PR gate looks for them.",
                          examples=["factory settings set reviewMarkers tmp/reviews"]),
    "reReviewPercent": dict(long="A reviewer's second round reads only what changed since its own last round, unless that "
                                 "delta is more than this percent of the branch diff or touches a new file: then it is "
                                 "a full review. 0: always a full review.",
                            examples=["factory settings set reReviewPercent 30"]),
    "trustedReviewers": dict(long="Only approvals from these GitHub logins count at the merge gate. Empty: any approval "
                                  "counts. Use it when the repository has other collaborators.",
                             examples=['factory settings set trustedReviewers \'["your-login"]\'']),
    "holdLabel": dict(long="While the dev manager reviews a PR it puts this label on it. Agents skip held PRs (no "
                           "rework) and can't merge them.", examples=["factory settings set holdLabel factory-hold"]),
    "reviews.safety-auditor.paths": dict(long="A diff touching these paths needs the safety auditor's pass before the PR "
                                              "gate opens. Use it for the rules your CLAUDE.md says must never break.",
                                         examples=['factory settings set reviews.safety-auditor.paths \'["^packages/warnings/"]\'']),
    "reviews.security-reviewer.paths": dict(long="A diff touching these paths needs the security reviewer's pass: auth, "
                                                 "payments, public endpoints, uploads, storage, tenancy, secrets.",
                                            examples=['factory settings set reviews.security-reviewer.paths \'["^apps/api/src/auth/"]\'']),
    "agents": dict(long="The agents' names, in order. The first works in the project folder, the others in "
                        "`<project>-agents/<name>`. Names become folder names and `agent:<name>` labels, so use "
                        "lowercase letters, digits and dashes. Each name is a slot, which decides its ports.",
                   examples=['factory settings set agents \'["ada", "grace", "haile"]\'']),
    "claimStaleHours": dict(long="A loop's claim on a task (and a pushed task branch) lapses after this many hours, or "
                                 "when its process exits, so a crashed agent doesn't hold work for ever.",
                            examples=["factory settings set claimStaleHours 6"]),
    "waitMinutes": dict(long="An idle loop looks for work this often (a token-free wait). 0: it exits instead of waiting.",
                        examples=["factory settings set waitMinutes 1"]),
    "models": dict(long="The model per role: builder, manager, test-writer, reviewer, architecture-reviewer, "
                        "safety-auditor, security-reviewer. `effort` (low, medium, high, xhigh, max) is for builder and "
                        "manager only; the reviewer may `escalateTo` a stronger model. A role with no entry keeps "
                        "today's model.",
                   examples=['factory settings set models \'{"builder": {"model": "opus", "effort": "high"}, "reviewer": {"model": "sonnet", "escalateTo": "opus"}}\'']),
    "tasks.source": dict(long="`plan`: the unticked lines of the build plan are the tasks. `issues`: open GitHub issues "
                              "labelled ready are the tasks, claimed with labels and a claim comment.",
                         examples=["factory settings set tasks.source issues"]),
    "tasks.labels": dict(long="Rename the labels the factory puts on issues. Keys: ready, inProgress, inReview, blocked, "
                              "agentPrefix. Keys you leave out keep their defaults.",
                         examples=['factory settings set tasks.labels \'{"ready": "ready-for-agent"}\'']),
    "tasks.staleHours": dict(long="An in-progress issue with no activity for this long goes back to ready (the dev manager "
                                  "does it).", examples=["factory settings set tasks.staleHours 3"]),
    "agentEnv": dict(long="Variables that differ per parallel loop, so loops don't share ports, databases or queues. "
                          "Placeholders: `{slot}` (1, 2, ...), `{suffix}` (empty in slot 1, `_N` after) and "
                          "`{port:N}` (N in slot 1, N + portStep * (slot - 1) after). `validate` checks that no two "
                          "ports collide across slots.",
                     examples=['factory settings set agentEnv \'{"API_PORT": "{port:4100}", "DATABASE_URL": "postgres://app:app@localhost:5432/app{suffix}"}\'']),
    "portStep": dict(long="How far each agent's ports move from the previous agent's. Make it larger than the number of "
                          "ports a loop uses.", examples=["factory settings set portStep 10"]),
    "ci.runners": dict(long="Heavy runner loops per machine, each with its own Docker. `FACTORY_CI_RUNNERS` overrides it "
                            "on one machine. Run `factory ci install` again after changing it.",
                       examples=["factory settings set ci.runners 3"]),
    "eval.command": dict(long="What the eval skill runs, e.g. `pnpm golden`. Empty: no eval yet.",
                         examples=["factory settings set eval.command 'pnpm golden'"]),
    "design.references": dict(long="The folder of design reference screens the design-check skill compares a built "
                                   "screen with. Empty: no design check.",
                              examples=["factory settings set design.references design/screens"]),
    "agents@machine": dict(long="The names this machine runs for the project, each one an agent in the project's `agents`. "
                                "`FACTORY_AGENTS` (comma-separated) overrides it. Empty: every name in the project's "
                                "`agents`. In issues mode a name another machine has live is refused.",
                           examples=["factory settings --local set agents haile,tewodros"],
                           needs="nothing: it is this machine's file, not committed"),
    "remoteControl@machine": dict(long="Whether `factory loop -i` and `factory agent` start Claude with Remote Control, so "
                                       "you can reach the session from claude.ai/code or your phone. "
                                       "`FACTORY_REMOTE_CONTROL=0` or `1` overrides it for one run.",
                                  examples=["factory settings --local set remoteControl off"],
                                  needs="nothing: it is this machine's file, not committed"),
}
for _key, _more in MORE.items():
    _table = MACHINE if _key.endswith("@machine") else SETTINGS
    _s = _table[_key.split("@")[0]]
    for _field, _value in _more.items():
        setattr(_s, _field, _value)
for _s in list(SETTINGS.values()) + list(MACHINE.values()):
    if _s.scope == "machine" and not _s.needs:
        _s.needs = "nothing: it is this machine's file, not committed"


def table(local=False):
    return MACHINE if local else SETTINGS


def free_form_keys():
    return {k for k, s in SETTINGS.items() if s.kind == "dict"}


def is_free_form(path):
    """True when `path` is a setting that holds an object whose keys are the person's own (agentEnv, models ...)."""
    return path in free_form_keys()


def is_known_path(path):
    """True when `path` is a setting, a group of settings (`tasks`), or inside a free-form setting."""
    parts = path.split(".")
    for i in range(1, len(parts) + 1):
        head = ".".join(parts[:i])
        if head in SETTINGS and (SETTINGS[head].kind == "dict" or i == len(parts)):
            return True
    return any(k.startswith(path + ".") for k in SETTINGS)


def section_of(name):
    """The slug for a section given as its slug, its title or the start of either (case-insensitive); else None."""
    name = (name or "").strip().lower()
    for slug, title, _ in SECTIONS:
        if name in (slug, title.lower()):
            return slug
    matches = [slug for slug, title, _ in SECTIONS if name and (slug.startswith(name) or title.lower().startswith(name))]
    return matches[0] if len(matches) == 1 else None


def as_text(value):
    return json.dumps(value, ensure_ascii=False)


# --- checking values ------------------------------------------------------------------------------------------

def _agent_names(names, known=None):
    from factory_config import safe_agent
    seen = set()
    for name in names:
        try:
            safe_agent(name if isinstance(name, str) else "")
        except SystemExit:
            raise SettingError(f"{name!r} isn't a valid agent name: use lowercase letters, digits and dashes.")
        if name in seen:
            raise SettingError(f"{name} is listed twice: each agent name must be used once.")
        seen.add(name)
        if known is not None and name not in known:
            raise SettingError(f"{name} isn't an agent in `agents` of the project ({', '.join(known)}).")


def _agent_env(value):
    from factory_env import render
    for var, template in value.items():
        if var.startswith("_"):
            continue
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(var)):
            raise SettingError(f"{var!r} isn't a valid variable name: letters, digits and _ only.")
        if not isinstance(template, str):
            raise SettingError(f"{var} takes text such as \"{{port:4100}}\"; got {template!r}.")
        try:
            render(template, 1, 10)
        except SystemExit as e:
            raise SettingError(str(e.code))


def _styles(value):
    for i, entry in enumerate(value, 1):
        if not isinstance(entry, dict):
            raise SettingError(f"item {i} takes an object: {{\"paths\": [...], \"skills\": [...]}}.")
        for field, kind in (("paths", list), ("skills", list), ("check", str)):
            if field in entry and not isinstance(entry[field], kind):
                raise SettingError(f"item {i}: `{field}` takes a {'list' if kind is list else 'string'}.")


def check_value(s, value, project_agents=None):
    """Raises SettingError when `value` doesn't fit the setting `s`; returns the value otherwise."""
    kind = s.kind
    if kind == "str":
        if not isinstance(value, str):
            raise SettingError(f"takes text; got {as_text(value)}.")
    elif kind == "enum":
        if value not in s.options:
            raise SettingError(f"takes one of {', '.join(s.options)}; got {as_text(value)}.")
    elif kind == "bool":
        if not isinstance(value, bool):
            raise SettingError(f"takes true or false; got {as_text(value)}.")
    elif kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise SettingError(f"takes a whole number; got {as_text(value)}.")
        if value < s.minimum:
            raise SettingError(f"must be at least {s.minimum} (got {value})" + (
                ". 0 would mean off, which this setting doesn't have." if s.minimum else "."))
        if s.maximum is not None and value > s.maximum:
            raise SettingError(f"must be at most {s.maximum} (got {value}).")
    elif kind == "list":
        if not isinstance(value, list):
            raise SettingError(f"takes a JSON list, e.g. '[\"a\", \"b\"]'; got {as_text(value)}.")
        if s.items == "str":
            for item in value:
                if not isinstance(item, str):
                    raise SettingError(f"every item takes text; got {as_text(item)}.")
        if s.regex:
            for item in value:
                try:
                    re.compile(item)
                except re.error as e:
                    raise SettingError(f"{item!r} isn't a valid regex ({e}).")
        if s.key == "styles":
            _styles(value)
        if s.key == "agents":
            _agent_names(value, project_agents if s.scope == "machine" else None)
        if s.key == "autostartAgents":
            _agent_names(value, project_agents)
    else:
        if not isinstance(value, dict):
            raise SettingError(f"takes a JSON object, e.g. '{{\"KEY\": \"value\"}}'; got {as_text(value)}.")
        if s.key == "models":
            from factory_models import validate
            try:
                validate(value)
            except ValueError as e:
                raise SettingError(str(e))
        if s.key == "agentEnv":
            _agent_env(value)
        if s.key == "tasks.labels":
            allowed = set(DEFAULTS["tasks"]["labels"])
            for k, v in value.items():
                if k not in allowed:
                    raise SettingError(f"{k!r} isn't a label name. Names: {', '.join(sorted(allowed))}.")
                if not isinstance(v, str) or not v:
                    raise SettingError(f"{k} takes a label as text.")
    return value


def parse(s, raw, project_agents=None):
    """The value for `raw` (what a person typed) as the setting's type; raises SettingError."""
    kind = s.kind
    if kind == "str":
        value = raw
    elif kind == "enum":
        value = raw
    elif kind == "int":
        try:
            value = int(raw)
        except ValueError:
            raise SettingError(f"takes a whole number; got {raw!r}.")
    elif kind == "bool":
        if raw.lower() in ("true", "yes", "on", "1"):
            value = True
        elif raw.lower() in ("false", "no", "off", "0"):
            value = False
        else:
            raise SettingError(f"takes true or false; got {raw!r}.")
    else:
        try:
            value = json.loads(raw)
        except ValueError:
            if kind == "list" and s.scope == "machine" and s.items == "str" and raw.strip() and not raw.strip().startswith(("[", "{")):
                value = [n.strip() for n in raw.split(",") if n.strip()]  # `agents haile,tewodros`
            else:
                example = '["a","b"]' if kind == "list" else '{"KEY": "value"}'
                raise SettingError(f"takes a JSON {kind}, e.g. '{example}'; got {raw!r}.")
    return check_value(s, value, project_agents)


def hint(s):
    """What a person may type for this setting, in a few words."""
    if s.kind == "int":
        lo = f"at least {s.minimum}" + (f", at most {s.maximum}" if s.maximum is not None else "")
        return f"a whole number, {lo}"
    if s.kind == "enum":
        return "one of " + ", ".join(s.options)
    if s.kind == "bool":
        return "true or false"
    if s.kind == "list":
        return "a JSON list"
    if s.kind == "dict":
        return "a JSON object"
    return "text"


# --- looking things up and validating a whole file ----------------------------------------------------------------

MISSING = object()


def lookup(data, key):
    node = data
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return MISSING
        node = node[part]
    return node


def effective(data, key):
    here = lookup(data, key)
    if here is not MISSING:
        return here
    return SETTINGS[key].default


def unknown_keys(data):
    """Dotted paths in the project file that are not settings (probably typos); `_about`-style keys are skipped."""
    out = []

    def walk(node, prefix):
        for k, v in node.items():
            if k.startswith("_"):
                continue
            path = prefix + k
            if not is_known_path(path):
                out.append(path)
            elif isinstance(v, dict) and path not in SETTINGS:
                walk(v, path + ".")
    walk(data, "")
    return out


def validate_all(data, root="."):
    """(errors, warnings) for a project file's data. Every message starts with the key it is about."""
    errors, warnings = [], []
    for key, s in SETTINGS.items():
        here = lookup(data, key)
        if here is MISSING:
            continue
        try:
            check_value(s, here)
        except SettingError as e:
            errors.append(f"{key}: {e}")
    for key in unknown_keys(data):
        warnings.append(f"{key}: not a factory setting (a typo?). It is kept and ignored. `factory settings` lists the settings.")
    source = effective(data, "tasks.source")
    for key in ("prd", "decisions", "plan"):
        here = lookup(data, key)
        if isinstance(here, str) and here and not (key == "plan" and source == "issues"):
            if not os.path.exists(os.path.join(root, here)):
                errors.append(f"{key}: {here} doesn't exist. Fix the path, or `factory settings unset {key}`.")
    errors += _port_collisions(data)
    return errors, warnings


def _port_collisions(data):
    env = lookup(data, "agentEnv")
    if not isinstance(env, dict):
        return []
    agents = lookup(data, "agents")
    slots = len(agents) if isinstance(agents, list) and agents else len(DEFAULTS["agents"])
    step = effective(data, "portStep")
    if isinstance(step, bool) or not isinstance(step, int):
        return []
    from factory_env import render
    seen, errors = {}, []
    for var, template in env.items():
        if var.startswith("_") or not isinstance(template, str) or "{port:" not in template:
            continue
        for slot in range(1, slots + 1):
            try:
                rendered = render(template, slot, step)
            except SystemExit:
                continue
            for port in re.findall(r"(?<!\d)\d{2,5}(?!\d)", rendered):
                who = (var, slot)
                if port in seen and seen[port][0] != var:
                    errors.append(f"agentEnv: port {port} is used by {seen[port][0]} (slot {seen[port][1]}) and by "
                                  f"{var} (slot {slot}). Raise portStep or move one base port.")
                seen.setdefault(port, who)
    return errors


# --- generated documentation --------------------------------------------------------------------------------------

README_BEGIN = "<!-- settings:begin -->"
README_END = "<!-- settings:end -->"


def _cell(text):
    return str(text).replace("|", "\\|").replace("\n", " ")


def markdown():
    """The settings tables for the README, one per section, generated from this metadata."""
    out = ["(Generated by `factory settings docs --write` from the settings table in `hooks/factory_settings_schema.py`:",
           "change the table there, not here. `factory settings help <key>` has the long help for each setting.)", ""]
    for slug, title, _ in SECTIONS:
        rows = [s for s in list(SETTINGS.values()) + list(MACHINE.values()) if s.section == slug]
        out += [f"**{title}**" + (" (`factory settings --local`, not in the project file)" if slug == "machine" else ""),
                "", "| Key | Type | Default | What it sets |", "|---|---|---|---|"]
        for s in rows:
            kind = s.kind if s.kind != "enum" else "one of " + "/".join(s.options)
            default = as_text(s.default)
            if len(default) > 60:
                default = "see `factory settings help " + s.key + "`"
            out.append(f"| `{_cell(s.key)}` | {kind} | `{_cell(default)}` | {_cell(s.short)} |")
        out.append("")
    return "\n".join(out).rstrip("\n")
