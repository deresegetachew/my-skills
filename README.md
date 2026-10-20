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
need the skill too, use a git submodule (next section), or add `--copy`: `./install.sh --project ~/dev/myapp --copy nestjs-best-practices` commits a pinned copy
into the project, and re-running it updates the copy.

## Use in a project as a git submodule

When a project's CI, cloud sessions or other machines need a skill, a symlink to your laptop's folder won't do:
the link points at a path that only exists on your laptop. Add my-skills to the project as a **git submodule**
instead. The project then records exactly which my-skills commit it uses, and every clone gets the same files.

**Set it up once** (use the https URL, so CI can fetch it without a key; my-skills is public):

```bash
cd ~/dev/myapp
git submodule add https://github.com/deresegetachew/my-skills.git vendor/my-skills
mkdir -p .claude/skills
ln -s ../../vendor/my-skills/nestjs-best-practices .claude/skills/nestjs-best-practices
ln -s ../../vendor/my-skills/nestjs-clean-code-ddd-hexagonal .claude/skills/nestjs-clean-code-ddd-hexagonal
git add .gitmodules vendor/my-skills .claude/skills && git commit -m "Skills from my-skills as a submodule"
```

The links are **relative and inside the repo**, so they work on every machine, unlike a link to your laptop's folder.
A skill's scripts run straight from the submodule, for example
`python3 vendor/my-skills/nestjs-clean-code-ddd-hexagonal/scripts/check_structure.py`.

**Clone or check out:**
- `git clone --recurse-submodules <url>`, or `git submodule update --init` after a plain clone;
- the same in each new git worktree (`factory-loop.sh` does it for you);
- in GitHub Actions, `actions/checkout` with `submodules: true`.

**Update the skills in the project:** push your change to my-skills first, then in the project:

```bash
git submodule update --remote vendor/my-skills
git commit -am "Update my-skills"          # through a pull request, like any other change
```

The project keeps the old version until that commit, so a skill change never reaches a project by surprise.
`git diff --submodule` shows which my-skills commits came in.

**Software factory projects:** add `^vendor/my-skills` and `^\.gitmodules$` to `protected` in `.claude/factory.json`,
so a coding agent can't change the rules it is reviewed against. Put `git submodule update --init` first in
`commands.install`.

**Which to use:**
- **Symlink** (`./install.sh`): only you, only on this machine.
- **Submodule:** the project's CI, cloud sessions and other people need the skill.
- **Copy** (`--copy`): the same, but when you don't want a submodule.

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
