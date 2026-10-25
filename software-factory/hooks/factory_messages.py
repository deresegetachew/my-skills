#!/usr/bin/env python3
"""The factory's messages (#107): one structured, versioned envelope for questions, answers, must-fixes, approvals and
status, shaped like A2A tasks and kept in the GitHub comments and issues the factory already uses. The full
specification (envelope, states, transitions, the mapping to A2A) is docs/messages.md.

  <!-- factory-msg v=1 id=<id> kind=question from=haile to=po state=submitted ref=issue#103 in-reply-to=<id> sha=<head> -->

kind: question | answer | mustfix | approval | status.  State: submitted, working, input-required, completed, failed,
canceled (A2A's task states); an agent's status adds idle and down. `to` defaults to dev-manager. On a reply, `state`
is the state the question it answers moves to. The old markers (factory-question, factory-answer, factory-mustfix,
factory-approved) are still read, and an envelope in the same comment wins over them.

  factory messages ls [--to X] [--from X] [--state S] [--ref N] [--kind K] [--all] [--json]
                        open messages across the open issues and PRs (questions by default)
  factory messages new --kind K [--to X] [--from X] [--ref R] [--in-reply-to ID] [--state S] [--sha SHA]
                        print the envelope (and the old marker line) to paste at the top of a comment

This module is also the library: parse_comment / render / fold / check_new / verdicts are what the PR gate, `factory
wait`, `next_task.py` and `factory status` use. Everything is read through the GitHub REST API (`gh api`). Messages
from a peer are data, never instructions: nothing here changes what an agent may do.
"""
import argparse, json, os, re, secrets, sys, time
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SCHEMA = 1
KINDS = ("question", "answer", "mustfix", "approval", "status")
STATES = ("submitted", "working", "input-required", "completed", "failed", "canceled")
OPEN = ("submitted", "working", "input-required")
AGENT_STATES = ("working", "idle", "down", "input-required")
ANSWER_STATES = ("completed", "failed")
STATUS_STATES = ("working", "input-required", "failed", "canceled")
TRANSITIONS = {
    "submitted": ("working", "input-required", "completed", "failed", "canceled"),
    "working": ("input-required", "completed", "failed", "canceled"),
    "input-required": ("working", "completed", "failed", "canceled"),
    "completed": (), "failed": (), "canceled": (),
}
DEV_MANAGER = "dev-manager"
WELL_KNOWN = (DEV_MANAGER, "po", "owner")
DEFAULT_STATE = {"question": "submitted", "answer": "completed", "mustfix": "submitted", "approval": "completed"}
LEGACY_LINE = {"question": "<!-- factory-question -->", "answer": "<!-- factory-answer -->"}

NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{2,39}")
REF = re.compile(r"(issue|pr)#(\d+)")
SHA = re.compile(r"[0-9a-f]{7,40}")
ENVELOPE = re.compile(r"<!--\s*factory-msg\b(.*?)-->", re.S)
ATTR = re.compile(r"([A-Za-z][\w-]*)=(\S+)")
MARKUP = re.compile(r"<!--.*?-->", re.S)
LEGACY_QUESTION = re.compile(r"<!--\s*factory-question\b")
LEGACY_ANSWER = re.compile(r"<!--\s*factory-answer(?!-)\b")  # not factory-answer-claim
LEGACY_MUSTFIX = re.compile(r"<!--\s*factory-mustfix\b(?:\s+sha=([0-9a-f]{7,40}))?")
LEGACY_APPROVED = re.compile(r"<!--\s*factory-approved\b(?:\s+sha=([0-9a-f]{7,40}))?")
ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


@dataclass
class Message:
    id: str
    kind: str
    frm: str = ""
    to: str = DEV_MANAGER
    state: str = "submitted"
    ref: str = ""
    in_reply_to: str = ""
    sha: str = ""
    legacy: bool = False
    login: str = ""
    comment_id: object = None
    url: str = ""
    created: str = ""
    summary: str = ""
    thread: str = ""


