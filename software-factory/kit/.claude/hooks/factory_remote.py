#!/usr/bin/env python3
"""Keeps the git remotes pointing at where the repository lives now.

When a repository is moved or renamed on GitHub, the old address still works for reading (GitHub redirects it),
but writes through the API answer `307` and fail. An agent then sees red errors on its own checkout and may
decide the repository has moved somewhere it hasn't. The loop runs this at start and between tasks: it asks
GitHub for each remote's current name and, when it differs, points the remote at it and says so in one line.
Remotes are shared by every worktree of the repository, so one fix covers all the agents on the machine.

  python3 .claude/hooks/factory_remote.py          check and fix; prints one line per remote it changed
  python3 .claude/hooks/factory_remote.py --check  only say what it would change (exit 1 if anything)
"""
import re, subprocess, sys

GITHUB = re.compile(r"^(?P<pre>(?:https?://|ssh://)?(?:[^@/]+@)?github\.com[:/])(?P<owner>[\w.-]+)/(?P<repo>[\w.-]+?)"
                    r"(?P<post>\.git)?/?$")


def run(*a):
    p = subprocess.run(a, capture_output=True, text=True)
    return p.returncode, p.stdout.strip()


def current_name(owner, repo):
    """The repository's full name as GitHub has it now (GET follows a move or a rename), or None when unknown."""
    rc, out = run("gh", "api", f"repos/{owner}/{repo}", "--jq", ".full_name")
    return out if rc == 0 and re.fullmatch(r"[\w.-]+/[\w.-]+", out or "") else None


def fixes():
    """[(remote, old url, new url)] for the GitHub remotes whose repository now has another name."""
    rc, out = run("git", "remote")
    out_list = []
    for remote in out.split() if rc == 0 else []:
        rc, url = run("git", "config", "--get", f"remote.{remote}.url")  # as written, before insteadOf
        m = GITHUB.match(url) if rc == 0 else None
        if not m:
            continue
        now = current_name(m["owner"], m["repo"])
        if now and now.lower() != f"{m['owner']}/{m['repo']}".lower():
            out_list.append((remote, url, f"{m['pre']}{now}{m['post'] or ''}"))
    return out_list


def main():
    check = "--check" in sys.argv[1:]
    found = fixes()
    for remote, old, new in found:
        if check:
            print(f"{remote} points at {old}, but the repository is now {new}.")
        elif run("git", "remote", "set-url", remote, new)[0] == 0:
            print(f"The repository moved on GitHub: {remote} now points at {new} (was {old}).")
    sys.exit(1 if check and found else 0)


if __name__ == "__main__":
    main()
