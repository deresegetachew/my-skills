#!/usr/bin/env python3
"""`factory doctor`: check this machine and project for what the factory needs, and say how to fix each gap (#63).

Read-only: it runs version and status commands, never installs, logs in, decrypts or prints a secret. Each line is
`ok`, `fix` (the factory won't work until it's fixed, with the fix) or `note` (worth a look). Exit 1 when any `fix`.
Checks that don't apply to the project (Node without a package.json, sops without a .sops.yaml) are left out.

  python3 .claude/hooks/factory_doctor.py
"""
import json, os, re, shutil, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402

LINUX = sys.platform.startswith("linux")


class Report:
    def __init__(self):
        self.fixes = 0

    def ok(self, what):
        print(f"ok    {what}")

    def fix(self, what, how):
        self.fixes += 1
        print(f"fix   {what}: {how}")

    def note(self, what, how):
        print(f"note  {what}: {how}")


def run(*a, timeout=20):
    try:
        p = subprocess.run(a, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def version(text):
    m = re.search(r"(\d+)(?:\.(\d+))?", text or "")
    return (int(m.group(1)), int(m.group(2) or 0)) if m else None


def tools(r):
    if shutil.which("git"):
        r.ok("git")
    else:
        r.fix("git", "install git")
    r.ok(f"python {sys.version.split()[0]}") if sys.version_info >= (3, 8) else r.fix(
        "python", f"{sys.version.split()[0]} is too old; install Python 3.8 or newer")
    if not shutil.which("claude"):
        r.fix("Claude Code", "install it (`npm install -g @anthropic-ai/claude-code`), then run `claude` once to log in")
    else:
        r.ok("Claude Code " + (run("claude", "--version")[1].split() or ["(version unknown)"])[0])
    if not shutil.which("gh"):
        r.fix("GitHub CLI", "install gh (https://cli.github.com), then `gh auth login`")
    else:
        rc, out, err = run("gh", "auth", "status")
        if rc == 0:
            r.ok("gh is signed in")
        else:
            r.fix("GitHub CLI", "`gh auth status` fails: run `gh auth login` (or check GH_TOKEN)")


def node(r):
    if not os.path.exists("package.json"):
        return
    if not shutil.which("node"):
        r.fix("Node", "install Node" + (f" {open('.nvmrc').read().strip()} (see .nvmrc)" if os.path.exists(".nvmrc") else ""))
        return
    have = run("node", "--version")[1]
    if os.path.exists(".nvmrc"):
        want = open(".nvmrc").read().strip()
        w, h = version(want), version(have)
        if w and h and h[0] != w[0]:
            r.fix("Node", f"{have} here, {want} in .nvmrc: run `nvm install && nvm use` (or install Node {w[0]})")
        else:
            r.ok(f"Node {have}")
    else:
        r.ok(f"Node {have}")
    try:
        manager = json.load(open("package.json")).get("packageManager", "")
    except ValueError:
        manager = ""
    tool = manager.split("@")[0] if manager else ""
    if tool and not shutil.which(tool):
        r.fix(tool, f"package.json wants {manager}: run `corepack enable`")
    elif tool:
        rc, out, err = run(tool, "--version", timeout=60)
        if rc != 0:  # corepack may fail to fetch the wanted version
            r.fix(tool, f"`{tool} --version` fails ({(err or out).splitlines()[0][:120] if err or out else 'no output'}): "
                  f"run `corepack enable` and `corepack prepare {manager} --activate`")
        else:
            r.ok(f"{tool} {out.splitlines()[0] if out else ''}".strip())


def docker(r):
    if not any(os.path.exists(f) for f in ("compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml")):
        return
    if not shutil.which("docker"):
        r.fix("Docker", "the project has a compose file: install Docker" + (" (rootless Docker is safer)" if LINUX else ""))
        return
    rc, out, err = run("docker", "info", "--format", "{{json .SecurityOptions}}")
    if rc != 0:
        r.fix("Docker", "installed but not reachable: start Docker"
              + (" (rootless: `systemctl --user start docker`, and set DOCKER_HOST)" if LINUX else ""))
    else:
        r.ok("Docker is running" + (" (rootless)" if "rootless" in out else ""))


def project(r, cfg):
    rc, out, _ = run("git", "submodule", "status")
    if rc == 0 and out:
        bad = [l.split()[1] for l in out.splitlines() if l[:1] in "-+U" and len(l.split()) > 1]
        if bad:
            r.fix("submodules", f"{', '.join(bad)} not at the commit main pins: run `git submodule update --init`")
        else:
            r.ok("submodules")
    if os.path.exists(".claude/settings.json"):
        r.ok(".claude/settings.json")
    else:
        r.fix(".claude/settings.json", "it doesn't resolve, so the hooks and deny rules won't load: run "
              "`git submodule update --init`, or `bash vendor/my-skills/software-factory/install.sh . --link`")
    if os.path.exists(".env.example") and not os.path.exists(".env.local"):
        r.note(".env.local", "missing; copy .env.example to .env.local and fill it in")
    if os.path.exists(".sops.yaml"):
        key = os.environ.get("SOPS_AGE_KEY_FILE", "")
        if not shutil.which("sops"):
            r.fix("sops", "the project keeps secrets with sops: install sops and age")
        elif not key or not os.path.isfile(os.path.expanduser(key)):
            r.fix("SOPS_AGE_KEY_FILE", "set it to your age private key file, in your shell profile")
        else:
            r.ok("sops and its age key")
    install = cfg["commands"].get("install") or ""
    if "pnpm" in install and not os.path.isdir("node_modules"):
        r.note("node_modules", f"not installed yet: run `{install}`")


def factory(r, cfg):
    if shutil.which("factory"):
        r.ok("`factory` is on your PATH")
    else:
        r.note("`factory` command", "run `./factory install-shim` once, and add ~/.local/bin to PATH")
    names = cfg.get("agents") or []
    only = [n.strip() for n in os.environ.get("FACTORY_AGENTS", "").split(",") if n.strip()]
    unknown = [n for n in only if n not in names]
    if unknown:
        r.fix("FACTORY_AGENTS", f"{', '.join(unknown)} aren't in `agents` in .claude/factory.json ({', '.join(names)})")
    elif only:
        r.ok(f"this machine runs {', '.join(only)} (FACTORY_AGENTS)")
    else:
        r.note("FACTORY_AGENTS", "not set; fine on one machine. With several, give each its own names, for example "
               f"`export FACTORY_AGENTS={','.join(names[:2])}`")
    if sys.platform == "darwin":
        r.note("sleep", "keep the Mac awake while agents run (`caffeinate -d` in another tab)")


def main():
    if run("git", "rev-parse", "--show-toplevel")[0] != 0:
        print("factory doctor: run it inside the project's git repo.", file=sys.stderr)
        return 1
    os.chdir(run("git", "rev-parse", "--show-toplevel")[1])
    r = Report()
    tools(r)
    try:
        cfg = load()
    except (OSError, ValueError) as e:
        r.fix(".claude/factory.json", f"can't read it ({e})")
        cfg = None
    node(r)
    docker(r)
    if cfg:
        project(r, cfg)
        factory(r, cfg)
    print()
    print(f"{r.fixes} to fix." if r.fixes else "All the checks pass.")
    return 1 if r.fixes else 0


if __name__ == "__main__":
    sys.exit(main())
