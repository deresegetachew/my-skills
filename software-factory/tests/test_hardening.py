#!/usr/bin/env python3
"""Smaller fixes from the 22 Oct security audit: blocking ends a claim, env keys and agent names are checked, the
stop hook never signals a guessed process.  python3 software-factory/tests/test_hardening.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.abspath(os.path.join(HERE, "..", "kit", ".claude", "hooks"))
sys.path.insert(0, HERE)
from test_issues import issue, labels, run, setup  # noqa: E402  (the fake gh)


def test_a_block_ends_the_old_claim_so_a_later_claim_wins():
    d, db, env = setup([issue(1, labels=("factory:in-progress", "agent:menelik"))])
    state = json.load(open(db))
    state["comments"] = {"1": [{"body": "<!-- factory-claim agent=menelik -->", "at": 0}]}
    json.dump(state, open(db, "w"))
    run(d, env, "block", "1", "waits for #2")
    state = json.load(open(db))  # the owner unblocks by hand: labels only
    state["issues"][0]["labels"] = [{"name": "factory:ready"}]
    json.dump(state, open(db, "w"))
    assert run(d, env, "pick", "--agent", "taytu")[1] == "issue-1 Task 1"
    assert labels(db, 1) == ["agent:taytu", "factory:in-progress"], labels(db, 1)


def test_an_env_key_that_is_not_a_plain_name_is_refused():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    os.makedirs(os.path.join(d, ".claude"))
    json.dump({"agentEnv": {"X=1; touch pwned #": "v"}}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_env.py")], cwd=d, capture_output=True, text=True)
    assert p.returncode != 0 and "valid variable name" in p.stderr, p
    assert not os.path.exists(os.path.join(d, "pwned"))


def test_an_agent_name_that_could_be_a_path_is_refused():
    sys.path.insert(0, HOOKS)
    from factory_config import safe_agent
    assert safe_agent("taytu") == "taytu"
    for bad in ("../x", "a/b", "Taytu", "", "x" * 41):
        try:
            safe_agent(bad)
        except SystemExit:
            continue
        raise AssertionError(f"{bad!r} was accepted")


def test_only_claude_itself_counts_as_claude():
    sys.path.insert(0, HOOKS)
    from factory_session import is_claude
    assert is_claude("claude --remote-control=taytu /next-task 3")
    assert is_claude("/usr/local/bin/claude")
    assert is_claude("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")
    assert not is_claude("bash /home/claude/project/factory-loop.sh -i")
    assert not is_claude("python3 /home/claude/x.py")


if __name__ == "__main__":
    os.environ.pop("FACTORY_AGENT", None)
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
