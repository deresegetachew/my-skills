#!/usr/bin/env python3
"""The curated lessons file (#72): a short list of one-line rules the builder and the reviewers read first, so the
same must-fix, review finding or CI failure does not come back task after task.

  factory lessons show               the lessons, one per line (what the builder and the reviewers read)
  factory lessons check              the file is within the cap and each lesson is one line with an example or a link
  factory lessons suggest [--last N] [--min K] [--json]
                                     candidates from the last N task pull requests (default 20): must-fix comments and
                                     CI failures that came back on at least K of them (default 2), plus this machine's
                                     reviewer findings; read-only, and it skips what a lesson already says
  factory lessons add "<rule>"       append one lesson (dev manager)
  factory lessons prune [--apply]    lessons a hook, lint rule or check enforces now (dev manager); --apply removes them

The file is `lessons` in .claude/factory.json (default .claude/factory/lessons.md), at most `lessonsCap` lessons
(default 40). A lesson is one line that starts with "- " and holds an example or a link: a `code span`, a URL, an
issue or PR number such as #123, or "e.g.". When a tool now enforces a lesson, say where with a tag at the end,
`[enforced: path/to/check]`; `prune` then proposes removing it. Agents cannot edit `.claude/`: `add` and `prune` refuse
inside an agent session, so the dev manager approves every change. Reads only through `gh api`.
"""
import argparse, json, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import branch_task, load  # noqa: E402

MAX_LINE = 240
HEADER = """# Lessons

Short rules the builder and the reviewers read before they start. One line each, at most `lessonsCap` lines (40).
Each one has an example or a link. When a hook, lint rule or check enforces a rule now, tag it
`[enforced: path/to/check]` and `factory lessons prune` proposes dropping it. The dev manager changes this file:
`factory lessons suggest` proposes lessons, `factory lessons add "<rule>"` adds one.

"""
EXAMPLE = re.compile(r"`[^`]+`|https?://\S+|#\d+|\be\.g\.")
ENFORCED = re.compile(r"\s*\[enforced:\s*([^\]]+?)\s*\]")
MUSTFIX = re.compile(r"<!--\s*factory-mustfix\b[^>]*-->")
ITEM = re.compile(r"^\s*(?:[-*]|\d+[.)])\s+(.*\S)")
STOP = set("the and for with that this are was not but from has have its into than then when what use must fix need "
           "needs should would could add too also any all one out can".split())


