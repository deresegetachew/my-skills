#!/usr/bin/env python3
"""The factory's messages (#107): the A2A-shaped envelope, its states and transitions, old markers still read,
`factory messages ls|new`, and the agent card.  python3 software-factory/tests/test_messages.py

The library is imported directly; the commands run against a fake `gh` on PATH that reads a JSON file."""
import json, os, subprocess, sys, tempfile

SF = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(SF, "hooks"))
import factory_messages as fm  # noqa: E402
import factory_cards as fc  # noqa: E402

FACTORY = os.path.join(SF, "factory")
HOOK = os.path.join(SF, "hooks", "factory_messages.py")

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, re, sys
from urllib.parse import urlparse, parse_qs
db = json.load(open(os.environ["FAKE_DB"])); a = sys.argv[1:]
open(os.environ["FAKE_LOG"], "a").write(" ".join(a) + "\n")
if a[:1] != ["api"]: sys.exit("fake gh: only gh api")
path = [x for x in a[1:] if not x.startswith("-") and x not in ("GET", "Accept: application/vnd.github+json")][0]
u = urlparse(path.replace("repos/{owner}/{repo}/", "")); p = u.path; q = parse_qs(u.query); page = int(q.get("page", ["1"])[0])
def out(x): print(json.dumps(x)); sys.exit(0)
def paged(x): out(x if page == 1 else [])
if p == "issues": paged([i for i in db["items"] if i["state"] == q.get("state", ["open"])[0]])
m = re.fullmatch(r"issues/(\d+)", p)
if m:
    for i in db["items"]:
        if str(i["number"]) == m.group(1): out(i)
    sys.exit("gh: Not Found (HTTP 404)")
