#!/usr/bin/env python3
"""PreToolUse hook on Bash: gate `gh pr create` and `gh pr merge` for the coding agent.

create: needs a reviewer pass for the current commit (<reviewMarkers>/<branch>.ok holding HEAD),
        except draft PRs (`--draft`), which are for questions and early feedback.
        When the diff touches a path in `styles`, it also needs the architecture-reviewer's pass
        (<reviewMarkers>/<branch>.arch.ok holding HEAD).
merge:  needs those passes for the PR's head commit, green CI, and no protected paths changed
        (`protected` in .claude/factory.json; `alwaysAllowed` files such as the build plan are fine).
        Protected changes are left for the dev manager or a person to merge.
Exit 2 blocks the command and tells Claude why.
"""
import json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(__file__))
from factory_config import blocked_ids, branch_task, load, styled, tasks  # noqa: E402


def run(*a):
    p = subprocess.run(a, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


def block(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command", "")
if not re.search(r"\bgh\s+pr\s+(create|merge)\b", cmd):
    sys.exit(0)
cfg = load()
mark = lambda b: os.path.join(cfg["reviewMarkers"], b.replace("/", "_") + ".ok")
passed = lambda b, sha: os.path.exists(mark(b)) and open(mark(b)).read().strip() == sha
arch_mark = lambda b: os.path.join(cfg["reviewMarkers"], b.replace("/", "_") + ".arch.ok")
arch_passed = lambda b, sha: os.path.exists(arch_mark(b)) and open(arch_mark(b)).read().strip() == sha
ARCH_MSG = ("This change touches code with a style guide ({skills}), and the architecture-reviewer hasn't passed "
            "this commit. Ask the architecture-reviewer subagent, fix every must-fix, then try again.")

# Draft PRs are how the coding agent talks to the dev manager (questions, blocked work, early feedback).
# They can't be merged, and merging stays fully gated below, so they skip the reviewer check.
is_draft = re.search(r"(^|\s)(--draft|-d)(\s|$)", cmd) is not None
if re.search(r"\bgh\s+pr\s+create\b", cmd) and not is_draft:
    _, branch = run("git", "branch", "--show-current")
    _, head = run("git", "rev-parse", "HEAD")
    if not passed(branch, head):
        block("No reviewer pass for this commit. Ask the reviewer subagent to review the diff, fix any "
              "must-fix items, then open the pull request.")
    changed = run("git", "diff", "--name-only", f"origin/{cfg['mainBranch']}...HEAD")[1].split()
    styles = styled(changed, cfg)
    if styles and not arch_passed(branch, head):
        block(ARCH_MSG.format(skills=", ".join(sorted({s for st in styles for s in st.get("skills", [])}))))
    tid = branch_task(branch)
    if tid:
        main = cfg["mainBranch"]
        plan = run("git", "show", f"origin/{main}:{cfg['plan']}")[1]
        done = {i for i, d, _ in tasks(plan) if d}
        blocked = blocked_ids(run("git", "show", f"origin/{main}:{cfg['blocked']}")[1])
        if tid in done:
            block(f"Task {tid} is already ticked on {main}. Run `python3 .claude/hooks/next_task.py` and build that one.")
        if tid in blocked:
            block(f"Task {tid} is in {cfg['blocked']}. Pick the next task with `python3 .claude/hooks/next_task.py`.")
    rc, out = run("gh", "pr", "list", "--author", "@me", "--state", "open", "--json", "number,isDraft")
    if rc == 0:
        ready = [p["number"] for p in json.loads(out or "[]") if not p["isDraft"]]
        if len(ready) >= int(cfg["maxOpenPRs"]):
            block(f"{len(ready)} of your pull requests are open (limit {cfg['maxOpenPRs']}): "
                  + ", ".join(f"#{n}" for n in sorted(ready)) + ". Wait for the oldest with "
                  f"`.claude/hooks/wait_for_merge.sh {min(ready)}`, or answer what's blocking it, before opening another.")

m = re.search(r"\bgh\s+pr\s+merge\b\s*([^\s-][^\s]*)?", cmd)
if m:
    ref = [m.group(1)] if m.group(1) else []
    rc, out = run("gh", "pr", "view", *ref, "--json", "headRefName,headRefOid,files,comments,labels")
    if rc != 0:
        block("Could not read the pull request: " + out)
    pr = json.loads(out)
    # A dev-manager must-fix holds the merge until the dev manager approves a later commit: the agent's own
    # reviewer passing is not enough once someone else has found a problem.
    last = None
    for c in pr.get("comments", []):
        body = c.get("body") or ""
        if "<!-- factory-mustfix" in body:
            last = "mustfix"
        elif "<!-- factory-approved" in body:
            last = "approved"
    hold = cfg.get("holdLabel", "factory-hold")
    if any(label.get("name") == hold for label in pr.get("labels", [])):
        block(f"The dev manager is reviewing this pull request (label `{hold}`). Leave it open and continue with the "
              "next task: the dev manager approves and merges it, or posts must-fixes, and removes the label.")
    if last == "mustfix":
        block("The dev manager left a must-fix on this pull request (a `<!-- factory-mustfix -->` comment). Fix it, "
              "push, reply on the PR, and leave the merge to the dev manager, who approves with `<!-- factory-approved -->`.")
    if not passed(pr["headRefName"], pr["headRefOid"]):
        block("This pull request has no reviewer pass for its latest commit. Review it first.")
    styles = styled([f["path"] for f in pr.get("files", [])], cfg)
    if styles and not arch_passed(pr["headRefName"], pr["headRefOid"]):
        block(ARCH_MSG.format(skills=", ".join(sorted({s for st in styles for s in st.get("skills", [])}))))
    rc, _ = run("gh", "pr", "checks", *ref)
    if rc != 0:
        block("CI is not green (or still running) for this pull request. Wait for it or fix it; do not merge.")
    paths = [f["path"] for f in pr.get("files", [])]
    hits = [p for p in paths if p not in cfg["alwaysAllowed"]
            and any(re.search(rx, p) for rx in cfg["protected"])]
    if hits:
        block("This pull request changes protected files, so the dev manager or a person merges it: "
              + ", ".join(hits[:8]) + ". Leave it open, say so in the PR description, and continue with the next task.")
sys.exit(0)
