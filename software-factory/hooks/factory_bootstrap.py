#!/usr/bin/env python3
"""`factory bootstrap`: take a fresh Linux machine to a sandboxed, factory-ready state (#105).

  factory bootstrap machine [options]      the steps that need root: packages, the dedicated user, subuid/subgid, linger,
                                           the network guard (and, if you ask, key-only SSH and a machine that stays awake)
  factory bootstrap project [options]      what the dedicated user sets up for itself (never as root): rootless Docker,
                                           Node, Claude Code, the checkout, the stack, CI runners, autostart; ends with
                                           `factory doctor --sandbox`
  factory bootstrap all [options]          the machine plan, then how to continue as the dedicated user
  factory bootstrap status                 what bootstrap set up (its manifest) against what is there now
  factory bootstrap uninstall [--apply]    remove the system parts; the user and its home stay unless you type a confirmation

Nothing privileged runs by itself. `machine` and `uninstall` print the plan and change nothing; `--apply`, as root
(`sudo factory bootstrap machine --apply`), runs it, and `--script [FILE]` writes the same steps as a bash script you can
read first. `--dry-run` is accepted everywhere and is the default for the privileged steps. Every step is checked first, so
a second run changes nothing. Errors are `{code, message, fix}` on stderr.

Options: --user NAME (factory)  --egress internet|none  --allow-host ADDR[:PORT] (repeat)  --block-loopback-port PORT (repeat)
         --block-inbound-port PORT (repeat)  --authorized-keys FILE  --harden-ssh  --keep-awake | --no-keep-awake
         --runners N  --agents a,b  --repo URL  --dir PATH  --yes

The human steps are never done here: `gh auth login`, the Claude login (and its folder-trust prompt) and copying the age
key. Bootstrap checks that they exist (it never reads, prints or stores a token or the key) and tells you what to run.
"""
import argparse, datetime, json, os, re, shlex, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_bootstrap_machine as M  # noqa: E402
import factory_bootstrap_project as PR  # noqa: E402
from factory_bootstrap_core import BootstrapError, Context, Executor, probe, refuse, shell_of  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
USER_OK = re.compile(r"[a-z_][a-z0-9_-]{0,30}")


def parser():
    ap = argparse.ArgumentParser(prog="factory bootstrap", add_help=False)
    ap.add_argument("what", nargs="?", default="help")
    ap.add_argument("--user", default="factory")
    ap.add_argument("--egress", default="internet")
    ap.add_argument("--allow-host", action="append", default=[])
    ap.add_argument("--block-loopback-port", action="append", default=[])
    ap.add_argument("--block-inbound-port", action="append", default=[])
    ap.add_argument("--authorized-keys")
    ap.add_argument("--harden-ssh", action="store_true")
    ap.add_argument("--keep-awake", dest="keep_awake", action="store_true", default=None)
    ap.add_argument("--no-keep-awake", dest="keep_awake", action="store_false")
    ap.add_argument("--runners", type=int)
    ap.add_argument("--agents")
    ap.add_argument("--repo")
    ap.add_argument("--dir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--script", nargs="?", const="-")
    ap.add_argument("--remove-user", action="store_true")
    ap.add_argument("--delete-home", action="store_true")
    ap.add_argument("--confirm")
    ap.add_argument("-h", "--help", action="store_true")
    return ap


def options(a):
    if not USER_OK.fullmatch(a.user) or a.user == "root":
        raise BootstrapError("bad-user", f"{a.user!r} is not a usable account name.", "Use lowercase letters, digits, - and _, not root.")
    if a.egress not in ("internet", "none"):
        raise BootstrapError("bad-egress", f"--egress {a.egress!r} is not internet or none.", "Use --egress internet or --egress none.")
    try:
        import factory_netguard as G
        [G.parse_allow_host(h) for h in a.allow_host]
        ports = [G.parse_port(p) for p in a.block_loopback_port + a.block_inbound_port]
    except Exception as e:
        raise BootstrapError("bad-option", str(e), "Fix the option and run it again.")
    agents = [x for x in (a.agents or "").split(",") if x]
    if any(not re.fullmatch(r"[a-z][a-z0-9-]*", x) for x in agents):
        raise BootstrapError("bad-agents", f"--agents {a.agents!r}: names are lowercase letters, digits and dashes.",
                             "For example --agents haile,tewodros.")
    return {"user": a.user, "egress": a.egress, "allow_hosts": a.allow_host, "block_loopback_ports": a.block_loopback_port,
            "block_inbound_ports": a.block_inbound_port, "authorized_keys": a.authorized_keys, "harden_ssh": a.harden_ssh,
            "keep_awake": a.keep_awake, "runners": a.runners, "agents": agents, "repo": a.repo, "dir": a.dir}


