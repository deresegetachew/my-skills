#!/usr/bin/env python3
"""`factory turbo`: the shared self-hosted Turborepo remote cache for the agents and CI (#59).

Every agent worktree, every machine and every CI job used to build, type-check and test the same unchanged packages
from scratch. One small cache server per project (ducktors/turborepo-remote-cache, ci/compose-turbo.yaml) on the
factory machine, reachable only on the local network or Tailscale, lets them share the results.

  factory turbo status            what is set, where each part comes from, and whether the cache answers (no secrets)
  factory turbo install [--no-github]
                                  start the server on this machine (docker compose, restart unless-stopped), wait until it
                                  answers, and give CI the same cache (repo variables TURBO_API and TURBO_TEAM, secrets
                                  TURBO_TOKEN and TURBO_REMOTE_CACHE_SIGNATURE_KEY, sent on stdin). Run it again to update.
  factory turbo down [--purge]    stop it (--purge also removes the stored artifacts)
  factory turbo env               export lines for an agent session (used by factory-loop.sh and the session hook);
                                  prints the token, so only eval it. Prints nothing while the cache is not set up.
  factory turbo ci-env            KEY=value lines for $GITHUB_ENV in the CI workflow, from the job's environment only

Settings (the `turbo` block of .claude/factory.json; `factory settings` lists them): api (the address agents and CI
use, for example http://100.64.0.7:3335; empty: the cache is off), team (default: the repository's name), bind and
port (where the server listens on this machine; 127.0.0.1 unless you choose a Tailscale or LAN address), and
secretsCommand (a command that prints TURBO_TOKEN=... and TURBO_REMOTE_CACHE_SIGNATURE_KEY=... lines, for example
`sops -d --output-type dotenv secrets/factory.yaml`). The environment wins over the command, and the code works
without any of it: no token or an unreachable cache means the local Turborepo cache only, with a note saying why.

The token and the signature key are never written to a file, never put in an argument and never printed, except by
`env` and `ci-env`, whose output is meant for the shell and for $GITHUB_ENV.
"""
import json, os, re, shlex, shutil, subprocess, sys, time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import ProxyHandler, Request, build_opener

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from factory_config import load  # noqa: E402

DEFAULTS = {"api": "", "team": "", "bind": "127.0.0.1", "port": 3335, "secretsCommand": ""}
SECRET_KEYS = ("TURBO_TOKEN", "TURBO_REMOTE_CACHE_SIGNATURE_KEY")
# Seconds Turborepo waits for the cache before it builds locally. Its default is much longer.
CACHE_TIMEOUT = "10"
VALUE = re.compile(r"[A-Za-z0-9._~+/=:-]{8,512}")
LOOPBACK = ("localhost", "127.0.0.1", "::1")
SETUP_HINT = ("Make a token once with `openssl rand -hex 32` and keep it where only you can read it, for example in "
              "your sops secrets file. Then either export TURBO_TOKEN in your shell profile, or set "
              "turbo.secretsCommand to a command that prints TURBO_TOKEN=<token> (and, for signed artifacts, "
              "TURBO_REMOTE_CACHE_SIGNATURE_KEY=<32 or more characters>), for example "
              "`factory settings set turbo.secretsCommand 'sops -d --output-type dotenv secrets/factory.yaml'`.")
LOCAL_ONLY = "Builds use the local cache only."


def say(text, stream=None):
    print(f"factory turbo: {text}", file=stream or sys.stderr)


def die(text):
    say(text)
    sys.exit(1)


# ---------- settings ----------
def repo_name():
    p = subprocess.run(["git", "config", "--get", "remote.origin.url"], capture_output=True, text=True)
    m = re.search(r"github\.com[:/][\w.-]+/([\w.-]+?)(?:\.git)?/?$", p.stdout.strip()) if p.returncode == 0 else None
    return m.group(1).lower() if m else ""


