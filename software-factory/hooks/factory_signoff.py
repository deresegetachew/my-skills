#!/usr/bin/env python3
"""The sign-off and testing queue (#101): what only a person can check, and the tests of the running app.

One issue, "Sign-off and testing queue" (pin it), holds one comment per item. The state of an item is read from the
comments after it, so nothing is edited and a second run changes nothing.

  factory signoff ls [--all] [--json]       open items (--all: finished ones too), one line each
  factory signoff add <id> --task N --check "how to check it"
                                            a task's "Done when" needs a person: say how they check it
  factory signoff plan <id> [--task N] (--file PLAN.md | --text "...")
                                            the product owner's test plan for the running app; proposed until confirmed
  factory signoff confirm <id> [--by NAME]  the owner says this is what gets tested (a revised plan needs it again)
  factory signoff result <id> pass|fail|blocked [--note "..."] [--build REF] [--by NAME]
                                            record a result; a test plan takes one only once it is confirmed
  add other options: --dry-run prints the comment and posts nothing

States: a sign-off item is open, passed or failed. A test plan is proposed (waits for the owner), confirmed (waits for a
run), passed, failed or blocked. Whether a plan is run by a scripted browser or by Claude driving a browser is not
decided; this file only keeps the plans, the confirmations and the results, whoever or whatever produced them.
Read and written through the GitHub REST API (`gh api`).
"""
import argparse, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402

TITLE = "Sign-off and testing queue"
ID = re.compile(r"[A-Za-z0-9][\w.-]{0,63}")
MARK = re.compile(r"<!--\s*factory-(signoff-result|signoff|testplan-confirm|testplan|testresult)\b([^>]*?)-->")
ATTR = re.compile(r"([A-Za-z][\w-]*)=(\S+)")
RESULTS = ("pass", "fail", "blocked")
WORD = {"pass": "passed", "fail": "failed", "blocked": "blocked"}


def queue(create=False):
    """The number of the open queue issue (made on demand when `create`), else None."""
    for i in fi.gh_all("repos/{owner}/{repo}/issues?state=open"):
        if i.get("title") == TITLE and "pull_request" not in i:
            return i["number"]
    if not create:
        return None
    made = fi.gh("POST", "repos/{owner}/{repo}/issues", {
        "title": TITLE,
        "body": "Things only a person can check, and the tests of the running app. One comment per item "
                "(`factory signoff add|plan|confirm|result`). Pin this issue. The state of an item is read from the "
                "comments after it; nothing is edited."})
    return made["number"]


def read(comments):
    """{id: item} from the queue's comments, in the order the items first appeared.

    item: kind (signoff | testplan), id, task, text (the comment's words), state, results [(result, by, note)]."""
    items = {}
    for c in comments:
        body = c.get("body") or ""
        m = MARK.search(body)
        if not m:
            continue
        what, attrs = m.group(1), dict(ATTR.findall(m.group(2)))
        i = attrs.get("id")
        if not i:
            continue
        text = MARK.sub("", body).strip()
        if what == "signoff" or what == "testplan":
            if what == "signoff" and i in items:
                continue  # the first entry stands
            # a revised test plan replaces the old one: it has to be confirmed again and its results start over
            items[i] = {"kind": what, "id": i, "task": attrs.get("task"), "text": text, "confirmed": False,
                        "results": []}
        elif i in items:
            it = items[i]
            if what == "testplan-confirm" and it["kind"] == "testplan":
                it["confirmed"] = True
            elif what in ("signoff-result", "testresult") and attrs.get("result") in RESULTS:
                if it["kind"] == "testplan" and not it["confirmed"]:
                    continue  # a result for a plan nobody confirmed counts for nothing
                it["results"].append((attrs["result"], attrs.get("by", ""), text))
    for it in items.values():
        last = it["results"][-1][0] if it["results"] else None
        if it["kind"] == "signoff":
            it["state"] = WORD[last] if last in ("pass", "fail") else "open"
        else:
            it["state"] = WORD[last] if last else ("confirmed" if it["confirmed"] else "proposed")
    return items


def open_items(items):
    return [it for it in items.values() if it["state"] in ("open", "proposed", "confirmed")]


def line(it):
    first = (it["text"].splitlines() or [""])[0][:90]
    task = f" task #{it['task']}" if it.get("task") else ""
    kind = "sign-off" if it["kind"] == "signoff" else "test plan"
    return f"{it['id']}: {kind} {it['state']}{task}: {first}"


