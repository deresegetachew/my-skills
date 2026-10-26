#!/usr/bin/env python3
"""`factory ci log <pr or run>`: why did my CI fail? Prints the failed job's log, trimmed to the failing step (#206).

Read-only: it only GETs through `gh api`, so it needs none of the writes the deny rules keep out. The argument is a
pull request number or a workflow run id; a number that is not a pull request is tried as a run.

  python3 .claude/hooks/factory_ci_log.py <pr or run>

No failed job: one line saying so (exit 0). Not found or unreadable: `{code, message, fix}` on stderr (exit 1).
"""
import json, re, subprocess, sys

UNSUCCESSFUL = {"failure", "startup_failure", "timed_out", "cancelled", "action_required", "stale"}
STAMP = re.compile(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ?")
MAX_LINES = 80


def gh(path, raw=False):
    """The JSON (or, with raw, the text) at a path; None when gh fails."""
    p = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if p.returncode != 0:
        return None
    if raw:
        return p.stdout
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return None


def fail(code, message, fix):
    print(json.dumps({"code": code, "message": message, "fix": fix}), file=sys.stderr)
    return 1


def failed_jobs(number):
    """(label, [failed jobs]) for a pull request, else for a run; (None, None) when it is neither."""
    pr = gh(f"repos/{{owner}}/{{repo}}/pulls/{number}")
    if isinstance(pr, dict) and (pr.get("head") or {}).get("sha"):
        sha = pr["head"]["sha"]
        data = gh(f"repos/{{owner}}/{{repo}}/commits/{sha}/check-runs?per_page=100")
        runs = data.get("check_runs", []) if isinstance(data, dict) else []
        bad = [r for r in runs if r.get("conclusion") in UNSUCCESSFUL]
        jobs = [gh(f"repos/{{owner}}/{{repo}}/actions/jobs/{r['id']}") or r for r in bad]
        return f"PR #{number} ({sha[:7]})", jobs
    data = gh(f"repos/{{owner}}/{{repo}}/actions/runs/{number}/jobs?per_page=100")
    if isinstance(data, dict) and "jobs" in data:
        return f"run {number}", [j for j in data["jobs"] if j.get("conclusion") in UNSUCCESSFUL]
    return None, None


def trim(log):
    """The log lines of the failing step: from the last group start before the first error to the error line."""
    lines = [STAMP.sub("", l) for l in log.splitlines()]
    err = next((i for i, l in enumerate(lines) if l.startswith("##[error]")), None)
    if err is None:
        return lines[-MAX_LINES:]
    start = max([i for i, l in enumerate(lines[:err]) if l.startswith("##[group]")] or [max(0, err - MAX_LINES)])
    chunk = lines[start:min(len(lines), err + 1)]
    return chunk[-MAX_LINES:]


def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        return fail("usage", "factory ci log needs a pull request number or a run id.", "Run `factory ci log 123`.")
    label, jobs = failed_jobs(sys.argv[1])
    if label is None:
        return fail("ci-not-found", f"{sys.argv[1]} is not a pull request or a workflow run here (or gh could not read it).",
                    "Check the number with `gh pr list` or `factory ci status`, then run `factory ci log <number>` again.")
    if not jobs:
        print(f"{label}: No failed job found. CI passed, is still running, or has not started.")
        return 0
    for job in jobs:
        step = next((s for s in job.get("steps") or [] if s.get("conclusion") in UNSUCCESSFUL), None)
        print(f"{label}: job {job.get('name')}" + (f", failed step {step.get('number')}: {step.get('name')}" if step else ""))
        log = gh(f"repos/{{owner}}/{{repo}}/actions/jobs/{job['id']}/logs", raw=True)
        if log is None:
            print("  (no log to read: GitHub gave none, perhaps because the job never started; see `factory ci status`)")
            continue
        print("\n".join(trim(log)))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
