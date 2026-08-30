# my-skills

Reusable agent skills — not tied to any one project or tool. Each top-level folder
is a self-contained skill (instructions + templates/scripts it needs).

## Install

Clone once, anywhere:

```bash
git clone git@github.com:deresegetachew/my-skills.git ~/Documents/dev/my-skills
```

Then make a skill available to Claude Code by symlinking it in — two ways to do that,
depending on where you want it usable:

**Globally** (every project on this machine):

```bash
ln -s ~/Documents/dev/my-skills/<skill-name> ~/.claude/skills/<skill-name>
```

**Project-scoped** (only inside one project, e.g. for a team member who's cloned
`my-skills` at the same path):

```bash
mkdir -p .claude/skills
ln -s ../../../my-skills/<skill-name> .claude/skills/<skill-name>   # adjust ../ depth to your project's location
```

Either way it's a symlink, not a copy — `git pull` inside `my-skills` updates every
project using it at once. Skip this step if you've already symlinked a skill
globally; a project-scoped copy is redundant unless you specifically want the
project to carry the skill even when opened on a machine that has a different (or
no) global skill set.

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
