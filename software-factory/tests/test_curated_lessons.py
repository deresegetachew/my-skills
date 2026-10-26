#!/usr/bin/env python3
"""The curated lessons file (#72): a short list of one-line rules the builder and the reviewers read first, fed by
must-fix comments, reviewer findings and CI failures, kept under a cap and pruned when something enforces a rule.
Ported to curated_lessons.test.ts (#252); this case stays until factory_settings is ported.  python3 software-factory/tests/test_curated_lessons.py"""
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
        if f.endswith((".py", ".ts")):
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


def test_the_lessons_file_is_a_setting():
    d, env = project(lessons=None, cfg={"lessons": "docs/lessons.md"})
    os.makedirs(os.path.join(d, "docs"))
    open(os.path.join(d, "docs", "lessons.md"), "w").write("- Elsewhere, e.g. `x`\n")
    # (`factory lessons show` reading it: curated_lessons.test.ts, #252)
    for key in ("lessons", "lessonsCap"):
        p = subprocess.run(["python3", os.path.join(HOOKS, "factory_settings.py"), "show", key], cwd=d, env=env,
                           capture_output=True, text=True)
        assert p.returncode == 0 and key in p.stdout, p


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
