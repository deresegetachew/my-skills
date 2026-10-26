# Projects that use the submodule

For projects that still take the factory through a git submodule: what is shared, how to update and how to move to releases.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [Appendix: projects that use the submodule](#appendix-projects-that-use-the-submodule)
- [Installed as a submodule: what's shared and what's yours](#installed-as-a-submodule-whats-shared-and-whats-yours)
- [Updating the factory](#updating-the-factory)

<br>

## Appendix: projects that use the submodule

Some projects still take the factory through a git submodule (`vendor/my-skills`). This part is for them.

### Moving a project from the submodule to releases

A project that takes the factory from the submodule has its engine files as links. A release does not overwrite links:
`factory update v0.1.0-alpha.1` (or `--release`) stops with `[linked_install]` and changes nothing. The move is its own
reviewed pull request, and today most of it is by hand:

1. **Start from a clean main** and make a branch for the move.
2. **Remove the links the installer made** for the engine files: `.claude/hooks/*`, `.claude/ci/*`, the agents and skills
   the factory ships, `.claude/settings.json`, `.claude/manager/settings.json`, `factory` and `factory-loop.sh`. By hand;
   no command does this step yet. Keep your own files (`.claude/factory.json`, `.claude/factory/notes/`, `CLAUDE.md`).
   Keep the `.claude/skills/nestjs-*` links if you use them (see the next section). Commit the removal on the branch:
   `factory update` refuses a tree with uncommitted changes (`[dirty_tree]`) when the project has no pin yet.
3. **Install the release.** `factory` is gone with its link, so run the client from the submodule that is still there:
   `python3 vendor/my-skills/software-factory/hooks/factory_release.py update v0.1.0-alpha.1`. It writes real files, the
   pin `.claude/factory/release.json` and no templates over yours.
4. **Decide about the submodule.** A project that uses the nestjs skills keeps `vendor/my-skills` for them only; a
   project that does not removes the submodule, its `.gitmodules` entry and the `submodules: true` lines in CI. Both are
   by hand.
5. **Check:** `factory doctor` is green, and `factory version` shows the release.
6. **Commit the install and open the pull request.** `.claude/` and `.gitmodules` are normally in `protected`, so the
   dev manager or the owner merges it. After that, `factory update` is the only way the factory changes in the project.

Steps 2 and 4 are the parts still manual. Moving Remanual, the first project, is the owner's merge.

<br>
## Installed as a submodule: what's shared and what's yours

### What the installer does

`bash vendor/my-skills/software-factory/install.sh . --link`, run from the project's folder:

- **Links the shared files.** For every agent, skill, hook, `factory ci` file (`.claude/ci/`), `settings.json`,
  `factory` and `factory-loop.sh` in the kit, it makes a relative symlink in the project that points into `vendor/my-skills`. A plain copy that's identical
  to the kit becomes a link. A copy that differs is kept, with a warning: move its project lines into `factory.json`
  or a note, delete it, and run the installer again.
- **Copies the templates** the first time only (when there's no `.claude/factory.json` yet): `factory.json`, the
  notes folder, `CLAUDE.factory.md`, the docs templates, the CI workflow, the issue template and `CODEOWNERS`. It
  never overwrites a file that's there.
- **Tells the stack on that first install** (#199, `hooks/factory_stack.py`). A `package.json` means Node: the pnpm
  `ci.yml` and the `commands.*` of the template stay. No `package.json` and Python files (`pyproject.toml`,
  `setup.py`, `requirements*.txt`, or `tests/test_*.py`) mean Python: `ci.yml` is the Python template
  (`kit/.github/workflows/ci-python.yml.template`, which runs `commands.install` and `commands.test`), the pnpm
  `commands.*` are emptied, `commands.install` is `python3 -m pip install -r requirements.txt` when that file exists,
  and `commands.test` is `python3 -m unittest discover` only when the tests are unittest-style (otherwise it stays
  empty and the output says to set it). Anything else keeps the pnpm template and the output names the files to edit.
  The output says which it chose. An existing `ci.yml` is kept as it is. The first install from a release
  (`factory update <tag>`, no `.claude/factory.json` yet) does the same, with the detector from the release's own
  `hooks/factory_stack.py`; later updates never touch `ci.yml` or `commands.*`. `factory doctor` does not yet check that the
  workflow matches `factory.json` (follow-up of #199).
- **Adds `tmp/` and `__pycache__/`** to `.gitignore`.

Without `--link` (`bash install.sh <project dir>`), it copies everything instead, for a project without the
submodule. Then nothing updates by itself.

Commit the links. Git stores a link as its target path, so every clone gets them back.

### Why `.claude/` holds links

Claude Code looks for agents, skills and hooks in the project's `.claude/` folder, never in `vendor/`. So the real
files stay in the submodule, and `.claude/` points to them:

```
.claude/agents/reviewer.md  ──►  vendor/my-skills/software-factory/kit/.claude/agents/reviewer.md
   where Claude looks               the real file
```

- There's one copy of each file, pinned to one my-skills commit.
- Your editor and Claude follow the link. `ls -l .claude/hooks` shows the arrows.
- **Never edit a link.** Agents can't anyway (`Edit(./.claude/**)` and `Edit(./vendor/**)` are denied). Change the
  file in my-skills, then [update](#updating-the-factory).

### Shared and project-owned

| Shared: links into `vendor/my-skills` | The project's own |
|---|---|
| The agents: reviewer, architecture-reviewer, test-writer, safety-auditor, security-reviewer | `.claude/factory.json`: commands, paths, protected files, ports, which paths need which review |
| The skills: next-task, design-check, eval | `.claude/factory/notes/<agent or skill>.md`: what an agent needs that only this project knows |
| The hooks, `.claude/ci/`, `settings.json`, `factory`, `factory-loop.sh` | `CLAUDE.md`, the PRD, the plan, the decisions, the CI workflow |
| Style-guide skills you link from my-skills | The `.gitmodules` entry and the pinned commit |

**To customise, never edit a shared file in the project:**

- **Structured settings go in `factory.json`.** For example, this sends every change touching auth or billing to the
  security reviewer:

  ```json
  "reviews": { "security-reviewer": { "paths": ["auth", "billing"] } }
  ```

- **Free text goes in a note.** `.claude/factory/notes/security-reviewer.md` might say "tenants are brands; payments
  are Stripe". Each agent and skill reads its note first. A note adds to the shared rules; it never removes one.
- **A rule that should change everywhere** is changed in my-skills. Each project then takes it with `factory update`.

<br>
## Updating the factory

*This section is for a project still on the submodule. A project with `.claude/factory/release.json` uses
[releases](updating.md#updating-from-releases).*

**The pin.** The project doesn't store my-skills' files. It stores one commit id for `vendor/my-skills` (a
"gitlink"; `git ls-files -s vendor/my-skills` shows it). The folder is a checkout of that commit. Nothing in my-skills
reaches a project until the project moves its pin, in a PR.

**To take a newer factory:**

1. Change the file in my-skills and merge it to main there.
2. In the project, on a clean main: `factory update`.
3. Commit the result on a branch and open a PR. `factory update` prints the commands, for example
   `git checkout -b chore/update-my-skills && git add -A && git commit -m "Update my-skills to <commit>"`.
4. When `vendor/my-skills` and `.gitmodules` are protected (they should be), the gate won't let an agent merge it:
   the dev manager or you merge it.

**What each command does:**

| Command | What it does | Changes the pin? |
|---|---|---|
| `git submodule update --init` | Makes `vendor/my-skills` match the pinned commit (clones it the first time) | No |
| `git submodule update --remote vendor/my-skills` | Moves the folder to my-skills' newest main | Yes, in your working tree: you commit it |
| `factory update` | Runs both of the above, lists the new my-skills commits, re-runs `install.sh . --link` to link any new shared files (`--layout new` also switches the links to the new folders), and tells you to commit. It doesn't commit or push | Yes, like `--remote` |
| `git config submodule.recurse true` | One setting per clone (not committed). After it, `git pull`, `checkout` and `switch` also update the submodule to the pin | No |
| `git clone --recurse-submodules <url>` | Clones the project with the submodule checked out | No |

**After the update PR merges:**

- **Running agents need nothing.** Between tasks the loop goes back to `origin/main` and runs
  `git submodule update --init`. If `factory-loop.sh` changed, it [restarts itself](agent-loops.md#agent-loops). Each new Claude
  session also runs `git submodule update --init` in its SessionStart hook, so it uses the new hooks.
- **Your own clones:** `git pull` moves the pin but, without `submodule.recurse`, leaves the files where they were.
  `git status` then shows `modified: vendor/my-skills (new commits)`. Run `git submodule update --init` to fix it.

<br>

Previous: [The files in the kit](kit-files.md)
