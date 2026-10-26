#!/usr/bin/env python3
"""The shared self-hosted Turborepo remote cache (#59): the compose file, `factory turbo`, the environment agents and
CI get, and what happens without a token or when the cache is down.  python3 software-factory/tests/test_turbo_cache.py

Docker cannot run in the tests, so the compose file is checked as text and `docker` and `gh` are fakes on PATH that log
what they were given. The cache itself is a small HTTP server in the test that answers like the real one's
/v8/artifacts/status. The token below is made up for the test; it must never show up in any output, argument or log."""
import json, os, re, stat, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from wiki_text import readme_and_wiki

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
TURBO = os.path.join(HOOKS, "factory_turbo.py")
COMPOSE = os.path.join(SF, "ci", "compose-turbo.yaml")
KIT = os.path.join(SF, "kit")
TOKEN = "tkn-7f3a9c1e5b2d4f60a8c9e1d3b5f7a901"
SIGKEY = "sig-0123456789abcdef0123456789abcdef0123"


def read(*p):
    return open(os.path.join(*p)).read()


# ---------- a fake cache ----------
class Cache(BaseHTTPRequestHandler):
    seen = []

    def do_GET(self):
        Cache.seen.append((self.path, self.headers.get("Authorization")))
        ok = self.headers.get("Authorization") == f"Bearer {TOKEN}" and self.path.startswith("/v8/artifacts/status")
        self.send_response(200 if ok else 401)
        self.end_headers()
        self.wfile.write(b'{"status":"enabled"}' if ok else b'{"message":"no"}')

    def log_message(self, *a):
        pass


def serve():
    server = HTTPServer(("127.0.0.1", 0), Cache)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


FAKE_DOCKER = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.docker"
[ "${TURBO_TOKEN:-}" = "$EXPECT_TOKEN" ] && echo "token-in-env" >>"$FAKE_LOG.docker"
echo "bind=${TURBO_CACHE_BIND:-} port=${TURBO_CACHE_PORT:-}" >>"$FAKE_LOG.docker"
[ "${FAKE_DOCKER_DOWN:-0}" = 1 ] && [ "$1" = info ] && exit 1
exit 0
'''
FAKE_GH = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.gh"
case "$1 $2" in
  "secret set") echo "stdin:$(cat)" >>"$FAKE_LOG.gh-stdin" ;;
esac
[ "${FAKE_GH_FAILS:-0}" = 1 ] && { echo "HTTP 403: Resource not accessible" >&2; exit 1; }
exit 0
'''


def project(turbo=None, remote="git@github.com:acme/Widget.git", extra=None):
    root = tempfile.mkdtemp()
    d, bin_ = os.path.join(root, "work"), os.path.join(root, "bin")
    os.makedirs(os.path.join(d, ".claude"))
    os.makedirs(bin_)
    subprocess.run(["git", "init", "-q", "-b", "main", d], check=True)
    subprocess.run(["git", "-C", d, "remote", "add", "origin", remote], check=True)
    cfg = dict(extra or {})
    if turbo is not None:
        cfg["turbo"] = turbo
    json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    for name, body in (("docker", FAKE_DOCKER), ("gh", FAKE_GH)):
        path = os.path.join(bin_, name)
        open(path, "w").write(body)
        os.chmod(path, 0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("TURBO_", "FACTORY_", "GITHUB_", "CLAUDE"))}
    env.update({"PATH": f"{bin_}:{os.environ['PATH']}", "HOME": root, "FAKE_LOG": os.path.join(root, "log"),
                "EXPECT_TOKEN": TOKEN, "FACTORY_TURBO_WAIT": "2"})
    return d, env


def turbo(d, env, *args, **extra_env):
    p = subprocess.run([sys.executable, TURBO, *args], cwd=d, env={**env, **extra_env}, capture_output=True,
                       text=True, timeout=60)
    return p


def log(env, suffix):
    try:
        return open(env["FAKE_LOG"] + suffix).read()
    except FileNotFoundError:
        return ""


