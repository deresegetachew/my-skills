#!/usr/bin/env python3
"""The release client (#113): factory version | releases | update [version] | rollback.  python3 software-factory/tests/test_release_client.py

A fake GitHub on 127.0.0.1 serves real archives built by tools/build_release.py (from tiny fake repos, and once
from this repo's own tree), so the producer and the client are tested against each other and nothing leaves the
machine. `fake ci.sh` stands in for the runner services: it records what the client asks of it."""
import hashlib, http.server, importlib.util, io, json, os, re, shutil, subprocess, sys, tarfile, tempfile, threading

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.dirname(SF)
CLIENT = os.path.join(SF, "hooks", "factory_release.py")
PIN = os.path.join(".claude", "factory", "release.json")

spec = importlib.util.spec_from_file_location("build_release", os.path.join(REPO, "tools", "build_release.py"))
build_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_release)

FAKE_CI = """#!/usr/bin/env bash
# fake ci.sh {v}: records what the client asks, answers from flag files
echo "$*" >>"$FAKE_CI_LOG"
case "$1" in
  stale) [ -f "$FAKE_CI_STALE" ] && { echo "older compose.yaml"; exit 3; }; exit 0 ;;
  install) rm -f "$FAKE_CI_STALE"; exit 0 ;;
  check) [ -f "$FAKE_CI_BROKEN" ] && { echo "can't read entrypoint.sh: the runner container's user needs mode 644"; exit 1; }; exit 0 ;;
esac
"""


def git(d, *a, check=True):
    p = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", d, *a], capture_output=True, text=True)
    assert not check or p.returncode == 0, (a, p.stdout, p.stderr)
    return p.stdout


def tree(version, files=None, notes=None):
    """The files of a fake software-factory at `version`. A value of None in `files` leaves that file out."""
    base = {
        "VERSION": version + "\n",
        "README.md": "readme\n",
        "factory": "#!/usr/bin/env bash\n# factory " + version + "\necho factory\n",
        "factory-loop.sh": "#!/usr/bin/env bash\n# loop " + version + "\n",
        "hooks/factory_x.py": "VERSION = %r\n" % version,
        "hooks/factory_old.py": "OLD = 1\n",
        "ci/ci.sh": FAKE_CI.replace("{v}", version),
        "kit/.claude/agents/a.md": "agent " + version + "\n",
        "kit/.claude/settings.json": json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command",
                                    "command": "python3 \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/factory_x.py"}]}]}}) + "\n",
        "kit/.claude/factory.json": "{}\n",
        "kit/docs/blocked.md": "# blocked\n",
        "kit/.gitignore": "tmp/\n",
    }
    base.update(files or {})
    return {k: v for k, v in base.items() if v is not None}


