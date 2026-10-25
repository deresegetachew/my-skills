#!/usr/bin/env python3
"""`factory run-check [--name N] [--lines N] <command>`: run a check or test command quietly (#68).

The full output goes to a log file (`<checkLogDir>/<name>.log`, default tmp/checks), and the agent sees only a
capped summary: one line when it passes; when it fails, the lines that name a failure first, then the end of the
output (`checkOutputLines` in all), and the log path to open only if that isn't enough. Exit code: the command's.
The log folder holds a `.gitignore`, so a log never counts as an untracked file (the Stop check and `factory verify`
compare those).

  factory run-check pnpm -s test
  factory run-check --name types -- pnpm -s typecheck
"""
import os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402

# A line that names a failure: a failed test, an assertion, a compiler error with its file and line.
FAILURE = re.compile(r"(\bFAIL(ED)?\b|✗|×|\bError\b|\berror TS\d+|AssertionError|\bexpected\b|"
                     r"Traceback|:\d+:\d+)", re.I)


def excerpt(text, limit):
    """At most `limit` lines: the failing ones first (in order), then the end of the output, without repeats."""
    lines = [l for l in text.strip().splitlines() if l.strip()]
    failing = [i for i, l in enumerate(lines) if FAILURE.search(l)][: max(limit // 2, 1)]
    tail = list(range(max(len(lines) - (limit - len(failing)), 0), len(lines)))
    keep = sorted(set(failing) | set(tail))[-limit:] if limit > 0 else []
    out, last = [], None
    for i in keep:
        if last is not None and i != last + 1:
            out.append("...")
        out.append(lines[i])
        last = i
    return out


def line_limit(cfg):
    try:  # a bad value must never hide a failure
        return max(int(cfg.get("checkOutputLines") or 40), 1)
    except (TypeError, ValueError):
        return 40


def write_log(cfg, name, text):
    """Save the full output; returns the path, or "" when it can't be written (the summary still works)."""
    d = cfg.get("checkLogDir") or "tmp/checks"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "check"
    path = os.path.join(d, safe + ".log")
    try:
        os.makedirs(d, exist_ok=True)
        gi = os.path.join(d, ".gitignore")
        if not os.path.exists(gi):
            with open(gi, "w") as f:
                f.write("*\n")
        with open(path, "w") as f:
            f.write(text)
        return path
    except OSError:
        return ""


def run(cmd, cfg, name=None, limit=None):
    """Run `cmd` in a shell. Returns (exit code, the summary to show)."""
    limit = limit or line_limit(cfg)
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    text = r.stdout + r.stderr
    log = write_log(cfg, name or re.sub(r"\W+", "-", cmd)[:40], f"$ {cmd}\n{text}")
    where = f"Full log: {log}" if log else "The full log could not be saved."
    n = len(text.splitlines())
    if r.returncode == 0:
        return 0, f"ok: `{cmd}` ({n} lines hidden). {where}"
    head = f"`{cmd}` fails (exit {r.returncode}). First errors, {limit} lines at most. {where}"
    return r.returncode, head + "\n" + "\n".join(excerpt(text, limit))


def main(argv):
    name, lines, args = None, None, list(argv)
    while args and args[0] in ("--name", "--lines") and len(args) > 1:
        if args[0] == "--name":
            name = args[1]
        else:
            try:
                lines = max(int(args[1]), 1)
            except ValueError:
                print("factory run-check: --lines takes a number", file=sys.stderr)
                return 2
        args = args[2:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print("usage: factory run-check [--name N] [--lines N] [--] <command>", file=sys.stderr)
        return 2
    cmd = args[0] if len(args) == 1 else " ".join(__import__("shlex").quote(a) for a in args)
    code, summary = run(cmd, load(), name, lines)
    print(summary, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
