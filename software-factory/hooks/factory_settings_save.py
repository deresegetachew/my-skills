#!/usr/bin/env python3
"""Proposing a change of .claude/factory.json as a pull request (#49): `factory settings pr`, and the "branch and
pull request" choice when the interactive menu saves.

`.claude/` is protected, so project settings never go to main by hand. This makes a branch `settings/<short-name>`
from the main branch, commits only .claude/factory.json, pushes it and opens the PR (draft by default) with a body
that lists each change and the review it needs. The person's checkout goes back to the main branch afterwards.
"""
import json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_settings_schema import MISSING, NEEDS, DEFAULT_REVIEW, SETTINGS, as_text  # noqa: E402
from factory_settings_store import PATH, changes, fail, read_project, refuse_in_agent_session  # noqa: E402


def git(*args, check=True):
    p = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and p.returncode:
        fail(f"git {' '.join(args)} failed: {(p.stderr or p.stdout).strip()}")
    return p


def committed():
    """.claude/factory.json as the current commit has it ({} when it has none)."""
    p = git("show", f"HEAD:{PATH}", check=False)
    if p.returncode:
        return {}
    try:
        return json.loads(p.stdout)
    except ValueError:
        return {}


def shown(value):
    return "(default)" if value is MISSING else as_text(value)


def reviews_needed(diffs):
    out = []
    for key, _, _ in diffs:
        if key in NEEDS:
            out.append(f"`{key}`: {NEEDS[key]}")
    return out


def branch_name(diffs):
    words = re.sub(r"[^a-z0-9]+", "-", "-".join(k for k, _, _ in diffs[:3]).lower()).strip("-")[:40].strip("-")
    base = f"settings/{words or 'update'}"
    name, n = base, 1
    while git("rev-parse", "--verify", "-q", name, check=False).returncode == 0:
        n += 1
        name = f"{base}-{n}"
    return name


def title(diffs):
    keys = [k for k, _, _ in diffs]
    return "Factory settings: " + (", ".join(keys) if len(keys) <= 3 else f"{', '.join(keys[:3])} and {len(keys) - 3} more")


def body(diffs):
    lines = [f"Changes to `{PATH}`, made with `factory settings`:", ""]
    for key, old, new in diffs:
        lines.append(f"- `{key}`: {shown(old)} -> {shown(new)}")
    needs = reviews_needed(diffs)
    lines += ["", "Review needed:"]
    lines += [f"- {n}" for n in needs] or ["- no extra label"]
    lines += [f"- {DEFAULT_REVIEW}", "", "The settings are read by the PR gate and the hooks, so this is merged by the dev "
              "manager or the owner, never by an agent."]
    return "\n".join(lines)


def open_pr(draft=True, main=None):
    """Branch, commit, push and open the PR. Prints the PR's URL. Stops with a message that says how to go on."""
    refuse_in_agent_session()
    data, _ = read_project()
    main = main or data.get("mainBranch") or "main"
    current = git("branch", "--show-current").stdout.strip()
    if current != main:
        fail(f"you are on `{current or 'a detached HEAD'}`, not on `{main}`. Run `git checkout {main}` first, so the pull "
             "request carries only this settings change.")
    diffs = changes(committed(), data)
    if not diffs:
        fail(f"nothing to propose: {PATH} is the same as in the last commit. Change a setting first.")
    branch = branch_name(diffs)
    git("checkout", "-q", "-b", branch)
    ok = False
    try:
        git("add", PATH)
        git("commit", "-q", "-m", title(diffs) + "\n\n" + body(diffs), "--", PATH)
        p = git("push", "-q", "-u", "origin", branch, check=False)
        if p.returncode:
            fail(f"the commit is on branch {branch}, but the push failed: {p.stderr.strip()}\n"
                 f"Fix the remote, then run: git push -u origin {branch} && gh pr create --base {main} --head {branch}")
        cmd = ["gh", "pr", "create", "--base", main, "--head", branch, "--title", title(diffs), "--body", body(diffs)]
        if draft:
            cmd.append("--draft")
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode:
            fail(f"the branch {branch} is pushed, but `gh pr create` failed: {p.stderr.strip()}\n"
                 f"Open the pull request by hand from {branch} into {main}.")
        ok = True
        print(p.stdout.strip() or f"Pull request opened from {branch}.")
        print("It is " + ("a draft; mark it ready when you want it reviewed." if draft else "ready for review."))
    finally:
        git("checkout", "-q", main, check=False)  # the person's checkout goes back to main, whatever happened
        if ok:
            print(f"You are back on {main}; {PATH} here is as main has it until the pull request merges.")
