# Reviews and gates

Which reviews a change needs, and the gate that decides what an agent may merge.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [Reviews and gates](#reviews-and-gates)

<br>

## Reviews and gates

### Who merges a green task pull request

One rule, no setting. **The builder merges its own task pull request** when the gate allows it: the reviewer passed that
commit, CI is green, no `protected` path changed and the dev manager has no hold or must-fix on it. **A person merges it
(the owner, per CODEOWNERS)** when a protected path changed, or when the pull request says "A person merges this one".
**The dev manager** reviews and merges everything else, and it is the one that picks up a pull request the builder left
open (CI was red, or the run ended): `factory dev-manager loop` lists every open, non-draft pull request whose head has
no review mark. A builder that did not merge ends its final message with the pull request number, why, and
`factory dev-manager loop` as the thing that carries it on. The dev manager's queue puts task pull requests with green CI
ahead of docs and other pull requests of the same kind; one that has waited four times `manager.deadManMinutes` (two hours
by default) goes by age, so nothing is starved.

### The subagents

| Subagent | When | What it does |
|---|---|---|
| `test-writer` | Start of every task that adds behaviour | Writes failing tests from the "Done when" and the PRD. Never touches production code |
| `reviewer` | Every change, before the PR | Runs the checks and the guard, checks the task, the PRD and `CLAUDE.md`, and records a pass for the commit |
| `architecture-reviewer` | Changes on paths with a style guide (`styles`) | Reviews against the style-guide skills, runs their `check`, and records its own pass |
| `safety-auditor` | Changes on `reviews.safety-auditor.paths`, or anything touching the critical rules | Checks each critical rule still holds and is tested; writes a summary for whoever merges |
| `security-reviewer` | Changes on `reviews.security-reviewer.paths`, plus auth, payments, uploads, tenancy, secrets | Reports exploitable problems with file, line and fix |

**Models.** The test-writer, the architecture-reviewer and the reviewer's first pass run on Sonnet; the
safety-auditor and the security-reviewer run on Opus. A reviewer must-fix is fixed first, then the fixed commit is
reviewed on Opus; a diff over `prSizeWarn` lines or one on a `protected` path starts on Opus
([Saving tokens](agent-loops.md#saving-tokens)).

`factory reviews` (`factory_reviews.ts`) lists the extra reviews and checks a change needs, from `reviews`, `eval`,
`design` and `styles` in `factory.json`: for example `safety-auditor`, `security-reviewer`, `eval`, `design-check`,
`architecture-reviewer`. The `reviewer` is always needed and isn't listed. The next-task skill runs each listed one,
and the reviewer checks they ran.

**Review markers.** A pass is a file: the reviewer writes the commit id to `tmp/reviews/<branch>.ok`, the
architecture reviewer to `<branch>.arch.ok` (`reviewMarkers` sets the folder). A pass counts only for that exact
commit, so any new commit needs a new review.

**Incremental re-review.** After a review finds problems and the agent fixes them, the same reviewer should not read the
whole diff again. Each reviewer (`reviewer`, `arch`, `safety`, `security`) records its rounds with
`factory rereview record`: the commit it reviewed, pass or fail, a short findings summary, and the files and changed
lines of the branch diff at that moment, in `<reviewMarkers>/<branch>.reviews.json` (next to the markers, never in
them). The agent saves its answer with `factory rereview reply`. The reviewer's first step is `factory rereview prompt`,
which prints its instructions for this round:

- **delta:** `git diff <last reviewed commit>..HEAD`, the reviewer's own earlier findings and the agent's reply. It checks
  that each finding is fixed and that the new lines are fine, and does not re-read the rest of the branch diff;
- **full:** the whole branch diff, with the earlier findings listed for reference. This is the answer for a first round,
  and when the earlier commit is no longer in the branch's history (rebase or reset), the branch's base moved (main merged
  in), the change touches a file the earlier round never saw, the delta is more than `reReviewPercent` (default 30) percent
  of the branch diff's changed lines, or `reReviewPercent` is 0 (the old behaviour).

`factory rereview plan --kind reviewer` prints which it will be, and why, as JSON. The gate is unchanged: the pass marker
is still a file holding HEAD's id and nothing else, so the last round of every reviewer ends on the PR's head commit. A
round nobody recorded (another machine, a cleaned `tmp/`) simply gets a full review.

**Lessons (#72).** The same mistakes come back across tasks: the dev manager writes the same must-fix, a reviewer flags
the same problem, CI fails for the same reason. Each repeat costs a review round, a CI run and a fix session, so the
project keeps one short **lessons file** (`lessons` in `factory.json`, by default `.claude/factory/lessons.md`):

- **Short on purpose.** At most `lessonsCap` (40) lessons, one line each, each with an example or a link (a `code span`, a
  URL, `#123` or "e.g."): *packages/validators: annotate recursive helpers' return types (e.g. TS7022 in `schema.ts`)*.
  `factory lessons check` fails on a longer file, a wrapped lesson or one without an example, and CI runs it in the
  Factory guard job. Adding past the cap is refused until something is pruned.
- **Read up front.** The builder reads it at the start of a task (`next-task`, step 1) and the four reviewers read it
  before the diff; the `reviewer` treats a change that repeats a lesson as a must-fix and quotes the lesson.
  `factory lessons show` prints the lessons and nothing else, so reading it costs a few hundred tokens.
- **Fed from three sources.** `factory lessons suggest [--last 20] [--min 2]` reads the last N closed task pull
  requests from GitHub and lists causes that came back on at least `--min` of them: the dev manager's must-fix items
  (the list items of each `factory-mustfix` comment), CI failures (the job and step that failed, once per PR, from the
  failed runs on its branch, the data `factory report` counts), and this machine's reviewer findings from
  `<reviewMarkers>/*.reviews.json` (failing rounds; findings on other machines are not seen). Similar wording is grouped,
  and what an existing lesson already says is left out. It prints each candidate with its PRs and a ready
  `factory lessons add "..."` command, and changes nothing.
- **The dev manager approves.** Agents cannot edit `.claude/`, and `add` and `prune --apply` refuse inside an agent
  session (and are denied in the agents' settings); the dev manager runs them and merges the change in a pull request. An agent
  that learns something writes "lesson candidate: ..." in its PR description.
- **Pruned when enforced.** A lesson a hook, lint rule or check enforces now is dead weight. Tag it
  `[enforced: path/to/check]`; `factory lessons prune` lists the tagged lessons whose enforcement exists, `--apply` removes
  them, and `check` warns about a tag that points at nothing.
- **Measured.** `factory report --since <date>` counts must-fix rounds and failed CI runs per task (#65); fewer repeated
  rounds after a lesson is added is the test of the lesson.

### The PR gate

`pr-gate.ts` is a PreToolUse hook. It reads every Bash command Claude runs, including compound ones (`;`, `&&`,
pipes, subshells), and blocks the pull-request commands that aren't ready:

| Command | Allowed only when |
|---|---|
| `gh pr create`, `gh pr new`, `gh pr ready` | The reviewer passed the current commit (and the architecture reviewer, on styled paths). When main's `factory.json` sets `commands.ci`, `factory verify` passed that commit too. Fewer than `maxOpenPRs` of your ready PRs are open. Plan mode: the task isn't ticked or blocked on main. Issues mode: the issue is open, not blocked, not held by another agent, and the body says `Closes #<n>`. Every new decision or migration file (`decisions`, `numberedDirs`) takes a number neither main nor another open PR has; the message names the next free one (`factory_numbers.ts`). Drafts (`--draft`) skip all of this: they're how agents ask questions |
| `gh pr merge` | The command has no `--admin` (it skips branch protection). The PR is named by number or URL. It has no `factory-hold` label. The latest marker on it isn't a must-fix, and if it's an approval, it names the current head. The command has `--match-head-commit <head>`, so GitHub merges only the commit the gate checked. The reviewer passes (and the architecture reviewer's, on styled paths) are for that head. CI is green (`gh pr checks`); when the jobs never started (GitHub billing or the spending limit), the gate says that isn't a code result, so the agent doesn't push or re-run to chase it (`factory_ci.ts`). No protected file changed (all files, past the first 100) |

It also blocks:

- more than one PR command, or a push and a merge, in one command;
- `gh` aliases and anything that isn't a known `gh` command;
- an agent posting the dev manager's markers (`factory-approved`, `factory-answer`, `factory-mustfix`) in a PR or issue
  comment, edit, review or close; `gh pr review --approve`; adding `tests-reviewed` or `deps-reviewed`; removing
  `factory-hold`;
- writes through `gh api` that go around those checks (#260): any method but GET to `repos/<o>/<r>/pulls/<n>/merge`,
  to a `labels` path (or with a `labels` field) or to a `reviews` path, and GraphQL mutations. Other writes have their
  fields (`-f`, `-F body=@<file>`) and `--input` file read: the dev manager's markers and messages are checked as for
  `gh pr comment`, and `POST repos/<o>/<r>/pulls` gets the `gh pr create` checks (`-F draft=true` is a draft). A plain
  GET passes the gate (the agents' settings still deny `gh api`);
- a force push: `git push` with `-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror` or a `+`
  refspec, wherever git's global options (`-C`, `-c`) sit, also inside `bash -c` or `xargs`; and deleting a remote
  branch (`git push <remote> :<branch>`).

It finds `gh` and `git` in the words as the shell reads them, so quoting (`g\h`, `"g"h`) does not hide them.

**A local CI check before the PR** (`commands.ci`). Set it to what the CI job runs, scoped to what changed and
building dependent packages first, for example
`pnpm -s turbo run typecheck lint test build --filter=...[{base}]` (`{base}` becomes `origin/<main>`).
`factory verify` runs main's `commands.ci` (read from GitHub like the gate's rules, so a branch can't change or
miss it; the worktree's copy only when GitHub can't be reached, and it says so). It needs a clean working tree,
with no uncommitted changes and no untracked files that aren't ignored, and records the commit in
`<reviewMarkers>/<branch>.ci.ok`. The gate
then needs that mark for the PR's commit at `gh pr create` and `gh pr ready`, so a type error doesn't cost a CI round
trip and a new session. Drafts don't need it, nor does the merge (CI itself is green by then). Without `commands.ci`
on main, nothing changes.

**It fails closed.** If it hits an error (a broken `factory.json`, `gh` not signed in, a command it can't parse), it
blocks the command and says why.

**Trusted reviewers.** With `"trustedReviewers": ["<login>"]` in `factory.json`, only approvals from those GitHub
logins count, and only their must-fixes send a pull request back to rework (`factory next`). This only helps once the
agents use a different GitHub account from the dev manager (see [Security notes](sandboxed-machine.md#security-notes)).
In issues mode `factory doctor` reports an empty list as a fix (#260).

**Protected by default.** The default `protected` list also covers `factory` and `factory-loop.sh` at the project root:
the loop runs main's copy of the script, so a merged change to it runs in every loop.

The agents' settings back it up with deny rules: no force push, no push to main, no `--no-verify`, no deleting remote
branches, no `gh api` and no `gh alias` from the agent, no edits to `.claude/`, `vendor/`, `CLAUDE.md` or the PRD,
no reading `.env` files.

**These rules and the hooks below apply to the agents only (#258).** They are in `.claude/factory/settings.json`,
which Claude Code never loads by itself: `factory loop` and `factory agent` pass it (`claude --settings`), as main has
it on origin, when they start an agent. Your own Claude sessions in the project run without the gate, the guard's
hooks or these deny rules; CI and the PR gate on the agents' pull requests still apply. A project's own
`.claude/settings.json` applies to every session, and Claude Code adds the factory's rules on top for an agent.

### Other hooks

| Hook | What it does |
|---|---|
| Stop: `check.ts` | In a factory run only (`factory loop`, which sets `FACTORY_LOOP=1`): won't let a turn end while typecheck or tests fail, when code under `codePaths` changed. Skips a rerun when nothing changed since the last green check. Your own session in the project skips it; CI and the PR gate still check the build |
| Stop: `factory_stop.ts` | In `factory loop -i`, closes the session a few seconds after the agent marks its task done |
| SessionStart: `factory_session.ts` | Updates the submodules. In a session `factory agent` started, also claims the folder, installs, sets the agent's env and registers it |
| Post-tool, Stop, SessionEnd: `factory_agents.ts hook` | Pings, idle and down on the agent issue (issues mode) |

### The Factory guard (CI)

`factory_guard.ts` runs in CI on every pull request, where the agent can't edit around it. It fails a PR for:

| Finding | Passes once the dev manager adds |
|---|---|
| An existing test deleted, or an assertion or test case removed or rewritten | `tests-reviewed` |
| A test weakened in a commit after implementation started | `tests-reviewed` |
| An existing golden or expected output changed or deleted (`goldenPaths`) | `tests-reviewed` |
| A new `.skip`, `.only`, `xit`, `fit`, `test.todo` or `@pytest.mark.skip` | `tests-reviewed` |
| A new dependency in a `package.json` | `deps-reviewed` |
| Two decision files with the same number | never: renumber |
| A task branch ticking a task other than its own | never: fix it |
| A workflow using `pull_request_target` | never: fix it |

It warns, without failing, when a PR is over `prSizeWarn` changed lines. A label change re-runs only the guard.
Create the two labels once in the repo. Only the dev manager adds them, after reading the change.

Protected files are not the guard's job: the PR gate stops an agent merging them, and branch protection with
`CODEOWNERS` can require you.

The guard runs from the base branch's checkout, not the pull request's, so a pull request can't change the guard that
judges it. (The pull request that installs the factory has no guard on its base yet, so that one runs its own copy.)

**A project's `bunfig.toml` never reaches the factory's scripts** (#259). Bun reads `./bunfig.toml`, and a `preload`
there runs before the script: it could end the PR gate with "allowed" before the gate looked at the command. So every
place the factory starts Bun (the hooks in the agents' and the manager's settings, both CI templates, `factory`,
`factory-loop.sh`, `install.sh` and the scripts' own calls) passes `--config=/dev/null`, which turns that file off.
`bunfig.toml` is in the default `protected` list, and `factory doctor` notes one that has a `preload`. `factory update`
adds `--config=/dev/null` to the factory's steps in a project's own workflows.

### Branch protection: the real lock

The gate and the hooks are guard rails for well-meaning agents. They run on your machine, inside the agent's own
session, and see only Bash commands. They are not a security boundary: an agent runs the project's own scripts to
build and test, and a script it wrote can run `gh` or `git` past the gate (#261). **GitHub is the lock**, and it needs
two things on GitHub that only the owner can set:

1. **The agents use their own GitHub account, without admin rights.** Make a second account (a machine user), invite it
   under Settings, Collaborators with the **Write** role (not Admin), and on the agents' machine run `gh auth login` as
   that account (or set `GH_TOKEN` to its token). Then `gh pr merge --admin` and a merge through the API fail on
   GitHub's side. Put the dev manager's login (or yours) in `trustedReviewers`.
2. **A ruleset on main** (Settings, Rules, Rulesets, New branch ruleset, target the default branch), or a branch
   protection rule:
   - **Require a pull request before merging, with 1 approval.** The dev manager's account (or yours) approves; the
     agents' account can't approve its own PR.
   - **Require status checks to pass:** `Factory guard` and `Typecheck, lint, test, build` (the job names in the kit's
     CI), plus any you add.
   - **Block force pushes** (and deletions).
   - **No bypass for the agents' account.** Leave the bypass list empty, or only you.

`factory doctor` checks both: it fails when this machine's gh login is an admin of the repo, and when main doesn't
require the `Factory guard` check and a review. A login without admin rights can't read every protection setting;
then it says what to check by hand instead of failing.

Until the agents have their own account, everything is opened under one login, and GitHub doesn't let an author
approve their own PR: require 0 approvals and the checks, and know that the lock is then only as strong as that one
login. Optional: `CODEOWNERS` on the protected paths, with "require review from code owners".

<br>

Previous: [Roles](roles.md) | Next: [The dev manager](dev-manager.md)
