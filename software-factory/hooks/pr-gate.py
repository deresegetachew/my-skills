#!/usr/bin/env python3
"""PreToolUse hook on Bash: gate the coding agent's pull-request commands.

create (and `gh pr new`, `gh pr ready`): needs a reviewer pass for the commit (<reviewMarkers>/<branch>.ok holding
        it), except draft PRs (`--draft`), which are for questions and early feedback. When the diff touches a path
        in `styles`, it also needs the architecture-reviewer's pass (<branch>.arch.ok). When main's factory.json sets
        `commands.ci`, it also needs `factory verify` to have passed that commit (<branch>.ci.ok), so a PR doesn't
        reach CI with errors the agent could have caught locally (#58).
merge:  needs those passes for the PR's head commit, green CI, no protected paths changed (`protected` in
        .claude/factory.json; `alwaysAllowed` files such as the build plan are fine), no hold label, no open
        dev-manager must-fix, and `--match-head-commit <head>` so the commit checked is the commit merged.
Numbers: create and ready also need every new decision or migration file (`decisions`, `numberedDirs`) to take a
        number that neither main nor another open PR has (factory_numbers.py); the message names the next free one.
Issues mode (`tasks.source: "issues"`): create also needs the branch's issue (task/<n>-...) open, not blocked, not
        held by another agent, and `Closes #<n>` in the PR body.
Markers: agents may not post the dev manager's markers (factory-approved, factory-answer, factory-mustfix), add
        the review labels or remove the hold label.
Messages (docs/messages.md): a comment with a `factory-msg` envelope is checked too. An agent posts as itself
        (from= is FACTORY_AGENT), never as kind approval or mustfix, and answers, works on or fails only a question
        addressed to it, with a valid state transition; the question is looked up in the thread (the number on the
        command, else ref=). An envelope of another version is not read, so it passes. With `trustedReviewers` in factory.json, only those GitHub
        logins' approvals count. An approval counts only for the commit it names (`sha=`).
Pushes: agents may not delete remote branches (`git push <remote> :<branch>` or `+:<branch>`), also inside bash -c.
Settings: agents may not change the factory's settings (`factory settings set`, `unset`, `pr`, `interactive`, `--local`
        changes, `docs --write`), also inside bash -c; the read-only ones (list, get, help, diff, validate) pass (#49).
Wrappers: gh run through a shell, eval, xargs or a package runner (pnpm exec, npx, yarn) can't be checked: refused.

This gate is a guard rail for well-meaning agents, not a security boundary: branch protection and required CI
checks on GitHub are. It fails closed: an error, or a command it can't read, blocks the command.
Exit 2 blocks the command and tells Claude why.
"""
import json, os, re, shlex, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

GH_COMMANDS = {"api", "attestation", "auth", "browse", "cache", "codespace", "completion", "config", "copilot",
               "extension", "gist", "gpg-key", "help", "issue", "label", "org", "pr", "preview", "project",
               "release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status", "variable", "workflow",
               "version"}
GLOBAL_WITH_VALUE = {"-R", "--repo", "--hostname"}
VALUE_FLAGS = {  # flags of the gh subcommands the gate reads that take a value
    "-t", "--title", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email",
    "--match-head-commit", "-B", "--base", "-H", "--head", "-a", "--assignee", "-l", "--label", "-m",
    "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "--add-label", "--remove-label",
    "--add-assignee", "--remove-assignee", "--add-reviewer", "--remove-reviewer", "--add-project",
    "--remove-project", "-c", "--comment", "-R", "--repo", "-q", "--jq", "--json", "-S", "--search", "-L",
    "--limit", "-s", "--state"}
# gh pr merge: -s, -m, -r and -d are booleans there (squash, merge, rebase, delete branch), not values.
MERGE_VALUE_FLAGS = {"-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email",
                     "--match-head-commit", "-R", "--repo"}
