#!/usr/bin/env python3
"""The dev manager's orchestrator (#97, #109): what `factory dev-manager [name] loop` runs each cycle. It has no model.

Each cycle it reads GitHub (factory_watch.py: the seven checks, which include `factory precheck`'s), and:
  - opens a thread note on every task issue that just went `factory:in-progress`, and closes the note of a closed issue;
  - posts what only the owner can act on (a queued CI, an idle agent, a PR waiting for the product owner ...) to the
    owner-queue issue, once per `id`, mentioning the owner so GitHub notifies his phone;
  - applies the dead-man's switch: work that has waited `manager.deadManMinutes` with no dev-manager activity is reported
    to the owner, naming it;
  - starts one one-item sub-manager per item that needs a manager, at most `manager.maxSubManagers` at once, each a fresh
    `claude -p "/manage-pass <item>"` on the manager settings profile, with the item's fact sheet and thread note in its
    prompt, under a lease (factory_lease.py). A sub-manager does its item and exits. The orchestrator never starts builders.

Labels and comments on GitHub are the source of truth; the only local state is `.git/factory-manager/<name>.log` and the
pid files of the sub-managers it started. A thread's memory is a note comment on the task issue (on the PR when there is
no issue); it is a memory for the sub-managers, not a cache.

  factory_orchestrator.py cycle [--name N] [--dry-run] [--interactive] [--wait]
        exit 0: there was work (started, posted or already running)   exit 3: nothing to do
        --dry-run   read everything and print what it would do; write nothing
        --interactive  run the first item in a session you can type into (Remote Control), one item, then return
        --wait      wait for the sub-managers it started
  factory_orchestrator.py sub --name N --item <ref> [--interactive]     one sub-manager (what cycle starts)
"""
import argparse, hashlib, json, os, re, subprocess, sys, time
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402
import factory_lease as lease  # noqa: E402
import factory_roles as roles  # noqa: E402
import factory_watch as watch  # noqa: E402
from factory_config import load, manager_setting, role_names, safe_agent, task_labels  # noqa: E402

OWNER_TITLE = "Dev manager: needs the owner"
ASK_RX = re.compile(r"<!--\s*factory-owner-ask\s+id=([^\s>]+)(?:\s+[^>]*?)?\s*-->")  # for=product may follow
NOTE_RX = re.compile(r"<!--\s*factory-manager-note\s+thread=(\S+)\s+status=(\w+)\s*-->")


def common_dir():
    p = subprocess.run(["git", "rev-parse", "--git-common-dir"], capture_output=True, text=True)
    return os.path.abspath(p.stdout.strip() or ".git")


def state_dir(name):
    d = os.path.join(common_dir(), "factory-manager", f"{name}.d")
    os.makedirs(d, exist_ok=True)
    return d


class Out:
    """Prints a line and, unless this is a dry run, appends it to `.git/factory-manager/<name>.log`."""

    def __init__(self, name, dry):
        self.name, self.dry = name, dry

    def __call__(self, line):
        print(f"[{self.name}] {line}", flush=True)
        if not self.dry:
            try:
                os.makedirs(os.path.join(common_dir(), "factory-manager"), exist_ok=True)
                with open(os.path.join(common_dir(), "factory-manager", f"{self.name}.log"), "a", encoding="utf-8") as f:
                    f.write(f"{lease.iso(lease.now())} {line}\n")
            except OSError:
                pass


# --- the owner queue ---------------------------------------------------------------------------------------------------

def owner_login(cfg):
    """The login to mention: `manager.notify`, else the repository's owner when that is a person."""
    given = str(manager_setting(cfg, "notify") or "").lstrip("@")
    if given:
        return given
    repo = fi.gh("GET", "repos/{owner}/{repo}") or {}
    owner = repo.get("owner") or {}
    return owner.get("login", "") if owner.get("type") == "User" else ""


def owner_queue(cfg, create=False):
    """The number of the open "Dev manager: needs the owner" issue; made on demand when `create`."""
    for i in fi.gh_all("repos/{owner}/{repo}/issues?state=open"):
        if i.get("title") == OWNER_TITLE and "pull_request" not in i:
            return i["number"]
    if not create:
        return None
    made = fi.gh("POST", "repos/{owner}/{repo}/issues", {
        "title": OWNER_TITLE,
        "body": "One comment per thing the dev manager needs from the owner, each starting "
                "`<!-- factory-owner-ask id=<slug> -->`. Answer in the comment; the next pass reads the reply. Pin this "
                "issue. Nothing is posted twice."})
    return made["number"]