def nowhere_leaks(p, env):
    everything = p.stdout + p.stderr + log(env, ".docker") + log(env, ".gh")
    assert TOKEN not in everything and SIGKEY not in everything, "a secret was printed or passed as an argument"


# ---------- the compose file ----------
def test_the_compose_file_pins_the_image_and_listens_on_loopback_unless_told_otherwise():
    text = read(COMPOSE)
    image = re.search(r"image:\s*(\S+)", text).group(1)
    assert image.startswith("ducktors/turborepo-remote-cache:"), image
    assert re.search(r":\$\{TURBO_CACHE_VERSION:-\d+\.\d+\.\d+\}$", image), "a pinned version, never latest: " + image
    assert "${TURBO_CACHE_BIND:-127.0.0.1}" in text, "reachable only where the owner chose: loopback by default"
    assert "0.0.0.0" not in text


def test_the_compose_file_takes_the_token_from_the_environment_and_holds_none():
    text = read(COMPOSE)
    assert re.search(r"TURBO_TOKEN:\s*['\"]?\$\{TURBO_TOKEN:\?[^}]+\}", text), "required, with a message, never a value"
    assert not re.search(r"TURBO_TOKEN:\s*['\"]?[A-Za-z0-9]{8,}", text)


def test_the_compose_file_is_a_small_unprivileged_service_with_a_named_volume_and_nothing_mounted_from_the_host():
    text = read(COMPOSE)
    assert "restart: unless-stopped" in text, "it comes back after a reboot"
    for bad in ("privileged", "network_mode", "pid: host", "/var/run/docker.sock"):
        assert bad not in text, bad
    assert not re.search(r"^\s*-\s*['\"]?(\.|~|/[^:\s]*:)", text, re.M), "no bind mounts: ci.sh would have to copy them (#111's class)"
    assert re.search(r"^\s*-\s*turbo-cache-data:/data", text, re.M) and "STORAGE_PROVIDER: local" in text
    assert "cap_drop" in text and "no-new-privileges" in text and "read_only: true" in text


# ---------- settings and defaults ----------
def test_the_turbo_settings_are_listed_with_defaults_and_checked():
    d, env = project()
    out = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_settings.py")], cwd=d, env=env,
                         capture_output=True, text=True).stdout
    for key in ("turbo.api", "turbo.team", "turbo.bind", "turbo.port", "turbo.secretsCommand"):
        assert key in out, key
    set_ = lambda *a: subprocess.run([sys.executable, os.path.join(HOOKS, "factory_settings.py"), "set", *a], cwd=d,
                                     env=env, capture_output=True, text=True)
    assert set_("turbo.port", "3400").returncode == 0
    assert set_("turbo.port", "many").returncode != 0
    assert json.load(open(os.path.join(d, ".claude", "factory.json")))["turbo"] == {"port": 3400}


def test_the_template_factory_json_has_the_turbo_block_with_no_secret_in_it():
    cfg = json.load(open(os.path.join(KIT, ".claude", "factory.json")))
    assert set(cfg["turbo"]) == {"api", "team", "bind", "port", "secretsCommand"}
    assert cfg["turbo"]["api"] == "" and cfg["turbo"]["bind"] == "127.0.0.1", "off until the owner sets an address"


# ---------- what agent sessions get ----------
def test_nothing_is_printed_while_the_cache_is_not_set_up():
    d, env = project()
    p = turbo(d, env, "env")
    assert p.returncode == 0 and p.stdout == "" and p.stderr == "", p


def test_agents_get_the_cache_address_team_token_and_signature_key_when_it_answers():
    server, url = serve()
    d, env = project({"api": url})
    p = turbo(d, env, "env", TURBO_TOKEN=TOKEN, TURBO_REMOTE_CACHE_SIGNATURE_KEY=SIGKEY)
    assert p.returncode == 0, p
    got = dict(re.findall(r"^export (\w+)=(.*)$", p.stdout, re.M))
    assert got["TURBO_API"] == url and got["TURBO_TEAM"] == "widget", got
    assert got["TURBO_TOKEN"] == TOKEN and got["TURBO_REMOTE_CACHE_SIGNATURE_KEY"] == SIGKEY
    assert "TURBO_REMOTE_CACHE_TIMEOUT" in got, "a slow cache must not stall a build for long"
    assert Cache.seen and Cache.seen[-1][1] == f"Bearer {TOKEN}", "it asked the cache before promising it"
    assert p.stderr == "", p.stderr
    server.shutdown()


