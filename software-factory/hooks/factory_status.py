#!/usr/bin/env python3
"""`factory status`: one read-only view of the whole factory, across machines (#64).

  Agents     every agent on every machine (issues mode: their agent issues): working, idle, silent or down
  Here       this machine's claims (which local agent holds which folder and task)
  PRs        open pull requests: draft, CI, the reviewer's pass for the head (when the marker is on this machine),
             the dev manager's hold, must-fix or approval, which dev manager has claimed the head for review
             (a lease, #99), and "a person merges this one"
  CI         runs queued and the oldest one's age, and the self-hosted runners (when GitHub lets us see them)
  Tasks      issues mode: ready (by milestone), in progress, in review, blocked; plan mode: the next task

Everything comes from `gh api` (GitHub's REST API), git and local files. It changes nothing on GitHub or in the
working tree; in plan mode `next_task.py` runs a `git fetch` to see main's plan. A section
GitHub can't answer says so and the rest still shows.

  python3 .claude/hooks/factory_status.py [--json]
"""
import argparse, json, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load, load_from_main, task_labels, task_source  # noqa: E402
import factory_manager_claims as claims  # noqa: E402
from factory_prs import ci_state as judged_ci, claim_of, gate_word, section  # noqa: E402

HOOKS = os.path.dirname(os.path.abspath(__file__))


def gh(path):
    p = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip()[:200] or "gh api failed")
    return json.loads(p.stdout) if p.stdout.strip() else None


def ago(stamp, now):
    if not stamp:
        return ""
    t = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    m = int((now - t).total_seconds() // 60)
    return f"{m} min" if m < 120 else f"{m // 60} h"


def agents(cfg):
    if task_source(cfg) != "issues":
        return {"note": "agents report on GitHub in issues mode only (tasks.source \"issues\")"}
    import factory_agents
    rows = [factory_agents.state_of(cfg, i) for i in factory_agents.current(factory_agents.agent_issues())]
    return {"agents": [{"name": n, "status": s, "lastPing": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "minutesAgo": round(q)} for n, s, t, q in sorted(r for r in rows if r)]}


def last_line(p, what):
    text = (p.stderr or p.stdout or "").strip().splitlines()
    return text[-1] if text else f"{what} exited {p.returncode}"


def here():
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_claims.py"), "list"], capture_output=True,
                       text=True)
    if p.returncode != 0:
        raise RuntimeError(last_line(p, "factory_claims.py"))
    return {"claims": [l for l in p.stdout.splitlines() if l.strip()]}


def marker(cfg, branch, sha, kind):
    path = os.path.join(cfg["reviewMarkers"], branch.replace("/", "_") + kind)
    try:
        with open(path) as f:
            return f.read().strip() == sha
    except OSError:
        return None  # not on this machine


def ci_state(sha):
    """The CI rule of `factory prs` (factory_prs.py), in the words this view has always used."""
    state = judged_ci(sha)[0]
    return {"red": "failed"}.get(state, state)


def pulls(cfg):
    # Main's settings, as the gate reads them: an agent can't widen trustedReviewers in its own copy.
    try:
        gate_cfg = load_from_main(cfg)
    except RuntimeError:
        gate_cfg = cfg
    trusted = set(gate_cfg.get("trustedReviewers") or [])
    hold = gate_cfg.get("holdLabel", "factory-hold")

    def one(p):
        sha, branch = p["head"]["sha"], p["head"]["ref"]
        labels = {x["name"] for x in p.get("labels", [])}
        comments = gh(f"repos/{{owner}}/{{repo}}/issues/{p['number']}/comments?per_page=100") or []
        dm = gate_word(comments, sha, trusted)
        held, _ = claim_of(comments, sha, claims.now_utc())
        return {"number": p["number"], "title": p["title"], "branch": branch, "draft": bool(p.get("draft")),
                "ci": ci_state(sha), "reviewed": marker(cfg, branch, sha, ".ok"), "hold": hold in labels,
                "devManager": dm,
                "claim": {"manager": held["manager"], "until": held["until"]} if held else None,
                "personMerges": "a person merges this one" in (p.get("body") or "").lower()}

    with ThreadPoolExecutor(8) as pool:  # two calls per PR: side by side, so it stays quick
        return {"pulls": list(pool.map(one, gh("repos/{owner}/{repo}/pulls?state=open&per_page=100") or []))}