def digest(cfg):
    """Lines for the product owner's work list: what waits on the owner or on a test run. Reads GitHub only."""
    n = queue()
    if not n:
        return []
    items = read(fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments"))
    out = []
    for it in open_items(items):
        if it["kind"] == "testplan" and it["state"] == "proposed":
            out.append(f"test plan {it['id']} waits for the owner to confirm (queue #{n})")
        elif it["kind"] == "testplan":
            out.append(f"test plan {it['id']} is confirmed and not run yet (queue #{n})")
    signoffs = [it for it in open_items(items) if it["kind"] == "signoff"]
    if signoffs:
        one = len(signoffs) == 1
        out.append(f"{len(signoffs)} sign-off item{'' if one else 's'} {'waits' if one else 'wait'} for a person (queue #{n})")
    return out


def who(a):
    given = getattr(a, "by", None) or os.environ.get("FACTORY_AGENT")
    return re.sub(r"[^\w.-]", "", given or (fi.gh("GET", "user") or {}).get("login", "") or "unknown")


def post(a, marker, text=""):
    body = f"{marker}\n{text}".rstrip() + "\n"
    if a.dry_run:
        print("would post to the sign-off and testing queue:\n" + body)
        return
    n = queue(create=True)
    fi.comment(n, body)
    print(f"posted to the sign-off and testing queue (#{n}).")


def fail(msg, fix):
    sys.exit(f"factory signoff: {msg}\n  fix: {fix}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="factory signoff", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("ls")
    s.add_argument("--all", action="store_true")
    s.add_argument("--json", action="store_true")
    for name in ("add", "plan", "confirm", "result"):
        s = sub.add_parser(name)
        s.add_argument("id")
        s.add_argument("--dry-run", action="store_true")
        s.add_argument("--by")
    sub.choices["add"].add_argument("--task", type=int, required=True)
    sub.choices["add"].add_argument("--check", required=True)
    sub.choices["plan"].add_argument("--task", type=int)
    sub.choices["plan"].add_argument("--file")
    sub.choices["plan"].add_argument("--text")
    sub.choices["result"].add_argument("outcome", choices=RESULTS)
    sub.choices["result"].add_argument("--note", default="")
    sub.choices["result"].add_argument("--build", default="")
    a = ap.parse_args(argv)
    if a.cmd == "ls":
        n = queue()
        items = read(fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments")) if n else {}
        shown = list(items.values()) if a.all else open_items(items)
        if a.json:
            import json
            print(json.dumps(shown, indent=2))
        else:
            print("\n".join(line(it) for it in shown) or "nothing waits in the sign-off and testing queue")
        return
    if not ID.fullmatch(a.id):
        fail(f"'{a.id}' is not an id.", "use letters, digits, dots and dashes, for example login-flow-2")
    n = queue()
    items = read(fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments")) if n else {}
    it = items.get(a.id)
    if a.cmd == "add":
        if it:
            fail(f"'{a.id}' is already in the queue ({it['state']}).", "pick another id, or record a result for it")
        post(a, f"<!-- factory-signoff id={a.id} task={a.task} -->", f"To check: {a.check}")
    elif a.cmd == "plan":
        text = open(a.file, encoding="utf-8").read() if a.file else a.text
        if not text:
            fail("a plan needs its steps.", "pass --file PLAN.md or --text \"...\"")
        if it and it["kind"] == "signoff":
            fail(f"'{a.id}' is a sign-off item, not a test plan.", "pick another id")
        task = f" task={a.task}" if a.task else (f" task={it['task']}" if it and it["task"] else "")
        post(a, f"<!-- factory-testplan id={a.id}{task} -->", text.strip())
    elif a.cmd == "confirm":
        if not it or it["kind"] != "testplan":
            fail(f"there is no test plan '{a.id}'.", "see `factory signoff ls`")
        if it["confirmed"] and not it["results"]:
            print(f"{a.id} is already confirmed.")
            return
        post(a, f"<!-- factory-testplan-confirm id={a.id} by={who(a)} -->",
             f"Confirmed by {who(a)}: this is what gets tested.")
    else:
        if not it:
            fail(f"there is no item '{a.id}'.", "see `factory signoff ls`")
        if it["kind"] == "testplan" and not it["confirmed"]:
            fail(f"test plan '{a.id}' is not confirmed, so a result for it counts for nothing.",
                 f"the owner confirms it first: factory signoff confirm {a.id}")
        marker = "testresult" if it["kind"] == "testplan" else "signoff-result"
        if it["kind"] == "signoff" and a.outcome == "blocked":
            fail("a sign-off item is passed or failed.", "use pass or fail")
        build = re.sub(r"[^\w.-]", "", a.build) if a.build else ""
        at = f" build={build}" if a.build else ""
        post(a, f"<!-- factory-{marker} id={a.id} result={a.outcome} by={who(a)}{at} -->", a.note)


if __name__ == "__main__":
    main()
