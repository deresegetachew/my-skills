#!/usr/bin/env python3
"""Lets several factory loops run on one project without stepping on each other.

Two things are claimed, both in a lock-protected JSON file inside the repo's shared git directory
(`<git-common-dir>/factory/claims.json`, so every worktree of a clone sees the same file and nothing is committed):

  - checkouts: each loop works in its own checkout. The first loop takes the project folder; later loops get a
    git worktree next to it (`<project>-agents/<name>`, named from `agents` in factory.json), created on first use and reused afterwards.
  - tasks: a loop claims a task before building it, and other loops skip it.

A claim belongs to a live process: when the pid that made it has exited (or the claim is older than
`claimStaleHours`), it no longer counts. Loops on other machines or clones can't see this file, so a task whose
`task/<id>-...` branch got a commit on the remote within `claimStaleHours` counts as taken too.

  python3 .claude/hooks/factory_claims.py checkout --pid $$     -> prints "<agent> <directory>" to work in
  python3 .claude/hooks/factory_claims.py release --agent taytu [--tasks-only]
  python3 .claude/hooks/factory_claims.py list
  python3 .claude/hooks/factory_claims.py done --agent taytu --task 3.2       (factory loop -i: close the session)
  python3 .claude/hooks/factory_claims.py clean                                remove unused agent worktrees
  cd "$(python3 .claude/hooks/factory_claims.py worktree taytu)" && claude
                                                                -> a plain Claude session in taytu's worktree; the
                                                                   SessionStart hook (factory_session.py) sets it up
next_task.py --claim <agent> --pid <pid> uses `claim_task` below.
"""
import argparse, contextlib, fcntl, json, os, socket, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import agent_name, agent_slot, load  # noqa: E402

HOST = socket.gethostname()


def git(*a):
    p = subprocess.run(["git", *a], capture_output=True, text=True)
    return p.stdout.strip() if p.returncode == 0 else ""


def state_dir():
    common = os.path.abspath(git("rev-parse", "--git-common-dir") or ".git")
    d = os.path.join(common, "factory")
    os.makedirs(d, exist_ok=True)
    return d


@contextlib.contextmanager
def locked():
    """The claims, read and written under an exclusive lock so two loops can't claim at the same moment."""
    d = state_dir()
    with open(os.path.join(d, "claims.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = os.path.join(d, "claims.json")
        try:
            with open(path) as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}
        data.setdefault("checkouts", {})
        data.setdefault("tasks", {})
        yield data
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)


def alive(claim, stale_hours):
    if not claim or time.time() - claim.get("at", 0) > stale_hours * 3600:
        return False
    if claim.get("host") != HOST:
        return True  # can't check a pid on another machine; the age limit applies
    try:
        os.kill(int(claim["pid"]), 0)
        return True
    except (OSError, ValueError, KeyError):
        return False


def stamp(agent, pid, **extra):
    return {"agent": agent, "pid": int(pid), "host": HOST, "at": time.time(), **extra}


def checkout(pid, stale_hours):
    """The project folder if no live loop holds it, else this loop's own worktree. Prints and returns it."""
    main_top = os.path.dirname(os.path.abspath(git("rev-parse", "--git-common-dir")))
    with locked() as data:
        cos = data["checkouts"]
        cfg = load()
        names = [agent_name(cfg, n) for n in range(1, max(len(cfg.get("agents") or []), 1) + 1)]
        candidates = [(names[0], main_top)] + [
            (name, os.path.join(main_top + "-agents", name)) for name in names[1:]
        ]
        for agent, path in candidates:
            if not alive(cos.get(agent), stale_hours):
                cos[agent] = stamp(agent, pid, path=path)
                break
        else:
            raise SystemExit(f"every agent ({', '.join(names)}) already has a live loop on this clone; "
                             "add names to `agents` in .claude/factory.json for more")
    ensure_worktree(path, main_top)
    print(f"{agent} {path}")
    return agent, path


