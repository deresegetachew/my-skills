#!/usr/bin/env python3
"""`factory usage`: how many tokens the factory's sessions used, per task, from Claude Code's own session logs on
this machine. Use it to measure a change to the factory (a cheaper model, less reading) before and after.

  factory usage                       the last 7 days, per task, then the totals
  factory usage --since 2026-10-20 --until 2026-10-24
  factory usage --by agent            per subagent type (reviewer, test-writer, ...) instead of per task
  factory usage --by role             manager (sessions that start with /manage-pass, or end with a `factory-role` line naming
                                      the dev manager), product-owner (that line names it) against builder (all others)
  factory usage --json                the same as JSON
  factory usage --task 96 --markdown  one task's tokens per subagent, as a PR comment (the next-task skill posts it)
  factory usage --record "label"      also append a dated summary row to the usage log (`usageLog` in
                                      factory.json, default docs/factory-usage.md), to commit in a PR

Reads ~/.claude/projects/<this project's folders>/*.jsonl (the main sessions, including each agent worktree) and
their subagents/*.jsonl. Each model reply is counted once (by message id). A session belongs to the task whose
branch (`task/<n>-...`) it spent most replies on. Nothing leaves the machine; the log row holds only totals.

Tokens are reported as Claude reports them: input (not cached), cache writes, cache reads, output. "Fresh input"
is input + cache writes: what had to be read without a cache hit. Prices differ per model, so use `/usage` or the
console for money; this command is for comparing like with like.
"""
import argparse, collections, datetime as dt, glob, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402

TASK = re.compile(r"^task/(\d+(?:[.-]\d+)*?)-")
FIELDS = ("input", "cache_write", "cache_read", "output")


def project_dirs(root, base):
    """Claude Code keeps a project's logs in ~/.claude/projects/<its path with / and . as ->. Agent worktrees live
    in <root>-agents/<name>, so their folders start with the same prefix."""
    slug = re.sub(r"[^A-Za-z0-9]", "-", root)
    return [d for d in glob.glob(os.path.join(base, glob.escape(slug) + "*")) if os.path.isdir(d)]


def replies(path):
    """(message id, timestamp, branch, model, usage, cwd) for each assistant reply in one log file."""
    try:
        f = open(path, encoding="utf-8")
    except OSError:
        return
    with f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "assistant":
                continue
            m = d.get("message") or {}
            u = m.get("usage") or {}
            if not u:
                continue
            yield (m.get("id") or d.get("uuid"), d.get("timestamp") or "", d.get("gitBranch") or "",
                   m.get("model") or "?", u, d.get("cwd") or "")


MANAGER_PASS = re.compile(r"/?manage-pass\b")
# The role loops end their prompt with `<!-- factory-role role=... name=... -->` (#102). It names the role exactly, so a
# product owner's session is not counted as a builder's.
ROLE = re.compile(r"<!--\s*factory-role\s+role=([\w-]+)")
ROLE_LABEL = {"coding-agent": "builder", "dev-manager": "manager", "product-owner": "product-owner"}


def session_role(path):
    """'manager' when the session's first prompt is the dev manager's `/manage-pass` (how `factory manage-tick` and the
    manager loop start it), else 'builder': every other session on this project, builders and people alike."""
    try:
        f = open(path, encoding="utf-8")
    except OSError:
        return "builder"
    with f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "user":
                continue
            c = (d.get("message") or {}).get("content")
            if isinstance(c, list):
                c = " ".join(b.get("text", "") for b in c if isinstance(b, dict))
            marked = ROLE.search(c) if isinstance(c, str) else None
            if marked:
                return ROLE_LABEL.get(marked.group(1), marked.group(1))
            return "manager" if isinstance(c, str) and MANAGER_PASS.match(re.sub(r"^\s*<command-(?:message|name)>\s*", "", c)) else "builder"
    return "builder"


def tokens(u):
    return {"input": int(u.get("input_tokens") or 0), "cache_write": int(u.get("cache_creation_input_tokens") or 0),
            "cache_read": int(u.get("cache_read_input_tokens") or 0), "output": int(u.get("output_tokens") or 0)}


