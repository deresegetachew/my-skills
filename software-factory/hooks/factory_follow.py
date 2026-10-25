#!/usr/bin/env python3
"""`factory follow`, `factory say`, `factory remote` and `factory agent <name> --detach` (#106): watch and talk to an
agent by its name, wherever it runs.

  factory remote add <name> <user@host>     how to reach a machine (the sandbox user, never an admin account)
  factory remote cloud <agent> <url>        a cloud agent: the Remote Control link of its session
  factory remote list | remove <name>
  factory follow [--json]                   every agent and one-item sub-manager we can find: name, where, state, task,
                                            last ping, Remote Control link
  factory follow <agent> [--read] [--on R]  attach to its session: type, answer prompts, Esc to interrupt. --read cannot type.
                                            A cloud agent prints its Remote Control link instead
  factory follow <agent> --log [--polls N]  stream the session's output without a terminal (Ctrl-C stops)
  factory follow --all [--on R]             one read-only pane per session (tiled), in a local tmux
  factory say <agent> "message" [--on R]    send one message, as if typed; the use is logged on that machine (no text)
  factory agent <name> --detach             start that agent in a detached tmux session (what the commands above find)

Remotes live in this machine's own file, never in the project and never on GitHub. Errors are `{code, message, fix}`.
Detach with Ctrl-b d. Closing the terminal or losing the connection only detaches; the agent keeps working. Ctrl+C is not
"detach": it interrupts Claude, and quitting Claude ends the session and drops its claims.
"""
import argparse, json, os, re, shlex, shutil, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_remotes as R  # noqa: E402
from factory_remotes import RemoteError  # noqa: E402

DETACH_NOTE = ("Detach with Ctrl-b d: the agent keeps working. Ctrl+C is not detach, it interrupts Claude, and quitting Claude "
               "ends the session and drops its claims. Everyone attached sees one screen, sized to the smallest terminal; "
               "use --read for extra viewers.")


