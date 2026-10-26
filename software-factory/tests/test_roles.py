#!/usr/bin/env python3
"""Generic roles (#102): `factory <role> [name] loop [-i] [--once] [--dry-run]`, one loop runner for the coding agent,
the dev manager and the product owner, and the project's role folder.

Runs the real factory, factory-loop.sh and hooks in a throwaway project (a bare origin and a clone) with a fake
`claude` (logs its arguments) and a fake `gh` (a JSON file). Waits are 0 minutes.
The rest is in roles.test.ts (#252); this case needs factory_doctor, and test_artifacts.py uses the helpers.
  python3 software-factory/tests/test_roles.py"""
import json, os, shutil, subprocess, sys, tempfile, time

SF = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
GIT = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}

CLAUDE = r'''#!/usr/bin/env bash
# Fake claude: logs its arguments; FAKE_CLAUDE_HOOK (a script) may react to the prompt.
# one write per line: sub-managers run side by side, and a long line printed in pieces can be split by another's
line="$(printf 'claude %s\n' "$(printf '%s' "$*" | tr '\n' ' ')")"; tmp="$(mktemp)"; printf '%s\n' "$line" > "$tmp"; cat "$tmp" >> "$LOOP_LOG"; rm -f "$tmp"
if [ -n "${FAKE_CLAUDE_HOOK:-}" ]; then bash "$FAKE_CLAUDE_HOOK" "$@"; exit $?; fi
exit 0
'''

GH = r'''#!/usr/bin/env python3
import json, os, re, sys
from urllib.parse import urlparse, parse_qs
db = json.load(open(os.environ["FAKE_DB"])); a = sys.argv[1:]
open(os.environ["LOOP_LOG"], "a").write("gh " + " ".join(a) + "\n")
if a[:1] != ["api"]: sys.exit(1)
path = [x for x in a[1:] if not x.startswith("-") and x not in ("GET", "PATCH", "POST", "PUT", "DELETE", "application/vnd.github+json")][0]
u = urlparse(path.replace("repos/{owner}/{repo}/", "")); p = u.path; q = parse_qs(u.query); page = int(q.get("page", ["1"])[0])
def out(x): print(json.dumps(x)); sys.exit(0)
if p == "user": out({"login": "me"})
if p == "issues":
    items = db.get("issues", [])
    if "labels" in q: items = [i for i in items if q["labels"][0] in [l["name"] for l in i.get("labels", [])]]
    out(items if page == 1 else [])
if p == "pulls": out(db.get("pulls", []) if page == 1 else [])
m = re.fullmatch(r"issues/(\d+)/comments", p)
if m: out([{"body": b, "created_at": "2026-10-25T10:00:00Z"} for b in db.get("comments", {}).get(m.group(1), [])] if page == 1 else [])
out([] if page == 1 else [])
'''


def sh(*a, cwd=None, check=True):
    return subprocess.run(a, cwd=cwd, check=check, capture_output=True, text=True, env={**os.environ, **GIT})