def when(ts):
    try:
        return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def collect(root, base, since, until):
    """{session: {"task": str, "rows": [(kind, model, tokens)]}} for replies between since and until."""
    seen, sessions = set(), collections.defaultdict(lambda: {"branches": collections.Counter(), "rows": [], "role": "builder"})
    for d in project_dirs(root, base):
        for main in glob.glob(os.path.join(d, "*.jsonl")):
            sid = os.path.basename(main)[:-6]
            role = session_role(main)
            files = [(main, "main")]
            for sub in glob.glob(os.path.join(d, sid, "subagents", "*.jsonl")):
                kind = "subagent"
                try:
                    kind = json.load(open(sub[:-6] + ".meta.json")).get("agentType") or kind
                except (OSError, ValueError):
                    pass
                files.append((sub, kind))
            for path, kind in files:
                for mid, ts, branch, model, u, cwd in replies(path):
                    t = when(ts)
                    if mid in seen or t is None or t < since or t >= until:
                        continue
                    if cwd and not (cwd == root or cwd.startswith(root + os.sep) or cwd.startswith(root + "-agents")):
                        continue
                    seen.add(mid)
                    s = sessions[sid]
                    s["role"] = role
                    m = TASK.match(branch)
                    if m and kind == "main":
                        s["branches"][m.group(1).replace("-", ".")] += 1
                    s["rows"].append((kind, model, tokens(u)))
    out = {}
    for sid, s in sessions.items():
        task = s["branches"].most_common(1)[0][0] if s["branches"] else "-"
        out[sid] = {"task": task, "rows": s["rows"], "role": s["role"]}
    return out


def add(a, b):
    for k in FIELDS:
        a[k] += b[k]


def zero():
    return dict.fromkeys(FIELDS, 0)


def summarise(sessions, by):
    groups = collections.defaultdict(lambda: {"tokens": zero(), "replies": 0, "sessions": set()})
    total = {"tokens": zero(), "replies": 0, "tasks": set(), "models": collections.Counter()}
    for sid, s in sessions.items():
        for kind, model, t in s["rows"]:
            key = {"task": s["task"], "agent": kind, "role": s.get("role", "builder")}.get(by, model)
            g = groups[key]
            add(g["tokens"], t)
            g["replies"] += 1
            g["sessions"].add(sid)
            add(total["tokens"], t)
            total["replies"] += 1
            total["models"][model] += t["input"] + t["cache_write"] + t["cache_read"] + t["output"]
        if s["task"] != "-":
            total["tasks"].add(s["task"])
    return groups, total


def fresh(t):
    return t["input"] + t["cache_write"]


def hit(t):
    read = t["input"] + t["cache_write"] + t["cache_read"]
    return (t["cache_read"] / read * 100) if read else 0.0


def k(n):
    return f"{n / 1000:,.0f}k" if n >= 1000 else str(n)


def markdown(task, groups, total, since, until):
    """A PR comment: this task's tokens per subagent type, from this machine's logs up to now."""
    t = total["tokens"]
    lines = [f"<!-- factory-usage task={task} -->",
             f"**Tokens for task {task}** so far, from this machine's Claude Code logs ({since:%Y-%m-%d} to now). "
             "Fresh input is input that missed the cache.", "",
             "| Agent | Replies | Fresh input | Cache reads | Output | Cache hit |", "|---|---|---|---|---|---|"]
    for key, g in sorted(groups.items(), key=lambda kv: -fresh(kv[1]["tokens"]) - kv[1]["tokens"]["cache_read"]):
        x = g["tokens"]
        lines.append(f"| {key} | {g['replies']} | {k(fresh(x))} | {k(x['cache_read'])} | {k(x['output'])} | "
                     f"{hit(x):.0f}% |")
    lines.append(f"| **All** | {total['replies']} | {k(fresh(t))} | {k(t['cache_read'])} | {k(t['output'])} | "
                 f"{hit(t):.0f}% |")
    if total["models"]:
        lines += ["", "By model: " + ", ".join(f"{m} {k(v)}" for m, v in total["models"].most_common()) + "."]
    if not total["replies"]:
        lines += ["", "No replies found for this task on this machine (another machine may have built it)."]
    return "\n".join(lines)


