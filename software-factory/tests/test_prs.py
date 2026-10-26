#!/usr/bin/env python3
"""`factory prs`: the one list a dev manager starts a pass from (#98), against a fake `gh` that answers from a scenario
(recorded-style REST replies) and logs every call. Ported to prs.test.ts (#252); this case stays until factory_settings
is ported.  python3 software-factory/tests/test_prs.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
sys.path.insert(0, HOOKS)

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from urllib.parse import urlparse
s = json.load(open(os.environ["PRS_SCENARIO"]))
a = sys.argv[1:]
open(os.environ["PRS_LOG"], "a").write(" ".join(a) + "\n")
if a[:2] == ["repo", "view"]:
    print("main"); sys.exit(0)
method = a[a.index("-X") + 1] if "-X" in a else "GET"
if a[:1] != ["api"] or method != "GET" or "--input" in a or "-f" in a or "-F" in a:
    sys.exit("fake gh: prs must only read")
path = urlparse([x for x in a[1:] if not x.startswith("-") and x not in ("GET", "Accept: application/vnd.github+json")][0]
                .replace("repos/{owner}/{repo}/", "")).path
if path == "contents/.claude/factory.json":
    print(json.dumps(s.get("main_settings", {}))); sys.exit(0)
if path in s.get("broken", []):
    sys.exit("gh: HTTP 403")
if path in s:
    print(json.dumps(s[path])); sys.exit(0)
if path == "branches":
    print("[]"); sys.exit(0)
sys.exit("fake gh: no answer for " + path)
'''

LONG_AGO = "2020-01-01T00:00:00Z"
FAR = "2099-01-01T00:00:00Z"
SHAS = {n: f"{n:x}" * 40 for n in range(1, 12)}  # 1*40 ... b*40: hex, like real commit ids
OLD = "0" * 40
CFG = {"tasks": {"source": "issues"}, "agents": ["menelik", "taytu"]}
MAIN = {"tasks": {"source": "issues"}, "manager": {"flakes": ["e2e"]}, "protected": [r"^\.claude/"]}


def run(name, ci=(), comments=(), labels=(), draft=False, branch=None, body="", files=("src/a.py",)):
    return dict(name=name, ci=list(ci), comments=list(comments), labels=list(labels), draft=draft,
                branch=branch or f"task/{name}-x", body=body, files=list(files))


def check(name, conclusion="success", status="completed", id=1):
    return {"id": id, "name": name, "status": status, "conclusion": conclusion}


def marker(kind, sha, at="2020-01-01T01:00:00Z", extra=""):
    return {"body": f"<!-- {kind} sha={sha} {extra}-->", "created_at": at}


def scenario(prs, extra=None):
    s = {"pulls": [], "issues": [], "issues/comments": []}
    for n, p in prs.items():
        sha = SHAS[n]
        s["pulls"].append({"number": n, "title": f"Task {n}", "draft": p["draft"], "body": p["body"],
                           "html_url": f"https://github.com/o/r/pull/{n}", "head": {"sha": sha, "ref": p["branch"]},
                           "labels": [{"name": x} for x in p["labels"]]})
        s[f"commits/{sha}"] = {"commit": {"committer": {"date": LONG_AGO}}}
        s[f"commits/{sha}/check-runs"] = {"check_runs": p["ci"]}
        s[f"issues/{n}/comments"] = p["comments"]
        s[f"pulls/{n}/files"] = [{"filename": f} for f in p["files"]]
    s["main_settings"] = MAIN
    s.update(extra or {})
    return s


def project(sc, cfg=CFG):
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "-b", "main", d], check=True)
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    os.makedirs(os.path.join(d, "bin"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(d, ".claude", "hooks", f))
    json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, "bin", "gh"), "w").write(FAKE_GH)
    os.chmod(os.path.join(d, "bin", "gh"), 0o755)
    json.dump(sc, open(os.path.join(d, "scenario.json"), "w"))
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "PRS_SCENARIO": os.path.join(d, "scenario.json"),
           "PRS_LOG": os.path.join(d, "log"), "PYTHONDONTWRITEBYTECODE": "1"}
    for k in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"):
        env.pop(k, None)
    return d, env


def prs(sc, *args, cfg=CFG):
    d, env = project(sc, cfg)
    p = subprocess.run(["bash", os.path.join(SF, "factory"), "prs", *args], cwd=d, env=env, capture_output=True,
                       text=True, timeout=60)
    return d, p


def pulls_json(sc, cfg=CFG):
    d, p = prs(sc, "--json", cfg=cfg)
    assert p.returncode == 0, p
    out = json.loads(p.stdout)
    return {x["number"]: x for x in out["pulls"]}, out


def claim(manager, sha, until, at="2020-01-01T01:00:00Z"):
    return {"body": f"<!-- factory-review-claim manager={manager} sha={sha} until={until} -->", "created_at": at}


def test_settings_lists_the_flake_list():
    d, env = project(scenario({}))
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_settings.py"), "show", "manager.flakes"], cwd=d,
                       env=env, capture_output=True, text=True)
    assert p.returncode == 0 and "manager.flakes" in p.stdout, p