def is_root():
    return hasattr(os, "geteuid") and os.geteuid() == 0


def show_plan(steps, ctx, out=print):
    todo = 0
    for s in steps:
        if s.done():
            out(f"ok    {s.title}")
            continue
        todo += 1
        out(f"plan  {s.title}")
        if s.manual:
            out(f"      by hand: {s.manual}")
        for act in s.actions:
            for line in shell_of(act, ctx).splitlines():
                out(f"      {line}")
    return todo


def script_of(steps, ctx, user):
    lines = ["#!/usr/bin/env bash", "# Generated by `factory bootstrap` (read it before you run it, as root).",
             "set -euo pipefail", 'export DEBIAN_FRONTEND=noninteractive',
             '[ "$(id -u)" = 0 ] || { echo "run this as root (sudo bash <this file>)" >&2; exit 1; }', ""]
    for s in steps:
        if s.done():
            lines.append(f"# already done: {s.title}")
            continue
        lines.append(f"echo '== {s.title.replace(chr(39), '')}'")
        if any("$UID_F" in shell_of(a, ctx) for a in s.actions):
            lines.append(f"UID_F=$(id -u {shlex.quote(user)})")
        for act in s.actions:
            lines.append(shell_of(act, ctx))
        lines.append("")
    lines.append('echo "Done. Next, as the sandbox user: factory bootstrap project"')
    return "\n".join(lines) + "\n"


