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
    from factory_machine import machine_names
    only = machine_names()
    unknown = [n for n in only if n not in names]
    if unknown:
        r.fix("FACTORY_AGENTS / machine names file", f"{', '.join(unknown)} aren't in `agents` in .claude/factory.json ({', '.join(names)})")
    elif only:
        r.ok(f"this machine runs {', '.join(only)} (FACTORY_AGENTS or the machine names file)")
    else:
        r.note("FACTORY_AGENTS", "not set; fine on one machine. With several, give each its own names, for example "
               f"`export FACTORY_AGENTS={','.join(names[:2])}`")
    try:
        from factory_autostart import doctor as autostart_doctor
        for level, what, how in autostart_doctor(cfg):
            (r.ok(what + (f": {how}" if how else "")) if level == "ok" else r.fix(what, how) if level == "fix"
             else r.note(what, how))
    except (ImportError, SystemExit):
        pass
    if sys.platform == "darwin":
        r.note("sleep", "keep the Mac awake while agents run (`caffeinate -d` in another tab)")


def models(r, cfg):
    from factory_models import table, validate
    try:
        validate(cfg.get("models", {}))
    except ValueError as e:
        r.fix("models in .claude/factory.json", f"{e} Fix it with `factory settings set models '<json>'`")
        return
    for role, model, source in table(cfg.get("models", {})):
        r.ok(f"model for {role}: {model} ({source})")


def roles(r, cfg):
    """The role folders (#102): every path in a role's reads.md exists; the names don't clash with coding agents'."""
    try:
        import factory_roles as fr
        from factory_config import roles_dir, role_names
    except ImportError:
        return
    if not any(fr.role_dir(cfg, role) for role in fr.ROLE_DEFS):
        r.note("role folders", f"{roles_dir(cfg)}/ doesn't exist, so the roles read their `notes` instead: run "
               "`factory init-roles` to create it, then commit it")
    else:
        for role in fr.ROLE_DEFS:
            folder = fr.role_dir(cfg, role)
            if not folder:
                r.note(f"role folder for {role}", f"{roles_dir(cfg)}/{role}/ is missing: run `factory init-roles`")
                continue
            reads = os.path.join(folder, "reads.md")
            if not os.path.isfile(reads):
                r.fix(f"{reads}", "missing: run `factory init-roles`, or write one (a document per line, with a reason)")
                continue
            missing = fr.missing_reads(cfg, role) or []
            for path in missing:
                r.fix(f"{reads}: {path}", "does not exist: fix the path, or remove the line")
            if not missing:
                r.ok(f"{role} reads.md: every path exists")
    clash = sorted(set(role_names(cfg, "dev-manager") + role_names(cfg, "product-owner")) & set(cfg.get("agents") or []))
    if clash:
        r.fix("role names", f"{', '.join(clash)} is also a coding agent's name: change `roles.<role>.names`")


def manager(r, cfg):
    """The dev-manager orchestrator (#97): its settings profile resolves and every hook script the profile runs exists."""
    import re as _re
    path = str(((cfg.get("roles") or {}).get("dev-manager") or {}).get("profile") or ".claude/manager/settings.json")
    if not os.path.isfile(path):
        r.note("manager profile", f"{path} doesn't exist, so sub-managers use the project's settings (which deny `gh api`): "
               "run `factory update`, or set `roles.dev-manager.profile`")
        return
    try:
        profile = json.load(open(path))
    except (OSError, ValueError) as e:
        r.fix(path, f"isn't valid JSON ({e})")
        return
    missing = []
    for group in (profile.get("hooks") or {}).values():
        for entry in group:
            for h in entry.get("hooks", []):
                for token in _re.findall(r"[\w./$\"-]+\.py", h.get("command", "")):
                    script = token.replace('"', "").replace("$CLAUDE_PROJECT_DIR/", "")
                    if "$" not in script and not os.path.exists(script):
                        missing.append(script)
    for script in sorted(set(missing)):
        r.fix(f"{path}: {script}", "the hook script is missing: run `factory update`")
    if not missing:
        r.ok("manager profile: it resolves and its hooks exist")


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
        models(r, cfg)
        roles(r, cfg)
        manager(r, cfg)
    print()
    print(f"{r.fixes} to fix." if r.fixes else "All the checks pass.")
    return 1 if r.fixes else 0


if __name__ == "__main__":
    sys.exit(main())