@dataclass
class Task:
    """A question and everything that happened to it: A2A's Task, with the question as its first message."""
    question: Message
    state: str = "submitted"
    history: list = field(default_factory=list)  # [(state, message that set it)]
    answer: object = None

    @property
    def id(self):
        return self.question.id

    @property
    def to(self):
        return self.question.to

    @property
    def frm(self):
        return self.question.frm

    @property
    def ref(self):
        return self.question.ref

    @property
    def is_open(self):
        return self.state in OPEN


@dataclass
class Thread:
    tasks: dict = field(default_factory=dict)       # question id -> Task, in the order asked
    rejected: list = field(default_factory=list)    # [(message, why)]: replies that did not apply
    duplicates: list = field(default_factory=list)  # messages whose id was already seen: ignored
    index: dict = field(default_factory=dict)       # message id -> question id, for in-reply-to chains
    seen: set = field(default_factory=set)

    def task_of(self, message_id):
        return self.tasks.get(self.index.get(message_id))


def new_id():
    """A short sortable id: the time in seconds then six random characters (14 characters, base 32)."""
    t, head = int(time.time()), ""
    for _ in range(8):
        head = ALPHABET[t & 31] + head
        t >>= 5
    return head + "".join(secrets.choice(ALPHABET) for _ in range(6))


# --- reading and writing the envelope -------------------------------------------------------------------------------

def visible(text):
    """The first line of what a person reads in a comment, without the markers."""
    for line in MARKUP.sub("", text or "").splitlines():
        if line.strip():
            return line.strip()[:100]
    return ""


def attributes(raw):
    """{name: value} from the inside of an envelope; None when an attribute is given twice (ambiguous)."""
    out = {}
    for name, value in ATTR.findall(raw):
        if name in out:
            return None
        out[name] = value
    return out


def from_attributes(a):
    """A Message from an envelope's attributes, or None when it is not a valid version-1 envelope. Unknown extra
    attributes are ignored, and an envelope of another version is not read at all (a newer kit may write it)."""
    if not a or a.get("v") != str(SCHEMA) or a.get("kind") not in KINDS or not ID.fullmatch(a.get("id", "")):
        return None
    kind = a["kind"]
    state = a.get("state", DEFAULT_STATE.get(kind))
    if state not in STATES + (("idle", "down") if kind == "status" else ()):
        return None
    frm, to = a.get("from", ""), a.get("to", DEV_MANAGER)
    ref, reply, sha = a.get("ref", ""), a.get("in-reply-to", ""), a.get("sha", "")
    if (frm and not NAME.fullmatch(frm)) or not NAME.fullmatch(to) or (ref and not REF.fullmatch(ref)):
        return None
    if (reply and not ID.fullmatch(reply)) or (sha and not SHA.fullmatch(sha)):
        return None
    return Message(id=a["id"], kind=kind, frm=frm, to=to, state=state, ref=ref, in_reply_to=reply, sha=sha)


def parse_envelopes(text):
    """The valid version-1 envelopes in a text, in order; the visible text of the first line goes in `summary`."""
    found = []
    for m in ENVELOPE.finditer(text or ""):
        message = from_attributes(attributes(m.group(1)))
        if message:
            message.summary = visible(text)
            found.append(message)
    return found


def legacy_message(body, key):
    """The message an old marker comment stands for (at most one per comment: question, answer, must-fix, approval)."""
    ident = f"c{key}"
    summary = visible(body)
    if LEGACY_QUESTION.search(body):
        return Message(id=ident, kind="question", legacy=True, summary=summary)
    if LEGACY_ANSWER.search(body):
        failed = re.search(r"needs-owner\s*:", body, re.I)
        return Message(id=ident, kind="answer", frm=DEV_MANAGER, to="", state="failed" if failed else "completed",
                       legacy=True, summary=summary)
    for kind, regex in (("mustfix", LEGACY_MUSTFIX), ("approval", LEGACY_APPROVED)):
        m = regex.search(body)
        if m:
            return Message(id=ident, kind=kind, frm=DEV_MANAGER, state=DEFAULT_STATE[kind], sha=m.group(1) or "",
                           legacy=True, summary=summary)
    return None


