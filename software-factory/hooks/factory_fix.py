#!/usr/bin/env python3
"""`factory fix`: format and auto-fix the files this branch changed, so agents never spend a turn on style (#69).

Runs `commands.fix` from .claude/factory.json on the changed files only: every file that differs from the merge base
with main (committed on the branch, edited, or new and not ignored), minus deleted files and, when `fixPaths` is set,
minus files that match none of its regexes. Unrelated files are never passed to the fixer, so they never churn.

`commands.fix` holds `{files}` where the quoted file list goes (for example
`prettier --write {files} && eslint --fix {files}`); without `{files}` the list is appended. A long list runs in
chunks. The agent sees one line ("formatted 3 files", never a diff). When the fixer exits non-zero, the findings it
could not fix are shown the way a failing check is: the failing lines first, `checkOutputLines` in all, and the log.

The Stop check runs it before typecheck and test, and `factory verify` runs it before `commands.ci`.

  factory fix            exit 0: nothing to do, or formatted; 1: the fixer failed or can't run
"""
import hashlib, os, re, shlex, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402
from factory_run_check import excerpt, line_limit, write_log  # noqa: E402

CHUNK = 100  # files per fixer run, so a big branch never exceeds the shell's argument limit


def git(*a):
    p = subprocess.run(["git", *a], capture_output=True, text=True)
    return p.returncode, p.stdout


def base(cfg):
    """The commit the branch started from: the merge base with origin/<main>, else <main>, else HEAD."""
    for ref in (f"origin/{cfg['mainBranch']}", cfg["mainBranch"]):
        rc, out = git("merge-base", "HEAD", ref)
        if rc == 0 and out.strip():
            return out.strip()
    return "HEAD"


def changed_files(cfg):
    """Files changed on this branch that still exist, sorted, filtered by `fixPaths`."""
    _, tracked = git("diff", "--name-only", "--diff-filter=d", "-z", base(cfg), "--")
    _, new = git("ls-files", "-z", "--others", "--exclude-standard")
    names = {n for n in (tracked + new).split("\0") if n and os.path.isfile(n) and not os.path.islink(n)}
    patterns = [re.compile(p) for p in cfg.get("fixPaths") or []]
    if patterns:
        names = {n for n in names if any(p.search(n) for p in patterns)}
    return sorted(names)


def digest(names):
    out = {}
    for n in names:
        try:
            with open(n, "rb") as f:
                out[n] = hashlib.sha256(f.read()).hexdigest()
        except OSError:
            out[n] = ""
    return out


def command_for(template, files):
    quoted = " ".join(shlex.quote(f) for f in files)
    return template.replace("{files}", quoted) if "{files}" in template else f"{template} {quoted}"


def run(cfg):
    """Run the fixer. Returns (exit code, message): the code is the fixer's own; the message is one line, or the
    capped findings when it failed. An empty message means there was nothing to do."""
    template = ((cfg.get("commands") or {}).get("fix") or "").strip()
    if not template:
        return 0, ""
    files = changed_files(cfg)
    if not files:
        return 0, ""
    before = digest(files)
    text, rc, cmd = "", 0, template
    for i in range(0, len(files), CHUNK):
        cmd = command_for(template, files[i:i + CHUNK])
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        text += p.stdout + p.stderr
        if p.returncode != 0:
            rc = p.returncode
            break
    after = digest(files)
    n = sum(1 for f in files if before[f] != after[f])
    done = f"formatted {n} file{'' if n == 1 else 's'}" if n else ""
    if rc == 0:
        return 0, done
    log = write_log(cfg, "fix", f"$ {cmd}\n{text}")
    where = f" Full log: {log}" if log else ""
    head = f"`commands.fix` fails (exit {rc}); fix what it names by hand.{where}"
    return rc, (done + ". " if done else "") + head + "\n" + "\n".join(excerpt(text, line_limit(cfg)))


def main():
    cfg = load()
    if not (cfg.get("commands") or {}).get("fix"):
        print("commands.fix isn't set in .claude/factory.json, so there is nothing to run. Set it to your "
              "formatter and auto-fixer, for example: prettier --write {files} && eslint --fix {files}")
        return 0
    rc, msg = run(cfg)
    print(msg or "nothing to format", file=sys.stderr if rc else sys.stdout)
    return rc


if __name__ == "__main__":
    sys.exit(main())
