#!/usr/bin/env python3
"""Product questions (#110): a question addressed `to=po` waits for the product owner, and moves up a level when nobody
answers: product owner, then dev manager, then the owner. It only reads.

A coding agent posts a question on its task issue (or PR) with `to=po` for a product question ("what should this screen do
when X?", "which of these two behaviours is right?"), `to=dev-manager` (the default) for a technical or process one. It keeps
working on other things while it waits. The levels:

  po           the first `roles.product-owner.escalateMinutes` (120) after the question, when a product owner is running
  dev-manager  the next `escalateMinutes`, or from the start when no product owner is running: the dev manager answers it
               or escalates it (the fallback)
  owner        after that: the dev manager's watcher reports it to the owner queue

A product owner is running when its agent issue is not down or silent. State-based and idempotent: nothing is stored,
the level is worked out from the question's age each time, so a missed wake-up finds it later.

  factory_po.py [--json]      the open `to=po` questions with their level and age (like `factory messages ls --to po`, plus
                              the level); exit 0
"""
import json, os, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402
import factory_messages as fm  # noqa: E402
from factory_config import load, role_setting  # noqa: E402

PO = "po"
LEVELS = ("po", "dev-manager", "owner")


def escalate_minutes(cfg):
    return float(role_setting(cfg, "product-owner", "escalateMinutes", 120))


def running(cfg, issues=None):
    """Whether a product owner is running: an agent issue of the product-owner role that is not down or silent."""
    if (cfg.get("tasks") or {}).get("source") != "issues":
        return False  # agents are not tracked on GitHub: nobody can say a product owner runs, so the fallback applies
    import factory_agents
    for issue in factory_agents.current(factory_agents.agent_issues() if issues is None else issues):
        if factory_agents.role_of(issue) != "product-owner":
            continue
        st = factory_agents.state_of(cfg, issue)
        if st and st[1] not in ("down", "silent"):
            return True
    return False


def level(age_minutes, every, po_running):
    """po, dev-manager or owner for a `to=po` question of that age."""
    step = int(max(age_minutes, 0) // every) if every > 0 else 0
    return LEVELS[min((0 if po_running else 1) + step, 2)]


def minutes_since(text, now):
    try:
        t = datetime.fromisoformat((text or "").replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    return max((now - t).total_seconds() / 60, 0.0)


def waiting(thread, every, alive, now):
    """[(task, level, age in minutes)] for the open `to=po` questions of a folded thread. A question that asks the asker
    for more information (input-required) waits for the asker, not for the product owner, so it is left out."""
    out = []
    for t in fm.select(thread.tasks.values(), to=PO):
        if t.state in ("submitted", "working"):
            age = minutes_since(t.question.created, now)
            out.append((t, level(age, every, alive), age))
    return out


def questions(cfg, comments_of=None, items=None, now=None, po_running=None):
    """Open questions addressed to `po` on the open issues and PRs: [{id, number, what, level, age, summary, frm, since}],
    oldest first. `items` and `comments_of` let a caller share what it has read; `po_running` says whether to assume a
    product owner runs (the product owner's own pass passes True: it is the one asking)."""
    now = now or datetime.now(timezone.utc)
    every = escalate_minutes(cfg)
    alive = running(cfg) if po_running is None else po_running
    if items is None:
        items = [i for i in fi.gh_all("repos/{owner}/{repo}/issues?state=open") if "factory:agent" not in fi.names(i)]
    comments_of = comments_of or (lambda n: fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments"))
    out = []
    for item in items:
        n = item["number"]
        if not item.get("comments", 1):
            continue
        what = "PR" if item.get("pull_request") else "issue"
        thread = fm.fold(fm.messages_of(comments_of(n), f"{'pr' if what == 'PR' else 'issue'}#{n}"))
        for t, lvl, age in waiting(thread, every, alive, now):
            out.append({"id": t.id, "number": n, "what": what, "level": lvl, "age": age,
                        "summary": t.question.summary, "frm": t.frm or "an agent", "since": t.question.created})
    return sorted(out, key=lambda q: -q["age"])


def main(argv=None):
    cfg = load()
    rows = questions(cfg)
    if "--json" in (argv if argv is not None else sys.argv[1:]):
        print(json.dumps(rows, indent=2))
    else:
        print("\n".join(f"{q['id']:<14} {q['level']:<12} {q['what']} #{q['number']}  {q['age'] / 60:.1f} h  "
                        f"{q['frm']}: {q['summary']}" for q in rows) or "no product questions waiting")


if __name__ == "__main__":
    main()