def test_the_token_can_come_from_a_command_the_owner_sets_and_the_environment_wins():
    server, url = serve()
    d, env = project({"api": url, "secretsCommand": f"printf '# a comment\\nexport TURBO_TOKEN=\"{TOKEN}\"\\n"
                                                    f"TURBO_REMOTE_CACHE_SIGNATURE_KEY={SIGKEY}\\nOTHER=ignored\\n'"})
    p = turbo(d, env, "env")
    assert p.returncode == 0 and f"export TURBO_TOKEN={TOKEN}" in p.stdout, p
    assert f"export TURBO_REMOTE_CACHE_SIGNATURE_KEY={SIGKEY}" in p.stdout and "OTHER" not in p.stdout
    d2, env2 = project({"api": url, "secretsCommand": "echo TURBO_TOKEN=from-the-command-not-used"})
    p = turbo(d2, env2, "env", TURBO_TOKEN=TOKEN)
    assert f"export TURBO_TOKEN={TOKEN}" in p.stdout and "not-used" not in p.stdout, p
    server.shutdown()


def test_without_a_token_nothing_breaks_and_the_message_says_how_to_supply_one():
    server, url = serve()
    d, env = project({"api": url})
    p = turbo(d, env, "env")
    assert p.returncode == 0 and "export" not in p.stdout, p
    assert "TURBO_TOKEN" in p.stderr and "turbo.secretsCommand" in p.stderr and "local cache" in p.stderr, p.stderr
    assert "unset TURBO_TOKEN" in p.stdout, "a stale token from an earlier shell is not left behind"
    server.shutdown()


def test_a_cache_that_is_down_is_skipped_quickly_with_a_note():
    d, env = project({"api": "http://127.0.0.1:9"})
    p = turbo(d, env, "env", TURBO_TOKEN=TOKEN)
    assert p.returncode == 0 and "export" not in p.stdout and "unset TURBO_API" in p.stdout, p
    assert "can't be reached" in p.stderr and "local cache" in p.stderr, p.stderr
    nowhere_leaks(p, env)


def test_a_rejected_token_is_said_and_not_used():
    server, url = serve()
    d, env = project({"api": url})
    p = turbo(d, env, "env", TURBO_TOKEN="a-different-token-0000000000000000")
    assert "export" not in p.stdout and "rejected" in p.stderr, p
    assert "a-different-token" not in p.stdout + p.stderr
    server.shutdown()


def test_a_failing_secrets_command_degrades_and_its_output_is_not_shown():
    server, url = serve()
    d, env = project({"api": url, "secretsCommand": f"echo {TOKEN}; echo 'no key file' >&2; exit 3"})
    p = turbo(d, env, "env")
    assert p.returncode == 0 and "export" not in p.stdout, p
    assert "secretsCommand" in p.stderr and "exit 3" in p.stderr and "no key file" in p.stderr
    nowhere_leaks(p, env)
    server.shutdown()


def test_an_address_that_is_not_http_is_refused_without_stopping_anything():
    d, env = project({"api": "file:///etc/passwd"})
    p = turbo(d, env, "env", TURBO_TOKEN=TOKEN)
    assert p.returncode == 0 and "export" not in p.stdout and "http" in p.stderr, p


def test_status_shows_where_each_part_comes_from_and_never_a_secret():
    server, url = serve()
    d, env = project({"api": url})
    p = turbo(d, env, "status", TURBO_TOKEN=TOKEN, TURBO_REMOTE_CACHE_SIGNATURE_KEY=SIGKEY)
    assert p.returncode == 0, p
    for word in ("address", "team", "widget", "token", "environment", "signature", "answers"):
        assert word in p.stdout, (word, p.stdout)
    nowhere_leaks(p, env)
    p = turbo(d, env, "status")
    assert p.returncode == 1 and "missing" in p.stdout and "turbo.secretsCommand" in p.stdout, p
    server.shutdown()


