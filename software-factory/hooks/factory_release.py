#!/usr/bin/env python3
"""The release client (#113): a project gets the software factory from numbered GitHub releases of my-skills.

  factory version              installed release, the one main pins, the newest, and what changed since
  factory releases [--all]     the releases that exist, with dates and a one-line note
  factory update [version]     newest release (or the named one): download, check the checksum, install into the
                               project, refresh this machine's runner services, verify. Leaves the change uncommitted.
  factory rollback             back to the release that was installed before (offline, from the download cache)

The installed factory is committed in the project (decision in #113): hooks/ and ci/ go to .claude/hooks and
.claude/ci, `factory` and `factory-loop.sh` to the project root, the agents, skills and settings.json to .claude/.
`.claude/factory/release.json` is the pin: the release, its archive's SHA-256, the previous release and the hash of
every installed file. Changing it is how the whole team ends up on one release.

Stdlib only, so it also installs the first release into a project that has no factory yet:
  python3 <unpacked release>/hooks/factory_release.py update

Every error is `[code] message` and `Fix: ...`. Tests point FACTORY_RELEASE_API at a local fake of GitHub's API.
"""
import argparse, hashlib, http.client, json, os, re, shutil, subprocess, sys, tarfile, tempfile, urllib.error, urllib.parse, urllib.request, zlib

DEFAULT_REPO = "deresegetachew/my-skills"
PIN_PATH = ".claude/factory/release.json"
PIN_SCHEMA = "factory-pin/1"
MANIFEST_SCHEMA = "factory-release/1"
TAG_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.]*))?$")
SUM_RE = re.compile(r"^([0-9a-fA-F]{64}) [ *](\S.*)$")
AGENT_ENV = ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE")
MAX_MEMBERS, MAX_FILE, MAX_TOTAL = 5000, 20 * 1024 * 1024, 100 * 1024 * 1024
TEMPLATE_GITIGNORE = ("tmp/", "__pycache__/")


class FactoryError(Exception):
    def __init__(self, code, message, fix):
        super().__init__(f"[{code}] {message} Fix: {fix}")
        self.code, self.message, self.fix = code, message, fix


# --- versions and checksums ---------------------------------------------------------------------------------------

def normalize_tag(text):
    t = (text or "").strip()
    t = t if t.startswith("v") else "v" + t
    if not TAG_RE.match(t):
        raise FactoryError("bad_version", f"'{text}' is not a release like v1.4.0.",
                           "name a release as MAJOR.MINOR.PATCH, with or without the v (`factory releases` lists them).")
    return t


def sort_key(tag):
    m = TAG_RE.match(tag)
    major, minor, patch, pre = m.groups()
    return (int(major), int(minor), int(patch), 1 if pre is None else 0, pre or "")


def version_of(tag):
    return tag[1:]


def checksum_for(text, name):
    found = {}
    for line in text.splitlines():
        m = SUM_RE.match(line.strip("\r"))
        if m:
            found[m.group(2)] = m.group(1).lower()
    if not found:
        raise FactoryError("bad_checksum", "SHA256SUMS has no readable checksum line.",
                           "do not install this release; tell the owner, who can cut it again.")
    if name not in found:
        raise FactoryError("bad_checksum", f"SHA256SUMS has no checksum for {name}.",
                           "do not install this release; tell the owner, who can cut it again.")
    return found[name]


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# --- GitHub: the list of releases and the downloads --------------------------------------------------------------