def settings(cfg, environ=None):
    """The turbo settings, the environment over factory.json. Raises ValueError for an address that is no use."""
    environ = os.environ if environ is None else environ
    s = {**DEFAULTS, **(cfg.get("turbo") or {})}
    api = (environ.get("TURBO_API") or s["api"] or "").strip().rstrip("/")
    team = environ.get("TURBO_TEAM") or s["team"] or repo_name() or "factory"
    if api:
        u = urlparse(api)
        if re.search(r"\s", api) or u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
            raise ValueError(f"the cache address {api!r} must be http:// or https:// with a host, and no user, "
                             "password or spaces in it. Set it with `factory settings set turbo.api http://<host>:<port>`.")
        try:
            u.port
        except ValueError:
            raise ValueError(f"the cache address {api!r} has an invalid port.")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", team):
        raise ValueError(f"the team {team!r} must be letters, digits, dots, dashes or underscores. "
                         "Set it with `factory settings set turbo.team <name>`.")
    return {"api": api, "team": team, "bind": str(s["bind"]), "port": int(s["port"]),
            "secretsCommand": str(s["secretsCommand"] or ""), "fromEnvApi": bool(environ.get("TURBO_API"))}


# ---------- secrets ----------
def scrub(text, secrets):
    for value in secrets:
        if value:
            text = text.replace(value, "***")
    return text


def parse_dotenv(text):
    found = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, eq, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if eq and key in SECRET_KEYS:
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            found[key] = value
    return found


def resolve_secrets(s, environ=None, run_command=True):
    """(secrets, where, notes): TURBO_TOKEN and TURBO_REMOTE_CACHE_SIGNATURE_KEY from the environment first, then from
    the owner's secrets command. `where` says which. Never raises; a bad value is left out and noted (not shown)."""
    environ = os.environ if environ is None else environ
    found, where, notes = {}, {}, []
    for key in SECRET_KEYS:
        if environ.get(key):
            found[key], where[key] = environ[key], "the environment"
    if run_command and s["secretsCommand"] and any(k not in found for k in SECRET_KEYS):
        try:
            p = subprocess.run(s["secretsCommand"], shell=True, capture_output=True, text=True, timeout=60,
                               stdin=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired) as e:
            notes.append(f"turbo.secretsCommand didn't finish ({type(e).__name__}).")
        else:
            if p.returncode != 0:
                err = scrub((p.stderr.strip().splitlines() or [""])[0], parse_dotenv(p.stdout).values())[:160]
                notes.append(f"turbo.secretsCommand failed (exit {p.returncode})" + (f": {err}" if err else "") + ".")
            for key, value in parse_dotenv(p.stdout).items():
                if key not in found and value:
                    found[key], where[key] = value, "turbo.secretsCommand"
    for key in list(found):
        if not VALUE.fullmatch(found[key]):
            notes.append(f"{key} is left out: a value must be 8 to 512 letters, digits or . _ ~ + / = : - (no "
                         "spaces, quotes or newlines).")
            del found[key], where[key]
    return found, where, notes


# ---------- the cache ----------
def probe(api, team, token, timeout=3):
    """('ok'|'rejected'|'down'|'http', detail). The machine's own proxy settings are ignored: the cache is private."""
    request = Request(f"{api}/v8/artifacts/status?slug={quote(team)}",
                      headers={"Authorization": f"Bearer {token}"} if token else {})
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=timeout) as r:
            return ("ok", "") if 200 <= r.status < 300 else ("http", f"HTTP {r.status}")
    except HTTPError as e:
        return ("rejected", "") if e.code in (401, 403) else ("http", f"HTTP {e.code}")
    except (URLError, OSError, ValueError) as e:
        return "down", type(getattr(e, "reason", e)).__name__


def explain(api, state, detail):
    if state == "rejected":
        return (f"the cache at {api} rejected the token (the token in use differs from the one the server was started "
                f"with). {LOCAL_ONLY} Run `factory turbo install` again after changing the token.")
    if state == "http":
        return f"the cache at {api} answered {detail}, not what a cache says. {LOCAL_ONLY}"
    return (f"the cache at {api} can't be reached ({detail or 'no answer'}). Is `factory turbo install` done on the "
            f"cache machine, and is this machine on the same network or Tailscale? {LOCAL_ONLY}")