# ---------- the session hook and the loop ----------
def test_a_plain_session_gets_the_cache_in_its_env_file_and_the_token_is_not_printed():
    server, url = serve()
    d, env = project({"api": url})
    subprocess.run(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"],
                   check=True)
    envfile = os.path.join(os.path.dirname(d), "claude-env")
    open(envfile, "w").close()
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_session.py")], cwd=d, input="{}", text=True,
                       capture_output=True, env={**env, "CLAUDE_ENV_FILE": envfile, "CLAUDE_PROJECT_DIR": d,
                                                 "TURBO_TOKEN": TOKEN}, timeout=60)
    assert p.returncode == 0, p
    written = open(envfile).read()
    assert f"export TURBO_API={url}" in written and f"export TURBO_TOKEN={TOKEN}" in written, written
    assert TOKEN not in p.stdout + p.stderr, "the hook prints to the agent's context"
    server.shutdown()


def test_the_loop_asks_for_the_cache_before_every_task_so_a_late_cache_is_picked_up():
    text = read(SF, "factory-loop.sh")
    isolate = text.split("isolate() {")[1].split("\n}\n")[0]
    assert 'factory_turbo.py" env' in isolate, "inside isolate(), which runs before each task"
    assert subprocess.run(["bash", "-n", os.path.join(SF, "factory-loop.sh")]).returncode == 0


# ---------- install and down ----------
def test_install_starts_the_service_with_the_token_in_the_environment_never_in_an_argument():
    server, url = serve()
    d, env = project({"api": url, "bind": "127.0.0.1", "port": 3401})
    p = turbo(d, env, "install", "--no-github", TURBO_TOKEN=TOKEN)
    assert p.returncode == 0, p
    docker = log(env, ".docker")
    assert "compose --file" in docker and "compose-turbo.yaml" in docker
    assert "--project-name widget-turbo-cache" in docker and "up -d" in docker, docker
    assert "token-in-env" in docker and "bind=127.0.0.1 port=3401" in docker, docker
    nowhere_leaks(p, env)
    assert log(env, ".gh") == "", "--no-github leaves the repository alone"
    server.shutdown()


def test_install_gives_ci_the_same_cache_through_repo_variables_and_secrets_sent_on_stdin():
    server, url = serve()
    d, env = project({"api": url})
    p = turbo(d, env, "install", TURBO_TOKEN=TOKEN, TURBO_REMOTE_CACHE_SIGNATURE_KEY=SIGKEY)
    assert p.returncode == 0, p
    gh = log(env, ".gh")
    assert f"variable set TURBO_API --body {url}" in gh and "variable set TURBO_TEAM --body widget" in gh, gh
    assert "secret set TURBO_TOKEN" in gh and "secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY" in gh, gh
    assert f"stdin:{TOKEN}" in log(env, ".gh-stdin") and f"stdin:{SIGKEY}" in log(env, ".gh-stdin")
    nowhere_leaks(p, env)
    server.shutdown()


def test_install_without_a_token_stops_before_docker_and_says_how_to_supply_one():
    server, url = serve()
    d, env = project({"api": url})
    p = turbo(d, env, "install")
    assert p.returncode == 1, p
    assert "TURBO_TOKEN" in p.stderr and "turbo.secretsCommand" in p.stderr and "openssl rand" in p.stderr, p.stderr
    assert log(env, ".docker") == "" and log(env, ".gh") == ""
    server.shutdown()


def test_install_without_an_address_stops_and_names_the_setting():
    d, env = project()
    p = turbo(d, env, "install", TURBO_TOKEN=TOKEN)
    assert p.returncode == 1 and "turbo.api" in p.stderr and log(env, ".docker") == "", p


def test_install_says_so_when_docker_is_not_running():
    server, url = serve()
    d, env = project({"api": url})
    p = turbo(d, env, "install", TURBO_TOKEN=TOKEN, FAKE_DOCKER_DOWN="1")
    assert p.returncode == 1 and "Docker" in p.stderr and "compose" not in log(env, ".docker"), p
    server.shutdown()


