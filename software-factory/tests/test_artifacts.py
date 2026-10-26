#!/usr/bin/env python3
"""The project's artifacts and designs as reviewed copies in the repo (#104): the doctor's checks of the copies and a
role's reads.md naming a copy. These stay in Python until factory_doctor is ported (#252); the rest is in
artifacts.test.ts.

Runs the real factory in a throwaway project (see test_roles.py). The fetcher and the version lookup are fake commands
(shell scripts the test writes), so nothing here talks to a network.   python3 software-factory/tests/test_artifacts.py"""
import json, os, stat, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_roles import factory, project  # noqa: E402

URL = "https://claude.ai/artifact/SMWHUKAEcqo6VtbTzYrTZj"
FETCH = '#!/bin/sh\n# usage: fetch <url> <out>   (the fake exporter)\nmkdir -p "$2"; printf "<h1>PRD v$VERSION</h1>" > "$2/index.html"; printf "body{}" > "$2/style.css"\n'
INFO = '#!/bin/sh\necho "{\\"title\\": \\"MVP PRD\\", \\"updated\\": \\"$UPDATED\\", \\"version\\": \\"$VERSION\\"}"\n'


def art_project(fetch=True, info=True, files=None):
    d, work, env = project(files=files)
    tools = os.path.join(d, "tools")
    os.makedirs(tools)
    for name, body in (("fetch.sh", FETCH), ("info.sh", INFO)):
        path = os.path.join(tools, name)
        open(path, "w").write(body)
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    cfg_path = os.path.join(work, ".claude", "factory.json")
    cfg = json.load(open(cfg_path))
    cfg["artifacts"] = {}
    if fetch:
        cfg["artifacts"]["fetch"] = f"sh {tools}/fetch.sh {{url}} {{out}}"
    if info:
        cfg["artifacts"]["info"] = f"sh {tools}/info.sh {{url}}"
    json.dump(cfg, open(cfg_path, "w"))
    env = {**env, "VERSION": "3", "UPDATED": "2026-10-20T10:00:00Z"}
    return d, work, env


def art(work, env, *args, **over):
    return factory(work, {**env, **over}, "artifacts", *args)


def manifest(work):
    return json.load(open(os.path.join(work, "docs", "artifacts.json")))


def error(p):
    return json.loads(p.stderr.strip().splitlines()[-1])


def test_doctor_flags_a_copy_that_is_older_than_its_artifact_or_missing():
    d, work, env = art_project()
    art(work, env, "pull", URL, "docs/prd")
    ok = factory(work, env, "doctor")
    assert "artifact SMWHUKAEcqo6VtbTzYrTZj" in ok.stdout and "up to date" in ok.stdout, ok.stdout
    old = factory(work, {**env, "VERSION": "9", "UPDATED": "2026-10-25T00:00:00Z"}, "doctor")
    assert "OLDER than the artifact" in old.stdout and "factory artifacts pull" in old.stdout, old.stdout


def test_a_role_reads_md_names_an_artifact_through_its_repo_copy():
    d, work, env = art_project()
    folder = os.path.join(work, ".claude", "factory", "roles", "product-owner")
    os.makedirs(folder)
    open(os.path.join(folder, "reads.md"), "w").write("- docs/prd/index.html - the PRD as designed (a copy of an artifact)\n")
    before = factory(work, env, "doctor").stdout
    assert "docs/prd/index.html" in before and "does not exist" in before, before  # not pulled yet
    art(work, env, "pull", URL, "docs/prd")
    after = factory(work, env, "doctor").stdout
    assert "fix   .claude/factory/roles/product-owner/reads.md: docs/prd/index.html" not in after, after
    assert "ok    product-owner reads.md: every path exists" in after, after