def report(groups, total, by, since, until):
    print(f"Token use {since:%Y-%m-%d} to {until:%Y-%m-%d} (from this machine's Claude Code logs), per {by}.\n")
    print(f"{by:14} {'replies':>8} {'fresh in':>10} {'cache read':>11} {'output':>9} {'cache hit':>10}")
    for key, g in sorted(groups.items(), key=lambda kv: -fresh(kv[1]["tokens"]) - kv[1]["tokens"]["cache_read"]):
        t = g["tokens"]
        print(f"{str(key)[:14]:14} {g['replies']:>8} {k(fresh(t)):>10} {k(t['cache_read']):>11} {k(t['output']):>9} "
              f"{hit(t):>9.0f}%")
    t = total["tokens"]
    n = len(total["tasks"])
    print(f"\nAll: {total['replies']} replies, fresh input {k(fresh(t))}, cache reads {k(t['cache_read'])}, output "
          f"{k(t['output'])}, cache hit {hit(t):.0f}%.")
    if n:
        print(f"Per task ({n} tasks): fresh input {k(fresh(t) // n)}, cache reads {k(t['cache_read'] // n)}, "
              f"output {k(t['output'] // n)}.")
    if total["models"]:
        print("By model (all tokens): " + ", ".join(f"{m} {k(v)}" for m, v in total["models"].most_common()))


def record(path, label, total, since, until):
    t, n = total["tokens"], max(len(total["tasks"]), 1)
    new = not os.path.exists(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        if new:
            f.write("# Factory token use\n\nOne row per measurement (`factory usage --record \"label\"`), from one "
                    "machine's Claude Code logs. Compare rows for the same kind of work: tokens per task matter more "
                    "than totals. \"Fresh input\" is input that missed the cache.\n\n"
                    "| Measured | Period | Label | Tasks | Fresh input per task | Cache reads per task | "
                    "Output per task | Cache hit |\n|---|---|---|---|---|---|---|---|\n")
        f.write(f"| {dt.date.today():%Y-%m-%d} | {since:%Y-%m-%d} to {until:%Y-%m-%d} | {label} | "
                f"{len(total['tasks'])} | {k(fresh(t) // n)} | {k(t['cache_read'] // n)} | {k(t['output'] // n)} | "
                f"{hit(t):.0f}% |\n")
    print(f"\nRecorded in {path}. Commit it in a pull request to keep the history.")


def day(s):
    return dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc)


def main(argv):
    p = argparse.ArgumentParser(prog="factory usage", description="Token use per task, from this machine's logs.")
    p.add_argument("--since", type=day, help="first day (YYYY-MM-DD, UTC); default 7 days ago")
    p.add_argument("--until", type=day, help="day after the last (YYYY-MM-DD, UTC); default tomorrow")
    p.add_argument("--by", choices=("task", "agent", "model", "role"), default="task")
    p.add_argument("--json", action="store_true")
    p.add_argument("--record", metavar="LABEL", help="append a summary row to the usage log")
    p.add_argument("--task", help="only the sessions of this task (its id or issue number)")
    p.add_argument("--markdown", action="store_true", help="print a PR comment (use with --task)")
    p.add_argument("--logs", default=os.path.join(os.path.expanduser("~"), ".claude", "projects"),
                   help=argparse.SUPPRESS)
    a = p.parse_args(argv)
    today = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    until = a.until or today + dt.timedelta(days=1)
    since = a.since or until - dt.timedelta(days=8)
    cfg = load()
    root = os.getcwd()
    sessions = collect(root, a.logs, since, until)
    if a.task:
        task = a.task.lstrip("#").replace("-", ".")
        sessions = {sid: s for sid, s in sessions.items() if s["task"] == task}
    groups, total = summarise(sessions, "agent" if a.markdown else a.by)
    if a.markdown:
        print(markdown(a.task.lstrip("#") if a.task else "-", groups, total, since, until))
    elif a.json:
        print(json.dumps({"since": since.isoformat(), "until": until.isoformat(), "by": a.by,
                          "groups": {str(key): {"tokens": g["tokens"], "replies": g["replies"]}
                                     for key, g in groups.items()},
                          "total": {"tokens": total["tokens"], "replies": total["replies"],
                                    "tasks": sorted(total["tasks"])}}, indent=2))
    else:
        report(groups, total, a.by, since, until)
    if a.record:
        record(cfg.get("usageLog") or "docs/factory-usage.md", a.record.replace("|", "/"), total, since, until)


if __name__ == "__main__":
    main(sys.argv[1:])
