#!/usr/bin/env python3
"""The end-to-end flow (#103): from an idea in an empty folder to a reviewed first milestone, then a change of direction,
using only the role commands. A scripted test with fakes: the product owner's `-i` session is a fake `claude` that runs a
short script (what the skill tells the real one to do), the owner's yes is a comment added to the fake GitHub, and the
fake `gh` (fakegh.py) keeps the issues, labels and comments. Nothing real runs: no model, no network.

What it checks is that the hand-offs work through GitHub and the repository alone: a role started on a fresh clone finds
everything it needs. The part that needs a real model (the interview itself, the quality of the PRD) is not tested here;
the owner runs it once for real (docs in README, "From an idea to a first milestone").
  python3 software-factory/tests/test_flow.py"""
import json, os, re, subprocess, sys, textwrap

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fakegh  # noqa: E402
from test_roles import GIT, SF, factory, log, project, sh  # noqa: E402

sys.path.insert(0, os.path.join(SF, "hooks"))
import factory_init  # noqa: E402

PRELUDE = """
import json, os, subprocess, sys
def fx(*a):
    p = subprocess.run(["bash", "./factory", *a], capture_output=True, text=True)
    open(os.environ["FLOW_OUT"], "a").write(json.dumps({"args": a, "rc": p.returncode, "out": p.stdout, "err": p.stderr}) + "\\n")
    return p
def push(msg):
    env = {**os.environ}
    subprocess.run(["git", "add", "-A"], check=True)
    subprocess.run(["git", "commit", "-qm", msg], check=True)
    subprocess.run(["git", "push", "-q", "origin", "HEAD:main"], check=True)  # the owner merges the pull request
"""


def flow_project():
    d, work, env = project(cfg={"tasks": {"source": "issues"}}, db={})
    path = os.path.join(d, "bin", "gh")
    open(path, "w").write(fakegh.GH)
    os.chmod(path, 0o755)
    env["FLOW_OUT"] = os.path.join(d, "flow.jsonl")
    open(env["FLOW_OUT"], "w").close()
    return d, work, env


def db(d):
    return json.load(open(os.path.join(d, "db.json")))


def save(d, data):
    json.dump(data, open(os.path.join(d, "db.json"), "w"))


def session(d, work, env, script):
    """The product owner's `-i` session: `factory product-owner eleni loop -i --once` with nothing queued, so the loop
    starts a discovery session; the fake claude runs `script` in the session's own checkout."""
    body = os.path.join(d, "session.py")
    open(body, "w").write(PRELUDE + textwrap.dedent(script))
    hook = os.path.join(d, "hook.sh")
    open(hook, "w").write(f'python3 "{body}"\n')
    p = factory(work, {**env, "FAKE_CLAUDE_HOOK": hook}, "product-owner", "eleni", "loop", "-i", "--once", timeout=150)
    assert p.returncode == 0, (p.stdout, p.stderr)
    return p


def ran(env):
    return [json.loads(l) for l in open(env["FLOW_OUT"]).read().splitlines()]


def owner_says(d, text, queue=101):
    data = db(d)
    data.setdefault("comments", {}).setdefault(str(queue), []).append({"body": text, "created_at": "2026-10-25T12:00:00Z"})
    save(d, data)


def stage(work, env, *args):
    return factory(work, env, "prd", "--stage", *args)


def rows(work, env):
    return {r["stage"]: r for r in json.loads(stage(work, env, "--json").stdout)}


# --- stage 0: the scaffold -------------------------------------------------------------------------------------------

def test_init_makes_the_scaffold_and_a_second_run_adds_and_posts_nothing():
    d, work, env = flow_project()
    p = factory(work, env, "init")
    assert p.returncode == 0, (p.stdout, p.stderr)
    for want in ("added    .claude/factory/roles/product-owner/README.md", "created  11 labels", "made     owner queue #101",
                 "added    docs/PRD.md", "added    .github/PULL_REQUEST_TEMPLATE/prd-change.md", "factory product-owner loop -i"):
        assert want in p.stdout, (want, p.stdout)
    data = db(d)
    assert {"factory:ready", "factory:in-progress", "factory:blocked"} <= {x["name"] for x in data["labels"]}, data["labels"]
    assert [i["title"] for i in data["issues"]] == ["Dev manager: needs the owner"], data["issues"]
    n = len(data["posted"])
    again = factory(work, env, "init")
    assert again.returncode == 0 and "added" not in again.stdout.split("Next,")[0] and "made" not in again.stdout.split("Next,")[0], again.stdout
    assert "exists   owner queue #101" in again.stdout and len(db(d)["posted"]) == n, "a second run posted something"