class _KeepTokenHome(urllib.request.HTTPRedirectHandler):
    """A redirect to another host (GitHub's file storage) must not carry the token along."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlparse(newurl).netloc != urllib.parse.urlparse(req.full_url).netloc:
            for table in (new.headers, new.unredirected_hdrs):
                table.pop("Authorization", None)
        return new


def api_base():
    return os.environ.get("FACTORY_RELEASE_API", "https://api.github.com").rstrip("/")


def token():
    return os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""


def open_url(url, accept):
    headers = {"Accept": accept, "User-Agent": "software-factory-client"}
    if token():
        headers["Authorization"] = "Bearer " + token()
    try:
        return urllib.request.build_opener(_KeepTokenHome).open(urllib.request.Request(url, headers=headers), timeout=30)
    except urllib.error.HTTPError as e:
        if e.code in (403, 429) and e.headers.get("X-RateLimit-Remaining") == "0":
            raise FactoryError("rate_limited", "GitHub is limiting requests from this machine.",
                               "wait a few minutes, or set GH_TOKEN (for example `export GH_TOKEN=$(gh auth token)`) and try again.")
        raise FactoryError("http_error", f"GitHub answered {e.code} for {url}.",
                           "check the repository name (release.repo in .claude/factory.json) and try again.")
    except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
        raise FactoryError("no_network", f"could not reach GitHub ({getattr(e, 'reason', e)}).",
                           "check the connection and run it again. `factory rollback`, and `factory update <version>` for a release "
                           "this machine already downloaded, need no network.")


def list_releases(repo):
    """Published releases that carry a version tag, newest first (a draft is invisible to everyone but the owner)."""
    out = []
    for page in range(1, 11):
        with open_url(f"{api_base()}/repos/{repo}/releases?per_page=100&page={page}", "application/vnd.github+json") as r:
            try:
                batch = json.loads(r.read().decode("utf-8"))
            except ValueError:
                raise FactoryError("http_error", "GitHub's answer was not a list of releases.", "try again in a minute.")
        for item in batch:
            tag = item.get("tag_name", "")
            if item.get("draft") or not TAG_RE.match(tag):
                continue
            out.append({"tag": tag, "version": version_of(tag), "date": (item.get("published_at") or "")[:10],
                        "notes": item.get("body") or "", "pre": bool(item.get("prerelease")),
                        "assets": {a["name"]: a.get("browser_download_url", "") for a in item.get("assets", []) if "name" in a}})
        if len(batch) < 100:
            break
    return sorted(out, key=lambda r: sort_key(r["tag"]), reverse=True)


def newest(releases):
    full = [r for r in releases if not r["pre"]]
    if not full:
        raise FactoryError("no_releases", "there is no published release yet (pre-releases are only used when named).",
                           "ask the owner to cut one, or name a pre-release: `factory update v1.0.0-rc.1`.")
    return full[0]


def find_release(releases, tag):
    for r in releases:
        if r["tag"] == tag:
            return r
    have = ", ".join(r["tag"] for r in releases[:8]) or "none"
    raise FactoryError("no_such_release", f"there is no release {tag}.", f"pick one that exists ({have}); `factory releases` lists them.")


def note_line(notes):
    lines = [l.strip() for l in notes.splitlines() if l.strip()]
    for l in lines:
        if l.startswith("- "):
            return l[2:]
    return lines[0] if lines else ""


def note_bullets(notes):
    return [l.strip()[2:] for l in notes.splitlines() if l.strip().startswith("- ")]


def download(url, dest):
    """Stream `url` to `dest` through a .part file; a short or failed transfer leaves nothing behind."""
    part = dest + ".part"
    try:
        with open_url(url, "application/octet-stream") as r, open(part, "wb") as f:
            want = r.headers.get("Content-Length")
            got = 0
            while True:
                try:
                    block = r.read(1 << 20)
                except (http.client.HTTPException, OSError) as e:
                    raise FactoryError("download_interrupted", f"the download stopped part way ({e}).", "run the command again.")
                if not block:
                    break
                f.write(block)
                got += len(block)
        if want is not None and got != int(want):
            raise FactoryError("download_interrupted", f"the download stopped part way ({got} of {want} bytes).", "run the command again.")
        os.replace(part, dest)
    except FactoryError:
        remove(part)
        raise
    except OSError as e:
        remove(part)
        raise FactoryError("download_interrupted", f"the download could not be saved ({e}).", "check the disk space and run the command again.")


def remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def cache_folder(repo, tag):
    base = os.environ.get("FACTORY_CACHE_DIR") or os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "software-factory")
    return os.path.join(base, repo.replace("/", "__"), tag)


def archive_name(tag):
    return f"software-factory-{version_of(tag)}.tar.gz"


def cached_archive(folder, tag, expect_sha):
    """The downloaded archive when it is there and its checksum holds, else None. A cache that disagrees with the
    pin's recorded checksum is an error, never silently replaced."""
    name = archive_name(tag)
    path, sums = os.path.join(folder, name), os.path.join(folder, "SHA256SUMS")
    if not (os.path.isfile(path) and os.path.isfile(sums)):
        return None
    try:
        want = checksum_for(open(sums).read(), name)
    except (FactoryError, OSError):
        want = None
    have = sha256_file(path)
    if want is None or have != want:
        shutil.rmtree(folder, ignore_errors=True)  # a damaged cache: download it again
        return None
    if expect_sha and have != expect_sha:
        raise FactoryError("bad_checksum", f"the downloaded {name} does not match the checksum this project's pin records for {tag}.",
                           f"delete {folder} and try again; if it repeats, do not install and tell the owner.")
    return path


