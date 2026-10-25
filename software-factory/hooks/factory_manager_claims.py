#!/usr/bin/env python3
"""Several dev managers at once (#99): review and question claims with a lease, so two managers never review,
answer, merge or ask the same thing twice, and a manager that dies mid-review does not block a PR.

  factory_manager_claims.py list    [--json]                 open PRs and unanswered questions, and who holds each
  factory_manager_claims.py review  <pr> --manager NAME      claim a PR's head commit for review (exit 0 won, 3 lost or held, 4 already reviewed)
  factory_manager_claims.py answer  <comment id> --manager NAME
                                                             claim a `factory-question` (same exit codes)
  factory_manager_claims.py next    --manager NAME [--max N] [--json]
                                                             sweep stale holds, then claim every free PR and question
                                                             (up to N) and print what this manager won
  factory_manager_claims.py release <pr|question id> --manager NAME
                                                             give a claim up (and take the hold off a PR)
  factory_manager_claims.py sweep                            take `factory-hold` off PRs whose lease ran out
  factory_manager_claims.py merge   <pr> --manager NAME [--method squash|merge|rebase]
                                                             merge the approved head; "done by someone else" is not an error
  factory_manager_claims.py ask     --id SLUG --text TEXT    post an owner-queue ask once (by its id)

The protocol lives in GitHub comments, so any manager on any machine takes part. All managers and builders share one
GitHub account (owner's decision, 2026-10-25): the manager's name is inside the comment, and `trustedReviewers`
cannot tell managers apart, so nothing here relies on it.

  <!-- factory-review-claim manager=<name> sha=<head> until=<ISO time> -->
  <!-- factory-answer-claim manager=<name> question=<comment id> until=<ISO time> -->
  <!-- factory-claim-release manager=<name> sha=<head> -->            (or question=<comment id>)
  <!-- factory-owner-ask id=<slug> -->                                 (on the owner-queue issue)

A claim is a lease: `until` is now plus `manager.claimMinutes` (default 20), and never counts for more than
MAX_LEASE_MINUTES after the comment was posted. The earliest unexpired claim for the same head (or question) wins,
in the order GitHub lists the comments; a manager that posted a claim re-reads the comments and does nothing if it
lost. A new head commit makes the sha differ, so the old claim means nothing. A review marker for the head
(`factory-approved`, `factory-mustfix`, `pr-watch`) ends a review claim; a `factory-answer` after the question ends an
answer claim. `merge` carries the head sha, so GitHub refuses a second manager's merge.
"""
import argparse, json, os, re, sys
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402
from factory_config import load  # noqa: E402

MAX_LEASE_MINUTES = 120   # a lease never counts for longer than this after its comment, whatever `until` says
OWNER_QUEUE_TITLE = "Dev manager: needs the owner"
NAME = re.compile(r"[a-z0-9][a-z0-9-]*")
MARKER = re.compile(r"<!--\s*(factory-review-claim|factory-answer-claim|factory-claim-release)\s+([^>]*?)-->")
QUESTION = re.compile(r"<!--\s*factory-question\b")
ANSWER = re.compile(r"<!--\s*factory-answer(?!-)\b")
REVIEWED = re.compile(r"<!--\s*(?:factory-approved|factory-mustfix|pr-watch)\s+sha=([0-9a-f]{7,40})")
APPROVED = re.compile(r"<!--\s*factory-approved\s+sha=([0-9a-f]{7,40})")
ASK = re.compile(r"<!--\s*factory-owner-ask\s+id=([A-Za-z0-9._-]+)")

WON, LOST, DONE = 0, 3, 4


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0)


