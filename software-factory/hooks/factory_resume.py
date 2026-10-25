#!/usr/bin/env python3
"""`factory resume`: what a machine does after a reboot (#88). `factory autostart install` runs it at every boot.

  factory resume              wait for Docker and the network, run `commands.stackUp`, then start this machine's
                              agents (autostartAgents) in detached tmux sessions, each in its own worktree
  factory resume --dry-run    say what it would do, change nothing
  factory resume --force      run although autostart is off on this machine

Unfinished work is never touched. Before an agent starts, a worktree with uncommitted changes or unpushed commits is
saved to <state>/backups/<agent>-<branch>-<time>/ (changes.patch, status.txt, unpushed.txt, untracked/), nothing is
reset or cleaned, and the agent's first prompt says it is resuming after an unexpected restart (branch, files,
backup path). An agent starts only when its worktree's settings resolve, so its hooks and deny rules are on (#46).
Agents already running are left alone, so running it by hand is safe.

The boot report is one line per component in <state>/boot.log (`$XDG_STATE_HOME/<repo>-factory`, else
`~/.local/state/<repo>-factory`) and, in issues mode, a comment on the first started agent's issue unless the
machine file says "autostartReport": false. A GitHub failure is only a line in the log.

Settings: `commands.stackUp` and `commands.stackHealth` in .claude/factory.json; the machine's own "autostart",
"autostartAgents" and "autostartReport" (factory_machine.py); variables in <config>/<repo>.env reach the agents.
FACTORY_RESUME_WAIT (seconds, default 300) is how long it waits for Docker, the network and the stack's health;
FACTORY_RESUME_POLL (seconds, default 5) how often it asks.
Exit 1 when anything could not be started.
"""
import json, os, re, shlex, shutil, subprocess, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
HOOKS = os.path.dirname(os.path.abspath(__file__))
SETTINGS_FIX = ("run `git submodule update --init` there, or `bash vendor/my-skills/software-factory/install.sh . "
                "--link`, then `factory resume`")