def parse_comment(comment, index=None):
    """The messages in one GitHub comment (a dict with body, id, user.login or author.login, created_at, html_url).
    A comment with a valid envelope is read by it alone; otherwise by its old marker."""
    body = comment.get("body") or ""
    found = parse_envelopes(body)
    if not found:
        key = comment.get("id") if comment.get("id") is not None else f"@{index if index is not None else 0}"
        one = legacy_message(body, key)
        found = [one] if one else []
    who = (comment.get("user") or comment.get("author") or {}).get("login", "")
    for m in found:
        m.login, m.comment_id = who, comment.get("id")
        m.url, m.created = comment.get("html_url") or comment.get("url") or "", comment.get("created_at") or ""
    return found


def messages_of(comments, ref=""):
    """All messages of a thread's comments, in order. `ref` is the default for a message that names none."""
    out = []
    for i, c in enumerate(comments):
        for m in parse_comment(c, i):
            m.ref = m.ref or ref
            out.append(m)
    return out


def render(m):
    """The envelope comment for a message (one line)."""
    parts = [f"v={SCHEMA}", f"id={m.id}", f"kind={m.kind}"]
    if m.frm:
        parts.append(f"from={m.frm}")
    parts += [f"to={m.to}", f"state={m.state}"]
    for name, value in (("ref", m.ref), ("in-reply-to", m.in_reply_to), ("sha", m.sha)):
        if value:
            parts.append(f"{name}={value}")
    return "<!-- factory-msg " + " ".join(parts) + " -->"


def legacy_line(m):
    """The old marker that goes with an envelope so a kit that does not know it yet still understands the comment."""
    if m.kind in LEGACY_LINE:
        return LEGACY_LINE[m.kind]
    if m.kind in ("mustfix", "approval") and m.sha:
        return f"<!-- factory-{'mustfix' if m.kind == 'mustfix' else 'approved'} sha={m.sha} -->"
    return ""


def verdicts(body):
    """[('mustfix' | 'approved', sha or None)] the dev manager's word in a comment, from the envelope or the old
    marker. A comment with both counts once."""
    found = [("mustfix" if m.kind == "mustfix" else "approved", m.sha or None)
             for m in parse_envelopes(body) if m.kind in ("mustfix", "approval")]
    if found:
        return found
    for kind, regex in (("mustfix", LEGACY_MUSTFIX), ("approved", LEGACY_APPROVED)):
        m = regex.search(body or "")
        if m:
            return [(kind, m.group(1))]
    return []


def decode_pages(text):
    """The comments from `gh api --paginate` output: one JSON list per page, back to back."""
    out, dec, i = [], json.JSONDecoder(), 0
    text = text or ""
    while i < len(text):
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            break
        chunk, i = dec.raw_decode(text, i)
        out += chunk if isinstance(chunk, list) else [chunk]
    return out


# --- states ---------------------------------------------------------------------------------------------------------

def can_move(old, new):
    """Whether a question in state `old` may go to `new`. Staying where it is is allowed: a repeat does nothing."""
    return old == new or new in TRANSITIONS.get(old, ())