def save_manifest(opts, done):
    path = M.manifest_path()
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    data.update({"version": 1, "user": opts["user"], "uid": M.user_uid(opts["user"])})
    data.setdefault("steps", {})
    for s in done:
        data["steps"][s.id] = {"at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "record": s.record}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(path + ".tmp", path)


def confirm(question, yes):
    if yes:
        return True
    if not sys.stdin.isatty():
        raise BootstrapError("needs-yes", "This would change the machine and there is no terminal to ask on.",
                             "Read the plan, then run it again with --yes.")
    return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")


def execute(steps, ctx, opts, record_manifest):
    """Runs the steps that are not done, in order, verifying each. Returns 0, or 1 at the first failure."""
    ex, done = Executor(ctx), []
    for s in steps:
        if s.done():
            print(f"ok    {s.title}")
            continue
        if s.manual and not s.actions:
            print(f"fix   {s.title}: {s.manual}")
            return 1
        if s.manual:
            print(f"note  {s.title}: {s.manual}")
        print(f"run   {s.title}")
        try:
            for act in s.actions:
                ex.do(act)
        except BootstrapError as e:
            print(f"fix   {s.title}: {e.message} {e.fix}")
            if record_manifest and done:
                save_manifest(opts, done)
            return 1
        if not s.trust and not s.done():
            print(f"fix   {s.title}: it ran, but the check afterwards still fails. Read the step's output above, fix it, "
                  "and run the command again.")
            if record_manifest and done:
                save_manifest(opts, done)
            return 1
        done.append(s)
        print(f"done  {s.title}")
    if record_manifest and done:
        save_manifest(opts, done)
    return 0


def cmd_machine(a, opts):
    steps = M.steps(opts)
    ctx = Context(opts["user"], applying=a.apply and not a.dry_run and not a.script)
    if a.script:
        text = script_of(steps, Context(opts["user"], False), opts["user"])
        if a.script == "-":
            sys.stdout.write(text)
        else:
            with open(a.script, "w") as f:
                f.write(text)
            os.chmod(a.script, 0o700)
            print(f"Wrote {a.script}. Read it, then run it as root: sudo bash {a.script}")
        return 0
    if not (a.apply and not a.dry_run):
        todo = show_plan(steps, ctx)
        print()
        print("Everything is in place." if not todo else
              f"{todo} step(s) to do. Nothing was changed. To run them: `sudo factory bootstrap machine --apply` "
              "(or `--script FILE` to read them as a bash script first).")
        return 0
    if not is_root():
        return refuse(BootstrapError("not-root", "These steps change the system and need root.",
                                     "Run: sudo factory bootstrap machine --apply"))
    todo = [s for s in steps if not s.done()]
    if todo and not confirm(f"Run {len(todo)} privileged step(s) as root?", a.yes):
        print("Nothing was changed.")
        return 0
    rc = execute(steps, ctx, opts, record_manifest=True)
    if rc == 0:
        print()
        print(f"The machine part is done. Next, as {opts['user']} (ssh in, or `sudo -u {opts['user']} -i`), from the project's "
              "checkout: factory bootstrap project")
    return rc


def project_root():
    rc, out, _ = probe(["git", "rev-parse", "--show-toplevel"])
    return out.strip() if rc == 0 else ""


def load_project_cfg(root):
    if not root:
        return {}
    os.environ["CLAUDE_PROJECT_DIR"] = root
    try:
        from factory_config import load
        return load()
    except (OSError, ValueError, ImportError):
        return {}


def report_human(project):
    open_ = [(t, c) for t, c, ok in PR.human_steps(project) if not ok]
    if not open_:
        print("ok    GitHub, Claude and the age key are in place")
        return True
    print()
    print("These steps are yours. Bootstrap never signs in for you and never reads or stores a token or the key:")
    for i, (title, cmd) in enumerate(open_, 1):
        print(f"  {i}. {title}:  {cmd}")
    print("Then run `factory bootstrap project` again; it carries on from here and ends with `factory doctor --sandbox`.")
    return False


def cmd_project(a, opts):
    if is_root():
        return refuse(BootstrapError("root-refused", "The project part must not run as root.",
                                     f"Run it as the sandbox user: sudo -u {opts['user']} -i, then `factory bootstrap project`."))
    root = project_root()
    cfg = load_project_cfg(root)
    ctx = Context(opts["user"], False)
    steps = PR.steps(opts, root, cfg)
    if a.dry_run:
        show_plan(steps, ctx)
        if root:
            show_plan(PR.after_human(opts, root, cfg), ctx)
        return 0
    rc = execute(steps, ctx, opts, record_manifest=False)
    if rc or not root:
        return rc
    if not report_human(root):
        return 2
    rc = execute(PR.after_human(opts, root, cfg), ctx, opts, record_manifest=False)
    if rc:
        return rc
    print()
    doctor = os.path.join(HERE, "factory_doctor.py")
    p = subprocess.run([sys.executable, doctor, "--sandbox"], env={**os.environ, "CLAUDE_PROJECT_DIR": root},
                       capture_output=True, text=True)
    sys.stdout.write(p.stdout)
    sys.stderr.write(p.stderr)
    return p.returncode


def cmd_status(a, opts):
    try:
        data = json.load(open(M.manifest_path()))
    except (OSError, ValueError):
        print("Bootstrap has not been run on this machine (no manifest at " + M.manifest_path() + ").")
        return 0
    bad = 0
    print(f"Sandbox user: {data.get('user')} (uid {data.get('uid')})")
    for sid, entry in sorted(data.get("steps", {}).items()):
        rec, problems = entry.get("record", {}), []
        for f in rec.get("files", []):
            if not os.path.exists(f):
                problems.append(f"{f} is missing")
        for u in rec.get("units", []):
            if probe(["systemctl", "is-enabled", "--quiet", u])[0] != 0:
                problems.append(f"{u} is not enabled")
        if rec.get("user") and not M.user_exists(rec["user"]):
            problems.append(f"user {rec['user']} is gone")
        print(("fix   " if problems else "ok    ") + f"{sid} ({entry.get('at', '?')})" + (": " + "; ".join(problems) if problems else ""))
        bad += bool(problems)
    if bad:
        print(f"\n{bad} step(s) differ from what bootstrap recorded: `sudo factory bootstrap machine --apply` puts them back.")
    return 1 if bad else 0


def uninstall_steps(data):
    """What to remove, from the manifest: only things bootstrap recorded."""
    out = []
    for sid, entry in sorted(data.get("steps", {}).items(), reverse=True):
        rec = entry.get("record", {})
        for u in rec.get("units", []):
            out.append((f"stop and disable {u}", ["systemctl", "disable", "--now", u], True))
        if rec.get("table"):
            out.append((f"delete the nft table {rec['table']}", ["nft", "delete", "table", "inet", rec["table"]], True))
        for t in rec.get("masked", []):
            out.append((f"unmask {t}", ["systemctl", "unmask", t], True))
        for f in rec.get("files", []):
            if sid != "sops":  # tools stay: other things may use them
                out.append((f"remove {f}", ["rm", "-f", f], True))
    out.append(("reload systemd", ["systemctl", "daemon-reload"], True))
    return out


def cmd_uninstall(a, opts):
    try:
        data = json.load(open(M.manifest_path()))
    except (OSError, ValueError):
        print("Nothing to uninstall: bootstrap has no manifest on this machine.")
        return 0
    user = data.get("user") or opts["user"]
    actions = uninstall_steps(data)
    created = data.get("steps", {}).get("user", {}).get("record", {}).get("created")
    if a.remove_user or a.delete_home:
        if not created:
            print(f"note  {user} existed before bootstrap, so it is not removed.")
        else:
            actions.append((f"remove the user {user}" + (" and its home" if a.delete_home else " (the home folder stays)"),
                            ["deluser"] + (["--remove-home"] if a.delete_home else []) + [user], True))
    for title, argv, _ in actions:
        print(("run   " if a.apply and not a.dry_run else "plan  ") + title + "   # " + " ".join(argv))
    if not a.apply or a.dry_run:
        print("\nNothing was changed. The home folder, the backups and the installed packages are never removed by default.")
        return 0
    if not is_root():
        return refuse(BootstrapError("not-root", "Removing system parts needs root.", "Run: sudo factory bootstrap uninstall --apply"))
    if (a.remove_user or a.delete_home) and created:
        typed = a.confirm if a.confirm is not None else (input(f"Type the user name ({user}) to confirm: ").strip() if sys.stdin.isatty() else "")
        if typed != user:
            return refuse(BootstrapError("not-confirmed", f"The user is only removed after you type its name ({user}).",
                                         f"Run it again with --confirm {user}, or type the name when asked."))
    elif not confirm("Remove these system parts?", a.yes):
        print("Nothing was changed.")
        return 0
    for title, argv, _ in actions:
        if argv[0] == "deluser" and not ((a.remove_user or a.delete_home) and created):
            continue
        rc, _, err = probe(argv)
        if rc != 0 and argv[0] != "nft":
            print(f"fix   {title}: {(err.strip().splitlines() or ['failed'])[-1][:140]}")
    try:
        os.remove(M.manifest_path())
    except OSError:
        pass
    print("done  system parts removed; the manifest is gone.")
    return 0


def main(argv):
    a = parser().parse_args(argv)
    if a.help or a.what in ("help", "-h"):
        print(__doc__)
        return 0
    try:
        if any(os.environ.get(k) for k in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE")) and a.what != "status":
            raise BootstrapError("agent-session", "An agent session can't set up or remove a machine.",
                                 "A person runs `factory bootstrap` from their own terminal (the agent variables are set here).")
        opts = options(a)
        if a.what == "machine":
            return cmd_machine(a, opts)
        if a.what == "project":
            return cmd_project(a, opts)
        if a.what == "all":
            rc = cmd_machine(a, opts)
            if rc == 0 and not (a.apply and not a.dry_run):
                print(f"\nThen, as {opts['user']}: factory bootstrap project")
            return rc
        if a.what == "status":
            return cmd_status(a, opts)
        if a.what == "uninstall":
            return cmd_uninstall(a, opts)
        return refuse(BootstrapError("unknown-command", f"`factory bootstrap {a.what}` is not a command.",
                                     "Use machine, project, all, status or uninstall (factory bootstrap help)."))
    except BootstrapError as e:
        return refuse(e)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