def number(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


def main_top():
    p = subprocess.run(["git", "rev-parse", "--git-common-dir"], capture_output=True, text=True)
    if p.returncode != 0:
        print("factory resume: run it inside the project's git repo.", file=sys.stderr)
        sys.exit(1)
    return os.path.dirname(os.path.abspath(p.stdout.strip()))


def session_name(agent):
    from factory_machine import repo_key
    return re.sub(r"[^A-Za-z0-9_-]+", "-", f"{repo_key()}-{agent}")


def agent_path(cfg, top, agent):
    """Where agent `agent` works: the project folder for the first name, else <project>-agents/<name>."""
    from factory_config import agent_name, agent_slot
    slot = agent_slot(cfg, agent)
    return top if slot == 1 else os.path.join(top + "-agents", agent_name(cfg, slot or 0))


def git(path, *a):
    p = subprocess.run(["git", "-C", path, *a], capture_output=True, text=True)
    return p.stdout if p.returncode == 0 else ""


def inspect(path):
    """What a worktree holds: {"branch": "" when detached, "changes": status lines, "unpushed": commit lines}."""
    if not os.path.isdir(path):
        return {"branch": "", "changes": [], "unpushed": []}
    return {"branch": git(path, "branch", "--show-current").strip(),
            "changes": [l for l in git(path, "status", "--porcelain").splitlines() if l.strip()],
            "unpushed": [l for l in git(path, "log", "--branches", "--not", "--remotes",
                                        "--format=%h %s").splitlines() if l.strip()]}


def backup(agent, path, info, stamp):
    """Saves a worktree's unfinished work outside it and returns the folder. Reads the worktree, never writes to it."""
    from factory_machine import state_dir
    branch = re.sub(r"[^A-Za-z0-9._-]+", "-", info["branch"] or "detached").strip("-") or "detached"
    base = os.path.join(state_dir(), "backups", f"{agent}-{branch}-{stamp}")
    dest, n = base, 1
    while os.path.exists(dest):
        n += 1
        dest = f"{base}-{n}"
    os.makedirs(dest)
    with open(os.path.join(dest, "changes.patch"), "w") as f:
        f.write(git(path, "diff", "HEAD", "--binary"))
    with open(os.path.join(dest, "status.txt"), "w") as f:
        f.write(git(path, "status", "--short", "--branch") + "\n" + git(path, "status"))
    with open(os.path.join(dest, "unpushed.txt"), "w") as f:
        f.write("\n".join(info["unpushed"]) + ("\n" if info["unpushed"] else ""))
    copied = 0
    for rel in git(path, "ls-files", "--others", "--exclude-standard", "-z").split("\0"):
        src = os.path.join(path, rel)
        if not rel or os.path.islink(src) or not os.path.isfile(src) or os.path.getsize(src) > 1 << 20 or copied >= 200:
            continue  # small regular files only; the list is in status.txt either way
        os.makedirs(os.path.dirname(os.path.join(dest, "untracked", rel)), exist_ok=True)
        shutil.copy2(src, os.path.join(dest, "untracked", rel))
        copied += 1
    return dest


def note_text(agent, path, info, backup_dir, when):
    files = [l[3:] if len(l) > 3 else l for l in info["changes"]]
    shown = "\n".join(f"  - {f}" for f in files[:20]) + (f"\n  - ... and {len(files) - 20} more" if len(files) > 20 else "")
    where = f"on branch `{info['branch']}`" if info["branch"] else "on a detached HEAD"
    lines = [f"You are resuming after an unexpected restart of this machine ({when}). You are {agent}; your worktree is "
             f"{path}, {where}."]
    if files:
        lines.append(f"{len(files)} file{'s' if len(files) != 1 else ''} had uncommitted changes, and they are still there:\n{shown}")
    if info["unpushed"]:
        lines.append(f"{len(info['unpushed'])} commit{'s' if len(info['unpushed']) != 1 else ''} had not been pushed:\n"
                     + "\n".join(f"  - {l}" for l in info["unpushed"][:10]))
    if backup_dir:
        lines.append(f"A backup of that work is in {backup_dir} (changes.patch, status.txt, unpushed.txt, untracked/). "
                     "Nothing was reset or cleaned.")
    lines.append("Continue your own in-progress issue or pull request on this branch first, and do not claim new work "
                 "until it is done. Run `git status` and read the changes before you edit anything. If the work does "
                 "not match any issue of yours, say so in your first message instead of discarding it.")
    return "\n\n".join(lines) + "\n"


def read_env_file(path):
    """KEY=value lines (# comments, optional quotes) -> dict."""
    out = {}
    try:
        for line in open(path):
            m = re.fullmatch(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*", line)
            if m and not line.lstrip().startswith("#"):
                v = m.group(2)
                out[m.group(1)] = v[1:-1] if len(v) > 1 and v[0] == v[-1] and v[0] in "\"'" else v
    except OSError:
        pass
    return out


class Report:
    """One line per component: printed, and appended to the boot log (unless it is a dry run)."""

    def __init__(self, log_path, dry):
        self.lines, self.failed, self.log_path, self.dry = [], 0, log_path, dry

    def add(self, line, failed=False):
        self.failed += 1 if failed else 0
        self.lines.append(line)
        print(line, flush=True)
        if not self.dry:
            try:
                os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
                with open(self.log_path, "a") as f:
                    f.write(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
            except OSError:
                pass


def wait_until(check, seconds, poll):
    """True as soon as check() is true, polling until `seconds` have passed (always at least one try)."""
    end = time.time() + seconds
    while True:
        if check():
            return True
        if time.time() >= end:
            return False
        time.sleep(min(poll, max(end - time.time(), 0.01)))


def run(cmd, cwd, timeout, env=None):
    try:
        return subprocess.run(cmd, shell=isinstance(cmd, str), cwd=cwd, capture_output=True, text=True, timeout=timeout,
                              env=env)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", f"timed out after {int(timeout)} s")
    except OSError as e:
        return subprocess.CompletedProcess(cmd, 127, "", str(e))


def last_line(text, fallback=""):
    lines = [l.strip() for l in (text or "").strip().splitlines() if l.strip()]
    return lines[-1][:200] if lines else fallback


def start_stack(cfg, top, report, wait, poll, dry):
    up = (cfg.get("commands") or {}).get("stackUp") or ""
    health = (cfg.get("commands") or {}).get("stackHealth") or ""
    if not up:
        report.add("stack: no commands.stackUp is set, nothing to start")
        return
    if dry:
        report.add(f"stack: would wait for Docker, run `{up}`" + (f" and wait until `{health}` passes" if health else ""))
        return
    if shutil.which("docker"):
        t = time.time()
        if not wait_until(lambda: run(["docker", "info"], top, 30).returncode == 0, wait, poll):
            report.add(f"stack: NOT started: Docker did not answer within {int(wait)} s. Start Docker, then run "
                       "`factory resume`.", failed=True)
            return
        report.add(f"docker: ready after {int(time.time() - t)} s")
    p = run(up, top, number("FACTORY_RESUME_STACK_TIMEOUT", 1200))
    if p.returncode != 0:
        report.add(f"stack: failed (exit {p.returncode}): {last_line(p.stderr or p.stdout, 'no output')}. "
                   f"Run `{up}` by hand to see why.", failed=True)
        return
    if health and not wait_until(lambda: run(health, top, 60).returncode == 0, wait, poll):
        report.add(f"stack: started but `{health}` did not pass within {int(wait)} s", failed=True)
        return
    report.add("stack: up" + (" and healthy" if health else ""))


def register_working(cfg, top, agent, report):
    """Issues mode: if the agent still holds an in-progress issue, ping its agent issue as working on it, so the dev
    manager does not hand the issue to another agent while the agent is coming back."""
    from factory_config import task_labels, task_source
    if task_source(cfg) != "issues":
        return
    try:
        import factory_issues
        L = task_labels(cfg)
        held = [i["number"] for i in factory_issues.task_issues(label=L["agentPrefix"] + agent)
                if L["inProgress"] in {x["name"] for x in i["labels"]}]
        if not held:
            return
        p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_agents.py"), "ping", "--agent", agent,
                            "--status", f"working on #{held[0]} (resumed)"], cwd=top, capture_output=True, text=True,
                           timeout=120)
        if p.returncode != 0:
            raise RuntimeError(last_line(p.stderr, "ping failed"))
        report.add(f"agent {agent}: registered {agent} as working on #{held[0]}")
    except (Exception, SystemExit) as e:
        report.add(f"agent {agent}: GitHub: could not mark {agent} as working: {str(e)[:160]}")


def post_report(cfg, agent, report, machine):
    """Issues mode: the boot report as a comment on the agent's issue. Never fails the resume."""
    try:
        import factory_agents, factory_issues
        issue = factory_agents.find_issue(agent)
        if not issue:
            report.add(f"report: {agent} has no agent issue to post to")
            return
        body = (f"Boot report: this machine (machine {machine or 'unknown'}) rebooted and ran `factory resume` at "
                f"{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}.\n\n"
                + "\n".join(f"- {l}" for l in report.lines))
        factory_issues.comment(issue["number"], body)
        report.add(f"report: posted to #{issue['number']}")
    except (Exception, SystemExit) as e:
        report.add(f"report: GitHub: could not post the boot report: {str(e)[:160]}")


def start_agent(cfg, top, agent, report, ctx):
    from factory_config import task_source
    name = session_name(agent)
    if subprocess.run(["tmux", "has-session", "-t", f"={name}"], capture_output=True).returncode == 0:
        report.add(f"agent {agent}: already running (tmux session {name}), left alone")
        return
    path = agent_path(cfg, top, agent)
    if ctx["dry"]:
        info = inspect(path)
        extra = (f"; {len(info['changes'])} uncommitted files and {len(info['unpushed'])} unpushed commits on "
                 f"{info['branch'] or 'a detached HEAD'} would be backed up first" if info["changes"] or info["unpushed"] else "")
        report.add(f"agent {agent}: would start tmux session {name} in {path}{extra}")
        return
    if not ctx["network"]:
        report.add(f"agent {agent}: NOT started: origin is not reachable (no network, or git cannot sign in). "
                   "Fix that, then run `factory resume`.", failed=True)
        return
    made = run([sys.executable, os.path.join(HOOKS, "factory_claims.py"), "worktree", agent], top, 300)
    if made.returncode != 0:
        report.add(f"agent {agent}: NOT started: could not make its worktree: {last_line(made.stderr, 'unknown error')}",
                   failed=True)
        return
    path = last_line(made.stdout) or path
    info = inspect(path)
    protect = bool(info["changes"] or info["unpushed"])
    backup_dir = ""
    if protect:  # first of all, before anything else looks at the folder
        try:
            backup_dir = backup(agent, path, info, ctx["stamp"])
            report.add(f"backup {agent}: {len(info['changes'])} changed files and {len(info['unpushed'])} unpushed "
                       f"commits on {info['branch'] or 'a detached HEAD'} saved to {backup_dir}")
        except OSError as e:
            report.add(f"backup {agent}: FAILED ({e}); the worktree is not touched either way", failed=True)
    # The kit's files in .claude/ are links into a submodule: without it the hooks and deny rules would not load (#46).
    if os.path.exists(os.path.join(path, ".gitmodules")):
        p = run(["git", "-C", path, "submodule", "update", "--init", "-q"], top, 600)
        if p.returncode != 0:
            report.add(f"agent {agent}: NOT started: `git submodule update --init` failed in {path}: "
                       f"{last_line(p.stderr)}. {SETTINGS_FIX}.", failed=True)
            return
    if not os.path.exists(os.path.join(path, ".claude", "settings.json")):
        report.add(f"agent {agent}: NOT started: {path}/.claude/settings.json does not resolve, so the factory's hooks "
                   f"and deny rules would not load. {SETTINGS_FIX}.", failed=True)
        return
    env = {"FACTORY_AGENTS": agent}
    if protect:
        env["FACTORY_RESUME"] = "1"  # the loop leaves this folder as it is for its first task
    if protect or info["branch"]:
        os.makedirs(ctx["state"], exist_ok=True)
        note = os.path.join(ctx["state"], f"resume-{agent}.md")
        with open(note, "w") as f:
            f.write(note_text(agent, path, info, backup_dir, ctx["when"]))
        env["FACTORY_RESUME_NOTE"] = note
    env.update(ctx["carry"])
    command = "exec env " + " ".join(shlex.quote(f"{k}={v}") for k, v in env.items()) + " " + \
        shlex.quote(os.path.join(top, "factory")) + " loop -i"
    p = run(["tmux", "new-session", "-d", "-s", name, "-c", top, command], top, 60)
    if p.returncode != 0 or subprocess.run(["tmux", "has-session", "-t", f"={name}"], capture_output=True).returncode != 0:
        report.add(f"agent {agent}: NOT started: tmux could not start the session: {last_line(p.stderr, 'no session')}",
                   failed=True)
        return
    ctx["started"].append(agent)
    report.add(f"agent {agent}: started (tmux session {name}, folder {path})"
               + (f", resuming {info['branch'] or 'unfinished work'} with its changes intact" if protect else
                  (f", on {info['branch']}" if info["branch"] else "")))
    register_working(cfg, top, agent, report)


def main(argv):
    dry, force = "--dry-run" in argv, "--force" in argv
    top = main_top()
    os.chdir(top)
    from factory_config import load
    from factory_machine import autostart_settings, config_dir, machine_id, repo_key, state_dir
    cfg = load()
    on, agents, post = autostart_settings()
    report = Report(os.path.join(state_dir(), "boot.log"), dry)
    if not on and not force:
        print("factory resume: autostart is off on this machine (factory autostart install turns it on; "
              "--force runs it anyway).")
        return 0
    for k, v in read_env_file(os.path.join(config_dir(), f"{repo_key()}.env")).items():
        os.environ.setdefault(k, v)
    wait, poll = number("FACTORY_RESUME_WAIT", 300), number("FACTORY_RESUME_POLL", 5)
    report.add(f"resume: {'dry run, ' if dry else ''}autostart on {repo_key()} (machine {machine_id() or 'unknown'}), "
               f"agents: {', '.join(agents) or 'none'}")
    if not dry and agents and not shutil.which("tmux"):
        report.add("resume: tmux is not installed, so no agent can start in a detached session. Install tmux.", failed=True)
        agents = []
    start_stack(cfg, top, report, wait, poll, dry)
    network = dry or not agents or wait_until(
        lambda: run(["git", "ls-remote", "origin", "HEAD"], top, 30).returncode == 0, wait, poll)
    carry = {k: v for k, v in os.environ.items() if k in ("PATH", "DOCKER_HOST", "XDG_RUNTIME_DIR")}
    carry.update(read_env_file(os.path.join(config_dir(), f"{repo_key()}.env")))
    ctx = {"dry": dry, "network": network, "state": state_dir(), "carry": carry, "started": [],
           "stamp": datetime.now().strftime("%Y%m%d-%H%M%S"), "when": datetime.now().strftime("%Y-%m-%d %H:%M")}
    for agent in agents:
        start_agent(cfg, top, agent, report, ctx)
    if not dry:
        if ctx["started"] and post:
            post_report(cfg, ctx["started"][0], report, machine_id())
        report.add(f"resume: done, {len(ctx['started'])} of {len(agents)} agents started"
                   + (f", {report.failed} problem{'s' if report.failed != 1 else ''}" if report.failed else ""))
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
