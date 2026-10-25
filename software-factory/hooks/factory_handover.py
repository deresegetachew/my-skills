#!/usr/bin/env python3
"""`factory handover snapshot` (#100): the state a manager hands over, read from GitHub on the day, as plain text.

The runbook (docs/manager-handover.md) starts by moving a long-running manager's notes out of its session. A snapshot made
by hand goes stale; this prints the same facts from GitHub so nothing important stays only in a tick message:

  factory handover snapshot        print it (markdown); post it as a comment on the owner queue, or paste it into
                                   `<roles.dir>/dev-manager/README.md` where it is a stable fact
  factory handover snapshot --json the same as JSON

It lists: open pull requests (with who opened them), tasks in progress, blocked and ready, the open owner-queue asks and
the open questions, the agents (role, state, machine), what needs a manager right now (`factory precheck`), and the numbers
in use in the numbered folders (decisions, migrations) on main and in open PRs. It only reads.
"""
import json, os, subprocess, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402
from factory_config import load, task_labels  # noqa: E402


def first_line(text):
    import re
    for line in re.sub(r"<!--.*?-->", "", text or "", flags=re.S).splitlines():
        if line.strip():
            return line.strip()[:100]
    return ""


def numbers_in_use(cfg):
    """{folder: highest number on main} for the numbered folders, from git (origin/<main>)."""
    import factory_numbers as fn
    out = {}
    for folder in fn.folders(cfg):
        p = subprocess.run(["git", "ls-tree", "--name-only", f"origin/{cfg['mainBranch']}:{folder}"],
                           capture_output=True, text=True)
        nums = [fn.number(n)[0] for n in p.stdout.splitlines() if fn.number(n)] if p.returncode == 0 else []
        out[folder] = max(nums) if nums else None
    return out


def snapshot(cfg):
    import factory_orchestrator as orch, factory_prs, factory_wait
    prs = fi.gh_all("repos/{owner}/{repo}/pulls?state=open")
    labels = task_labels(cfg)
    tasks = {}
    for key in ("inProgress", "blocked", "ready"):
        tasks[key] = [{"number": i["number"], "title": i["title"]} for i in fi.task_issues(label=labels[key])]
    queue = orch.owner_queue(cfg, create=False)
    asks = []
    if queue:
        for slug, c in factory_prs.open_owner_asks(fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{queue}/comments")):
            asks.append({"id": slug, "line": first_line(c.get("body"))})
    agents = []
    if (cfg.get("tasks") or {}).get("source") == "issues":
        import factory_cards
        agents = factory_cards.cards(cfg, __import__("factory_agents").agent_issues())
    return {
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "pullRequests": [{"number": p["number"], "title": p["title"], "by": (p.get("user") or {}).get("login", ""),
                          "head": p["head"]["sha"][:7], "draft": bool(p.get("draft"))} for p in prs],
        "tasks": tasks, "ownerQueue": queue, "ownerAsks": asks,
        "agents": [{"name": a["name"], "role": a.get("role", a["kind"]), "state": a["state"], "machine": a["machine"]} for a in agents],
        "needsAManager": factory_wait.precheck(cfg),
        "numbers": numbers_in_use(cfg),
    }


def render(s):
    out = [f"## Manager handover snapshot ({s['at']})", "",
           "Made from GitHub on the day; the labels, markers and comments are the truth, this is a reading of them.", ""]
    out.append(f"**Open pull requests ({len(s['pullRequests'])})**")
    out += [f"- #{p['number']} {p['title']} (by {p['by']}, head {p['head']}{', draft' if p['draft'] else ''})" for p in s["pullRequests"]] or ["- none"]
    for key, title in (("inProgress", "Tasks in progress"), ("blocked", "Tasks blocked"), ("ready", "Tasks ready")):
        out += ["", f"**{title} ({len(s['tasks'][key])})**"]
        out += [f"- #{t['number']} {t['title']}" for t in s["tasks"][key]] or ["- none"]
    out += ["", f"**Open owner-queue asks ({len(s['ownerAsks'])})**" + (f", issue #{s['ownerQueue']}" if s["ownerQueue"] else ", no queue issue yet")]
    out += [f"- `{a['id']}`: {a['line']}" for a in s["ownerAsks"]] or ["- none"]
    out += ["", f"**Needs a manager right now ({len(s['needsAManager'])})**"]
    out += [f"- {line}" for line in s["needsAManager"]] or ["- nothing"]
    out += ["", f"**Agents ({len(s['agents'])})**"]
    out += [f"- {a['name']}: {a['role']}, {a['state']}" + (f", machine {a['machine']}" if a["machine"] else "") for a in s["agents"]] or ["- none registered on GitHub"]
    out += ["", "**Numbers in use on main** (the next free one is one more; check open PRs too)"]
    out += [f"- {folder}: {n if n is not None else 'none yet'}" for folder, n in s["numbers"].items()]
    return "\n".join(out)


def main(argv=None):
    a = argv if argv is not None else sys.argv[1:]
    if not a or a[0] != "snapshot":
        sys.exit(__doc__)
    s = snapshot(load())
    print(json.dumps(s, indent=2) if "--json" in a else render(s))


if __name__ == "__main__":
    main()
