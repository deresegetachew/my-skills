#!/usr/bin/env python3
"""The parts `factory bootstrap` is built from (#105): a step is data (what to check, what to do), so the same list can
be shown as a plan, written as a shell script for the owner to review, or run. Nothing here runs by itself.

  Run(argv)            a command (as another user with `as_user`)
  Write(path, text)    a file with a mode and an owner; `text` may be a function of the Context
  Mkdir(path)          a folder with a mode and an owner
  Call(fn, label)      Python code for the few things a command line cannot do (a checksum-verified download)

A Step has a `done()` check, so a second run changes nothing, and `privileged`: such a step runs only through
`--apply` and as root. Errors are `{code, message, fix}`.
"""
import json, os, pwd, shlex, subprocess, sys


class BootstrapError(Exception):
    def __init__(self, code, message, fix):
        super().__init__(message)
        self.code, self.message, self.fix = code, message, fix

    def as_json(self):
        return json.dumps({"code": self.code, "message": self.message, "fix": self.fix})


class Run:
    def __init__(self, argv, as_user=None, env=None, stdin=None, ok=(0,)):
        self.argv, self.as_user, self.env, self.stdin, self.ok = list(argv), as_user, dict(env or {}), stdin, tuple(ok)


class Write:
    def __init__(self, path, text, mode=0o644, owner=None):
        self.path, self.text, self.mode, self.owner = path, text, mode, owner


class Mkdir:
    def __init__(self, path, mode=0o755, owner=None):
        self.path, self.mode, self.owner = path, mode, owner


class Call:
    def __init__(self, fn, label):
        self.fn, self.label = fn, label


class Step:
    def __init__(self, sid, title, actions, done=None, privileged=False, record=None, manual="", trust=False):
        # trust: the actions are idempotent commands whose result can't be checked (the project's own install command)
        self.trust = trust
        self.id, self.title, self.actions, self.done = sid, title, actions, done or (lambda: False)
        self.privileged, self.record, self.manual = privileged, record or {}, manual


class Context:
    """What the actions may ask for: the dedicated user, its uid (a shell variable while only planning)."""

    def __init__(self, user, applying):
        self.user, self.applying = user, applying

    def uid(self):
        if not self.applying:
            return "$UID_F"
        try:
            return pwd.getpwnam(self.user).pw_uid
        except KeyError:
            rc, out, _ = probe(["id", "-u", self.user])
            if rc == 0 and out.strip().isdigit():
                return int(out.strip())
            raise BootstrapError("no-user", f"The user {self.user} does not exist yet.",
                                 "Run the user step first (`factory bootstrap machine --apply`).")


def text_of(action, ctx):
    t = action.text
    return t(ctx) if callable(t) else t


def shell_of(action, ctx):
    """One action as shell text (for the plan and for --script)."""
    if isinstance(action, Run):
        argv = " ".join(shlex.quote(a) for a in action.argv)
        envs = " ".join(f"{k}={shlex.quote(v)}" for k, v in action.env.items())
        line = (f"{envs} " if envs else "") + argv
        if action.as_user:
            line = f"runuser -u {shlex.quote(action.as_user)} -- " + (f"env {envs} " if envs else "") + argv
        return line + (" <<'EOF'\n" + action.stdin + "EOF" if action.stdin else "")
    if isinstance(action, Write):
        text = text_of(action, ctx)
        own = f" -o {shlex.quote(action.owner)} -g {shlex.quote(action.owner)}" if action.owner else ""
        marker = "FACTORY_EOF"
        # The heredoc is unquoted only where the text holds the uid variable.
        quote = "" if "$UID_F" in text else "'"
        return (f"install -d -m 755 {shlex.quote(os.path.dirname(action.path))}\n"
                f"install -m {action.mode:o}{own} /dev/stdin {shlex.quote(action.path)} <<{quote}{marker}{quote}\n"
                f"{text.rstrip(chr(10))}\n{marker}")
    if isinstance(action, Mkdir):
        own = f" -o {shlex.quote(action.owner)} -g {shlex.quote(action.owner)}" if action.owner else ""
        return f"install -d -m {action.mode:o}{own} {shlex.quote(action.path)}"
    return f"# {action.label} (done by factory bootstrap itself; see the plan for what it does)"


class Executor:
    """Runs actions. `echo` prints one line per action as it goes; secrets never pass through here (no env value is
    printed, and `Run.env` holds only non-secret settings)."""

    def __init__(self, ctx, echo=print):
        self.ctx, self.echo = ctx, echo

    def run_argv(self, argv, env=None, stdin=None, as_user=None):
        full = list(argv)
        if as_user and (not hasattr(os, "geteuid") or os.geteuid() == 0):
            full = ["runuser", "-u", as_user, "--"] + (["env"] + [f"{k}={v}" for k, v in (env or {}).items()] if env else []) + full
            env = None
        p = subprocess.run(full, input=stdin, text=True, capture_output=True, env={**os.environ, **(env or {})})
        return p.returncode, (p.stdout or ""), (p.stderr or "")

    def do(self, action):
        if isinstance(action, Run):
            rc, out, err = self.run_argv(action.argv, action.env, action.stdin, action.as_user)
            if rc not in action.ok:
                tail = (err or out).strip().splitlines()[-1:] or ["no output"]
                raise BootstrapError("command-failed", f"`{' '.join(action.argv[:3])}` failed (exit {rc}): {tail[0][:160]}",
                                     "Read the message, fix the cause and run the same command again: finished steps are skipped.")
        elif isinstance(action, Write):
            os.makedirs(os.path.dirname(action.path), exist_ok=True)
            tmp = action.path + ".tmp"
            with open(tmp, "w") as f:
                f.write(text_of(action, self.ctx))
            os.chmod(tmp, action.mode)
            if action.owner and hasattr(os, "geteuid") and os.geteuid() == 0:
                try:
                    pw = pwd.getpwnam(action.owner)
                    os.chown(tmp, pw.pw_uid, pw.pw_gid)
                except KeyError:
                    pass
            os.replace(tmp, action.path)
        elif isinstance(action, Mkdir):
            os.makedirs(action.path, exist_ok=True)
            os.chmod(action.path, action.mode)
            if action.owner and hasattr(os, "geteuid") and os.geteuid() == 0:
                try:
                    pw = pwd.getpwnam(action.owner)
                    os.chown(action.path, pw.pw_uid, pw.pw_gid)
                except KeyError:
                    pass
        elif isinstance(action, Call):
            action.fn()


def probe(argv, env=None, timeout=20):
    """(returncode, stdout, stderr) of a read-only command; (127, '', reason) when it cannot start."""
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env={**os.environ, **(env or {})})
    except (OSError, subprocess.TimeoutExpired) as e:
        return 127, "", str(e)
    return p.returncode, p.stdout, p.stderr


def refuse(err, code=1):
    print(err.as_json(), file=sys.stderr)
    return code
