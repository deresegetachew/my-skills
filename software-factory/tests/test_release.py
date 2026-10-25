#!/usr/bin/env python3
"""The release build (#113): deterministic archive, manifest, checksum, refusals.  python3 software-factory/tests/test_release.py"""
import hashlib, importlib.util, json, os, shutil, subprocess, sys, tarfile, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT = os.path.join(REPO, "tools", "build_release.py")


def repo(version="1.2.3"):
    """A tiny git repo shaped like my-skills: software-factory with a kit, a test, a cache file and an executable."""
    d = tempfile.mkdtemp()
    for rel, body in {"software-factory/VERSION": version + "\n", "software-factory/README.md": "readme\n",
                      "software-factory/kit/factory": "#!/bin/sh\n", "software-factory/kit/.claude/hooks/a.py": "print(1)\n",
                      "software-factory/tests/test_x.py": "x\n", "software-factory/kit/__pycache__/a.pyc": "c\n",
                      "other-skill/SKILL.md": "not shipped\n"}.items():
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").write(body)
    os.chmod(os.path.join(d, "software-factory/kit/factory"), 0o755)
    for cmd in (["init", "-q", "-b", "main"], ["add", "-f", "-A"],
                ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]):
        subprocess.run(["git", "-C", d, *cmd], check=True)
    return d


def run(root, out, *extra):
    return subprocess.run([sys.executable, SCRIPT, "--root", root, "--out", out, *extra], capture_output=True, text=True)


def test_same_commit_gives_identical_bytes():
    d = repo()
    a, b = tempfile.mkdtemp(), tempfile.mkdtemp()
    assert run(d, a).returncode == 0
    time.sleep(1.1)  # a timestamp in the output would differ now
    assert run(d, b).returncode == 0
    name = "software-factory-1.2.3.tar.gz"
    assert open(os.path.join(a, name), "rb").read() == open(os.path.join(b, name), "rb").read()
    assert open(os.path.join(a, "SHA256SUMS")).read() == open(os.path.join(b, "SHA256SUMS")).read()


def test_archive_contents_owners_and_times_are_fixed():
    d = repo()
    out = tempfile.mkdtemp()
    run(d, out)
    with tarfile.open(os.path.join(out, "software-factory-1.2.3.tar.gz")) as t:
        names = t.getnames()
        assert names == sorted(names)
        assert names == ["software-factory-1.2.3/MANIFEST.json", "software-factory-1.2.3/README.md", "software-factory-1.2.3/VERSION",
                         "software-factory-1.2.3/kit/.claude/hooks/a.py", "software-factory-1.2.3/kit/factory"], names
        for m in t.getmembers():
            assert (m.uid, m.gid, m.uname, m.gname, m.mtime) == (0, 0, "", "", 0), m.name
        assert t.getmember("software-factory-1.2.3/kit/factory").mode == 0o755
        assert t.getmember("software-factory-1.2.3/README.md").mode == 0o644
    raw = open(os.path.join(out, "software-factory-1.2.3.tar.gz"), "rb").read()
    assert raw[4:8] == b"\0\0\0\0"  # gzip header mtime is zero


def test_manifest_matches_files_and_commit():
    d = repo()
    out = tempfile.mkdtemp()
    run(d, out)
    commit = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    with tarfile.open(os.path.join(out, "software-factory-1.2.3.tar.gz")) as t:
        m = json.load(t.extractfile("software-factory-1.2.3/MANIFEST.json"))
        assert (m["version"], m["tag"], m["source_commit"], m["schema"]) == ("1.2.3", "v1.2.3", commit, "factory-release/1")
        assert [f["path"] for f in m["files"]] == ["README.md", "VERSION", "kit/.claude/hooks/a.py", "kit/factory"]
        for f in m["files"]:
            data = t.extractfile("software-factory-1.2.3/" + f["path"]).read()
            assert f["sha256"] == hashlib.sha256(data).hexdigest() and f["size"] == len(data), f["path"]


def test_sha256sums_checks_out():
    d = repo()
    out = tempfile.mkdtemp()
    run(d, out)
    digest, name = open(os.path.join(out, "SHA256SUMS")).read().split()
    assert digest == hashlib.sha256(open(os.path.join(out, name), "rb").read()).hexdigest()
    assert name == "software-factory-1.2.3.tar.gz"


def commit_all(d):
    for cmd in (["add", "-f", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "links"]):
        subprocess.run(["git", "-C", d, *cmd], check=True)


def archive(d):
    out = tempfile.mkdtemp()
    p = run(d, out)
    assert p.returncode == 0, p.stderr
    return tarfile.open(os.path.join(out, "software-factory-1.2.3.tar.gz"))


def assert_no_links(t):
    links = [m.name for m in t.getmembers() if m.issym() or m.islnk() or not (m.isfile() or m.isdir())]
    assert links == [], f"the archive holds links or special files: {links}"