def project(cfg=None, db=None, files=None, profile=True):
    d = tempfile.mkdtemp()
    origin, work, bin_ = (os.path.join(d, x) for x in ("origin.git", "work", "bin"))
    sh("git", "init", "-q", "--bare", "-b", "main", origin)
    sh("git", "clone", "-q", origin, work)
    shutil.copytree(os.path.join(SF, "hooks"), os.path.join(work, ".claude", "hooks"),
                    ignore=shutil.ignore_patterns("__pycache__"))
    for f in ("factory", "factory-loop.sh"):
        shutil.copy(os.path.join(SF, f), os.path.join(work, f))
        os.chmod(os.path.join(work, f), 0o755)
    base = {"waitMinutes": 0, "agents": ["menelik", "taytu"], "roles": {"dev-manager": {"names": ["lead", "second"]},
            "product-owner": {"names": ["eleni", "sabla"]}}, "manager": {"busyMinutes": 0, "idleMinutes": 0},
            "docs": {}}
    base.pop("docs")
    base["roles"]["product-owner"].update({"busyMinutes": 0, "idleMinutes": 0})
    base.update(cfg or {})
    json.dump(base, open(os.path.join(work, ".claude", "factory.json"), "w"))
    os.makedirs(os.path.join(work, "docs"))
    open(os.path.join(work, "docs", "build-plan.md"), "w").write("# Plan\n\n- [ ] **1.1 First task**\n")
    open(os.path.join(work, "CLAUDE.md"), "w").write("rules\n")
    open(os.path.join(work, ".gitignore"), "w").write("__pycache__/\n")  # as install.sh writes it: a run that writes .pyc files leaves the tree clean
    if profile:
        os.makedirs(os.path.join(work, ".claude", "manager"))
        json.dump({"permissions": {"allow": ["Bash(gh api *)"]}}, open(os.path.join(work, ".claude", "manager", "settings.json"), "w"))
    for name, text in (files or {}).items():
        os.makedirs(os.path.dirname(os.path.join(work, name)) or work, exist_ok=True)
        open(os.path.join(work, name), "w").write(text)
    sh("git", "add", "-A", cwd=work)
    sh("git", "commit", "-qm", "start", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:main", cwd=work)
    os.makedirs(bin_)
    for name, body in (("claude", CLAUDE), ("gh", GH)):
        open(os.path.join(bin_, name), "w").write(body)
        os.chmod(os.path.join(bin_, name), 0o755)
    json.dump(db or {}, open(os.path.join(d, "db.json"), "w"))
    env = {**os.environ, **GIT, "PATH": f"{bin_}:{os.environ['PATH']}", "LOOP_LOG": os.path.join(d, "log"),
           "FAKE_DB": os.path.join(d, "db.json"), "FACTORY_REMOTE_CONTROL": "0", "HOME": d,
           "PYTHONDONTWRITEBYTECODE": "1"}  # the hooks run in the work tree: no .pyc may land in it
    for k in ("FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_ROLE", "FACTORY_NAME", "FACTORY_RELOAD_AGENT",
              "FACTORY_RELOAD_DIR", "FACTORY_RESUME", "CLAUDE_PROJECT_DIR"):
        env.pop(k, None)
    open(os.path.join(d, "log"), "w").close()
    return d, work, env


def factory(work, env, *args, timeout=90, stdin=subprocess.DEVNULL):
    return subprocess.run(["bash", "./factory", *args], cwd=work, env=env, capture_output=True, text=True,
                          timeout=timeout, stdin=stdin)


def log(env):
    return open(env["LOOP_LOG"]).read().splitlines()


def claude_calls(env):
    return [l for l in log(env) if l.startswith("claude ")]


def porcelain(work):
    return sh("git", "status", "--porcelain", cwd=work).stdout


UNREVIEWED = {"pulls": [{"number": 5, "title": "x", "draft": False, "head": {"sha": "a" * 40}, "user": {"login": "me"}}]}
PO_WORK = {"issues": [{"number": 7, "title": "Pick the palette", "labels": [{"name": "factory:needs-product"}]}]}


def test_doctor_reports_a_reads_path_that_does_not_exist():
    d, work, env = project(files={
        ".claude/factory/roles/dev-manager/README.md": "x\n",
        ".claude/factory/roles/dev-manager/reads.md": "- CLAUDE.md - rules\n- docs/nope.md#section - gone\n- docs/*.md - plan\n"})
    bin_ = os.path.join(d, "bin")
    for tool in ("git", "python3", "bash", "sh", "env", "uname", "dirname", "basename", "cat"):
        if shutil.which(tool) and not os.path.exists(os.path.join(bin_, tool)):
            os.symlink(shutil.which(tool), os.path.join(bin_, tool))
    open(os.path.join(work, ".claude", "settings.json"), "w").write("{}")
    p = factory(work, {**env, "PATH": bin_}, "doctor")
    fixes = [l for l in p.stdout.splitlines() if l.startswith("fix")]
    assert any("docs/nope.md" in l and "does not exist" in l for l in fixes), p.stdout
    assert not any("CLAUDE.md" in l or "docs/*.md" in l for l in fixes), fixes
