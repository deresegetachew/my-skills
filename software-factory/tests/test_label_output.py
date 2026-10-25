#!/usr/bin/env python3
"""Commands that change labels or claims say what they did (#156).  python3 software-factory/tests/test_label_output.py"""
import json, os, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_issues import HOOKS, issue, run, setup  # noqa: E402


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
    readme = open(os.path.join(sf, "README.md")).read()
    assert "Nothing to release" in readme, "README should show the release output"
    assert "in review: added" in readme, "README should show the review output"


if __name__ == "__main__":
    os.environ.pop("FACTORY_AGENT", None)
    for t in [v for k, v in sorted(globals().items()) if k.startswith("test_")]:
        t()
        print("ok", t.__name__)