def agent_session():
    return any(os.environ.get(v) for v in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"))


def fail(msg):
    print(f"factory lessons: {msg}", file=sys.stderr)
    return 1


def settings(cfg):
    try:
        cap = int(cfg.get("lessonsCap", 40))
    except (TypeError, ValueError):
        cap = 40
    return cfg.get("lessons") or ".claude/factory/lessons.md", max(cap, 1)


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def lesson_lines(text):
    return [ln for ln in text.splitlines() if ln.startswith("- ")]


def problems(text):
    """[(line number, what is wrong)] for a lessons file's text."""
    out, prev_bullet = [], False
    for n, ln in enumerate(text.splitlines(), 1):
        if ln.startswith("- "):
            prev_bullet = True
            if len(ln) > MAX_LINE:
                out.append((n, f"longer than {MAX_LINE} characters; keep a lesson to one short line"))
            if not EXAMPLE.search(ENFORCED.sub("", ln)):
                out.append((n, "no example or link; add a `code span`, a URL, #123 or e.g."))
        elif ln.strip() and ln[0] in " \t" and prev_bullet:
            out.append((n, "continues the lesson above; a lesson is one line"))
        elif not ln.strip():
            prev_bullet = False
        else:
            prev_bullet = False
    return out


def tokens(text):
    out = set()
    for w in re.findall(r"[a-z][a-z0-9_.-]{2,}", text.lower()):
        w = w.strip(".-")
        if len(w) > 4 and w.endswith("s"):
            w = w[:-1]
        if len(w) >= 3 and w not in STOP and not re.fullmatch(r"[0-9a-f]{7,}", w):
            out.add(w)
    return out


def jaccard(a, b):
    return len(a & b) / len(a | b) if a | b else 0.0


def covered(cand, known):
    """Does an existing lesson already say most of what this candidate says?"""
    t = tokens(cand)
    return bool(t) and any(len(t & k) / len(t) >= 0.6 for k in known)


def enforcement(line):
    m = ENFORCED.search(line)
    return m.group(1) if m else None


# ---- show, check, add, prune -------------------------------------------------------------------------------------

def cmd_show(cfg, args):
    path, _ = settings(cfg)
    for ln in lesson_lines(read(path)):
        print(ln)
    return 0


def cmd_check(cfg, args):
    path, cap = settings(cfg)
    text = read(path)
    if not text:
        print(f"No lessons file at {path}: nothing to check.")
        return 0
    ls, bad = lesson_lines(text), 0
    for n, why in problems(text):
        print(f"factory lessons: {path} line {n}: {why}", file=sys.stderr)
        bad += 1
    if len(ls) > cap:
        print(f"factory lessons: {len(ls)} lessons, over the cap of {cap}. Fix: drop the ones a hook or check enforces "
              f"now (factory lessons prune), or merge similar ones.", file=sys.stderr)
        bad += 1
    print(f"{len(ls)} of {cap} lessons ({path})")
    for ln in ls:
        target = enforcement(ln)
        if target and os.path.exists(target):
            print(f"  enforced by {target} now, so it can go (factory lessons prune): {ENFORCED.sub('', ln)[2:70]}")
        elif target:
            print(f"  says it is enforced by {target}, which does not exist: {ENFORCED.sub('', ln)[2:70]}")
    return 1 if bad else 0


def cmd_add(cfg, args):
    if agent_session():
        return fail("add changes .claude/, which only the dev manager does. Fix: put the lesson in a "
                    "`<!-- factory-question -->` comment on your pull request and the dev manager decides.")
    path, cap = settings(cfg)
    rule = " ".join(args.rule.split())
    rule = rule[2:] if rule.startswith("- ") else rule
    line = "- " + rule
    text = read(path)
    for n, why in problems(line):
        return fail(f"not added: {why}.")
    existing = lesson_lines(text)
    if len(existing) >= cap:
        return fail(f"not added: the file already has {len(existing)} lessons, the cap (lessonsCap) is {cap}. "
                    f"Fix: run `factory lessons prune` or merge two lessons first.")
    new = tokens(ENFORCED.sub("", line))
    for ex in existing:
        if ENFORCED.sub("", ex).casefold() == ENFORCED.sub("", line).casefold() or jaccard(new, tokens(ENFORCED.sub("", ex))) >= 0.8:
            return fail(f"not added: a lesson like it is already there: {ex[:100]}")
    if not text:
        text = HEADER
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    elif not text.endswith("\n"):
        text += "\n"
    write(path, text + line + "\n")
    print(f"Added lesson {len(existing) + 1} of {cap}: {line}")
    return 0


def write(path, text):
    with open(path + ".tmp", "w") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


def cmd_prune(cfg, args):
    path, _ = settings(cfg)
    text = read(path)
    gone = [ln for ln in lesson_lines(text) if enforcement(ln) and os.path.exists(enforcement(ln))]
    if not gone:
        print("Nothing to prune: no lesson names an enforcement that exists.")
        return 0
    for ln in gone:
        print(f"{'removing' if args.apply else 'prune'}: {ln}")
    if not args.apply:
        print("Run `factory lessons prune --apply` (dev manager) to remove them, then commit the file in a pull request.")
        return 0
    if agent_session():
        return fail("prune --apply changes .claude/, which only the dev manager does.")
    write(path, "".join(ln + "\n" for ln in text.splitlines() if ln not in gone))
    return 0


# ---- suggest -------------------------------------------------------------------------------------------------------

def gh(path):
    p = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"factory lessons: gh api {path.split('?')[0]} failed: {(p.stderr or p.stdout).strip()[:200]}. "
                         f"Fix: run `gh auth status`.")
    return json.loads(p.stdout) if p.stdout.strip() else None


def task_pulls(last):
    out, page = [], 1
    while len(out) < last:
        chunk = gh(f"repos/{{owner}}/{{repo}}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page={page}") or []
        out += [p for p in chunk if branch_task(p["head"]["ref"])]
        if len(chunk) < 100:
            break
        page += 1
    return out[:last]


def items(body):
    """The separate must-fixes in a comment: its list items, or else its first line."""
    body = MUSTFIX.sub("", body or "").strip()
    found = [m.group(1) for ln in body.splitlines() if (m := ITEM.match(ln))]
    if not found:
        found = [ln.strip() for ln in body.splitlines() if ln.strip()][:1]
    return [re.sub(r"[*_]{2}|^must-fix:\s*", "", x, flags=re.I).strip()[:160] for x in found if x.strip()]


def pull_facts(p):
    """(must-fix items, CI failure causes) of one task pull request."""
    n, branch = p["number"], p["head"]["ref"]
    mustfix = [t for c in gh(f"repos/{{owner}}/{{repo}}/issues/{n}/comments?per_page=100") or []
               if MUSTFIX.search(c.get("body") or "") for t in items(c["body"])]
    runs = (gh(f"repos/{{owner}}/{{repo}}/actions/runs?branch={branch.replace('/', '%2F')}&per_page=100") or {}).get("workflow_runs", [])
    causes = set()
    for r in [r for r in runs if r.get("conclusion") == "failure"][:10]:
        for job in (gh(f"repos/{{owner}}/{{repo}}/actions/runs/{r['id']}/jobs?per_page=100") or {}).get("jobs", []):
            if job.get("conclusion") != "failure":
                continue
            steps = [s["name"] for s in job.get("steps", []) if s.get("conclusion") == "failure"]
            causes.add(f"{job['name']} / {steps[0]}" if steps else job["name"])
    return f"#{n}", mustfix, sorted(causes)