def test_a_symlink_forwarder_is_archived_as_a_real_file_with_its_targets_content_and_mode():
    d = repo()
    os.makedirs(os.path.join(d, "software-factory", "hooks"))
    open(os.path.join(d, "software-factory", "hooks", "b.py"), "w").write("print(2)\n")
    os.chmod(os.path.join(d, "software-factory", "hooks", "b.py"), 0o755)
    os.symlink("../../../hooks/b.py", os.path.join(d, "software-factory", "kit", ".claude", "hooks", "b.py"))
    commit_all(d)
    with archive(d) as t:
        assert_no_links(t)
        fwd = t.getmember("software-factory-1.2.3/kit/.claude/hooks/b.py")
        assert fwd.isfile() and fwd.mode == 0o755
        assert t.extractfile(fwd).read() == b"print(2)\n" == t.extractfile("software-factory-1.2.3/hooks/b.py").read()
        m = json.load(t.extractfile("software-factory-1.2.3/MANIFEST.json"))
        assert "kit/.claude/hooks/b.py" in [f["path"] for f in m["files"]]


def test_a_symlink_that_leaves_the_factory_folder_or_points_at_unshipped_code_is_refused():
    d = repo()
    os.symlink("../../other-skill/SKILL.md", os.path.join(d, "software-factory", "kit", "escape.md"))
    commit_all(d)
    refused(run(d, tempfile.mkdtemp()), "symlink")
    d = repo()
    os.symlink("../tests/test_x.py", os.path.join(d, "software-factory", "kit", "t.py"))
    commit_all(d)
    refused(run(d, tempfile.mkdtemp()), "symlink")


def test_the_real_checkout_builds_an_archive_with_the_moved_folders_and_no_links():
    # Builds from the working tree as it is now (copied into a scratch git repo), so a new forwarder or moved file
    # that would put a link into a release fails here, not at the first release.
    d = tempfile.mkdtemp()
    tracked = subprocess.run(["git", "-C", REPO, "ls-files", "-z"], capture_output=True, text=True, check=True).stdout.split("\0")
    for rel in filter(None, tracked):
        src = os.path.join(REPO, rel)
        if not os.path.lexists(src):
            continue
        dst = os.path.join(d, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.islink(src):
            os.symlink(os.readlink(src), dst)
        else:
            shutil.copy2(src, dst)
    subprocess.run(["git", "-C", d, "init", "-q", "-b", "main"], check=True)
    commit_all(d)
    out = tempfile.mkdtemp()
    p = run(d, out)
    assert p.returncode == 0, p.stderr
    version = open(os.path.join(REPO, "software-factory", "VERSION")).read().strip()
    with tarfile.open(os.path.join(out, f"software-factory-{version}.tar.gz")) as t:
        assert_no_links(t)
        names = set(t.getnames())
        top = f"software-factory-{version}/"
        for must in ("hooks/factory_guard.py", "ci/ci.sh", "ci/entrypoint.sh", "factory", "factory-loop.sh", "install.sh",
                     "kit/.claude/settings.json", "kit/.claude/hooks/factory_guard.py", "kit/.claude/ci/ci.sh", "kit/factory"):
            assert top + must in names, must
        assert t.getmember(top + "factory").mode == 0o755 and t.getmember(top + "kit/factory").mode == 0o755
        assert t.getmember(top + "kit/.claude/ci/entrypoint.sh").mode == t.getmember(top + "ci/entrypoint.sh").mode
        assert not [n for n in names if "/tests/" in n]
        assert t.extractfile(top + "kit/factory").read() == t.extractfile(top + "factory").read()


def refused(p, code):
    assert p.returncode == 1, p.stdout
    err = json.loads(p.stderr)
    assert err["code"] == code and err["message"] and err["fix"], err


def test_refuses_a_dirty_tree():
    d = repo()
    out = tempfile.mkdtemp()
    open(os.path.join(d, "software-factory", "README.md"), "a").write("edit\n")
    refused(run(d, out), "dirty_tree")
    assert os.listdir(out) == []


def test_refuses_an_untracked_file():
    d = repo()
    open(os.path.join(d, "software-factory", "new.txt"), "w").write("x")
    refused(run(d, tempfile.mkdtemp()), "dirty_tree")


def test_refuses_a_tag_that_does_not_match_the_version():
    d = repo("1.2.3")
    refused(run(d, tempfile.mkdtemp(), "--tag", "v1.2.4"), "tag_mismatch")
    assert run(d, tempfile.mkdtemp(), "--tag", "v1.2.3").returncode == 0


def test_refuses_a_bad_or_missing_version():
    refused(run(repo("one"), tempfile.mkdtemp()), "bad_version")
    d = repo()
    subprocess.run(["git", "-C", d, "rm", "-q", "software-factory/VERSION"], check=True)
    subprocess.run(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x"], check=True)
    refused(run(d, tempfile.mkdtemp()), "no_version")


def test_real_checkout_has_a_valid_version():
    spec = importlib.util.spec_from_file_location("br", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.VERSION_RE.match(mod.read_version(REPO))
