#!/usr/bin/env python3
"""Is a folder trusted by Claude Code? (#180, #193)

A folder Claude Code has not been told to trust makes it ignore the whole `permissions.allow` list ("Ignoring N
permissions.allow entries from .claude/settings.json: this workspace has not been trusted"), so an unattended run
stalls on the first command. The flag is `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json`; a folder also
counts as trusted when a folder above it is, or when it is a git worktree whose main working tree is trusted. This only reads that file, never writes it, and never prints what is in it.

  python3 .claude/hooks/factory_trust.py check [<path>]   exit 0 when trusted or unknown; exit 1 and a
                                                          {code, message, fix} line when the folder is not trusted
"""
import json, os, subprocess, sys


def config_path():
    return os.path.join(os.path.expanduser("~"), ".claude.json")


def main_tree(path):
    """The main working tree of the git worktree at `path`, or None when `path` is not a linked worktree (#246).
    Found with `git rev-parse --git-common-dir`: it is the .git folder of the main working tree."""
    def ask(*args):
        p = subprocess.run(["git", "-C", path, "rev-parse", *args], capture_output=True, text=True)
        return os.path.realpath(os.path.join(path, p.stdout.strip())) if p.returncode == 0 and p.stdout.strip() else None
    common, own = ask("--git-common-dir"), ask("--git-dir")
    if not common or not own or common == own or os.path.basename(common) != ".git":
        return None
    return os.path.dirname(common)


def walk_up(projects, path):
    here = os.path.realpath(path)
    while True:
        entry = projects.get(here)
        if isinstance(entry, dict) and entry.get("hasTrustDialogAccepted") is True:
            return True
        up = os.path.dirname(here)
        if up == here:
            return False
        here = up


def inherited_from(path):
    """The main working tree whose trust a git worktree at `path` inherits, or None (not a worktree, or that tree is not
    trusted itself). Claude Code writes no entry for a worktree of a trusted repository (#246)."""
    try:
        with open(config_path()) as f:
            projects = json.load(f).get("projects")
    except (OSError, ValueError, AttributeError):
        return None
    projects = projects if isinstance(projects, dict) else {}
    if walk_up(projects, path):
        return None  # trusted on its own account
    main = main_tree(path)
    return main if main and walk_up(projects, main) else None


def state(path):
    """"trusted", "untrusted", or "unknown" (no ~/.claude.json, or one that can't be read: nothing to judge by)."""
    try:
        with open(config_path()) as f:
            projects = json.load(f).get("projects")
    except (OSError, ValueError, AttributeError):
        return "unknown"
    projects = projects if isinstance(projects, dict) else {}
    if walk_up(projects, path):
        return "trusted"
    main = main_tree(path)  # a git worktree of a trusted main working tree is trusted too
    return "trusted" if main and walk_up(projects, main) else "untrusted"


def problem(path):
    """The plain error for an untrusted folder: {code, message, fix}."""
    return {"code": "folder_not_trusted",
            "message": f"Claude Code has not been told to trust {path}, so it ignores the allow list in .claude/settings.json "
                       "and an unattended run stops at its first command.",
            "fix": f"open it once yourself: `cd {path} && claude`, answer yes to the trust question, then start the loop again. "
                   "Only you can do this; the factory never sets the trust flag."}


def main(argv):
    if argv[:1] != ["check"]:
        sys.exit(__doc__)
    path = argv[1] if len(argv) > 1 else os.getcwd()
    if state(path) != "untrusted":
        return 0
    print(json.dumps(problem(os.path.realpath(path))))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
