#!/usr/bin/env python3
"""Numbered files (decisions, migrations): a new one takes a number neither main nor another open PR has.

Agents number decisions and migrations from main when they open a PR, so two PRs opened close together pick the
same number, and the dev manager renumbered one PR after another. The PR gate now checks this when a PR is
created or marked ready, and names the next free number.

The folders: `decisions` in .claude/factory.json, plus `numberedDirs` (for example ["apps/api/migrations"]).
A numbered file's name starts with its number and a dash or underscore: 0042-demo-guides.md, 0009_spare_parts.sql.

  python3 .claude/hooks/factory_numbers.py            what this branch adds, and any clash (exit 1 on a clash)
"""
import json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

NUMBERED = re.compile(r"^(\d{3,6})[-_]")


def run(*a):
    p = subprocess.run(a, capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def folders(cfg):
    dirs = [cfg.get("decisions") or "docs/decisions"] + list(cfg.get("numberedDirs") or [])
    return [d.rstrip("/") for d in dict.fromkeys(dirs) if d]


def number(path):
    m = NUMBERED.match(os.path.basename(path))
    return (int(m.group(1)), len(m.group(1))) if m else None


def in_folder(path, folder):
    return os.path.dirname(path) == folder


def on_main(cfg, folder):
    rc, out, _ = run("git", "ls-tree", "--name-only", f"origin/{cfg['mainBranch']}:{folder}")
    return {} if rc != 0 else {n[0]: f"{folder}/{f}" for f in out.splitlines() for n in [number(f)] if n}


def fetch_main(cfg):
    """Main as it is now: a number another PR took and merged while this branch was built must count."""
    rc, _, err = run("git", "fetch", "-q", "origin", cfg["mainBranch"])
    if rc != 0:
        raise RuntimeError(f"could not fetch origin/{cfg['mainBranch']}: {err[:200]}")


def added_here(cfg):
    """[(path, renamed from or None)] for the files this branch adds or renames."""
    rc, out, err = run("git", "diff", "--name-status", "-M", "--diff-filter=AR", f"origin/{cfg['mainBranch']}...HEAD")
    if rc != 0:
        raise RuntimeError(f"could not list this branch's new files against origin/{cfg['mainBranch']}: {err[:200]}")
    found = []
    for line in out.splitlines():
        parts = line.split("\t")
        found.append((parts[2], parts[1]) if parts[0].startswith("R") and len(parts) == 3 else (parts[-1], None))
    return found


def keeps_its_number(path, previous):
    """A rename in the same folder that keeps its number (a new title) takes no new number."""
    return bool(previous) and os.path.dirname(previous) == os.path.dirname(path) \
        and number(previous) is not None and number(path) is not None and number(previous)[0] == number(path)[0]


def open_prs_added(skip_branch):
    """{pr number: [(path, renamed from or None)]} for the open PRs other than this branch's."""
    rc, out, err = run("gh", "api", "--paginate", "repos/{owner}/{repo}/pulls?state=open&per_page=100",
                       "--jq", '.[] | "\\(.number)\\t\\(.head.ref)"')
    if rc != 0:
        raise RuntimeError(f"could not list the open pull requests: {err[:200]}")
    found = {}
    for line in out.splitlines():
        n, _, ref = line.partition("\t")
        if not n or ref == skip_branch:
            continue
        found[int(n)] = pr_added(n)
    return found


def clashes(cfg, branch, mine=None):
    """Plain sentences, one per clash, each naming the next free number; [] when every new number is free.
    `mine`: [(path, renamed from or None)], or this checkout's branch when None."""
    fetch_main(cfg)
    mine = added_here(cfg) if mine is None else mine
    mine = [p for p, prev in mine if not keeps_its_number(p, prev)]
    folder_list = [f for f in folders(cfg) if any(in_folder(p, f) for p in mine)]
    if not folder_list:
        return []
    others = open_prs_added(branch)
    out = []
    for folder in folder_list:
        taken = {n: f"{p} on main" for n, p in on_main(cfg, folder).items()}
        for pr, files in sorted(others.items()):
            for p, _ in files:
                if in_folder(p, folder) and number(p):
                    taken.setdefault(number(p)[0], f"{p} in #{pr}")
        new = sorted((number(p), p) for p in mine if in_folder(p, folder) and number(p))
        used = set(taken) | {n for (n, _), _ in new}
        nxt = max(used) + 1 if used else 1
        own = {}
        for (n, width), p in new:
            by = taken.get(n) or (f"{own[n]} in this branch" if n in own else None)
            if by:
                out.append(f"{p} uses number {n:0{width}d}, which {by} already has. Rename it to "
                           f"{nxt:0{width}d}, with its heading and every link to it.")
                nxt += 1
            else:
                own[n] = p
    return out


def pr_added(number_):
    """[(path, renamed from or None)] for the files a PR adds or renames, from GitHub (for `gh pr ready`, where the
    checkout may be another branch)."""
    rc, out, err = run("gh", "api", "--paginate", f"repos/{{owner}}/{{repo}}/pulls/{number_}/files", "--jq",
                       '.[] | select(.status == "added" or .status == "renamed") | "\\(.filename)\\t\\(.previous_filename // "")"')
    if rc != 0:
        raise RuntimeError(f"could not list the files of #{number_}: {err[:200]}")
    return [(p, prev or None) for line in out.splitlines() if line for p, _, prev in [line.partition("\t")]]


def main():
    from factory_config import load
    cfg = load()
    branch = run("git", "branch", "--show-current")[1]
    found = clashes(cfg, branch)
    print("\n".join(found) if found else "Every new decision and migration number is free.")
    sys.exit(1 if found else 0)


if __name__ == "__main__":
    main()
