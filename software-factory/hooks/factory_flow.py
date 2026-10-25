#!/usr/bin/env python3
"""`factory prd --stage` (#103): where a project is on the way from an idea to a first milestone, read from the project and
GitHub, and the owner's gates between the stages.

  factory prd --stage                 the stages, what is done, what the owner has approved, and the next step
  factory prd --stage --json          the same as JSON
  factory prd --stage --ask <stage>   ask the owner to approve a stage (vision, design or plan): one owner-queue
                                      comment, never posted twice

The stages: 1 vision (the PRD has stories with unique numbers), 2 design (the design folder has references), 3 plan (task
issues that name the stories, each with its "Done when"), 4 hand over (the three are approved and a task is ready for a
coding agent). Nothing is stored apart from the owner-queue comments: an approval is the owner's reply under the ask
`stage-<name>`, either `<!-- factory-owner-answer id=stage-<name> -->` or a first word of yes, approved, ok or go ahead.
Any other reply is a question or a no: the stage stays open and the product owner reads it. Read-only except `--ask`.
Errors are `{code, message, fix}` on stderr.
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402
import factory_prd  # noqa: E402
from factory_config import load, task_labels  # noqa: E402
from factory_machine import refuse  # noqa: E402

GATES = ("vision", "design", "plan")
YES = re.compile(r"^\W*(yes|approved?|ok|okay|go ahead)\b", re.I)
ASK = re.compile(r"<!--\s*factory-owner-ask\s+id=stage-([a-z]+)\b[^>]*-->")
ANSWER = re.compile(r"<!--\s*factory-owner-answer\s+id=stage-([a-z]+)\s*-->")
DONE_WHEN = re.compile(r"^#{1,6}\s*(acceptance criteria|done when)\b", re.I | re.M)


def design_dir(cfg):
    ref = (cfg.get("design") or {}).get("references") or ""
    return ref.split("/")[0] if ref else "design"


def has_files(folder):
    return os.path.isdir(folder) and any(f for _, _, fs in os.walk(folder) for f in fs)


def approvals(comments):
    """{stage: 'approved' | 'asked' | 'answered'} from the owner-queue comments, oldest first. A reply under a stage ask
    that says yes (or carries the answer marker) approves it; any other reply leaves it open as `answered`."""
    state, last = {}, None
    for c in comments:
        body = c.get("body") or ""
        a = ASK.search(body)
        if a:
            last = a.group(1)
            state[last] = "asked"
            continue
        m = ANSWER.search(body)
        if m and m.group(1) in state:
            state[m.group(1)] = "approved"
        elif last and state.get(last) in ("asked", "answered"):
            state[last] = "approved" if YES.match(re.sub(r"<!--.*?-->", "", body, flags=re.S)) else "answered"
    return state


def evidence(cfg, issues):
    """{stage: (done, line)} from the working tree and the task issues."""
    path = cfg.get("prd") or "docs/PRD.md"
    stories = [s for s in factory_prd.parse_stories(open(path, encoding="utf-8").read()) if s[1]] if os.path.isfile(path) else []
    numbers = [n for n, _, _ in stories]
    dup = sorted({n for n in numbers if numbers.count(n) > 1})
    vision = (bool(stories) and not dup,
              f"{path}: {len(set(numbers))} stories" + (f", US-{dup[0]} used twice" if dup else "") if stories
              else f"{path} has no stories with a title (`- US-1: <what the person can do>`)")
    folder = design_dir(cfg)
    design = (has_files(folder), f"{folder}/ has references" if has_files(folder) else f"{folder}/ is empty or missing")
    tasks = [i for i in issues if "pull_request" not in i and "factory:agent" not in fi.names(i)
             and i.get("state_reason") != "not_planned" and factory_prd.story_refs(i.get("body"))]
    thin = [i["number"] for i in tasks if not DONE_WHEN.search(i.get("body") or "")]
    served = {n for i in tasks for n in factory_prd.story_refs(i.get("body"))}
    bare = sorted(set(numbers) - served)
    ok = bool(tasks) and not thin
    line = f"{len(tasks)} tasks name a story"
    if thin:
        line += "; no `Done when` in " + ", ".join(f"#{n}" for n in thin)
    if tasks and bare:
        line += "; stories with no task: " + ", ".join(f"US-{n}" for n in bare)
    plan = (ok, line if tasks else "no task names a story (`PRD: US-<n>`; `factory issues new`)")
    return {"vision": vision, "design": design, "plan": plan}


def status(cfg, comments=None, issues=None):
    import factory_orchestrator as orch
    queue = orch.owner_queue(cfg, create=False)
    if comments is None:
        comments = fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{queue}/comments") if queue else []
    if issues is None:
        issues = fi.gh_all("repos/{owner}/{repo}/issues?state=all")
    ev, approved = evidence(cfg, issues), approvals(comments)
    rows = []
    for name in GATES:
        done, line = ev[name]
        rows.append({"stage": name, "done": done, "approval": approved.get(name, "not asked") if done else "not ready",
                     "line": line, "queue": queue})
    ready = [i for i in issues if task_labels(cfg)["ready"] in fi.names(i) and i.get("state") == "open"]
    go = all(r["approval"] == "approved" for r in rows)
    rows.append({"stage": "hand over", "done": go and bool(ready),
                 "approval": "-", "queue": queue,
                 "line": (f"{len(ready)} ready tasks: start `factory coding-agent loop`" if go and ready else
                          "waiting for the three approvals" if not go else "no task is ready")})
    return rows


def next_step(rows):
    for r in rows[:3]:
        if not r["done"]:
            return f"Next: finish the {r['stage']} ({r['line']})."
        if r["approval"] == "not asked":
            return f"Next: ask the owner: factory prd --stage --ask {r['stage']}"
        if r["approval"] in ("asked", "answered"):
            return f"Next: wait for the owner's yes on stage-{r['stage']}" + (" (a reply is there; read it)" if r["approval"] == "answered" else "")
    return "Next: start the coding agents." if rows[3]["done"] else "Next: add a ready task."


def render(rows):
    out = ["Flow stages (the owner approves each gate)", ""]
    for n, r in enumerate(rows, 1):
        word = "done" if r["done"] else "not yet"
        out.append(f"{n} {r['stage']:<10} {word:<8} {r['approval']:<10} {r['line']}")
    return "\n".join(out + ["", next_step(rows)])


def ask(cfg, stage, rows):
    if stage not in GATES:
        refuse("unknown-stage", f"'{stage}' is not a stage the owner approves.", f"Use one of {', '.join(GATES)}.")
    i = GATES.index(stage)
    row = rows[i]
    if not row["done"]:
        refuse("not-ready", f"The {stage} is not done: {row['line']}.", f"Finish it, then ask: factory prd --stage --ask {stage}")
    if i and rows[i - 1]["approval"] != "approved":
        refuse("earlier-gate", f"The {GATES[i - 1]} is not approved yet.", f"Wait for the owner's yes on stage-{GATES[i - 1]} first.")
    if row["approval"] != "not asked":
        print(f"stage-{stage}: already {row['approval']}; nothing posted.")
        return
    import factory_orchestrator as orch
    queue = orch.owner_queue(cfg, create=True)
    fi.comment(queue, f"<!-- factory-owner-ask id=stage-{stage} -->\nPlease approve the {stage}: {row['line']}.\n\n"
                      f"Reply `yes` to approve it, or say what to change; the product owner reads the reply.")
    print(f"stage-{stage}: asked in the owner queue (#{queue}).")


def main(argv=None):
    a = argv if argv is not None else sys.argv[1:]
    cfg = load()
    rows = status(cfg)
    if "--ask" in a:
        k = a.index("--ask")
        ask(cfg, a[k + 1] if k + 1 < len(a) else "", rows)
        return
    print(json.dumps(rows, indent=2) if "--json" in a else render(rows))


if __name__ == "__main__":
    main()