def build(version, files=None):
    """Build a real release archive from a throwaway git repo shaped like my-skills; returns the dist folder."""
    d = tempfile.mkdtemp()
    for rel, body in tree(version, files).items():
        p = os.path.join(d, "software-factory", rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").write(body)
    for x in ("factory", "factory-loop.sh", "ci/ci.sh"):
        os.chmod(os.path.join(d, "software-factory", x), 0o755)
    # the forwarders step 1 of #112 left at the old kit/ paths: the release packs them as files, and the client skips them
    os.symlink("../factory", os.path.join(d, "software-factory", "kit", "factory"))
    if "hooks/factory_x.py" in tree(version, files):
        os.makedirs(os.path.join(d, "software-factory", "kit", ".claude", "hooks"))
        os.symlink("../../../hooks/factory_x.py", os.path.join(d, "software-factory", "kit", ".claude", "hooks", "factory_x.py"))
    git(d, "init", "-q", "-b", "main")
    git(d, "add", "-A", "-f")
    git(d, "commit", "-q", "-m", "release " + version)
    out = tempfile.mkdtemp()
    build_release.build(d, out, "v" + version)
    return out


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        s = self.server.fake
        s.hits.append(self.path)
        path = self.path.split("?")[0]
        if path.endswith("/releases"):
            page = 1 if "page=1" in self.path or "page=" not in self.path else 2
            body = json.dumps(s.listing() if page == 1 else []).encode()
            return self.send(200, body, "application/json")
        parts = path.strip("/").split("/")
        if parts[0] == "dl":
            tag, name = parts[1], parts[2]
            data = s.assets[tag][name]
            if name in s.corrupt:
                data = bytes([data[0] ^ 1]) + data[1:]
            if name in s.truncate:
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data[:len(data) // 2])
                self.wfile.flush()
                self.close_connection = True
                return
            return self.send(200, data, "application/octet-stream")
        self.send(404, b"{}", "application/json")

    def send(self, code, body, kind):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class FakeGitHub:
    """GET /repos/<repo>/releases and /dl/<tag>/<asset>, like GitHub's API and download URLs."""

    def __init__(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.fake = self
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.releases, self.assets, self.hits = [], {}, []
        self.corrupt, self.truncate = set(), set()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def listing(self):
        return [{"tag_name": r["tag"], "name": r["tag"], "published_at": r["date"], "body": r["body"], "draft": False,
                 "prerelease": r["pre"],
                 "assets": [{"name": n, "browser_download_url": f"{self.url}/dl/{r['tag']}/{n}", "size": len(self.assets[r["tag"]][n])}
                            for n in self.assets[r["tag"]]]} for r in self.releases]

    def add(self, version, files=None, date="2026-11-01T10:00:00Z", notes=None, pre=False, assets=None):
        dist = build(version, files)
        tag = "v" + version
        self.assets[tag] = assets if assets is not None else {n: open(os.path.join(dist, n), "rb").read() for n in os.listdir(dist)}
        body = notes if notes is not None else f"Software factory {tag}.\n\nChanges:\n\n- change in {version} (abc{version.replace('.', '')})\n"
        self.releases.insert(0, {"tag": tag, "date": date, "body": body, "pre": pre})
        return dist

    def stop(self):
        self.server.shutdown()


def world(*versions):
    """(fake github, an empty project with one commit, its environment)."""
    gh = FakeGitHub()
    for i, v in enumerate(versions):
        gh.add(v, date="2026-1%d-01T10:00:00Z" % i if i < 3 else "2026-12-01T10:00:00Z")
    d = tempfile.mkdtemp()
    git(d, "init", "-q", "-b", "main")
    open(os.path.join(d, "README.md"), "w").write("project\n")
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", "start")
    scratch = tempfile.mkdtemp()
    env = {k: v for k, v in os.environ.items() if k not in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE", "GH_TOKEN", "GITHUB_TOKEN")}
    env.update({"HOME": tempfile.mkdtemp(), "FACTORY_RELEASE_API": gh.url, "FACTORY_CACHE_DIR": os.path.join(scratch, "cache"),
                "FAKE_CI_LOG": os.path.join(scratch, "ci.log"), "FAKE_CI_STALE": os.path.join(scratch, "stale"),
                "FAKE_CI_BROKEN": os.path.join(scratch, "broken"), "PYTHONDONTWRITEBYTECODE": "1"})
    return gh, d, env


def fac(d, env, *args):
    p = subprocess.run([sys.executable, CLIENT, *args], cwd=d, env=env, capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout + p.stderr


def commit(d, msg="factory"):
    # The client rewrites files with the archive's fixed times, often with the same size as the old version. Git
    # trusts a file whose size, times and inode are unchanged (inodes get reused), so on a busy machine `add -A`
    # could miss the new content. Emptying the index first makes it read every file again.
    git(d, "rm", "-r", "--cached", "-q", "--ignore-unmatch", ".")
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", msg)


def pin(d):
    return json.load(open(os.path.join(d, PIN)))


def snapshot(d):
    """Every file in the project (not .git) with its bytes and mode, to prove a refused command changed nothing."""
    out = {}
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if x != ".git"]
        for f in files:
            p = os.path.join(root, f)
            out[os.path.relpath(p, d)] = (open(p, "rb").read(), os.stat(p).st_mode)
    return out


def ci_log(env):
    try:
        return open(env["FAKE_CI_LOG"]).read().split("\n")
    except FileNotFoundError:
        return []


def cached(env):
    return [f for _r, _d, fs in os.walk(env["FACTORY_CACHE_DIR"]) for f in fs] if os.path.isdir(env["FACTORY_CACHE_DIR"]) else []


# --- first install, update, a named release ---------------------------------------------------------------------

def test_first_install_takes_the_newest_full_release_and_records_it_in_the_pin():
    gh, d, env = world("1.0.0", "1.1.0")
    gh.add("1.2.0-rc.1", pre=True)  # a pre-release is never "newest" unless asked for by name
    rc, out = fac(d, env, "update")
    assert rc == 0, out
    assert "v1.1.0" in out and "v1.2.0-rc.1" not in out, out
    assert open(os.path.join(d, ".claude/hooks/factory_x.py")).read() == "VERSION = '1.1.0'\n"
    assert open(os.path.join(d, ".claude/agents/a.md")).read() == "agent 1.1.0\n"
    assert os.access(os.path.join(d, "factory"), os.X_OK) and os.access(os.path.join(d, ".claude/ci/ci.sh"), os.X_OK)
    assert not os.path.exists(os.path.join(d, "kit")), "the kit/ forwarders are not installed"
    p = pin(d)
    archive = gh.assets["v1.1.0"]["software-factory-1.1.0.tar.gz"]
    assert p["tag"] == "v1.1.0" and p["version"] == "1.1.0" and p["sha256"] == hashlib.sha256(archive).hexdigest(), p
    assert p["previous"] is None and p["files"][".claude/hooks/factory_x.py"] == hashlib.sha256(b"VERSION = '1.1.0'\n").hexdigest(), p
    assert os.path.exists(os.path.join(d, ".claude/factory.json")) and os.path.exists(os.path.join(d, "docs/blocked.md")), "templates on a first install"
    assert "tmp/" in open(os.path.join(d, ".gitignore")).read().split()
    assert git(d, "branch", "--list").split() == ["*", "main"], "no branch is created"
    assert git(d, "log", "--oneline").count("\n") == 1, "nothing is committed"
    assert "git add" in out and "commit" in out, "the report says how to commit it"


def test_a_project_with_its_own_factory_json_gets_the_manager_profile_and_the_next_release_updates_it():
    gh, d, env = world()
    gh.add("1.0.0", files={"kit/.claude/manager/settings.json": '{"profile": "1.0.0"}\n'}, date="2026-10-01T10:00:00Z")
    gh.add("1.1.0", files={"kit/.claude/manager/settings.json": '{"profile": "1.1.0"}\n'}, date="2026-11-01T10:00:00Z")
    own = os.path.join(d, ".claude", "factory.json")
    os.makedirs(os.path.dirname(own))
    open(own, "w").write('{"mainBranch": "trunk"}\n')  # the project already has its own config, so templates are not given
    commit(d)
    profile = os.path.join(d, ".claude", "manager", "settings.json")
    rc, out = fac(d, env, "update", "1.0.0")
    assert rc == 0, out
    assert open(profile).read() == '{"profile": "1.0.0"}\n', "an engine file, given even when factory.json exists"
    assert open(own).read() == '{"mainBranch": "trunk"}\n'
    assert ".claude/manager/settings.json" in pin(d)["files"], "so verification checks it"
    commit(d)
    rc, out = fac(d, env, "update")
    assert rc == 0, out
    assert open(profile).read() == '{"profile": "1.1.0"}\n'
    open(profile, "w").write("{}\n")  # a drifted profile is found and repaired like any engine file
    commit(d)
    rc, out = fac(d, env, "update")
    assert open(profile).read() == '{"profile": "1.1.0"}\n', out


def settings_allow(d):
    return json.load(open(os.path.join(d, ".claude", "settings.json")))["permissions"]["allow"]


def test_a_projects_extra_allow_entries_are_merged_survive_updates_and_are_not_drift():
    gh, d, env = world()
    kit = lambda v, allow: {"kit/.claude/settings.json": json.dumps({"permissions": {"allow": allow, "deny": ["Bash(rm *)"]}}) + "\n"}
    gh.add("1.0.0", files=kit("1.0.0", ["Bash(ls *)"]), date="2026-10-01T10:00:00Z")
    gh.add("1.1.0", files=kit("1.1.0", ["Bash(ls *)", "Bash(git log*)"]), date="2026-11-01T10:00:00Z")
    own = os.path.join(d, ".claude", "factory.json")
    os.makedirs(os.path.dirname(own))
    open(own, "w").write(json.dumps({"permissions": {"allow": ["Edit(tmp/**)", "Bash(ls *)", "Bash(mkdir -p *)"]}}) + "\n")
    commit(d)
    rc, out = fac(d, env, "update", "1.0.0")
    assert rc == 0, out
    assert settings_allow(d) == ["Bash(ls *)", "Edit(tmp/**)", "Bash(mkdir -p *)"], "the release's entries, then the project's, no repeats"
    assert json.load(open(os.path.join(d, ".claude", "settings.json")))["permissions"]["deny"] == ["Bash(rm *)"]
    rc, out = fac(d, env, "version")
    assert "the files match the pin" in out, out
    commit(d)
    rc, out = fac(d, env, "update")  # the next release keeps the project's entries
    assert rc == 0, out
    assert settings_allow(d) == ["Bash(ls *)", "Bash(git log*)", "Edit(tmp/**)", "Bash(mkdir -p *)"]
    assert "differ" not in fac(d, env, "version")[1]
    commit(d)
    settings = os.path.join(d, ".claude", "settings.json")  # an entry added by hand in settings.json is still drift
    data = json.load(open(settings))
    data["permissions"]["allow"].append("Bash(curl *)")
    json.dump(data, open(settings, "w"), indent=2)
    assert "settings.json differs from v1.1.0" in fac(d, env, "version")[1]


def test_an_allow_entry_added_to_factory_json_needs_an_update_to_take_effect_and_doctor_says_so():
    gh, d, env = world("1.0.0")
    assert fac(d, env, "update")[0] == 0
    own = os.path.join(d, ".claude", "factory.json")
    open(own, "w").write(json.dumps({"permissions": {"allow": ["Edit(tmp/**)"]}}) + "\n")
    commit(d)
    rc, out = fac(d, env, "version")
    assert "Edit(tmp/**)" in out and "differ" in out, out
    rc, out = fac(d, env, "update")
    assert rc == 0 and "Edit(tmp/**)" in settings_allow(d), out
    assert "Edit(tmp/**)" not in fac(d, env, "version")[1]


def test_a_bad_allow_list_is_refused_with_a_fix_and_changes_nothing():
    gh, d, env = world("1.0.0")
    os.makedirs(os.path.join(d, ".claude"))
    open(os.path.join(d, ".claude", "factory.json"), "w").write(json.dumps({"permissions": {"allow": "Edit(tmp/**)"}}) + "\n")
    commit(d)
    before = snapshot(d)
    rc, out = fac(d, env, "update")
    assert rc != 0 and "permissions.allow" in out and "Fix:" in out, out
    assert snapshot(d) == before


def test_the_kits_default_allow_list_has_what_a_headless_coding_agent_needs_and_no_unmatched_or_risky_rules():
    allow = json.load(open(os.path.join(SF, "kit", ".claude", "settings.json")))["permissions"]["allow"]
    for entry in ("Edit(tmp/**)", "Bash(cd *)", "Bash(ls *)", "Bash(mkdir -p *)", "Bash(git rev-parse*)"):
        assert entry in allow, entry
    assert not [a for a in allow if a.startswith("Write(")], "Claude Code never matches Write(path) rules"
    assert not [a for a in allow if "python3 -c" in a], "an inline interpreter would let an agent run anything"
    assert len(allow) == len(set(allow))


def local_release(version="1.0.0"):
    """A real release built by tools/build_release.py, as files on disk: (archive path, SHA256SUMS path)."""
    dist = build(version)
    return os.path.join(dist, f"software-factory-{version}.tar.gz"), os.path.join(dist, "SHA256SUMS")


def offline(env):
    return {**env, "FACTORY_RELEASE_API": "http://127.0.0.1:9"}  # nothing listens there: any request would fail


def test_update_from_a_local_archive_installs_it_with_no_network_and_records_the_pin():
    gh, d, env = world()
    archive, sums = local_release("1.0.0")
    rc, out = fac(d, offline(env), "update", "--archive", archive, "--sums", sums)
    assert rc == 0, out
    assert open(os.path.join(d, ".claude/hooks/factory_x.py")).read() == "VERSION = '1.0.0'\n"
    p = pin(d)
    assert p["tag"] == "v1.0.0" and p["sha256"] == hashlib.sha256(open(archive, "rb").read()).hexdigest(), p
    assert gh.hits == [], "no request reached the fake GitHub"
    assert "local archive" in out and "git add" in out, out
    assert "not refreshed" in out and not ci_log(env)[:-1], "the archive's own scripts are not run to refresh services"


def test_the_sums_file_defaults_to_the_one_beside_the_archive_and_a_version_must_agree_with_the_archive():
    gh, d, env = world()
    archive, sums = local_release("1.0.0")
    rc, out = fac(d, offline(env), "update", "--archive", archive)
    assert rc == 0 and pin(d)["tag"] == "v1.0.0", out
    commit(d)
    rc, out = fac(d, offline(env), "update", "v2.0.0", "--archive", archive, "--sums", sums)
    assert rc != 0 and "[version_mismatch]" in out and "Fix:" in out, out


def test_a_local_archive_with_a_wrong_checksum_is_refused_and_nothing_is_changed():
    gh, d, env = world()
    archive, sums = local_release("1.0.0")
    open(sums, "w").write("0" * 64 + "  software-factory-1.0.0.tar.gz\n")
    before = snapshot(d)
    rc, out = fac(d, offline(env), "update", "--archive", archive, "--sums", sums)
    assert rc != 0 and "[bad_checksum]" in out and "Fix:" in out, out
    assert snapshot(d) == before


def test_an_archive_changed_after_its_sums_were_made_is_refused():
    gh, d, env = world()
    archive, sums = local_release("1.0.0")
    data = open(archive, "rb").read()
    open(archive, "wb").write(data[:-1] + bytes([data[-1] ^ 1]))
    rc, out = fac(d, offline(env), "update", "--archive", archive, "--sums", sums)
    assert rc != 0 and "bad_checksum" in out or "bad_archive" in out, out
    assert not os.path.exists(os.path.join(d, PIN))


def test_a_missing_archive_or_sums_file_is_refused_with_the_fix():
    gh, d, env = world()
    archive, sums = local_release("1.0.0")
    rc, out = fac(d, offline(env), "update", "--archive", archive + ".nope")
    assert rc != 0 and "[missing_file]" in out and "Fix:" in out, out
    os.remove(sums)
    rc, out = fac(d, offline(env), "update", "--archive", archive)
    assert rc != 0 and "[missing_file]" in out and "SHA256SUMS" in out, out
    rc, out = fac(d, offline(env), "update", "--sums", sums)
    assert rc != 0 and "--archive" in out, out


def test_an_archive_whose_name_is_not_a_release_is_refused():
    gh, d, env = world()
    archive, sums = local_release("1.0.0")
    odd = os.path.join(os.path.dirname(archive), "release.tgz")
    shutil.copy(archive, odd)
    rc, out = fac(d, offline(env), "update", "--archive", odd, "--sums", sums)
    assert rc != 0 and "[bad_archive_name]" in out and "software-factory-" in out, out


def test_the_factory_command_sends_update_archive_to_the_release_client_even_before_a_pin_exists():
    text = open(os.path.join(SF, "factory")).read()
    assert "--archive" in text.split("update)")[1].split("--layout")[0], "factory update --archive reaches factory_release.py"


def test_update_moves_to_the_newest_release_removes_files_it_dropped_and_leaves_the_projects_own_files():
    gh, d, env = world("1.0.0")
    assert fac(d, env, "update")[0] == 0
    open(os.path.join(d, ".claude/factory.json"), "w").write('{"mainBranch": "trunk"}\n')  # the project's own settings
    commit(d)
    gh.add("1.1.0", files={"hooks/factory_old.py": None, "hooks/factory_new.py": "NEW = 1\n"},
           notes="Software factory v1.1.0.\n\nChanges since v1.0.0:\n\n- faster waits (1111111)\n- quieter checks (2222222)\n")
    rc, out = fac(d, env, "update")
    assert rc == 0, out
    assert pin(d)["version"] == "1.1.0" and pin(d)["previous"]["tag"] == "v1.0.0", pin(d)
    assert not os.path.exists(os.path.join(d, ".claude/hooks/factory_old.py"))
    assert os.path.exists(os.path.join(d, ".claude/hooks/factory_new.py"))
    assert open(os.path.join(d, ".claude/factory.json")).read() == '{"mainBranch": "trunk"}\n'
    assert "v1.0.0 -> v1.1.0" in out and "faster waits (1111111)" in out and "quieter checks (2222222)" in out, out
    assert "removed" in out and "factory_old.py" in out, out


def test_running_update_twice_changes_nothing_the_second_time_even_before_the_first_is_committed():
    gh, d, env = world("1.0.0")
    assert fac(d, env, "update")[0] == 0
    before, status = snapshot(d), git(d, "status", "--porcelain")
    rc, out = fac(d, env, "update")  # the tree is dirty with the first update: the same update again is fine
    assert rc == 0 and "already" in out, out
    assert snapshot(d) == before and git(d, "status", "--porcelain") == status
    commit(d)
    rc, out = fac(d, env, "update")
    assert rc == 0 and "already" in out and git(d, "status", "--porcelain") == "", out


def test_a_named_release_can_be_installed_newer_or_older_with_or_without_the_v():
    gh, d, env = world("1.0.0", "1.1.0", "2.0.0")
    assert fac(d, env, "update", "1.1.0")[0] == 0 and pin(d)["tag"] == "v1.1.0"
    commit(d)
    rc, out = fac(d, env, "update", "v1.0.0")
    assert rc == 0 and pin(d)["tag"] == "v1.0.0" and "v1.1.0 -> v1.0.0" in out, out
    assert pin(d)["previous"]["tag"] == "v1.1.0"
    commit(d)
    rc, out = fac(d, env, "update", "v2.0.0")
    assert rc == 0 and pin(d)["tag"] == "v2.0.0", out


def test_an_unknown_release_is_refused_with_the_ones_that_exist_and_nothing_changes():
    gh, d, env = world("1.0.0", "1.1.0")
    before = snapshot(d)
    rc, out = fac(d, env, "update", "v9.9.9")
    assert rc == 1 and "[no_such_release]" in out and "v1.1.0" in out and "factory releases" in out, out
    assert snapshot(d) == before


def test_update_never_creates_a_branch_or_a_commit_and_works_from_any_branch():
    gh, d, env = world("1.0.0")
    git(d, "checkout", "-q", "-b", "stale-topic")  # a leftover local branch with no remote
    heads = git(d, "rev-parse", "HEAD")
    assert fac(d, env, "update")[0] == 0
    assert git(d, "branch", "--show-current").strip() == "stale-topic" and git(d, "rev-parse", "HEAD") == heads
    assert sorted(git(d, "branch", "--format=%(refname:short)").split()) == ["main", "stale-topic"]


# --- refusals: dirty tree, checksum, network, interrupted download, unsafe archive -------------------------------

def test_a_dirty_tree_is_refused_with_the_reason_and_nothing_is_changed_or_stashed():
    gh, d, env = world("1.0.0")
    open(os.path.join(d, "README.md"), "a").write("edit\n")
    open(os.path.join(d, "scratch.txt"), "w").write("untracked\n")
    before = snapshot(d)
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[dirty_tree]" in out and "README.md" in out and "scratch.txt" in out and "git stash" in out, out
    assert snapshot(d) == before and git(d, "stash", "list") == "" and not gh.hits, "refused before any download"


def test_a_bad_checksum_installs_nothing_and_leaves_nothing_in_the_cache():
    gh, d, env = world("1.0.0")
    gh.corrupt.add("software-factory-1.0.0.tar.gz")
    before = snapshot(d)
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[bad_checksum]" in out and "v1.0.0" in out, out
    assert snapshot(d) == before and cached(env) == []
    gh.corrupt.clear()
    gh.corrupt.add("SHA256SUMS")  # the checksum file is what is wrong this time
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[bad_checksum]" in out and snapshot(d) == before


def test_a_release_without_its_checksum_file_is_refused():
    gh, d, env = world()
    dist = gh.add("1.0.0")
    gh.assets["v1.0.0"].pop("SHA256SUMS")
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[incomplete_release]" in out and "SHA256SUMS" in out, out
    assert not os.path.exists(os.path.join(d, ".claude"))


def test_no_network_is_a_plain_error_and_the_project_is_untouched():
    gh, d, env = world("1.0.0")
    env["FACTORY_RELEASE_API"] = "http://127.0.0.1:1"  # nothing listens
    before = snapshot(d)
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[no_network]" in out and "rollback" in out, out
    assert snapshot(d) == before
    rc, out = fac(d, env, "releases")
    assert rc == 1 and "[no_network]" in out


def test_an_interrupted_download_leaves_no_partial_file_and_the_next_try_works():
    gh, d, env = world("1.0.0")
    gh.truncate.add("software-factory-1.0.0.tar.gz")
    before = snapshot(d)
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[download_interrupted]" in out and "run" in out, out
    assert snapshot(d) == before and [f for f in cached(env) if "tar.gz" in f] == [], cached(env)
    gh.truncate.clear()
    rc, out = fac(d, env, "update")
    assert rc == 0 and pin(d)["tag"] == "v1.0.0", out


def raw_tar(entries):
    """An archive with exactly these members: (name, bytes or None for a symlink to 'target', type)."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w:gz") as t:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "link":
                info.type, info.linkname = tarfile.SYMTYPE, data
                t.addfile(info)
            else:
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))
    return raw.getvalue()


def evil_release(gh, entries):
    archive = raw_tar(entries)
    sums = ("%s  software-factory-6.6.6.tar.gz\n" % hashlib.sha256(archive).hexdigest()).encode()  # a correct checksum
    gh.add("6.6.6", assets={"software-factory-6.6.6.tar.gz": archive, "SHA256SUMS": sums})


def test_an_archive_cannot_write_outside_its_folder_or_unpack_a_link():
    for entries in ([("software-factory-6.6.6/../../evil", b"x", "file")],
                    [("/tmp/evil-abs", b"x", "file")],
                    [("software-factory-6.6.6/factory", "/etc/passwd", "link")],
                    [("other-top/factory", b"x", "file")]):
        gh, d, env = world()
        evil_release(gh, entries + [("software-factory-6.6.6/MANIFEST.json", b"{}", "file")])
        before = snapshot(d)
        rc, out = fac(d, env, "update")
        assert rc == 1 and "[unsafe_archive]" in out, (entries, out)
        assert snapshot(d) == before and not os.path.exists("/tmp/evil-abs") and not os.path.exists(os.path.join(os.path.dirname(d), "evil"))


def test_an_archive_whose_files_do_not_match_its_manifest_is_refused():
    gh, d, env = world()
    dist = build("6.6.6")
    name = "software-factory-6.6.6.tar.gz"
    with tarfile.open(os.path.join(dist, name)) as t:
        members = [(m.name, t.extractfile(m).read(), "file") for m in t.getmembers()]
    members = [(n, b"tampered\n" if n.endswith("hooks/factory_x.py") else data, k) for n, data, k in members]
    evil_release(gh, members)
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[bad_archive]" in out and "factory_x.py" in out, out
    assert not os.path.exists(os.path.join(d, ".claude"))


def test_agents_cannot_update_the_factory():
    gh, d, env = world("1.0.0")
    for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
        rc, out = fac(d, {**env, var: "1"}, "update")
        assert rc == 1 and "[agent_session]" in out, (var, out)
    assert not os.path.exists(os.path.join(d, ".claude"))


def test_agents_are_denied_update_and_rollback_in_the_shipped_settings():
    rules = json.load(open(os.path.join(SF, "kit", ".claude", "settings.json")))["permissions"]["deny"]
    for rule in ("Bash(factory update*)", "Bash(./factory update*)", "Bash(factory rollback*)", "Bash(./factory rollback*)",
                 "Bash(*factory_release*)"):
        assert rule in rules, rule


# --- rollback and offline use ------------------------------------------------------------------------------------

def test_rollback_returns_to_the_previous_release_without_the_network_and_again_goes_forward():
    gh, d, env = world("1.0.0", "1.1.0")
    assert fac(d, env, "update", "v1.0.0")[0] == 0
    commit(d)
    assert fac(d, env, "update")[0] == 0 and pin(d)["tag"] == "v1.1.0"
    commit(d)
    gh.hits.clear()
    env["FACTORY_RELEASE_API"] = "http://127.0.0.1:1"  # the network is gone
    rc, out = fac(d, env, "rollback")
    assert rc == 0 and pin(d)["tag"] == "v1.0.0" and "v1.1.0 -> v1.0.0" in out, out
    assert open(os.path.join(d, ".claude/hooks/factory_x.py")).read() == "VERSION = '1.0.0'\n"
    assert pin(d)["previous"]["tag"] == "v1.1.0"
    commit(d)
    rc, out = fac(d, env, "rollback")
    assert rc == 0 and pin(d)["tag"] == "v1.1.0", out
    assert gh.hits == []


def test_rollback_with_nothing_before_it_says_how_to_name_a_release():
    gh, d, env = world("1.0.0")
    assert fac(d, env, "update")[0] == 0
    commit(d)
    rc, out = fac(d, env, "rollback")
    assert rc == 1 and "[no_previous]" in out and "factory update v" in out, out
    rc, out = fac(tempfile.mkdtemp(), env, "rollback")
    assert rc == 1


def test_rollback_checks_the_cached_archive_against_the_checksum_recorded_in_the_pin():
    gh, d, env = world("1.0.0", "1.1.0")
    assert fac(d, env, "update", "v1.0.0")[0] == 0
    commit(d)
    assert fac(d, env, "update")[0] == 0
    commit(d)
    env["FACTORY_RELEASE_API"] = "http://127.0.0.1:1"
    # someone replaces the cached v1.0.0 archive AND its checksum file with a consistent but different pair
    folder = [os.path.join(r) for r, _d, fs in os.walk(env["FACTORY_CACHE_DIR"]) if "software-factory-1.0.0.tar.gz" in fs][0]
    fake = raw_tar([("software-factory-1.0.0/MANIFEST.json", b"{}", "file")])
    open(os.path.join(folder, "software-factory-1.0.0.tar.gz"), "wb").write(fake)
    open(os.path.join(folder, "SHA256SUMS"), "w").write("%s  software-factory-1.0.0.tar.gz\n" % hashlib.sha256(fake).hexdigest())
    before = snapshot(d)
    rc, out = fac(d, env, "rollback")
    assert rc == 1 and "[bad_checksum]" in out and "pin" in out, out
    assert snapshot(d) == before


def test_a_release_already_downloaded_installs_again_without_the_network():
    gh, d, env = world("1.0.0", "1.1.0")
    assert fac(d, env, "update", "v1.0.0")[0] == 0
    commit(d)
    env["FACTORY_RELEASE_API"] = "http://127.0.0.1:1"
    rc, out = fac(d, env, "update", "v1.0.0")
    assert rc == 0 and "already" in out, out


# --- drift and the machine ---------------------------------------------------------------------------------------

def test_a_drifted_file_is_found_by_version_and_repaired_by_update_even_when_committed():
    gh, d, env = world("1.0.0")
    assert fac(d, env, "update")[0] == 0
    commit(d)
    open(os.path.join(d, ".claude/hooks/factory_x.py"), "a").write("# hand edit\n")
    os.remove(os.path.join(d, ".claude/agents/a.md"))
    commit(d, "someone edited the shared files")
    rc, out = fac(d, env, "version")
    assert rc == 0 and "differ" in out and "factory_x.py" in out and "a.md" in out, out
    rc, out = fac(d, env, "update")
    assert rc == 0 and "repaired" in out, out
    assert open(os.path.join(d, ".claude/hooks/factory_x.py")).read() == "VERSION = '1.0.0'\n"
    assert os.path.exists(os.path.join(d, ".claude/agents/a.md"))
    assert "differ" not in fac(d, env, "version")[1]


def test_services_older_than_the_pin_are_refreshed_only_when_they_are_older():
    gh, d, env = world("1.0.0")
    assert fac(d, env, "update")[0] == 0
    log = ci_log(env)
    assert "stale" in log and "install" not in log, log  # nothing was older: no reinstall
    commit(d)
    open(env["FAKE_CI_STALE"], "w").write("")  # the machine pulled this pin, but its runner services are from before
    rc, out = fac(d, env, "update")
    assert rc == 0 and "already" in out and "runner services" in out, out
    assert "install" in ci_log(env), ci_log(env)
    assert not os.path.exists(env["FAKE_CI_STALE"])
    assert "check" in ci_log(env)


def test_a_runner_whose_start_script_cannot_be_read_fails_the_verification_and_is_not_called_success():
    gh, d, env = world("1.0.0")
    open(env["FAKE_CI_BROKEN"], "w").write("")
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[verification_failed]" in out and "entrypoint.sh" in out, out
    assert "Updated" not in out and "up to date" not in out, out
    os.remove(env["FAKE_CI_BROKEN"])
    commit(d)
    rc, out = fac(d, env, "update")
    assert rc == 0 and "verified" in out, out


def fake_systemd(env, enabled=True, restart_fails=False):
    """A systemctl on PATH that says a heartbeat unit is installed (or not) and logs what it is asked."""
    bin_ = tempfile.mkdtemp()
    log = os.path.join(bin_, "systemctl.log")
    body = ('#!/usr/bin/env bash\necho "$*" >>%s\ncase "$2" in\n  show-environment) exit 0 ;;\n  is-enabled) exit %d ;;\n  restart) exit %d ;;\nesac\n'
            % (log, 0 if enabled else 1, 1 if restart_fails else 0))
    open(os.path.join(bin_, "systemctl"), "w").write(body)
    os.chmod(os.path.join(bin_, "systemctl"), 0o755)
    env.update({"PATH": bin_ + os.pathsep + env["PATH"], "FACTORY_AUTOSTART_PLATFORM": "linux"})
    return log


def test_an_installed_heartbeat_daemon_is_restarted_so_it_does_not_keep_running_the_old_code():
    gh, d, env = world("1.0.0")
    log = fake_systemd(env)
    rc, out = fac(d, env, "update")
    assert rc == 0, out
    assert re.search(r"--user restart .*-factory-heartbeat\.service", open(log).read()), open(log).read()
    assert "Restarted" in out and "heartbeat" in out, out


def test_no_heartbeat_daemon_installed_means_nothing_is_restarted_and_nothing_is_said_about_it():
    gh, d, env = world("1.0.0")
    log = fake_systemd(env, enabled=False)
    rc, out = fac(d, env, "update")
    assert rc == 0 and "restart" not in open(log).read() and "heartbeat" not in out, (out, open(log).read())


def test_a_heartbeat_daemon_that_will_not_restart_fails_the_update_with_the_fix():
    gh, d, env = world("1.0.0")
    fake_systemd(env, restart_fails=True)
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[services_failed]" in out and "factory heartbeat install" in out, out
    assert "Done." not in out, out


def test_verification_catches_a_settings_hook_that_points_at_a_file_that_is_not_there():
    gh, d, env = world()
    gh.add("1.0.0", files={"hooks/factory_x.py": None})
    rc, out = fac(d, env, "update")
    assert rc == 1 and "[verification_failed]" in out and ".claude/hooks/factory_x.py" in out, out


# --- version and releases ----------------------------------------------------------------------------------------

def test_version_shows_installed_pinned_newest_and_what_changed_since():
    gh, d, env = world("1.0.0", "1.1.0")
    gh.add("1.2.0", notes="Software factory v1.2.0.\n\nChanges:\n\n- a newer thing (3333333)\n")
    assert fac(d, env, "update", "v1.0.0")[0] == 0
    commit(d)
    remote = tempfile.mkdtemp()
    git(remote, "init", "-q", "--bare")
    git(d, "remote", "add", "origin", remote)
    git(d, "push", "-q", "origin", "main")
    git(d, "fetch", "-q", "origin")
    rc, out = fac(d, env, "version")
    assert rc == 0, out
    assert "Installed" in out and "v1.0.0" in out and "Pinned" in out and "origin/main" in out and "Newest" in out and "v1.2.0" in out, out
    assert "a newer thing (3333333)" in out and "change in 1.1.0" in out, out
    assert "factory update" in out
    env["FACTORY_RELEASE_API"] = "http://127.0.0.1:1"
    rc, out = fac(d, env, "version")  # offline still answers what it knows
    assert rc == 0 and "v1.0.0" in out and "unknown" in out, out
    rc, out = fac(d, env, "version", "--json")
    assert rc == 0 and json.loads(out)["installed"]["tag"] == "v1.0.0"


def test_version_in_a_project_still_on_the_submodule_says_so():
    gh, d, env = world("1.0.0")
    open(os.path.join(d, ".gitmodules"), "w").write('[submodule "vendor/my-skills"]\n\tpath = vendor/my-skills\n\turl = https://github.com/deresegetachew/my-skills\n')
    rc, out = fac(d, env, "version")
    assert rc == 0 and "submodule" in out and "v1.0.0" in out and "no release pin" in out, out


def test_releases_lists_newest_first_with_dates_notes_and_where_you_are():
    gh, d, env = world("1.0.0", "1.1.0")
    gh.add("1.2.0-rc.1", pre=True, date="2026-12-24T10:00:00Z")
    assert fac(d, env, "update", "v1.0.0")[0] == 0
    rc, out = fac(d, env, "releases")
    rows = [l for l in out.splitlines() if re.match(r"^[* ] +v\d", l)]
    assert rc == 0 and [r.lstrip("* ").split()[0] for r in rows] == ["v1.2.0-rc.1", "v1.1.0", "v1.0.0"], out
    assert "2026-12-24" in out and "change in 1.1.0" in out and "pre-release" in out, out
    assert "installed" in [r for r in rows if "v1.0.0" in r][0] and "newest" in [r for r in rows if "v1.1.0" in r][0], out


# --- the old way keeps working, and the commands are wired in ----------------------------------------------------

def project_with_factory(gh):
    """A project that has the factory as real files (not the submodule), no pin yet, with the real `factory` command."""
    d = tempfile.mkdtemp()
    git(d, "init", "-q", "-b", "main")
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    for f in os.listdir(os.path.join(SF, "hooks")):
        if f.endswith(".py"):
            shutil.copy(os.path.join(SF, "hooks", f), os.path.join(d, ".claude", "hooks", f))
    shutil.copy(os.path.join(SF, "factory"), os.path.join(d, "factory"))
    open(os.path.join(d, ".claude", "factory.json"), "w").write("{}\n")
    commit(d, "project")
    return d


def run_factory(d, env, *args):
    # always this checkout's own `factory`: an installed fake release replaces the project's copy with a stub
    p = subprocess.run(["bash", os.path.join(SF, "factory"), *args], cwd=d, env={**env, "CLAUDE_PROJECT_DIR": d}, capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout + p.stderr


def test_a_project_with_no_pin_still_updates_through_the_submodule_as_before():
    gh, _d, env = world("1.0.0")
    d = project_with_factory(gh)
    rc, out = run_factory(d, env, "update")
    assert rc == 1 and "no my-skills submodule in .gitmodules" in out, out  # the old command ran, not the release client
    assert not os.path.exists(os.path.join(d, PIN)) and gh.hits == []


def test_a_project_linked_to_the_submodule_cannot_be_overwritten_by_a_release():
    gh, _d, env = world("1.0.0")
    d = project_with_factory(gh)
    target = os.path.join(d, ".claude", "hooks", "factory_x.py")
    os.makedirs(os.path.join(d, "vendor"))
    open(os.path.join(d, "vendor", "x.py"), "w").write("x\n")
    os.symlink("../../vendor/x.py", target)
    commit(d, "linked")
    rc, out = run_factory(d, env, "update", "v1.0.0")
    assert rc == 1 and "[linked_install]" in out and "factory_x.py" in out and "submodule" in out, out
    assert os.path.islink(target) and open(os.path.join(d, "vendor", "x.py")).read() == "x\n"


def factory_repo_copy():
    """A copy of my-skills' own layout: the factory's real files, VERSION and the release builder at the root (#162)."""
    d = tempfile.mkdtemp()
    git(d, "init", "-q", "-b", "main")
    os.makedirs(os.path.join(d, "software-factory"))
    os.makedirs(os.path.join(d, "tools"))
    open(os.path.join(d, "software-factory", "VERSION"), "w").write("1.0.0\n")
    open(os.path.join(d, "tools", "build_release.py"), "w").write("# builds the release archive\n")
    os.makedirs(os.path.join(d, ".claude"))  # my-skills links .claude/hooks to software-factory/hooks
    os.symlink(os.path.join(SF, "hooks"), os.path.join(d, ".claude", "hooks"))
    commit(d, "my-skills")
    return d


def test_update_and_rollback_refuse_inside_the_factorys_own_repo_and_change_nothing():
    gh, _d, env = world("1.0.0")
    d = factory_repo_copy()
    before = snapshot(d)
    for args in (("update",), ("update", "v1.0.0"), ("update", "--release"), ("update", "--layout", "new"), ("rollback",)):
        rc, out = run_factory(d, env, *args)
        assert rc == 1 and "[factory_repo]" in out and "Fix:" in out, (args, out)
        assert "software-factory/" in out and "release" in out, (args, out)
    assert snapshot(d) == before and git(d, "status", "--porcelain") == "" and gh.hits == []
    assert not os.path.exists(os.path.join(d, PIN))


def test_the_release_client_refuses_directly_in_the_factorys_own_repo_even_in_an_agent_session():
    gh, _d, env = world("1.0.0")
    d = factory_repo_copy()
    for cmd in ("update", "rollback"):
        rc, out = fac(d, {**env, "FACTORY_AGENT": "haile"}, cmd)
        assert rc == 1 and "[factory_repo]" in out, (cmd, out)
    assert git(d, "status", "--porcelain") == "" and gh.hits == []


def test_an_ordinary_project_is_not_taken_for_the_factorys_repo():
    gh, _d, env = world("1.0.0")
    d = project_with_factory(gh)
    rc, out = run_factory(d, env, "update")
    assert "[factory_repo]" not in out and "no my-skills submodule in .gitmodules" in out, out
    # a project that only has one of the two marker files is an ordinary project too
    os.makedirs(os.path.join(d, "tools"))
    open(os.path.join(d, "tools", "build_release.py"), "w").write("x\n")
    rc, out = run_factory(d, env, "update")
    assert "[factory_repo]" not in out, out
    gh2, d2, env2 = world("1.0.0")
    rc, out = fac(d2, env2, "update")
    assert rc == 0 and "[factory_repo]" not in out, out


def test_the_factory_command_runs_version_releases_update_and_rollback_and_lists_them_in_help():
    gh, _d, env = world("1.0.0", "1.1.0")
    d = project_with_factory(gh)
    rc, out = run_factory(d, env, "help")
    for c in ("version", "releases", "update [version]", "rollback"):
        assert c in out, c
    rc, out = run_factory(d, env, "update", "--release")  # no pin yet: --release asks for the release client
    assert rc == 0 and pin(d)["tag"] == "v1.1.0", out
    commit(d)
    assert run_factory(d, env, "update", "v1.0.0")[0] == 0
    commit(d)
    rc, out = run_factory(d, env, "rollback")
    assert rc == 0 and pin(d)["tag"] == "v1.1.0", out
    assert "v1.1.0" in run_factory(d, env, "version")[1] and "v1.0.0" in run_factory(d, env, "releases")[1]
    commit(d)
    rc, out = run_factory(d, env, "update")  # a pin exists: plain update is the release client
    assert rc == 0 and "already" in out, out


# --- small pieces ---------------------------------------------------------------------------------------------------

def load_client():
    spec = importlib.util.spec_from_file_location("factory_release", CLIENT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_versions_sort_as_semantic_versions_and_the_checksum_file_is_read_strictly():
    m = load_client()
    tags = ["v1.10.0", "v1.2.0", "v1.2.0-rc.1", "v2.0.0", "v1.9.9"]
    assert sorted(tags, key=m.sort_key) == ["v1.2.0-rc.1", "v1.2.0", "v1.9.9", "v1.10.0", "v2.0.0"]
    assert m.normalize_tag("1.4.0") == "v1.4.0" and m.normalize_tag("v1.4.0") == "v1.4.0"
    for bad in ("latest", "v1.4", "1.4.0; rm -rf /", "../v1.4.0"):
        try:
            m.normalize_tag(bad)
        except m.FactoryError as e:
            assert e.code == "bad_version" and e.fix
        else:
            raise AssertionError(bad)
    h = "a" * 64
    assert m.checksum_for("%s  software-factory-1.0.0.tar.gz\n%s *other\n" % (h, "b" * 64), "software-factory-1.0.0.tar.gz") == h
    for text in ("", "nothing here\n", "%s  other.tar.gz\n" % h, "xyz  software-factory-1.0.0.tar.gz\n"):
        try:
            m.checksum_for(text, "software-factory-1.0.0.tar.gz")
        except m.FactoryError as e:
            assert e.code in ("bad_checksum", "incomplete_release")
        else:
            raise AssertionError(text)


# --- against this repo's own tree --------------------------------------------------------------------------------

def test_a_release_built_from_this_repo_installs_into_a_project_and_passes_the_verification():
    src = tempfile.mkdtemp()
    shutil.copytree(os.path.join(REPO, "software-factory"), os.path.join(src, "software-factory"), symlinks=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    git(src, "init", "-q", "-b", "main")
    git(src, "add", "-A", "-f")
    git(src, "commit", "-q", "-m", "snapshot")
    out_dir = tempfile.mkdtemp()
    built = build_release.build(src, out_dir, None)
    tag = "v" + built["version"]
    gh, d, env = world()
    gh.assets[tag] = {n: open(os.path.join(out_dir, n), "rb").read() for n in os.listdir(out_dir)}
    gh.releases.insert(0, {"tag": tag, "date": "2026-11-01T10:00:00Z", "body": "- real tree (abcdef0)\n", "pre": False})
    rc, out = fac(d, env, "update")
    assert rc == 0, out
    for rel in (".claude/hooks/factory_release.py", ".claude/hooks/factory_doctor.py", ".claude/ci/ci.sh", ".claude/ci/entrypoint.sh",
                ".claude/settings.json", ".claude/agents/reviewer.md", ".claude/skills/next-task/SKILL.md", "factory", "factory-loop.sh"):
        assert os.path.isfile(os.path.join(d, rel)) and not os.path.islink(os.path.join(d, rel)), rel
    assert os.access(os.path.join(d, "factory"), os.X_OK) and os.access(os.path.join(d, ".claude/ci/ci.sh"), os.X_OK)
    p = subprocess.run(["bash", os.path.join(d, "factory"), "help"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 0 and "rollback" in p.stdout, p.stderr
    p = subprocess.run(["bash", os.path.join(d, "factory"), "version"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 0 and tag in p.stdout, p.stderr
    commit(d)
    assert fac(d, env, "update")[0] == 0 and "differ" not in fac(d, env, "version")[1]


def only_a_prerelease():
    gh, d, env = world()
    gh.add("0.1.0-alpha.1", pre=True)
    return gh, d, env


def test_with_only_a_prerelease_update_names_it_in_the_fix():
    gh, d, env = only_a_prerelease()
    rc, out = fac(d, env, "update")
    assert rc != 0 and "no_releases" in out, out
    assert "factory update v0.1.0-alpha.1" in out, out  # the exact command that works
    assert fac(d, env, "update", "v0.1.0-alpha.1")[0] == 0  # and it does


def test_with_no_release_at_all_the_fix_still_says_to_ask_the_owner():
    gh, d, env = world()
    rc, out = fac(d, env, "update")
    assert rc != 0 and "no_releases" in out and "ask the owner" in out and "v0" not in out, out


def test_version_shows_the_prerelease_when_there_is_no_full_release():
    gh, d, env = only_a_prerelease()
    rc, out = fac(d, env, "version")
    assert rc == 0 and "pre-release" in out and "v0.1.0-alpha.1" in out and "factory update v0.1.0-alpha.1" in out, out
    rc, out = fac(d, env, "version", "--json")
    assert json.loads(out)["prerelease"]["tag"] == "v0.1.0-alpha.1", out


def test_version_mentions_a_prerelease_newer_than_the_newest_full_release():
    gh, d, env = world("1.0.0")
    gh.add("1.1.0-rc.1", pre=True)
    rc, out = fac(d, env, "version")
    assert "Newest     v1.0.0" in out and "v1.1.0-rc.1" in out and "Pre-release" in out, out


def stack_world(project_files):
    """A release that carries the real stack detector, both CI workflows and a pnpm factory.json template."""
    gh, d, env = world()
    gh.add("1.0.0", files={
        "kit/.github/workflows/ci.yml": "name: CI\n# pnpm template\n",
        "kit/.github/workflows/ci-python.yml.template": "name: CI\n# python template\n",
        "kit/.claude/factory.json": json.dumps({"commands": {"install": "pnpm install", "test": "pnpm -s test", "build": "pnpm -s build"}}) + "\n"})
    for rel, body in project_files.items():
        os.makedirs(os.path.dirname(os.path.join(d, rel)) or d, exist_ok=True)
        open(os.path.join(d, rel), "w").write(body)
    commit(d, "the project")
    return gh, d, env


UNITTEST_TESTS = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n"


def test_a_first_release_install_in_a_python_project_gets_the_python_workflow_and_commands():
    gh, d, env = stack_world({"tests/test_a.py": UNITTEST_TESTS})
    rc, out = fac(d, env, "update", "v1.0.0")
    assert rc == 0, out
    assert "python template" in open(os.path.join(d, ".github/workflows/ci.yml")).read()
    assert not os.path.exists(os.path.join(d, ".github/workflows/ci-python.yml.template"))
    c = json.load(open(os.path.join(d, ".claude/factory.json")))["commands"]
    assert c["test"] == "python3 -m unittest discover" and not c["install"] and not c["build"], c
    assert "Stack: Python" in out, out
    # later updates leave the project's workflow and commands alone
    open(os.path.join(d, ".github/workflows/ci.yml"), "a").write("# mine\n")
    commit(d)
    gh.add("1.1.0")
    assert fac(d, env, "update")[0] == 0
    assert open(os.path.join(d, ".github/workflows/ci.yml")).read().endswith("# mine\n")
    assert json.load(open(os.path.join(d, ".claude/factory.json")))["commands"]["test"] == "python3 -m unittest discover"


def test_code_in_a_release_is_never_run_by_the_update():
    marker = os.path.join(tempfile.mkdtemp(), "ran")
    gh, d, env = stack_world({"tests/test_a.py": UNITTEST_TESTS})
    gh.add("1.0.1", files={"kit/.github/workflows/ci.yml": "name: CI\n# pnpm template\n",
                           "kit/.github/workflows/ci-python.yml.template": "name: CI\n# python template\n",
                           "hooks/factory_stack.py": "open(%r, 'w').write('x')\ndef detect(root):\n    open(%r, 'w').write('x')\n" % (marker, marker)})
    rc, out = fac(d, env, "update", "v1.0.1")
    assert rc == 0, out
    assert not os.path.exists(marker), "the release's own factory_stack.py ran during the update"
    assert "python template" in open(os.path.join(d, ".github/workflows/ci.yml")).read()  # the client's own detector decided


def test_a_first_release_install_in_a_node_project_is_unchanged():
    gh, d, env = stack_world({"package.json": "{}\n", "tests/test_a.py": UNITTEST_TESTS})
    rc, out = fac(d, env, "update", "v1.0.0")
    assert rc == 0, out
    assert "pnpm template" in open(os.path.join(d, ".github/workflows/ci.yml")).read()
    assert json.load(open(os.path.join(d, ".claude/factory.json")))["commands"]["test"] == "pnpm -s test"
    assert "Stack:" not in out, out


def test_a_first_release_install_in_an_unknown_stack_keeps_pnpm_and_says_what_to_edit():
    gh, d, env = stack_world({"main.c": "int main(){}\n"})
    rc, out = fac(d, env, "update", "v1.0.0")
    assert rc == 0 and "pnpm template" in open(os.path.join(d, ".github/workflows/ci.yml")).read(), out
    assert "could not tell" in out and ".github/workflows/ci.yml" in out, out


def test_a_first_release_install_never_overwrites_an_existing_workflow_or_factory_json():
    gh, d, env = stack_world({"tests/test_a.py": UNITTEST_TESTS, ".github/workflows/ci.yml": "name: mine\n",
                              ".claude/factory.json": '{"commands": {"test": "make test"}}\n'})
    rc, out = fac(d, env, "update", "v1.0.0")
    assert rc == 0, out
    assert open(os.path.join(d, ".github/workflows/ci.yml")).read() == "name: mine\n"
    assert json.load(open(os.path.join(d, ".claude/factory.json")))["commands"]["test"] == "make test"


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