def ensure_worktree(path, main_top):
    """Create the worktree at `path` from origin/<main> if it doesn't exist, with the local env files copied."""
    if path == main_top or os.path.isdir(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cfg = load()
    subprocess.run(["git", "fetch", "-q", "origin", cfg["mainBranch"]], check=False)
    subprocess.run(["git", "worktree", "add", "--detach", path, f"origin/{cfg['mainBranch']}"], check=True,
                   stdout=subprocess.DEVNULL)
    # A new worktree has no untracked local files: bring the local env files over.
    import glob, shutil
    for f in [".env.local"] + glob.glob(os.path.join(main_top, ".env.*.local")):
        src = os.path.join(main_top, os.path.basename(f))
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(path, os.path.basename(f)))


def worktree(who):
    """The folder of agent `who` (a name, or a slot number; 1 is the project folder), created if needed. Prints it."""
    cfg = load()
    n = int(who) if str(who).isdigit() else agent_slot(cfg, str(who))
    if n is None:
        raise SystemExit(f"no agent called {who}: the agents are {', '.join(cfg.get('agents') or [])}")
    main_top = os.path.dirname(os.path.abspath(git("rev-parse", "--git-common-dir")))
    path = main_top if n == 1 else os.path.join(main_top + "-agents", agent_name(cfg, n))
    ensure_worktree(path, main_top)
    print(path)


def register(agent, pid, path, stale_hours):
    """Record that an interactive session (pid) works in this checkout. Returns the other live holder, if any."""
    with locked() as data:
        held = data["checkouts"].get(agent)
        if held and alive(held, stale_hours) and int(held.get("pid", 0)) != int(pid):
            return held
        data["checkouts"][agent] = stamp(agent, pid, path=path)
    return None


def release(agent, tasks_only=False):
    with locked() as data:
        if not tasks_only:
            data["checkouts"].pop(agent, None)
        for tid in [t for t, c in data["tasks"].items() if c.get("agent") == agent]:
            del data["tasks"][tid]


def remote_busy(cfg, stale_hours):
    """Task ids with a task/<id>-... branch on the remote that got a commit within the stale window."""
    subprocess.run(["git", "fetch", "-q", "origin", "+refs/heads/task/*:refs/remotes/origin/task/*"],
                   capture_output=True)
    from factory_config import branch_task
    busy = {}
    out = git("for-each-ref", "--format=%(refname:strip=3) %(committerdate:unix)", "refs/remotes/origin/task")
    for line in out.splitlines():
        name, _, ts = line.rpartition(" ")
        tid = branch_task(name)  # name is "task/<id>-..."
        if tid and ts.isdigit() and time.time() - int(ts) < stale_hours * 3600:
            busy[tid] = name
    return busy


def claim_task(open_ids, agent, pid, cfg):
    """The first of `open_ids` this agent may build, claimed for it; None when every one is taken."""
    stale = float(cfg.get("claimStaleHours", 6))
    remote = remote_busy(cfg, stale)
    with locked() as data:
        tasks = data["tasks"]
        mine = [t for t, c in tasks.items() if c.get("agent") == agent and alive(c, stale) and t in open_ids]
        if mine:  # keep working on what this agent already holds
            return mine[0]
        for tid in open_ids:
            held = tasks.get(tid)
            if held and held.get("agent") != agent and alive(held, stale):
                continue
            if tid in remote and not (held and held.get("agent") == agent):
                continue
            for t in [t for t, c in tasks.items() if c.get("agent") == agent]:
                del tasks[t]  # one task per agent at a time
            tasks[tid] = stamp(agent, pid)
            return tid
    return None


def done_file(agent):
    from factory_config import safe_agent
    return os.path.join(state_dir(), f"done-{safe_agent(agent)}")


def mark_done(agent, task):
    """An interactive session finished its task: the Stop hook closes it and the loop moves on."""
    with open(done_file(agent), "w") as f:
        f.write(task)


def take_done(agent):
    """The task an agent marked done, removing the mark; '' when there is none."""
    p = done_file(agent)
    if not os.path.exists(p):
        return ""
    task = open(p).read().strip()
    os.remove(p)
    return task


