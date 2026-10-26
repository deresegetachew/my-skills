#!/usr/bin/env python3
"""`factory doctor`: check this machine and project for what the factory needs, and say how to fix each gap (#63).

Read-only: it runs version and status commands, never installs, logs in, decrypts or prints a secret. Each line is
`ok`, `fix` (the factory won't work until it's fixed, with the fix) or `note` (worth a look). Exit 1 when any `fix`.
Checks that don't apply to the project (Node without a package.json, sops without a .sops.yaml) are left out.

  python3 .claude/hooks/factory_doctor.py [--sandbox]

`--sandbox` adds the checks of a sandboxed factory machine (factory_sandbox.py): run it as the dedicated user that
`factory bootstrap` made. It runs a few network probes and one container, so it takes longer.
"""
import fnmatch, json, os, re, shutil, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402

LINUX = sys.platform.startswith("linux")


class Report:
    def __init__(self):
        self.fixes = 0

    def ok(self, what):
        print(f"ok    {what}")

    def fix(self, what, how):
        self.fixes += 1
        print(f"fix   {what}: {how}")

    def note(self, what, how):
        print(f"note  {what}: {how}")


def run(*a, timeout=20):
    try:
        p = subprocess.run(a, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def version(text):
    m = re.search(r"(\d+)(?:\.(\d+))?", text or "")
    return (int(m.group(1)), int(m.group(2) or 0)) if m else None


def tools(r):
    if shutil.which("git"):
        r.ok("git")
    else:
        r.fix("git", "install git")
    r.ok(f"python {sys.version.split()[0]}") if sys.version_info >= (3, 8) else r.fix(
        "python", f"{sys.version.split()[0]} is too old; install Python 3.8 or newer")
    if not shutil.which("claude"):
        r.fix("Claude Code", "install it (`npm install -g @anthropic-ai/claude-code`), then run `claude` once to log in")
    else:
        r.ok("Claude Code " + (run("claude", "--version")[1].split() or ["(version unknown)"])[0])
    if not shutil.which("gh"):
        r.fix("GitHub CLI", "install gh (https://cli.github.com), then `gh auth login`")
    else:
        gh_access(r)


def gh_failure(text):
    """Why a `gh api` call failed, in a few words, from what gh printed."""
    t = (text or "").lower()
    if re.search(r"bad credentials|http 401|requires authentication|token.*(expired|invalid|revoked)", t):
        return "the token was refused (bad or expired); make a new one and run `gh auth login`, or reset GH_TOKEN"
    if re.search(r"could not resolve|no such host|dial tcp|timed out|timeout|connection|network|unreachable|proxy|tls|certificate", t):
        return "can't reach github.com (no network or a proxy in the way); check the connection, then run `factory doctor` again"
    if re.search(r"gh auth login|gh_token|not logged|no token|authentication", t) or not t:
        return "no token; run `gh auth login`, or set GH_TOKEN"
    return "`gh api user` failed (" + t.splitlines()[0][:100] + "); run `gh auth login` or check GH_TOKEN"


def gh_access(r):
    """GitHub access is judged by a real call (#157): `gh auth status` checks more than the factory needs."""
    rc, out, err = run("gh", "api", "user")
    if rc != 0:  # a token for an app can't read /user but can read the repo
        rc2, _, _ = run("gh", "api", "repos/{owner}/{repo}")
        if rc2 == 0:
            rc = 0
    if rc != 0:
        r.fix("GitHub CLI", "gh can't call the GitHub API: " + gh_failure(err or out))
        return
    r.ok("gh is signed in")
    if run("gh", "auth", "status")[0] != 0:
        r.note("gh auth status", "it reports a problem, but `gh api` works, so the factory is fine (common with GH_TOKEN)")


def main_branch(r, cfg):
    """One main branch (#196): the PR gate reads GitHub's default branch, the loop reads the file's `mainBranch`.
    They must agree, or the loop checks out a branch that has no factory files. Skipped when gh can't say."""
    rc, out, _ = run("gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name")
    default = out.splitlines()[0].strip() if rc == 0 and out else ""
    if not re.fullmatch(r"[\w./-]+", default):
        return
    mine = cfg.get("mainBranch") or "main"
    if mine == default:
        r.ok(f"mainBranch {mine} is GitHub's default branch")
    else:
        r.fix("main-branch-differs", f"mainBranch in .claude/factory.json is {mine}, but GitHub's default branch is "
              f"{default}, and the PR gate reads {default}. Fix: run `factory settings set mainBranch {default}`, "
              f"or change the default branch in the repository's settings on GitHub to {mine}")


def origin_main(r, cfg):
    """origin/<mainBranch> exists (#181): a clone of an empty repo has no fetch setting, so it never does."""
    from factory_claims import missing_origin_main
    main = cfg.get("mainBranch") or "main"
    err = missing_origin_main(main)
    if err:
        r.fix(err["code"], f"{err['message']} {err['fix']}")
    elif run("git", "remote", "get-url", "origin")[0] == 0:
        r.ok(f"origin/{main} exists")


def node(r):
    if not os.path.exists("package.json"):
        return
    if not shutil.which("node"):
        r.fix("Node", "install Node" + (f" {open('.nvmrc').read().strip()} (see .nvmrc)" if os.path.exists(".nvmrc") else ""))
        return
    have = run("node", "--version")[1]
    if os.path.exists(".nvmrc"):
        want = open(".nvmrc").read().strip()
        w, h = version(want), version(have)
        if w and h and h[0] != w[0]:
            r.fix("Node", f"{have} here, {want} in .nvmrc: run `nvm install && nvm use` (or install Node {w[0]})")
        else:
            r.ok(f"Node {have}")
    else:
        r.ok(f"Node {have}")
    try:
        manager = json.load(open("package.json")).get("packageManager", "")
    except ValueError:
        manager = ""
    tool = manager.split("@")[0] if manager else ""
    if tool and not shutil.which(tool):
        r.fix(tool, f"package.json wants {manager}: run `corepack enable`")
    elif tool:
        rc, out, err = run(tool, "--version", timeout=60)
        if rc != 0:  # corepack may fail to fetch the wanted version
            r.fix(tool, f"`{tool} --version` fails ({(err or out).splitlines()[0][:120] if err or out else 'no output'}): "
                  f"run `corepack enable` and `corepack prepare {manager} --activate`")
        else:
            r.ok(f"{tool} {out.splitlines()[0] if out else ''}".strip())


def docker(r):
    if not any(os.path.exists(f) for f in ("compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml")):
        return
    if not shutil.which("docker"):
        r.fix("Docker", "the project has a compose file: install Docker" + (" (rootless Docker is safer)" if LINUX else ""))
        return
    rc, out, err = run("docker", "info", "--format", "{{json .SecurityOptions}}")
    if rc != 0:
        r.fix("Docker", "installed but not reachable: start Docker"
              + (" (rootless: `systemctl --user start docker`, and set DOCKER_HOST)" if LINUX else ""))
    else:
        r.ok("Docker is running" + (" (rootless)" if "rootless" in out else ""))


def project(r, cfg):
    rc, out, _ = run("git", "submodule", "status")
    if rc == 0 and out:
        bad = [l.split()[1] for l in out.splitlines() if l[:1] in "-+U" and len(l.split()) > 1]
        if bad:
            r.fix("submodules", f"{', '.join(bad)} not at the commit main pins: run `git submodule update --init`")
        else:
            r.ok("submodules")
    if os.path.exists(".claude/settings.json"):
        r.ok(".claude/settings.json")
    else:
        r.fix(".claude/settings.json", "it doesn't resolve, so the hooks and deny rules won't load: run "
              "`factory update` (a project on releases), or `git submodule update --init` / "
              "`bash vendor/my-skills/software-factory/install.sh . --link` (a project on the submodule)")
    if os.path.exists(".env.example") and not os.path.exists(".env.local"):
        r.note(".env.local", "missing; copy .env.example to .env.local and fill it in")
    if os.path.exists(".sops.yaml"):
        key = os.environ.get("SOPS_AGE_KEY_FILE", "")
        if not shutil.which("sops"):
            r.fix("sops", "the project keeps secrets with sops: install sops and age")
        elif not key or not os.path.isfile(os.path.expanduser(key)):
            r.fix("SOPS_AGE_KEY_FILE", "set it to your age private key file, in your shell profile")
        else:
            r.ok("sops and its age key")
    install = cfg["commands"].get("install") or ""
    if "pnpm" in install and not os.path.isdir("node_modules"):
        r.note("node_modules", f"not installed yet: run `{install}`")


# What an unattended coding-agent run does on every task; each needs an allow rule or it stops and waits for an answer.
LOOP_COMMANDS = ("git fetch origin", "git add .", "git commit -m x", "git push origin task/x", "gh pr create")
STALL_FREE_MODES = ("acceptEdits", "bypassPermissions", "dontAsk")


def read_json(path):
    try:
        with open(os.path.expanduser(path)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def allows(rules, command):
    for rule in rules:
        m = re.fullmatch(r"Bash\((.*)\)", rule) if isinstance(rule, str) else None
        if m and fnmatch.fnmatchcase(command, m.group(1)):
            return True
    return False


def permissions(r, cfg):
    """How an unattended run gets its permissions (#179): the mode its `claude -p` starts with, and whether the allow
    list covers the commands every task runs. A headless run cannot answer a prompt, so anything missing stalls it."""
    mode = cfg.get("permissionMode", "acceptEdits")
    if mode == "acceptEdits":
        r.ok("permissions for unattended runs: --permission-mode acceptEdits (permissionMode)")
    else:
        mine = (read_json("~/.claude/settings.json").get("permissions") or {}).get("defaultMode")
        if mine in STALL_FREE_MODES:
            r.ok(f"permissions for unattended runs: no flag is passed; your Claude Code settings set {mine}")
        else:
            r.fix("permissionMode in .claude/factory.json", "it is `default` and your own Claude Code settings set no permission mode, so "
                  "an unattended run stops at the first edit it needs approved: run `factory settings set permissionMode acceptEdits`")
    text = open(".claude/settings.json").read() if os.path.exists(".claude/settings.json") else ""
    if ".claude/hooks/pr-gate.py" not in text:
        return  # not the factory's settings.json (or none): there is no allow list to judge
    have = list((read_json(".claude/settings.json").get("permissions") or {}).get("allow") or [])
    have += list((cfg.get("permissions") or {}).get("allow") or [])
    missing = [c for c in LOOP_COMMANDS if not allows(have, c)]
    if missing:
        r.fix("allow list for unattended runs", f"no rule allows {', '.join('`' + c + '`' for c in missing)}, so a headless run stops there "
              "waiting for an answer: add rules such as `Bash(git commit*)` to `permissions.allow` in .claude/factory.json "
              "(or to .claude/settings.json in a project that takes the kit by link)")


def trust(r, cfg):
    """Claude Code ignores the whole allow list in a folder it has not been told to trust (#180). Reads the flag in
    ~/.claude.json for the project folder and each agent worktree that exists; never writes it or prints the file."""
    import factory_trust
    top = os.path.realpath(os.path.dirname(os.path.abspath(run("git", "rev-parse", "--git-common-dir")[1])))
    paths = [top] + [os.path.join(top + "-agents", n) for n in sorted(cfg.get("agents") or []) if isinstance(n, str)]
    for path in [p for p in paths if os.path.isdir(p)]:
        found = factory_trust.state(path)
        if found == "trusted":
            r.ok(f"Claude Code trusts {path}")
        elif found == "untrusted":
            r.fix(f"Claude Code does not trust {path}", f"it would ignore the allow list in .claude/settings.json and an unattended "
                  f"run would stop at its first command: run `cd {path} && claude` yourself and answer yes to the trust question "
                  "(the factory never sets the flag)")
        else:
            r.note("Claude Code trust", "~/.claude.json has no folder list to check yet: run `claude` in the project once and answer "
                   "the trust question; do the same in each agent worktree")
            return


def ci(r, cfg):
    """CI, the runners and the agents' leftovers (#205): factory_doctor_ci.py. Read-only; needs GitHub to answer."""
    import factory_doctor_ci
    factory_doctor_ci.checks(r, cfg)


def factory(r, cfg):
    if shutil.which("factory"):
        r.ok("`factory` is on your PATH")
    else:
        r.note("`factory` command", "run `./factory install-shim` once, and add ~/.local/bin to PATH")
    names = cfg.get("agents") or []
    from factory_machine import machine_names
    only = machine_names()
    unknown = [n for n in only if n not in names]
    if unknown:
        r.fix("FACTORY_AGENTS / machine names file", f"{', '.join(unknown)} aren't in `agents` in .claude/factory.json ({', '.join(names)})")
    elif only:
        r.ok(f"this machine runs {', '.join(only)} (FACTORY_AGENTS or the machine names file)")
    else:
        r.note("FACTORY_AGENTS", "not set; fine on one machine. With several, give each its own names, for example "
               f"`export FACTORY_AGENTS={','.join(names[:2])}`")
    try:
        from factory_autostart import doctor as autostart_doctor
        for level, what, how in autostart_doctor(cfg):
            (r.ok(what + (f": {how}" if how else "")) if level == "ok" else r.fix(what, how) if level == "fix"
             else r.note(what, how))
    except (ImportError, SystemExit):
        pass
    try:
        from factory_heartbeat_service import doctor as heartbeat_doctor
        for level, what, how in heartbeat_doctor(cfg):
            (r.ok(what + (f": {how}" if how else "")) if level == "ok" else r.fix(what, how) if level == "fix"
             else r.note(what, how))
    except (ImportError, SystemExit):
        pass
    if sys.platform == "darwin":
        r.note("sleep", "keep the Mac awake while agents run (`caffeinate -d` in another tab)")


def turbo(r, cfg):
    """The shared Turborepo cache (#59): only when turbo.api is set. Never runs turbo.secretsCommand (that decrypts)."""
    from factory_turbo import explain, probe, settings, turbo_json_signs
    try:
        s = settings(cfg)
    except ValueError as e:
        r.note("shared build cache", str(e))
        return
    if not s["api"]:
        return
    if os.environ.get("TURBO_TOKEN"):
        r.ok("shared build cache token: TURBO_TOKEN is set")
    elif s["secretsCommand"]:
        r.ok("shared build cache token: from turbo.secretsCommand (not run here; `factory turbo status` runs it)")
    else:
        r.note("shared build cache token", "TURBO_TOKEN isn't set and turbo.secretsCommand is empty, so builds use the "
               "local cache only. `factory turbo status` says how to supply one")
    state, detail = probe(s["api"], s["team"], None)  # no token: any answer, even a refusal, proves it is there
    if state in ("ok", "rejected"):
        r.ok(f"shared build cache answers at {s['api']}")
    else:
        r.note("shared build cache", explain(s["api"], state, detail))
    if os.environ.get("TURBO_REMOTE_CACHE_SIGNATURE_KEY") and turbo_json_signs() is False:
        r.note("shared build cache signatures", "TURBO_REMOTE_CACHE_SIGNATURE_KEY is set, but turbo.json has no "
               "\"remoteCache\": {\"signature\": true}, so nothing is signed or checked")
def release(r):
    """A project that takes the factory from releases (#113): the installed files are the pinned release's, and this
    machine is ready (hooks exist, scripts parse, runner files readable). The same checks `factory update` ends with."""
    import factory_release as fr
    try:
        pin = fr.read_pin(os.getcwd())
    except fr.FactoryError as e:
        r.fix(fr.PIN_PATH, f"{e.message} {e.fix}")
        return
    if pin is None:
        return
    problems = fr.verify_machine(os.getcwd(), pin)
    if problems:
        for p in problems:
            r.fix(f"factory {pin['tag']}", f"{p}: run `factory update` (it repairs the files and the services, and checks again)")
    else:
        r.ok(f"factory {pin['tag']}: the files match the pin and this machine is ready")


def models(r, cfg):
    from factory_models import table, validate
    try:
        validate(cfg.get("models", {}))
    except ValueError as e:
        r.fix("models in .claude/factory.json", f"{e} Fix it with `factory settings set models '<json>'`")
        return
    for role, model, source in table(cfg.get("models", {})):
        r.ok(f"model for {role}: {model} ({source})")


def roles(r, cfg):
    """The role folders (#102): every path in a role's reads.md exists; the names don't clash with coding agents'."""
    try:
        import factory_roles as fr
        from factory_config import roles_dir, role_names
    except ImportError:
        return
    if not any(fr.role_dir(cfg, role) for role in fr.ROLE_DEFS):
        r.note("role folders", f"{roles_dir(cfg)}/ doesn't exist, so the roles read their `notes` instead: run "
               "`factory init-roles` to create it, then commit it")
    else:
        for role in fr.ROLE_DEFS:
            folder = fr.role_dir(cfg, role)
            if not folder:
                r.note(f"role folder for {role}", f"{roles_dir(cfg)}/{role}/ is missing: run `factory init-roles`")
                continue
            reads = os.path.join(folder, "reads.md")
            if not os.path.isfile(reads):
                r.fix(f"{reads}", "missing: run `factory init-roles`, or write one (a document per line, with a reason)")
                continue
            missing = fr.missing_reads(cfg, role) or []
            for path in missing:
                r.fix(f"{reads}: {path}", "does not exist: fix the path, or remove the line")
            if not missing:
                r.ok(f"{role} reads.md: every path exists")
    clash = sorted(set(role_names(cfg, "dev-manager") + role_names(cfg, "product-owner")) & set(cfg.get("agents") or []))
    if clash:
        r.fix("role names", f"{', '.join(clash)} is also a coding agent's name: change `roles.<role>.names`")


def artifacts(r, cfg):
    """The artifact copies in the repo (#104): each one exists, is not edited by hand, and is not older than its artifact
    when the project can say (`artifacts.info`)."""
    try:
        import factory_artifacts as fa
        entries = fa.read_manifest(cfg)["artifacts"]
    except (ImportError, SystemExit):
        return
    for e in entries:
        state, detail = fa.judge(cfg, e)
        what = f"artifact {e['id']} ({e['dest']})"
        if state in ("current", "unknown"):
            r.ok(f"{what}: {detail}")
        elif state == "edited":
            r.note(what, detail + "; put the change in the artifact, or pull again with --force")
        else:
            r.fix(what, detail + f"; run `factory artifacts pull {e['url']} {e['dest']}`")


def manager(r, cfg):
    """The dev-manager orchestrator (#97): its settings profile resolves and every hook script the profile runs exists."""
    import re as _re
    path = str(((cfg.get("roles") or {}).get("dev-manager") or {}).get("profile") or ".claude/manager/settings.json")
    if not os.path.isfile(path):
        r.note("manager profile", f"{path} doesn't exist, so sub-managers use the project's settings (which deny `gh api`): "
               "run `factory update`, or set `roles.dev-manager.profile`")
        return
    try:
        profile = json.load(open(path))
    except (OSError, ValueError) as e:
        r.fix(path, f"isn't valid JSON ({e})")
        return
    missing = []
    for group in (profile.get("hooks") or {}).values():
        for entry in group:
            for h in entry.get("hooks", []):
                for token in _re.findall(r"[\w./$\"-]+\.py", h.get("command", "")):
                    script = token.replace('"', "").replace("$CLAUDE_PROJECT_DIR/", "")
                    if "$" not in script and not os.path.exists(script):
                        missing.append(script)
    for script in sorted(set(missing)):
        r.fix(f"{path}: {script}", "the hook script is missing: run `factory update`")
    if not missing:
        r.ok("manager profile: it resolves and its hooks exist")


def main():
    if run("git", "rev-parse", "--show-toplevel")[0] != 0:
        print("factory doctor: run it inside the project's git repo.", file=sys.stderr)
        return 1
    os.chdir(run("git", "rev-parse", "--show-toplevel")[1])
    r = Report()
    tools(r)
    try:
        cfg = load()
    except (OSError, ValueError) as e:
        r.fix(".claude/factory.json", f"can't read it ({e})")
        cfg = None
    node(r)
    docker(r)
    if cfg:
        project(r, cfg)
        origin_main(r, cfg)
        main_branch(r, cfg)
        factory(r, cfg)
        models(r, cfg)
        permissions(r, cfg)
        trust(r, cfg)
        ci(r, cfg)
        roles(r, cfg)
        manager(r, cfg)
        turbo(r, cfg)
        artifacts(r, cfg)
        release(r)
    if "--sandbox" in sys.argv[1:]:
        from factory_sandbox import run as sandbox
        print()
        print("Sandbox (#105)")
        sandbox(r, cfg)
    print()
    print(f"{r.fixes} to fix." if r.fixes else "All the checks pass.")
    return 1 if r.fixes else 0


if __name__ == "__main__":
    sys.exit(main())