def post_ask(cfg, name, ask_id, line, out):
    """Posts a report to the owner queue once per id. Returns True when it posted (or would, in a dry run)."""
    queue = owner_queue(cfg, create=False)
    if queue:
        for c in fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{queue}/comments"):
            m = ASK_RX.search(c.get("body") or "")
            if m and m.group(1) == ask_id:
                return False
    if out.dry:
        out(f"would post to the owner queue (id {ask_id}): {line}")
        return True
    queue = owner_queue(cfg, create=True)
    login = owner_login(cfg)
    body = (f"<!-- factory-owner-ask id={ask_id} -->\n{'@' + login + ' ' if login else ''}for your attention: {line}\n\n"
            f"Posted by the dev manager {name}. If you want it handled differently, say so here; the next pass reads the reply.")
    fi.comment(queue, body)
    out(f"posted to the owner queue (id {ask_id}): {line}")
    return True


# --- thread notes ------------------------------------------------------------------------------------------------------

def note_body(thread, status, first_line):
    return (f"<!-- factory-manager-note thread={thread} status={status} -->\n"
            f"**Dev manager note for {thread}.** This is the thread's memory for the dev manager's sessions (they start "
            "with none); GitHub's labels and comments are the truth. The sub-manager edits it before it exits.\n\n"
            f"- {first_line}\n")


def find_note(comments):
    for c in comments:
        m = NOTE_RX.search(c.get("body") or "")
        if m:
            return c, m.group(1), m.group(2)
    return None