# Text the gate can't see because the shell would expand it first: $(...), `...`, ${...} and $NAME.
SHELL_EXPANSION = re.compile(r"\$\(|`|\$\{|\$[A-Za-z_]")
MARKERS = re.compile(r"<!--\s*factory-(approved|answer|mustfix)\b")
REVIEW_LABELS = {"tests-reviewed", "deps-reviewed"}
SEPARATORS = set(";&|()<>")
# Prefixes that run the next word as the program, so `env gh pr merge` and `sudo gh ...` are still gh.
PREFIXES = {"env", "command", "builtin", "exec", "sudo", "nohup", "time", "nice", "doas",
            # shell words that start a command list: `if gh pr merge ...; then`, `! gh ...`, `{ gh ...; }`
            "if", "then", "else", "elif", "while", "until", "do", "!", "{", "}"}
# Programs that run a command given as text; a gh command inside their arguments can't be checked.
WRAPPERS = {"bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "xargs", "env", "nohup", "time", "timeout",
            "sudo", "script", "watch", "nice", "python", "python3", "node", "perl", "ruby",
            # package runners run the next words as a program: `pnpm exec gh pr merge 7` is gh, unchecked
            "pnpm", "pnpx", "npx", "npm", "yarn", "bunx", "bun", "corepack"}
GH_IN_SUBSTITUTION = re.compile(r"(\$\(|`)\s*(\S*/)?gh(\s|[`)]|$)")  # "$(gh pr merge 7)", `gh ...`
GH_IN_TEXT = re.compile(r"(^|[^\w.-])gh\s+(-\S+\s+)*[a-z]")
# A refspec that deletes a remote branch: `git push origin :task/1-x` or `+:x` (#47).
GIT_GLOBAL_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
PUSH_DELETE_IN_TEXT = re.compile(r"(^|[^\w.-])git\b[^;&|]*\bpush\b[^;&|]*\s\+?:")


SETTINGS_READ_ONLY = {"list", "ls", "get", "show", "help", "options", "diff", "validate", "docs"}
SETTINGS_WITH_VALUE = {"--section", "--file"}


def settings_change(args):
    """True when these arguments of `factory settings` would change something: anything but the read-only commands."""
    if "-i" in args:
        return True
    sub, skip = None, False
    for a in args:
        if skip:
            skip = False
        elif a in SETTINGS_WITH_VALUE:
            skip = True
        elif not a.startswith("-"):
            sub = a
            break
    if sub is None:
        return False  # bare `factory settings` lists (the menu needs a terminal an agent doesn't have)
    return sub not in SETTINGS_READ_ONLY or (sub == "docs" and "--write" in args)


def changes_settings(cmd, depth=0):
    """True when the command (or a bash -c inside it) runs a `factory settings` command that changes settings."""
    try:
        parts = simple_commands(cmd)
    except ValueError:
        return bool(re.search(r"factory\s+settings\s+(?!(list|ls|get|show|help|options|diff|validate)\b)", cmd))
    for tokens in parts:
        i = 0
        while i < len(tokens) and (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[i]) or tokens[i] in PREFIXES
                                   or (i and tokens[i - 1] in PREFIXES and tokens[i].startswith("-"))):
            i += 1
        if i >= len(tokens):
            continue
        prog, rest = os.path.basename(tokens[i]), tokens[i + 1:]
        if prog in ("bash", "sh", "zsh", "dash") and "-c" in rest and depth < 3:
            k = rest.index("-c")
            if k + 1 < len(rest) and changes_settings(rest[k + 1], depth + 1):
                return True
        elif prog == "factory" and rest[:1] == ["settings"]:
            if settings_change(rest[1:]):
                return True
        elif prog.startswith("factory_settings") and settings_change(rest):
            return True
        elif prog in ("python", "python3"):
            for k, t in enumerate(rest):
                if os.path.basename(t).startswith("factory_settings") and settings_change(rest[k + 1:]):
                    return True
    return False


def push_deletes(tokens):
    """Whether this simple command is `git push` with a refspec that deletes a remote branch (`:branch`)."""
    i = 0
    while i < len(tokens) and (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[i]) or tokens[i] in PREFIXES):
        i += 1
    if i >= len(tokens) or os.path.basename(tokens[i]) != "git":
        return False
    i += 1
    while i < len(tokens) and tokens[i].startswith("-"):  # git's global options, some with a value
        i += 2 if tokens[i] in GIT_GLOBAL_WITH_VALUE else 1
    if i >= len(tokens) or tokens[i] != "push":
        return False
    return any(t.startswith((":", "+:")) and len(t.lstrip("+")) > 1 for t in tokens[i + 1:])