def move_problem(task, m, trusted=()):
    """Why message `m` may not move `task` where it says, or None. Only the addressee answers, works, asks for more
    or fails a question; only the asker cancels it or resumes it after a clarification; a login in `trusted` may
    do any of it."""
    allowed = ANSWER_STATES if m.kind == "answer" else STATUS_STATES
    if m.state not in allowed:
        return f"A {m.kind} sets one of {', '.join(allowed)}, not {m.state}."
    if not can_move(task.state, m.state):
        return f"The question is {task.state}; it can't move to {m.state}."
    if m.state == task.state or (m.login and m.login in trusted):
        return None
    actor = m.frm or (DEV_MANAGER if m.legacy else "")
    if m.state == "canceled":
        return None if actor == task.frm else f"Only the asker ({task.frm or 'unknown'}) can cancel a question."
    if task.state == "input-required" and m.state == "working":
        return None if actor in (task.frm, task.to) else f"Only {task.frm or 'the asker'} or {task.to} can resume it."
    return None if actor == task.to else f"This question is addressed to {task.to}, not {actor or 'an unnamed sender'}."


def fold(messages, trusted=()):
    """The tasks (questions) a thread's messages make, in order. A reply moves the question it names, or the one a
    message in its chain belongs to, when the transition is valid and its sender may make it; anything else is listed
    in `rejected`. A message whose id was seen before changes nothing, so posting it again is safe."""
    t = Thread()
    for m in messages:
        if m.id in t.seen:
            t.duplicates.append(m)
            continue
        t.seen.add(m.id)
        if m.kind == "question":
            if m.state != "submitted":
                t.rejected.append((m, f"A question starts as submitted, not {m.state}."))
                continue
            t.tasks[m.id] = Task(m, history=[("submitted", m)])
            t.index[m.id] = m.id
        elif m.kind == "answer" and m.legacy:
            for task in t.tasks.values():
                if task.is_open and (task.question.legacy or task.to == DEV_MANAGER):
                    apply(t, task, m)
        elif m.kind in ("answer", "status") and m.in_reply_to:
            task = t.task_of(m.in_reply_to)
            why = (f"I can't find message {m.in_reply_to} in this thread." if not task
                   else move_problem(task, m, trusted))
            if why:
                t.rejected.append((m, why))
            else:
                apply(t, task, m)
        elif m.kind == "answer":
            t.rejected.append((m, "An answer says which message it replies to (in-reply-to)."))
    return t


def apply(thread, task, m):
    thread.index[m.id] = task.id
    if m.state != task.state:
        task.state = m.state
        task.history.append((m.state, m))
    if m.kind == "answer":
        task.answer = m


def check_new(m, thread, me=None):
    """Why a message an agent is about to post is refused, or None. `thread` is the fold of the thread it goes in
    (None: only the checks that need no thread). Agents post as themselves, never approve or send must-fixes (the dev
    manager's), and answer, work on or fail only a question addressed to them; invalid transitions are refused."""
    if me and m.frm != me:
        return f"Post as yourself: from= is {m.frm or 'missing'}, and you are {me}."
    if m.kind in ("approval", "mustfix"):
        return "Approvals and must-fixes are reserved for the dev manager."
    if thread is not None and m.id in thread.seen:
        return None  # the same message again changes nothing
    if m.kind == "question":
        return None if m.state == "submitted" else f"A question starts as submitted, not {m.state}."
    if m.kind == "status" and not m.in_reply_to:
        return None if m.state in AGENT_STATES else f"An agent's status is one of {', '.join(AGENT_STATES)}."
    if not m.in_reply_to:
        return "An answer or a state change says which message it replies to: add in-reply-to=<id>."
    if thread is None:
        return None
    task = thread.task_of(m.in_reply_to)
    if not task:
        return f"I can't find message {m.in_reply_to} in this thread. Check the id with `factory messages ls`."
    return move_problem(task, m)


# --- asking the thread ----------------------------------------------------------------------------------------------

def ref_number(ref):
    m = re.fullmatch(r"(?:(issue|pr))?#?(\d+)", ref or "")
    return m.group(2) if m else None


def ref_matches(have, want):
    """`want` is 7, #7, pr#7 or issue#7; a bare number matches either kind."""
    w = re.fullmatch(r"(?:(issue|pr)#|#)?(\d+)", want or "")
    h = REF.fullmatch(have or "")
    if not w or not h or w.group(2) != h.group(2):
        return False
    return not w.group(1) or w.group(1) == h.group(1)