def agent_env(cfg, environ=None, probe_fn=probe):
    """(env, unset, notes) for an agent session. All empty while the cache is not set up (turbo.api empty). When it is
    set up but unusable, `unset` names the variables to clear, so a stale value from an earlier shell is not left."""
    environ = os.environ if environ is None else environ
    try:
        s = settings(cfg, environ)
    except ValueError as e:
        return {}, [], [f"{e} {LOCAL_ONLY}"]
    if not s["api"]:
        return {}, [], []
    everything = list(("TURBO_API", "TURBO_TEAM", *SECRET_KEYS, "TURBO_REMOTE_CACHE_TIMEOUT"))
    secrets, _, notes = resolve_secrets(s, environ)
    token = secrets.get("TURBO_TOKEN")
    if not token:
        return {}, everything, notes + [f"TURBO_TOKEN isn't set, so the cache at {s['api']} isn't used. {LOCAL_ONLY} "
                                        f"{SETUP_HINT}"]
    state, detail = probe_fn(s["api"], s["team"], token)
    if state != "ok":
        return {}, everything, notes + [explain(s["api"], state, detail)]
    env = {"TURBO_API": s["api"], "TURBO_TEAM": s["team"], "TURBO_TOKEN": token}
    if secrets.get("TURBO_REMOTE_CACHE_SIGNATURE_KEY"):
        env["TURBO_REMOTE_CACHE_SIGNATURE_KEY"] = secrets["TURBO_REMOTE_CACHE_SIGNATURE_KEY"]
    env["TURBO_REMOTE_CACHE_TIMEOUT"] = CACHE_TIMEOUT
    return env, [], notes


def cmd_env(cfg):
    env, unset, notes = agent_env(cfg)
    for n in notes:
        say(n)
    for k in unset:
        print(f"unset {k}")
    for k, v in env.items():
        print(f"export {k}={shlex.quote(v)}")
    return 0


def cmd_ci_env(cfg):
    """From the job's environment only. A job never runs the project's secrets command: it is code from the branch."""
    environ = os.environ
    api = (environ.get("TURBO_API") or "").strip()
    if not api:
        return 0  # no repository variable: the cache is not set up for CI, and that is fine
    try:
        s = settings({}, environ)
    except ValueError as e:
        say(f"{e} {LOCAL_ONLY}")
        return 0
    token = environ.get("TURBO_TOKEN", "")
    if not token:
        say(f"no token in this job (a pull request from another repository gets no secrets), so the cache isn't used. "
            f"{LOCAL_ONLY}")
        return 0
    secrets, _, notes = resolve_secrets(s, environ, run_command=False)
    for n in notes:
        say(n)
    if "TURBO_TOKEN" not in secrets:
        return 0
    state, detail = probe(s["api"], s["team"], secrets["TURBO_TOKEN"])
    if state != "ok":
        say(explain(s["api"], state, detail))
        return 0
    lines = {"TURBO_API": s["api"], "TURBO_TEAM": s["team"], "TURBO_TOKEN": secrets["TURBO_TOKEN"]}
    if secrets.get("TURBO_REMOTE_CACHE_SIGNATURE_KEY"):
        lines["TURBO_REMOTE_CACHE_SIGNATURE_KEY"] = secrets["TURBO_REMOTE_CACHE_SIGNATURE_KEY"]
    lines["TURBO_REMOTE_CACHE_TIMEOUT"] = CACHE_TIMEOUT
    for k, v in lines.items():
        print(f"{k}={v}")
    return 0


# ---------- status ----------
def turbo_json_signs():
    try:
        return bool(json.load(open("turbo.json")).get("remoteCache", {}).get("signature"))
    except (OSError, ValueError, AttributeError):
        return None  # no turbo.json here


