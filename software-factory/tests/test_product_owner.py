#!/usr/bin/env python3
"""The product-owner role's tools (#101): `factory prd` (progress against the PRD), the sign-off and testing queue
(`factory signoff`), the owner-queue asks tagged for=product, and the dry run that prints the digest.

Runs the real factory and hooks in a throwaway project (see test_roles.py) with a fake `claude` and the stateful fake
`gh` of fakegh.py. The sign-off queue's own tests are in signoff.test.ts (#252).   python3 software-factory/tests/test_product_owner.py"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fakegh  # noqa: E402
from test_roles import SF, claude_calls, factory, project  # noqa: E402

sys.path.insert(0, os.path.join(SF, "hooks"))
import factory_prd  # noqa: E402

PRD = """# PRD

## User stories

- US-1: Upload a manual
- US-2: Review the draft guide
### US-3. Publish a guide
- **US-4** Follow a guide offline
- US-4: Follow a guide on a phone
- US-5: Ask the builder helper
"""


def issue(n, title, body="", labels=(), state="open", reason=None):
    return {"number": n, "title": title, "body": body, "state": state, "labels": [{"name": x} for x in labels],
            "state_reason": reason}


TASKS = [
    issue(10, "Upload form", "## Brief\n- **PRD:** US-1\n", state="closed"),
    issue(11, "Upload errors", "PRD: US-1", state="closed"),
    issue(12, "Review screen", "- **PRD:** US-2\n", ["factory:in-progress"]),
    issue(13, "Publish gate", "PRD: US-3", ["factory:ready"]),
    issue(14, "Dropped idea", "PRD: US-5", state="closed", reason="not_planned"),
    issue(15, "Old story", "PRD: US-9", ["factory:ready"]),
    issue(16, "No story named", "## Brief\n- **PRD:** \n", ["factory:ready"]),
]


def po_project(db=None, cfg=None, prd=PRD, files=None):
    d, work, env = project(db=db or {"issues": TASKS}, cfg=cfg, files={"docs/PRD.md": prd, **(files or {})})
    path = os.path.join(d, "bin", "gh")
    open(path, "w").write(fakegh.GH)
    os.chmod(path, 0o755)
    return d, work, env


def posted(d):
    return json.load(open(os.path.join(d, "db.json"))).get("posted", [])


# --- factory prd -----------------------------------------------------------------------------------------------------

def test_a_story_id_starts_a_heading_or_a_list_item_and_a_task_names_its_stories_on_one_line():
    got = factory_prd.parse_stories(PRD)
    assert [(n, t) for n, t, _ in got] == [(1, "Upload a manual"), (2, "Review the draft guide"), (3, "Publish a guide"),
                                          (4, "Follow a guide offline"), (4, "Follow a guide on a phone"),
                                          (5, "Ask the builder helper")], got
    assert factory_prd.story_refs("x\n- **PRD:** US-3, US-5 and US-3\n") == [3, 5]
    assert factory_prd.story_refs("PRD: US-2") == [2] and factory_prd.story_refs("see US-2 in the PRD") == []
    assert factory_prd.story_refs("- **PRD:** \n- **Decisions:** US-7") == []


def test_prd_prints_per_story_its_tasks_and_state_and_how_much_remains():
    d, work, env = po_project()
    p = factory(work, env, "prd")
    assert p.returncode == 0, (p.stdout, p.stderr)
    out = p.stdout
    assert "5 stories: 1 done, 1 in progress, 1 planned, 2 with no task. Tasks: 2 of 4 done." in out, out
    assert "US-1   done" in out and "#10 done, #11 done" not in out, out  # a finished story hides its tasks in the list
    assert "US-2   in progress" in out and "#12 in progress" in out, out
    assert "US-3   planned" in out and "#13 ready" in out, out
    assert "US-5   no task" in out, out  # the closed-as-not-planned task counts for nothing
    assert "US-4 is used by 2 stories (lines 8, 9)" in out, out
    assert "Tasks #15 name US-9, which the PRD does not have." in out, out
    assert not posted(d), "factory prd is read-only"


def test_prd_open_hides_done_stories_and_story_shows_one_with_all_its_tasks():
    d, work, env = po_project()
    out = factory(work, env, "prd", "--open").stdout
    assert "US-1 " not in out and "US-2   in progress" in out, out
    one = factory(work, env, "prd", "--story", "1").stdout
    assert "Upload a manual" in one and "#10 done, #11 done" in one and "US-2" not in one, one
    missing = factory(work, env, "prd", "--story", "99").stdout
    assert "no story US-99" in missing, missing


def test_prd_json_is_the_same_data():
    d, work, env = po_project()
    data = json.loads(factory(work, env, "prd", "--json").stdout)
    assert data["counts"] == {"done": 1, "in progress": 1, "planned": 1, "no task": 2}, data["counts"]
    assert data["duplicates"] == {"4": [8, 9]} and data["unknown"] == {"9": [15]}, data
    assert [r["story"] for r in data["stories"]] == [1, 2, 3, 4, 5]


def test_prd_without_story_ids_or_without_a_prd_says_what_to_do():
    d, work, env = po_project(prd="# PRD\n\n1. Upload a manual\n")
    p = factory(work, env, "prd")
    assert p.returncode != 0 and "US-<n>" in p.stderr and "PRD: US-3" in p.stderr, p.stderr
    d, work, env = po_project(cfg={"prd": "docs/none.md"})
    p = factory(work, env, "prd")
    assert p.returncode != 0 and "docs/none.md does not exist" in p.stderr and "`prd`" in p.stderr, p.stderr


def test_the_task_template_has_the_prd_line():
    text = open(os.path.join(SF, "kit", ".github", "ISSUE_TEMPLATE", "factory-task.md")).read()
    assert "**PRD:** US-" in text, "the template's PRD line shows the form the progress view reads"
    assert factory_prd.story_refs(text.replace("US-<n>", "US-3")) == [3]


# --- the owner queue, for=product ----------------------------------------------------------------------------------------

QUEUE = issue(40, "Dev manager: needs the owner")


def ask(slug, tag="", text="this needs your yes: renumber the PRD stories?"):
    return f"<!-- factory-owner-ask id={slug}{(' ' + tag) if tag else ''} -->\n{text}"


def test_asks_tagged_for_product_are_read_by_the_dev_manager_side_too():
    # (factory_prs's side of this is in prs.test.ts, #252)
    import factory_orchestrator
    body = ask("renumber", "for=product")
    assert factory_orchestrator.ASK_RX.search(body).group(1) == "renumber"
    assert factory_orchestrator.ASK_RX.search("<!-- factory-owner-ask id=a -->x").group(1) == "a"


def test_the_work_list_has_open_product_asks_and_the_queue_but_not_other_asks_or_answered_ones():
    db = {"issues": [QUEUE], "comments": {"40": [
        ask("renumber", "for=product"),
        ask("ci-queued", text="CI is queued"),
        ask("freeze", "for=product", "this needs your yes: freeze phase 3?"),
        "Yes, freeze it.",
        ask("wording", "for=product", "this needs your yes: the warning heading"),
        "<!-- factory-owner-answer id=wording -->\nDone."]}}
    d, work, env = po_project(db=db)
    p = factory(work, env, "product-owner", "loop", "--once", "--dry-run")
    assert p.returncode == 0, (p.stdout, p.stderr)
    out = p.stdout
    assert "[eleni] work: owner queue #40, ask renumber for product: this needs your yes: renumber the PRD stories?" in out, out
    assert "ask ci-queued" not in out and "ask freeze" not in out and "ask wording" not in out, out
    assert "would run: claude -p \"/product-pass\"" in out, out
    assert not claude_calls(env) and not posted(d)


def test_the_dry_run_digest_says_where_the_role_reads_and_what_waits_in_the_queue():
    db = {"issues": [QUEUE, issue(41, "Sign-off and testing queue")], "comments": {"41": [
        "<!-- factory-testplan id=checkout task=13 -->\n1. Open it.",
        "<!-- factory-testplan id=signup task=14 -->\n1. Sign up.",
        "<!-- factory-testplan-confirm id=signup by=boss -->",
        "<!-- factory-signoff id=arabic task=12 -->\nTo check: read it."]}}
    d, work, env = po_project(db=db)
    factory(work, env, "init-roles")
    p = factory(work, env, "product-owner", "loop", "--once", "--dry-run")
    out = p.stdout
    assert "[eleni] reads: .claude/factory/roles/product-owner/ (README.md, reads.md: " in out and "missing" not in out, out
    assert "work: test plan checkout waits for the owner to confirm (queue #41)" in out, out
    assert "work: test plan signup is confirmed and not run yet (queue #41)" in out, out
    assert "work: 1 sign-off item waits for a person (queue #41)" in out, out
    assert not posted(d) and not claude_calls(env)


def test_the_default_reads_md_lists_the_documents_the_project_has():
    d, work, env = po_project()
    factory(work, env, "init-roles")
    reads = open(os.path.join(work, ".claude", "factory", "roles", "product-owner", "reads.md")).read()
    assert "- docs/PRD.md - the PRD: user stories and decisions" in reads and "- CLAUDE.md" in reads, reads
    assert "design" not in "".join(l for l in reads.splitlines() if not l.startswith("#")), "only documents that exist"
    import factory_roles
    assert [p for p, _, _ in factory_roles.parse_reads(reads)] == ["CLAUDE.md", "docs/PRD.md"], reads


def test_without_a_role_folder_the_digest_says_how_to_add_one():
    d, work, env = po_project()
    out = factory(work, env, "product-owner", "loop", "--once", "--dry-run").stdout
    assert "reads: no role folder at .claude/factory/roles/product-owner/" in out and "factory init-roles" in out, out


# --- the skill and the dev manager's skill -------------------------------------------------------------------------------

def test_the_product_pass_skill_exists_and_the_dev_manager_skill_sends_product_asks_to_it():
    skill = open(os.path.join(SF, "kit", ".claude", "skills", "product-pass", "SKILL.md")).read()
    assert skill.startswith("---\nname: product-pass\ndescription: ") and "factory signoff confirm" in skill
    assert "never confirm on your own" in skill and "for=product" in skill
    dm = open(os.path.join(SF, "kit", ".claude", "skills", "manage-pass", "SKILL.md")).read()
    assert "<!-- factory-owner-ask id=<slug> for=product -->" in dm


def test_the_product_owner_profile_may_run_the_prd_and_signoff_commands():
    s = json.load(open(os.path.join(SF, "kit", ".claude", "manager", "settings.json")))["permissions"]["allow"]
    for c in ("factory prd*", "factory signoff*", "./factory prd*", "./factory signoff*"):
        assert f"Bash({c})" in s, c


# --- the watcher after the merge of main (it reads the old question markers through factory_wait) --------------------------

def test_the_watcher_still_sees_an_old_style_question_on_a_pull_request():
    pr = {"number": 7, "title": "x", "draft": False, "head": {"sha": "a" * 40, "ref": "task/5-x"}, "user": {"login": "me"},
          "labels": []}
    d, work, env = po_project(db={"pulls": [pr], "issues": [dict(issue(7, "x"), pull_request={})],
                                  "comments": {"7": ["<!-- factory-question -->\nWhich colour?"]}})
    p = factory(work, env, "watch", "--json")
    assert p.returncode in (0, 3), (p.stdout, p.stderr)
    kinds = [(i["kind"], i["ref"]) for i in json.loads(p.stdout)]
    assert ("question", "question-7") in kinds, kinds