def test_a_dry_run_changes_nothing():
    d, work, env = flow_project()
    p = factory(work, env, "init", "--dry-run")
    assert p.returncode == 0 and "would add docs/PRD.md" in p.stdout and "would make the owner queue issue" in p.stdout, p.stdout
    assert not os.path.exists(os.path.join(work, "docs", "PRD.md")) and not db(d).get("posted"), "a dry run wrote something"


def test_the_prd_change_template_in_the_kit_is_the_one_init_writes():
    kit = open(os.path.join(SF, "kit", ".github", "PULL_REQUEST_TEMPLATE", "prd-change.md")).read()
    assert kit == factory_init.PR_TEXT
    for part in ("## Stories this touches", "## Tasks that move", "## Decision record", "## Owner's yes"):
        assert part in kit, part


# --- stage 1 to 4, and the pivot -------------------------------------------------------------------------------------

VISION = """
os.makedirs("docs", exist_ok=True)
open("docs/PRD.md", "w").write(
    "# Product requirements\\n\\n## Vision\\n\\nBuilders follow a guide on any screen.\\n\\n## User stories\\n\\n"
    "- US-1: Follow a guide step by step\\n- US-2: Open a guide offline\\n\\n## Rules that must never break\\n\\nWarnings are never reworded.\\n")
push("PRD: vision and stories")
fx("prd", "--stage", "--ask", "design")      # too early: nothing approved yet
fx("prd", "--stage", "--ask", "vision")
"""

DESIGN = """
os.makedirs("design/screens", exist_ok=True)
open("design/STYLE.md", "w").write("# Style\\n\\nCalm and practical.\\n")
open("design/screens/step.html", "w").write("<h1>Step</h1>\\n")
push("design references")
fx("prd", "--stage", "--ask", "design")
"""

PLAN = """
body = ("## What we're building\\n\\nThe step screen.\\n\\n## Brief: read these, not more\\n\\n- **PRD:** US-%d\\n\\n"
        "## Acceptance criteria\\n\\n- A builder sees one instruction per step\\n")
for n, title in ((1, "Step screen"), (2, "Offline cache")):
    open("task.md", "w").write(body % n)
    fx("issues", "new", "--title", title, "--body-file", "task.md", "--milestone", "First milestone")
os.remove("task.md")
fx("prd", "--stage", "--ask", "plan")
"""

PIVOT = """
text = open("docs/PRD.md").read().replace("\\n## Rules", "- US-3: Search the parts list\\n\\n## Rules", 1)
open("docs/PRD.md", "w").write(text)
os.makedirs("docs/decisions", exist_ok=True)
open("docs/decisions/0001-add-parts-search.md", "w").write("# 1. Add a parts search\\n\\nBuilders look for a screw by its number.\\n")
open("task.md", "w").write("## Brief: read these, not more\\n\\n- **PRD:** US-3\\n\\n## Acceptance criteria\\n\\n- A builder finds a part by its number\\n")
fx("issues", "new", "--title", "Parts search", "--body-file", "task.md", "--milestone", "First milestone")
os.remove("task.md")
open("pr-body.md", "w").write(open(".github/PULL_REQUEST_TEMPLATE/prd-change.md").read())
push("PRD change: parts search")
"""


