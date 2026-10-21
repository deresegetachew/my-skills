# my-skills

Reusable skills for Claude Code. Each top-level folder is one self-contained skill.

| Skill | What it does |
|---|---|
| [software-factory](software-factory/README.md) | Turns a repo into a software factory: coding agents build from a PRD and a plan, a dev manager reviews and merges. |
| nestjs-clean-code-ddd-hexagonal | Backend architecture: hexagonal layers, a pure domain, CommandBus and QueryBus, strictly one class per file. Includes a CI checker (`scripts/check_structure.py`). |
| nestjs-best-practices | 40 NestJS rules in 10 categories, each with wrong and right examples. |
| study-notes | Bootstraps and writes pages for an Astro study-notes site. |

## Three ways to use a skill

| Way | Who sees it | When |
|---|---|---|
| **Symlink** (`./install.sh`) | Only you, on this machine | Personal use |
| **Git submodule** | Everyone: CI, cloud sessions, other machines | A project depends on the skill (recommended) |
| **Copy** (`./install.sh --copy`) | Everyone | Like a submodule, when you don't want one |

### Symlink: for yourself

```bash
git clone https://github.com/deresegetachew/my-skills.git ~/Documents/dev/my-skills
cd ~/Documents/dev/my-skills
./install.sh                                  # list skills and what's installed
./install.sh software-factory                 # install one for all projects (~/.claude/skills)
./install.sh --project ~/dev/myapp <skill>    # install into one project only
./install.sh --remove <skill>                 # uninstall
```

`git pull` here updates every symlinked install. A symlink points at your laptop, so it is useless to CI and to
other machines.

### Submodule: for a project

The project records the exact my-skills commit it uses, and every clone gets the same files.

**Set up** (https, so CI needs no key):

```bash
git submodule add https://github.com/deresegetachew/my-skills.git vendor/my-skills
ln -s ../../vendor/my-skills/nestjs-best-practices .claude/skills/nestjs-best-practices   # relative link, works everywhere
```

For the software factory, run `bash vendor/my-skills/software-factory/install.sh . --link` instead; it makes all the
links for you and adds the `./factory` command (see [its README](software-factory/README.md)).

**Clone:** `git clone --recurse-submodules <url>`, or run `git submodule update --init` after a plain clone. In GitHub
Actions, use `actions/checkout` with `submodules: true`.

**Update:** push the change to my-skills, then in the project:

```bash
git submodule update --remote vendor/my-skills
git commit -am "Update my-skills"      # in a pull request, like any other change
```

The project stays on the old version until that commit, so a skill change never reaches it by surprise.

**Protect it:** a coding agent must not change the rules it is reviewed against. Add `^vendor/my-skills` and
`^\.gitmodules$` to `protected` in `.claude/factory.json`.

### Copy

`./install.sh --project ~/dev/myapp --copy <skill>` puts a pinned copy into the project. Run it again to update.

## Using a skill

Claude picks installed skills up by themselves. Call one by name (`/study-notes`), or describe the task in words
that match its description. Each skill's own README or SKILL.md says what it needs to run.
