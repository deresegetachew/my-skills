#!/usr/bin/env python3
"""The dev manager's standing rules, settings profile and merge gate (#96).  python3 software-factory/tests/test_manager_gate.py

The gate runs as Claude Code runs a PreToolUse hook (the tool call as JSON on stdin; exit 2 blocks) against a fake `gh`
that reads one JSON file. The profile and the skill are read as files."""
import json, os, re, shutil, subprocess, sys, tempfile

SF = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
GATE = os.path.join(SF, "hooks", "manager_gate.py")
KIT = os.path.join(SF, "kit")
PROFILE = os.path.join(KIT, ".claude", "manager", "settings.json")
SKILL = os.path.join(KIT, ".claude", "skills", "manage-pass", "SKILL.md")

HEAD = "a" * 40
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, re, sys
from urllib.parse import urlparse, parse_qs
db = json.load(open(os.environ["FAKE_DB"])); a = sys.argv[1:]
if a[:2] == ["repo", "view"]: print("main"); sys.exit(0)
if a[:1] != ["api"]: sys.exit("fake gh: only gh api")
path = [x for x in a[1:] if not x.startswith("-") and "/" in x and not x.startswith("Accept")][0]
if path.startswith("repos/{owner}/{repo}/contents/.claude/factory.json"): print(json.dumps(db.get("factory", {}))); sys.exit(0)
u = urlparse(path.replace("repos/{owner}/{repo}/", "")); p = u.path; q = parse_qs(u.query); page = int(q.get("page", ["1"])[0])
def out(x): print(json.dumps(x)); sys.exit(0)
if db.get("down"): sys.exit("HTTP 500")
m = re.fullmatch(r"pulls/(\d+)", p)
if m: out(db["pulls"][m.group(1)])
m = re.fullmatch(r"issues/(\d+)/comments", p)
if m: out(db["comments"].get(m.group(1), []) if page == 1 else [])
m = re.fullmatch(r"commits/(\w+)/check-runs", p)
if m: out({"check_runs": db.get("runs", []), "total_count": len(db.get("runs", []))})
m = re.fullmatch(r"commits/(\w+)/status", p)
if m: out({"statuses": db.get("statuses", []), "total_count": 0})
sys.exit("fake gh: no route for " + p)
'''


def comment(body, login="me"):
    return {"body": body, "user": {"login": login}}


def run_ok(name, at="2026-10-25T10:00:00Z", started=None, conclusion="success", status="completed", id_=1):
    return {"id": id_, "name": name, "status": status, "conclusion": conclusion, "started_at": started or at}


def world(pr=None, comments=None, runs=None, statuses=None, down=False, cfg=None):
    d = tempfile.mkdtemp()
    os.makedirs(f"{d}/bin")
    os.makedirs(f"{d}/.claude")
    json.dump(cfg or {}, open(f"{d}/.claude/factory.json", "w"))
    open(f"{d}/bin/gh", "w").write(FAKE_GH)
    os.chmod(f"{d}/bin/gh", 0o755)
    pull = {"state": "open", "head": {"sha": HEAD, "ref": "task/12-guard-rails"}, "body": "Closes #12", **(pr or {})}
    db = {"pulls": {"7": pull}, "comments": {"7": comments if comments is not None else
                                              [comment(f"<!-- factory-approved sha={HEAD[:12]} -->\nLooks good.")]},
          "runs": runs if runs is not None else [run_ok("test"), run_ok("lint")], "statuses": statuses or [], "down": down,
          "factory": cfg or {}}
    json.dump(db, open(f"{d}/db.json", "w"))
    subprocess.run(["git", "init", "-q", d], check=True)
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "FAKE_DB": f"{d}/db.json", "CLAUDE_PROJECT_DIR": d}
    return d, env


def gate(d, env, command):
    p = subprocess.run([sys.executable, GATE], cwd=d, env=env, input=json.dumps({"tool_input": {"command": command}}),
                       capture_output=True, text=True, timeout=60)
    return p.returncode, p.stderr.strip()


MERGE = "gh api -X PUT repos/{owner}/{repo}/pulls/7/merge -f merge_method=merge -f sha=%s"


def refused(d, env, command, *words):
    rc, err = gate(d, env, command)
    assert rc == 2, (command, rc, err)
    for w in words:
        assert w.lower() in err.lower(), (w, err)
    assert "owner-queue ask" in err or "must-fix" in err or "Wait" in err or "Run gh" in err or "unbalanced" in err, err
    return err


def allowed(d, env, command):
    rc, err = gate(d, env, command)
    assert rc == 0, (command, rc, err)


# --- merges -----------------------------------------------------------------------------------------------------------

def test_a_merge_of_an_approved_head_with_green_ci_is_allowed():
    d, env = world()
    allowed(d, env, MERGE % HEAD)
    allowed(d, env, MERGE % HEAD[:12])  # a short sha that is the head's prefix
    allowed(d, env, f"gh pr merge 7 --merge --match-head-commit {HEAD}")


def test_a_merge_pinned_to_another_sha_is_refused():
    d, env = world()
    refused(d, env, MERGE % ("b" * 40), "moved on", HEAD[:12])


def test_a_merge_that_is_not_pinned_is_refused():
    d, env = world()
    refused(d, env, "gh api -X PUT repos/{owner}/{repo}/pulls/7/merge -f merge_method=merge", "pin the merge")
    refused(d, env, "gh pr merge 7 --merge", "pin the merge")


def test_an_unapproved_pr_is_refused():
    d, env = world(comments=[comment("Looks fine to me")])
    refused(d, env, MERGE % HEAD, "no `<!-- factory-approved")
    d, env = world(comments=[])
    refused(d, env, MERGE % HEAD, "no `<!-- factory-approved")


def test_an_approval_for_an_older_commit_is_refused():
    d, env = world(comments=[comment("<!-- factory-approved sha=" + "c" * 12 + " -->")])
    refused(d, env, MERGE % HEAD, "approval is for " + "c" * 12)


def test_a_must_fix_after_the_approval_holds_the_merge_and_an_approval_after_it_releases_it():
    ok = f"<!-- factory-approved sha={HEAD[:12]} -->"
    d, env = world(comments=[comment(ok), comment("<!-- factory-mustfix sha=" + HEAD[:12] + " -->\nfix x")])
    refused(d, env, MERGE % HEAD, "latest marker is a must-fix")
    d, env = world(comments=[comment("<!-- factory-mustfix sha=" + "c" * 12 + " -->"), comment(ok)])
    allowed(d, env, MERGE % HEAD)


def test_the_managers_own_pr_is_refused_by_its_branch_or_its_marker():
    d, env = world(pr={"head": {"sha": HEAD, "ref": "manager/fasil-fix-ci"}})
    refused(d, env, MERGE % HEAD, "opened", "owner")
    d, env = world(pr={"body": "Fix.\n<!-- factory-role role=dev-manager name=fasil -->"})
    refused(d, env, MERGE % HEAD, "opened")


def test_only_trusted_logins_approvals_count_when_main_names_them():
    mark = f"<!-- factory-approved sha={HEAD[:12]} -->"
    d, env = world(cfg={"trustedReviewers": ["owner"]}, comments=[comment(mark, "intruder")])
    refused(d, env, MERGE % HEAD, "no `<!-- factory-approved")
    d, env = world(cfg={"trustedReviewers": ["owner"]}, comments=[comment(mark, "intruder"), comment(mark, "owner")])
    allowed(d, env, MERGE % HEAD)


def test_ci_is_judged_by_the_newest_non_skipped_run_per_job():
    runs = [run_ok("test", started="2026-10-25T09:00:00Z", conclusion="failure", id_=1),
            run_ok("test", started="2026-10-25T09:10:00Z", conclusion="success", id_=2),   # the re-run passed
            run_ok("lint", started="2026-10-25T09:00:00Z", conclusion="success", id_=3),
            run_ok("lint", started="2026-10-25T09:20:00Z", conclusion="skipped", id_=4),   # a skipped run counts for nothing
            run_ok("deploy", conclusion="skipped", id_=5)]
    d, env = world(runs=runs)
    allowed(d, env, MERGE % HEAD)


def test_failed_pending_and_missing_ci_are_not_green():
    d, env = world(runs=[run_ok("test", conclusion="failure"), run_ok("lint")])
    refused(d, env, MERGE % HEAD, "CI failed", "test")
    d, env = world(runs=[run_ok("test", status="in_progress", conclusion=None), run_ok("lint")])
    refused(d, env, MERGE % HEAD, "still running", "factory wait ci 7")
    d, env = world(runs=[])
    refused(d, env, MERGE % HEAD, "no CI runs")
    d, env = world(runs=[run_ok("test")], statuses=[{"id": 1, "context": "ci/legacy", "state": "failure"}])
    refused(d, env, MERGE % HEAD, "ci/legacy")


def test_a_merge_of_a_closed_pr_is_left_to_github():
    d, env = world(pr={"state": "closed"}, comments=[])
    allowed(d, env, MERGE % HEAD)


def test_when_github_cannot_be_read_the_merge_is_refused():
    d, env = world(down=True)
    refused(d, env, MERGE % HEAD, "could not read")


def test_a_merge_sha_the_shell_would_expand_is_refused():
    d, env = world()
    refused(d, env, "gh api -X PUT repos/{owner}/{repo}/pulls/7/merge -f sha=$(git rev-parse HEAD)", "plain text")
    refused(d, env, "gh api -X PUT repos/{owner}/{repo}/pulls/7/merge --input body.json", "plain text")


# --- refs, history, protected places ------------------------------------------------------------------------------------

def test_force_pushes_and_ref_deletions_are_refused():
    d, env = world()
    for cmd, word in (("git push --force origin fix", "force"), ("git push -f origin fix", "force"),
                      ("git push --force-with-lease origin fix", "force"), ("git push origin +fix:fix", "force"),
                      ("git push origin :old-branch", "delete"), ("git push origin --delete old-branch", "delete"),
                      ("git push -d origin old-branch", "delete"), ("git branch -D old", "delete"),
                      ("git tag -d v1", "delete"), ("git update-ref -d refs/heads/x", "delete"),
                      ("git push origin HEAD:main", "main branch"), ("git push origin main", "main branch"),
                      ("git -C /tmp/x push --force origin fix", "force"),
                      ("gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/old", "refs"),
                      ("gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/x -f sha=1 -F force=true", "refs")):
        refused(d, env, cmd, word)


def test_github_content_and_branch_protection_cannot_be_written_but_can_be_read():
    d, env = world()
    for cmd, word in (("gh api -X PUT repos/{owner}/{repo}/contents/.github/workflows/ci.yml -f message=x", ".github"),
                      ("gh api repos/{owner}/{repo}/contents/.github/CODEOWNERS -f message=x -f content=eA==", ".github"),
                      ("gh api -X DELETE repos/{owner}/{repo}/contents/.github/CODEOWNERS", ".github"),
                      ("gh api -X PUT repos/{owner}/{repo}/branches/main/protection --input p.json", "branch protection"),
                      ("gh api -X DELETE repos/{owner}/{repo}/branches/main/protection", "branch protection"),
                      ("gh api -X POST repos/{owner}/{repo}/rulesets --input r.json", "rulesets"),
                      ("gh api -X PUT repos/{owner}/{repo}/actions/secrets/KEY -f encrypted_value=x", "secrets")):
        refused(d, env, cmd, word)
    allowed(d, env, "gh api repos/{owner}/{repo}/contents/.github/CODEOWNERS")
    allowed(d, env, "gh api repos/{owner}/{repo}/branches/main/protection")


def test_ordinary_manager_commands_pass():
    d, env = world()
    for cmd in ("gh api repos/{owner}/{repo}/pulls?state=open", "git log --oneline -5", "git fetch origin",
                "gh api -X POST repos/{owner}/{repo}/issues/7/comments -f body=hello",
                "gh api -X POST repos/{owner}/{repo}/git/refs -f ref=refs/heads/manager/x -f sha=1",
                "gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f base=main", "factory precheck",
                "python3 .claude/hooks/factory_wait.py ci 7", "git push origin manager/fasil-note"):
        allowed(d, env, cmd)


def test_gh_hidden_in_a_wrapper_or_unreadable_is_refused():
    d, env = world()
    refused(d, env, "bash -c 'gh api -X PUT repos/{owner}/{repo}/pulls/7/merge -f sha=" + HEAD + "'", "run gh and git directly")
    refused(d, env, "eval \"git push --force origin x\"", "run gh and git directly")
    refused(d, env, "gh api 'repos/x", "cannot read")


def test_secrets_files_are_not_read_by_a_shell_command():
    d, env = world()
    for cmd in ("cat .env", "cat .env.local", "head -3 secrets/dev.yaml", "cat ~/.ssh/id_rsa", "grep KEY apps/api/.env.production"):
        refused(d, env, cmd, "secrets")
    allowed(d, env, "cat .env.example")


def test_a_chained_command_is_checked_part_by_part():
    d, env = world(comments=[])
    refused(d, env, "git fetch origin && " + MERGE % HEAD, "factory-approved")


def test_judge_takes_the_newest_non_skipped_run_per_job():
    sys.path.insert(0, os.path.join(SF, "hooks"))
    import factory_ci_judge as j
    assert j.judge([run_ok("a", started="2026-10-25T09:00:00Z", conclusion="failure", id_=1),
                    run_ok("a", started="2026-10-25T09:05:00Z", id_=2)]) == ("green", ["a"])
    assert j.judge([run_ok("a", started="2026-10-25T09:00:00Z", id_=1),
                    run_ok("a", started="2026-10-25T09:05:00Z", conclusion="failure", id_=2)]) == ("failed", ["a"])
    assert j.judge([run_ok("a", conclusion="skipped")]) == ("none", [])
    assert j.judge([run_ok("a", id_=1), run_ok("b", status="queued", conclusion=None, id_=2)]) == ("pending", ["b"])
    assert j.judge([run_ok("a", conclusion="cancelled")]) == ("failed", ["a"])


# --- the settings profile ---------------------------------------------------------------------------------------------

def load_profile():
    return json.load(open(PROFILE))


def test_the_profile_allows_gh_api_and_read_only_git_and_the_tools_a_review_needs():
    allow = load_profile()["permissions"]["allow"]
    for need in ("Bash(gh api *)", "Read", "Grep", "Glob", "Agent", "Bash(git log*)", "Bash(git show*)", "Bash(git diff*)"):
        assert need in allow, need
    assert not any(a.startswith(("Bash(git push", "Bash(git commit", "Bash(git checkout", "Bash(git add")) for a in allow), allow


def test_the_profile_denies_what_the_manager_never_does():
    deny = load_profile()["permissions"]["deny"]
    for need in ("Bash(git push --force*)", "Bash(git push origin main*)", "Bash(git push * --delete*)",
                 "Edit(./.claude/**)", "Edit(./vendor/**)", "Edit(./CLAUDE.md)", "Edit(./docs/PRD.md)",
                 "Write(./.claude/**)", "Read(./.env)", "Read(./.env.local)", "Read(./secrets/**)", "Bash(gh pr merge*)"):
        assert need in deny, need


def test_the_profile_keeps_every_factory_protecting_deny_of_the_shared_settings_except_the_gh_api_one():
    shared = json.load(open(os.path.join(KIT, ".claude", "settings.json")))["permissions"]
    assert "Bash(gh api *)" in shared["deny"], "the reason the manager needs its own profile"
    mine = set(load_profile()["permissions"]["deny"])
    left = [d for d in shared["deny"] if d != "Bash(gh api *)" and d not in mine and not d.startswith(("Bash(gh pr ", "Bash(git push", "Bash(git branch"))
            and "manager-claims" not in d and "manager_claims" not in d]
    assert left == [], left
    # a builder may not run the claim commands (#99), but the dev manager is the one who does
    claims = [d for d in shared["deny"] if "manager-claims" in d or "manager_claims" in d]
    assert claims and not any(d in mine for d in claims), claims
    assert "Bash(factory manager-claims*)" in load_profile()["permissions"]["allow"]
    for d in shared["deny"]:
        if d.startswith(("Bash(git push", "Bash(git branch")):
            assert d in mine, d


def test_the_profile_wires_the_merge_gate_on_bash():
    hooks = load_profile()["hooks"]["PreToolUse"]
    assert any(h.get("matcher") == "Bash" and any("manager_gate.py" in x["command"] for x in h["hooks"]) for h in hooks), hooks
    # every hook command the profile runs exists in the factory's hooks folder
    for event in load_profile()["hooks"].values():
        for h in event:
            for x in h["hooks"]:
                name = re.search(r'/hooks/([\w.-]+\.py)', x["command"]).group(1)
                assert os.path.isfile(os.path.join(SF, "hooks", name)), name


def test_a_link_install_links_the_skill_the_profile_and_the_gate_into_a_project():
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "vendor"))
        subprocess.run(["cp", "-a", os.path.dirname(SF), os.path.join(d, "vendor", "my-skills")], check=True)
        subprocess.run(["git", "init", "-q"], cwd=d, check=True)
        p = subprocess.run(["bash", os.path.join(d, "vendor", "my-skills", "software-factory", "install.sh"), ".", "--link"],
                           cwd=d, capture_output=True, text=True)
        assert p.returncode == 0, p.stderr
        for rel in (".claude/skills/manage-pass/SKILL.md", ".claude/manager/settings.json", ".claude/hooks/manager_gate.py",
                    ".claude/hooks/factory_ci_judge.py"):
            path = os.path.join(d, rel)
            assert os.path.islink(path) and os.path.isfile(path), rel


# --- the skill and the playbook ---------------------------------------------------------------------------------------

def skill_text():
    return open(SKILL).read()


def test_the_skill_is_well_formed_and_holds_the_rules():
    s = skill_text()
    m = re.match(r"^---\nname: manage-pass\ndescription: (.+?)\n---\n", s, re.S)
    assert m and len(m.group(1)) > 40, s[:200]
    for need in ("factory-question", "factory-answer", "factory-mustfix sha=<head>", "factory-approved sha=<head>",
                 "pr-watch sha=<head>", "factory-owner-ask id=<slug>", "factory-hold", "PUT repos/{owner}/{repo}/pulls/<n>/merge",
                 "sha=<head>", "tests-reviewed", "deps-reviewed", "newest run that is not `skipped`", "rerun-failed-jobs",
                 "@copilot", "does not exist", "quiet pass", "--dry-run", "owner-queue ask", "<roles.dir>/dev-manager/README.md",
                 "<notes>/manager.md", "Review in a subagent", "pass order"):
        assert need.lower() in s.lower() or need in s, need
    assert "-X PUT" in s or "PUT repos" in s


def test_the_what_you_may_change_table_has_one_source_the_skill_and_the_playbook_links_to_it():
    dm = open(os.path.join(SF, "DEV-MANAGER.md")).read()
    s = skill_text()
    rows = ["Review the coding agents' PRs; approve and merge those that pass", "**Any change to the factory:**",
            "**Your own working rhythm:**", "**Merging your own PRs,** whatever they change",
            "**Scope and order:**", "**Anything on the owner's computer,**", "**History:** force-pushing"]
    for row in rows:
        assert row in s, row
        assert row not in dm, "the playbook must link to the table, not copy it: " + row
    assert "| You do it on your own | You ask the owner first |" in s
    assert "kit/.claude/skills/manage-pass/SKILL.md" in dm


def test_the_skill_text_of_the_table_is_what_the_playbook_said_on_21_oct():
    # the owner's rule is kept word for word: these cells are copied from the playbook before the move
    s = skill_text()
    for cell in ("Post must-fixes, answer the agents' questions, add `tests-reviewed` / `deps-reviewed` after reading the change",
                 "Keep main's CI green: fix a broken build on a branch and merge it",
                 "**History:** force-pushing, deleting branches you didn't make, rewriting anything already pushed"):
        assert cell in s, cell


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