def test_install_warns_when_the_address_cannot_be_reached_from_other_machines_or_runners():
    server, url = serve()
    d, env = project({"api": "http://100.64.0.7:3335", "bind": "127.0.0.1"})
    p = turbo(d, env, "install", "--no-github", TURBO_TOKEN=TOKEN)
    assert "turbo.bind" in p.stdout + p.stderr and "Tailscale" in p.stdout + p.stderr, p
    d, env = project({"api": url, "bind": "0.0.0.0"})
    p = turbo(d, env, "install", "--no-github", TURBO_TOKEN=TOKEN)
    assert "every network" in p.stdout + p.stderr, p
    server.shutdown()


def test_a_github_failure_after_the_service_is_up_is_reported_with_the_fix_and_no_secret():
    server, url = serve()
    d, env = project({"api": url})
    p = turbo(d, env, "install", TURBO_TOKEN=TOKEN, FAKE_GH_FAILS="1")
    assert p.returncode == 1 and "admin" in p.stdout + p.stderr and "up -d" in log(env, ".docker"), p
    nowhere_leaks(p, env)
    server.shutdown()


def test_down_stops_it_and_purge_also_removes_the_stored_artifacts():
    d, env = project({"api": "http://127.0.0.1:9"})
    assert turbo(d, env, "down").returncode == 0
    assert re.search(r"--project-name widget-turbo-cache down( --remove-orphans)?$", log(env, ".docker").splitlines()[0])
    assert turbo(d, env, "down", "--purge").returncode == 0
    assert "down --remove-orphans --volumes" in log(env, ".docker") or "down --volumes" in log(env, ".docker")


# ---------- CI ----------
def test_ci_env_prints_github_env_lines_only_when_everything_is_there_and_the_cache_answers():
    server, url = serve()
    d, env = project()
    p = turbo(d, env, "ci-env", TURBO_API=url, TURBO_TEAM="widget", TURBO_TOKEN=TOKEN)
    lines = dict(l.split("=", 1) for l in p.stdout.splitlines())
    assert p.returncode == 0 and lines == {"TURBO_API": url, "TURBO_TEAM": "widget", "TURBO_TOKEN": TOKEN,
                                           "TURBO_REMOTE_CACHE_TIMEOUT": lines["TURBO_REMOTE_CACHE_TIMEOUT"]}, p
    p = turbo(d, env, "ci-env", TURBO_API=url, TURBO_TEAM="widget", TURBO_TOKEN=TOKEN,
              TURBO_REMOTE_CACHE_SIGNATURE_KEY=SIGKEY)
    assert f"TURBO_REMOTE_CACHE_SIGNATURE_KEY={SIGKEY}" in p.stdout.splitlines()
    server.shutdown()


def test_ci_env_prints_nothing_for_a_job_without_secrets_with_no_variables_or_with_the_cache_down():
    server, url = serve()
    d, env = project()
    for extra in ({}, {"TURBO_API": url, "TURBO_TOKEN": ""}, {"TURBO_API": "", "TURBO_TOKEN": TOKEN},
                  {"TURBO_API": "http://127.0.0.1:9", "TURBO_TEAM": "widget", "TURBO_TOKEN": TOKEN}):
        p = turbo(d, env, "ci-env", **extra)
        assert p.returncode == 0 and p.stdout == "", (extra, p)
    p = turbo(d, env, "ci-env", TURBO_API="http://127.0.0.1:9", TURBO_TEAM="widget", TURBO_TOKEN=TOKEN)
    assert "can't be reached" in p.stderr and TOKEN not in p.stderr
    p = turbo(d, env, "ci-env", TURBO_API=url, TURBO_TOKEN="")  # a fork's pull request: secrets come in empty
    assert "no token" in p.stderr
    server.shutdown()


def test_ci_env_never_runs_a_command_from_the_settings_in_a_job():
    server, url = serve()
    if os.path.exists(d_marker()):
        os.remove(d_marker())
    d, env = project({"api": url, "secretsCommand": f"touch {d_marker()}; echo TURBO_TOKEN={TOKEN}"})
    turbo(d, env, "ci-env", TURBO_API=url, TURBO_TEAM="widget")
    assert not os.path.exists(d_marker())
    server.shutdown()