def parse_time(text):
    try:
        t = datetime.fromisoformat((text or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def stamp(t):
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def claim_minutes(cfg):
    try:
        return max(int((cfg.get("manager") or {}).get("claimMinutes", 20)), 1)
    except (TypeError, ValueError):
        return 20


def same_sha(a, b):
    return bool(a and b) and (a.startswith(b) or b.startswith(a))


# ---------------------------------------------------------------------------------------------------- the comments

def parse_marker(comment):
    """The claim or release marker in a comment as a dict (kind, manager, sha or question, until), else None."""
    m = MARKER.search(comment.get("body") or "")
    if not m:
        return None
    attrs = dict(re.findall(r"(\w+)=(\S+)", m.group(2)))
    kind = {"factory-review-claim": "review", "factory-answer-claim": "answer", "factory-claim-release": "release"}[m.group(1)]
    if not NAME.fullmatch(attrs.get("manager", "")):
        return None
    out = {"kind": kind, "manager": attrs["manager"], "sha": attrs.get("sha"), "question": attrs.get("question"),
           "id": comment.get("id"), "created": parse_time(comment.get("created_at"))}
    if kind != "release":
        until = parse_time(attrs.get("until"))
        if until is None or (kind == "review" and not out["sha"]) or (kind == "answer" and not out["question"]):
            return None
        if out["created"]:  # a claim posted by something odd cannot hold a PR for days
            until = min(until, out["created"] + timedelta(minutes=MAX_LEASE_MINUTES))
        out["until"] = until
    else:
        out["until"] = None
        if not (out["sha"] or out["question"]):
            return None
    return out


def subject_of(c):
    return ("sha", c["sha"]) if c.get("sha") else ("question", str(c["question"]))


def live_claims(comments, now):
    """Unexpired claims, in comment order, with a manager's own release dropping its earlier claims for that subject."""
    claims = []
    for c in comments:
        m = parse_marker(c)
        if not m:
            continue
        if m["kind"] == "release":
            claims = [x for x in claims if not (x["manager"] == m["manager"] and subject_of(x) == subject_of(m)
                                                and x["kind"] == ("review" if m["sha"] else "answer"))]
        else:
            claims.append(m)
    return [c for c in claims if c["until"] > now]


def review_winner(comments, head, now):
    """The earliest unexpired review claim for exactly this head; GitHub's comment order breaks ties."""
    for c in live_claims(comments, now):
        if c["kind"] == "review" and same_sha(head, c["sha"]):
            return c
    return None


def answer_winner(comments, question_id, now):
    for c in live_claims(comments, now):
        if c["kind"] == "answer" and str(c["question"]) == str(question_id):
            return c
    return None


def reviewed(comments, head):
    return any(same_sha(head, sha) for c in comments for sha in REVIEWED.findall(c.get("body") or ""))


def approved(comments, head, trusted=()):
    ok = False
    for c in comments:
        login = (c.get("user") or {}).get("login", "")
        m = APPROVED.search(c.get("body") or "")
        if m and (not trusted or login in trusted):
            ok = same_sha(head, m.group(1))
        elif "<!-- factory-mustfix" in (c.get("body") or ""):
            ok = False
    return ok


def open_questions(comments):
    """Questions with no later `factory-answer` (an answer settles every question before it)."""
    asked = []
    for c in comments:
        b = c.get("body") or ""
        if QUESTION.search(b):
            asked.append(c)
        elif ANSWER.search(b):
            asked = []
    return asked


def stale_hold(comments, labels, hold, now):
    """True when the hold label is on, some manager claimed this PR before, and no lease is running any more."""
    if hold not in labels:
        return False
    any_claim = any(parse_marker(c) and parse_marker(c)["kind"] == "review" for c in comments)
    return any_claim and not any(c["kind"] == "review" for c in live_claims(comments, now))


# ---------------------------------------------------------------------------------------------------- GitHub

def comments_of(n):
    return fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments")


def post(n, body):
    return fi.gh("POST", f"repos/{{owner}}/{{repo}}/issues/{n}/comments", {"body": body})


def lease_text(who, what, until):
    return f"Dev manager {who} is {what} until {until.strftime('%H:%M')} UTC. This is a lease: it ends when a review marker or an answer is posted, or when the time passes."


def hold_on(n, cfg):
    fi.add_labels(n, [cfg.get("holdLabel", "factory-hold")])


def hold_off(n, cfg):
    fi.remove_label(n, cfg.get("holdLabel", "factory-hold"))


def check_name(name):
    if not name or not NAME.fullmatch(name):
        sys.exit("factory manager-claims: give the manager's name with --manager (lowercase letters, digits, dashes), "
                 "for example --manager dm-1.")
    return name


def claim_review(cfg, pr, who, now=None):
    """(exit code, line). Claim the PR's head for review; the earliest unexpired claim wins."""
    now = now or now_utc()
    n = pr["number"]
    head = pr["head"]["sha"]
    comments = comments_of(n)
    if reviewed(comments, head):
        return DONE, f"PR #{n}: {head[:7]} already has a review marker"
    held = review_winner(comments, head, now)
    if held and held["manager"] != who:
        return LOST, f"PR #{n}: held by {held['manager']} until {held['until'].strftime('%H:%M')} UTC"
    if held and held["manager"] == who:
        hold_on(n, cfg)  # already mine: make sure the hold is on, no second claim
        return WON, f"PR #{n}: already claimed by {who} until {held['until'].strftime('%H:%M')} UTC"
    until = now + timedelta(minutes=claim_minutes(cfg))
    mine = post(n, f"<!-- factory-review-claim manager={who} sha={head} until={stamp(until)} -->\n"
                   + lease_text(who, f"reviewing {head[:7]}", until))
    winner = review_winner(comments_of(n), head, now)
    if not winner or winner["id"] != mine["id"]:
        who2 = winner["manager"] if winner else "another manager"
        return LOST, f"PR #{n}: lost the claim to {who2}; doing nothing"
    hold_on(n, cfg)
    return WON, f"PR #{n}: claimed {head[:7]} until {until.strftime('%H:%M')} UTC; hold on"


def claim_answer(cfg, qid, who, now=None):
    now = now or now_utc()
    q = fi.gh("GET", f"repos/{{owner}}/{{repo}}/issues/comments/{qid}", ok_404=True)
    if not q or not QUESTION.search(q.get("body") or ""):
        sys.exit(f"factory manager-claims: comment {qid} is not a factory-question. Take the id from `factory manager-claims list`.")
    n = int(q["issue_url"].rsplit("/", 1)[1])
    comments = comments_of(n)
    if not any(str(c.get("id")) == str(qid) for c in open_questions(comments)):
        return DONE, f"question {qid} on #{n}: already answered"
    held = answer_winner(comments, qid, now)
    if held and held["manager"] != who:
        return LOST, f"question {qid} on #{n}: held by {held['manager']} until {held['until'].strftime('%H:%M')} UTC"
    if held:
        return WON, f"question {qid} on #{n}: already claimed by {who}"
    until = now + timedelta(minutes=claim_minutes(cfg))
    mine = post(n, f"<!-- factory-answer-claim manager={who} question={qid} until={stamp(until)} -->\n"
                   + lease_text(who, f"answering the question above (comment {qid})", until))
    winner = answer_winner(comments_of(n), qid, now)
    if not winner or winner["id"] != mine["id"]:
        return LOST, f"question {qid} on #{n}: lost the claim to {winner['manager'] if winner else 'another manager'}; doing nothing"
    return WON, f"question {qid} on #{n}: claimed until {until.strftime('%H:%M')} UTC"


def release(cfg, target, who):
    """Give a claim up: a PR number (hold off, release marker when it is still unreviewed) or a question comment id."""
    pr = fi.gh("GET", f"repos/{{owner}}/{{repo}}/pulls/{target}", ok_404=True)
    if pr:
        n, head = pr["number"], pr["head"]["sha"]
        comments = comments_of(n)
        held = review_winner(comments, head, now_utc())
        if held and held["manager"] != who:
            return LOST, f"PR #{n}: held by {held['manager']}, not {who}; hold left on"
        if held:
            post(n, f"<!-- factory-claim-release manager={who} sha={head} -->\nDev manager {who} gave up the review of {head[:7]}.")
        hold_off(n, cfg)
        return WON, f"PR #{n}: hold off" + (", claim released" if held else "")
    q = fi.gh("GET", f"repos/{{owner}}/{{repo}}/issues/comments/{target}", ok_404=True)
    if not q:
        sys.exit(f"factory manager-claims: {target} is neither an open PR nor a comment. Check the number.")
    n = int(q["issue_url"].rsplit("/", 1)[1])
    held = answer_winner(comments_of(n), target, now_utc())
    if held and held["manager"] == who:
        post(n, f"<!-- factory-claim-release manager={who} question={target} -->\nDev manager {who} gave up the question (comment {target}).")
        return WON, f"question {target} on #{n}: claim released"
    return LOST, f"question {target} on #{n}: no claim by {who} to release"


def sweep(cfg, now=None, pulls=None):
    """Take `factory-hold` off PRs whose lease ran out (the manager died). Returns the PR numbers."""
    now = now or now_utc()
    hold = cfg.get("holdLabel", "factory-hold")
    freed = []
    for p in pulls if pulls is not None else fi.gh_all("repos/{owner}/{repo}/pulls?state=open"):
        labels = {x["name"] for x in p.get("labels", [])}
        if hold in labels and stale_hold(comments_of(p["number"]), labels, hold, now):
            hold_off(p["number"], cfg)
            freed.append(p["number"])
    return freed


# ---------------------------------------------------------------------------------------------------- the picture

def scan(cfg, now=None):
    """Everything a manager decides from: open PRs with their review state and claim, open questions with theirs."""
    now = now or now_utc()
    hold = cfg.get("holdLabel", "factory-hold")
    prs, questions = [], []
    for p in fi.gh_all("repos/{owner}/{repo}/pulls?state=open"):
        n, head = p["number"], p["head"]["sha"]
        comments = comments_of(n)
        labels = {x["name"] for x in p.get("labels", [])}
        w = review_winner(comments, head, now)
        state = "reviewed" if reviewed(comments, head) else "draft" if p.get("draft") else "claimed" if w else "free"
        prs.append({"number": n, "title": p["title"], "head": head, "draft": bool(p.get("draft")), "hold": hold in labels,
                    "state": state, "staleHold": stale_hold(comments, labels, hold, now),
                    "claim": {"manager": w["manager"], "until": stamp(w["until"])} if w else None})
        questions += question_rows(n, comments, now)
    for i in fi.gh_all("repos/{owner}/{repo}/issues?state=open"):
        if "pull_request" not in i and i.get("comments"):
            questions += question_rows(i["number"], comments_of(i["number"]), now)
    return {"prs": prs, "questions": questions}


def question_rows(n, comments, now):
    rows = []
    for q in open_questions(comments):
        w = answer_winner(comments, q["id"], now)
        rows.append({"number": n, "id": q["id"], "state": "claimed" if w else "free",
                     "claim": {"manager": w["manager"], "until": stamp(w["until"])} if w else None})
    return rows


def pick(cfg, who, limit=None):
    """Sweep stale holds, then claim every free PR and question (up to `limit`). Returns what this manager won."""
    freed = sweep(cfg)
    won = {"swept": freed, "reviews": [], "answers": []}
    taken = 0
    for p in fi.gh_all("repos/{owner}/{repo}/pulls?state=open"):
        if limit is not None and taken >= limit:
            break
        if p.get("draft"):
            continue
        code, line = claim_review(cfg, p, who)
        if code == WON and "already claimed" not in line:
            won["reviews"].append({"number": p["number"], "head": p["head"]["sha"]})
            taken += 1
    for q in scan(cfg)["questions"]:
        if limit is not None and taken >= limit:
            break
        if q["state"] != "free":
            continue
        code, line = claim_answer(cfg, q["id"], who)
        if code == WON and "already claimed" not in line:
            won["answers"].append({"number": q["number"], "question": q["id"]})
            taken += 1
    return won


def show(s):
    print("Pull requests")
    for p in s["prs"]:
        flag = {"reviewed": "has a review marker for this head", "draft": "draft", "free": "free to review",
                "claimed": "claimed by {manager} until {until}"}[p["state"]]
        if p["claim"]:
            flag = flag.format(**p["claim"])
        extra = ", hold on" if p["hold"] else ""
        extra += ", STALE hold (lease ran out)" if p["staleHold"] else ""
        print(f"  #{p['number']:<5} {p['head'][:7]}  {flag}{extra}")
    if not s["prs"]:
        print("  none open")
    print("Questions waiting")
    for q in s["questions"]:
        flag = "free to answer" if q["state"] == "free" else "claimed by {manager} until {until}".format(**q["claim"])
        print(f"  #{q['number']:<5} comment {q['id']}  {flag}")
    if not s["questions"]:
        print("  none")


# ---------------------------------------------------------------------------------------------------- merge, ask

def merge(cfg, n, who, method):
    """Merge the approved head with its sha. A refusal because someone else merged or pushed is not an error."""
    pr = fi.gh("GET", f"repos/{{owner}}/{{repo}}/pulls/{n}")
    if pr.get("merged") or pr.get("state") != "open":
        return 0, f"PR #{n}: already {'merged' if pr.get('merged') else 'closed'} (done by someone else)"
    head = pr["head"]["sha"]
    if not approved(comments_of(n), head, set(cfg.get("trustedReviewers") or [])):
        return 1, (f"factory manager-claims: PR #{n} has no factory-approved marker for {head[:7]}. "
                   "Review it first and post <!-- factory-approved sha=<head> -->.")
    try:
        fi.gh("PUT", f"repos/{{owner}}/{{repo}}/pulls/{n}/merge", {"sha": head, "merge_method": method})
    except SystemExit as e:
        now = fi.gh("GET", f"repos/{{owner}}/{{repo}}/pulls/{n}")
        if now.get("merged"):
            return 0, f"PR #{n}: merged by someone else (done by someone else)"
        if now["head"]["sha"] != head:
            return 0, f"PR #{n}: the head moved to {now['head']['sha'][:7]} while merging; it needs a new review (nothing merged)"
        if now.get("state") != "open":
            return 0, f"PR #{n}: closed by someone else"
        return 1, f"factory manager-claims: GitHub refused the merge of #{n}: {e}. Check CI and conflicts, then try again."
    hold_off(n, cfg)
    return 0, f"PR #{n}: merged {head[:7]} ({who})"


def owner_queue(create):
    for i in fi.gh_all("repos/{owner}/{repo}/issues?state=open"):
        if i.get("title") == OWNER_QUEUE_TITLE and "pull_request" not in i:
            return i["number"]
    if not create:
        return None
    made = fi.gh("POST", "repos/{owner}/{repo}/issues", {
        "title": OWNER_QUEUE_TITLE,
        "body": "One comment per thing the dev managers cannot decide, each starting `<!-- factory-owner-ask id=<slug> -->`. "
                "Answer in the comment; the next manager pass reads the reply. Pin this issue."})
    return made["number"]


def ask(text, slug):
    """Post an owner-queue ask once. Two managers racing: the earliest comment with the id stays, the other is deleted."""
    if not re.fullmatch(r"[A-Za-z0-9._-]+", slug or ""):
        sys.exit("factory manager-claims: --id is a slug of letters, digits, dots, dashes and underscores.")
    n = owner_queue(create=True)

    def mine():
        rows = comments_of(n)
        return [c for c in rows if (ASK.search(c.get("body") or "") or [None, None])[1] == slug]

    if mine():
        return 0, f"ask {slug}: already on #{n}, not posted again"
    c = post(n, f"<!-- factory-owner-ask id={slug} -->\nThis needs your yes: {text}")
    first = mine()[0]
    if first["id"] != c["id"]:
        fi.gh("DELETE", f"repos/{{owner}}/{{repo}}/issues/comments/{c['id']}")
        return 0, f"ask {slug}: another manager posted it first; mine removed"
    return 0, f"ask {slug}: posted on #{n}"


# ---------------------------------------------------------------------------------------------------- command line

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("command", choices=["list", "review", "answer", "next", "release", "sweep", "merge", "ask"])
    ap.add_argument("target", nargs="?", help="a PR number, or a question's comment id")
    ap.add_argument("--manager")
    ap.add_argument("--max", type=int, dest="limit")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--method", default="squash", choices=["squash", "merge", "rebase"])
    ap.add_argument("--id", dest="slug")
    ap.add_argument("--text")
    a = ap.parse_args(argv)
    cfg = load()
    needs_target = a.command in ("review", "answer", "release", "merge")
    if needs_target and not (a.target or "").isdigit():
        sys.exit(f"factory manager-claims: {a.command} needs a number: factory manager-claims {a.command} <number> --manager NAME")
    if a.command in ("review", "answer", "release", "merge", "next"):
        check_name(a.manager)
    if a.command == "list":
        s = scan(cfg)
        print(json.dumps(s, indent=2)) if a.json else show(s)
        return 0
    if a.command == "review":
        pr = fi.gh("GET", f"repos/{{owner}}/{{repo}}/pulls/{a.target}")
        if pr.get("state") != "open":
            print(f"PR #{a.target}: not open")
            return DONE
        code, line = claim_review(cfg, pr, a.manager)
    elif a.command == "answer":
        code, line = claim_answer(cfg, a.target, a.manager)
    elif a.command == "release":
        code, line = release(cfg, a.target, a.manager)
    elif a.command == "sweep":
        freed = sweep(cfg)
        print("hold taken off: " + ", ".join(f"#{n}" for n in freed) if freed else "no stale hold")
        return 0
    elif a.command == "merge":
        code, line = merge(cfg, int(a.target), a.manager, a.method)
    elif a.command == "ask":
        if not a.slug or not a.text:
            sys.exit("factory manager-claims: ask needs --id SLUG and --text TEXT.")
        code, line = ask(a.text, a.slug)
    else:
        won = pick(cfg, a.manager, a.limit)
        if a.json:
            print(json.dumps(won, indent=2))
        else:
            for n in won["swept"]:
                print(f"swept: PR #{n} hold taken off (lease ran out)")
            for r in won["reviews"]:
                print(f"review: PR #{r['number']} {r['head'][:7]}")
            for q in won["answers"]:
                print(f"answer: question {q['question']} on #{q['number']}")
            if not (won["reviews"] or won["answers"]):
                print("nothing to claim")
        return 0
    print(line, file=sys.stderr if code == 1 else sys.stdout)
    return code


if __name__ == "__main__":
    sys.exit(main())
