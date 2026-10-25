#!/usr/bin/env python3
"""The curated lessons file (#72): a short list of one-line rules the builder and the reviewers read first, fed by
must-fix comments, reviewer findings and CI failures, kept under a cap and pruned when something enforces a rule.
Runs `factory lessons ...` in a scratch project with a fake `gh`.  python3 software-factory/tests/test_curated_lessons.py"""
import json, os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
KIT = os.path.join(SF, "kit")

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from urllib.parse import urlparse, parse_qs, unquote
s = json.load(open(os.environ["LESSONS_SCENARIO"]))
a = sys.argv[1:]
if a[:1] != ["api"] or "-X" in a or "--input" in a:
    sys.exit("fake gh: suggest must only read")
u = urlparse(a[1].replace("repos/{owner}/{repo}/", "")); q = parse_qs(u.query)
if u.path == "pulls":
    print(json.dumps(s["pulls"] if q.get("page", ["1"])[0] == "1" else [])); sys.exit(0)
if u.path == "actions/runs":
    print(json.dumps({"workflow_runs": s["runs"].get(unquote(q["branch"][0]), [])})); sys.exit(0)
if u.path.startswith("actions/runs/") and u.path.endswith("/jobs"):
    print(json.dumps({"jobs": s["jobs"].get(u.path.split("/")[2], [])})); sys.exit(0)
if u.path.startswith("issues/") and u.path.endswith("/comments"):
    print(json.dumps(s["comments"].get(u.path.split("/")[1], []))); sys.exit(0)
