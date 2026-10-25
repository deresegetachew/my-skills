#!/usr/bin/env python3
"""The project's artifacts and designs as reviewed copies in the repo (#104): `factory artifacts pull|status|list`, the
manifest, and a role's reads.md naming a copy.

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


def test_pull_copies_the_published_files_and_records_where_they_came_from():
    d, work, env = art_project()
    p = art(work, env, "pull", URL, "docs/prd")
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert open(os.path.join(work, "docs", "prd", "index.html")).read() == "<h1>PRD v3</h1>"
    assert os.path.exists(os.path.join(work, "docs", "prd", "style.css"))
    (e,) = manifest(work)["artifacts"]
    assert e["id"] == "SMWHUKAEcqo6VtbTzYrTZj" and e["url"] == URL and e["dest"] == "docs/prd", e
    assert e["title"] == "MVP PRD" and e["updated"] == "2026-10-20T10:00:00Z" and e["version"] == "3", e
    assert set(e["files"]) == {"index.html", "style.css"} and len(e["files"]["index.html"]) == 64, e
    assert e["pulledBy"] and e["pulledAt"].endswith("Z"), e
    assert "Review it and commit both" in p.stdout


def test_pull_takes_a_bare_id_and_the_default_folder_and_pulling_again_replaces_the_copy():
    d, work, env = art_project()
    assert art(work, env, "pull", "SMWHUKAEcqo6VtbTzYrTZj").returncode == 0
    assert os.path.exists(os.path.join(work, "docs", "artifacts", "SMWHUKAEcqo6VtbTzYrTZj", "index.html"))
    p = art(work, env, "pull", "https://claude.ai/code/artifact/SMWHUKAEcqo6VtbTzYrTZj?x=1", VERSION="4")
    assert p.returncode == 0, p.stderr
    assert "v4" in open(os.path.join(work, "docs", "artifacts", "SMWHUKAEcqo6VtbTzYrTZj", "index.html")).read()
    assert len(manifest(work)["artifacts"]) == 1, "one entry per artifact"


def test_a_copy_edited_by_hand_is_not_overwritten_without_force():
    d, work, env = art_project()
    art(work, env, "pull", URL, "docs/prd")
    open(os.path.join(work, "docs", "prd", "index.html"), "a").write("<p>my edit</p>")
    p = art(work, env, "pull", URL, "docs/prd", VERSION="4")
    e = error(p)
    assert p.returncode == 1 and e["code"] == "edited-locally" and "index.html" in e["message"] and "--force" in e["fix"], e
    assert "my edit" in open(os.path.join(work, "docs", "prd", "index.html")).read()
    p = art(work, env, "pull", URL, "docs/prd", "--force", VERSION="4")
    assert p.returncode == 0 and "my edit" not in open(os.path.join(work, "docs", "prd", "index.html")).read()


def test_pull_refuses_a_folder_outside_the_project_or_one_that_holds_other_files():
    d, work, env = art_project(files={"docs/other/readme.md": "x"})
    for dest in ("../elsewhere", "/tmp/elsewhere", "."):
        p = art(work, env, "pull", URL, dest)
        assert p.returncode == 1 and error(p)["code"] == "outside-project", (dest, p.stderr)
    p = art(work, env, "pull", URL, "docs/other")
    assert error(p)["code"] == "not-empty" and not os.path.exists(os.path.join(work, "docs", "artifacts.json"))
    bad = art(work, env, "pull", "not an artifact")
    assert error(bad)["code"] == "not-an-artifact" and "claude.ai/artifact" in error(bad)["fix"]


def test_without_a_fetcher_pull_says_how_to_import_an_export_made_by_hand():
    d, work, env = art_project(fetch=False, info=False)
    p = art(work, env, "pull", URL, "docs/prd")
    e = error(p)
    assert p.returncode == 1 and e["code"] == "no-fetcher" and f"factory artifacts pull {URL} docs/prd --from <folder>" in e["fix"], e
    export = os.path.join(d, "export")
    os.makedirs(export)
    open(os.path.join(export, "page.html"), "w").write("<p>exported</p>")
    ok = art(work, env, "pull", URL, "docs/prd", "--from", export, "--title", "MVP PRD", "--version", "7")
    assert ok.returncode == 0, ok.stderr
    (entry,) = manifest(work)["artifacts"]
    assert entry["title"] == "MVP PRD" and entry["version"] == "7" and list(entry["files"]) == ["page.html"], entry
    empty = os.path.join(d, "empty")
    os.makedirs(empty)
    assert error(art(work, env, "pull", "ZZZzzz111", "docs/z", "--from", empty))["code"] == "empty"


def test_a_failing_fetcher_leaves_the_project_as_it_was():
    d, work, env = art_project()
    cfg_path = os.path.join(work, ".claude", "factory.json")
    cfg = json.load(open(cfg_path))
    cfg["artifacts"]["fetch"] = "sh -c 'echo no network >&2; exit 4' x {url} {out}"
    json.dump(cfg, open(cfg_path, "w"))
    p = art(work, env, "pull", URL, "docs/prd")
    e = error(p)
    assert p.returncode == 1 and e["code"] == "fetch-failed" and "no network" in e["message"], e
    assert not os.path.exists(os.path.join(work, "docs", "prd")) and not os.path.exists(os.path.join(work, "docs", "artifacts.json"))


def test_dry_run_writes_nothing():
    d, work, env = art_project()
    p = art(work, env, "pull", URL, "docs/prd", "--dry-run")
    assert p.returncode == 0 and "would copy 2 file(s)" in p.stdout, (p.stdout, p.stderr)
    assert not os.path.exists(os.path.join(work, "docs", "prd")) and not os.path.exists(os.path.join(work, "docs", "artifacts.json"))


def test_status_says_which_copy_is_older_than_its_artifact():
    d, work, env = art_project()
    art(work, env, "pull", URL, "docs/prd")
    now = art(work, env, "status")
    assert now.returncode == 0 and "up to date" in now.stdout, now.stdout
    newer = art(work, env, "status", UPDATED="2026-10-24T09:00:00Z", VERSION="4")
    assert "OLDER than the artifact" in newer.stdout and "docs/prd" in newer.stdout, newer.stdout
    js = json.loads(art(work, env, "status", "--json", VERSION="4").stdout)
    assert js[0]["state"] == "older" and js[0]["dest"] == "docs/prd", js
    open(os.path.join(work, "docs", "prd", "style.css"), "a").write("x")
    assert "edited locally (style.css)" in art(work, env, "status").stdout
    import shutil
    shutil.rmtree(os.path.join(work, "docs", "prd"))
    assert "does not exist: pull it again" in art(work, env, "status").stdout


def test_status_without_a_way_to_ask_says_it_cannot_tell():
    d, work, env = art_project(info=False)
    art(work, env, "pull", URL, "docs/prd")
    out = art(work, env, "status").stdout
    assert "can't tell whether the artifact changed" in out and "OLDER" not in out, out


def test_list_and_an_empty_project():
    d, work, env = art_project()
    assert "no artifacts are pulled into this project" in art(work, env, "status").stdout
    art(work, env, "pull", URL, "docs/prd")
    out = art(work, env, "list").stdout
    assert "SMWHUKAEcqo6VtbTzYrTZj" in out and "MVP PRD" in out and "docs/prd" in out, out


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