def cmd_status(cfg):
    try:
        s = settings(cfg)
    except ValueError as e:
        print(f"address     invalid: {e}")
        return 1
    if not s["api"]:
        print("The shared build cache is off: turbo.api is empty.")
        print("Turn it on: pick the address agents and CI will use (this machine's Tailscale or LAN address and port "
              f"{s['port']}), `factory settings set turbo.api http://<address>:{s['port']}`, `factory settings set "
              "turbo.bind <address>`, then `factory turbo install`. docs/wiki/ci.md, \"A shared build cache\".")
        return 0
    secrets, where, notes = resolve_secrets(s)
    bad = 0
    print(f"address     {s['api']}" + ("  (from the environment)" if s["fromEnvApi"] else "  (turbo.api)"))
    print(f"team        {s['team']}")
    print(f"listens     {s['bind']}:{s['port']} on the machine that runs the server")
    if "TURBO_TOKEN" in secrets:
        print(f"token       found, from {where['TURBO_TOKEN']}")
    else:
        bad = 1
        print("token       missing. " + SETUP_HINT)
    if "TURBO_REMOTE_CACHE_SIGNATURE_KEY" in secrets:
        signs = turbo_json_signs()
        print(f"signature   key found, from {where['TURBO_REMOTE_CACHE_SIGNATURE_KEY']}"
              + ("" if signs is not False else "; but turbo.json has no remoteCache.signature, so nothing is signed"))
    else:
        print("signature   no key (artifacts are not signed). Optional: docs/wiki/ci.md, \"A shared build cache\".")
    for n in notes:
        print(f"note        {n}")
    if "TURBO_TOKEN" in secrets:
        state, detail = probe(s["api"], s["team"], secrets["TURBO_TOKEN"])
        if state == "ok":
            print("cache       answers, and accepts the token")
        else:
            bad = 1
            print("cache       " + explain(s["api"], state, detail))
    return bad


# ---------- install and down ----------
def compose_file():
    return os.path.join(HERE, "..", "ci", "compose-turbo.yaml")


def project_name(s):
    return re.sub(r"[^a-z0-9_-]", "-", s["team"].lower()).strip("-_") + "-turbo-cache"


def compose(s, *args, env=None):
    return subprocess.run(["docker", "compose", "--file", compose_file(), "--project-name", project_name(s), *args],
                          env=env, capture_output=True, text=True)


def reach_notes(s):
    host = urlparse(s["api"]).hostname
    if s["bind"] in ("0.0.0.0", "::"):
        yield ("turbo.bind listens on every network interface of this machine. Prefer this machine's Tailscale or LAN "
               "address, so only that network can reach the cache.")
    elif s["bind"] in LOOPBACK and host not in LOOPBACK:
        yield (f"turbo.api points at {host}, but the cache listens on {s['bind']} only, so other machines and the CI "
               "runner containers can't reach it. Set turbo.bind to this machine's Tailscale or LAN address "
               "(`factory settings set turbo.bind <address>`) and run `factory turbo install` again.")


