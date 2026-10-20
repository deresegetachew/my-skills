# my-skills

Reusable agent skills — not tied to any one project or tool. Each top-level folder
is a self-contained skill (instructions + templates/scripts it needs).

## Install

Clone once, anywhere:

```bash
git clone git@github.com:deresegetachew/my-skills.git ~/Documents/dev/my-skills
cd ~/Documents/dev/my-skills
```

Then pick what to install:

```bash
./install.sh                  # list the skills and what's already installed
./install.sh software-factory # install one globally (~/.claude/skills)
./install.sh --all            # install everything
./install.sh --project ~/dev/myapp software-factory   # only inside one project
./install.sh --remove study-notes                     # uninstall
```

It symlinks, not copies, so `git pull` here updates every install at once. For a project whose CI or cloud sessions
need the skill too, add `--copy`: `./install.sh --project ~/dev/myapp --copy nestjs-best-practices` commits a pinned copy
into the project, and re-running it updates the copy.

## Run

Once symlinked, Claude Code picks the skill up automatically — invoke it by name
(`/study-notes`) or just describe the task in words matching the skill's
description (e.g. "start a new study-notes site like my other one"); Claude reads
the matched skill's `SKILL.md` and follows it, which for a skill like `study-notes`
means it runs the setup commands (copy templates, `npm install`, etc.) itself. There's
nothing to install with `npm`/`pip`/etc. at the my-skills-repo level — each skill's
own README/SKILL.md documents whatever *it* needs to run (e.g. `study-notes` needs
Node + npm to build the Astro site it scaffolds).

## Update

```bash
cd ~/Documents/dev/my-skills && git pull
```

No re-linking needed — symlinks always point at the current file.

## Skills

- **study-notes** — bootstrap and author pages for an Astro-based study-notes/
  lesson site (component library, dark-mode theme, optional Gemini AI-tutor chat
  sidebar).
- **nestjs-clean-code-ddd-hexagonal** — the backend architecture style: hexagonal layers, a framework-free domain,
  use cases behind a CommandBus and QueryBus, thin controllers, SQL only in adapters, and strictly one class per file.
  Comes with `scripts/check_structure.py`, a CI check with a legacy list that only shrinks.
- **nestjs-best-practices** — 40 NestJS rules in 10 categories (architecture, DI, errors, security, performance,
  testing, database, API, microservices, DevOps), each with wrong and right examples.
- **software-factory** — turn a repo into a software factory: a coding agent builds
  from a PRD and a build plan in a loop (`/loop /next-task all`: tests first, reviewer and
  auditor subagents, hooks that gate PRs and merges), and a dev manager Claude session
  reviews, merges, fixes leftovers and keeps it busy. Includes the kit to copy into a
  project (`install.sh`) and the dev manager's playbook.
