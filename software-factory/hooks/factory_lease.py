#!/usr/bin/env python3
"""The minimal lease the dev-manager orchestrator needs (#97), in the shape issue #99 defines, behind one small module.

A lease is a comment on the item's pull request or issue:

  <!-- factory-review-claim manager=<name> sha=<head> until=<ISO time> -->        a review of one head commit
  <!-- factory-answer-claim manager=<name> question=<comment id> until=<ISO> -->   an answer to one question
  <!-- factory-item-claim manager=<name> item=<ref> until=<ISO time> -->           any other item (an agent, an issue)

Protocol (the same as #99): a manager that wants an item and sees no unexpired claim by another manager posts one
(`until` = now + minutes), re-reads the comments, and the earliest unexpired claim for that key wins (GitHub's comment
order is the tie-break). The loser does nothing. A new head commit is a different key (the sha differs). A manager that
dies leaves a claim that expires on its own; `release` ends it early by moving `until` to now.

Identity: every role shares one GitHub account, so the holder is the name inside the comment, never the login.

This module is the whole interface the orchestrator uses: `holder`, `acquire`, `release`. When the full claim protocol of
#99 (`factory prs` showing claims, stale-hold clean-up) lands, it keeps these marker formats, so claims made here and
there interoperate; swap the three functions for that module's and nothing else changes.
"""
import os, re, sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

KINDS = {"review": "sha", "answer": "question", "item": "item"}
CLAIM = re.compile(r"<!--\s*factory-(review|answer|item)-claim\s+manager=([\w.-]+)\s+(sha|question|item)=(\S+)\s+"
                   r"until=(\S+?)\s*-->")


def now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(text):
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def render(kind, holder, key, until):
    attr = KINDS[kind]
    return f"<!-- factory-{kind}-claim manager={holder} {attr}={key} until={iso(until)} -->"


def parse(body):
    """{kind, holder, key, until} for a claim comment, else None."""
    m = CLAIM.search(body or "")
    if not m or KINDS[m.group(1)] != m.group(3):
        return None
    until = parse_time(m.group(5))
    return {"kind": m.group(1), "holder": m.group(2), "key": m.group(4), "until": until} if until else None


def same_key(a, b):
    """A sha may be written short or long; every other key must match exactly."""
    if a == b:
        return True
    sha = re.compile(r"[0-9a-f]{7,40}")
    return bool(sha.fullmatch(a) and sha.fullmatch(b) and (a.startswith(b) or b.startswith(a)))


def claims_on(comments, kind, key, at=None):
    """The unexpired claims for `key`, in comment order: [(comment, claim)]."""
    at = at or now()
    out = []
    for c in comments:
        claim = parse(c.get("body"))
        if claim and claim["kind"] == kind and same_key(claim["key"], str(key)) and claim["until"] > at:
            out.append((c, claim))
    return out


def _gh():
    import factory_issues as fi
    return fi


def comments_of(target):
    return _gh().gh_all(f"repos/{{owner}}/{{repo}}/issues/{target}/comments")


def holder(target, kind, key, comments=None):
    """The manager holding the lease on `key` (the earliest unexpired claim), or None."""
    found = claims_on(comments if comments is not None else comments_of(target), kind, key)
    return found[0][1]["holder"] if found else None


def acquire(target, kind, key, who, minutes):
    """Claims `key` on issue or PR `target` for `who`. Returns the lease (a dict) when `who` holds it, else None.
    Already holding an unexpired one is fine (the lease is returned as it is)."""
    fi = _gh()
    key = str(key)
    existing = claims_on(comments_of(target), kind, key)
    if existing:
        c, claim = existing[0]
        return ({"target": target, "kind": kind, "key": key, "holder": who, "comment": c["id"],
                 "until": claim["until"]} if claim["holder"] == who else None)
    until = now() + timedelta(minutes=minutes)
    posted = fi.gh("POST", f"repos/{{owner}}/{{repo}}/issues/{target}/comments", {"body": render(kind, who, key, until)})
    mine = (posted or {}).get("id")
    won = claims_on(comments_of(target), kind, key)
    if not won or won[0][0].get("id") != mine:
        if mine:  # lost: end our claim at once so it does not outlive the loser's intent
            end(target, mine, kind, who, key)
        return None
    return {"target": target, "kind": kind, "key": key, "holder": who, "comment": mine, "until": until}


def end(target, comment_id, kind, who, key):
    _gh().gh("PATCH", f"repos/{{owner}}/{{repo}}/issues/comments/{comment_id}",
             {"body": render(kind, who, key, now() - timedelta(seconds=1)) + "\nreleased"})


def release(lease):
    """Ends the lease early. Safe to call twice."""
    if lease and lease.get("comment"):
        end(lease["target"], lease["comment"], lease["kind"], lease["holder"], lease["key"])
