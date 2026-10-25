#!/usr/bin/env python3
"""Build a software-factory release: a deterministic .tar.gz, its manifest, and SHA256SUMS (#113).

    python3 tools/build_release.py [--out dist] [--tag v1.2.3] [--root <checkout>]

Runs offline from a git checkout. Reads software-factory/VERSION; with --tag, refuses unless the tag is
"v" + that version. Refuses a checkout with uncommitted or untracked changes, so the archive always equals
a commit. The same commit gives byte-identical output: files are the git-tracked ones, sorted; owner, group and
mtime are fixed; gzip stores no timestamp or name.

Writes into --out:
  software-factory-<version>.tar.gz   everything under one folder, software-factory-<version>/
  SHA256SUMS                          `sha256sum -c` format, for the archive
Tracked symlinks (the forwarders at the old kit/ paths) are stored as regular files with their target's content
and mode: the archive holds no links, so unpacking it never depends on symlink support.
The archive holds MANIFEST.json (schema, version, source commit, every file with sha256, size, mode).
"""
import argparse, gzip, hashlib, io, json, os, re, subprocess, sys, tarfile

SCHEMA = "factory-release/1"
SRC = "software-factory"
# Excluded from the archive: the factory's own tests (they test my-skills, a project does not run them) and caches.
EXCLUDE_PREFIXES = (SRC + "/tests/",)
EXCLUDE_PARTS = ("__pycache__",)
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.]*)?$")
FIXED_MTIME = 0


class ReleaseError(Exception):
    def __init__(self, code, message, fix):
        super().__init__(f"{code}: {message} Fix: {fix}")
        self.code, self.message, self.fix = code, message, fix


def git(root, *args, text=True):
    p = subprocess.run(["git", "-C", root, *args], capture_output=True, text=text)
    if p.returncode:
        raise ReleaseError("git_failed", f"git {' '.join(args)} failed: {(p.stderr or '').strip()}",
                           "run this from a git checkout of my-skills.")
    return p.stdout


def read_version(root):
    path = os.path.join(root, SRC, "VERSION")
    try:
        version = open(path).read().strip()
    except OSError:
        raise ReleaseError("no_version", f"{SRC}/VERSION is missing.", "create it with the release number, e.g. 1.0.0.")
    if not VERSION_RE.match(version):
        raise ReleaseError("bad_version", f"{SRC}/VERSION is '{version}', not a version like 1.2.3.",
                           "write MAJOR.MINOR.PATCH (a -suffix such as -rc.1 is allowed).")
    return version


def check_tag(tag, version):
    if tag != "v" + version:
        raise ReleaseError("tag_mismatch", f"tag {tag} does not match {SRC}/VERSION ({version}).",
                           f"bump {SRC}/VERSION to {tag.lstrip('v')} in a merged PR, then tag again; or tag v{version}.")


def check_clean(root):
    dirty = git(root, "status", "--porcelain", "--untracked-files=all").strip()
    if dirty:
        raise ReleaseError("dirty_tree", "the working tree has uncommitted or untracked changes.",
                           "commit or remove them (git status shows which); a release is built from a commit only.")


def release_files(root):
    """(path, mode, source) for each tracked file that goes into the archive, sorted by path. `source` is the file
    whose bytes are archived. A tracked symlink (the forwarders at the old kit/ paths, #112) is archived as a
    regular file holding what it points to, so the archive never contains a link; a link that leaves software-factory/
    or points at something that is not shipped is refused."""
    out = git(root, "ls-files", "-s", "-z", "--", SRC)
    tracked = {}
    for rec in filter(None, out.split("\0")):
        meta, path = rec.split("\t", 1)
        tracked[path] = meta.split()[0]

    def shipped(path):
        return not (path.startswith(EXCLUDE_PREFIXES) or any(p in path.split("/") for p in EXCLUDE_PARTS))

    files = []
    for path, mode in tracked.items():
        if mode == "160000" or not shipped(path):
            continue
        source = path
        if mode == "120000":
            real = os.path.realpath(os.path.join(root, path))
            source = os.path.relpath(real, os.path.realpath(root)).replace(os.sep, "/")
            if not source.startswith(SRC + "/") or tracked.get(source) not in ("100644", "100755") or not shipped(source):
                raise ReleaseError("symlink", f"{path} is a symlink to {source}, which is not a regular file shipped in the release.",
                                   f"point it at a regular file inside {SRC}/ (not tests/), or remove the link.")
            mode = tracked[source]
        files.append((path, 0o755 if mode == "100755" else 0o644, source))
    return sorted(files)


def build(root, out_dir, tag=None):
    version = read_version(root)
    if tag:
        check_tag(tag, version)
    check_clean(root)
    commit = git(root, "rev-parse", "HEAD").strip()
    top = f"{SRC}-{version}"
    entries, manifest_files = [], []
    for path, mode, source in release_files(root):
        data = open(os.path.join(root, source), "rb").read()
        rel = path[len(SRC) + 1:]
        entries.append((f"{top}/{rel}", mode, data))
        manifest_files.append({"path": rel, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "mode": oct(mode)[2:]})
    manifest = {"schema": SCHEMA, "name": SRC, "version": version, "tag": "v" + version, "source_commit": commit,
                "files": manifest_files}
    entries.append((f"{top}/MANIFEST.json", 0o644, (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()))
    entries.sort(key=lambda e: e[0])

    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, mode, data in entries:
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), mode, FIXED_MTIME
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
    gz = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=gz, mtime=0, compresslevel=9) as g:
        g.write(raw.getvalue())

    os.makedirs(out_dir, exist_ok=True)
    name = f"{top}.tar.gz"
    with open(os.path.join(out_dir, name), "wb") as f:
        f.write(gz.getvalue())
    digest = hashlib.sha256(gz.getvalue()).hexdigest()
    with open(os.path.join(out_dir, "SHA256SUMS"), "w") as f:
        f.write(f"{digest}  {name}\n")
    return {"archive": os.path.join(out_dir, name), "sha256": digest, "version": version, "commit": commit,
            "files": len(manifest_files)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default="dist")
    ap.add_argument("--tag", help="refuse unless this equals v + software-factory/VERSION")
    ap.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    a = ap.parse_args(argv)
    try:
        r = build(os.path.abspath(a.root), a.out, a.tag)
    except ReleaseError as e:
        print(json.dumps({"code": e.code, "message": e.message, "fix": e.fix}), file=sys.stderr)
        return 1
    print(f"built {r['archive']} ({r['files']} files, version {r['version']}, commit {r['commit'][:12]})")
    print(f"sha256 {r['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
