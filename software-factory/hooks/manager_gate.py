#!/usr/bin/env python3
"""PreToolUse hook on Bash for the dev manager's sessions (#96): the guard rails the manager's settings profile
(.claude/manager/settings.json) wires in.

It refuses, and says what to do instead (always: write an owner-queue ask):
  - a merge unless the PR's latest approval marker is `<!-- factory-approved sha=<head> -->` for exactly the head being
    merged, no must-fix came after it, the merge is pinned to that head (`-f sha=<head>`, or `--match-head-commit`) and
    CI is judged green (newest non-skipped run per job name, factory_ci_judge.py);
  - closing a pull request (`gh api -X PATCH .../pulls/<n> -f state=closed`) unless a factory agent opened it (a `task/` branch
    in this repository, or the manager's own `manager/` branch): anyone else's is the owner's to close (#203);
  - a merge of a pull request the manager opened itself (a `manager/` branch, or a body with
    `<!-- factory-role role=dev-manager ... -->`): its own PRs wait for the owner;
  - deleting refs (`git push --delete`, `git push origin :branch`, `git branch -d`, `git update-ref -d`,
    `gh api -X DELETE .../git/refs/...`), force-pushing, and pushing to the main branch;
  - writes through `gh api` to `.github/` content, branch protection, rulesets, Actions secrets and variables, webhooks and
    deploy keys (reading them is fine);
  - reading secrets files (`.env*`, `secrets/`, keys) with a shell command.

Like pr-gate.py it is a guard rail, not a security boundary: branch protection and required CI on GitHub are. It fails
closed: an error, or a command it cannot read (gh or git hidden in bash -c, eval, xargs ...), blocks the command.
Exit 2 blocks the command and tells Claude why.
"""
import importlib.util, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def pr_gate():
    """pr-gate.py's command reader (its file name has a dash, so it is loaded by path)."""
    spec = importlib.util.spec_from_file_location("pr_gate", os.path.join(HERE, "pr-gate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PG = pr_gate()
API_VALUE_FLAGS = {"-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input", "-q", "--jq",
                   "-t", "--template", "--cache", "--hostname", "-p", "--preview"}
ASK = "Write an owner-queue ask instead (a comment on the owner-queue issue starting `<!-- factory-owner-ask id=<slug> -->`)."
OWN_BRANCH = re.compile(r"^manager/")
OWN_BODY = re.compile(r"<!--\s*factory-role\s+role=dev-manager\b")
APPROVED = re.compile(r"<!--\s*factory-approved\s+sha=([0-9a-f]{7,40})")
MUSTFIX = re.compile(r"<!--\s*factory-mustfix\b")
MERGE_PATH = re.compile(r"^(?P<repo>repos/[^/]+/[^/]+)/pulls/(?P<n>\d+)/merge/?$")
PULL_PATH = re.compile(r"^(?P<repo>repos/[^/]+/[^/]+)/pulls/(?P<n>\d+)/?$")
AGENT_BRANCH = re.compile(r"^task/")
PROTECTED_WRITE = [
    (re.compile(r"/contents/\.github(/|$)"), "`.github/` content (workflows and CODEOWNERS are protected)"),
    (re.compile(r"/branches/[^?]+/protection"), "branch protection"),
    (re.compile(r"/(rulesets|environments)(/|$|\?)"), "repository rulesets and environments"),
    (re.compile(r"/actions/(secrets|variables)(/|$|\?)"), "Actions secrets and variables"),
    (re.compile(r"/(hooks|keys)(/|$|\?)"), "webhooks and deploy keys"),
    (re.compile(r"/git/refs(/|$|\?)"), "git refs"),
]
SECRET = re.compile(r"(^|/)\.env(\.(?!example$|sample$|template$)[\w.-]+)?$|(^|/)secrets(/|$)|\.(pem|key|age)$|"
                    r"(^|/)id_(rsa|ed25519|ecdsa)\b|(^|/)\.ssh(/|$)|(^|/)\.config/gh(/|$)")
GIT_VALUE_FLAGS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}


def refuse(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def program(tokens):
    """The program of a simple command, after VAR=value assignments and prefixes like env or sudo, and its arguments."""
    i = 0
    while i < len(tokens) and (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[i]) or tokens[i] in PG.PREFIXES
                               or (i and tokens[i - 1] in PG.PREFIXES and tokens[i].startswith("-"))):
        i += 1
    return (os.path.basename(tokens[i]), tokens[i + 1:]) if i < len(tokens) else ("", [])


def gh_api(path, *extra):
    p = subprocess.run(["gh", "api", *extra, path], capture_output=True, text=True)
    if p.returncode != 0:
        refuse(f"The manager gate could not read {path} from GitHub ({(p.stderr or p.stdout).strip()[:200]}), so it did "
               "not run the command. Try again in a moment. " + ASK)
    return json.loads(p.stdout) if p.stdout.strip() else None


def all_pages(path):
    out, page = [], 1
    while True:
        chunk = gh_api(f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}")
        if not isinstance(chunk, list):
            refuse(f"GitHub answered something other than a list for {path}. " + ASK)
        out += chunk
        if len(chunk) < 100:
            return out
        page += 1


def trusted():
    """`trustedReviewers` from main's factory.json as GitHub has it (never this folder's copy). Fails closed."""
    try:
        from factory_config import load, load_from_main
        return set(load_from_main(load()).get("trustedReviewers") or [])
    except BaseException as e:
        refuse(f"The manager gate could not read the project's settings from GitHub ({str(e)[:200]}), so it did not run "
               "the command. Try again in a moment. " + ASK)


def gate_merge(repo, n, given):
    """Allows a merge of PR n pinned to `given`, or refuses and says why. `repo` is the API path prefix."""
    if not given:
        refuse(f"Pin the merge to the head you reviewed: add `-f sha=<head>` (or --match-head-commit <head>). "
               "GitHub then refuses it if the PR moved on. " + ASK)
    pr = gh_api(f"{repo}/pulls/{n}")
    if pr.get("state") != "open":
        return  # already merged or closed: GitHub refuses it, and that means done by someone else
    head, ref = pr["head"]["sha"], pr["head"]["ref"]
    if len(given) < 7 or not head.startswith(given):
        refuse(f"PR #{n} has moved on: its head is {head[:12]}, not {given[:12]}. Review the new commit first "
               f"(post a new `<!-- factory-approved sha={head[:12]} -->` only after reading it). " + ASK)
    if OWN_BRANCH.match(ref or "") or OWN_BODY.search(pr.get("body") or ""):
        refuse(f"PR #{n} is a pull request the dev manager opened ({ref}). The manager does not merge its own pull requests: "
               "the owner does. " + ASK)
    who = trusted()
    last = None  # the latest of the approval and must-fix markers decides
    for c in all_pages(f"{repo}/issues/{n}/comments"):
        body, login = c.get("body") or "", (c.get("user") or {}).get("login", "")
        if MUSTFIX.search(body):
            last = ("mustfix", "")
        else:
            m = APPROVED.search(body)
            if m and (not who or login in who):
                last = ("approved", m.group(1))
    if last is None:
        refuse(f"PR #{n} has no `<!-- factory-approved sha=<head> -->` comment. Review it first; approve it with "
               f"`<!-- factory-approved sha={head[:12]} -->`, or post a must-fix. " + ASK)
    if last[0] == "mustfix":
        refuse(f"PR #{n}: the latest marker is a must-fix, not an approval. Wait for the fix and review it again.")
    if not head.startswith(last[1]):
        refuse(f"PR #{n}: the approval is for {last[1][:12]}, but the head is {head[:12]}. Review the new commit, then "
               "approve it. " + ASK)
    try:
        import factory_ci_judge as judge
        verdict, jobs = judge.state(head, repo)
    except (RuntimeError, ImportError) as e:
        refuse(f"The manager gate could not judge CI for {head[:12]} ({e}). Try again in a moment.")
    if verdict != "green":
        what = {"pending": "is still running", "failed": "failed", "none": "has no CI runs yet"}[verdict]
        refuse(f"CI {what} for PR #{n} at {head[:12]}" + (f": {', '.join(jobs)}" if jobs else "")
               + f". CI is judged green only when the newest non-skipped run of every job succeeded. Wait with "
               f"`factory wait ci {n}`, re-run only a flake the project's note lists, or post a must-fix.")


def gate_close(repo, n):
    """Allows closing PR n when a factory agent opened it (a task/ branch in this repository, or the manager's own branch),
    else refuses: a pull request from the owner or anyone else is the owner's to close."""
    pr = gh_api(f"{repo}/pulls/{n}")
    if pr.get("state") != "open":
        return  # already closed or merged: nothing to close
    ref = (pr.get("head") or {}).get("ref") or ""
    head_repo = ((pr.get("head") or {}).get("repo") or {}).get("full_name")
    base_repo = ((pr.get("base") or {}).get("repo") or {}).get("full_name")
    if head_repo and base_repo and head_repo != base_repo:
        refuse(f"PR #{n} comes from another repository ({head_repo}), so it is not a factory agent's. Closing it is the owner's. " + ASK)
    if not (AGENT_BRANCH.match(ref) or OWN_BRANCH.match(ref)):
        refuse(f"PR #{n} is not a factory agent's (its branch is {ref or 'unknown'}, not task/...). The manager closes only the pull "
               "requests agents opened; one from the owner or anyone else is the owner's decision. " + ASK)


def api_call(flags, pos, cmd):
    """Checks one `gh api` call; `flags` and `pos` are its parsed arguments (pos[0] is "api", pos[1] the path)."""
    path = (pos[1] if len(pos) > 1 else "").split("://", 1)[-1]
    path = re.sub(r"^api\.github\.com/", "", path).lstrip("/")
    given = [v for n in ("-X", "--method") for v in flags.get(n, [])]
    fields = [v for n in ("-f", "--raw-field", "-F", "--field") for v in flags.get(n, [])]
    method = (given[-1] if given else ("POST" if fields or "--input" in flags else "GET")).upper()
    if method == "GET":
        return
    pull = PULL_PATH.match(path)
    if pull and method == "PATCH":
        if "--input" in flags or PG.SHELL_EXPANSION.search(cmd):
            refuse("Write the pull request change as plain text (`-f state=closed`): the gate reads the command before the shell "
                   "expands $(...) or $VARIABLES, and it cannot read a body from --input. " + ASK)
        if "state=closed" in [f.replace(" ", "") for f in fields]:
            gate_close(pull.group("repo"), pull.group("n"))
        return
    m = MERGE_PATH.match(path)
    if m and method == "PUT":
        if "--input" in flags or PG.SHELL_EXPANSION.search(cmd):
            refuse("Write the merge's sha as plain text (`-f sha=<head>`): the gate reads the command before the shell "
                   "expands $(...) or $VARIABLES, and it cannot read a body from --input. " + ASK)
        sha = ([f.split("=", 1)[1] for f in fields if f.startswith("sha=")] or [""])[-1]
        gate_merge(m.group("repo"), m.group("n"), sha)
        return
    for rx, what in PROTECTED_WRITE:
        if rx.search("/" + path):
            if what == "git refs":
                if method in ("DELETE", "PATCH"):
                    refuse("The manager does not delete or move refs (that rewrites history). " + ASK)
                return
            refuse(f"The manager does not change {what}: that is the owner's. " + ASK)


def git_call(args):
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in GIT_VALUE_FLAGS else 1
    if i >= len(args):
        return
    sub, rest = args[i], args[i + 1:]
    if sub == "push":
        if any(t in ("-f", "--force", "--mirror", "--prune") or t.startswith(("--force", "-f")) for t in rest) \
                or any(t.startswith("+") for t in rest):
            refuse("The manager does not force-push. " + ASK)
        if any(t in ("-d", "--delete") for t in rest) or any(t.startswith(":") and len(t) > 1 for t in rest):
            refuse("The manager does not delete remote branches or tags. " + ASK)
        names = [re.sub(r"^.*:", "", t) for t in rest if not t.startswith("-")]
        if any(re.fullmatch(r"(refs/heads/)?(main|master)", n) for n in names):
            refuse("The manager does not push to the main branch. " + ASK)
    elif sub in ("branch", "tag") and any(t in ("-d", "-D", "--delete") for t in rest):
        refuse("The manager does not delete branches or tags. " + ASK)
    elif sub == "update-ref" and any(t in ("-d",) for t in rest):
        refuse("The manager does not delete refs. " + ASK)


def main():
    data = json.load(sys.stdin)
    cmd = (data.get("tool_input") or {}).get("command", "") or ""
    try:
        parts = PG.simple_commands(cmd)
    except ValueError:
        refuse("The manager gate cannot read this command (unbalanced quotes?). Write it more simply.")
    for p in parts:
        prog, args = program(p)
        if not prog:
            continue
        if prog in PG.WRAPPERS and (any(PG.GH_IN_TEXT.search(t) or re.search(r"(^|[^\w.-])git\s+[a-z]", t) for t in args)
                                    or PG.GH_IN_TEXT.search(" ".join(args))):
            refuse("Run gh and git directly, not inside bash -c, sh -c, eval or a quoted string: the manager gate has to "
                   "see the command.")
        if prog == "git":
            git_call(args)
        elif prog == "gh":
            flags, pos = PG.parse_args(args, API_VALUE_FLAGS | PG.MERGE_VALUE_FLAGS | PG.GLOBAL_WITH_VALUE)
            if pos[:1] == ["api"]:
                api_call(flags, pos, cmd)
            elif pos[:2] == ["pr", "merge"]:
                if len(pos) < 3 or not re.fullmatch(r"\d+", pos[2]):
                    refuse("Name the pull request by its number, so the gate checks the one you mean.")
                if PG.SHELL_EXPANSION.search(cmd):
                    refuse("Write the head sha as plain text: the gate reads the command before the shell expands $(...) or "
                           "$VARIABLES. " + ASK)
                gate_merge("repos/{owner}/{repo}", pos[2], (flags.get("--match-head-commit") or [""])[-1])
        elif prog not in ("git", "gh") and any(SECRET.search(t) for t in args if not t.startswith("-")):
            refuse("The manager does not read secrets files (.env*, secrets/, keys). " + ASK)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # fail closed
        refuse(f"The manager gate hit an error ({type(e).__name__}: {e}); the command was not run. " + ASK)
    sys.exit(0)