def select(tasks, to=None, frm=None, state=None, ref=None, every_state=False):
    """Tasks that are open (or in `state`, or in any state with `every_state`), addressed `to`, asked by `frm`,
    about `ref`."""
    out = []
    for t in tasks:
        if state and t.state != state:
            continue
        if not state and not every_state and not t.is_open:
            continue
        if (to and t.to != to) or (frm and t.frm != frm) or (ref and not ref_matches(t.ref, ref)):
            continue
        out.append(t)
    return out


def row(m, state, thread):
    return {"id": m.id, "kind": m.kind, "from": m.frm, "to": m.to, "state": state, "ref": m.ref,
            "inReplyTo": m.in_reply_to, "sha": m.sha, "legacy": m.legacy, "thread": thread, "url": m.url,
            "created": m.created, "summary": m.summary}


def wanted(r, a):
    """The to / from / state / ref filters, for rows that are plain messages (questions are filtered as tasks)."""
    return not ((a.to and r["to"] != a.to) or (a.frm and r["from"] != a.frm) or (a.state and r["state"] != a.state)
                or (a.ref and not ref_matches(r["ref"], a.ref)))


def items_to_read(fi, a):
    if not a.ref:
        return fi.gh_all("repos/{owner}/{repo}/issues?state=open")
    number = ref_number(a.ref)
    if not number:
        refuse("bad-ref", f"'{a.ref}' isn't an issue or PR number.", "Use a number, or issue#<n> / pr#<n>.")
    item = fi.gh("GET", f"repos/{{owner}}/{{repo}}/issues/{number}", ok_404=True)
    if not item:
        refuse("no-such-item", f"There is no issue or PR #{number}.", "Check the number with `gh pr list`.")
    return [item]