def fetch_archive(repo, tag, release=None, expect_sha=None):
    """(path of the verified archive, release or None). Uses the download cache when it holds the release."""
    folder = cache_folder(repo, tag)
    hit = cached_archive(folder, tag, expect_sha)
    if hit:
        return hit, release
    if release is None:
        release = find_release(list_releases(repo), tag)
    name = archive_name(tag)
    for need in (name, "SHA256SUMS"):
        if not release["assets"].get(need):
            raise FactoryError("incomplete_release", f"release {tag} has no {need}.",
                               "do not install it; tell the owner, who can fix or cut the release again.")
    os.makedirs(folder, exist_ok=True)
    sums_path, archive_path = os.path.join(folder, "SHA256SUMS"), os.path.join(folder, name)
    try:
        download(release["assets"]["SHA256SUMS"], sums_path + ".new")
        download(release["assets"][name], archive_path + ".new")
        want = checksum_for(open(sums_path + ".new").read(), name)
        have = sha256_file(archive_path + ".new")
        if have != want:
            raise FactoryError("bad_checksum", f"the downloaded {name} ({tag}) has checksum {have[:12]}..., SHA256SUMS says {want[:12]}...",
                               "the download is damaged or was changed. Nothing was installed. Run it again; if it repeats, tell the owner.")
        if expect_sha and have != expect_sha:
            raise FactoryError("bad_checksum", f"{name} does not match the checksum this project's pin records for {tag}.",
                               "do not install it; tell the owner.")
        os.replace(sums_path + ".new", sums_path)
        os.replace(archive_path + ".new", archive_path)
    except BaseException:
        remove(sums_path + ".new")
        remove(archive_path + ".new")
        try:
            os.rmdir(folder)
        except OSError:
            pass
        raise
    return archive_path, release


# --- unpacking: nothing leaves the archive's own folder ------------------------------------------------------------

def unpack(path, tag):
    """{relative path: (bytes, mode)} of a release archive, after checking every member and the manifest."""
    version, top = version_of(tag), f"software-factory-{version_of(tag)}"
    files, total = {}, 0
    try:
        with tarfile.open(path, "r:gz") as tar:
            for count, m in enumerate(tar):
                if count >= MAX_MEMBERS:
                    raise FactoryError("unsafe_archive", f"the archive has more than {MAX_MEMBERS} entries.", "do not install it; tell the owner.")
                name = m.name
                parts = name.split("/")
                if name.startswith("/") or "\\" in name or any(p in ("", ".", "..") for p in parts):
                    raise FactoryError("unsafe_archive", f"the archive holds the path '{name}', which could leave its folder.", "do not install it; tell the owner.")
                if parts[0] != top:
                    raise FactoryError("unsafe_archive", f"'{name}' is outside the folder {top}/.", "do not install it; tell the owner.")
                if m.isdir():
                    continue
                if not m.isreg():
                    raise FactoryError("unsafe_archive", f"'{name}' is a link or special file; a release holds only plain files.", "do not install it; tell the owner.")
                if m.size > MAX_FILE or total + m.size > MAX_TOTAL:
                    raise FactoryError("unsafe_archive", f"'{name}' makes the archive larger than the limit.", "do not install it; tell the owner.")
                rel = name[len(top) + 1:]
                if rel in files:
                    raise FactoryError("unsafe_archive", f"'{name}' appears twice.", "do not install it; tell the owner.")
                data = tar.extractfile(m).read()
                total += len(data)
                files[rel] = (data, 0o755 if m.mode & 0o111 else 0o644)
    except (tarfile.TarError, EOFError, zlib.error, OSError) as e:
        raise FactoryError("bad_archive", f"the archive cannot be read ({e}).", "do not install it; tell the owner, who can cut it again.")
    return files, read_manifest(files, version)


def read_manifest(files, version):
    if "MANIFEST.json" not in files:
        raise FactoryError("bad_archive", "the archive has no MANIFEST.json.", "do not install it; tell the owner.")
    try:
        manifest = json.loads(files["MANIFEST.json"][0].decode("utf-8"))
        listed = {f["path"]: f for f in manifest["files"]}
    except (ValueError, KeyError, TypeError):
        raise FactoryError("bad_archive", "MANIFEST.json cannot be read.", "do not install it; tell the owner.")
    if manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("version") != version:
        raise FactoryError("bad_archive", f"MANIFEST.json is for {manifest.get('schema')} {manifest.get('version')}, not {MANIFEST_SCHEMA} {version}.",
                           "do not install it; tell the owner.")
    present = set(files) - {"MANIFEST.json"}
    if present != set(listed):
        extra, missing = sorted(present - set(listed)), sorted(set(listed) - present)
        raise FactoryError("bad_archive", f"the files do not match MANIFEST.json (not listed: {extra[:3]}, missing: {missing[:3]}).", "do not install it; tell the owner.")
    for rel, entry in listed.items():
        if sha256_bytes(files[rel][0]) != entry.get("sha256"):
            raise FactoryError("bad_archive", f"{rel} does not match the checksum in MANIFEST.json.", "do not install it; tell the owner.")
    return manifest


