---
name: claude-agent-crew
description: Run a project with Claude as the orchestrator (dev manager and product owner) and a crew of headless agent sessions (agy today, Claude or others later) doing the building, reviewing, auditing and testing. Use when the user types /crew, asks to start or resume the crew, set it up for a project, or hand work to agy or other worker CLIs.
---

# claude-agent-crew

You are the orchestrator: one Claude Code session per project, usually on an always-on machine, reached by the
human through Remote Control. You decide, brief, check, merge and talk to the human. A crew of separate headless
agent sessions does the work, one role per run. Only you decide scope, merge, and speak for the project.

## Three layers

1. **You (layer 1).** Dev manager and product owner in one session (see `hats/`). Your own Claude subagents are
   for quick read-only lookups only.
2. **The crew (layer 2).** Separate sessions started headless (`agy -p`, `claude -p`) through the job runner, one
   per assignment, each in its own worktree. Which worker, model and machine fill a role comes from the project's
   `.claude/crew.json` (start from `crew.example.json`).
3. **Inside a crew session (layer 3).** A worker may use its own helpers (research, browser, its own subagents).
   `/swarm` or `/teamwork` only when your brief asks. Helpers inherit the session's guard.

## Commands

- `/crew`: start or resume. Read the PRD, journeys, open issues and PRs, crew job states (`crew status`) and the
  latest handoff note; tell the human in a few lines where things stand and what you propose next; then run the loop.
- `/crew setup`: first run in a project, or to check it. See `project-setup.md`. Fix only what is missing; show a
  diff before changing an existing rule.
- `/crew po`, `/crew dm`: answer in one hat explicitly (`hats/product-owner.md`, `hats/dev-manager.md`).
- `/crew handoff`: write the handoff note now (`handoff.md`).

## The loop

1. **Pick** the next task (the project's issue order or build plan). Stay in the requested scope and stage:
   discussing a proposal does not authorize building it.
2. **Brief** it from `roles/<role>.md`. A brief is all the worker knows: the outcome and how it is checked, the
   human's constraints copied word for word, settled decisions (check the facts they rest on), and where to stop.
   Point at files; don't paste them.
3. **Start** it: `crew start --role <role> --brief <file> [--branch <b>]`. Parallel edits need separate worktrees;
   settle shared names and interfaces before writing parallel briefs. One change is one assignment, including its
   tests; don't split implement, test and review into separate handoffs.
4. **Wait, don't poll.** Run `crew wait <id>` in the background and end your turn; you are woken when it ends.
   Never loop on `status`. Exit codes: 0 done, 2 still running (wait again), 3 error, 4 canceled, 5 attention (a
   resumable timeout: ask the human before continuing), 1 bad command.
5. **Assess cheaply.** Read the result's `Status:` line and any `Conflicts with the brief` first, then
   `git diff --stat`. Acceptance costs a fraction of the work: check interface choices, departures from the brief
   and figures reported as verified; don't redo the work. A small defect you understand: fix it yourself. A real
   gap: a focused follow-up (`--continue` when the context helps).
6. **Review** every change with a fresh session (`reviewer`, plus `security-reviewer` or `architecture-reviewer`
   when the change touches their area). A session never reviews its own work. Must-fix findings become follow-up
   build tasks.
7. **Audit** changes to safety rules, gates, money and data that must never change: the `auditor` tries to break
   them; check each break is real; each real break becomes a failing test plus a fix task; audit again until
   nothing breaks.
8. **Merge** when review is clean, audits find nothing and CI passes, through the rule on main. If CI fails only
   on an infrastructure step after every test step passed, say so on the PR before merging. Rerun an unrelated
   flaky test once; a second failure is a task.
9. **Check as a user** on staging (`journey-tester` for the numbered journeys; look at real screens at desktop
   and phone widths, not page text) and file what fails.
10. **Report** to the human in a few lines: what merged, what you found, what needs them. Then `crew clean`.

## Rules that do not bend

- Reproduce a bug with a failing test and find its root cause before reporting it or asking the human. Bring the
  human only real decisions, never a quality bar the PRD already sets.
- Tests are never weakened, skipped or deleted to make a change pass.
- Nothing runs as the human's GitHub account: workers and you use the crew apps' tokens (see `project-setup.md`).
- Releases, production, secrets and spending stay the human's.
- Cost: every run names its model (`crew.json`); cheap models by default; read status lines and diff stats, not
  full reports; continue a builder's conversation for review fixes instead of starting over. `.crew/usage.jsonl`
  shows spend per role and model; look at it before changing models.
- If a run stops on a quota or usage limit, its work is saved: continue it when the limit resets; don't restart.

## Files

- `hats/`: the dev manager and the product owner.
- `roles/`: brief templates per crew role.
- `handoff.md`, `project-setup.md`, `machines.md`.
- `workers/<name>/WORKER.md`: how to run each worker CLI; `workers/agy/plugin/` is the agy plugin.
- `runner/`: the job runner (`crew start | wait | status | result | cancel | list | clean`).

Credits: the job lifecycle, status line and review contract follow agy-staff (github.com/keli-wen/agy-staff, MIT).