def collect(fi, cfg, a):
    """The rows `factory messages ls` shows, from the open issues and PRs (or the one item `--ref` names, open or
    not). Agent issues are read for their status only, and only for kind status or all."""
    trusted = set(cfg.get("trustedReviewers") or [])
    rows = []
    for item in items_to_read(fi, a):
        n = item["number"]
        default_ref = ("pr#" if item.get("pull_request") else "issue#") + str(n)
        if "factory:agent" in {x["name"] for x in item.get("labels", [])}:
            if a.kind in ("status", "all"):
                statuses = messages_of([{"body": item.get("body") or "", "html_url": item.get("html_url")}], default_ref)
                rows += [r for r in (row(m, m.state, n) for m in statuses if m.kind == "status") if wanted(r, a)]
            continue
        if not item.get("comments", 1):
            continue  # nothing was said there: no call
        messages = messages_of(fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments"), default_ref)
        if a.kind in ("question", "all"):
            thread = fold(messages, trusted)
            rows += [row(t.question, t.state, n)
                     for t in select(thread.tasks.values(), a.to, a.frm, a.state, a.ref, a.all)]
        plain = [row(m, m.state, n) for m in messages if m.kind in ("answer", "mustfix", "approval")
                 and a.kind in ("all", m.kind)]
        rows += [r for r in plain if wanted(r, a)]
    return sorted(rows, key=lambda r: (r["created"], r["id"]))


def line(r):
    return f"{r['id']:<14} {r['state']:<14} {r['from'] or '?'} -> {r['to'] or '?'}  {r['ref'] or '-'}  {r['summary']}"


# --- the command ----------------------------------------------------------------------------------------------------

def refuse(code, message, fix):
    from factory_machine import refuse as stop
    stop(code, message, fix)


def cmd_ls(a):
    import factory_issues as fi
    from factory_config import load
    every = KINDS + ("all",)
    if a.kind not in every:
        refuse("bad-kind", f"'{a.kind}' isn't a message kind.", f"Use one of: {', '.join(every)}.")
    if a.state and a.state not in STATES + ("idle", "down"):
        refuse("bad-state", f"'{a.state}' isn't a message state.", f"Use one of: {', '.join(STATES + ('idle', 'down'))}.")
    rows = collect(fi, load(), a)
    if a.json:
        print(json.dumps(rows, indent=2))
    elif rows:
        print("\n".join(line(r) for r in rows))
    else:
        print("no messages" + ("" if a.state else " waiting"))


def cmd_new(a):
    kinds = ", ".join(KINDS)
    if a.kind not in KINDS:
        refuse("bad-kind", f"'{a.kind}' isn't a message kind.", f"Use one of: {kinds}.")
    frm = a.frm or os.environ.get("FACTORY_AGENT") or ""
    if not frm:
        refuse("needs-from", "I don't know who is writing this message.", "Pass --from <name>, or run it as an agent (FACTORY_AGENT).")
    state = a.state or DEFAULT_STATE.get(a.kind) or "working"
    allowed = {"question": ("submitted",), "mustfix": ("submitted",), "approval": ("completed",),
               "answer": ANSWER_STATES, "status": STATUS_STATES if a.in_reply_to else AGENT_STATES}[a.kind]
    if state not in allowed:
        refuse("bad-state", f"A {a.kind} can't be {state}.", f"Use one of: {', '.join(allowed)}.")
    for flag, value in (("--from", frm), ("--to", a.to)):
        if not NAME.fullmatch(value):
            refuse("bad-name", f"'{value}' isn't a valid name for {flag}.", "Use lowercase letters, digits and dashes, e.g. po or haile.")
    if a.ref and not REF.fullmatch(a.ref):
        refuse("bad-ref", f"'{a.ref}' isn't a ref.", "Use issue#<n> or pr#<n>.")
    if a.kind == "answer" and not a.in_reply_to:
        refuse("needs-in-reply-to", "An answer says which message it replies to.", "Add --in-reply-to <id of the question>.")
    if a.kind in ("mustfix", "approval") and not (a.sha and SHA.fullmatch(a.sha)):
        refuse("needs-sha", f"A {a.kind} names the commit it is for.", "Add --sha <head commit, 7 to 40 hex characters>.")
    m = Message(id=a.id or new_id(), kind=a.kind, frm=frm, to=a.to, state=state, ref=a.ref or "",
                in_reply_to=a.in_reply_to or "", sha=a.sha or "")
    if not ID.fullmatch(m.id):
        refuse("bad-id", f"'{m.id}' isn't a valid message id.", "Use 3 to 40 letters, digits, dashes or underscores, or leave --id out.")
    print(render(m))
    if not a.no_legacy and legacy_line(m):
        print(legacy_line(m))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="factory messages")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("ls", help="open messages across issues and PRs")
    ls.add_argument("--to")
    ls.add_argument("--from", dest="frm")
    ls.add_argument("--state")
    ls.add_argument("--ref", help="an issue or PR number (7, pr#7, issue#103); also reads a closed one")
    ls.add_argument("--kind", default="question", help="question (default), answer, mustfix, approval, status or all")
    ls.add_argument("--all", action="store_true", help="every state, not only open ones")
    ls.add_argument("--json", action="store_true")
    new = sub.add_parser("new", help="print an envelope to paste at the top of a comment")
    new.add_argument("--kind", required=True)
    new.add_argument("--to", default=DEV_MANAGER)
    new.add_argument("--from", dest="frm")
    new.add_argument("--ref")
    new.add_argument("--in-reply-to", dest="in_reply_to")
    new.add_argument("--state")
    new.add_argument("--sha")
    new.add_argument("--id")
    new.add_argument("--no-legacy", action="store_true", help="leave out the old marker line")
    a = ap.parse_args(argv)
    if a.cmd == "ls":
        cmd_ls(a)
    else:
        cmd_new(a)


if __name__ == "__main__":
    main()