def ci(now):
    runs = (gh("repos/{owner}/{repo}/actions/runs?status=queued&per_page=100") or {}).get("workflow_runs", [])
    oldest = min((r["created_at"] for r in runs), default=None)
    out = {"queued": len(runs), "oldestQueued": ago(oldest, now) if oldest else None}
    try:
        rs = (gh("repos/{owner}/{repo}/actions/runners?per_page=100") or {}).get("runners", [])
        out["runners"] = [{"name": r["name"], "status": r.get("status"), "busy": bool(r.get("busy"))} for r in rs]
    except RuntimeError:
        out["runners"] = None  # listing runners needs admin on the repository
    return out


def tasks(cfg):
    if task_source(cfg) != "issues":
        p = subprocess.run([sys.executable, os.path.join(HOOKS, "next_task.py")], capture_output=True, text=True)
        out = p.stdout.strip()
        if p.returncode == 0 and out:
            return {"next": out}
        if p.returncode == 1 and out == "none":
            return {"next": "nothing ready"}
        raise RuntimeError(last_line(p, "next_task.py"))
    from factory_issues import names, task_issues
    L = task_labels(cfg)
    counts, ready = {"inProgress": 0, "inReview": 0, "blocked": 0}, {}
    for i in task_issues():
        n = names(i)
        if L["blocked"] in n:
            counts["blocked"] += 1
        elif L["inReview"] in n:
            counts["inReview"] += 1
        elif L["inProgress"] in n:
            counts["inProgress"] += 1
        elif L["ready"] in n:
            m = (i.get("milestone") or {}).get("title") or "no milestone"
            ready[m] = ready.get(m, 0) + 1
    return {"ready": ready, **counts}


def show(s, task_mode="plan"):
    def err(part):
        return f"  can't read it: {part['error']}" if "error" in part else None

    print("Agents (all machines)")
    a = s["agents"]
    print(err(a) or ("  " + a["note"] if "note" in a else "\n".join(
        f"  {x['name']:<12} {x['status']:<8} last ping {x['minutesAgo']} min ago" for x in a["agents"])
        or "  none registered"))
    print("This machine")
    h = s["here"]
    print(f"  claims: can't read them: {h['error']}" if "error" in h else
          "\n".join("  " + l for l in h.get("claims", [])) or "  no claims")
    print("Pull requests")
    p = s["pulls"]
    if "error" in p:
        print(err(p))
    for x in p.get("pulls", []):
        flags = ["draft"] if x["draft"] else []
        flags.append(f"CI {x['ci']}")
        if x["reviewed"] is not None:
            flags.append("reviewed" if x["reviewed"] else "not reviewed")
        if x.get("claim"):
            flags.append(f"claimed by {x['claim']['manager']} until {x['claim']['until'][11:16]} UTC")
        flags += [f for f, on in (("hold", x["hold"]), (x["devManager"], x["devManager"]),
                                  ("a person merges it", x["personMerges"])) if on]
        print(f"  #{x['number']:<5} {x['branch'][:40]:<40} {', '.join(flags)}")
    if "error" not in p and not p.get("pulls"):
        print("  none open")
    print("CI")
    c = s["ci"]
    if "error" in c:
        print(err(c))
    else:
        print(f"  {c['queued']} queued" + (f", the oldest for {c['oldestQueued']}" if c["oldestQueued"] else ""))
        if c["runners"] is None:
            print("  runners: can't be listed (it needs admin on the repository)")
        elif c["runners"]:
            print("  runners: " + ", ".join(f"{r['name']} {r['status']}{' busy' if r['busy'] else ''}"
                                             for r in c["runners"]))
    print("Tasks")
    t = s["tasks"]
    if "error" in t and task_mode != "issues":
        print(f"  next task: can't read it: {t['error']}")
    elif "error" in t:
        print(err(t))
    elif "next" in t:
        print(f"  next: {t['next']}")
    else:
        ready = ", ".join(f"{n} in {m}" for m, n in t["ready"].items()) or "none"
        print(f"  ready: {ready}")
        print(f"  in progress {t['inProgress']}, in review {t['inReview']}, blocked {t['blocked']}")


def main():
    ap = argparse.ArgumentParser(description="One read-only view of the factory across machines.")
    ap.add_argument("--json", action="store_true", help="the same, as JSON for scripts")
    a = ap.parse_args()
    cfg = load()
    now = datetime.now(timezone.utc)
    parts = {"agents": (agents, cfg), "here": (here,), "pulls": (pulls, cfg), "ci": (ci, now), "tasks": (tasks, cfg)}
    with ThreadPoolExecutor(len(parts)) as pool:  # each section asks GitHub on its own
        futures = {k: pool.submit(section, *v) for k, v in parts.items()}
        s = {k: f.result() for k, f in futures.items()}
    if a.json:
        print(json.dumps(s, indent=2))
    else:
        show(s, task_source(cfg))
    return 0


if __name__ == "__main__":
    sys.exit(main())