def tidy_branches(cfg):
    """Delete local task/<id>-... branches whose task is ticked on main (their PR has merged)."""
    from factory_config import branch_task, task_source, tasks
    if task_source(cfg) == "issues":  # done = its issue is closed
        p = subprocess.run(["gh", "api", "--paginate", "repos/{owner}/{repo}/issues?state=closed&per_page=100"],
                           capture_output=True, text=True)
        try:
            done = {str(i["number"]) for i in json.loads(p.stdout.replace("][", ","))} if p.returncode == 0 else set()
        except ValueError:
            done = set()
    else:
        plan = git("show", f"origin/{cfg['mainBranch']}:{cfg['plan']}")
        done = {i for i, d, _ in tasks(plan) if d}
    gone = []
    for name in git("for-each-ref", "--format=%(refname:short)", "refs/heads/task").split():
        if branch_task(name) in done and subprocess.run(["git", "branch", "-D", "-q", name],
                                                         capture_output=True).returncode == 0:
            gone.append(name)
    return gone


def clean(cfg, stale_hours):
    """Remove agent worktrees no live agent uses and that have no uncommitted work; prune merged task branches."""
    main_top = os.path.dirname(os.path.abspath(git("rev-parse", "--git-common-dir")))
    root = main_top + "-agents"
    with locked() as data:
        busy = {c.get("path") for c in data["checkouts"].values() if alive(c, stale_hours)}
    removed, kept = [], []
    for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        path = os.path.join(root, name)
        if path in busy:
            kept.append(f"{name} (in use)")
            continue
        dirty = subprocess.run(["git", "-C", path, "status", "--porcelain", "--ignore-submodules"],
                               capture_output=True, text=True).stdout.strip()
        if dirty:
            kept.append(f"{name} (uncommitted changes)")
            continue
        if subprocess.run(["git", "worktree", "remove", "--force", path], capture_output=True).returncode == 0:
            removed.append(name)
    subprocess.run(["git", "worktree", "prune"], capture_output=True)
    branches = tidy_branches(cfg)
    print("removed worktrees: " + (", ".join(removed) or "none"))
    if kept:
        print("kept: " + ", ".join(kept))
    print("deleted merged task branches: " + (", ".join(branches) or "none"))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("checkout")
    c.add_argument("--pid", required=True)
    r = sub.add_parser("release")
    r.add_argument("--agent", required=True)
    r.add_argument("--tasks-only", action="store_true", help="keep the checkout, drop the task claim")
    w = sub.add_parser("worktree", help="print (and create) the folder for slot N")
    w.add_argument("n", help="an agent name (taytu) or slot number (2)")
    sub.add_parser("list")
    d = sub.add_parser("done", help="mark the agent's task done (an interactive session then closes)")
    d.add_argument("--agent", required=True)
    d.add_argument("--task", required=True)
    t = sub.add_parser("take-done")
    t.add_argument("--agent", required=True)
    sub.add_parser("tidy-branches")
    sub.add_parser("clean")
    a = ap.parse_args()
    cfg = load()
    stale = float(cfg.get("claimStaleHours", 6))
    if a.cmd == "worktree":
        worktree(a.n)
    elif a.cmd == "done":
        mark_done(a.agent, a.task)
    elif a.cmd == "take-done":
        print(take_done(a.agent))
    elif a.cmd == "tidy-branches":
        print("\n".join(tidy_branches(cfg)))
    elif a.cmd == "clean":
        clean(cfg, stale)
    elif a.cmd == "checkout":
        checkout(a.pid, stale)
    elif a.cmd == "release":
        release(a.agent, a.tasks_only)
    else:
        with locked() as data:
            for kind in ("checkouts", "tasks"):
                for k, v in data[kind].items():
                    state = "live" if alive(v, stale) else "stale"
                    print(f"{kind[:-1]:8} {k:10} {v.get('agent', ''):9} pid {v.get('pid')} {state} {v.get('path', '')}")


if __name__ == "__main__":
    main()
