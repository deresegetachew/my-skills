#!/usr/bin/env python3
"""`factory reset-run` (#229): lists what an earlier run left in this project, and with --apply cleans it. A fake gh and a
fake docker record every call, so the tests show that the plan changes nothing, that --apply does each step and only this
project's own, and that a second run finds nothing.  python3 software-factory/tests/test_reset_run.py"""
import datetime, json, os, socket, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")

GH = r'''#!/usr/bin/env python3
import json, os, re, sys
a = sys.argv[1:]
open(os.environ["CALLS"], "a").write("gh " + " ".join(a) + "\n")
db_path = os.environ["DB"]; db = json.load(open(db_path))
if a[:1] != ["api"]: sys.exit(1)
method = a[a.index("-X") + 1] if "-X" in a else "GET"
path = [x for x in a[1:] if not x.startswith("-") and x not in (method, "Accept: application/vnd.github+json", "-")][0]
body = json.loads(sys.stdin.read()) if "--input" in a else {}
p = path.replace("repos/{owner}/{repo}/", "").split("?")[0]; q = path.split("?")[1] if "?" in path else ""
def out(x): json.dump(db, open(db_path, "w")); print(json.dumps(x)); sys.exit(0)
if p == "user": out({"login": "me"})
if p == "issues": out([] if "page=2" in q else [i for i in db["issues"] if "labels=factory:agent" in q])
m = re.fullmatch(r"issues/(\d+)", p)
if m and method == "PATCH":
    i = next(i for i in db["issues"] if i["number"] == int(m.group(1))); i.update(body); out(i)
if p == "actions/runners" and method == "GET": out({"runners": db["runners"]})
m = re.fullmatch(r"actions/runners/(\d+)", p)
if m and method == "DELETE":
    db["runners"] = [r for r in db["runners"] if r["id"] != int(m.group(1))]; out({})
if p == "actions/variables": out({"variables": db["variables"]})
m = re.fullmatch(r"actions/variables/(\w+)", p)
if m and method == "DELETE":
    db["variables"] = [v for v in db["variables"] if v["name"] != m.group(1)]; out({})
sys.exit("fake gh: no route for %s %s" % (method, p))
'''
DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
open(os.environ["CALLS"], "a").write("docker " + " ".join(a) + "\n")
db_path = os.environ["DB"]; db = json.load(open(db_path))
if a[:1] == ["ps"]:
    for c in db["containers"]: print("\t".join([c["id"], c["name"], c["project"]]))
if a[:1] == ["rm"]:
    db["containers"] = [c for c in db["containers"] if c["id"] != a[1]]; json.dump(db, open(db_path, "w"))
