#!/usr/bin/env python3
"""The release archive carries the wiki beside the README, so the links work there too (#242).
python3 software-factory/tests/test_wiki_release.py"""
import glob, importlib.util, os, posixpath, re, shutil, subprocess, sys, tarfile, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SF = os.path.join(REPO, "software-factory")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def real_archive():
    """Builds an archive from the tracked files of this checkout, copied into a scratch git repo."""
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
    for cmd in (["init", "-q", "-b", "main"], ["add", "-f", "-A"],
                ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x"]):
        subprocess.run(["git", "-C", d, *cmd], check=True, capture_output=True)
    out = tempfile.mkdtemp()
    p = subprocess.run([sys.executable, os.path.join(REPO, "tools", "build_release.py"), "--root", d, "--out", out],
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    return glob.glob(os.path.join(out, "software-factory-*.tar.gz"))[0]


def test_the_archive_holds_every_wiki_page_with_the_same_mode_as_the_readme():
    pages = sorted(os.path.basename(p) for p in glob.glob(os.path.join(SF, "docs", "wiki", "*.md")))
    assert pages, "no wiki pages"
    with tarfile.open(real_archive()) as t:
        top = t.getnames()[0].split("/")[0] + "/"
        for page in pages:
            member = t.getmember(top + "docs/wiki/" + page)
            assert member.mode == 0o644 and member.isreg(), page
        assert t.getmember(top + "README.md").mode == 0o644
        assert t.extractfile(top + "docs/wiki/settings.md").read() == open(os.path.join(SF, "docs", "wiki", "settings.md"), "rb").read()


def test_the_relative_links_of_the_readme_and_the_wiki_resolve_inside_the_archive():
    with tarfile.open(real_archive()) as t:
        names = set(t.getnames())
        top = t.getnames()[0].split("/")[0] + "/"
        for name in sorted(n for n in names if n == top + "README.md" or re.match(re.escape(top) + r"docs/wiki/[^/]+\.md$", n)):
            text = t.extractfile(name).read().decode("utf-8")
            for target in re.findall(r"\]\(([^)\s#]+)(?:#[^)\s]*)?\)", text):
                if re.match(r"^[a-z][a-z0-9+.-]*:", target):
                    continue
                dest = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if not dest.startswith(top):
                    continue  # leaves the archive: the my-skills README at the repo root, which a release does not ship
                assert dest in names or any(n.startswith(dest + "/") for n in names), f"{name}: {target}"


def test_a_project_is_given_the_wiki_the_same_way_it_is_given_the_readme():
    fr = load("factory_release", os.path.join(SF, "hooks", "factory_release.py"))
    assert fr.classify("README.md") is None
    for page in glob.glob(os.path.join(SF, "docs", "wiki", "*.md")):
        assert fr.classify("docs/wiki/" + os.path.basename(page)) == fr.classify("README.md")


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
