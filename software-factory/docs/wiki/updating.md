# Updating the factory from releases

How a project takes a new factory release, and what an update changes.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [Updating from releases](#updating-from-releases)

<br>

## Updating from releases

A project on releases has the factory as plain files committed in its repo (`.claude/hooks/`, `.claude/ci/`, `factory`,
`factory-loop.sh`, the agents and skills in `.claude/`, and the agents' rules in `.claude/factory/settings.json`), plus one file that says which release they
are: `.claude/factory/release.json`, the **pin**. Updating is a normal reviewed diff. For the common case you need one
command:

```
factory update          # newest release: download, check, install, refresh this machine, verify
```

| Want | Command |
|---|---|
| See where I am | `factory version`: installed release, the one `origin/main` pins, the newest, and what changed since |
| See what exists | `factory releases` (`--all` for the old ones): tag, date, one-line note, and where you are |
| Update to the newest | `factory update`: the newest full release. A pre-release is used only when you name it |
| Install from a file (no network) | `factory update --archive software-factory-1.4.0.tar.gz --sums SHA256SUMS` (`--sums` defaults to the SHA256SUMS beside the archive; the version is read from the file name). The same checksum, manifest and path checks run. It only writes the archive's files: nothing from the archive is run, so runner services are not refreshed (run `factory ci install` yourself) and the runner files are not checked |
| Use a specific release | `factory update v1.4.0` (the `v` is optional; it can be older, too; a pre-release such as `v0.1.0-alpha.1` is taken this way) |
| Go back | `factory rollback`: the release installed before, from this machine's download cache, no network needed |
| Catch up after a pull | `factory update` again: the files came with the pull, so it only refreshes this machine's runner services and verifies |

**`factory update` and `factory rollback` refuse inside the factory's own repository** (my-skills, found by
`software-factory/VERSION` and `tools/build_release.ts` at the root) with `[factory_repo]`, before anything else and
without changing a file. The `.claude/` entries there are links into `software-factory/`, and the releases come from
that repo. The fix: edit the real files in `software-factory/`, then cut a release with `tools/build_release.ts`. Every
other project is unaffected.

`factory update` does this, in order, and stops at the first problem with `[code] message` and `Fix: ...`:

1. Refuses a dirty working tree (it names the files; it stashes nothing). The only dirty tree it accepts is one that
   holds just a previous `factory update` you have not committed yet, so running it twice is safe.
2. Finds the release, downloads the archive and `SHA256SUMS` from GitHub, and checks the archive's SHA-256. A mismatch
   installs nothing and leaves nothing in the cache. A transfer that stops part way does the same.
3. Unpacks in memory with every path checked (nothing outside the archive's own folder, no links, no duplicate or
   unlisted file) and checks every file against the archive's `MANIFEST.json`.
4. Writes the files into the project, undoing everything if a write fails, removes files the new release dropped (one
   you changed is kept and named, never thrown away), and writes the pin. On a project's first release it also adds the templates it does not have (`factory.json`, docs,
   `.gitignore` lines), never over an existing file.
5. Refreshes this machine: if CI runner services are installed here and older than the files (`factory ci stale`), it
   runs `factory ci install`, which also rebuilds the runner image. If the heartbeat daemon is installed here it is
   restarted too (`factory heartbeat restart`), because it is one long process that would otherwise keep running the
   old code.