def cmd_install(cfg, args):
    github = "--no-github" not in args
    unknown = [a for a in args if a != "--no-github"]
    if unknown:
        die(f"unknown option {unknown[0]} (factory turbo install [--no-github])")
    try:
        s = settings(cfg)
    except ValueError as e:
        die(str(e))
    if not s["api"]:
        die("turbo.api is empty, so there is no address to serve. Fix: pick this machine's Tailscale or LAN address and "
            f"run `factory settings set turbo.api http://<address>:{s['port']}` and `factory settings set turbo.bind "
            "<address>`, commit .claude/factory.json in a PR, then run this again.")
    secrets, where, notes = resolve_secrets(s)
    for n in notes:
        say(n)
    if "TURBO_TOKEN" not in secrets:
        die("there is no cache token. " + SETUP_HINT)
    if not shutil.which("docker"):
        die("Docker isn't installed or isn't on your PATH. Fix: install Docker, then run this again.")
    if subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        die("Docker isn't running (or isn't reachable by this user). Fix: start Docker, then run this again.")
    # The token goes to docker compose in its environment, so it is in no argument and no file.
    env = {**os.environ, "TURBO_TOKEN": secrets["TURBO_TOKEN"], "TURBO_CACHE_BIND": s["bind"],
           "TURBO_CACHE_PORT": str(s["port"])}
    p = compose(s, "up", "-d", env=env)
    if p.returncode != 0:
        die("docker compose couldn't start the cache: " + scrub(p.stderr.strip()[-400:], secrets.values()))
    print(f"Started {project_name(s)} (listens on {s['bind']}:{s['port']}; restarts with Docker).")
    for n in reach_notes(s):
        print(f"note: {n}")
    deadline = time.time() + float(os.environ.get("FACTORY_TURBO_WAIT", "30"))
    while True:
        state, detail = probe(s["api"], s["team"], secrets["TURBO_TOKEN"], timeout=2)
        if state == "ok" or time.time() >= deadline:
            break
        time.sleep(1)
    if state == "ok":
        print(f"The cache answers at {s['api']}. Agents started from now on use it (factory turbo status).")
    else:
        print(f"note: {explain(s['api'], state, detail)}")
    failed = 0
    if github:
        failed = share_with_github(s, secrets)
    else:
        print("CI was left alone (--no-github): set the repo variables TURBO_API and TURBO_TEAM and the secrets "
              "TURBO_TOKEN (and TURBO_REMOTE_CACHE_SIGNATURE_KEY) yourself.")
    return failed


def share_with_github(s, secrets):
    steps = [(["variable", "set", "TURBO_API", "--body", s["api"]], None, "variable TURBO_API"),
             (["variable", "set", "TURBO_TEAM", "--body", s["team"]], None, "variable TURBO_TEAM")]
    for key in SECRET_KEYS:
        if key in secrets:
            steps.append((["secret", "set", key, "--app", "actions"], secrets[key], f"secret {key}"))
    done, failed = [], []
    for args, stdin, what in steps:
        p = subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True)
        (done if p.returncode == 0 else failed).append(what)
    if done:
        print("CI now has: " + ", ".join(done) + ".")
    if failed:
        print("note: GitHub didn't take " + ", ".join(failed) + ". Setting repository variables and secrets needs "
              "admin on the repository: ask an admin to run this, or set them under Settings > Secrets and variables "
              "> Actions (the values: `factory turbo env` prints them, carefully).")
        return 1
    print("Jobs from pull requests in this repository use the cache; those from forks get no secrets and don't.")
    return 0


def cmd_down(cfg, args):
    purge = "--purge" in args
    if [a for a in args if a != "--purge"]:
        die("usage: factory turbo down [--purge]")
    try:
        s = settings(cfg)
    except ValueError as e:
        die(str(e))
    if not shutil.which("docker"):
        die("Docker isn't installed or isn't on your PATH.")
    p = compose(s, "down", "--remove-orphans", *(["--volumes"] if purge else []), env={**os.environ, "TURBO_TOKEN": "x"})
    if p.returncode != 0:
        die("docker compose couldn't stop the cache: " + p.stderr.strip()[-400:])
    print(f"Stopped {project_name(s)}" + (" and removed the stored artifacts." if purge else ". Its artifacts are kept."))
    return 0


def main(argv):
    if os.environ.get("CLAUDE_PROJECT_DIR") is None:
        root = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        if root.returncode == 0:
            os.environ["CLAUDE_PROJECT_DIR"] = root.stdout.strip()
    cfg = load()
    cmd, args = (argv[0] if argv else "status"), argv[1:]
    if cmd == "env":
        return cmd_env(cfg)
    if cmd == "ci-env":
        return cmd_ci_env(cfg)
    if cmd == "status":
        return cmd_status(cfg)
    if cmd == "install":
        return cmd_install(cfg, args)
    if cmd == "down":
        return cmd_down(cfg, args)
    die("usage: factory turbo status | install [--no-github] | down [--purge] | env | ci-env")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
