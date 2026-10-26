#!/usr/bin/env python3
"""`factory review-pass` (#197): a review agent records its pass with one allowed command, and the review agents'
documented steps use only commands the kit's allow list covers.  python3 software-factory/tests/test_review_pass.py"""
import fnmatch, json, os, re, subprocess, sys, tempfile
from wiki_text import readme_and_wiki

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
SCRIPT = os.path.join(SF, "hooks", "factory_review_pass.py")
FACTORY = os.path.join(SF, "factory")
KIT = os.path.join(SF, "kit", ".claude")
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t", "PYTHONDONTWRITEBYTECODE": "1"}
ENV.pop("CLAUDE_PROJECT_DIR", None)


def git(d, *a):
    return subprocess.run(["git", *a], cwd=d, check=True, capture_output=True, text=True, env=ENV).stdout.strip()


def project(branch="task/9-x"):
    d = tempfile.mkdtemp()
    git(d, "init", "-q", "-b", "main")
    os.makedirs(os.path.join(d, ".claude"))
    json.dump({"reviewMarkers": "tmp/reviews"}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, "a.txt"), "w").write("a\n")
    git(d, "add", "-A")
    git(d, "commit", "-qm", "one")
    git(d, "checkout", "-q", "-b", branch)
    return d


def run(d, *a):
    return subprocess.run([sys.executable, SCRIPT, *a], cwd=d, capture_output=True, text=True, env=ENV)


def test_reviewer_marker_holds_head():
    d = project()
    p = run(d, "reviewer")
    assert p.returncode == 0, p.stderr
    mark = os.path.join(d, "tmp", "reviews", "task_9-x.ok")
    assert open(mark).read().strip() == git(d, "rev-parse", "HEAD")


def test_arch_marker_is_separate():
    d = project()
    assert run(d, "arch").returncode == 0
    assert os.path.isfile(os.path.join(d, "tmp", "reviews", "task_9-x.arch.ok"))
    assert not os.path.exists(os.path.join(d, "tmp", "reviews", "task_9-x.ok"))


def test_marker_follows_a_new_commit():
    d = project()
    run(d, "reviewer")
    open(os.path.join(d, "b.txt"), "w").write("b\n")
    git(d, "add", "-A")
    git(d, "commit", "-qm", "two")
    run(d, "reviewer")
    assert open(os.path.join(d, "tmp", "reviews", "task_9-x.ok")).read().strip() == git(d, "rev-parse", "HEAD")


def test_unknown_kind_and_detached_head_are_refused_with_a_fix():
    d = project()
    p = run(d, "nonsense")
    assert p.returncode == 1 and json.loads(p.stderr)["fix"], p
    git(d, "checkout", "-q", "--detach")
    p = run(d, "reviewer")
    assert p.returncode == 1 and json.loads(p.stderr)["code"] == "no-branch", p
    assert not os.path.exists(os.path.join(d, "tmp"))


def test_factory_command_and_help():
    assert 'review-pass) py factory_review_pass.py "$@"' in " ".join(open(FACTORY).read().split())
    h = subprocess.run(["bash", FACTORY, "help"], capture_output=True, text=True, env=ENV).stdout
    assert "review-pass" in h
    assert "factory review-pass" in readme_and_wiki()


def allowed():
    s = json.load(open(os.path.join(KIT, "settings.json")))["permissions"]["allow"]
    return [re.match(r"Bash\((.*)\)$", x).group(1) for x in s if x.startswith("Bash(")]


def agent_commands(name):
    """The commands in an agent file's fenced bash blocks."""
    text = open(os.path.join(KIT, "agents", name)).read()
    out = []
    for block in re.findall(r"```bash\n(.*?)```", text, re.S):
        for line in block.splitlines():
            line = line.split("   #")[0].strip()
            if line:
                out.append(line)
    return out


def test_review_agents_use_only_allowed_unchained_commands():
    pats = allowed()
    for name in sorted(os.listdir(os.path.join(KIT, "agents"))):
        for cmd in agent_commands(name):
            assert not re.search(r"&&|;|\||\$\(|`|>", cmd), f"{name}: chained shell: {cmd}"
            assert any(fnmatch.fnmatchcase(cmd, p) for p in pats), f"{name}: not on the allow list: {cmd}"


def test_pass_commands_are_documented_and_pr_body_dir_is_allowed():
    for name, kind in (("reviewer.md", "reviewer"), ("architecture-reviewer.md", "arch")):
        assert f"python3 .claude/hooks/factory_review_pass.py {kind}" in agent_commands(name)
    s = json.load(open(os.path.join(KIT, "settings.json")))["permissions"]["allow"]
    assert "Edit(tmp/**)" in s


if __name__ == "__main__":
    n = 0
    for k, v in sorted(globals().items()):
        if k.startswith("test_") and callable(v):
            v()
            n += 1
    print(f"{n} tests passed")
