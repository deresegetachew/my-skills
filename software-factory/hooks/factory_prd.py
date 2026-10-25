#!/usr/bin/env python3
"""`factory prd` (#101): progress against the PRD, as plain text, computed from GitHub. Nothing is written by hand.

Each user story in the PRD file (`prd` in factory.json) has an id, `US-<n>`, at the start of its heading or list item.
A task issue says which stories it serves with one line, `PRD: US-3, US-5` (the task template has it). This prints,
per story, its tasks and their state, then how much of the PRD is done and what has no task yet.

  factory prd [--open] [--story N] [--json]

  --open       hide the stories that are done
  --story N    one story, with its title and every task
  --json       the same data for scripts

A story is `done` when it has tasks and all are closed, `in progress` when one is in progress or in review (or some
are closed and some are not), `planned` when it has tasks and none has started, and `no task` when none names it.
A story number that two stories use is reported, because a task can't tell which one it means (fix the PRD first).
Read-only; the PRD is read from the working tree and the tasks through the GitHub REST API (`gh api`).
"""
import argparse, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402
from factory_config import load, task_labels  # noqa: E402

STORY = re.compile(r"^\s*(?:#{1,6}\s+|[-*]\s+|\|\s*)?\**US-(\d+)\b\**\s*[:.)|—–-]*\s*(.*?)\s*\|?\s*$")
PRD_LINE = re.compile(r"^[\s>*-]*\**PRD\b\**\s*:?\**\s*:?\s*(.*)$", re.I)
STORY_REF = re.compile(r"\bUS-(\d+)\b")
STATES = ("done", "in progress", "planned", "no task")


def parse_stories(text):
    """[(n, title, line)] for every line that starts a story, in file order (a number used twice appears twice)."""
    out = []
    for no, line in enumerate(text.splitlines(), 1):
        m = STORY.match(line)
        if m:
            out.append((int(m.group(1)), re.sub(r"[*_`]+", "", m.group(2)).strip(), no))
    return out


def story_refs(body):
    """The story numbers a task body names on its `PRD:` line(s)."""
    found = []
    for line in (body or "").splitlines():
        m = PRD_LINE.match(line)
        if m:
            found += [int(x) for x in STORY_REF.findall(m.group(1))]
    return sorted(set(found))


def task_state(cfg, issue):
    if issue.get("state") == "closed":
        return "done"
    have = fi.names(issue)
    labels = task_labels(cfg)
    for key, word in (("inReview", "in review"), ("inProgress", "in progress"), ("blocked", "blocked"), ("ready", "ready")):
        if labels[key] in have:
            return word
    return "open"


def story_state(tasks):
    if not tasks:
        return "no task"
    states = [t["state"] for t in tasks]
    if all(s == "done" for s in states):
        return "done"
    if any(s in ("in progress", "in review", "done") for s in states):
        return "in progress"
    return "planned"


def report(cfg, stories, issues):
    """The data `factory prd` prints: per story its tasks and state, the duplicates and the unknown references."""
    by_story = {}
    for i in issues:
        if "pull_request" in i or "factory:agent" in fi.names(i) or i.get("state_reason") == "not_planned":
            continue  # a PR, an agent's issue, or a task closed as not planned counts for nothing
        for n in story_refs(i.get("body")):
            by_story.setdefault(n, []).append({"number": i["number"], "title": i.get("title", ""),
                                               "state": task_state(cfg, i)})
    seen, dup, rows = {}, {}, []
    for n, title, line in stories:
        if n in seen:
            dup.setdefault(n, [seen[n]]).append(line)
            continue
        seen[n] = line
        tasks = sorted(by_story.get(n, []), key=lambda t: t["number"])
        rows.append({"story": n, "title": title, "line": line, "state": story_state(tasks), "tasks": tasks})
    counts = {s: sum(1 for r in rows if r["state"] == s) for s in STATES}
    every = [t for r in rows for t in r["tasks"]]
    unknown = {n: ts for n, ts in by_story.items() if n not in seen}
    return {"stories": rows, "counts": counts, "total": len(rows), "duplicates": dup,
            "tasks": {"total": len(every), "done": sum(1 for t in every if t["state"] == "done")},
            "unknown": {n: [t["number"] for t in ts] for n, ts in sorted(unknown.items())}}


def render(data, prd_path, only_open=False, story=None):
    out = []
    rows = [r for r in data["stories"] if (story is None or r["story"] == story) and not (only_open and r["state"] == "done")]
    for r in rows:
        mark = f"{sum(1 for t in r['tasks'] if t['state'] == 'done')}/{len(r['tasks'])}" if r["tasks"] else "-"
        head = f"US-{r['story']:<3} {r['state']:<12} {mark:<5} {r['title'][:70]}"
        out.append(head.rstrip())
        if r["tasks"] and (story is not None or r["state"] != "done"):
            out.append("        " + ", ".join(f"#{t['number']} {t['state']}" for t in r["tasks"]))
    if story is not None and not rows:
        return f"factory prd: {prd_path} has no story US-{story}."
    if story is None:
        c, t = data["counts"], data["tasks"]
        head = (f"{prd_path}: {data['total']} stories: {c['done']} done, {c['in progress']} in progress, "
                f"{c['planned']} planned, {c['no task']} with no task. Tasks: {t['done']} of {t['total']} done.")
        out = [head, ""] + out
        for n, lines in sorted(data["duplicates"].items()):
            out.append(f"\nUS-{n} is used by {len(lines)} stories (lines {', '.join(map(str, lines))}). A task can't say "
                       "which one it serves: renumber the PRD first.")
        for n, nums in data["unknown"].items():
            out.append(f"\nTasks {', '.join('#' + str(x) for x in nums)} name US-{n}, which the PRD does not have.")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Progress against the PRD, from GitHub. Read-only.")
    ap.add_argument("--open", action="store_true", help="hide stories that are done")
    ap.add_argument("--story", type=int, help="one story, with its tasks")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    cfg = load()
    path = cfg.get("prd") or "docs/PRD.md"
    if not os.path.isfile(path):
        sys.exit(f"factory prd: {path} does not exist. Set `prd` in .claude/factory.json to the PRD file.")
    stories = parse_stories(open(path, encoding="utf-8").read())
    if not stories:
        sys.exit(f"factory prd: {path} has no story ids. Start each user story's heading or list item with `US-<n>` "
                 "(for example `- US-3: Upload a manual`), then tasks can say `PRD: US-3`.")
    data = report(cfg, stories, fi.gh_all("repos/{owner}/{repo}/issues?state=all"))
    print(json.dumps(data, indent=2) if a.json else render(data, path, a.open, a.story))


if __name__ == "__main__":
    main()