def lifecycle(cfg, name, out):
    """Opens a note on each in-progress task issue, closes the note of a closed one. No model. Returns what it did."""
    if (cfg.get("tasks") or {}).get("source") != "issues":
        return []
    L, did = task_labels(cfg), []
    for i in fi.task_issues(label=L["inProgress"]):
        n = i["number"]
        if find_note(fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments")):
            continue
        if out.dry:
            out(f"would open the thread note on issue #{n}")
        else:
            fi.comment(n, note_body(f"issue-{n}", "open", f"opened {lease.iso(lease.now())} (label {L['inProgress']})"))
            out(f"opened the thread note on issue #{n}")
        did.append(n)
    since = lease.iso(lease.now() - timedelta(days=2))
    seen = 0
    for i in fi.gh_all(f"repos/{{owner}}/{{repo}}/issues?state=closed&since={since}"):
        if "pull_request" in i or seen >= 20 or not any(l["name"].startswith("factory:") for l in i.get("labels", [])):
            continue
        seen += 1
        found = find_note(fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{i['number']}/comments"))
        if found and found[2] == "open":
            c = found[0]
            if out.dry:
                out(f"would close the thread note on issue #{i['number']}")
            else:
                body = NOTE_RX.sub(f"<!-- factory-manager-note thread={found[1]} status=closed -->", c["body"], count=1)
                fi.gh("PATCH", f"repos/{{owner}}/{{repo}}/issues/comments/{c['id']}",
                      {"body": body + f"- closed {lease.iso(lease.now())}: the issue was closed, so the thread ends.\n"})
                out(f"closed the thread note on issue #{i['number']}")
            did.append(i["number"])
    return did


def thread_of(item, comments_of=None):
    """(issue or PR number to hold the note, thread name, note comment or None) for an item."""
    pr = item.get("pr")
    comments_of = comments_of or (lambda n: fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments"))
    holders = []
    if pr:
        pr_obj = fi.gh("GET", f"repos/{{owner}}/{{repo}}/pulls/{pr}") or {}
        issue = watch.issue_of(pr_obj) if pr_obj.get("head") else None
        holders = ([(issue, f"issue-{issue}")] if issue else []) + [(pr, f"pr-{pr}")]
    elif item["ref"].startswith("issue-"):
        n = int(item["ref"].split("-", 1)[1])
        holders = [(n, f"issue-{n}")]
    for number, thread in holders:
        found = find_note(comments_of(number))
        if found:
            return number, thread, found[0]
    return (holders[0][0], holders[0][1], None) if holders else (None, item["ref"], None)


# --- facts and prompts -------------------------------------------------------------------------------------------------

def fact_sheet(cfg, item, held, note, owner):
    """The item's facts, collected without a model: what the sub-manager would otherwise spend turns finding out."""
    lines = [f"Item {item['ref']} ({item['kind']}), waiting since {item['since'].isoformat() if item['since'] else 'unknown'}.",
             f"Why: {item['line']}"]
    pr = item.get("pr")
    if pr:
        p = fi.gh("GET", f"repos/{{owner}}/{{repo}}/pulls/{pr}") or {}
        head = (p.get("head") or {}).get("sha", "")
        comments = fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{pr}/comments")
        state, at = watch.review_state(comments, head) if head else ("none", None)
        verdict, jobs = watch.ci_state(head) if head else ("none", [])
        lines += [f"PR #{pr}: \"{p.get('title', '')}\" on branch {(p.get('head') or {}).get('ref', '?')} into "
                  f"{(p.get('base') or {}).get('ref', 'main')}, head {head}, draft={bool(p.get('draft'))}, "
                  f"mergeable_state={p.get('mergeable_state', '?')}, labels: "
                  f"{', '.join(x['name'] for x in p.get('labels', [])) or 'none'}.",
                  f"Review state of this head: {state}" + (f" (since {at.isoformat()})" if at else "") + ".",
                  f"CI judged by the manager's rule: {verdict}" + (f" ({', '.join(jobs)})" if jobs else "") + ".",
                  f"The manager's own PR: {'yes' if watch.is_own(p) else 'no'}."]
        issue = watch.issue_of(p)
        if issue:
            lines.append(f"Task issue: #{issue}.")
    if held:
        lines.append(f"Your lease: {lease.render(held['kind'], held['holder'], held['key'], held['until'])}")
    if owner:
        lines.append(f"Owner login for an owner-queue ask: @{owner}.")
    if note:
        lines.append(f"Thread note (comment {note['id']}; edit it with PATCH repos/{{owner}}/{{repo}}/issues/comments/"
                     f"{note['id']} before you exit):\n{note['body']}")
    else:
        lines.append("There is no thread note yet; create one on the PR or issue before you exit "
                     "(`<!-- factory-manager-note thread=<ref> status=open -->`).")
    return "\n".join(lines)


def running(name):
    """The refs of sub-managers this orchestrator started that are still alive (and drops the dead ones' pid files)."""
    d, alive = state_dir(name), []
    for f in os.listdir(d):
        if not f.endswith(".pid"):
            continue
        try:
            pid = int(open(os.path.join(d, f)).read().strip())
            os.kill(pid, 0)
            alive.append(f[:-4])
        except (OSError, ValueError):
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass
    return alive


# --- one sub-manager ---------------------------------------------------------------------------------------------------

def run_sub(cfg, name, ref, interactive=False):
    out = Out(name, False)
    pidfile = os.path.join(state_dir(name), f"{ref}.pid")
    open(pidfile, "w").write(str(os.getpid()))
    held = None
    try:
        item = next((i for i in watch.collect(cfg) if i["ref"] == ref and i["to"] == "manager"), None)
        if not item:
            out(f"{ref}: nothing needs a manager any more")
            return 0
        if item["target"]:
            held = lease.acquire(item["target"], item["lease"][0], item["lease"][1], name, float(manager_setting(cfg, "claimMinutes")))
            if not held:
                out(f"{ref}: another manager holds the lease; leaving it")
                return 0
        number, thread, note = thread_of(item)
        if note is None and number:
            fi.comment(number, note_body(thread, "open", f"opened {lease.iso(lease.now())} by {name} for {ref}"))
            number, thread, note = thread_of(item)
        sheet = fact_sheet(cfg, item, held, note, owner_login(cfg))
        prompt = roles.prompt(cfg, "dev-manager", name, ref, sheet)
        flags = roles.session_flags(cfg, "dev-manager")
        env = {**os.environ, "FACTORY_AGENT": name, "FACTORY_ROLE": "dev-manager", "FACTORY_LOOP": "1", "FACTORY_ITEM": ref}
        limit = float(manager_setting(cfg, "subManagerMinutes")) * 60
        out(f"{ref}: starting a {'session you can type into' if interactive else 'sub-manager'} ({item['line']})")
        if interactive:
            args = ["claude", *flags]
            if os.environ.get("FACTORY_REMOTE_CONTROL", "1") == "1":
                args.append(f"--remote-control={name} {ref}")
            rc = subprocess.run([*args, prompt], env=env).returncode
        else:
            logfile = os.path.join(state_dir(name), f"{ref}.out")
            with open(logfile, "w", encoding="utf-8") as f:
                try:
                    rc = subprocess.run(["claude", *flags, *roles.permission_flags(cfg), "-p", prompt], env=env, stdout=f, stderr=subprocess.STDOUT,
                                        timeout=limit).returncode
                except subprocess.TimeoutExpired:
                    out(f"{ref}: stopped after {limit / 60:.0f} minutes (manager.subManagerMinutes)")
                    rc = 1
        out(f"{ref}: the session ended ({'ok' if rc == 0 else f'exit {rc}'})")
        return 0 if rc == 0 else 1
    finally:
        lease.release(held)
        try:
            os.remove(pidfile)
        except OSError:
            pass


# --- the cycle ---------------------------------------------------------------------------------------------------------

def cycle(cfg, name, dry=False, interactive=False, wait=False):
    out = Out(name, dry)
    now = lease.now()
    info = {}
    items = watch.collect(cfg, now, info)
    did = bool(lifecycle(cfg, name, out))
    managers = [i for i in items if i["to"] == "manager"]
    owners = [i for i in items if i["to"] == "owner"]
    if items:
        out(f"{len(items)} item(s) need attention: " + ", ".join(i["ref"] for i in items))
    for i in owners:
        did = post_ask(cfg, name, i["ref"], i["line"], out) or did
    limit = float(manager_setting(cfg, "deadManMinutes"))
    stuck = [i for i in managers if i["since"] and watch.minutes(i["since"], now) >= limit]
    activity = info.get("activity")
    if stuck and not (activity and watch.minutes(activity, now) < limit):
        refs = sorted(i["ref"] for i in stuck)
        ask_id = "dead-man-" + hashlib.sha1(",".join(refs).encode()).hexdigest()[:8]
        waited = max(watch.minutes(i["since"], now) for i in stuck)
        quiet = f"for {watch.minutes(activity, now):.0f} min" if activity else "recently"
        did = post_ask(cfg, name, ask_id, f"{len(stuck)} item(s) have waited up to {waited:.0f} min and no dev manager has acted "
                       f"{quiet}: {', '.join(refs)}. A fresh sub-manager is being started for each; if this repeats, check "
                       f"that `factory dev-manager loop` is running and read .git/factory-manager/{name}.log.", out) or did
    cap = 1 if interactive else max(1, int(manager_setting(cfg, "maxSubManagers")))
    alive = [] if dry else running(name)
    foreign = 0
    started, procs = [], []
    for i in managers:
        if i["ref"] in alive:
            out(f"{i['ref']}: a sub-manager is already on it")
            continue
        if i["target"] and not dry:
            who = lease.holder(i["target"], *i["lease"])
            if who and who != name:
                foreign += 1
                out(f"{i['ref']}: {who} holds the lease; leaving it")
                continue
        if len(alive) + foreign + len(started) >= cap:
            out(f"{i['ref']}: waiting for a free place ({cap} sub-manager(s) at most, manager.maxSubManagers)")
            continue
        if dry:
            out(f"would start a {'session you can type into' if interactive else 'sub-manager'} for {i['ref']}: {i['line']}")
            out(f"would run: claude -p \"/manage-pass {i['ref']}\" (manager profile{" ".join(["", *roles.permission_flags(cfg)])}, a lease on {i['target'] or i['ref']})")
            started.append(i["ref"])
            continue
        if interactive:
            run_sub(cfg, name, i["ref"], interactive=True)
            started.append(i["ref"])
            break
        p = subprocess.Popen([sys.executable, os.path.abspath(__file__), "sub", "--name", name, "--item", i["ref"]],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                             cwd=os.getcwd())
        open(os.path.join(state_dir(name), f"{i['ref']}.pid"), "w").write(str(p.pid))
        out(f"{i['ref']}: started a sub-manager (pid {p.pid}): {i['line']}")
        started.append(i["ref"])
        procs.append(p)
    if wait:
        for p in procs:
            p.wait()
    busy = bool(items) or did or bool(alive)
    if not busy:
        out("nothing to do")
    return 0 if busy else 3


def main(argv):
    ap = argparse.ArgumentParser(prog="factory_orchestrator.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cycle")
    c.add_argument("--name", default=os.environ.get("FACTORY_AGENT"))
    c.add_argument("--dry-run", action="store_true")
    c.add_argument("--interactive", action="store_true")
    c.add_argument("--wait", action="store_true")
    s = sub.add_parser("sub")
    s.add_argument("--name", default=os.environ.get("FACTORY_AGENT"))
    s.add_argument("--item", required=True)
    s.add_argument("--interactive", action="store_true")
    a = ap.parse_args(argv)
    cfg = load()
    name = safe_agent(a.name or (role_names(cfg, "dev-manager") or ["manager"])[0])
    try:
        if a.cmd == "cycle":
            return cycle(cfg, name, a.dry_run, a.interactive, a.wait)
        return run_sub(cfg, name, a.item, a.interactive)
    except SystemExit as e:  # a gh call that failed: one line, and the loop counts it as a failed cycle
        if e.code in (None, 0) or isinstance(e.code, int):
            raise
        print(f"[{name}] {e.code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
