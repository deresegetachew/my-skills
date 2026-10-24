<!-- Software factory: merge this into the project's CLAUDE.md and fill in the <...> parts. -->

# CLAUDE.md: how to work in this repo

<One paragraph: what the product is and who it is for.>

What each document is for. Read the parts your task points to, not every document whole: search a long one
(`grep -n`) and read the sections you need. Most of a task's cost is what it reads.

1. `docs/PRD.md`: user stories (numbered), implementation and testing decisions. **The source of truth for scope.**
2. `docs/architecture.md`: the stack and the repo layout, with the reasons. Read it once before your first task in a new area.
3. `docs/build-plan.md`: phases, tasks and their "Done when" checks. Work through it in order.
4. `docs/decisions/`: decisions made along the way. Read the ones a task points to.
5. <Design system or style guide, if there is one.>

Keep this file short and stable: project notes that change often go in `.claude/factory/notes/`.

## The rules that matter most

A change that breaks one of these is wrong even if the tests pass. The `safety-auditor` checks them.

- <Rule 1: a promise the product must never break, stated so a reviewer can check it.>
- <Rule 2.>
- <Rule 3.>

## Writing for people

- <Voice, tone, casing, wording rules for any text users see.>
- Plain error messages: `{code, message, fix}`, where `fix` tells the person what to do.

## Code style

- <Language, strictness, validation at boundaries, patterns to follow or a reference repo.>

## How to work (software factory)

- To build: `./factory-loop.sh` (a fresh run per task) or `/loop /next-task all`. The next task comes from
  `python3 .claude/hooks/next_task.py`, never from reading the plan by eye. Tests come first from `test-writer`
  and are read-only once implementation starts; `reviewer` passes each commit before its PR.
- Questions go to the dev manager as PR comments starting with `<!-- factory-question -->`; keep working around
  them. Wait for a merge with `.claude/hooks/wait_for_merge.sh <n>`, never with a timed pause.
- CI's Factory guard fails PRs that change existing tests or expected outputs, add `.skip`/`.only` or
  dependencies (until the dev manager labels them reviewed), reuse a decision number, or tick another task.
- PRs merge themselves when the reviewer passed the latest commit, CI is green and no protected files
  changed (`.claude/hooks/pr-gate.py`, paths in `.claude/factory.json`). The rest are reviewed and merged by
  the dev manager (a Claude session watching the repo) or a person.
- UI work is checked with `/design-check`; prompt and model work with `/eval`.
- Small pull requests, one build-plan task each, with tests that check what a user or another module can
  observe. Never assert on prompts or internal state. Model calls in tests use recorded replies.
- Keep secrets out of the repo (`.env.local`, the host's secret store).
- When a decision isn't covered by the docs, choose the simplest option that fits the PRD, write it down in
  `docs/decisions/NNNN-title.md`, and carry on.