'''


def iso(minutes_ago):
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def agent_issue(number, name, status, minutes_ago):
    return {"number": number, "title": f"Agent: {name} · {status}", "state": "open", "labels": [{"name": "factory:agent"}],
            "body": f"<!-- factory-agent name={name} status={status} ping={iso(minutes_ago)} -->\n"}


def world():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "-b", "main", d], check=True)
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(d, ".claude", "hooks", f))
    os.symlink(os.path.join(SF, "ci"), os.path.join(d, ".claude", "ci"))
    json.dump({"agents": ["menelik", "taytu"], "tasks": {"source": "issues"}, "ci": {"repo": "acme/widget"}},
              open(os.path.join(d, ".claude", "factory.json"), "w"))
    os.makedirs(os.path.join(d, ".git", "factory"))
    json.dump({"checkouts": {"menelik": {"pid": 2 ** 22 + 12345, "host": socket.gethostname(), "path": d, "at": 1}}, "tasks": {}},
              open(os.path.join(d, ".git", "factory", "claims.json"), "w"))
    bin_ = os.path.join(d, "bin")
    os.makedirs(bin_)
    for name, body in (("gh", GH), ("docker", DOCKER)):
        open(os.path.join(bin_, name), "w").write(body)
        os.chmod(os.path.join(bin_, name), 0o755)
    db = {"issues": [agent_issue(4, "ghost", "idle", 60 * 24 * 3), agent_issue(11, "menelik", "down", 600),
                     agent_issue(12, "taytu", "idle", 1)],
          "runners": [{"id": 7, "name": "widget-ci-old", "status": "offline", "busy": False, "labels": [{"name": "self-hosted"}]},
                      {"id": 8, "name": "other-ci-old", "status": "offline", "busy": False, "labels": []},
                      {"id": 9, "name": "widget-ci-live", "status": "online", "busy": False,
                       "labels": [{"name": "self-hosted"}, {"name": "widget-local"}]}],
          "variables": [{"name": "CI_RUNS_ON_LIGHT", "value": '["self-hosted","widget-light"]'},
                        {"name": "CI_RUNS_ON", "value": '["self-hosted","widget-local"]'}],
          "containers": [{"id": "c1", "name": "widget-ci-runner-1", "project": "widget-ci"},
                         {"id": "c2", "name": "unrelated", "project": "otherproj"},
                         {"id": "c3", "name": "widget-ci-light-runner", "project": "widget-ci-light"},
                         {"id": "c4", "name": "lookalike", "project": "widget-ci-extra"}]}
    json.dump(db, open(os.path.join(d, "db.json"), "w"))
    env = {**os.environ, "PATH": bin_ + os.pathsep + os.environ["PATH"], "DB": os.path.join(d, "db.json"),
           "CALLS": os.path.join(d, "calls.log"), "PYTHONDONTWRITEBYTECODE": "1"}
    env.pop("FACTORY_AGENT", None)
    return d, env


def run(d, env, *args):
    p = subprocess.run([sys.executable, os.path.join(d, ".claude", "hooks", "factory_reset_run.py"), *args], cwd=d, env=env,
                       capture_output=True, text=True, timeout=90)
    return p


def db(d):
    return json.load(open(os.path.join(d, "db.json")))


def calls(d):
    p = os.path.join(d, "calls.log")
    return open(p).read().splitlines() if os.path.exists(p) else []


def writes(d):
    return [c for c in calls(d) if "-X PATCH" in c or "-X DELETE" in c or c.startswith("docker rm")]


def test_without_apply_it_prints_the_plan_and_changes_nothing():
    d, env = world()
    before = (db(d), open(os.path.join(d, ".git/factory/claims.json")).read())
    p = run(d, env)
    assert p.returncode == 0, p
    out = p.stdout
    for what in ("release the claims of menelik", "close Agent issue #4", "close Agent issue #11", "remove the exited container widget-ci-runner-1",
                 "remove the exited container widget-ci-light-runner", "remove the offline runner widget-ci-old", "delete CI_RUNS_ON_LIGHT"):
        assert what in out, (what, out)
    assert "plan" in out and "--apply" in out, out
    assert writes(d) == [], writes(d)
    assert (db(d), open(os.path.join(d, ".git/factory/claims.json")).read()) == before


def test_apply_does_each_step_and_only_this_projects_own():
    d, env = world()
    p = run(d, env, "--apply")
    assert p.returncode == 0, p
    assert p.stdout.count("done,") == 7, p.stdout
    after = db(d)
    assert {i["number"]: i["state"] for i in after["issues"]} == {4: "closed", 11: "closed", 12: "open"}, after["issues"]  # the live agent stays
    assert [r["id"] for r in after["runners"]] == [8, 9]  # another project's offline runner and the online one stay
    assert [v["name"] for v in after["variables"]] == ["CI_RUNS_ON"]  # the one with an online runner stays
    assert [c["id"] for c in after["containers"]] == ["c2", "c4"]  # another project's and a lookalike stay
    claims = json.load(open(os.path.join(d, ".git/factory/claims.json")))
    assert claims["checkouts"] == {}, claims


def test_a_second_apply_changes_nothing():
    d, env = world()
    run(d, env, "--apply")
    n = len(writes(d))
    p = run(d, env, "--apply")
    assert p.returncode == 0 and "Nothing to reset." in p.stdout and "done," not in p.stdout, p.stdout
    assert len(writes(d)) == n, writes(d)


def test_a_signed_out_gh_is_a_plain_error_with_a_fix_and_nothing_changes():
    d, env = world()
    open(os.path.join(d, "bin", "gh"), "w").write("#!/bin/sh\necho 'gh: run gh auth login' >&2\nexit 1\n")
    p = run(d, env, "--apply")
    err = json.loads(p.stderr.strip().splitlines()[-1])
    assert p.returncode == 1 and err["code"] == "github-failed" and "gh auth login" in err["fix"], p
    assert writes(d) == [] and len(db(d)["containers"]) == 4


def test_an_unknown_option_is_refused_before_anything_runs():
    d, env = world()
    p = run(d, env, "--force")
    assert p.returncode == 1 and json.loads(p.stderr)["code"] == "usage", p
    assert calls(d) == []


def test_the_command_is_in_factory_help_and_the_readme_table():
    help_text = subprocess.run(["bash", os.path.join(SF, "factory"), "help"], capture_output=True, text=True).stdout
    assert "reset-run" in help_text and "--apply" in help_text
    assert "`factory reset-run [--apply]`" in open(os.path.join(SF, "README.md")).read()


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_") and callable(v):
            v()
            print("ok", k)
