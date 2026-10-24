#!/usr/bin/env python3
"""The names a project's self-hosted CI runner uses, as shell assignments for `factory ci` (ci.sh).

Every name comes from the project, so two projects can run their runners side by side on one Mac:

  CI_REPO      owner/name on GitHub                  "ci.repo" in .claude/factory.json, else `gh repo view`,
                                                     else the origin remote
  CI_NAME      the runner's name                     "ci.name", else "<repo name>-ci"         (remanual-ci)
  CI_LABEL     the label jobs ask for                "ci.label", else "<repo name>-local"     (remanual-local)
  CI_AGENT     the LaunchAgent's label               dev.software-factory.<name>
  CI_PLIST     ~/Library/LaunchAgents/<agent>.plist
  CI_INSTALLED ~/Library/Application Support/<name>  the private copy launchd runs (never the checkout)
  CI_STATE     ~/.local/state/<name>                 the log and the pid of a loop started by hand
  CI_REPLACES  "ci.replaces": LaunchAgent labels of an older install to unload first
  CI_RUNNERS   "ci.runners": heavy runner loops on this machine (default 1); FACTORY_CI_RUNNERS overrides it here
  CI_LIGHT     1 unless "ci.light" is false: one more, small loop without Docker for light jobs
  CI_LIGHT_LABEL "ci.lightLabel", else "<repo name>-light"                                  (remanual-light)
  CI_IMAGE     "ci.image": "build" (default: build runner.Dockerfile with the project's Node, pnpm and Playwright)
               or "base" (GitHub's plain runner image)
  CI_CACHES    1 unless "ci.caches" is false: the Docker Hub mirror and the pnpm store outlive a job
On Linux (FACTORY_CI_PLATFORM=linux, set by ci.sh) a systemd --user service runs it instead of launchd:
  CI_UNIT      <name>.service
  CI_UNIT_FILE ~/.config/systemd/user/<name>.service  ($XDG_CONFIG_HOME)
  CI_INSTALLED ~/.local/share/<name>                   ($XDG_DATA_HOME), the private copy systemd runs

  python3 ci_names.py            prints them as `NAME=value` lines, quoted for `eval` in bash
"""
import json, os, re, shlex, subprocess, sys

SAFE = re.compile(r"[a-z0-9][a-z0-9._-]{0,47}")
REPO = re.compile(r"[\w.-]+/[\w.-]+")


def run(*a):
    try:
        p = subprocess.run(a, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""
    return p.returncode, p.stdout.strip()


def config():
    try:
        with open(os.path.join(".claude", "factory.json")) as f:
            return json.load(f).get("ci") or {}
    except FileNotFoundError:
        return {}


def repo_from_remote():
    rc, url = run("git", "config", "--get", "remote.origin.url")
    m = re.search(r"github\.com[:/]([\w.-]+/[\w.-]+?)(?:\.git)?/?$", url) if rc == 0 else None
    return m.group(1) if m else None


def names(cfg):
    repo = cfg.get("repo")
    if not repo:
        rc, out = run("gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")
        repo = out if rc == 0 and REPO.fullmatch(out) else repo_from_remote()
    if not repo or not REPO.fullmatch(repo):
        raise SystemExit("factory ci: can't tell this project's GitHub repository. Set \"ci\": {\"repo\": "
                         "\"owner/name\"} in .claude/factory.json, or log in with `gh auth login`.")
    base = repo.split("/")[1].lower()
    name = cfg.get("name") or f"{base}-ci"
    label = cfg.get("label") or f"{base}-local"
    light_label = cfg.get("lightLabel") or f"{base}-light"
    raw = os.environ.get("FACTORY_CI_RUNNERS") or cfg.get("runners", 1)
    try:
        runners = int(raw)
    except (TypeError, ValueError):
        raise SystemExit(f"factory ci: ci.runners (or FACTORY_CI_RUNNERS) must be a whole number, not {raw!r}.")
    if not 1 <= runners <= 16:
        raise SystemExit(f"factory ci: ci.runners is {runners}; use 1 to 16.")
    if light_label == label:
        raise SystemExit(f"factory ci: ci.lightLabel must differ from ci.label ({label!r}): with one label, light jobs "
                         "would wait behind heavy ones again.")
    light = cfg.get("light", True) is not False
    image = cfg.get("image") or "build"
    if image not in ("build", "base"):
        raise SystemExit(f"factory ci: ci.image is {image!r}; use \"build\" or \"base\".")
    caches = cfg.get("caches", True) is not False
    for what, value in (("name", name), ("label", label), ("lightLabel", light_label)):
        if not SAFE.fullmatch(value):
            raise SystemExit(f"factory ci: the {what} {value!r} must be lowercase letters, digits, dots, dashes or "
                             "underscores (up to 48), starting with a letter or digit.")
    # LaunchAgents of an older install under other names (a project's own runner from before `factory ci`):
    # `factory ci install` unloads them first, so two loops never compete for the same jobs.
    replaces = [a for a in (cfg.get("replaces") or []) if isinstance(a, str)]
    for a in replaces:
        if not re.fullmatch(r"[\w.-]{1,128}", a):
            raise SystemExit(f"factory ci: {a!r} in ci.replaces isn't a LaunchAgent label.")
    home = os.path.expanduser("~")
    state_home = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")
    agent = f"dev.software-factory.{name}"
    linux = os.environ.get("FACTORY_CI_PLATFORM") == "linux"
    config_home = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    data_home = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    return {
        "CI_REPO": repo,
        "CI_NAME": name,
        "CI_LABEL": label,
        "CI_AGENT": agent,
        "CI_PLIST": os.path.join(home, "Library", "LaunchAgents", f"{agent}.plist"),
        "CI_INSTALLED": os.path.join(data_home, name) if linux else os.path.join(home, "Library", "Application Support", name),
        "CI_UNIT": f"{name}.service",
        "CI_UNIT_FILE": os.path.join(config_home, "systemd", "user", f"{name}.service"),
        "CI_STATE": os.path.join(state_home, name),
        "CI_REPLACES": " ".join(replaces),
        "CI_RUNNERS": str(runners),
        "CI_LIGHT": "1" if light else "0",
        "CI_LIGHT_LABEL": light_label,
        "CI_IMAGE": image,
        "CI_CACHES": "1" if caches else "0",
    }


def main():
    for k, v in names(config()).items():
        print(f"{k}={shlex.quote(v)}")


if __name__ == "__main__":
    sys.exit(main())