# --- what goes where in a project --------------------------------------------------------------------------------------

def classify(rel):
    """("engine", target) for what the factory owns in a project, ("template", target) for what a project fills in and
    is only given on a first install, None for what is not installed (docs, the installer, the kit/ forwarders)."""
    if rel in ("factory", "factory-loop.sh"):
        return "engine", rel
    for src, dst in (("hooks/", ".claude/hooks/"), ("ci/", ".claude/ci/")):
        if rel.startswith(src):
            return "engine", dst + rel[len(src):]
    if rel.startswith("kit/.claude/"):
        sub = rel[len("kit/.claude/"):]
        if sub.startswith(("hooks/", "ci/")):
            return None  # the forwarders to the folders above
        if sub.startswith(("agents/", "skills/")) or sub == "settings.json":
            return "engine", ".claude/" + sub
        return "template", ".claude/" + sub
    if rel in ("kit/factory", "kit/factory-loop.sh"):
        return None
    if rel.startswith("kit/"):
        return "template", rel[len("kit/"):]
    return None


def plan(files):
    engine, templates = {}, {}
    for rel in sorted(files):
        c = classify(rel)
        if c:
            (engine if c[0] == "engine" else templates)[c[1]] = rel
    return engine, templates


# --- the project ---------------------------------------------------------------------------------------------------------

def git(root, *args, check=True):
    p = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)
    if check and p.returncode:
        raise FactoryError("git_failed", f"git {' '.join(args)} failed: {p.stderr.strip()}", "run this inside the project's git repository.")
    return p


def project_root():
    p = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if p.returncode:
        raise FactoryError("not_a_repo", "this is not inside a git repository.", "run it inside the project's folder.")
    return p.stdout.strip()


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except ValueError as e:
        raise FactoryError("bad_pin", f"{path} is not valid JSON ({e}).", "restore it from git (`git checkout -- " + os.path.basename(path) + "`) or delete it and name a release.")


def read_pin(root):
    pin = read_json(os.path.join(root, PIN_PATH))
    if pin is None:
        return None
    if pin.get("schema") != PIN_SCHEMA or not TAG_RE.match(str(pin.get("tag", ""))) or not isinstance(pin.get("files"), dict):
        raise FactoryError("bad_pin", f"{PIN_PATH} is not a pin this client understands.", f"restore it from git, or run `factory update <version>` after deleting it.")
    return pin


def repo_name(root, pin):
    if os.environ.get("FACTORY_RELEASE_REPO"):
        return os.environ["FACTORY_RELEASE_REPO"]
    if pin and pin.get("repo"):
        return pin["repo"]
    try:
        cfg = read_json(os.path.join(root, ".claude", "factory.json")) or {}
    except FactoryError:
        cfg = {}
    repo = (cfg.get("release") or {}).get("repo") if isinstance(cfg.get("release"), dict) else None
    return repo or DEFAULT_REPO


def refuse_agent():
    for var in AGENT_ENV:
        if var in os.environ:
            raise FactoryError("agent_session", "an agent session cannot change the factory (the PR gate reads these files).",
                               "run `factory update` yourself in a terminal, then commit it in a pull request.")


def dirty_paths(root):
    out = git(root, "status", "--porcelain", "--untracked-files=all").stdout
    paths = []
    for line in out.splitlines():
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ")[1]
        paths.append(path.strip('"'))
    return paths


def is_symlinked(root, rel):
    cur = root
    for part in rel.split("/"):
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            return True
    return False


def pinned_problems(root, pin):
    """Why the files on disk are not what the pin says: missing, changed, or not executable. Empty when they match."""
    bad = []
    for rel, sha in sorted(pin["files"].items()):
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            bad.append(f"{rel} is missing")
        elif sha256_file(path) != sha:
            bad.append(f"{rel} differs from {pin['tag']}")
        elif rel in pin.get("executable", []) and not os.access(path, os.X_OK):
            bad.append(f"{rel} is not executable")
    return bad


