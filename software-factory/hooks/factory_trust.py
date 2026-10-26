#!/usr/bin/env python3
"""Is a folder trusted by Claude Code? (#180, #193)

A folder Claude Code has not been told to trust makes it ignore the whole `permissions.allow` list ("Ignoring N
permissions.allow entries from .claude/settings.json: this workspace has not been trusted"), so an unattended run
stalls on the first command. The flag is `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json`; a folder also
counts as trusted when a folder above it is. This only reads that file, never writes it, and never prints what is in it.

  python3 .claude/hooks/factory_trust.py check [<path>]   exit 0 when trusted or unknown; exit 1 and a
                                                          {code, message, fix} line when the folder is not trusted
"""
import json, os, sys


def config_path():
    return os.path.join(os.path.expanduser("~"), ".claude.json")


def state(path):
    """"trusted", "untrusted", or "unknown" (no ~/.claude.json, or one that can't be read: nothing to judge by)."""
    try:
        with open(config_path()) as f:
            projects = json.load(f).get("projects")
    except (OSError, ValueError, AttributeError):
        return "unknown"
    projects = projects if isinstance(projects, dict) else {}
    here = os.path.realpath(path)
    while True:
        entry = projects.get(here)
        if isinstance(entry, dict) and entry.get("hasTrustDialogAccepted") is True:
            return "trusted"
        up = os.path.dirname(here)
        if up == here:
            return "untrusted"
        here = up


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
