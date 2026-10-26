# A sandboxed machine

How to set a machine up for unattended agents, and what to keep in mind about security.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [A sandboxed machine: `factory bootstrap`](#a-sandboxed-machine-factory-bootstrap)
- [Security notes](#security-notes)

<br>

## A sandboxed machine: `factory bootstrap`

`factory bootstrap` takes a fresh Ubuntu or Debian machine (systemd) to a state where agents and CI runners run as a
dedicated, unprivileged user behind a network guard, and ends with `factory doctor --sandbox` green. It is the hand-built
setup of a factory machine written down as code: reinstalling the machine or adding a third one is two commands and
three sign-ins. Linux only for now.

```sh
sudo factory bootstrap machine                 # prints the plan, changes nothing
sudo factory bootstrap machine --script s.sh   # the same steps as a bash script to read (and run with sudo bash s.sh)
sudo factory bootstrap machine --apply         # runs them, as root, after a y/N question (--yes: no question)
sudo -u factory -i                             # or ssh in as that user; then, from the project's checkout:
factory bootstrap project                      # as the sandbox user, never as root
```

`factory bootstrap` works before there is a checkout (it runs from where the `factory` script lives); `project` takes
`--repo URL [--dir PATH]` to clone one, with its submodules.

**Nothing privileged runs by itself.** The machine part and `uninstall` only print their plan unless you pass `--apply`
and run as root; `--dry-run` is accepted everywhere. Every step has a check, so a second run changes nothing, and every
system change is written to a manifest (`/var/lib/software-factory/bootstrap.json`) that `status` and `uninstall` use.
The project part is refused as root. Agents cannot run it: it refuses inside an agent session (`FACTORY_AGENT`, `FACTORY_LOOP` or `CLAUDECODE` set), `status` excepted.

| Part | What it does |
|---|---|
| `machine` (root) | Packages (`uidmap`, `slirp4netns`, `dbus-user-session`, `git`, `gh`, `age`, `tmux`, `nftables` ...); `sops` as the release binary with its checksum checked; the user (default `factory`: no password, no sudo, not in the docker group, its home and the admin's home mode 750); subuid/subgid ranges; `loginctl enable-linger`; the network guard; with `--authorized-keys FILE` the given public keys; with `--harden-ssh` key-only SSH and no root login; with `--keep-awake` (the default on a laptop, `--no-keep-awake` to refuse) no sleep, suspend or lid switch |
| `project` (the user) | Rootless Docker (`dockerd-rootless-setuptool.sh install`, `systemctl --user enable --now docker`); `DOCKER_HOST`, `SOPS_AGE_KEY_FILE` and `PATH` in `~/.bashrc`; `~/.secrets` (700); Node from `.nvmrc` through nvm and `corepack enable`; Claude Code with the official installer; submodules, `.env.local` from `.env.example`, `commands.install`; `factory install-shim`; with `--agents a,b` the machine's agent names; then, after the sign-ins, `commands.stackUp`, the CI runners (`factory ci install`, `--runners N` for `FACTORY_CI_RUNNERS`) and autostart; last, `factory doctor --sandbox` |
| `status` | The manifest against what is there now; exit 1 when something drifted |
| `uninstall` | The guard, its unit and rules, the sleep and SSH drop-ins, the saved settings and the manifest. The user, its home, backups and the installed packages stay. `--remove-user` or `--delete-home` remove the account (only one bootstrap created) and need its name typed (`--confirm NAME` for scripts) |

**The human steps stay yours.** `gh auth login`, the Claude login (and its folder-trust prompt for the project) and
copying the age key are never done by bootstrap. `project` stops after the first part when one is open, prints the exact
commands and exits 2; run it again after, and it carries on with the runners and autostart. It only checks that they
exist (`gh auth status`, the credentials file, `sops -d` of the first file under `secrets/`, output discarded). It never
reads, prints, logs or stores a token or the key.

### Network guard

The default policy: **internet yes; home network no; Tailscale no; other users' files no; no sudo; no docker group.** It is
an nftables table `factory_guard`, loaded by the systemd unit `factory-net-guard.service`, that matches the sandbox user's
uid (`meta skuid`):

- DNS only to the resolver, which is read from `/etc/resolv.conf` and `resolvectl dns` (a systemd-resolved stub on
  127.0.0.53 needs no rule), not hard-coded;
- `--allow-host ADDR[:PORT]` (repeat) lets one home-network host through, such as a Postgres or a build cache;
- everything private is dropped with the log prefix `FACTORY-BLOCK `: RFC1918, the Tailscale range 100.64.0.0/10,
  link-local, and IPv6 ULA and tailnet addresses;
- loopback ports of other users' services are dropped: `--block-loopback-port PORT` (repeat) plus, at every run, every
  loopback or wildcard port that a process of another user listens on (`ss -ltnHe`). A service started later is covered the
  next time `sudo factory bootstrap machine --apply` runs, and `factory doctor --sandbox` fails until then;
- `--block-inbound-port PORT` drops those ports from other hosts (`FACTORY-INBOUND `);
- `--egress none` closes the internet too.

The settings are saved in `/etc/software-factory/sandbox.json`, so a re-run converges on them (`user`, `egress`,
`allowHosts`, `blockLoopbackPorts`, `blockInboundPorts`). Rules are rendered from `hooks/factory_netguard.ts`, which is also
what the tests check.

### `factory doctor --sandbox`

Run it as the sandbox user. Each check prints `ok`, `fix` (with the fix) or `note`:

- identity: the user is the one bootstrap made; no sudo (`sudo -n true` fails); not in the sudo, docker or admin groups;
  the admin's home and `.ssh` are unreadable; `~/.secrets` is 700;
- network: GitHub, npm and the Claude API answer; the router, the tailnet, link-local and the blocked local ports do not;
  `FACTORY-BLOCK` entries appear in the kernel log (a note when this user may not read the log);
- **local services of other users** (known gap 1): every loopback or wildcard port that another user listens on is in the
  guard's rules; if not, run the machine step again;
- **containers** (known gap 2): a container started by this user (`docker run busybox wget` to the router) cannot reach the
  router either, which is true when Docker is rootless because its traffic leaves through the user's own process;
- rootless Docker with overlayfs, the `cpu`, `memory` and `pids` cgroup controllers delegated to the user's systemd
  (the ingest sandbox tests need memory limits), linger on;
- the CI runner units are active (at least `ci.runners`) and every agent worktree has its submodules checked out.

A user account is a weaker boundary than a VM, and the agents still hold what their job needs inside the sandbox: a `gh`
token, the age key and the Claude login. Keep the separate GitHub account for agents from [Security notes](#security-notes).
Not in this version: macOS, a VM mode, creating the GitHub account.

<br>
## Security notes

- **One GitHub login for everything is the weak spot.** By default the agents use your `gh` login. When the dev manager
  also posts as your account, GitHub can't tell them apart: an agent's token can merge, label and
  comment like the dev manager, and `trustedReviewers` can't separate them. The gate and the deny rules stop an agent
  doing this through its normal commands, but they're not a boundary against one that writes its own script.
- **Recommended for projects that matter: a separate GitHub account for the agents**, with write access (not admin)
  to the repo. Then put the dev manager's login in `trustedReviewers`, require approvals or code-owner reviews in
  branch protection, and the agents can't approve their own work.
- **The agents run on your machine.** Keep Claude Code's sandbox on rather than skipping permission checks, and keep
  secrets out of the repo (`.env.local`, the host's secret store). Agents are denied reading `.env` files.
- **Agent issues are public to anyone who can read the repo.** They show the slot only, unless you set
  `tasks.showWhere`.
- **CI:** the kit's workflow has read-only permissions and, unless you set up the [shared build cache](ci.md#a-shared-build-cache),
  no secrets, and the guard fails a workflow that uses `pull_request_target`. A self-hosted runner (`factory ci`) runs branch code on your Mac with a privileged
  container: see [the known risk](ci.md#ci-githubs-runners-or-your-own-mac).

<br>

Previous: [CI and the build cache](ci.md) | Next: [Settings and style guides](settings.md)
