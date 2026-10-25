#!/usr/bin/env python3
"""The project part of `factory bootstrap` (#105): what the dedicated user sets up for itself, no root needed.

Rootless Docker, the shell profile, the secrets folder, Node (nvm, corepack), Claude Code, the checkout with its
submodules, `.env.local`, the install and the dev stack, the `factory` shim, the machine's agent names, and, once
the person has done the three human steps, the CI runners and autostart. The human steps are never done here:
`gh auth login`, the Claude login and copying the age key. `human_steps()` says which are still open, from the
state only: it never reads, prints or stores a token or a key.
"""
import json, os, shutil

from factory_bootstrap_core import BootstrapError, Call, Mkdir, Run, Step, Write, probe

PROFILE_MARK = "# --- software factory"
NVM_URL = "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh"
CLAUDE_URL = "https://claude.ai/install.sh"
SETUPTOOL_DIRS = ["/usr/bin", "/usr/local/bin", "/usr/share/docker.io/contrib", "/opt/docker/bin"]


def home():
    return os.path.expanduser("~")


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def profile_block():
    return (f"\n{PROFILE_MARK}\n"
            'export XDG_RUNTIME_DIR=/run/user/$(id -u)\n'
            'export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock\n'
            'export SOPS_AGE_KEY_FILE=~/.secrets/sops/age/keys.txt\n'
            'export PATH="$HOME/.local/bin:$PATH"\n')


def find_setuptool():
    found = shutil.which("dockerd-rootless-setuptool.sh")
    if found:
        return found
    for d in SETUPTOOL_DIRS:
        p = os.path.join(d, "dockerd-rootless-setuptool.sh")
        if os.path.exists(p):
            return p
    return ""


def docker_rootless_ok():
    rc, out, _ = probe(["docker", "info", "--format", "{{json .SecurityOptions}}"])
    return rc == 0 and "rootless" in out


def node_major(project):
    for f in (os.path.join(project, ".nvmrc"),):
        m = read(f).strip().lstrip("v").split(".")[0]
        if m.isdigit():
            return m
    return "24"


def runtime_dir():
    return os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"


def fetch_and_run(url, label, args=()):
    """Downloads an installer to a private file and runs it with bash (never `curl | bash`), so a failed download is
    an error, not a half-run script."""
    def go():
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "install.sh")
            p = subprocess.run(["curl", "-fsSL", "-o", path, url], capture_output=True, text=True)
            if p.returncode != 0:
                raise BootstrapError("download", f"Could not download the {label} installer ({url}).",
                                     "Check the internet (and that the network guard lets this user out), then run it again.")
            q = subprocess.run(["bash", path, *args], capture_output=True, text=True)
            if q.returncode != 0:
                raise BootstrapError("installer", f"The {label} installer failed: {(q.stderr or q.stdout).strip()[-160:]}",
                                     "Run it by hand to see why, then run `factory bootstrap project` again.")
    return Call(go, f"install {label}")


def human_steps(project):
    """[(title, command, done)] for what only the person can do. `done` is a check of state, not of contents."""
    key = os.environ.get("SOPS_AGE_KEY_FILE") or os.path.join(home(), ".secrets", "sops", "age", "keys.txt")
    key = os.path.expanduser(key)
    steps = [("Sign in to GitHub", "gh auth login", probe(["gh", "auth", "status"])[0] == 0),
             ("Sign in to Claude Code (accept the folder-trust prompt for the project)", "claude",
              os.path.exists(os.path.join(home(), ".claude", ".credentials.json"))
              or os.path.exists(os.path.join(home(), ".claude.json")))]
    if project and os.path.exists(os.path.join(project, ".sops.yaml")):
        sdir = os.path.join(project, "secrets")
        files = sorted(f for f in os.listdir(sdir) if f.endswith((".yaml", ".yml"))) if os.path.isdir(sdir) else []
        enc = os.path.join(sdir, files[0]) if files else ""
        ok = os.path.isfile(key) and (not enc or probe(["sops", "-d", enc], env={"SOPS_AGE_KEY_FILE": key})[0] == 0)
        steps.append((f"Copy the age key to {key} (mode 600)", f"install -m 600 /path/to/keys.txt {key}", ok))
    return steps