def run(*a):
    p = subprocess.run(a, capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def block(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def simple_commands(cmd):
    """The command split into simple commands (on ; & | && || newlines and brackets), each a token list."""
    cmd = cmd.replace("\\\r\n", " ").replace("\\\n", " ")  # a backslash-newline continues the line in bash
    lex = shlex.shlex(cmd.replace("\n", " ; "), posix=True, punctuation_chars="".join(sorted(SEPARATORS)))
    lex.whitespace_split = True
    lex.commenters = ""
    out, cur = [], []
    for tok in lex:
        if tok and set(tok) <= SEPARATORS:
            if cur:
                out.append(cur)
            cur = []
        else:
            cur.append(tok)
    if cur:
        out.append(cur)
    return out


def gh_call(tokens):
    """(top-level command, subcommand, args) when this simple command runs gh, else None."""
    i = 0  # gh counts only as the program: after VAR=value assignments and plain prefixes like env or sudo
    while i < len(tokens) and (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[i]) or tokens[i] in PREFIXES
                               or (i and tokens[i - 1] in PREFIXES and tokens[i].startswith("-"))):
        i += 1
    if i >= len(tokens) or os.path.basename(tokens[i]) != "gh":
        return None
    rest, k = tokens[i + 1:], 0

    def word():
        nonlocal k
        lead = []
        while k < len(rest):
            t = rest[k]
            if t in GLOBAL_WITH_VALUE:
                lead += rest[k:k + 2]
                k += 2
            elif t.startswith("-"):
                lead.append(t)
                k += 1
            else:
                k += 1
                return t, lead
        return "", lead

    top, _ = word()
    sub, lead = word()
    return top, sub, lead + rest[k:]


def parse_args(args, value_flags=None):
    """(flags {name: [values]}, positionals) for gh-style arguments."""
    value_flags = VALUE_FLAGS if value_flags is None else value_flags
    flags, pos, k = {}, [], 0
    while k < len(args):
        t = args[k]
        if t.startswith("--") and "=" in t:
            name, value = t.split("=", 1)
            flags.setdefault(name, []).append(value)
        elif t in value_flags and k + 1 < len(args):
            flags.setdefault(t, []).append(args[k + 1])
            k += 1
        elif len(t) > 2 and not t.startswith("--") and t[:2] in value_flags:  # -F/tmp/x.md, -b'text'
            flags.setdefault(t[:2], []).append(t[2:])
        elif t.startswith("-") and len(t) > 1:
            flags.setdefault(t, []).append("")
        else:
            pos.append(t)
        k += 1
    return flags, pos


def is_true(flags, *names):
    """Whether a boolean flag is set and every value given for it is true (gh uses the last one, so a mix is refused
    as not set: --draft --draft=false is not a draft)."""
    given = values(flags, *names)
    return bool(given) and all(v in ("", "true") for v in given)


def values(flags, *names):
    return [v for n in names for v in flags.get(n, [])]


def body_text(flags):
    """The PR or comment body the command passes: --body values and --body-file contents."""
    given = values(flags, "-b", "--body", "-c", "--comment", "-F", "--body-file")
    if any(SHELL_EXPANSION.search(v) for v in given):
        block("Write the body as plain text or a --body-file path: the PR gate reads the command before the shell "
              "expands $(...), `...` or $VARIABLES, so it can't check what they'd say.")
    text = "\n".join(values(flags, "-b", "--body", "-c", "--comment"))
    for f in values(flags, "-F", "--body-file"):
        if f == "-":
            block("Pass the body with --body or a --body-file path, not on stdin: the PR gate has to read it.")
        if not os.path.isfile(f):
            block(f"--body-file {f} doesn't exist.")
        with open(f) as fh:
            text += "\n" + fh.read()
    return text


def main():
    data = json.load(sys.stdin)
    cmd = (data.get("tool_input") or {}).get("command", "") or ""
    if "settings" in cmd and changes_settings(cmd):
        block("Agents don't change the factory's settings (`factory settings set`, `unset`, `pr`, `interactive`, "
              "`--local`, `docs --write`): the PR gate reads them. `factory settings list`, `get`, `help`, `diff` and "
              "`validate` are fine. Ask the dev manager to change the setting in a pull request.")
    if re.search(r"\bpush\b", cmd) and re.search(r"\bgit\b", cmd):
        try:
            pushes = simple_commands(cmd)
        except ValueError:
            block("The PR gate can't read this command (unbalanced quotes?). Write it more simply.")
        if any(push_deletes(p) for p in pushes) or any(
                p and os.path.basename(p[0]) in WRAPPERS and PUSH_DELETE_IN_TEXT.search(" ".join(p[1:]))
                for p in pushes):
            block("Agents don't delete remote branches (`git push <remote> :<branch>`). Leave branch clean-up to the "
                  "dev manager.")
    if not re.search(r"(^|[^\w.-])gh\b", cmd):
        return  # no gh at all: the fast path for every other Bash call
    try:
        parts = simple_commands(cmd)
    except ValueError:
        block("The PR gate can't read this command (unbalanced quotes?). Write it more simply.")
    calls = [(c, p) for c, p in ((gh_call(p), p) for p in parts) if c]
    # gh hidden inside one argument (bash -c '...', eval "...", xargs sh -c ...) can't be checked: refuse it.
    if any((os.path.basename(p[0]) in WRAPPERS and (any(GH_IN_TEXT.search(t) for t in p[1:])
                                                     or GH_IN_TEXT.search(" ".join(p[1:]))))
           for p in parts if p) or GH_IN_SUBSTITUTION.search(cmd):
        block("Run gh directly, not inside bash -c, sh -c, eval or a quoted string: the PR gate has to see the command.")
    if not calls:
        return
    from factory_config import load, load_from_main
    # The rules come from main's factory.json, never this worktree's copy, which the agent could edit (#51).
    cfg = load_from_main(load())
    for (top, sub, args), tokens in calls:
        if top in ("pr", "issue") and any(t in ("-R", "--repo") or t.startswith(("--repo=", "-R")) for t in tokens):
            block("Agents work on this repository only: leave out -R/--repo, so the gate checks the PR it means.")
    if any(p and os.path.basename(p[0]) in ("cd", "pushd", "popd") for p in parts):
        block("Run pull-request commands from the project folder, without cd in the same command: the gate checks "
              "the repository it runs in.")
    calls = [c for c, _ in calls]
    for top, sub, args in calls:
        if top == "alias":
            block("Agents don't define gh aliases.")
        if top and top not in GH_COMMANDS:
            block(f"`gh {top}` isn't a gh command the factory knows (aliases and extensions aren't allowed for "
                  "agents). Use the plain gh command.")
    for top, sub, args in calls:
        if top in ("pr", "issue") and sub in ("comment", "edit", "review", "close", "reopen", "create", "new"):
            check_markers(cfg, sub, args)
    pr_calls = [(sub, args) for top, sub, args in calls if top == "pr"]
    merges = [args for sub, args in pr_calls if sub == "merge"]
    gated = [(sub, args) for sub, args in pr_calls if sub in ("create", "new", "ready", "merge")
             and not (sub == "ready" and is_true(parse_args(args)[0], "--undo"))]  # back to draft: nothing to gate
    if not gated:
        return
    if len(merges) > 1:
        block("One merge per command, so each one is checked.")
    if merges and any(p and os.path.basename(p[0]) == "git" and "push" in p[1:4] for p in parts):
        block("Push and merge in separate commands: a push in the same command would merge a commit nobody checked.")
    if len(gated) > 1:
        block("One pull-request command at a time (create, ready or merge), so each one is checked.")
    sub, args = gated[0]
    if sub in ("create", "new"):
        gate_create(cfg, args)
    elif sub == "ready":
        gate_ready(cfg, args)
    else:
        gate_merge(cfg, args)


def check_markers(cfg, sub, args):
    flags, _ = parse_args(args)
    if any(SHELL_EXPANSION.search(v) for vs in flags.values() for v in vs):
        block("Write labels and other values as plain text: the PR gate reads the command before the shell expands "
              "$(...), `...` or $VARIABLES.")
    if sub == "review" and ("--approve" in flags or "-a" in flags):
        block("Agents don't approve pull requests; the dev manager does.")
    text = body_text(flags)
    if MARKERS.search(text):
        block("Only the dev manager posts factory-approved, factory-answer and factory-mustfix comments. Ask with "
              "<!-- factory-question --> instead.")
    check_messages(args, text)
    labels = lambda *n: {x.strip() for v in values(flags, *n) for x in v.split(",")}
    hold = cfg.get("holdLabel", "factory-hold")
    if hold in labels("--remove-label"):
        block(f"Only the dev manager removes `{hold}`.")
    if REVIEW_LABELS & labels("--add-label", "-l", "--label"):
        block("Only the dev manager adds the review labels (tests-reviewed, deps-reviewed).")


def read_thread(number):
    rc, out, err = run("gh", "api", "--paginate", f"repos/{{owner}}/{{repo}}/issues/{number}/comments")
    if rc != 0:
        block(f"I could not read the comments of #{number} to check this message ({err[:200]}). Try again in a moment.")
    import factory_messages as fm
    return fm.messages_of(fm.decode_pages(out))


def check_messages(args, text):
    """The reserved senders and the state machine for messages in the new envelope (docs/messages.md): an agent posts as
    itself; approvals and must-fixes stay the dev manager's; only the addressee answers, works on or fails a question,
    and a transition must be valid. Envelopes of another version, and plain text, pass: nothing reads them."""
    import factory_messages as fm
    found = fm.parse_envelopes(text)
    if not found:
        return
    me = os.environ.get("FACTORY_AGENT") or None
    _, pos = parse_args(args)
    number = pos[0] if pos and pos[0].isdigit() else None  # `gh pr comment 7`
    for m in found:
        problem = fm.check_new(m, None, me)  # the checks that need no thread
        if not problem and m.kind in ("answer", "status") and m.in_reply_to:
            ref = fm.ref_number(m.ref)
            if number and ref and ref != number:
                block(f"This message says ref={m.ref} but you are commenting on #{number}. Post the reply in the thread "
                      "of the question, or fix ref=.")
            if not (number or ref):
                block("Say which pull request or issue this reply belongs to: add ref=pr#<n> or ref=issue#<n> to the "
                      "message, or name the number on the command (gh pr comment <n>).")
            problem = fm.check_new(m, fm.fold(read_thread(number or ref)), me)
        if problem:
            block(problem + " (Messages: docs/messages.md in the software-factory.)")


def passed(cfg, branch, sha, kind=".ok"):
    mark = os.path.join(cfg["reviewMarkers"], branch.replace("/", "_") + kind)
    if not os.path.isfile(mark):
        return False
    with open(mark) as f:
        return f.read().strip() == sha


ARCH_MSG = ("This change touches code with a style guide ({skills}), and the architecture-reviewer hasn't passed "
            "this commit. Ask the architecture-reviewer subagent, fix every must-fix, then try again.")


def need_reviews(cfg, branch, head, changed):
    from factory_config import styled
    if not passed(cfg, branch, head):
        block("No reviewer pass for this commit. Ask the reviewer subagent to review the diff, fix any "
              "must-fix items, then try again.")
    styles = styled(changed, cfg)
    if styles and not passed(cfg, branch, head, ".arch.ok"):
        block(ARCH_MSG.format(skills=", ".join(sorted({s for st in styles for s in st.get("skills", [])}))))


def need_local_ci(cfg, branch, head):
    """`commands.ci` on main: the same checks CI runs, passed locally for this exact commit by `factory verify`."""
    if (cfg.get("commands") or {}).get("ci") and not passed(cfg, branch, head, ".ci.ok"):
        block("CI's checks haven't passed locally for this commit. Run `factory verify` (or "
              "`python3 .claude/hooks/factory_verify.py`), fix what fails, commit, and try again.")


def need_task(cfg, branch, body):
    from factory_config import blocked_ids, branch_task, task_labels, task_source, tasks
    tid = branch_task(branch)
    if tid and task_source(cfg) == "issues":
        L = task_labels(cfg)
        n = tid.split(".")[0]
        rc, out, err = run("gh", "api", f"repos/{{owner}}/{{repo}}/issues/{n}")
        if rc != 0:
            block(f"Branch {branch} names issue #{n}, which I can't read ({err[:200]}). Name the branch "
                  "task/<issue number>-<short-name>.")
        issue = json.loads(out)
        names = {x["name"] for x in issue.get("labels", [])}
        if issue.get("state") != "open":
            block(f"Issue #{n} is closed. Pick the next job with `python3 .claude/hooks/next_task.py`.")
        held_by = [x[len(L["agentPrefix"]):] for x in names if x.startswith(L["agentPrefix"])]
        me = os.environ.get("FACTORY_AGENT")
        if me and held_by and me not in held_by:
            block(f"Issue #{n} now belongs to {', '.join(held_by)} (it was released while you were quiet). Leave it, "
                  "and pick the next job with `python3 .claude/hooks/next_task.py`.")
        if L["blocked"] in names:
            block(f"Issue #{n} is blocked (see its comments). Pick the next job with `python3 .claude/hooks/next_task.py`.")
        if not re.search(rf"\b(closes|fixes|resolves)\s+#{n}\b", body, re.I):
            block(f"Say `Closes #{n}` in the pull request body, so merging it closes the issue.")
    elif tid:
        main = cfg["mainBranch"]
        plan = run("git", "show", f"origin/{main}:{cfg['plan']}")[1]
        done = {i for i, d, _ in tasks(plan) if d}
        blocked = blocked_ids(run("git", "show", f"origin/{main}:{cfg['blocked']}")[1])
        if tid in done:
            block(f"Task {tid} is already ticked on {main}. Run `python3 .claude/hooks/next_task.py` and build that one.")
        if tid in blocked:
            block(f"Task {tid} is in {cfg['blocked']}. Pick the next task with `python3 .claude/hooks/next_task.py`.")


def need_room(cfg):
    rc, out, err = run("gh", "pr", "list", "--author", "@me", "--state", "open", "--json", "number,isDraft")
    if rc != 0:
        block(f"Could not count your open pull requests ({err[:200]}). Try again in a moment.")
    ready = [p["number"] for p in json.loads(out or "[]") if not p["isDraft"]]
    if len(ready) >= int(cfg["maxOpenPRs"]):
        block(f"{len(ready)} of your pull requests are open (limit {cfg['maxOpenPRs']}): "
              + ", ".join(f"#{n}" for n in sorted(ready)) + ". Wait for the oldest with "
              f"`.claude/hooks/wait_for_merge.sh {min(ready)}`, or answer what's blocking it, before opening another.")


def need_free_numbers(cfg, branch, added=None):
    import factory_numbers
    try:
        found = factory_numbers.clashes(cfg, branch, added)
    except RuntimeError as e:
        block(f"Could not check the decision and migration numbers ({e}). Run `git fetch origin` and try again.")
    if found:
        block("A new numbered file takes a number that's already used:\n- " + "\n- ".join(found)
              + "\nRename it on this branch, commit, push, then open the pull request again.")


def gate_create(cfg, args):
    flags, _ = parse_args(args)
    if is_true(flags, "--draft", "-d"):
        return  # drafts are how agents ask questions; they can't be merged, and ready and merge stay gated
    branch = run("git", "branch", "--show-current")[1]
    head = run("git", "rev-parse", "HEAD")[1]
    rc, out, err = run("git", "diff", "--name-only", f"origin/{cfg['mainBranch']}...HEAD")
    if rc != 0:
        block(f"Could not list this branch's changes against origin/{cfg['mainBranch']} ({err[:200]}). "
              "Run `git fetch origin` and try again.")
    changed = out.split()
    need_reviews(cfg, branch, head, changed)
    need_local_ci(cfg, branch, head)
    need_task(cfg, branch, body_text(flags))
    need_free_numbers(cfg, branch)
    need_room(cfg)


def pr_ref(pos):
    if not pos:
        return []
    ref = pos[0]
    if not re.fullmatch(r"\d+", ref):  # a URL could name another repository, which the gate doesn't check
        block(f"Name the pull request by its number (got `{ref}`), so the gate checks the one you mean.")
    return [ref]


def view(ref, fields):
    rc, out, err = run("gh", "pr", "view", *ref, "--json", fields)
    if rc != 0:
        block("Could not read the pull request: " + (err or out)[:300])
    return json.loads(out)


def pr_files(number):
    rc, out, err = run("gh", "api", "--paginate", f"repos/{{owner}}/{{repo}}/pulls/{number}/files", "--jq",
                       ".[].filename")
    if rc != 0:
        block("Could not list the pull request's files: " + err[:300])
    return [x for x in out.splitlines() if x]


def gate_ready(cfg, args):
    _, pos = parse_args(args)
    pr = view(pr_ref(pos), "number,headRefName,headRefOid,body")
    need_reviews(cfg, pr["headRefName"], pr["headRefOid"], pr_files(pr["number"]))
    need_local_ci(cfg, pr["headRefName"], pr["headRefOid"])
    need_task(cfg, pr["headRefName"], pr.get("body") or "")
    import factory_numbers
    try:
        added = factory_numbers.pr_added(pr["number"])
    except RuntimeError as e:
        block(f"Could not check the decision and migration numbers ({e}). Try again in a moment.")
    need_free_numbers(cfg, pr["headRefName"], added)
    need_room(cfg)


def gate_merge(cfg, args):
    flags, pos = parse_args(args, MERGE_VALUE_FLAGS)
    pr = view(pr_ref(pos), "number,headRefName,headRefOid,comments,labels")
    head = pr["headRefOid"]
    hold = cfg.get("holdLabel", "factory-hold")
    if any(label.get("name") == hold for label in pr.get("labels", [])):
        block(f"The dev manager is reviewing this pull request (label `{hold}`). Leave it open and continue with the "
              "next task: the dev manager approves and merges it, or posts must-fixes, and removes the label.")
    import factory_messages as fm
    trusted = set(cfg.get("trustedReviewers") or [])
    last = None  # a must-fix holds the merge until an approval of the current head commit comes after it
    for c in pr.get("comments", []):
        body = c.get("body") or ""
        login = (c.get("author") or {}).get("login", "")
        for kind, sha in fm.verdicts(body):  # the envelope or the old marker
            if kind == "mustfix":
                last = "mustfix"
            elif not trusted or login in trusted:
                last = "approved" if sha and head.startswith(sha) else "stale"
    if last == "mustfix":
        block("The dev manager left a must-fix on this pull request (a `<!-- factory-mustfix -->` comment). Fix it, "
              "push, reply on the PR, and leave the merge to the dev manager, who approves with `<!-- factory-approved -->`.")
    if last == "stale":
        block("The dev manager's approval is for an older commit. Leave the merge to the dev manager.")
    if values(flags, "--match-head-commit") != [head]:
        block(f"Add `--match-head-commit {head}` so GitHub merges only the commit this gate checked.")
    files = pr_files(pr["number"])
    need_reviews(cfg, pr["headRefName"], head, files)
    rc, _, _ = run("gh", "pr", "checks", str(pr["number"]))
    if rc != 0:
        from factory_ci import MESSAGE, not_started
        why = not_started(head)
        if why:
            block(MESSAGE.format(why=why))
        block("CI is not green (or still running) for this pull request. Wait for it or fix it; do not merge.")
    hits = [p for p in files if p not in cfg["alwaysAllowed"] and any(re.search(rx, p) for rx in cfg["protected"])]
    if hits:
        block("This pull request changes protected files, so the dev manager or a person merges it: "
              + ", ".join(hits[:8]) + ". Leave it open, say so in the PR description, and continue with the next task.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # fail closed: a gate that crashes must not let the command through
        block(f"The PR gate hit an error ({type(e).__name__}: {e}); the command was not run. Fix the cause (for "
              "example .claude/factory.json, or gh not installed or signed in) and try again.")
    sys.exit(0)
