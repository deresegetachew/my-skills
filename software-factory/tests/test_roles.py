#!/usr/bin/env python3
"""Generic roles (#102): `factory <role> [name] loop [-i] [--once] [--dry-run]`, one loop runner for the coding agent,
the dev manager and the product owner, and the project's role folder.

Runs the real factory, factory-loop.sh and hooks in a throwaway project (a bare origin and a clone) with a fake
`claude` (logs its arguments) and a fake `gh` (a JSON file). Waits are 0 minutes.
  python3 software-factory/tests/test_roles.py"""
import json, os, shutil, subprocess, sys, tempfile, time

SF = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
GIT = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}

CLAUDE = r'''#!/usr/bin/env bash
# Fake claude: logs its arguments; FAKE_CLAUDE_HOOK (a script) may react to the prompt.
printf 'claude %s\n' "$(printf '%s' "$*" | tr '\n' ' ')" >> "$LOOP_LOG"
if [ -n "${FAKE_CLAUDE_HOOK:-}" ]; then bash "$FAKE_CLAUDE_HOOK" "$@"; exit $?; fi
exit 0
'''

GH = r'''#!/usr/bin/env python3
import json, os, re, sys
from urllib.parse import urlparse, parse_qs
db = json.load(open(os.environ["FAKE_DB"])); a = sys.argv[1:]
open(os.environ["LOOP_LOG"], "a").write("gh " + " ".join(a) + "\n")
if a[:1] != ["api"]: sys.exit(1)
path = [x for x in a[1:] if not x.startswith("-") and x not in ("GET", "PATCH", "POST", "PUT", "DELETE", "application/vnd.github+json")][0]
u = urlparse(path.replace("repos/{owner}/{repo}/", "")); p = u.path; q = parse_qs(u.query); page = int(q.get("page", ["1"])[0])
def out(x): print(json.dumps(x)); sys.exit(0)
if p == "user": out({"login": "me"})
if p == "issues":
    items = db.get("issues", [])
    if "labels" in q: items = [i for i in items if q["labels"][0] in [l["name"] for l in i.get("labels", [])]]
    out(items if page == 1 else [])
if p == "pulls": out(db.get("pulls", []) if page == 1 else [])
m = re.fullmatch(r"issues/(\d+)/comments", p)
if m: out([{"body": b, "created_at": "2026-10-25T10:00:00Z"} for b in db.get("comments", {}).get(m.group(1), [])] if page == 1 else [])
out([] if page == 1 else [])
'''


def sh(*a, cwd=None, check=True):
    return subprocess.run(a, cwd=cwd, check=check, capture_output=True, text=True, env={**os.environ, **GIT})


