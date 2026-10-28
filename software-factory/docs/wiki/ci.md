# CI and the build cache

Where CI runs, on GitHub's runners or your own Mac, and how agents share a build cache.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [CI: GitHub's runners or your own Mac](#ci-githubs-runners-or-your-own-mac)
- [A shared build cache](#a-shared-build-cache)

<br>

## CI: GitHub's runners or your own Mac

A project's CI can run on GitHub's runners (the default) or on a self-hosted runner on your Mac, which uses no
GitHub Actions minutes, for example when the account's Actions minutes or billing are blocked. GitHub still starts
the jobs and shows the checks on each pull request; only the machine changes. `factory ci` does both, and doesn't
care which: `factory ci status` works in either mode.

```sh
factory ci install        # once, from a checkout on main, with Docker Desktop running and gh logged in
factory ci use local      # sends jobs to it (the repo variable CI_RUNS_ON)
factory ci status         # mode, latest runs, the runner, Docker, the last log lines
factory ci use github     # back to GitHub's runners; the runner stays installed and idle
factory ci uninstall
```

**Names come from the project.** For `acme/widget` the runner is `widget-ci` and its jobs ask for the label
`widget-local`. The LaunchAgent is `dev.software-factory.widget-ci`, the installed copy is
`~/Library/Application Support/widget-ci/widget-ci`, the log is `~/.local/state/widget-ci/runner.log`, the compose
project is `widget-ci`, and each registration is `widget-ci-<mac>-<time>`. To choose others, or to replace an older
install under another LaunchAgent label (`factory ci install` unloads it and removes its file first):

```json
"ci": {"name": "widget-ci", "label": "widget-local", "repo": "acme/widget", "replaces": ["com.example.old-runner"],
       "runners": 3, "light": true, "lightLabel": "widget-light", "image": "build", "caches": true}
```

**Several Macs.** Run `factory ci install` on each: they register with the same label and GitHub gives each job to
one of them. `factory ci status` lists every runner with the label; `factory ci stop` removes only this Mac's idle
registrations (and any of the project's that are offline and idle).

**How it runs.** The runner is GitHub's runner image as a Linux container, with its own Docker beside it
(Docker-in-Docker, on a unix socket only, no TCP port). Each registration is ephemeral: one job, then both
containers and all their volumes are removed (`down -v`) and a new round starts. No token is stored: each round gets
a registration token from your `gh` login (`factory ci start` also takes one on stdin or from `RUNNER_TOKEN`, and
never writes it). launchd runs a private copy in `~/Library/Application Support/<name>/`, never the checkout, so a
branch checked out later can't change what runs unattended; `factory ci install` warns when the checkout isn't on
`origin/main`. The LaunchAgent has only absolute PATH entries, is checked with `plutil -lint`, and is reloaded with
`launchctl bootout`, a wait until launchd lets go, then `bootstrap`. The loop is an executable named after the
runner (`#!/bin/bash`), so `ps` shows `/bin/bash …/<name>` and `factory ci stop` only kills a process with exactly
that command line. *Not tested:* what macOS shows for it in Login Items and Activity Monitor; the process itself is
still `bash`.

<a id="ci-faster"></a>

**Faster rounds: a pre-built image and a registry mirror (#60).** A fresh runner per job used to download everything
again: Node, pnpm, the service images (Postgres ...) and Playwright's browser. Two things now carry over.

1. **The runner image** (`ci.image`, default `"build"`). `factory ci install` builds `<name>-runner:latest` from
   `runner.Dockerfile`: GitHub's runner image plus what this checkout asks for.
   - Node from `.nvmrc`, in the tool cache `actions/setup-node` looks in first, so it doesn't download it.
   - pnpm from `package.json`'s `packageManager`, through corepack.
   - Playwright's Chromium and its system libraries, in `/ms-playwright`, at the version in the lockfile. The jobs'
     user owns that folder, because Playwright's install writes a lock there even when the browser is present.
   - The image sets `FACTORY_CI_IMAGE=1`, so a workflow can leave out `--with-deps` there.
   - It is labelled with the three versions. `factory ci status` says when the checkout wants others (after a Node
     bump on main, say): then run `install` again, which rebuilds it.
   - If the build fails, the runners use GitHub's plain image and say so. `"image": "base"` skips the build. The
     light lane always uses the plain image.
2. **A pull-through mirror of Docker Hub** (`ci.caches`, default on; heavy runners only). It is `<name>-mirror`, a
   pinned `registry:2.8.3`, one per project and machine, and dind uses it as its registry mirror. Each instance
   reaches it over a network of its own (`<project>-cache`), so two jobs never share a network, and their
   published service ports stay apart.

**What persists, and who can write it.** Only the mirror's store of image layers, and only the mirror writes it,
from Docker Hub.
- A job can pull through it but can't push to it: a pull-through registry takes no pushes, and its volume is mounted
  in no job.
- dind checks every layer against its digest.
- No workspace, build output, environment variable, token or secret is written there.
- **No pnpm store is shared.** Job steps could write into one, and pnpm doesn't re-check a stored file's hash, so one
  pull request could plant code that later jobs (main pushes too) would run. Each job's pnpm store is new.
- dind's data (the job's own images, containers and volumes), the runner's workspace and the job's networks are
  removed by `down --volumes` after every job, so a job never sees another job's files.
- `factory ci uninstall` removes the mirror, its networks and the image too.
- The Turborepo results of the **[shared build cache](#a-shared-build-cache)** are a separate, opt-in service on the
  host (`factory turbo install`), not part of a runner; it has its own security notes.
- **`factory ci start`** (one loop by hand) uses neither: it runs GitHub's plain image with no mirror. Use `install`
  for the faster rounds.

<a id="ci-on-linux"></a>

**On Linux.** `factory ci install` writes a systemd user service, `~/.config/systemd/user/<name>.service`, that runs
the private copy in `~/.local/share/<name>/`, with `Restart=always`. It then runs `systemctl --user daemon-reload`
and `enable --now`. `uninstall`, `status`, `stop` and `logs` work as on a Mac.
- **Linger:** without it, systemd stops a user's services at logout and doesn't start them at boot. `install` says so
  and gives the command: `sudo loginctl enable-linger <user>`.
- **Docker:** the service gets `DOCKER_HOST` from your shell, else from the current `docker context`, else
  `$XDG_RUNTIME_DIR/docker.sock` when rootless Docker is there.
- **The user manager:** `systemctl --user` needs that user's session. From `sudo -iu ci` or `su - ci` there is none, so
  `factory ci` stops before changing anything and says how to get one (log in as the user directly, or enable linger
  and set `XDG_RUNTIME_DIR=/run/user/<uid>`).
- **gh on the CI user:** sign in with `gh auth login --insecure-storage`, so the token is in gh's own file. A keyring
  can't be unlocked by a service at boot. Never put a token in the unit.
- **Recommended:** run CI as a dedicated user with **rootless Docker**. The privileged Docker-in-Docker container
  then has only that user's rights, which contains the known risk below.
- Several machines, Mac or Linux, can serve the same label.

<a id="ci-lanes"></a>

**Two lanes: light and heavy jobs.** Every runner takes one job at a time, so a 30-second Factory guard waits behind
whatever is queued before it. The guard reruns on every label change, and label changes are the dev manager's merge
steps (approval, `tests-reviewed`, the hold), so on one busy runner a merge could wait hours for it (#90). So:

- **Light jobs**: the Factory guard, and any other short job that runs on label changes and needs no Docker. They
  go to the **light lane**: one small runner per machine, label `<repo>-light`, without Docker-in-Docker
  (`compose-light.yaml`, 1 CPU, 1 GB), that takes nothing else.
- **Heavy jobs**: typecheck, lint, tests, build, browsers, evals, anything with service containers. They go to the
  `ci.runners` heavy runners, label `<repo>-local`, each with its own Docker.

`factory ci install` installs both (`"ci": {"light": false}` leaves the light lane out). `factory ci use local` sets
`CI_RUNS_ON` to `["self-hosted","<repo>-local"]` and `CI_RUNS_ON_LIGHT` to `["self-hosted","<repo>-light"]`, and
`use github` deletes both. `install` sets `CI_RUNS_ON_LIGHT` too when local mode is on. If gh can't set a variable
(that needs admin on the repository), the command prints the value, and a person sets it under *Settings → Secrets
and variables → Actions → Variables*. With no light runner online, light jobs wait. Then set `CI_RUNS_ON_LIGHT` to the
same value as `CI_RUNS_ON`, or delete it.

<a id="how-many-runners"></a>
**How many runners.** Each heavy runner is
a loop with its own compose project (`<name>`, `<name>-2`, ...), registration names (`<name>-<host>.2-<time>`),
Docker-in-Docker, volumes and workspace, all removed after each job ([what persists](#ci-faster)). They share the label, so GitHub gives each job
to whichever is free, on any machine. How many fit depends on the machine and the project (a CI box runs 3, a
laptop 1), so the count is set per project and machine (#282):

```
factory ci runners        # the count here and where it comes from
factory ci runners 4      # save 4 for this project on this machine, then install them
```

`factory ci runners 4` writes `ci.runners` into this machine's settings file for the project (the same file as
`factory settings --local`, outside the repo, never committed) and runs `factory ci install`. Which count wins:

1. `FACTORY_CI_RUNNERS` in the shell (for one command or one shell);
2. this machine's saved count (`factory ci runners <n>`, or `factory settings --local set ci.runners <n>`);
3. `ci.runners` in `.claude/factory.json`, the project's default for every machine (`factory settings set ci.runners 3`, merged in a PR);
4. 1.

`factory ci install`, `factory ci status`, `factory update` and `factory doctor --sandbox` all use that count.
`factory update` refreshes the runner services but never scales a machine down: when this machine has more heavy
runners installed than the count says, it keeps them and says so; `factory ci runners <n>` or `factory ci install`
scales it down.

**Clean up** with `factory ci clean`: it lists this project's offline idle runners (`<name>-...`) and its exited CI
containers, and `factory ci clean --apply` removes them. It never deletes `CI_RUNS_ON` or `CI_RUNS_ON_LIGHT`, since
that changes where jobs run (`factory ci use`); when no online runner has their labels it says so. `factory
reset-run` does the same and more (claims, Agent issues, a dangling runs-on variable) before a test run.
- Budget about 4 GB of memory per heavy runner (a job, its dind and its service containers) and 1 GB for the light
  one. `install` warns when that is more than the machine has free.
- CPU matters less: most jobs use one or two cores.
- Scaling down removes the extra instances and their idle registrations. An instance that is running a job stays
  until the job ends, and so does one whose state GitHub can't tell `install` (gh offline); run `install` again then.
  There is a short window between that check and the unload: a job that starts in it is cancelled, and GitHub
  shows it as failed.
- **Running `install` again restarts every instance**, so jobs in progress on this machine are cancelled. Run it when
  the runners are idle (`factory ci status`).
- Registration names keep machines apart: `<name>-<host>-<time>` for instance 1, `<name>-<host>.2-<time>` and
  `<name>-<host>.light-<time>` for the others (a host name never has a dot here). So instance 2 on `foo` and a
  machine called `foo-2` never touch each other's runners.
- On a Mac, the memory check uses Docker Desktop's VM (the jobs run there). On Linux it uses free memory, counting
  the instances that already run.
- With `"light": false`, `install` and `use local` delete `CI_RUNS_ON_LIGHT` (or say a person must), and `status`
  warns whenever `CI_RUNS_ON_LIGHT` names a label that no online runner has.

**The workflow.** Each job picks its machine from those variables, and a pull request from another repository (a
fork) always runs on GitHub's runners. The kit's `.github/workflows/ci.yml` does this:

```yaml
# light: the Factory guard
runs-on: ${{ fromJSON(github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && '"ubuntu-latest"' || vars.CI_RUNS_ON_LIGHT || vars.CI_RUNS_ON || '"ubuntu-latest"') }}
# heavy: everything else
runs-on: ${{ fromJSON(github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && '"ubuntu-latest"' || vars.CI_RUNS_ON || '"ubuntu-latest"') }}
```

What the self-hosted runner needs that GitHub's image has (found in remanual, decision 0047 there):

- `actions/setup-node` **before** `pnpm/action-setup`: pnpm's installer needs `node`, which the runner image lacks.
  Use `pnpm/action-setup`'s own `cache: true` then.
- Tests one package at a time there: `pnpm run test ${{ runner.environment == 'self-hosted' && '--concurrency=1' || '' }}`.
  The Mac's CPUs are shared with the agents' work, and parallel test runs pushed slow tests past their timeouts.
- No Google Chrome (and none for Linux ARM64): for Lighthouse, point `CHROME_PATH` at Playwright's Chromium,
  wrapped with `--no-sandbox` (a container has no user namespaces for Chrome's sandbox).

**Before you use it.** Keep the repository private, and leave *Settings → Actions → General → Run workflows from
fork pull requests* off: that is what keeps outside code off your Mac (the `runs-on` rule above is a second layer).
Creating registration tokens needs admin on the repository. Keep the Mac awake while CI should run; queued jobs
wait (GitHub keeps them up to 24 hours) and start when the runner is back. `factory ci status` calls out runs
queued for a long time with no runner online.

**The known risk.** A job runs the code of the branch it tests, and the Docker-in-Docker container is privileged,
so it is not a security boundary: a job that tries can reach Docker Desktop's VM, your other containers and their
data, the folders Docker Desktop shares (by default all of `/Users`), and services on your Mac's `localhost`. Only
people who can push to the repository (you and the agents) run code on it. Running the runner in a separate VM is
the follow-up ([remanual #150](https://github.com/deresegetachew/remanual/issues/150)).
<a id="a-shared-build-cache"></a>

## A shared build cache

Turborepo caches the result of every task (build, typecheck, test), but only on the machine that ran it. So each agent
worktree, each machine and each CI runner (a new container per job) started cold and rebuilt packages nobody had
touched (#59). The fix is one **self-hosted Turborepo remote cache** per project: a small server
([ducktors/turborepo-remote-cache](https://github.com/ducktors/turborepo-remote-cache), pinned in
`ci/compose-turbo.yaml`) on the factory machine. The agents' sessions and the CI jobs send results to it and take
results from it, so a package that did not change is done once.

**It is off until you set it up, and it degrades by itself.** With `turbo.api` empty nothing changes. With it set, but
no token, or the server not answering, every agent session and CI job says so in one line and builds with the local
cache only, as before. Nothing fails because the cache is away.

### Set it up: one command, once the owner has supplied a token

The token is the one thing the factory cannot make for you, and it is never in the repository or in `factory.json`.

1. **Make a token** and keep it where only you can read it: `openssl rand -hex 32`. For signed artifacts (below) also
   make a signature key of 32 or more characters, the same way.
2. **Tell the factory where to find it**, either of these (the environment wins):
   - export `TURBO_TOKEN` (and `TURBO_REMOTE_CACHE_SIGNATURE_KEY`) in the shell profile of every machine that runs
     agents, and on the machine that runs the server; or
   - set `turbo.secretsCommand` to a command that prints `KEY=value` lines. With sops (which the factory's projects
     already use): put `TURBO_TOKEN: ...` in an encrypted file and set
     `factory settings set turbo.secretsCommand 'sops -d --output-type dotenv secrets/factory.yaml'`. Agents and
     `factory turbo install` run it; `factory doctor` never does.
3. **Pick the address** the agents and CI will use: the machine's Tailscale or LAN address, and a port (3335 by
   default): `factory settings set turbo.api http://100.64.0.7:3335` and `factory settings set turbo.bind 100.64.0.7`.
   Commit `.claude/factory.json` in a PR.
4. **Run `factory turbo install`** on the machine that will host the cache. It starts the server (`docker compose up
   -d`, `restart: unless-stopped`, so it is back after a reboot), waits until it answers, and sets the repository
   variables `TURBO_API` and `TURBO_TEAM` and the secrets `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` (the
   secrets go to `gh` on stdin, never in an argument, so CI uses the same cache. Setting them needs admin on the
   repository; without it the command says what to ask an admin, and `--no-github` skips the step).

`factory turbo status` shows what is set and whether the cache answers, and never prints a secret. Run `factory turbo
install` again to update the server or change the token (the server restarts with the new one); agents pick up a
changed token or address at their next task.

### What agents and CI get

- **Agents.** `factory-loop.sh` asks `factory turbo env` before every task, and the SessionStart hook asks it for a
  plain `factory agent` session. When the cache answers, the session gets `TURBO_API`, `TURBO_TEAM`, `TURBO_TOKEN`
  (and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` when there is one), plus `TURBO_REMOTE_CACHE_TIMEOUT=10` so a slow cache
  cannot stall a build. All agents share one `TURBO_TEAM`, so they share results. The hook never prints the token into
  the session.
- **CI.** The kit's `ci.yml` has a step, *Shared remote cache (optional)*, before the install, that runs
  `factory_turbo.ts ci-env >> "$GITHUB_ENV"` with `vars.TURBO_API`, `vars.TURBO_TEAM` and the two secrets. It sets the
  variables only when they are all there and the cache answers. It is skipped for a pull request from another
  repository (a fork gets no secrets and runs on GitHub's runners). A project that copied `ci.yml` earlier adds the step
  by hand.
- **Reaching it.** The server listens only on `turbo.bind`: `127.0.0.1` unless you choose another address, and
  `install` says when `turbo.api` and `turbo.bind` do not fit (for example a Tailscale address in `turbo.api` and a
  loopback `bind`). The CI runner containers reach the host's Tailscale or LAN address through Docker's normal
  networking, so use that address, not `localhost`. Never put it on the public internet.

### The project's side (a PR in the project, once this is in the pinned my-skills)

- `turbo.json` needs no `TURBO_*` entries: Turborepo reads them itself.
- To sign artifacts, add `"remoteCache": { "signature": true }` to `turbo.json`, and give every machine and CI the same
  `TURBO_REMOTE_CACHE_SIGNATURE_KEY`. `factory doctor` notes a key without that setting.
- Check it works: run a task twice from two agents' worktrees (`pnpm turbo run typecheck`); the second shows
  `cache hit, replaying logs` for the packages nobody changed and `FULL TURBO` at the end. CI shows the same for the
  packages a pull request left alone.

### Security

- **What it stores:** build outputs and logs of Turborepo tasks. No source, no environment, no registry credentials.
  Anyone with the token can read all of it and write to it.
- **Poisoning is the risk.** A cached output that is wrong is replayed by every later run with the same task hash. So:
  - the server answers only with the token, and listens only where you bound it (Tailscale or the LAN, never the
    internet);
  - **sign artifacts** (`remoteCache.signature` plus a signature key): a client then refuses an artifact whose
    signature does not match, so anyone who can reach the server but lacks the key cannot plant one. *Check that your
    server version stores the signature tag:* a server that does not (reported for some storage backends in upstream
    issue 394) makes every signed task a miss, which `FULL TURBO` shows. Then leave signing off until it is fixed;
  - **the token and the key reach everyone who runs jobs with them:** the agents (their sessions have the variables, as
    do commands they run) and the pull-request jobs of this repository. They can write artifacts. That is the same trust
    you already give them to run code on your machine and on the runners, no more, but it means a branch's CI run can
    write what main's run later reads. For a project that does not accept this, leave the repository variable
    `TURBO_API` unset: CI then builds locally, and only the agents share a cache;
  - **forks never use it:** the workflow skips the step, a fork's pull request has no secrets, and it already runs on
    GitHub's runners (not your machine), so it cannot reach a private address anyway. Leave *Run workflows from fork
    pull requests* off, as for the runners;
  - the server container is unprivileged: every capability dropped, a read-only file system, no host mounts, a named
    volume for the artifacts, and a pinned image (`TURBO_CACHE_VERSION` overrides the tag).
- **The token is in the server container's configuration** (`docker inspect`), readable by people in the `docker` group
  on that machine. It is in no file the factory writes and in no command line it runs.
- **Rotating:** change the token where it comes from, run `factory turbo install` (restarts the server and updates the
  repository secret), and the agents pick it up at their next task. `factory turbo down --purge` also clears everything
  stored.

<br>

Previous: [The dev manager](dev-manager.md) | Next: [A sandboxed machine](sandboxed-machine.md)
