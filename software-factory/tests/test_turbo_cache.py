#!/usr/bin/env python3
"""The shared self-hosted Turborepo remote cache (#59): the checks left in Python until factory_settings and factory_doctor
are ported (#252); everything else is in turbo_cache.test.ts. Original summary:: the compose file, `factory turbo`, the environment agents and
CI get, and what happens without a token or when the cache is down.  python3 software-factory/tests/test_turbo_cache.py

Docker cannot run in the tests, so the compose file is checked as text and `docker` and `gh` are fakes on PATH that log
what they were given. The cache itself is a small HTTP server in the test that answers like the real one's
/v8/artifacts/status. The token below is made up for the test; it must never show up in any output, argument or log."""
import json, os, re, stat, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

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


def d_marker():
    return os.path.join(tempfile.gettempdir(), "factory-turbo-test-marker-ran")


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


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