def reviewer_facts(cfg):
    """[(branch, finding)] from this machine's review records: a failing round's findings (rereview records)."""
    out, d = [], cfg.get("reviewMarkers", "tmp/reviews")
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return out
    for name in names:
        if not name.endswith(".reviews.json"):
            continue
        try:
            data = json.load(open(os.path.join(d, name)))
        except (OSError, ValueError):
            continue
        branch = name[:-len(".reviews.json")].replace("_", "/", 1)
        for rounds in data.values() if isinstance(data, dict) else []:
            for r in rounds if isinstance(rounds, list) else []:
                if isinstance(r, dict) and r.get("result") == "fail":
                    out += [(branch, t) for t in items(r.get("findings") or "")]
    return out


def cluster(pairs):
    """[(text, refs)] -> groups of similar texts: [{'text', 'refs'}] (the first text stands for its group)."""
    groups = []
    for ref, text in pairs:
        t = tokens(text)
        for g in groups:
            if jaccard(t, g["tokens"]) >= 0.5:
                if ref not in g["refs"]:
                    g["refs"].append(ref)
                break
        else:
            groups.append({"text": text, "tokens": t, "refs": [ref]})
    return groups


def candidates(facts, reviewer, known, minimum):
    out = []
    must = [(ref, t) for ref, mf, _ in facts for t in mf]
    for g in cluster(must):
        out.append({"source": "mustfix", "text": g["text"], "refs": g["refs"]})
    ci = {}
    for ref, _, causes in facts:
        for c in causes:
            ci.setdefault(c, []).append(ref)
    for c, refs in ci.items():
        out.append({"source": "ci", "text": f"CI fails at {c}", "refs": refs})
    for g in cluster(reviewer):
        out.append({"source": "reviewer", "text": g["text"], "refs": g["refs"]})
    res = []
    for c in out:
        c["count"] = len(c["refs"])
        if c["count"] < minimum or covered(c["text"], known):
            continue
        ref = c["refs"][0]
        c["line"] = (f"- CI step `{c['text'][len('CI fails at '):]}` failed on {c['count']} recent PRs: say what to run before pushing (e.g. {ref})"
                     if c["source"] == "ci" else f"- {c['text'].rstrip('.')} (e.g. {ref})")
        res.append(c)
    return sorted(res, key=lambda c: (-c["count"], c["text"]))


def cmd_suggest(cfg, args):
    path, _ = settings(cfg)
    known = [tokens(ENFORCED.sub("", ln)) for ln in lesson_lines(read(path))]
    pulls = task_pulls(args.last)
    with ThreadPoolExecutor(6) as pool:
        facts = list(pool.map(pull_facts, pulls))
    found = candidates(facts, reviewer_facts(cfg), known, args.min)
    if args.json:
        print(json.dumps({"pulls": len(pulls), "min": args.min, "candidates": found}, indent=2))
        return 0
    if not found:
        print(f"No repeated causes in the last {len(pulls)} task pull requests (a cause must come back on {args.min}+). "
              f"Nothing to add.")
        return 0
    print(f"Candidate lessons from the last {len(pulls)} task pull requests (read-only; nothing is added until you run add):")
    for c in found:
        print(f"\n{c['count']}x  {c['text']}\n     {c['source']}: {', '.join(c['refs'])}")
        print(f"     factory lessons add \"{c['line'][2:]}\"")
    print("\nEdit the wording first: one line, imperative, with the example. Then commit the file in a pull request.")
    return 0


def main():
    ap = argparse.ArgumentParser(prog="factory lessons", description="The curated lessons file.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("show")
    sub.add_parser("check")
    s = sub.add_parser("suggest")
    s.add_argument("--last", type=int, default=20, help="how many recent task pull requests to read (20)")
    s.add_argument("--min", type=int, default=2, help="a cause must come back on this many of them (2)")
    s.add_argument("--json", action="store_true")
    a = sub.add_parser("add")
    a.add_argument("rule")
    pr = sub.add_parser("prune")
    pr.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    cfg = load()
    return {"show": cmd_show, "check": cmd_check, "suggest": cmd_suggest, "add": cmd_add, "prune": cmd_prune}[args.cmd](cfg, args)


if __name__ == "__main__":
    sys.exit(main())