sys.exit("fake gh: no answer for " + a[1])
'''

LESSONS = """# Lessons

Short rules, one line each. Read before you build.

- packages/validators: annotate recursive helpers' return types (e.g. TS7022 in `schema.ts`)
- Run `pnpm lint --fix` before every push (https://example.com/why)
"""


def pr(n, branch):
    return {"number": n, "head": {"ref": branch}, "created_at": "2026-10-20T10:00:00Z", "state": "closed",
            "merged_at": "2026-10-21T10:00:00Z"}


def mf(text):
    return {"body": "<!-- factory-mustfix sha=abc1234 -->\n" + text, "created_at": "2026-10-20T12:00:00Z"}


def project(lessons=LESSONS, cfg=None, scenario=None, files=()):
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "-b", "main", d], check=True)
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    os.makedirs(os.path.join(d, ".claude", "factory"))
    os.makedirs(os.path.join(d, "bin"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(d, ".claude", "hooks", f))
    json.dump({"reviewMarkers": "tmp/reviews", **(cfg or {})}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    if lessons is not None:
        open(os.path.join(d, ".claude", "factory", "lessons.md"), "w").write(lessons)
    for f in files:
        os.makedirs(os.path.dirname(os.path.join(d, f)), exist_ok=True)
        open(os.path.join(d, f), "w").write("x")
    open(os.path.join(d, "bin", "gh"), "w").write(FAKE_GH)
    os.chmod(os.path.join(d, "bin", "gh"), 0o755)
    json.dump(scenario or {}, open(os.path.join(d, "scenario.json"), "w"))
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "LESSONS_SCENARIO": os.path.join(d, "scenario.json")}
    for k in ("CLAUDE_PROJECT_DIR", "FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
        env.pop(k, None)
    return d, env


def run(d, env, *args, extra_env=None):
    return subprocess.run(["bash", os.path.join(SF, "factory"), "lessons", *args], cwd=d, env={**env, **(extra_env or {})},
                          capture_output=True, text=True, timeout=60)


def lines(d):
    return [x for x in open(os.path.join(d, ".claude", "factory", "lessons.md")).read().splitlines() if x.startswith("- ")]


SCENARIO = {
    "pulls": [pr(40, "task/30-a"), pr(41, "task/31-b"), pr(42, "task/32-c"), pr(43, "chore/not-a-task")],
    "comments": {
        "40": [mf("- Annotate the recursive helper's return type (TS7022) in packages/validators\n- Missing test for the empty cart")],
        "41": [mf("1. packages/validators: recursive helper needs an explicit return type, TS7022")],
        "42": [mf("Run `pnpm lint --fix` before pushing; lint failed on formatting."),
               {"body": "<!-- factory-approved sha=abc -->", "created_at": "2026-10-20T13:00:00Z"}],
        "43": [mf("- not a task pull request, never counted")],
    },
    "runs": {"task/30-a": [{"id": 1, "conclusion": "failure"}, {"id": 2, "conclusion": "failure"}],
             "task/31-b": [{"id": 3, "conclusion": "failure"}],
             "task/32-c": [{"id": 4, "conclusion": "success"}]},
    "jobs": {"1": [{"name": "Typecheck, lint, test, build", "conclusion": "failure",
                    "steps": [{"name": "pnpm install", "conclusion": "success"}, {"name": "pnpm typecheck", "conclusion": "failure"}]}],
             "2": [{"name": "Typecheck, lint, test, build", "conclusion": "failure",
                    "steps": [{"name": "pnpm typecheck", "conclusion": "failure"}]}],
             "3": [{"name": "Typecheck, lint, test, build", "conclusion": "failure",
                    "steps": [{"name": "pnpm typecheck", "conclusion": "failure"}]}]},
}


def test_show_prints_only_the_lessons_and_nothing_when_there_is_no_file():
    d, env = project()
    p = run(d, env, "show")
    assert p.returncode == 0 and p.stdout.count("\n") == 2 and "TS7022" in p.stdout and "# Lessons" not in p.stdout, p
    d, env = project(lessons=None)
    p = run(d, env, "show")
    assert p.returncode == 0 and p.stdout.strip() == "", p


def test_check_passes_a_short_file_and_a_missing_one():
    d, env = project()
    p = run(d, env, "check")
    assert p.returncode == 0 and "2 of 40" in p.stdout, p
    d, env = project(lessons=None)
    assert run(d, env, "check").returncode == 0


def test_check_fails_over_the_cap_and_the_cap_is_a_setting():
    many = "# Lessons\n" + "".join(f"- rule {i}, e.g. `x{i}`\n" for i in range(41))
    d, env = project(lessons=many)
    p = run(d, env, "check")
    assert p.returncode == 1 and "41 lessons" in p.stderr and "40" in p.stderr and "prune" in p.stderr, p
    d, env = project(lessons=many, cfg={"lessonsCap": 50})
    assert run(d, env, "check").returncode == 0
    d, env = project(cfg={"lessonsCap": 1})
    assert run(d, env, "check").returncode == 1


def test_check_wants_one_line_with_an_example_or_a_link():
    d, env = project(lessons="- Be careful with types\n- A rule\n  that wraps, e.g. `x`\n- ok, see #12\n")
    p = run(d, env, "check")
    assert p.returncode == 1, p
    assert "line 1" in p.stderr and "example" in p.stderr, p
    assert "line 2" in p.stderr or "line 3" in p.stderr, p  # the wrapped continuation line
    assert "line 4" not in p.stderr, p
    d, env = project(lessons="- " + "long " * 80 + "e.g. `x`\n")
    assert run(d, env, "check").returncode == 1


def test_add_appends_a_valid_lesson_and_refuses_bad_ones_with_a_fix():
    d, env = project()
    p = run(d, env, "add", "Pin the Node version in `.nvmrc` (e.g. #7)")
    assert p.returncode == 0 and len(lines(d)) == 3 and lines(d)[-1].endswith("(e.g. #7)"), p
    p = run(d, env, "add", "pin the node version in `.nvmrc` (e.g. #7)")  # the same lesson again
    assert p.returncode == 1 and "already" in p.stderr and len(lines(d)) == 3, p
    p = run(d, env, "add", "Be careful")
    assert p.returncode == 1 and "example" in p.stderr and len(lines(d)) == 3, p
    d, env = project(cfg={"lessonsCap": 2})
    p = run(d, env, "add", "A third rule, e.g. `x`")
    assert p.returncode == 1 and "2 lessons" in p.stderr and "prune" in p.stderr and len(lines(d)) == 2, p


def test_add_creates_the_file_and_agents_cannot_change_it():
    d, env = project(lessons=None)
    assert run(d, env, "add", "First rule, e.g. `x`").returncode == 0 and len(lines(d)) == 1
    for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
        p = run(d, env, "add", "Another rule, e.g. `y`", extra_env={var: "1"})
        assert p.returncode == 1 and "dev manager" in p.stderr and len(lines(d)) == 1, (var, p)
    p = run(d, env, "show", extra_env={"FACTORY_AGENT": "taytu"})  # reading is for everyone
    assert p.returncode == 0 and "First rule" in p.stdout, p


def test_prune_lists_lessons_that_something_enforces_now_and_removes_them_on_request():
    text = ("- Annotate recursive helpers, e.g. `x.ts` [enforced: tools/lint-rule.js]\n"
            "- Run the formatter first, e.g. `pnpm fmt` [enforced: tools/gone.js]\n"
            "- Keep tests small, e.g. #3\n")
    d, env = project(lessons=text, files=["tools/lint-rule.js"])
    p = run(d, env, "prune")
    assert p.returncode == 0 and "Annotate recursive helpers" in p.stdout and "Keep tests small" not in p.stdout, p
    assert "Run the formatter first" not in p.stdout and len(lines(d)) == 3, p
    p = run(d, env, "check")  # an enforcement that no longer exists is worth a look, not a failure
    assert p.returncode == 0 and "tools/gone.js" in p.stdout and "tools/lint-rule.js" in p.stdout, p
    p = run(d, env, "prune", "--apply")
    assert p.returncode == 0 and len(lines(d)) == 2 and "Annotate" not in "".join(lines(d)), p


def test_suggest_lists_repeated_causes_from_mustfix_comments_and_ci_and_skips_known_lessons():
    d, env = project(scenario=SCENARIO)
    p = run(d, env, "suggest", "--json")
    assert p.returncode == 0, p
    out = json.loads(p.stdout)
    texts = {c["text"]: c for c in out["candidates"]}
    # the recursive-helper must-fix came twice (PRs 40 and 41) but is already a lesson: not suggested again
    assert not any("TS7022" in t for t in texts), texts
    # `pnpm lint --fix` is already a lesson too; the single empty-cart must-fix is below --min 2
    assert not any("empty cart" in t for t in texts), texts
    ci = [c for c in out["candidates"] if c["source"] == "ci"]
    assert len(ci) == 1 and ci[0]["count"] == 2 and ci[0]["refs"] == ["#40", "#41"], out  # once per PR, not per run
    assert "Typecheck, lint, test, build / pnpm typecheck" in ci[0]["text"], ci
    assert ci[0]["line"].startswith("- ") and "#40" in ci[0]["line"], ci
    assert out["pulls"] == 3, out  # the chore branch is not a task PR


def test_suggest_with_no_lessons_yet_proposes_the_repeats_with_the_prs_and_a_command_to_approve():
    d, env = project(lessons=None, scenario=SCENARIO)
    p = run(d, env, "suggest")
    assert p.returncode == 0, p
    assert "TS7022" in p.stdout and "#40" in p.stdout and "#41" in p.stdout, p.stdout
    assert "empty cart" not in p.stdout and "not a task pull request" not in p.stdout, p.stdout
    assert "factory lessons add" in p.stdout, p.stdout
    p = run(d, env, "suggest", "--min", "1", "--json")
    assert any("empty cart" in c["text"] for c in json.loads(p.stdout)["candidates"]), p.stdout
    p = run(d, env, "suggest", "--last", "1", "--min", "1", "--json")  # only the first task PR GitHub lists, #40
    assert {r for c in json.loads(p.stdout)["candidates"] for r in c["refs"]} == {"#40"}, p.stdout


def test_suggest_adds_reviewer_findings_kept_on_this_machine():
    d, env = project(lessons=None, scenario={"pulls": [], "runs": {}, "comments": {}, "jobs": {}})
    os.makedirs(os.path.join(d, "tmp", "reviews"))
    for branch in ("task_5-a", "task_6-b"):
        json.dump({"reviewer": [{"sha": "a" * 40, "result": "fail", "findings": "must-fix: `api/users.ts` logs the raw email\n"},
                                {"sha": "b" * 40, "result": "pass", "findings": "no must-fix"}]},
                  open(os.path.join(d, "tmp", "reviews", branch + ".reviews.json"), "w"))
    p = run(d, env, "suggest", "--json")
    c = json.loads(p.stdout)["candidates"]
    assert len(c) == 1 and c[0]["source"] == "reviewer" and c[0]["count"] == 2 and "raw email" in c[0]["text"], p.stdout


def test_suggest_is_read_only_and_says_so_when_there_is_nothing():
    d, env = project(scenario={"pulls": [], "runs": {}, "comments": {}, "jobs": {}})
    before = open(os.path.join(d, ".claude", "factory", "lessons.md")).read()
    p = run(d, env, "suggest")
    assert p.returncode == 0 and "no repeated" in p.stdout.lower(), p
    assert open(os.path.join(d, ".claude", "factory", "lessons.md")).read() == before


def test_the_lessons_file_is_a_setting():
    d, env = project(lessons=None, cfg={"lessons": "docs/lessons.md"})
    os.makedirs(os.path.join(d, "docs"))
    open(os.path.join(d, "docs", "lessons.md"), "w").write("- Elsewhere, e.g. `x`\n")
    assert "Elsewhere" in run(d, env, "show").stdout
    for key in ("lessons", "lessonsCap"):
        p = subprocess.run(["python3", os.path.join(HOOKS, "factory_settings.py"), "show", key], cwd=d, env=env,
                           capture_output=True, text=True)
        assert p.returncode == 0 and key in p.stdout, p


def test_the_builder_and_every_reviewer_read_the_lessons_first():
    for rel in ("agents/reviewer.md", "agents/architecture-reviewer.md", "agents/safety-auditor.md",
                "agents/security-reviewer.md", "skills/next-task/SKILL.md"):
        text = open(os.path.join(KIT, ".claude", rel)).read()
        assert "factory_lessons.py show" in text, rel
    assert "lesson" in open(os.path.join(KIT, ".claude", "agents", "reviewer.md")).read().lower()
    assert "factory_lessons.py suggest" in open(os.path.join(SF, "DEV-MANAGER.md")).read()


def test_agents_may_read_lessons_but_settings_deny_changing_them():
    deny = json.load(open(os.path.join(KIT, ".claude", "settings.json")))["permissions"]["deny"]
    joined = " ".join(deny)
    for sub in ("add", "prune"):
        assert f"factory_lessons.py {sub}" in joined and f"factory lessons {sub}" in joined, (sub, deny)


def test_the_kit_ships_a_valid_empty_lessons_file_and_ci_checks_it():
    template = os.path.join(KIT, ".claude", "factory", "lessons.md")
    assert os.path.isfile(template)
    d, env = project(lessons=open(template).read())
    p = run(d, env, "check")
    assert p.returncode == 0 and "0 of 40" in p.stdout, p
    ci = open(os.path.join(KIT, ".github", "workflows", "ci.yml")).read()
    assert "factory_lessons.py check" in ci


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