def in_agent_session():
    return any(os.environ.get(k) for k in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"))


def agents_may_not(what):
    """Agents may read the list, but not type into other sessions or change where machines are."""
    if in_agent_session():
        raise RemoteError("agent-session", f"An agent session can't {what}.",
                          "A person runs this from their own terminal (the agent variables are set here).")


def refuse(err):
    print(err.as_json(), file=sys.stderr)
    return 1


def project():
    from factory_config import load
    from factory_machine import repo_key
    return load(), repo_key()


def github_states(cfg):
    """{agent name: (state, minutes since the last ping, task text)} from the agent issues; {} when issues mode is off or
    GitHub can't be asked (then the list shows what the remotes see, without a state from GitHub)."""
    if (cfg.get("tasks") or {}).get("source") != "issues":
        return {}
    try:
        import factory_agents as A
        out = {}
        for issue in A.current(A.agent_issues()):
            st = A.state_of(cfg, issue)
            if st:
                title = issue.get("title") or ""
                out[st[0]] = (st[1], int(st[3]), title.split("·", 1)[1].strip() if "·" in title else "")
        return out
    except (Exception, SystemExit):
        return {}


def ago(minutes):
    return "just now" if minutes < 1 else f"{minutes} min ago" if minutes < 120 else f"{minutes // 60} h ago"


def rows(cfg, repo, on=None):
    """The listing as dicts, and the unreachable remotes."""
    found = R.discover(cfg, repo, only=on)
    states = github_states(cfg)
    out, down, seen = [], [], set()
    for r in found:
        if not r["reachable"]:
            down.append(r)
        for e in r["entries"]:
            st = states.get(e["name"]) if e["kind"] == "agent" else None
            seen.add(e["name"])
            out.append({"name": e["session"] if e["kind"] == "sub-manager" else e["name"], "kind": e["kind"], "where": r["remote"],
                        "state": ("alive" if st[0] in ("working", "idle") else st[0]) if st else "running",
                        "task": st[2] if st else (f"{e['name']} on {e['item']}" if e["kind"] == "sub-manager" else ""),
                        "lastPing": ago(st[1]) if st else "", "remoteControl": e["url"]})
    if not on:
        for c in R.cloud_entries():
            st = states.get(c["name"])
            seen.add(c["name"])
            out.append({"name": c["name"], "kind": "agent", "where": "cloud", "state": ("alive" if st[0] in ("working", "idle") else st[0]) if st else "cloud",
                        "task": st[2] if st else "", "lastPing": ago(st[1]) if st else "", "remoteControl": c["url"]})
        for name, st in sorted(states.items()):
            if name not in seen:
                out.append({"name": name, "kind": "agent", "where": "not on a remote", "state": st[0], "task": st[2],
                            "lastPing": ago(st[1]), "remoteControl": ""})
    return out, down


def cmd_list(args):
    cfg, repo = project()
    if not R.remotes():
        print("No remotes yet. `factory remote add dev-pc factory@192.168.2.45` tells factory where a machine is; "
              "agents on this machine are not listed here (`factory status` shows all agents).")
        return 0
    out, down = rows(cfg, repo, args.on)
    if args.json:
        print(json.dumps({"agents": out, "unreachable": [{"remote": d["remote"], "error": d["error"]} for d in down]}, indent=2))
        return 0
    if out:
        head = ("NAME", "WHERE", "STATE", "TASK", "LAST PING", "REMOTE CONTROL")
        table = [head] + [(r["name"], r["where"], r["state"], r["task"], r["lastPing"], r["remoteControl"] or "-") for r in out]
        widths = [max(len(str(row[i])) for row in table) for i in range(5)]
        for row in table:
            print("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(row[:5])) + "  " + row[5])
    else:
        print("No agent sessions found on the configured remotes.")
    for d in down:
        print(f"{d['remote']}: unreachable ({d['error']})")
    print("\nfactory follow <name> to attach (--read to watch only). Remote Control links open in the Claude app.")
    return 0


def attach_argv(target, session, read):
    return R.ssh_command(tty=True) + [target, f"tmux attach {'-r ' if read else ''}-t {shlex.quote('=' + session)}"]


def cmd_follow_one(args):
    cfg, repo = project()
    kind, remote, target, session, url = R.find(args.agent, cfg, repo, args.on)
    if kind == "cloud":
        print(f"{args.agent} runs in the cloud. Open it from the Claude app or claude.ai/code:\n  {url}")
        return 0
    R.ensure_sandbox_target(target)
    if args.log:
        return stream(target, session, args.polls)
    note = f"Following {args.agent} on {remote} ({target}), tmux session {session}." + (" Watching only: you cannot type." if args.read else "")
    print(note, file=sys.stderr)
    if url:
        print(f"Remote Control: {url}", file=sys.stderr)
    print(DETACH_NOTE, file=sys.stderr)
    sys.stderr.flush()
    argv = attach_argv(target, session, args.read)
    os.execvp(argv[0], argv)


def capture(target, session):
    rc, out, err = R.ssh_run(target, f"tmux capture-pane -p -t {shlex.quote('=' + session + ':')} -S -200", timeout=20)
    if rc != 0:
        raise RemoteError("session-gone", f"The session {session} on {target} is gone ({(err.strip().splitlines() or ['no answer'])[-1][:100]}).",
                          "factory follow lists what is running.")
    return out.rstrip("\n").splitlines()


def new_lines(prev, now):
    """The lines of `now` that `prev` did not already have, when the screen only scrolled forward."""
    for k in range(min(len(prev), len(now)), 0, -1):
        if prev[-k:] == now[:k]:
            return now[k:]
    return now


def stream(target, session, polls=None, sleep=time.sleep, out=sys.stdout):
    prev, n = None, 0
    try:
        while polls is None or n < polls:
            now = capture(target, session)
            for line in (now if prev is None else new_lines(prev, now)):
                out.write(line + "\n")
            out.flush()
            prev, n = now, n + 1
            if polls is None or n < polls:
                sleep(2)
    except KeyboardInterrupt:
        pass
    return 0


def cmd_follow_all(args):
    cfg, repo = project()
    found = [(r, e) for r in R.discover(cfg, repo, only=args.on) for e in r["entries"]]
    if not found:
        return refuse(RemoteError("nothing-to-follow", "No agent session was found on the remotes.",
                                  "Start agents with `factory agent <name> --detach` on those machines, or check `factory remote list`."))
    if not shutil.which("tmux"):
        return refuse(RemoteError("no-tmux", "--all needs tmux on this machine to tile the panes.", "Install tmux, or follow one agent at a time."))
    for r, _ in found:
        R.ensure_sandbox_target(r["target"])
    session = f"factory-follow-{os.getpid()}"
    cmds = [" ".join(shlex.quote(a) for a in attach_argv(r["target"], e["session"], True)) for r, e in found]
    steps = [["tmux", "new-session", "-d", "-s", session, cmds[0]]]
    steps += [["tmux", "split-window", "-t", session, c] for c in cmds[1:]]
    steps += [["tmux", "select-layout", "-t", session, "tiled"], ["tmux", "set-option", "-t", session, "destroy-unattached", "on"]]
    env = {k: v for k, v in os.environ.items() if k != "TMUX"}
    for s in steps:
        subprocess.run(s, env=env, check=False)
    print("Read-only panes. Detach with Ctrl-b d.", file=sys.stderr)
    argv = ["tmux", "attach", "-t", session]
    os.execvpe(argv[0], argv, env)


def cmd_say(args):
    agents_may_not("send messages to other sessions (`factory say`)")
    message = args.message
    if not message.strip() or len(message) > 2000 or re.search(r"[\x00-\x1f\x7f]", message):
        return refuse(RemoteError("bad-message", "A message must be one line of text, up to 2000 characters.",
                                  "Send one line at a time. Never put a secret in it."))
    cfg, repo = project()
    kind, remote, target, session, _ = R.find(args.agent, cfg, repo, args.on)
    if kind == "cloud":
        return refuse(RemoteError("cloud-agent", f"{args.agent} runs in the cloud, so there is no session to type into from here.",
                                  "Open its Remote Control link (`factory follow " + args.agent + "`) in the Claude app and type there."))
    R.ensure_sandbox_target(target)
    who = f"{os.environ.get('USER') or os.environ.get('LOGNAME') or 'unknown'}@{os.uname().nodename}"
    s = shlex.quote(session)
    script = (f'S={s}; tmux has-session -t "=$S" 2>/dev/null || {{ echo NOSESSION; exit 3; }}; msg=$(cat); '
              f'tmux send-keys -t "=$S:" -l -- "$msg" && tmux send-keys -t "=$S:" Enter || exit 4; '
              f'd="${{XDG_STATE_HOME:-$HOME/.local/state}}/software-factory"; mkdir -p "$d"; '
              f'printf \'%s from=%s via=%s agent=%s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" {shlex.quote(who)} "${{SSH_CLIENT%% *}}" "$S" >>"$d/say.log"')
    rc, out, err = R.ssh_run(target, script, stdin=message)
    if rc == 3 or "NOSESSION" in out:
        return refuse(RemoteError("session-gone", f"The session {session} on {remote} is gone.", "factory follow lists what is running."))
    if rc != 0:
        return refuse(RemoteError("say-failed", f"Could not send the message to {session} on {remote}.", (err.strip().splitlines() or ["Try again."])[-1][:140]))
    print(f"Sent to {args.agent} on {remote} (logged there, without the text).")
    return 0


def agent_session(agent, cfg):
    from factory_machine import repo_key
    if agent.isdigit():
        names = cfg.get("agents") or []
        if not 1 <= int(agent) <= len(names):
            raise RemoteError("no-such-agent", f"There is no agent number {agent}.", f"Names: {', '.join(names)}.")
        agent = names[int(agent) - 1]
    return agent, re.sub(r"[^A-Za-z0-9_-]+", "-", f"{repo_key()}-{agent}")


def cmd_detach(argv):
    if not argv:
        return refuse(RemoteError("usage", "factory agent <name> --detach needs an agent name.", "For example: factory agent haile --detach"))
    cfg, _ = project()
    try:
        agent, session = agent_session(argv[0], cfg)
    except RemoteError as e:
        return refuse(e)
    if not shutil.which("tmux"):
        return refuse(RemoteError("no-tmux", "tmux is not installed, so the agent cannot run detached.", "Install tmux, then run this again."))
    if subprocess.run(["tmux", "has-session", "-t", f"={session}"], capture_output=True).returncode == 0:
        print(f"{agent} is already running (tmux session {session}). Follow it: factory follow {agent}")
        return 0
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    command = "exec " + " ".join(shlex.quote(a) for a in [os.path.join(top, "factory"), "agent", *argv])
    p = subprocess.run(["tmux", "new-session", "-d", "-s", session, "-c", top, command], capture_output=True, text=True)
    if p.returncode != 0:
        return refuse(RemoteError("tmux-failed", f"tmux could not start the session: {(p.stderr.strip().splitlines() or ['no reason'])[-1][:120]}",
                                  "Run `tmux ls` to see what is there."))
    print(f"Started {agent} in the tmux session {session}.\n"
          f"  here:        tmux attach -t {session}   (detach with Ctrl-b d)\n"
          f"  from afar:   factory follow {agent}     (after `factory remote add <name> <user@host>` on your own machine)")
    return 0


def cmd_remote(argv):
    try:
        sub = argv[0] if argv else "list"
        if sub not in ("list", "ls"):
            agents_may_not("change the list of remotes")
        if sub == "add" and len(argv) == 3:
            R.add_ssh(argv[1], argv[2])
            print(f"Added {argv[1]} -> {argv[2]}. `factory follow` lists the agents there.")
        elif sub == "cloud" and len(argv) == 3:
            R.add_cloud(argv[1], argv[2])
            print(f"Added the cloud agent {argv[1]}. `factory follow {argv[1]}` prints its Remote Control link.")
        elif sub in ("remove", "rm") and len(argv) == 2:
            R.remove(argv[1])
            print(f"Removed {argv[1]}.")
        elif sub in ("list", "ls") and len(argv) <= 1:
            data = R.remotes()
            if not data:
                print("No remotes. factory remote add <name> <user@host> | factory remote cloud <agent> <url>")
            for k, v in sorted(data.items()):
                print(f"{k}  {'cloud' if v.get('kind') == 'cloud' else 'ssh'}  {v.get('url') or v.get('target')}")
        else:
            print("usage: factory remote add <name> <user@host> | cloud <agent> <url> | list | remove <name>", file=sys.stderr)
            return 1
    except RemoteError as e:
        return refuse(e)
    return 0


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "remote":
            return cmd_remote(rest)
        if cmd == "detach":
            return cmd_detach(rest)
        ap = argparse.ArgumentParser(prog=f"factory {cmd}", add_help=False)
        ap.add_argument("--on")
        if cmd == "say":
            ap.add_argument("agent")
            ap.add_argument("message")
            return cmd_say(ap.parse_args(rest))
        if cmd == "follow":
            ap.add_argument("agent", nargs="?")
            ap.add_argument("--read", action="store_true")
            ap.add_argument("--all", action="store_true")
            ap.add_argument("--log", action="store_true")
            ap.add_argument("--json", action="store_true")
            ap.add_argument("--polls", type=int)
            a = ap.parse_args(rest)
            if a.all:
                return cmd_follow_all(a)
            return cmd_follow_one(a) if a.agent else cmd_list(a)
        print(f"factory_follow.py: unknown command {cmd}", file=sys.stderr)
        return 1
    except RemoteError as e:
        return refuse(e)
    except SystemExit:
        raise


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