def d_marker():
    return os.path.join(tempfile.gettempdir(), "factory-turbo-test-marker-ran")


def test_ci_env_refuses_a_value_that_could_inject_another_variable():
    server, url = serve()
    d, env = project()
    p = turbo(d, env, "ci-env", TURBO_API=url, TURBO_TEAM="widget\nGITHUB_PATH=/tmp/x", TURBO_TOKEN=TOKEN)
    assert p.stdout == "" and "newline" in p.stderr or "letters" in p.stderr, p
    server.shutdown()


def test_the_workflow_template_uses_the_cache_for_the_heavy_job_and_never_for_a_fork():
    text = read(KIT, ".github", "workflows", "ci.yml")
    step = text.split("Shared remote cache")[1].split("\n      - ")[0]
    assert "if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository" in step
    for want in ("TURBO_API: ${{ vars.TURBO_API }}", "TURBO_TEAM: ${{ vars.TURBO_TEAM }}",
                 "TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}",
                 "TURBO_REMOTE_CACHE_SIGNATURE_KEY: ${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",
                 'factory_turbo.py ci-env >> "$GITHUB_ENV"'):
        assert want in step, want
    heavy = text.split("  check:")[1]
    assert heavy.index("Shared remote cache") < heavy.index("pnpm install"), "before the first build"
    assert "pull_request_target" not in text and re.search(r"permissions:\s*\n\s+contents: read", text)


# ---------- doctor, help, files ----------
def test_doctor_notes_an_unreachable_cache_never_fails_on_it_and_never_runs_the_secrets_command():
    marker = d_marker()
    if os.path.exists(marker):
        os.remove(marker)
    d, env = project({"api": "http://127.0.0.1:9", "secretsCommand": f"touch {marker}"})
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_doctor.py")], cwd=d, env=env,
                       capture_output=True, text=True, timeout=120)
    lines = [l for l in p.stdout.splitlines() if "turbo" in l.lower() and "cache" in l.lower()]
    assert any(l.startswith("note") and "can't be reached" in l for l in lines), p.stdout
    assert not any(l.startswith("fix") and "turbo" in l.lower() for l in p.stdout.splitlines())
    assert not os.path.exists(marker), "doctor never decrypts or runs the owner's secrets command"


def test_doctor_says_when_turbo_json_does_not_sign_artifacts_but_a_key_is_set():
    server, url = serve()
    d, env = project({"api": url})
    open(os.path.join(d, "turbo.json"), "w").write('{"tasks": {}}')
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_doctor.py")], cwd=d,
                       env={**env, "TURBO_REMOTE_CACHE_SIGNATURE_KEY": SIGKEY}, capture_output=True, text=True, timeout=120)
    assert re.search(r"note .*signature", p.stdout), p.stdout
    assert SIGKEY not in p.stdout
    server.shutdown()


def test_factory_help_lists_the_turbo_commands_and_the_command_is_wired():
    text = read(SF, "factory")
    assert "turbo)" in text and "factory_turbo.py" in text
    out = subprocess.run(["bash", os.path.join(SF, "factory"), "help"], cwd=SF, capture_output=True, text=True).stdout
    for want in ("turbo status", "turbo install", "turbo down"):
        assert want in out, want


def test_the_new_files_reach_projects_through_the_old_kit_paths_too():
    for rel in ("hooks/factory_turbo.py", "ci/compose-turbo.yaml"):
        old = os.path.join(KIT, ".claude", rel)
        assert os.path.islink(old) and os.path.realpath(old) == os.path.join(SF, rel), old


def test_the_docs_cover_setup_security_signing_and_the_open_owner_item():
    readme = readme_and_wiki()
    for want in ("factory turbo install", "turbo.secretsCommand", "TURBO_REMOTE_CACHE_SIGNATURE_KEY", "Tailscale",
                 "openssl rand", "fork", "FULL TURBO", "remoteCache"):
        assert want in readme, want


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