def project(cfg=None, db=None, files=None, profile=True):
    d = tempfile.mkdtemp()
    origin, work, bin_ = (os.path.join(d, x) for x in ("origin.git", "work", "bin"))
    sh("git", "init", "-q", "--bare", "-b", "main", origin)
    sh("git", "clone", "-q", origin, work)
    shutil.copytree(os.path.join(SF, "hooks"), os.path.join(work, ".claude", "hooks"),
                    ignore=shutil.ignore_patterns("__pycache__"))
    for f in ("factory", "factory-loop.sh"):
        shutil.copy(os.path.join(SF, f), os.path.join(work, f))
        os.chmod(os.path.join(work, f), 0o755)
    base = {"waitMinutes": 0, "agents": ["menelik", "taytu"], "roles": {"dev-manager": {"names": ["lead", "second"]},
            "product-owner": {"names": ["eleni", "sabla"]}}, "manager": {"busyMinutes": 0, "idleMinutes": 0},
            "docs": {}}
    base.pop("docs")
    base["roles"]["product-owner"].update({"busyMinutes": 0, "idleMinutes": 0})
    base.update(cfg or {})
    json.dump(base, open(os.path.join(work, ".claude", "factory.json"), "w"))
    os.makedirs(os.path.join(work, "docs"))
    open(os.path.join(work, "docs", "build-plan.md"), "w").write("# Plan\n\n- [ ] **1.1 First task**\n")
    open(os.path.join(work, "CLAUDE.md"), "w").write("rules\n")
    if profile:
        os.makedirs(os.path.join(work, ".claude", "manager"))
        json.dump({"permissions": {"allow": ["Bash(gh api *)"]}}, open(os.path.join(work, ".claude", "manager", "settings.json"), "w"))
    for name, text in (files or {}).items():
        os.makedirs(os.path.dirname(os.path.join(work, name)) or work, exist_ok=True)
        open(os.path.join(work, name), "w").write(text)
    sh("git", "add", "-A", cwd=work)
    sh("git", "commit", "-qm", "start", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:main", cwd=work)
    os.makedirs(bin_)
    for name, body in (("claude", CLAUDE), ("gh", GH)):
        open(os.path.join(bin_, name), "w").write(body)
        os.chmod(os.path.join(bin_, name), 0o755)
    json.dump(db or {}, open(os.path.join(d, "db.json"), "w"))
    env = {**os.environ, **GIT, "PATH": f"{bin_}:{os.environ['PATH']}", "LOOP_LOG": os.path.join(d, "log"),
           "FAKE_DB": os.path.join(d, "db.json"), "FACTORY_REMOTE_CONTROL": "0", "HOME": d,
           "PYTHONDONTWRITEBYTECODE": "1"}  # the hooks run in the work tree: no .pyc may land in it
    for k in ("FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_ROLE", "FACTORY_NAME", "FACTORY_RELOAD_AGENT",
              "FACTORY_RELOAD_DIR", "FACTORY_RESUME", "CLAUDE_PROJECT_DIR"):
        env.pop(k, None)
    open(os.path.join(d, "log"), "w").close()
    return d, work, env


def factory(work, env, *args, timeout=90, stdin=subprocess.DEVNULL):
    return subprocess.run(["bash", "./factory", *args], cwd=work, env=env, capture_output=True, text=True,
                          timeout=timeout, stdin=stdin)


def log(env):
    return open(env["LOOP_LOG"]).read().splitlines()


def claude_calls(env):
    return [l for l in log(env) if l.startswith("claude ")]


def porcelain(work):
    return sh("git", "status", "--porcelain", cwd=work).stdout


UNREVIEWED = {"pulls": [{"number": 5, "title": "x", "draft": False, "head": {"sha": "a" * 40}, "user": {"login": "me"}}]}
PO_WORK = {"issues": [{"number": 7, "title": "Pick the palette", "labels": [{"name": "factory:needs-product"}]}]}


# --- done when 1: dry runs --------------------------------------------------------------------------------------------

def test_dev_manager_dry_run_prints_what_it_would_do_and_writes_nothing():
    d, work, env = project(db=UNREVIEWED)
    p = factory(work, env, "dev-manager", "lead", "loop", "--once", "--dry-run")
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert "[lead] dev-manager (dry run)" in p.stdout, p.stdout
    assert "PR #5: commit aaaaaaa not reviewed yet" in p.stdout, p.stdout
    assert "would run: claude" in p.stdout and "/manage-pass" in p.stdout, p.stdout
    assert not claude_calls(env), "a dry run must not start claude"
    assert not os.path.exists(work + "-agents"), "a dry run must not create a worktree"
    assert porcelain(work) == "", porcelain(work)
    assert not [l for l in log(env) if l.startswith("gh ") and "-X POST" in l or "-X PATCH" in l], log(env)


def test_dev_manager_dry_run_with_nothing_to_do_says_so():
    d, work, env = project(db={})
    p = factory(work, env, "dev-manager", "loop", "--once", "--dry-run")
    assert p.returncode == 0 and "nothing to do" in p.stdout and "[lead]" in p.stdout, (p.stdout, p.stderr)
    assert not claude_calls(env)


def test_product_owner_dry_run_names_the_work_and_the_skill():
    d, work, env = project(db=PO_WORK)
    p = factory(work, env, "product-owner", "loop", "--once", "--dry-run")
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert "[eleni] product-owner (dry run)" in p.stdout, p.stdout
    assert "issue #7: Pick the palette" in p.stdout and "/product-pass" in p.stdout, p.stdout
    assert not claude_calls(env) and not os.path.exists(work + "-agents")


# --- done when 2: the coding agent is unchanged ----------------------------------------------------------------------

def test_factory_loop_and_coding_agent_loop_are_the_same_thing():
    d, work, env = project()
    a = factory(work, env, "loop", "--dry-run")
    b = factory(work, env, "coding-agent", "loop", "--dry-run")
    assert a.returncode == 0 and b.returncode == 0, (a.stderr, b.stderr)
    assert a.stdout == b.stdout and "[menelik] coding-agent (dry run)" in a.stdout, (a.stdout, b.stdout)
    assert "next task: 1.1 First task" in a.stdout, a.stdout
    c = factory(work, env, "coding-agent", "taytu", "loop", "--dry-run")
    assert "[taytu] coding-agent (dry run)" in c.stdout, c.stdout
    n = factory(work, env, "coding-agent", "2", "loop", "--dry-run")  # the second name
    assert "[taytu]" in n.stdout, n.stdout


def test_a_coding_agent_pass_runs_next_task_exactly_as_before():
    d, work, env = project()
    p = factory(work, env, "loop", "1")
    assert p.returncode == 0, (p.stdout, p.stderr)
    calls = claude_calls(env)
    assert len(calls) == 1 and "-p /next-task 1.1" in calls[0], calls
    assert "--settings {\"disableClaudeAiConnectors\": true}" in calls[0], calls
    assert "--setting-sources" not in calls[0], calls  # a builder keeps the project's settings
    assert "factory-role" not in calls[0], calls


# --- a real pass of the other roles ---------------------------------------------------------------------------------

def test_a_product_owner_pass_runs_its_skill_in_its_own_worktree_with_its_profile():
    prof = {"permissions": {"allow": ["Bash(gh api *)"]}}
    d, work, env = project(db=PO_WORK, cfg={"roles": {"product-owner": {"names": ["eleni"], "busyMinutes": 0,
                                                                         "idleMinutes": 0,
                                                                         "profile": ".claude/manager/settings.json"}}})
    p = factory(work, env, "product-owner", "loop", "--once")
    assert p.returncode == 0, (p.stdout, p.stderr)
    calls = claude_calls(env)
    assert len(calls) == 1, calls
    c = calls[0]
    assert "-p /product-pass" in c and "<!-- factory-role role=product-owner name=eleni -->" in c, c
    assert "--setting-sources user" in c and "Bash(gh api *)" in c and "disableClaudeAiConnectors" in c, c
    assert "--strict-mcp-config" in c, c
    assert os.path.isdir(work + "-agents/eleni"), "the role works in its own worktree"
    assert prof["permissions"]["allow"][0] in c


def test_without_work_a_pass_starts_no_session():
    d, work, env = project(db={})
    p = factory(work, env, "product-owner", "loop", "--once")
    assert p.returncode == 0 and not claude_calls(env), (p.stdout, p.stderr)


def test_a_role_with_no_profile_file_keeps_the_default_flags():
    d, work, env = project(db=PO_WORK)  # roles.product-owner.profile points at a file that does not exist
    factory(work, env, "product-owner", "loop", "--once")
    c = claude_calls(env)[0]
    assert "--setting-sources" not in c and 'disableClaudeAiConnectors": true' in c, c


def test_models_setting_reaches_a_product_owner_session():
    d, work, env = project(db=PO_WORK, cfg={"models": {"product-owner": {"model": "opus", "effort": "high"}}})
    factory(work, env, "product-owner", "loop", "--once")
    c = claude_calls(env)[0]
    assert "--model opus" in c and "--effort high" in c, c


def test_three_failed_passes_in_a_row_stop_the_loop():
    # each failed run takes its issue off the list (the fake claude removes the label), so it is not "the same item"
    db = {"issues": [{"number": n, "title": f"Q{n}", "labels": [{"name": "factory:needs-product"}]} for n in (1, 2, 3, 4)]}
    d, work, env = project(db=db)
    hook = os.path.join(d, "hook.sh")
    open(hook, "w").write(
        'python3 - <<EOF\nimport json,os\nf=os.environ["FAKE_DB"]; db=json.load(open(f)); db["issues"].pop(0); '
        'json.dump(db,open(f,"w"))\nEOF\nexit 1\n')
    env["FAKE_CLAUDE_HOOK"] = hook
    p = factory(work, env, "product-owner", "loop")
    assert p.returncode == 1, (p.stdout, p.stderr)
    assert len(claude_calls(env)) == 3, claude_calls(env)
    assert "3 passes failed in a row" in p.stdout, p.stdout


def test_a_failed_pass_is_logged_and_the_loop_carries_on():
    db = {"issues": [{"number": n, "title": f"Q{n}", "labels": [{"name": "factory:needs-product"}]} for n in (1, 2)]}
    d, work, env = project(db=db)
    hook = os.path.join(d, "hook.sh")
    open(hook, "w").write(
        'python3 - <<EOF\nimport json,os\nf=os.environ["FAKE_DB"]; db=json.load(open(f)); db["issues"].pop(0); '
        'json.dump(db,open(f,"w"))\nEOF\n[ "$(grep -c "^claude" "$LOOP_LOG")" -gt 1 ] && exit 0; exit 1\n')
    env["FAKE_CLAUDE_HOOK"] = hook
    p = factory(work, env, "product-owner", "loop", "2")
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert "the pass exited with an error" in p.stdout and len(claude_calls(env)) == 2, p.stdout


def test_the_same_item_three_times_stops_the_loop():
    d, work, env = project(db=PO_WORK)  # the fake claude succeeds and the label stays: nothing changed
    p = factory(work, env, "product-owner", "loop")
    assert p.returncode == 1 and "came up 3 times in a row" in p.stdout, (p.stdout, p.stderr)
    assert len(claude_calls(env)) == 2, claude_calls(env)


# --- done when 3: two of a kind side by side --------------------------------------------------------------------------

def test_two_roles_of_one_kind_run_side_by_side_without_a_shared_lock_or_log():
    d, work, env = project(db=PO_WORK)
    hook = os.path.join(d, "hook.sh")
    # each session records itself and waits (up to 30 s) until the other is also running
    open(hook, "w").write(
        'name=$(printf "%s" "$*" | sed -n "s/.*name=\\([a-z]*\\).*/\\1/p")\n'
        'touch "$LOOP_LOG.$name"\n'
        'for i in $(seq 1 150); do [ -e "$LOOP_LOG.eleni" ] && [ -e "$LOOP_LOG.sabla" ] && exit 0; sleep 0.2; done\nexit 1\n')
    env["FAKE_CLAUDE_HOOK"] = hook
    a = subprocess.Popen(["bash", "./factory", "product-owner", "eleni", "loop", "--once"], cwd=work, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    b = subprocess.Popen(["bash", "./factory", "product-owner", "sabla", "loop", "--once"], cwd=work, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    oa, ob = a.communicate(timeout=90)[0], b.communicate(timeout=90)[0]
    assert a.returncode == 0 and b.returncode == 0, (oa, ob)
    assert os.path.isdir(work + "-agents/eleni") and os.path.isdir(work + "-agents/sabla")
    assert "[eleni]" in oa and "[sabla]" in ob and "[sabla]" not in oa, (oa, ob)


def test_a_name_belongs_to_one_loop_whatever_its_role():
    d, work, env = project(db=PO_WORK, cfg={"roles": {"dev-manager": {"names": ["taytu"]}}})
    p = factory(work, env, "dev-manager", "loop", "--once", "--dry-run")
    assert p.returncode == 0  # a dry run starts nothing
    q = factory(work, env, "dev-manager", "loop", "--once")
    assert q.returncode != 0 and "coding agent's name" in q.stdout + q.stderr, (q.stdout, q.stderr)


# --- done when 4: settings and the role folder -----------------------------------------------------------------------

def test_settings_list_the_role_settings():
    d, work, env = project()
    p = factory(work, env, "settings")
    for key in ("roles.dir", "roles.dev-manager.names", "roles.product-owner.names", "manager.busyMinutes",
                "manager.idleMinutes"):
        assert key in p.stdout, (key, p.stdout[-400:])
    q = factory(work, env, "settings", "show", "roles.dir")
    assert ".claude/factory/roles" in q.stdout, q.stdout


def test_a_missing_role_folder_falls_back_to_notes_and_a_present_one_wins():
    sys.path.insert(0, os.path.join(SF, "hooks"))
    import factory_roles as fr
    d, work, env = project(files={".claude/factory/notes/manager.md": "watch the flaky job\n"})
    old = os.getcwd()
    os.chdir(work)
    try:
        cfg = fr.load()
        text = fr.prompt(cfg, "dev-manager", "lead")
        assert text.startswith("/manage-pass") and ".claude/factory/notes/manager.md" in text, text
        assert "roles/dev-manager" not in text, text
        assert text.rstrip().endswith("<!-- factory-role role=dev-manager name=lead -->"), text
        made = fr.init(cfg)
        assert len(made) == 6, made
        text = fr.prompt(cfg, "dev-manager", "lead", "pr-5")
        assert text.startswith("/manage-pass pr-5"), text
        assert ".claude/factory/roles/dev-manager/README.md" in text and "reads.md" in text, text
        assert "notes/manager.md" not in text, text
    finally:
        os.chdir(old)


def test_init_roles_scaffolds_each_role_and_never_overwrites():
    d, work, env = project(files={".claude/factory/roles/dev-manager/README.md": "mine\n"})
    p = factory(work, env, "init-roles")
    assert p.returncode == 0, p.stderr
    base = os.path.join(work, ".claude", "factory", "roles")
    for role in ("coding-agent", "dev-manager", "product-owner"):
        assert os.path.isfile(os.path.join(base, role, "README.md")) and os.path.isfile(os.path.join(base, role, "reads.md"))
    assert open(os.path.join(base, "dev-manager", "README.md")).read() == "mine\n"
    reads = open(os.path.join(base, "dev-manager", "reads.md")).read()
    assert "CLAUDE.md" in reads and "docs/build-plan.md" in reads, reads  # the project's own documents that exist
    again = factory(work, env, "init-roles")
    assert "already has them" in again.stdout, again.stdout


def test_doctor_reports_a_reads_path_that_does_not_exist():
    d, work, env = project(files={
        ".claude/factory/roles/dev-manager/README.md": "x\n",
        ".claude/factory/roles/dev-manager/reads.md": "- CLAUDE.md - rules\n- docs/nope.md#section - gone\n- docs/*.md - plan\n"})
    bin_ = os.path.join(d, "bin")
    for tool in ("git", "python3", "bash", "sh", "env", "uname", "dirname", "basename", "cat"):
        if shutil.which(tool) and not os.path.exists(os.path.join(bin_, tool)):
            os.symlink(shutil.which(tool), os.path.join(bin_, tool))
    open(os.path.join(work, ".claude", "settings.json"), "w").write("{}")
    p = factory(work, {**env, "PATH": bin_}, "doctor")
    fixes = [l for l in p.stdout.splitlines() if l.startswith("fix")]
    assert any("docs/nope.md" in l and "does not exist" in l for l in fixes), p.stdout
    assert not any("CLAUDE.md" in l or "docs/*.md" in l for l in fixes), fixes


def test_reads_md_lines_name_a_path_a_section_and_a_reason():
    sys.path.insert(0, os.path.join(SF, "hooks"))
    import factory_roles as fr
    got = fr.parse_reads("# head\n\n- CLAUDE.md - rules\n* `docs/PRD.md#user-stories` - the stories\ndesign/STYLE.md  voice\n")
    assert got == [("CLAUDE.md", "", "rules"), ("docs/PRD.md", "user-stories", "the stories"),
                   ("design/STYLE.md", "", "voice")], got


# --- `factory loop -i` with no role asks ------------------------------------------------------------------------------

def run_on_a_terminal(work, env, args, answers):
    import pty
    master, slave = pty.openpty()
    p = subprocess.Popen(["bash", "./factory", *args], cwd=work, env=env, stdin=slave, stdout=subprocess.PIPE,
                         stderr=slave, text=True)
    os.close(slave)
    os.write(master, answers.encode())
    out = p.communicate(timeout=60)[0]
    shown = b""
    try:
        os.set_blocking(master, False)
        shown = os.read(master, 65536)
    except OSError:
        pass
    os.close(master)
    return p.returncode, out, shown.decode(errors="replace")


def test_loop_dash_i_on_a_terminal_asks_for_a_role_and_a_name():
    d, work, env = project(db=PO_WORK)
    rc, out, shown = run_on_a_terminal(work, env, ["loop", "-i", "--dry-run"], "3\nsabla\n")
    assert rc == 0, (out, shown)
    assert "Which role?" in shown and "product owner" in shown and "Which name?" in shown, shown
    assert "[sabla] product-owner (dry run)" in out, out


def test_loop_dash_i_on_a_terminal_takes_the_first_free_name_on_enter():
    d, work, env = project()
    rc, out, shown = run_on_a_terminal(work, env, ["loop", "-i", "--dry-run"], "2\n\n")
    assert rc == 0 and "[lead] dev-manager (dry run)" in out, (out, shown)


def test_a_role_word_or_the_env_skips_the_question():
    d, work, env = project()
    rc, out, shown = run_on_a_terminal(work, env, ["loop", "-i", "dev-manager", "--dry-run"], "")
    assert rc == 0 and "[lead] dev-manager (dry run)" in out and "Which role?" not in shown, (out, shown)
    rc, out, shown = run_on_a_terminal(work, {**env, "FACTORY_ROLE": "product-owner"}, ["loop", "-i", "--dry-run"], "")
    assert rc == 0 and "product-owner (dry run)" in out and "Which role?" not in shown, (out, shown)


def test_unattended_loop_never_asks_and_stays_a_coding_agent():
    d, work, env = project()
    p = factory(work, env, "loop", "-i", "--dry-run")  # -i, but stdin is not a terminal
    assert p.returncode == 0 and "coding-agent (dry run)" in p.stdout and "Which role?" not in p.stdout + p.stderr


# --- usage by role -----------------------------------------------------------------------------------------------------

def test_usage_by_role_separates_the_sessions_by_the_marker_in_their_first_prompt():
    d, work, env = project()
    slug = "".join(c if c.isalnum() else "-" for c in os.path.realpath(work))
    logs = os.path.join(d, ".claude", "projects", slug)
    os.makedirs(logs)

    def session(name, prompt, out_tokens):
        rows = [{"type": "user", "message": {"role": "user", "content": prompt}, "timestamp": "2026-10-25T09:00:00Z"},
                {"type": "assistant", "timestamp": "2026-10-25T09:00:05Z", "gitBranch": "main", "cwd": os.path.realpath(work),
                 "message": {"id": "m-" + name, "model": "sonnet", "usage": {"input_tokens": 10, "output_tokens": out_tokens,
                                                                               "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}}]
        open(os.path.join(logs, name + ".jsonl"), "w").write("\n".join(json.dumps(r) for r in rows) + "\n")

    session("a", "/manage-pass\n\n<!-- factory-role role=dev-manager name=lead -->", 111)
    session("b", [{"type": "text", "text": "/product-pass\n<!-- factory-role role=product-owner name=eleni -->"}], 222)
    session("c", "/next-task 1.1", 333)
    p = factory(work, env, "usage", "--by", "role", "--since", "2026-10-24", "--until", "2026-10-26", "--json")
    assert p.returncode == 0, (p.stdout, p.stderr)
    groups = json.loads(p.stdout)["groups"]
    assert {k: v["tokens"]["output"] for k, v in groups.items()} == {"manager": 111, "product-owner": 222, "builder": 333}, groups


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
