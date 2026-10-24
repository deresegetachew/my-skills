#!/usr/bin/env python3
"""The MCP config a factory session starts with (#55): the project's `.mcp.json` as the main branch has it on the
remote, never this worktree's copy.

`claude --mcp-config <file>` starts the stdio servers in that file without asking, so the file must be one an agent
can't change: an uncommitted, untracked or branch-only `.mcp.json` is never used. This fetches the main branch
(`mainBranch` in .claude/factory.json) from origin, writes its `.mcp.json` to this worktree's git folder
(`.git/factory-mcp.json`, out of the working tree) and prints that path. When main has none, or the fetch fails,
it prints the empty config `{"mcpServers":{}}`, so nothing starts. `.mcp.json` is protected, so a change to it
needs a person to merge.

  python3 .claude/hooks/factory_mcp.py      prints the value for `--mcp-config`
"""
import json, os, re, subprocess, sys

EMPTY = '{"mcpServers":{}}'


def git(*a, text=True):
    return subprocess.run(["git", *a], capture_output=True, text=text, timeout=60)


def main_branch():
    try:
        with open(os.path.join(".claude", "factory.json")) as f:
            name = json.load(f).get("mainBranch") or "main"
    except (OSError, ValueError):
        name = "main"
    return name if re.fullmatch(r"[\w./-]+", name) and not name.startswith("-") else "main"


def main():
    try:
        # FETCH_HEAD, straight from the remote: a local ref named origin/<main> can't stand in for it.
        if git("fetch", "-q", "origin", f"refs/heads/{main_branch()}").returncode != 0:
            print(EMPTY)
            return 0
        shown = git("show", "FETCH_HEAD:.mcp.json", text=False)
        if shown.returncode != 0:
            print(EMPTY)  # main has no .mcp.json
            return 0
        json.loads(shown.stdout)  # a broken file on main: start without servers rather than fail
        path = os.path.abspath(git("rev-parse", "--git-path", "factory-mcp.json").stdout.strip())
        with open(path, "wb") as f:
            f.write(shown.stdout)
        print(path)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print(EMPTY)
    return 0


if __name__ == "__main__":
    sys.exit(main())