def write_file(path, data, mode):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = os.path.join(os.path.dirname(path), "." + os.path.basename(path) + ".factory-tmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def install_files(root, files, manifest, tag, archive_sha, old_pin, repo):
    """Write the release into the project. Returns {added, changed, removed, kept_local}; undoes its work on a failure."""
    engine, templates = plan(files)
    for target in sorted(engine):
        if is_symlinked(root, target):
            raise FactoryError("linked_install", f"{target} is a link (this project takes the factory from the my-skills submodule).",
                               "a release does not overwrite links. Move this project off the submodule first (the migration is a separate reviewed pull request); "
                               "until then keep using `factory update`.")
    first = not os.path.exists(os.path.join(root, ".claude", "factory.json"))
    old_files = (old_pin or {}).get("files", {})
    backups, written_templates, result = {}, [], {"added": [], "changed": [], "removed": [], "kept_local": []}

    def remember(path):
        if path not in backups:
            if os.path.lexists(path):
                with open(path, "rb") as f:
                    backups[path] = (f.read(), os.stat(path).st_mode & 0o7777)
            else:
                backups[path] = None

    try:
        for target in sorted(engine):
            data, mode = files[engine[target]]
            path = os.path.join(root, target)
            exists = os.path.isfile(path)
            current = open(path, "rb").read() if exists else None
            if current == data and (os.stat(path).st_mode & 0o111 != 0) == bool(mode & 0o111):
                continue
            if exists and old_files.get(target) and sha256_bytes(current) != old_files[target]:
                result["kept_local"].append(target)  # replaced; reported so the reviewer sees it in the diff
            remember(path)
            write_file(path, data, mode)
            result["changed" if exists else "added"].append(target)
        for target in sorted(set(old_files) - set(engine)):
            path = os.path.join(root, target)
            if os.path.isfile(path) and not is_symlinked(root, target):
                remember(path)
                os.remove(path)
                result["removed"].append(target)
                folder = os.path.dirname(path)
                while folder != root and not os.listdir(folder):
                    os.rmdir(folder)
                    folder = os.path.dirname(folder)
        if first:
            for target in sorted(templates):
                data, mode = files[templates[target]]
                path = os.path.join(root, target)
                if target == ".gitignore":
                    remember(path)
                    have = open(path).read() if os.path.isfile(path) else ""
                    lines = have.split()
                    add = [l for l in data.decode().split() + list(TEMPLATE_GITIGNORE) if l not in lines]
                    if add:
                        write_file(path, (have + ("" if not have or have.endswith("\n") else "\n") + "\n".join(dict.fromkeys(add)) + "\n").encode(), 0o644)
                        written_templates.append(target)
                elif not os.path.lexists(path):
                    remember(path)
                    write_file(path, data, mode)
                    result["added"].append(target)
                    written_templates.append(target)
        pin = {"schema": PIN_SCHEMA, "repo": repo, "tag": tag, "version": version_of(tag), "sha256": archive_sha,
               "source_commit": manifest.get("source_commit", ""),
               "previous": ({"tag": old_pin["tag"], "version": old_pin["version"], "sha256": old_pin["sha256"]} if old_pin and old_pin["tag"] != tag
                            else (old_pin or {}).get("previous")),
               "templates": sorted(set((old_pin or {}).get("templates", [])) | set(written_templates)),
               "executable": sorted(t for t in engine if files[engine[t]][1] & 0o111),
               "files": {t: sha256_bytes(files[engine[t]][0]) for t in sorted(engine)}}
        path = os.path.join(root, PIN_PATH)
        remember(path)
        write_file(path, (json.dumps(pin, indent=2, sort_keys=True) + "\n").encode(), 0o644)
    except BaseException as e:
        for path, saved in backups.items():
            try:
                if saved is None:
                    remove(path)
                else:
                    write_file(path, saved[0], saved[1])
            except OSError:
                pass
        if isinstance(e, OSError):
            raise FactoryError("install_failed", f"could not write the files ({e}); the project was put back as it was.", "check the disk space and permissions, then run it again.")
        raise
    return result


# --- this machine ----------------------------------------------------------------------------------------------------------

def run_ci(root, *args, timeout=900):
    p = subprocess.run(["bash", os.path.join(root, ".claude", "ci", "ci.sh"), *args], cwd=root, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


def refresh_heartbeat(root):
    """Restart the heartbeat daemon when it is installed here: it is one long-running process, so it keeps running the
    code it started with until it is restarted. Says nothing when there is none."""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "factory_heartbeat_service.py")
    if not os.path.isfile(script):
        return []
    p = subprocess.run([sys.executable, script, "restart"], cwd=root, capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise FactoryError("services_failed", "restarting the heartbeat daemon failed:\n" + "\n".join("    " + l for l in (p.stdout + p.stderr).strip().splitlines()[-6:]),
                           "run `factory heartbeat install`, then `factory update` again.")
    return [l.strip() for l in p.stdout.splitlines() if l.strip()]


def refresh_services(root):
    """Reinstall the CI runner services when this machine has some and they are older than the checkout."""
    lines = refresh_runners(root)
    return lines + refresh_heartbeat(root)


def refresh_runners(root):
    if not os.path.isfile(os.path.join(root, ".claude", "ci", "ci.sh")):
        return ["runner services: this release has none to refresh"]
    rc, out = run_ci(root, "names", timeout=120)
    if rc != 0:
        return [f"runner services: not checked here ({out.splitlines()[0] if out else 'ci.sh names failed'})"]
    rc, out = run_ci(root, "stale")
    if rc == 0:
        return ["runner services: nothing to refresh"]
    if rc != 3:
        raise FactoryError("services_failed", f"could not tell whether the runner services are older ({out[:300]}).", "run `factory ci status` to see why.")
    older = [l.strip() for l in out.splitlines() if l.strip()]
    rc, out = run_ci(root, "install")
    if rc != 0:
        raise FactoryError("services_failed", "refreshing the runner services failed:\n" + "\n".join("    " + l for l in out.splitlines()[-8:]),
                           "run `factory ci install` and read what it says; then run `factory update` again.")
    return ["runner services: refreshed with `factory ci install` (" + "; ".join(older[:4]) + ")"]


def verify_machine(root, pin):
    """What must be true before saying the update worked. A list of problems; empty means verified."""
    problems = pinned_problems(root, pin)
    settings = os.path.join(root, ".claude", "settings.json")
    if os.path.isfile(settings):
        text = open(settings).read()
        try:
            json.loads(text)
        except ValueError as e:
            problems.append(f".claude/settings.json is not valid JSON ({e})")
        for hook in sorted(set(re.findall(r"\.claude/hooks/[\w.-]+", text))):
            if not os.path.isfile(os.path.join(root, hook)):
                problems.append(f".claude/settings.json runs {hook}, which is not there")
    for rel in sorted(pin["files"]):
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            continue
        if rel.endswith(".py"):
            try:
                compile(open(path, "rb").read(), rel, "exec")
            except SyntaxError as e:
                problems.append(f"{rel} does not compile ({e.msg}, line {e.lineno})")
        elif rel.endswith(".sh") or rel in ("factory", "factory-loop.sh"):
            if subprocess.run(["bash", "-n", path], capture_output=True).returncode:
                problems.append(f"{rel} does not parse as bash")
    if os.path.isfile(os.path.join(root, ".claude", "ci", "ci.sh")) and run_ci(root, "names", timeout=120)[0] == 0:
        rc, out = run_ci(root, "check", timeout=120)
        if rc != 0:
            problems += [l.strip() for l in out.splitlines() if l.strip()] or ["factory ci check failed"]
    return problems


# --- commands ---------------------------------------------------------------------------------------------------------------

def say(text=""):
    print(text)


def submodule_line(root):
    p = git(root, "config", "-f", ".gitmodules", "--get-regexp", r"submodule\..*\.path", check=False)
    for line in p.stdout.splitlines():
        path = line.split(None, 1)[1] if " " in line else ""
        if "my-skills" in path:
            sha = git(os.path.join(root, path), "rev-parse", "--short", "HEAD", check=False).stdout.strip() if os.path.isdir(os.path.join(root, path)) else ""
            return f"{path} at {sha or 'not checked out'}"
    return None


def pinned_on_main(root):
    cfg = read_json(os.path.join(root, ".claude", "factory.json")) or {}
    ref = f"origin/{cfg.get('mainBranch', 'main')}"
    if git(root, "rev-parse", "--verify", "-q", ref, check=False).returncode:
        return None, f"unknown ({ref} is not here; run `git fetch`)"
    p = git(root, "show", f"{ref}:{PIN_PATH}", check=False)
    if p.returncode:
        return None, f"none yet on {ref}"
    try:
        return json.loads(p.stdout), None
    except ValueError:
        return None, f"unreadable on {ref}"


def changes_between(releases, old_tag, new_tag):
    """Notes bullets of the releases after old_tag up to new_tag, newest first (empty when going back)."""
    lo = sort_key(old_tag) if old_tag else None
    hi = sort_key(new_tag)
    out = []
    for r in releases:
        k = sort_key(r["tag"])
        if (k == hi) if lo is None else (lo < k <= hi):  # a first install shows only its own release's notes
            out += [(r["tag"], b) for b in note_bullets(r["notes"])] or [(r["tag"], note_line(r["notes"]))]
    return out


def cmd_version(args):
    root = project_root()
    pin = read_pin(root)
    info = {"installed": None, "pinned": None, "newest": None, "submodule": None}
    emit = (lambda text="": None) if args.json else print  # --json prints only the JSON
    emit("Software factory")
    if pin:
        bad = pinned_problems(root, pin)
        info["installed"] = {"tag": pin["tag"], "ok": not bad, "differs": bad}
        emit(f"  Installed  {pin['tag']}" + ("  (the files match the pin)" if not bad else f"  ({len(bad)} file(s) differ from the pin)"))
        for b in bad[:8]:
            emit(f"             - {b}")
        if pin.get("previous"):
            emit(f"  Before     {pin['previous']['tag']}  (factory rollback)")
    else:
        sub = submodule_line(root)
        info["submodule"] = sub
        emit("  Installed  no release pin yet" + (f": this project takes the factory from the submodule {sub}" if sub else " (the factory files here were copied or linked by install.sh)"))
    main_pin, why = pinned_on_main(root)
    info["pinned"] = {"tag": main_pin["tag"]} if main_pin else None
    emit("  Pinned     " + (f"{main_pin['tag']}  (on origin/main)" if main_pin else why))
    newest_release, releases = None, []
    try:
        releases = list_releases(repo_name(root, pin))
        newest_release = newest(releases)
        info["newest"] = {"tag": newest_release["tag"], "date": newest_release["date"]}
        emit(f"  Newest     {newest_release['tag']}  ({newest_release['date']})")
    except FactoryError as e:
        emit(f"  Newest     unknown ({e.message.rstrip('.')})")
    if args.json:
        print(json.dumps(info, indent=2, sort_keys=True))
        return 0
    if newest_release and pin and sort_key(newest_release["tag"]) > sort_key(pin["tag"]):
        emit()
        emit(f"Since {pin['tag']}:")
        for tag, line in changes_between(releases, pin["tag"], newest_release["tag"])[:15]:
            emit(f"  - {line}  ({tag})")
        emit("Update this project with: factory update")
    elif newest_release and not pin:
        emit()
        emit("To take the factory from releases instead: factory update --release")
    elif newest_release:
        emit()
        emit("This project has the newest release.")
    if main_pin and pin and main_pin["tag"] != pin["tag"]:
        emit(f"\nmain pins {main_pin['tag']} but this checkout has {pin['tag']}: pull, then run `factory update`.")
    return 0


def cmd_releases(args):
    root = project_root()
    pin = read_pin(root)
    releases = list_releases(repo_name(root, pin))
    if not releases:
        say("There is no published release yet.")
        return 0
    main_pin, _ = pinned_on_main(root)
    top = next((r["tag"] for r in releases if not r["pre"]), None)
    shown = releases if args.all else releases[:15]
    for r in shown:
        marks = [m for m, on in (("installed", pin and pin["tag"] == r["tag"]), ("pinned on main", main_pin and main_pin["tag"] == r["tag"]),
                                 ("newest", r["tag"] == top), ("pre-release", r["pre"])) if on]
        say(("* " if pin and pin["tag"] == r["tag"] else "  ") + f"{r['tag']:<14}{r['date']:<12}{note_line(r['notes'])[:70]}" + (f"  ({', '.join(marks)})" if marks else ""))
    if len(releases) > len(shown):
        say(f"  ... {len(releases) - len(shown)} older (factory releases --all)")
    return 0


def check_clean(root, pin):
    """Refuse a dirty tree, except one that only holds the factory files a first run just wrote (a repeat is safe)."""
    dirty = dirty_paths(root)
    if not dirty:
        return False
    managed = (set(pin["files"]) | set(pin.get("templates", [])) | {PIN_PATH}) if pin else set()
    if pin and all(p in managed for p in dirty):
        return True  # only the factory's own files: fine if this turns out to be a repeat
    shown = ", ".join(dirty[:6]) + (f" and {len(dirty) - 6} more" if len(dirty) > 6 else "")
    raise FactoryError("dirty_tree", f"the working tree has uncommitted changes ({shown}).",
                       "commit them, or put them aside with `git stash -u`, then run it again. Nothing was changed.")


def cmd_update(args, rollback=False):
    root = project_root()
    command = "rollback" if rollback else "update"
    refuse_agent()
    pin = read_pin(root)
    repo = repo_name(root, pin)
    dirty_ok = check_clean(root, pin)
    old_tag = pin["tag"] if pin else None
    archive, release, releases, expect = None, None, [], None
    if rollback:
        if not pin or not pin.get("previous"):
            raise FactoryError("no_previous", "there is no earlier release recorded to go back to.",
                               "name the one you want: `factory update v1.3.2` (`factory releases` lists them).")
        tag, expect = pin["previous"]["tag"], pin["previous"].get("sha256")
    elif args.version:
        tag = normalize_tag(args.version)
    else:
        releases = list_releases(repo)
        release = newest(releases)
        tag = release["tag"]
    same = bool(pin) and pin["tag"] == tag
    drift = pinned_problems(root, pin) if same else []
    if dirty_ok and (not same or drift):
        raise FactoryError("dirty_tree", "the working tree has uncommitted changes to the factory's own files.",
                           "commit them (or `git checkout -- .claude factory factory-loop.sh` to drop them), then run it again. Nothing was changed.")
    say(f"factory {command}" + (f"  ({repo})" if args.verbose else ""))
    if same and not drift:
        say(f"  This project is already on {tag}; nothing to install.")
        installed = None
    else:
        archive, release = fetch_archive(repo, tag, release, expect)
        files, manifest = unpack(archive, tag)
        archive_sha = sha256_file(archive)
        installed = install_files(root, files, manifest, tag, archive_sha, pin, repo)
        if same:
            say(f"  {tag} was already installed; {len(drift)} file(s) differed from the pin and were repaired:")
            for d in drift[:8]:
                say(f"    - {d}")
        else:
            say(f"  {old_tag or 'no release'} -> {tag}" + ("  (going back)" if old_tag and sort_key(tag) < sort_key(old_tag) else ""))
            if not releases:
                try:
                    releases = list_releases(repo)
                except FactoryError:
                    releases = []
            if releases and not (old_tag and sort_key(tag) < sort_key(old_tag)):
                for rtag, line in changes_between(releases, old_tag, tag)[:15]:
                    say(f"    - {line}  ({rtag})")
            elif not releases:
                say("    (the release notes need the network; `factory releases` shows them later)")
        total = len(installed["added"]) + len(installed["changed"]) + len(installed["removed"])
        say(f"  Installed {tag}: {len(installed['added'])} new, {len(installed['changed'])} changed, {len(installed['removed'])} removed file(s).")
        for t in installed["removed"][:8]:
            say(f"    removed {t}")
        for t in installed["kept_local"][:8]:
            say(f"    note: {t} had local changes; the release's version replaced them (see the diff)")
    new_pin = read_pin(root)
    say("This machine")
    for line in refresh_services(root):
        say("  " + line)
    problems = verify_machine(root, new_pin)
    if problems:
        raise FactoryError("verification_failed", f"{tag} is installed here, but the checks after it failed:\n" + "\n".join("    - " + p for p in problems),
                           "fix what the lines above say (each names the file), then run `factory update` again; it is safe to repeat.")
    say(f"  checks: the files match the pin, every hook in settings.json exists, the scripts parse, the runner files are readable (verified)")
    changed = git(root, "status", "--porcelain", "--untracked-files=all").stdout.strip()
    say()
    say(f"Done. This project is on {tag}.")
    if changed:
        say("Nothing is committed for you. Review it, then:")
        say(f"  git add -A && git commit -m \"Update the software factory to {tag}\"")
        say("and open a pull request. Everyone else catches up with `factory update` after pulling it.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="factory", description="the software factory's release client")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("version")
    v.add_argument("--json", action="store_true")
    r = sub.add_parser("releases")
    r.add_argument("--all", action="store_true")
    u = sub.add_parser("update")
    u.add_argument("version", nargs="?")
    u.add_argument("--release", action="store_true", help="use releases even when the project has no pin yet")
    u.add_argument("--verbose", action="store_true")
    sub.add_parser("rollback").add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "version":
            return cmd_version(args)
        if args.cmd == "releases":
            return cmd_releases(args)
        return cmd_update(args, rollback=args.cmd == "rollback")
    except FactoryError as e:
        print(f"factory {args.cmd}: [{e.code}] {e.message}\nFix: {e.fix}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