m = re.fullmatch(r"issues/(\d+)/comments", p)
if m: paged(db.get("comments", {}).get(m.group(1), []))
sys.exit("fake gh: no route for " + p)
'''


def item(n, title="t", pr=False, labels=(), state="open", comments=1):
    d = {"number": n, "title": title, "state": state, "comments": comments, "labels": [{"name": x} for x in labels],
         "html_url": f"https://github.test/r/{n}", "body": ""}
    if pr:
        d["pull_request"] = {"url": "x"}
    return d


def comment(cid, body, login="me", at="2026-10-25T10:00:00Z"):
    return {"id": cid, "body": body, "user": {"login": login}, "created_at": at, "html_url": f"https://github.test/c/{cid}"}


def env_msg(**kw):
    """The envelope comment text for the attributes given (v=1 unless said)."""
    kw.setdefault("v", "1")
    return "<!-- factory-msg " + " ".join(f"{k.replace('_', '-')}={v}" for k, v in kw.items()) + " -->"


def world(items, comments, **extra):
    d = tempfile.mkdtemp()
    os.makedirs(f"{d}/bin")
    os.makedirs(f"{d}/.claude")
    open(f"{d}/bin/gh", "w").write(FAKE_GH)
    os.chmod(f"{d}/bin/gh", 0o755)
    json.dump({}, open(f"{d}/.claude/factory.json", "w"))
    json.dump({"items": items, "comments": comments}, open(f"{d}/db.json", "w"))
    env = {k: v for k, v in os.environ.items() if k != "FACTORY_AGENT"}
    env.update({"PATH": f"{d}/bin:{os.environ['PATH']}", "FAKE_DB": f"{d}/db.json", "FAKE_LOG": f"{d}/log", **extra})
    return d, env


def run(d, env, *args, tool="hook"):
    cmd = [sys.executable, HOOK, *args] if tool == "hook" else ["bash", FACTORY, "messages", *args]
    p = subprocess.run(cmd, cwd=d, env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def msgs(text, login="me", cid=1):
    return fm.parse_comment({"id": cid, "body": text, "user": {"login": login}})


def one(text, **kw):
    found = msgs(text, **kw)
    assert len(found) == 1, found
    return found[0]


# --- the envelope ---------------------------------------------------------------------------------------------------

def test_an_envelope_round_trips_through_render_and_parse():
    m = fm.Message(id="01abc23def", kind="question", frm="haile", to="po", state="submitted", ref="issue#103",
                   in_reply_to="01abc00000", sha="a" * 40)
    text = fm.render(m)
    assert text.startswith("<!-- factory-msg v=1 id=01abc23def kind=question from=haile to=po state=submitted ")
    back = one(text + "\nWhich colour?")
    assert (back.id, back.kind, back.frm, back.to, back.state, back.ref, back.in_reply_to, back.sha) == \
           ("01abc23def", "question", "haile", "po", "submitted", "issue#103", "01abc00000", "a" * 40)
    assert back.summary == "Which colour?" and not back.legacy


def test_an_envelope_may_span_lines_and_list_its_attributes_in_any_order():
    m = one("<!-- factory-msg v=1 id=q1x kind=question\n     state=submitted from=haile to=po\n     ref=pr#7 -->\nText")
    assert (m.id, m.to, m.ref) == ("q1x", "po", "pr#7")


def test_to_defaults_to_the_dev_manager_and_a_question_starts_submitted():
    m = one(env_msg(id="q1x", kind="question", **{"from": "haile"}))
    assert m.to == "dev-manager" and m.state == "submitted"


def test_unknown_future_versions_and_malformed_envelopes_are_ignored_not_fatal():
    assert msgs(env_msg(v="2", id="q1x", kind="question", **{"from": "haile"})) == []
    assert msgs(env_msg(id="q1x", kind="shout", **{"from": "haile"})) == []            # unknown kind
    assert msgs(env_msg(id="q1x", kind="question", state="sleeping")) == []             # unknown state
    assert msgs(env_msg(kind="question", **{"from": "haile"})) == []                    # no id
    assert msgs(env_msg(id="q1x", kind="question", to="Bad Name")) == []                # not an agent name
    assert msgs("<!-- factory-msg v=1 id=q1x kind=question ") == []                       # never closed
    assert msgs("") == [] and msgs(None) == []


def test_a_future_version_with_a_legacy_marker_line_still_counts_as_the_legacy_message():
    m = one(env_msg(v="2", id="q1x", kind="question") + "\n<!-- factory-question -->\nWhich?")
    assert m.legacy and m.kind == "question"


def test_the_old_markers_parse_as_messages():
    q = one("<!-- factory-question -->\nWhich one?", cid=41)
    assert (q.kind, q.state, q.to, q.legacy, q.id) == ("question", "submitted", "dev-manager", True, "c41")
    a = one("<!-- factory-answer -->\nThis one.", cid=42)
    assert (a.kind, a.state, a.frm, a.legacy) == ("answer", "completed", "dev-manager", True)
    f = one("<!-- factory-answer -->\nneeds-owner: the name is theirs", cid=43)
    assert f.state == "failed"
    mf = one("<!-- factory-mustfix sha=abc1234 -->\nFix x", cid=44)
    assert (mf.kind, mf.sha) == ("mustfix", "abc1234")
    ok = one("<!-- factory-approved sha=abc1234 -->", cid=45)
    assert (ok.kind, ok.sha, ok.state) == ("approval", "abc1234", "completed")


def test_an_envelope_wins_over_the_legacy_line_in_the_same_comment():
    found = msgs(env_msg(id="a1x", kind="answer", **{"from": "po"}, to="haile", state="completed",
                         in_reply_to="q1x") + "\n<!-- factory-answer -->\nUse blue.")
    assert len(found) == 1 and not found[0].legacy and found[0].frm == "po"


def test_verdicts_read_both_forms():
    assert fm.verdicts("<!-- factory-mustfix sha=abc1234 -->") == [("mustfix", "abc1234")]
    assert fm.verdicts("<!-- factory-approved sha=abc1234 -->") == [("approved", "abc1234")]
    both = env_msg(id="m1x", kind="mustfix", **{"from": "dev-manager"}, sha="abc1234") + "\n<!-- factory-mustfix sha=abc1234 -->"
    assert fm.verdicts(both) == [("mustfix", "abc1234")]                                 # not counted twice
    assert fm.verdicts(env_msg(id="p1x", kind="approval", **{"from": "dev-manager"}, sha="def5678")) == [("approved", "def5678")]
    assert fm.verdicts("<!-- factory-mustfix -->") == [("mustfix", None)]
    assert fm.verdicts("nothing") == []


def test_new_ids_are_short_unique_and_valid():
    ids = {fm.new_id() for _ in range(200)}
    assert len(ids) == 200 and all(8 <= len(i) <= 16 and fm.ID.fullmatch(i) for i in ids)


# --- states and transitions -----------------------------------------------------------------------------------------

def q(id="q1x", frm="haile", to="po", **kw):
    return fm.Message(id=id, kind="question", frm=frm, to=to, state="submitted", **kw)


def reply(id, kind, state, frm, to, of="q1x", **kw):
    return fm.Message(id=id, kind=kind, frm=frm, to=to, state=state, in_reply_to=of, **kw)


def state(thread, id="q1x"):
    return thread.tasks[id].state


def test_the_state_names_are_a2a_task_states():
    assert fm.STATES == ("submitted", "working", "input-required", "completed", "failed", "canceled")
    assert fm.OPEN == ("submitted", "working", "input-required")
    assert set(fm.TRANSITIONS["completed"]) == set() and set(fm.TRANSITIONS["failed"]) == set()


def test_submitted_to_working_to_completed():
    t = fm.fold([q(), reply("s1x", "status", "working", "po", "haile"), reply("a1x", "answer", "completed", "po", "haile")])
    assert state(t) == "completed" and t.rejected == [] and t.tasks["q1x"].answer.id == "a1x"
    assert [h[0] for h in t.tasks["q1x"].history] == ["submitted", "working", "completed"]


def test_an_answer_may_complete_a_submitted_question_directly():
    t = fm.fold([q(), reply("a1x", "answer", "completed", "po", "haile")])
    assert state(t) == "completed"


def test_input_required_is_a_clarification_going_back_and_the_asker_resumes_it():
    t = fm.fold([q(), reply("s1x", "status", "input-required", "po", "haile"),
                 reply("s2x", "status", "working", "haile", "po", of="s1x"),     # replies to the clarification message
                 reply("a1x", "answer", "completed", "po", "haile")])
    assert state(t) == "completed" and t.rejected == []


def test_failed_is_an_answer_that_could_not_be_given_here():
    t = fm.fold([q(), reply("a1x", "answer", "failed", "po", "haile")])
    assert state(t) == "failed" and not t.tasks["q1x"].is_open


def test_only_the_asker_cancels_and_only_the_addressee_answers():
    t = fm.fold([q(), reply("c1x", "status", "canceled", "po", "haile")])
    assert state(t) == "submitted" and "asker" in t.rejected[0][1]
    t = fm.fold([q(), reply("c1x", "status", "canceled", "haile", "po")])
    assert state(t) == "canceled"
    t = fm.fold([q(), reply("a1x", "answer", "completed", "taytu", "haile")])            # someone else answers
    assert state(t) == "submitted" and "addressed to po" in t.rejected[0][1]


def test_a_trusted_login_may_complete_a_question_addressed_to_someone_else():
    answer = reply("a1x", "answer", "completed", "dev-manager", "haile", login="owner-login")
    t = fm.fold([q(), answer], trusted={"owner-login"})
    assert state(t) == "completed"
    t = fm.fold([q(), answer], trusted={"someone-else"})
    assert state(t) == "submitted"


def test_invalid_transitions_are_rejected_with_the_reason():
    t = fm.fold([q(), reply("a1x", "answer", "completed", "po", "haile"), reply("s1x", "status", "working", "po", "haile")])
    assert state(t) == "completed" and "completed" in t.rejected[0][1]
    t = fm.fold([q(), reply("s1x", "status", "completed", "po", "haile")])                # completing is an answer
    assert state(t) == "submitted" and t.rejected
    t = fm.fold([q(), reply("s1x", "status", "submitted", "po", "haile")])                # never back to submitted
    assert state(t) == "submitted" and t.rejected
    assert fm.can_move("submitted", "working") and not fm.can_move("completed", "working")
    assert fm.can_move("working", "working")                                              # a repeat is a no-op, not invalid


def test_a_reply_to_nothing_is_rejected_and_never_creates_a_task():
    t = fm.fold([reply("a1x", "answer", "completed", "po", "haile", of="nope")])
    assert t.tasks == {} and "nope" in t.rejected[0][1]


def test_reposting_a_message_changes_nothing():
    answer = reply("a1x", "answer", "completed", "po", "haile")
    once = fm.fold([q(), answer])
    twice = fm.fold([q(), answer, answer, q()])
    assert state(once) == state(twice) == "completed"
    assert twice.rejected == [] and [m.id for m in twice.duplicates] == ["a1x", "q1x"]
    assert len(twice.tasks["q1x"].history) == len(once.tasks["q1x"].history)


def test_a_legacy_answer_completes_every_open_question_to_the_dev_manager_and_no_other():
    legacy_q = fm.Message(id="c1", kind="question", frm="", to="dev-manager", state="submitted", legacy=True)
    to_dm = q("q2x", to="dev-manager")
    to_po = q("q3x", to="po")
    legacy_a = fm.Message(id="c9", kind="answer", frm="dev-manager", to="", state="completed", legacy=True)
    t = fm.fold([legacy_q, to_dm, to_po, legacy_a])
    assert state(t, "c1") == "completed" and state(t, "q2x") == "completed" and state(t, "q3x") == "submitted"
    again = fm.fold([legacy_a, legacy_q])                                                 # a later question is open again
    assert state(again, "c1") == "submitted"


def test_open_filters_by_addressee_state_and_ref():
    t = fm.fold([q("q1x", to="po", ref="issue#103"), q("q2x", to="dev-manager", ref="pr#7"),
                 reply("s1x", "status", "input-required", "dev-manager", "haile", of="q2x")])
    assert [x.id for x in fm.select(t.tasks.values(), to="po")] == ["q1x"]
    assert [x.id for x in fm.select(t.tasks.values(), state="input-required")] == ["q2x"]
    assert [x.id for x in fm.select(t.tasks.values(), ref="7")] == ["q2x"]
    assert [x.id for x in fm.select(t.tasks.values(), ref="pr#7")] == ["q2x"]
    assert len(fm.select(t.tasks.values())) == 2


# --- what the PR gate asks of a new message -------------------------------------------------------------------------

def test_a_new_message_is_checked_against_its_thread():
    t = fm.fold([q(to="taytu")])
    ok = reply("a1x", "answer", "completed", "taytu", "haile")
    assert fm.check_new(ok, t, me="taytu") is None
    assert "yourself" in fm.check_new(ok, t, me="menelik")                                 # from= must be the poster
    stolen = reply("a1x", "answer", "completed", "po", "haile")
    assert "yourself" in fm.check_new(stolen, t, me="taytu")
    other = fm.fold([q(to="po")])
    assert "addressed to po" in fm.check_new(reply("a1x", "answer", "completed", "taytu", "haile"), other, me="taytu")
    assert "reserved" in fm.check_new(fm.Message(id="p1x", kind="approval", frm="taytu", state="completed", sha="abc1234"), t, me="taytu")
    assert "reserved" in fm.check_new(fm.Message(id="p1x", kind="mustfix", frm="taytu", state="submitted", sha="abc1234"), t, me="taytu")
    assert "can't find" in fm.check_new(reply("a1x", "answer", "completed", "taytu", "haile", of="zzz"), t, me="taytu")
    assert "in-reply-to" in fm.check_new(fm.Message(id="a1x", kind="answer", frm="taytu", state="completed"), t, me="taytu")
    done = fm.fold([q(to="taytu"), reply("a0x", "answer", "completed", "taytu", "haile")])
    assert "completed" in fm.check_new(reply("a1x", "answer", "failed", "taytu", "haile"), done, me="taytu")
    asked = fm.Message(id="q9x", kind="question", frm="taytu", to="po", state="submitted")
    assert fm.check_new(asked, t, me="taytu") is None
    assert "submitted" in fm.check_new(fm.Message(id="q9x", kind="question", frm="taytu", to="po", state="completed"), t, me="taytu")
    status = fm.Message(id="agent-taytu", kind="status", frm="taytu", state="input-required")
    assert fm.check_new(status, t, me="taytu") is None


# --- the commands ---------------------------------------------------------------------------------------------------

def thread_world(**extra):
    items = [item(103, "Task issue"), item(7, "A PR", pr=True), item(9, "Agent: haile", labels=["factory:agent"]),
             item(11, "Quiet", comments=0), item(5, "Old", state="closed")]
    comments = {
        "103": [comment(1, env_msg(id="q1x", kind="question", **{"from": "haile"}, to="po", state="submitted", ref="issue#103") + "\nWhich colour?", at="2026-10-25T09:00:00Z"),
                comment(2, env_msg(id="q2x", kind="question", **{"from": "taytu"}, to="po", state="submitted") + "\nWhich font?"),
                comment(3, env_msg(id="a2x", kind="answer", **{"from": "po"}, to="taytu", state="completed", in_reply_to="q2x") + "\nSerif.")],
        "7": [comment(4, "<!-- factory-question -->\nSplit the PR?"),
              comment(5, env_msg(id="q4x", kind="question", **{"from": "menelik"}, to="dev-manager") + "\nWhich branch?"),
              comment(6, env_msg(id="s4x", kind="status", **{"from": "dev-manager"}, to="menelik", state="input-required", in_reply_to="q4x") + "\nWhich one do you mean?")],
        "9": [comment(7, env_msg(id="q5x", kind="question", **{"from": "haile"}) + "\nNoise on an agent issue")],
        "5": [comment(8, env_msg(id="q6x", kind="question", **{"from": "haile"}, to="owner") + "\nOn a closed item")],
    }
    return world(items, comments, **extra)


def test_ls_lists_open_questions_across_issues_and_prs():
    d, env = thread_world()
    rc, out, err = run(d, env, "ls")
    assert rc == 0, err
    assert "q1x" in out and "haile -> po" in out and "issue#103" in out and "Which colour?" in out
    assert "c4" in out and "pr#7" in out and "Split the PR?" in out                      # the old marker, shown as a message
    assert "q4x" in out and "input-required" in out
    assert "q2x" not in out                                                              # answered
    assert "q5x" not in out and "q6x" not in out                                         # agent issues and closed items are skipped
    log = open(f"{d}/log").read()
    assert "issues/11/comments" not in log                                               # an item with no comments costs no call


def test_ls_filters_by_addressee_state_and_ref():
    d, env = thread_world()
    rc, out, _ = run(d, env, "ls", "--to", "po")
    assert rc == 0 and "q1x" in out and "q4x" not in out and "c4" not in out
    rc, out, _ = run(d, env, "ls", "--state", "input-required")
    assert "q4x" in out and "q1x" not in out
    rc, out, _ = run(d, env, "ls", "--ref", "7")
    assert "q4x" in out and "c4" in out and "q1x" not in out
    rc, out, _ = run(d, env, "ls", "--ref", "pr#7", "--to", "menelik")
    assert "no messages" in out
    rc, out, _ = run(d, env, "ls", "--ref", "5", "--state", "submitted")                  # a closed item, named directly
    assert "q6x" in out
    rc, out, _ = run(d, env, "ls", "--state", "completed")                                # terminal states are asked for by name
    assert "q2x" in out and "q1x" not in out


def test_ls_json_and_all():
    d, env = thread_world()
    rc, out, _ = run(d, env, "ls", "--json", "--all")
    rows = json.loads(out)
    by = {r["id"]: r for r in rows}
    assert by["q2x"]["state"] == "completed" and by["q1x"]["to"] == "po" and by["q1x"]["ref"] == "issue#103"
    assert by["c4"]["legacy"] is True and by["c4"]["from"] == "" and by["c4"]["url"].endswith("/c/4")


def test_ls_with_nothing_open_says_so_and_exits_zero():
    d, env = world([item(1)], {"1": [comment(1, "just talking")]})
    rc, out, _ = run(d, env, "ls")
    assert rc == 0 and "no messages" in out


def test_ls_bad_arguments_answer_with_code_message_fix():
    d, env = thread_world()
    rc, out, err = run(d, env, "ls", "--state", "sleeping")
    assert rc == 1
    e = json.loads(err)
    assert e["code"] == "bad-state" and "completed" in e["fix"]


def test_ls_reads_agent_status_with_kind_status():
    body = ("<!-- factory-agent name=haile status=working ping=2026-10-25T10:00:00Z -->\n"
            + env_msg(id="agent-haile", kind="status", **{"from": "haile"}, to="dev-manager", state="input-required") + "\nx")
    ag = item(9, "Agent: haile", labels=["factory:agent"])
    ag["body"] = body
    d, env = world([ag], {})
    rc, out, _ = run(d, env, "ls", "--kind", "status")
    assert rc == 0 and "agent-haile" in out and "input-required" in out
    rc, out, _ = run(d, env, "ls", "--kind", "status", "--state", "idle")
    assert "no messages" in out


def test_new_prints_an_envelope_and_the_old_marker():
    d, env = world([], {}, FACTORY_AGENT="haile")
    rc, out, err = run(d, env, "new", "--kind", "question", "--to", "po", "--ref", "issue#103")
    assert rc == 0, err
    lines = out.splitlines()
    m = fm.parse_comment({"id": 1, "body": out, "user": {"login": "x"}})
    assert len(m) == 1 and m[0].frm == "haile" and m[0].to == "po" and m[0].state == "submitted" and m[0].ref == "issue#103"
    assert lines[1] == "<!-- factory-question -->"
    rc, out2, _ = run(d, env, "new", "--kind", "question", "--no-legacy")
    assert out2.count("\n") == 0 and "factory-question" not in out2 and "to=dev-manager" in out2
    rc, out3, _ = run(d, env, "new", "--kind", "answer", "--in-reply-to", "q1x", "--to", "haile")
    assert "state=completed" in out3.splitlines()[0] and "in-reply-to=q1x" in out3 and out3.splitlines()[1] == "<!-- factory-answer -->"
    rc, out4, _ = run(d, env, "new", "--kind", "answer", "--in-reply-to", "q1x", "--to", "haile", "--state", "failed")
    assert "state=failed" in out4


def test_new_refuses_bad_input_with_code_message_fix():
    d, env = world([], {}, FACTORY_AGENT="haile")
    for args, code in ((("--kind", "shout"), "bad-kind"), (("--kind", "answer"), "needs-in-reply-to"),
                       (("--kind", "question", "--to", "Bad Name"), "bad-name"),
                       (("--kind", "question", "--state", "completed"), "bad-state"),
                       (("--kind", "mustfix"), "needs-sha")):
        rc, out, err = run(d, env, "new", *args)
        assert rc == 1, args
        e = json.loads(err)
        assert e["code"] == code and e["message"] and e["fix"], (args, e)
    env2 = {k: v for k, v in env.items() if k != "FACTORY_AGENT"}
    rc, out, err = run(d, env2, "new", "--kind", "question")
    assert rc == 1 and json.loads(err)["code"] == "needs-from"


def test_the_factory_command_runs_messages():
    d, env = thread_world()
    subprocess.run(["git", "init", "-q", d], check=True)
    os.symlink(os.path.join(SF, "hooks"), f"{d}/.claude/hooks")
    p = subprocess.run(["bash", FACTORY, "messages", "ls", "--to", "po"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 0 and "q1x" in p.stdout, p.stderr
    p = subprocess.run(["bash", FACTORY, "help"], cwd=d, env=env, capture_output=True, text=True)
    assert "messages" in p.stdout


# --- agent status and cards ------------------------------------------------------------------------------------------

def test_agent_status_uses_the_message_states_and_the_issue_carries_an_envelope():
    sys.path.insert(0, os.path.join(SF, "hooks"))
    import factory_agents as fa
    title, body = fa.render("haile", "input-required", "", "2026-10-25T09:00:00Z", machine="m1")
    assert title == "Agent: haile · input-required"
    assert fa.MARK.search(body).groups()[:2] == ("haile", "input-required")               # the old marker still reads
    m = fm.parse_comment({"id": 1, "body": body, "user": {"login": "x"}})
    assert len(m) == 1 and m[0].kind == "status" and m[0].frm == "haile" and m[0].state == "input-required"
    assert m[0].id == "agent-haile"
    title, body = fa.render("haile", "idle", "", "2026-10-25T09:00:00Z")
    assert fm.parse_comment({"id": 1, "body": body})[0].state == "idle"


def test_status_vocabulary_is_the_task_one_plus_idle_and_down():
    assert set(fm.AGENT_STATES) == {"working", "idle", "down", "input-required"}


def test_a_card_has_the_fields_an_agent_would_publish():
    c = fc.card("haile", state="working", machine_id="m1", version="1.2.3")
    assert c == {"name": "haile", "kind": "coding-agent", "skills": ["build-tasks"], "state": "working",
                 "location": "machine", "machine": "m1", "follow": "remote-control:haile", "version": "1.2.3",
                 "lastPing": None}
    dm = fc.card("dev-manager", state="idle")
    assert dm["kind"] == "dev-manager" and dm["location"] == "cloud" and dm["follow"] is None
    assert "answer-process-questions" in dm["skills"]
    po = fc.card("po", state="working")
    assert po["kind"] == "po" and "answer-product-questions" in po["skills"]


def test_agents_list_renders_from_the_cards():
    import factory_agents as fa
    title, body = fa.render("haile", "working", "working on #3", "2026-10-25T09:00:00Z", machine="m1")
    issue = {"number": 5, "title": title, "body": body, "state": "open", "labels": []}
    cards = fc.cards({}, [issue], version="9.9.9")
    assert [c["name"] for c in cards] == ["haile"] and cards[0]["state"] in ("working", "silent")
    assert cards[0]["version"] == "9.9.9" and cards[0]["location"] == "machine" and cards[0]["machine"] == "m1"
    line = fc.row(cards[0])
    assert line.startswith("haile") and f"last ping {cards[0]['lastPing']}" in line and "machine m1" in line


if __name__ == "__main__":
    bad = 0
    for k, v in sorted(globals().items()):
        if k.startswith("test_") and callable(v):
            try:
                v()
                print("ok", k)
            except Exception as e:  # noqa: BLE001
                bad += 1
                print("FAIL", k, repr(e))
    sys.exit(1 if bad else 0)
