#!/usr/bin/env python3
"""Commands that change labels or claims say what they did (#156).  python3 software-factory/tests/test_label_output.py"""
import json, os, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_issues import HOOKS, issue, labels, run, setup  # noqa: E402
from wiki_text import readme_and_wiki


def claims(agent, *extra):
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    os.makedirs(os.path.join(d, ".claude"))
    json.dump({}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    state = os.path.join(d, ".git", "factory")
    os.makedirs(state)
    json.dump({"checkouts": {"taytu": {"agent": "taytu", "pid": 1}},
               "tasks": {"issue-5": {"agent": "taytu", "pid": 1}}}, open(os.path.join(state, "claims.json"), "w"))

    def go(*args):
        p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_claims.py"), "release", *args], cwd=d,
                           capture_output=True, text=True)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    return go


def test_review_prints_the_labels_it_changed():
    d, db, env = setup([issue(1, labels=("factory:in-progress", "agent:menelik"))])
    rc, out = run(d, env, "review", "1")
    assert rc == 0 and out == "#1 is in review: added factory:in-review, removed factory:in-progress.", (rc, out)


def test_review_on_an_issue_already_in_review_says_nothing_changed():
    d, db, env = setup([issue(1, labels=("factory:in-review", "agent:menelik"))])
    rc, out = run(d, env, "review", "1")
    assert rc == 0 and out == "#1 was already in review: nothing changed.", (rc, out)


def test_release_prints_what_it_let_go():
    go = claims("taytu")
    rc, out, err = go("--agent", "taytu")
    assert rc == 0 and out == "Released taytu: the checkout and the task claim issue-5.", (rc, out, err)


def test_release_tasks_only_keeps_the_checkout_and_says_so():
    go = claims("taytu")
    rc, out, err = go("--agent", "taytu", "--tasks-only")
    assert rc == 0 and out == "Released taytu: the task claim issue-5. The checkout stays.", (rc, out, err)


def test_release_of_a_claim_that_is_not_there_says_so():
    go = claims("taytu")
    rc, out, err = go("--agent", "haile")
    assert rc == 0 and out == "Nothing to release: haile holds no checkout or task claim.", (rc, out, err)
    rc, out, err = go("--agent", "haile", "--tasks-only")
    assert rc == 0 and out == "Nothing to release: haile holds no task claim.", (rc, out, err)


def test_readme_and_help_describe_the_output():
    sf = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    readme = readme_and_wiki()
    assert "Nothing to release" in readme, "README should show the release output"
    assert "in review: added" in readme, "README should show the review output"


def test_issues_setup_says_what_it_made_and_makes_the_two_review_labels():
    d, db, env = setup([])
    json.dump({"issues": [], "labels": [{"name": "factory:ready", "color": "0e8a16"}]}, open(db, "w"))
    rc, out = run(d, env, "setup")
    assert rc == 0, out
    assert "created tests-reviewed" in out and "created deps-reviewed" in out, out
    assert "already there: factory:ready" in out, out
    made = {l["name"] for l in json.load(open(db))["labels"]}
    assert {"tests-reviewed", "deps-reviewed"} <= made, made
    rc, again = run(d, env, "setup")  # safe to run twice
    assert rc == 0 and "created" not in again and "already there: tests-reviewed" in again, again


def test_give_back_releases_a_claim_with_no_branch_or_pull_request_and_says_so():
    # #192: the run claimed #1 and #2, built only #2, and both stayed in progress on GitHub.
    d, db, env = setup([issue(1, labels=("factory:in-progress", "agent:taytu")),
                        issue(2, labels=("factory:in-progress", "agent:taytu")),
                        issue(3, labels=("factory:in-progress", "agent:menelik"))])
    rc, out = run(d, env, "give-back", "--agent", "taytu")
    assert rc == 0, out
    assert "released #1" in out and "released #2" in out and "#3" not in out, out
    assert "factory issues release" not in out
    assert labels(db, 1) == ["factory:ready"] and labels(db, 2) == ["factory:ready"], (labels(db, 1), labels(db, 2))
    assert labels(db, 3) == ["agent:menelik", "factory:in-progress"]  # another agent's claim is left alone


def test_give_back_keeps_a_claim_that_has_a_pushed_branch_a_pull_request_or_is_in_review():
    d, db, env = setup([issue(1, labels=("factory:in-progress", "agent:taytu")),
                        issue(2, labels=("factory:in-progress", "agent:taytu")),
                        issue(3, labels=("factory:in-review", "agent:taytu"))])
    state = json.load(open(db))
    state["branches"] = [{"name": "task/1-thing", "commit": {"sha": "a"}}]
    state["pulls"] = [{"number": 9, "head": {"ref": "task/2-other"}, "state": "open"}]
    json.dump(state, open(db, "w"))
    rc, out = run(d, env, "give-back", "--agent", "taytu")
    assert rc == 0 and "released" not in out, out
    assert "kept #1" in out and "kept #2" in out, out
    assert labels(db, 1) == ["agent:taytu", "factory:in-progress"]


def test_give_back_with_nothing_held_says_so():
    d, db, env = setup([issue(1)])
    rc, out = run(d, env, "give-back", "--agent", "taytu")
    assert rc == 0 and out == "Nothing to give back: taytu holds no in-progress issue.", out


if __name__ == "__main__":
    os.environ.pop("FACTORY_AGENT", None)
    for t in [v for k, v in sorted(globals().items()) if k.startswith("test_")]:
        t()
        print("ok", t.__name__)