def steps(opts, project, cfg):
    """The steps that need no human. `project` is the checkout's folder ('' when there is none yet)."""
    out = []
    h = home()
    out.append(Step("rootless-docker", "Set up rootless Docker for this user",
                    [Run([find_setuptool() or "dockerd-rootless-setuptool.sh", "install"],
                         env={"XDG_RUNTIME_DIR": runtime_dir()}),
                     Run(["systemctl", "--user", "enable", "--now", "docker"], env={"XDG_RUNTIME_DIR": runtime_dir()})],
                    done=docker_rootless_ok,
                    manual="" if find_setuptool() else
                    "dockerd-rootless-setuptool.sh was not found: install Docker Engine's rootless extras "
                    "(docker-ce-rootless-extras, https://docs.docker.com/engine/security/rootless/), then run this again."))
    rc = os.path.join(h, ".bashrc")
    out.append(Step("profile", "Add DOCKER_HOST, SOPS_AGE_KEY_FILE and PATH to ~/.bashrc",
                    [Call(lambda: open(rc, "a").write(profile_block()), "append the profile block")],
                    done=lambda: PROFILE_MARK in read(rc)))
    sec = os.path.join(h, ".secrets")
    dirs = [sec, os.path.join(sec, "sops"), os.path.join(sec, "sops", "age")]
    out.append(Step("secrets-dir", "Make ~/.secrets (mode 700), empty: you copy the age key in yourself",
                    [Mkdir(d, 0o700) for d in dirs],
                    done=lambda: all(os.path.isdir(d) and (os.stat(d).st_mode & 0o777) == 0o700 for d in dirs)))
    want = node_major(project)
    nvm_dir = os.path.join(h, ".nvm")

    def node_ok():
        rc_, o, _ = probe(["node", "--version"])
        return rc_ == 0 and o.strip().lstrip("v").split(".")[0] == want
    out.append(Step("node", f"Install Node {want} with nvm, and enable corepack",
                    ([] if os.path.exists(os.path.join(nvm_dir, "nvm.sh")) else [fetch_and_run(NVM_URL, "nvm")])
                    + [Run(["bash", "-c", f'. "$HOME/.nvm/nvm.sh" && nvm install {want} && nvm alias default {want} && corepack enable'])],
                    done=node_ok))
    out.append(Step("claude", "Install Claude Code (the official installer)", [fetch_and_run(CLAUDE_URL, "Claude Code")],
                    done=lambda: shutil.which("claude") is not None or os.path.exists(os.path.join(h, ".local", "bin", "claude"))))
    if not project:
        repo = opts.get("repo")
        if not repo:
            raise BootstrapError("no-project", "There is no project checkout here and no --repo was given.",
                                 "Run it inside the project's checkout, or give --repo <url> [--dir <folder>].")
        target = opts.get("dir") or os.path.join(h, os.path.basename(repo.rstrip("/")).removesuffix(".git"))
        out.append(Step("clone", f"Clone {repo} with its submodules into {target}",
                        [Run(["git", "clone", "--recurse-submodules", repo, target])], done=lambda: os.path.isdir(target)))
        return out + [Step("next", "Run `factory bootstrap project` again from inside the checkout", [], done=lambda: False,
                           manual=f"cd {target} && ./factory bootstrap project")]
    out.append(Step("submodules", "Check out the submodules", [Run(["git", "submodule", "update", "--init"])],
                    done=lambda: not any(l[:1] in "-+U" for l in probe(["git", "submodule", "status"])[1].splitlines())))
    env_example, env_local = os.path.join(project, ".env.example"), os.path.join(project, ".env.local")
    if os.path.exists(env_example):
        out.append(Step("env-local", "Copy .env.example to .env.local (fill it in yourself)",
                        [Call(lambda: (shutil.copyfile(env_example, env_local), os.chmod(env_local, 0o600)), "copy")],
                        done=lambda: os.path.exists(env_local)))
    install = (cfg.get("commands") or {}).get("install") or ""
    if install and not (os.path.isdir(os.path.join(project, "node_modules"))):
        out.append(Step("install", f"Install the project's dependencies (`{install}`)", [Run(["bash", "-c", install])],
                        done=lambda: os.path.isdir(os.path.join(project, "node_modules")), trust=True))
    out.append(Step("shim", "Put `factory` on PATH (factory install-shim)", [Run(["./factory", "install-shim"])],
                    done=lambda: os.path.exists(os.path.join(h, ".local", "bin", "factory"))))
    if opts.get("agents"):
        out.append(Step("agent-names", f"Set this machine's agent names to {','.join(opts['agents'])}",
                        [Run(["./factory", "machine", "setup", ",".join(opts["agents"])])],
                        done=lambda: all(a in probe(["./factory", "machine", "show"])[1] for a in opts["agents"])))
    return out


def ci_units_installed():
    from factory_machine import repo_key
    rc, out, _ = probe(["systemctl", "--user", "list-unit-files", "--no-legend", f"{repo_key()}-ci*.service"])
    return rc == 0 and f"{repo_key()}-ci" in out


def after_human(opts, project, cfg):
    """Steps that need GitHub, so they come after the human steps: the dev stack, the CI runners, autostart."""
    out = []
    stack = (cfg.get("commands") or {}).get("stackUp") or ""
    if stack:
        out.append(Step("stack", f"Start the dev stack (`{stack}`)", [Run(["bash", "-c", stack])],
                        done=lambda: probe(["bash", "-c", (cfg.get("commands") or {}).get("stackHealth") or "false"])[0] == 0))
    env = {"FACTORY_CI_RUNNERS": str(opts["runners"])} if opts.get("runners") is not None else {}
    out.append(Step("ci", "Install the CI runners as user services (factory ci install)",
                    [Run(["./factory", "ci", "install"], env=env)],
                    done=ci_units_installed))
    if opts.get("agents"):
        out.append(Step("autostart", "Bring the stack and agents back after a reboot (factory autostart install)",
                        [Run(["./factory", "autostart", "install", "--agents", ",".join(opts["agents"])])],
                        done=lambda: "autostart: on" in probe(["./factory", "autostart", "status"])[1]))
    return out
