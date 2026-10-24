#!/usr/bin/env python3
"""`factory usage`: tokens per task from Claude Code's logs.  python3 software-factory/tests/test_usage.py"""
import json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
USAGE = os.path.abspath(os.path.join(HERE, "..", "kit", ".claude", "hooks", "factory_usage.py"))


def reply(mid, branch, cwd, inp=10, write=100, read=1000, out=50, ts="2026-10-24T10:00:00Z", model="claude-opus-5-5"):
    return json.dumps({"type": "assistant", "timestamp": ts, "gitBranch": branch, "cwd": cwd,
                       "message": {"id": mid, "model": model, "usage": {
                           "input_tokens": inp, "cache_creation_input_tokens": write,
                           "cache_read_input_tokens": read, "output_tokens": out}}})


def setup():
    root = os.path.join(tempfile.mkdtemp(), "proj")
    os.makedirs(os.path.join(root, ".claude"))
    logs = tempfile.mkdtemp()
    slug = re.sub(r"[^A-Za-z0-9]", "-", root)
    main_dir, agent_dir, other = (os.path.join(logs, n) for n in (slug, slug + "-agents-taytu", "-elsewhere"))
    for d in (main_dir, agent_dir, other):
        os.makedirs(d)
    # Task 7 in the project folder, with a reviewer subagent; a reply logged twice counts once.
    lines = [reply("m1", "task/7-x", root), reply("m1", "task/7-x", root), reply("m2", "HEAD", root)]
    open(os.path.join(main_dir, "s1.jsonl"), "w").write("\n".join(lines) + "\n")
    sub = os.path.join(main_dir, "s1", "subagents")
    os.makedirs(sub)
    open(os.path.join(sub, "agent-a.jsonl"), "w").write(reply("r1", "HEAD", root, model="claude-sonnet-5-5") + "\n")
    json.dump({"agentType": "reviewer"}, open(os.path.join(sub, "agent-a.meta.json"), "w"))
    # Task 8 in an agent worktree; one reply outside the period.
    wt = root + "-agents/taytu"
    open(os.path.join(agent_dir, "s2.jsonl"), "w").write(
        reply("m3", "task/8-y", wt) + "\n" + reply("m4", "task/8-y", wt, ts="2026-10-01T10:00:00Z") + "\n")
    # Another project's log is never counted.
    open(os.path.join(other, "s3.jsonl"), "w").write(reply("m5", "task/9-z", "/elsewhere") + "\n")
    return root, logs


def usage(root, logs, *args):
    return subprocess.run([sys.executable, USAGE, "--logs", logs, "--since", "2026-10-20", "--until", "2026-10-25",
                           *args], cwd=root, capture_output=True, text=True,
                          env={**os.environ, "CLAUDE_PROJECT_DIR": root})


def test_tokens_are_grouped_per_task_once_per_reply():
    root, logs = setup()
    p = usage(root, logs, "--json")
    assert p.returncode == 0, p
    data = json.loads(p.stdout)
    assert data["total"]["tasks"] == ["7", "8"], data
    assert data["total"]["replies"] == 4, data  # m1 once, m2, r1, m3; not m4 (outside), not m5 (other project)
    assert data["groups"]["7"]["replies"] == 3 and data["groups"]["8"]["replies"] == 1, data
    assert data["total"]["tokens"] == {"input": 40, "cache_write": 400, "cache_read": 4000, "output": 200}


def test_by_agent_names_the_subagent_types():
    root, logs = setup()
    data = json.loads(usage(root, logs, "--json", "--by", "agent").stdout)
    assert data["groups"]["reviewer"]["replies"] == 1 and data["groups"]["main"]["replies"] == 3, data


def test_record_appends_a_row_to_the_usage_log():
    root, logs = setup()
    assert usage(root, logs, "--record", "baseline | before").returncode == 0
    assert usage(root, logs, "--record", "after").returncode == 0
    text = open(os.path.join(root, "docs", "factory-usage.md")).read()
    rows = [l for l in text.splitlines() if l.startswith("| 20")]
    assert len(rows) == 2 and "baseline / before" in rows[0] and "| 2 |" in rows[0], text


def test_the_text_report_runs():
    root, logs = setup()
    p = usage(root, logs)
    assert p.returncode == 0 and "Per task (2 tasks)" in p.stdout, p


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