def test_an_idea_in_an_empty_folder_reaches_the_hand_over_through_the_three_gates_and_a_pivot_follows():
    d, work, env = flow_project()
    assert factory(work, env, "init").returncode == 0
    sh("git", "add", "-A", cwd=work)
    sh("git", "commit", "-qm", "init", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:main", cwd=work)

    # Stage 1: vision. With nothing queued, -i starts a discovery session; nothing is ready before it.
    assert rows(work, env)["vision"]["done"] is False and "no stories with a title" in rows(work, env)["vision"]["line"]
    p = session(d, work, env, VISION)
    assert "nothing queued: a discovery session" in p.stdout, p.stdout
    claude = [l for l in log(env) if l.startswith("claude ")]
    assert len(claude) == 1 and "/product-pass discover" in claude[0] and "factory-role role=product-owner name=eleni" in claude[0], claude
    first = ran(env)
    assert first[0]["args"][-1] == "design" and first[0]["rc"] != 0 and '"code": "not-ready"' in first[0]["err"], first[0]
    assert first[1]["rc"] == 0 and "asked in the owner queue (#101)" in first[1]["out"], first[1]
    sh("git", "pull", "-q", "origin", "main", cwd=work, check=False)  # the PRD reached main
    r = rows(work, env)
    assert r["vision"]["done"] and r["vision"]["approval"] == "asked" and r["design"]["approval"] == "not ready", r
    assert "wait for the owner's yes on stage-vision" in stage(work, env).stdout
    asks = [c for c in db(d)["comments"]["101"] if "factory-owner-ask id=stage-vision" in (c if isinstance(c, str) else c["body"])]
    assert len(asks) == 1

    # The owner's reply is the gate. A question is not a yes.
    owner_says(d, "Why two stories and not three?")
    assert rows(work, env)["vision"]["approval"] == "answered"
    owner_says(d, "Yes, that is the scope.")
    assert rows(work, env)["vision"]["approval"] == "approved"

    # Stage 2: design (gated by the vision), approved with the answer marker.
    session(d, work, env, DESIGN)
    sh("git", "pull", "-q", "origin", "main", cwd=work, check=False)
    assert rows(work, env)["design"]["approval"] == "asked"
    owner_says(d, "<!-- factory-owner-answer id=stage-design -->\nlooks right")
    assert rows(work, env)["design"]["approval"] == "approved"

    # Stage 3: plan. Task issues name their stories and have a "Done when"; the plan is done when no story lacks a task.
    session(d, work, env, PLAN)
    r = rows(work, env)
    assert r["plan"]["done"] and "2 tasks name a story" in r["plan"]["line"] and r["plan"]["approval"] == "asked", r["plan"]
    issues = [i for i in db(d)["issues"] if i["title"] in ("Step screen", "Offline cache")]
    assert len(issues) == 2 and all(i["milestone"]["title"] == "First milestone" for i in issues)
    assert "US-1" in factory(work, env, "prd").stdout and "2 stories" in factory(work, env, "prd").stdout

    # Stage 4: hand over. The three approvals open the door; a coding agent finds a task, the dev manager reads the queue.
    assert rows(work, env)["hand over"]["done"] is False
    owner_says(d, "Approved, go ahead")
    r = rows(work, env)
    assert r["hand over"]["done"] and "2 ready tasks" in r["hand over"]["line"], r["hand over"]
    assert "Next: start the coding agents." in stage(work, env).stdout
    dry = factory(work, env, "coding-agent", "menelik", "loop", "--dry-run")
    assert "next task: issue-" in dry.stdout, dry.stdout
    assert factory(work, env, "dev-manager", "lead", "loop", "--once", "--dry-run").returncode in (0, 3)

    # Stage 7: a change of direction is a pull request from the template, a decision record and a task, and the story
    # count and the task list change with it.
    session(d, work, env, PIVOT)
    sh("git", "pull", "-q", "origin", "main", cwd=work, check=False)
    out = factory(work, env, "prd").stdout
    assert "3 stories" in out and "US-3" in out, out
    assert os.path.isfile(os.path.join(work, "docs", "decisions", "0001-add-parts-search.md"))
    assert "Parts search" in factory(work, env, "issues", "list").stdout, "the running agents pick the new task from GitHub"
    assert rows(work, env)["plan"]["done"], "the new task has its Done when"

    # Everything a role needs is findable from the repository: a fresh clone (another machine) sees the same stages.
    other = os.path.join(d, "other")
    sh("git", "clone", "-q", os.path.join(d, "origin.git"), other)
    p = subprocess.run(["bash", "./factory", "prd", "--stage"], cwd=other, env=env, capture_output=True, text=True)
    assert p.returncode == 0 and "hand over" in p.stdout and "approved" in p.stdout, (p.stdout, p.stderr)
    p = subprocess.run(["bash", "./factory", "product-owner", "eleni", "loop", "--dry-run"], cwd=other, env=env, capture_output=True, text=True)
    assert p.returncode == 0 and "missing" not in p.stdout, (p.stdout, p.stderr)


def test_a_stage_that_is_not_done_cannot_be_asked_and_an_unknown_stage_is_refused():
    d, work, env = flow_project()
    factory(work, env, "init")
    p = stage(work, env, "--ask", "plan")
    assert p.returncode == 1 and json.loads(p.stderr)["code"] == "not-ready" and json.loads(p.stderr)["fix"], p.stderr
    p = stage(work, env, "--ask", "launch")
    assert p.returncode == 1 and json.loads(p.stderr)["code"] == "unknown-stage", p.stderr


def test_a_product_owner_without_i_and_nothing_queued_still_has_nothing_to_do():
    d, work, env = flow_project()
    factory(work, env, "init")
    p = factory(work, env, "product-owner", "eleni", "loop", "--once")
    assert not [l for l in log(env) if l.startswith("claude ")], "no session starts without -i"
    d2 = factory(work, env, "product-owner", "eleni", "loop", "-i", "--dry-run")
    assert "discovery session" in d2.stdout, d2.stdout


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
