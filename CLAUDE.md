# CLAUDE.md: how to work in this repo

my-skills holds the owner's reusable Claude Code skills. The big one is **software-factory**: coding agents build a
project task by task, a dev manager reviews and merges, and a project gets the factory as a numbered release
(`factory update`). This repo is also built with its own factory (#112): the task list is this repo's GitHub issues.

What is here (read the part your task is about, not everything):

1. `software-factory/docs/PRD.md`: **read this first.** What the factory is for, the decisions taken, the user stories
   for each role, what is out of scope and what is later or open. It is the source of truth for scope.
   `software-factory/README.md`: how the factory works and every setting. `software-factory/SKILL.md` and
   `software-factory/DEV-MANAGER.md`: the skill for setting up a project and the dev manager's rules.
2. `software-factory/hooks/` (the `factory_*.py` commands and the hooks), `ci/` (runner services), `factory`,
   `factory-loop.sh`, `install.sh`: the factory's code. `software-factory/kit/` holds only what a project gets
   copied or linked: agents, skills, `settings.json`, templates. Old `kit/` paths that are symlinks are
   forwarders from the move (#112); do not add new ones.
3. `tools/`: `run_tests.py`, `check_skills.py`, `build_release.py` (the release archive).
4. `nestjs-best-practices/`, `nestjs-clean-code-ddd-hexagonal/`, `study-notes/`: separate skills.

## Test and check

- Everything: `PYTHONDONTWRITEBYTECODE=1 python3 tools/run_tests.py` (runs every `software-factory/tests/test_*.py` in
  its own process; no pytest). One file: `python3 software-factory/tests/test_<name>.py`. It takes minutes, so run the
  files for the code you changed while you work, and the whole set before the pull request.
- `python3 tools/check_skills.py`: each top-level skill folder is well formed, every `.sh` parses, every `.py`
  compiles, every `.json` loads. A new top-level folder (not starting with a dot) must be a skill with a `SKILL.md`.
- CI (`.github/workflows/check.yml`) runs both. Restore tracked `.pyc` files and remove temp folders after a run.

## The rules that matter most

A change that breaks one of these is wrong even if the tests pass.

- **No new dependencies.** The factory is Python 3 standard library and bash. No pip, no npm.
- **Tests are never weakened, skipped or deleted** to make a change pass. Failing tests come first; a bug fix adds
  the test that would have caught it. Tests check what a user or another program can observe (command output, exit
  codes, files written, what a fake `gh` or fake server was asked), never internals.
- **Agents cannot change what governs them.** The PR gate, the guard, `settings.json`, the agents' definitions and
  `.claude/factory.json` are protected: a pull request that touches them is listed as such and is merged by the dev
  manager or the owner, not by the agent that wrote it.
- **Publishing is the owner's call.** Never publish a release or push a tag, and never push to `main`.
- **Settings docs are generated.** The tables in `software-factory/README.md` come from
  `hooks/factory_settings_schema.py`; a test fails when they drift. Change the schema, then update the table.
- **A copied file gets the modes its reader needs** (#111): anything copied for a service or a container is readable
  by that user and not writable by others, with a test.
- **Safe to run twice, and nothing half done.** Installers and updaters check first, change nothing on a refusal,
  and undo a partial write.

## Writing for people

- Plain and short. Sentence case. Say what happened and what to do next.
- Errors are `{code, message, fix}`: `fix` tells the person the exact command or step.
- Names in docs and help match the commands (`factory update`, not "the updater"). Do not invent numbers.

## Code style

- Python: standard library only, small functions. Bash scripts must pass `bash -n`.
- Hooks and commands read settings through `factory_config.py`; a new setting is added to `factory_settings_schema.py`
  with its help and default, and to the README table.
- A new command appears in `factory help`, the README commands table and has a test of its output.

## How to work

- This repo uses its own factory through links: `./factory`, `./factory-loop.sh` and `.claude/{hooks,ci,agents,skills,
  manager,settings.json}` are relative symlinks into `software-factory/` (made by
  `bash software-factory/install.sh . --link --layout new`, re-run it when a shared file is added, then `rmdir docs/decisions docs` if it left an empty `docs/` folder:
  `check_skills.py` fails on a top-level folder that is not a skill). Edit the real
  files in `software-factory/`, never through a link. Run `./factory doctor` first on a new machine, then
  `./factory loop -i`. Do not run `factory update` here: this repo is where the releases come from.
- One task is one GitHub issue, labelled `factory:ready`, `factory:in-progress`, `factory:in-review`,
  `factory:blocked` (the labels are made once by `factory issues setup`; do not create labels by hand). The order is
  in issue #114. `factory next` gives the next one. Small pull requests with `Closes #<n>` (or `Part of #<n>`).
- A pull request body lists: what changed, the tests run (command and counts), protected files touched, choices made
  where the issue left them open, and risks. When an owner decision is missing, take the simplest option that fits,
  and write it down under "Choices I made".
- Questions go to the dev manager as PR comments starting with `<!-- factory-question -->`.
- Notes for individual agents are in `.claude/factory/notes/<agent or skill>.md`; they only add to the shared rules.

## Where the tasks are

The issues are the list, in the order of #114. `factory next` shows the next one. Scope is in the PRD.
