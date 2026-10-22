#!/usr/bin/env python3
"""Tells a CI failure from CI that never ran.

When GitHub can't start a job (the account's Actions minutes or spending limit, a failed payment), every job ends
at once as a failure, with no steps and an annotation such as "The job was not started because recent account
payments have failed or your spending limit needs to be increased". That says nothing about the code: pushing
again or re-running CI only adds more failed runs. Only a person (billing) can fix it.

  python3 .claude/hooks/factory_ci.py <commit>     prints why CI didn't run and exits 3; exits 0 when it did run
"""
import json, re, subprocess, sys

# Only GitHub's own wording: a real test named "billing" that fails must still count as a failure.
NOT_STARTED = re.compile(r"\bjob was not started\b|\bspending limit needs to be increased\b", re.I)
MESSAGE = ("CI didn't run on this commit: GitHub didn't start the jobs ({why}). That isn't a result about your code, "
           "so don't change code, push again or re-run CI to chase it. A person has to fix the account (Settings > "
           "Billing and plans). Leave the pull request open, say so on it once, and carry on with the next task; "
           "the dev manager re-runs CI when it works again.")


def gh_json(path):
    p = subprocess.run(["gh", "api", "--paginate", path], capture_output=True, text=True)
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout.replace("}{", "},{").replace("][", ","))
    except json.JSONDecodeError:
        return None


def not_started(sha):
    """The annotation's text when every failed check run on the commit never started, else None."""
    data = gh_json(f"repos/{{owner}}/{{repo}}/commits/{sha}/check-runs?per_page=100")
    runs = (data or {}).get("check_runs", []) if isinstance(data, dict) else []
    failed = [r for r in runs if r.get("conclusion") in ("failure", "startup_failure")]
    if not failed:
        return None
    why = None
    for r in failed:
        notes = gh_json(f"repos/{{owner}}/{{repo}}/check-runs/{r['id']}/annotations") or []
        hit = next((n.get("message", "") for n in notes if NOT_STARTED.search(n.get("message", ""))), None)
        if not hit:
            return None  # at least one job really ran and failed
        why = why or hit
    return why.strip().rstrip(".")


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: factory_ci.py <commit>")
    why = not_started(sys.argv[1])
    if why:
        print(MESSAGE.format(why=why))
        sys.exit(3)


if __name__ == "__main__":
    main()
