"""A stateful fake `gh` for tests that write to GitHub (comments, issues). Not a test file.

The state is a JSON file (FAKE_DB):
  issues    [{number, title, body, state, labels: [{name}], state_reason, pull_request?}]
  labels, milestones   what `POST labels` and `POST milestones` made
  comments  {"<issue number>": [body or {body, created_at}]}
  pulls     [...]
Reads answer from it. `POST issues` makes an issue; `POST issues/N/comments` appends a comment. Every call is logged to
LOOP_LOG as `gh <args>`, and every write also to `posted` in the file, so a test can say "nothing was written".

    open(os.path.join(d, "bin", "gh"), "w").write(fakegh.GH); os.chmod(..., 0o755)
"""

GH = r'''#!/usr/bin/env python3
import json, os, re, sys
from urllib.parse import urlparse, parse_qs
path_db = os.environ["FAKE_DB"]
db = json.load(open(path_db)); a = sys.argv[1:]
open(os.environ.get("LOOP_LOG", os.devnull), "a").write("gh " + " ".join(a) + "\n")
if a[:1] != ["api"]: sys.exit(1)
method = "GET"
for i, x in enumerate(a):
    if x in ("-X", "--method"): method = a[i + 1]
path = [x for x in a[1:] if not x.startswith("-") and x not in ("GET", "PATCH", "POST", "PUT", "DELETE", "application/vnd.github+json", "-")][0]
data = json.load(sys.stdin) if "--input" in a else {}
u = urlparse(path.replace("repos/{owner}/{repo}/", "")); p = u.path; q = parse_qs(u.query); page = int(q.get("page", ["1"])[0])
def out(x): print(json.dumps(x)); sys.exit(0)
def save(kind, what):
    db.setdefault("posted", []).append({"kind": kind, **what}); json.dump(db, open(path_db, "w"))
if p == "user": out({"login": "me"})
if p == "repos/{owner}/{repo}" or p == "repos/{owner}/{repo}/": out({"owner": {"login": "boss", "type": "User"}})
if p == "labels" and method == "POST":
    db.setdefault("labels", []).append({"name": data["name"], "color": data.get("color", "")}); save("label", {"name": data["name"]}); out({})
if p == "labels": out(db.get("labels", []) if page == 1 else [])
if p == "milestones" and method == "POST":
    ms = db.setdefault("milestones", []); m = {"number": len(ms) + 1, "title": data["title"]}; ms.append(m); save("milestone", m); out(m)
if p == "milestones": out(db.get("milestones", []) if page == 1 else [])
if p == "issues" and method == "POST":
    n = max([i["number"] for i in db.get("issues", [])] + [100]) + 1
    issue = {"number": n, "title": data.get("title", ""), "body": data.get("body", ""), "state": "open",
             "labels": [{"name": x} for x in data.get("labels", [])], "html_url": f"https://github.com/o/r/issues/{n}"}
    if data.get("milestone"):
        issue["milestone"] = next((m for m in db.get("milestones", []) if m["number"] == data["milestone"]), None)
    db.setdefault("issues", []).append(issue); save("issue", {"number": n, "title": issue["title"]}); out(issue)
if p == "issues":
    items = db.get("issues", [])
    st = q.get("state", ["open"])[0]
    if st != "all": items = [i for i in items if i.get("state", "open") == st]
    if "labels" in q: items = [i for i in items if q["labels"][0] in [l["name"] for l in i.get("labels", [])]]
    out(items if page == 1 else [])
m1 = re.fullmatch(r"issues/(\d+)", p)
if m1 and method == "GET": out(next((i for i in db.get("issues", []) if i["number"] == int(m1.group(1))), {}))
if p == "pulls": out(db.get("pulls", []) if page == 1 else [])
m = re.fullmatch(r"issues/(\d+)/comments", p)
if m and method == "POST":
    db.setdefault("comments", {}).setdefault(m.group(1), []).append(data.get("body", ""))
    save("comment", {"issue": int(m.group(1)), "body": data.get("body", "")}); out({"id": 1})
if m:
    rows = [{"id": 1000 * int(m.group(1)) + k, **(b if isinstance(b, dict) else {"body": b, "created_at": "2026-10-25T10:00:00Z"})}
            for k, b in enumerate(db.get("comments", {}).get(m.group(1), []), 1)]
    out(rows if page == 1 else [])
out([] if page == 1 else [])
'''
