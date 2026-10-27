# my-skills

My reusable skills for Claude Code, kept in one place so every project can use the same version.

<br>

## What's inside

| Skill | What it does |
|---|---|
| [**software-factory**](software-factory/README.md) | Turns a repo into a software factory. Coding agents build it task by task, and a dev manager reviews and merges. |
| **nestjs-clean-code-ddd-hexagonal** | The backend architecture: hexagonal layers, a pure domain, strictly one class per file. Comes with a CI checker. |
| **nestjs-best-practices** | 40 NestJS rules in 10 categories, each with a wrong and a right example. |
| **study-notes** | Builds and fills an Astro site for study notes. |

<br>

## How a skill reaches Claude

Claude Code reads skills from a `.claude/skills/` folder: either your personal one (`~/.claude/skills/`) or the one
inside a project. So "installing" a skill means putting it in one of those folders.

The question is **who needs to see it**:

| Who needs the skill | Use | Section |
|---|---|---|
| Only you, on your own laptop | A symlink to this folder | [1. Just for you](#1-just-for-you) |
| A project: its CI, cloud sessions and every clone | A git submodule | [2. For a project](#2-for-a-project) |

A symlink is the quickest, but it points at a folder on your laptop, so nothing else can follow it. A project needs
the files inside its own repo, and a submodule puts them there.

<br>

## 1. Just for you

Clone this repo once, then link the skills you want:

```bash
git clone https://github.com/deresegetachew/my-skills.git ~/Documents/dev/my-skills
cd ~/Documents/dev/my-skills

./install.sh                       # list the skills and what's installed
./install.sh study-notes           # install one for all your projects
./install.sh --remove study-notes  # uninstall
```

To update, run `git pull` in this folder. Every linked skill updates at once.

<br>

## 2. For a project

The project adds this repo as a **git submodule** in `vendor/my-skills`. Git then records which my-skills commit the
project uses, and every clone, CI run and cloud session gets exactly that version.

### Set it up, once

```bash
cd ~/dev/myapp
git submodule add https://github.com/deresegetachew/my-skills.git vendor/my-skills
```

Then link the skills you need into the project's `.claude/skills/`. The link is relative and lives inside the
repo, so it works on every machine:

```bash
mkdir -p .claude/skills
ln -s ../../vendor/my-skills/nestjs-best-practices .claude/skills/nestjs-best-practices
git add .gitmodules vendor/my-skills .claude/skills
git commit -m "Skills from my-skills"
```

> **Using the software factory?** It does not come through the submodule: a project installs it from a numbered
> release (`factory update <tag>`). See [software-factory](software-factory/README.md#set-up-a-project). The submodule
> is only for the other skills, such as the nestjs ones.

### Clone a project that uses it

```bash
git clone --recurse-submodules <project url>
# or, after a plain clone:
git submodule update --init
```

In GitHub Actions, check out with `submodules: true`.

### Update to a newer my-skills

1. Change the skill here and push it to main.
2. In the project, move the submodule forward and commit it in a pull request:

   ```bash
   git submodule update --remote vendor/my-skills
   git commit -am "Update my-skills"
   ```

The project stays on its old version until that commit merges. A change here never reaches a project by surprise.

### Protect it

A coding agent must not change the rules it is reviewed against. In a software factory project that keeps the
submodule, add `vendor/my-skills` and `.gitmodules` to the protected list; agents are denied edits under `vendor/`.

<br>

## How to cut a release

The factory is delivered as numbered GitHub releases. Only the owner publishes one.

1. Change `software-factory/VERSION` (for example `1.1.0`) in a pull request and merge it to `main`.
2. Tag that commit on `main` and push the tag: `git tag v1.1.0 && git push origin v1.1.0`.
3. The `Release` workflow (`.github/workflows/release.yml`) runs. It refuses a tag that is not on `main` or that differs from `VERSION`, runs `check_skills.ts` and the tests, builds the archive, checks the checksum and publishes the release with notes. A tag with a `-` (for example `v1.1.0-rc.1`) is published as a pre-release.
4. A refused or failed run publishes nothing. Delete the tag (`git push origin :refs/tags/v1.1.0`), fix the cause and tag again.

To try the build locally (needs a clean checkout, works offline): `bun tools/build_release.ts --out dist`. The same commit always gives the same bytes.

### What a release holds

Two files: `software-factory-<version>.tar.gz` and `SHA256SUMS` (check with `sha256sum -c SHA256SUMS` in the folder with both). The archive has one folder, `software-factory-<version>/`:

```
MANIFEST.json   schema, version, tag, source commit, and every file with sha256, size and mode
VERSION
factory  factory-loop.sh  install.sh  README.md  SKILL.md  DEV-MANAGER.md  PO.md
hooks/          every hook and factory_*.ts command, including the release client factory_release.ts
ci/             the runner services
docs/           the PRD, reference pages and the wiki
kit/            what a project is given: agents, skills, the agents' rules, templates
```

It is everything git tracks under `software-factory/` except `tests/` (those test my-skills itself), the dev-only
type-checking files (`package.json`, `tsconfig.json`, `bun.lock`) and caches. Nothing from the other skills is in it.

## Using a skill

Once a skill is installed, Claude picks it up by itself. Call it by name, for example `/study-notes`, or describe
the task in words that match its description.

<br>

<details>
<summary>Another option: a pinned copy instead of a submodule</summary>

`./install.sh --project ~/dev/myapp --copy <skill>` copies the skill into the project. Run it again to update the
copy. This works like a submodule for CI and clones, but the files are duplicated, so prefer the submodule.

</details>
