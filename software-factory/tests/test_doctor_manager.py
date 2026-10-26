#!/usr/bin/env python3
"""`factory doctor` and the dev manager's settings profile (#172): the note for a missing `.claude/manager/settings.json`
points at something that works. A project on a release that does not carry the file is told so, and to look for a newer
release, because `factory update` at that release answers "nothing to install"; a release that does carry it is
restored by `factory update`; a project with no pin keeps the old advice.
  python3 software-factory/tests/test_doctor_manager.py"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_doctor as doc  # noqa: E402

PROFILE = ".claude/manager/settings.json"


def pin(d, files):
    p = {"schema": "factory-pin/1", "repo": "acme/factory", "tag": "v0.1.0-alpha.1", "version": "0.1.0-alpha.1",
         "sha256": "0" * 64, "previous": None, "executable": [], "files": files}
    os.makedirs(os.path.join(d, ".claude", "factory"), exist_ok=True)
    json.dump(p, open(os.path.join(d, ".claude", "factory", "release.json"), "w"))


def manager_lines(d):
    p = doc.doctor(d, {**doc.machine(), "FACTORY_AGENTS": "taytu"})
    return [l for l in p.stdout.splitlines() if "manager profile" in l], p


def test_a_release_without_the_profile_is_named_and_a_newer_release_is_suggested():
    d = doc.project()
    pin(d, {".claude/hooks/factory_demo.py": "0" * 64})  # the pinned release lists no manager profile
    (line,), p = manager_lines(d)
    assert line.startswith("note") and "v0.1.0-alpha.1" in line and "doesn't carry" in line, line
    assert "factory releases" in line and "roles.dev-manager.profile" in line, line
    assert "nothing to install" not in line, line


def test_a_release_that_carries_the_profile_is_restored_by_update():
    d = doc.project()
    pin(d, {PROFILE: "0" * 64})
    (line,), p = manager_lines(d)
    assert line.startswith("note") and "run `factory update`" in line and "doesn't carry" not in line, line


def test_a_project_with_no_pin_keeps_the_old_advice():
    d = doc.project()
    (line,), p = manager_lines(d)
    assert line.startswith("note") and "run `factory update`" in line, line


def test_with_the_profile_there_all_is_ok():
    d = doc.project()
    os.makedirs(os.path.join(d, ".claude", "manager"))
    json.dump({"hooks": {}}, open(os.path.join(d, PROFILE), "w"))
    (line,), p = manager_lines(d)
    assert line.startswith("ok") and "resolves" in line, line


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_") and callable(v):
            v()
            print("ok", k)