6. Verifies: every file matches the pin; every hook named in the agents' settings exists; the TypeScript and shell scripts parse;
   and the installed runner files are readable by the runner container's user, not writable by others, and match the
   checkout (`factory ci check`, which, when Docker and the runner image are on the machine, also starts the installed
   entrypoint in the image as the container's own user and parses it). If any of that fails it exits 1, names each problem and does not say it worked.
   `factory doctor` runs the same checks.
7. Prints what changed (old to new, with the release notes' commit titles) and the commands to commit it. **It never
   commits, pushes or makes a branch**: you commit the diff in a pull request, and everyone else gets it by pulling and
   running `factory update`. Agent sessions cannot run it (the PR gate reads these files).

**Your own allow rules.** `.claude/factory/settings.json` (the agents' rules) belongs to the release: a rule typed into
it by hand is drift (`factory doctor` says `fix`), and the next `factory update` replaces it. List the project's extra
allow rules in `.claude/factory.json` instead, as `"permissions": {"allow": ["Edit(src/**)", "Bash(make test*)"]}`.
Each time the factory starts an agent it adds them, as main has them, after the release's own rules (#258), so a rule
applies on the agent's next run once the owner merges the pull request from `factory settings pr`, with nothing else to
run (#251). `factory update` and `factory settings pr` also write them into the file and record it in the pin, so they
are not drift. Use `Edit(path/**)` for files (Claude Code never matches `Write(path)` rules). Deny rules always win.
Changing the list is a protected change: it goes through a pull request the owner merges.

**Where the agents' rules live (#258).** The factory's rules for its agents (the deny list, the PR gate and the other
hooks) are in `.claude/factory/settings.json`, which Claude Code never loads by itself. `factory loop` and
`factory agent` pass it when they start an agent (`claude --settings <file>`), as main has it on origin, never the
worktree's copy, so an agent cannot loosen its own next run. Your own Claude sessions in the project do not get these
rules. A `.claude/settings.json` of your own still applies to every session, agents included: Claude Code adds the
factory's file on top, and a deny rule in either one wins. When main has no agents' settings, the factory starts no
agent and says how to fix it.

**Moving to injected settings.** Releases before #258 kept the agents' rules in `.claude/settings.json`. The update
that brings #258 removes that file when it still matches the pin, and says so; when you changed it, it is kept and
named: move your own rules to `permissions.allow` in `.claude/factory.json`, or keep the file as your own settings for
every session, and commit what you choose. A project linked to the submodule loses the link on its next
`install.sh . --link` (or `factory migrate-to-release`). `factory doctor` notes a `.claude/settings.json` that still
holds the factory's rules.

Where things live: downloads are cached in `~/.cache/software-factory/<repo>/<tag>/` (`FACTORY_CACHE_DIR` moves it).
`release.repo` in `factory.json` names the repository whose releases are used (default `deresegetachew/my-skills`);
`GH_TOKEN` is sent if set (rate limits, private forks). A rollback checks the cached archive against the checksum the
pin recorded, so a replaced cache is refused.

**A project that has no pin keeps working as before.** `factory update` without a pin runs the submodule update
described [below](submodule.md#updating-the-factory) until the project migrates. `factory update --release` (or naming a version)
starts taking releases in a project whose factory files are plain copies; it refuses, and changes nothing, where the
files are links into the submodule. Moving a project off the submodule is its own reviewed pull request.

**Which releases exist.** Pre-releases so far: `v0.1.0-alpha.1` (#184) to `v0.1.0-alpha.3`, each built from the
commit that bumped `software-factory/VERSION`. They are the old Python factory; later releases are Bun (#252). A tag with a hyphen is published as a pre-release. Until a full
release such as `v0.1.0` exists, `factory update` with no version stops with `[no_releases]`, names the pre-release that exists and
says to take it by name: `factory update v0.1.0-alpha.1`. `factory version` shows a pre-release newer than the newest full one on its own line. `factory releases` lists what exists.

**From the old Python release to Bun.** A project on `v0.1.0-alpha.3` updates with `factory update` as before. The
machine needs Bun first (`curl -fsSL https://bun.sh/install | bash`; `factory doctor` checks it). On that one update
the old Python client cannot restart the heartbeat daemon, so if the daemon runs on the machine, run
`factory heartbeat restart` once afterwards. Later updates restart it themselves. The project's
`.github/workflows/ci.yml` still calls `python3 .claude/hooks/*.py`, which that update removed, so CI on the update pull
request fails until it changes: run `factory update` once more with the new client (it rewrites each such step to
`bun --no-env-file .claude/hooks/*.ts` and adds `- uses: oven-sh/setup-bun@v2` to the jobs that need it), then commit
the workflow in the same pull request. `factory doctor` names any workflow step that calls a hook that is not there.

**Cutting a release** (the owner): bump `software-factory/VERSION` in a merged PR, tag that commit `vX.Y.Z` on main and
push the tag. `.github/workflows/release.yml` checks the tag, runs the tests, builds the archive with
`tools/build_release.ts`, and publishes it with `SHA256SUMS` and notes. Agents never publish a release or push a tag.

<br>

Next: [The factory command](commands.md)
