#!/usr/bin/env python3
"""Factory roles (#102): the small per-role definition the shared loop runner (factory-loop.sh) reads, and the
project's role folder.

A role is started the same way, `factory <role> [name] loop [-i] [--once] [--dry-run]`, and runs the same loop; what
differs is written here:

  coding-agent   claims a task and runs /next-task on it (today's `factory loop`)
  dev-manager    the orchestrator (factory_orchestrator.py), no model: it reads GitHub (factory_watch.py) and starts
                 one-item sub-managers, each a fresh `claude -p /manage-pass <item>`
  product-owner  runs /product-pass when an issue or pull request carries `roles.product-owner.workLabel`

The project's role folder (`roles.dir`, default `.claude/factory/roles`, committed in the project) holds, per role,
`README.md` (the project's own instructions for the role) and `reads.md` (the documents it reads, one per line with
a reason). A project without the folder falls back to its `notes` (`<notes>/manager.md` and so on).

  factory_roles.py vars <role>                 shell assignments for the loop runner (kind, skill, waits ...)
  factory_roles.py names <role>                the role's names, one per line
  factory_roles.py nth <role> <N>              the Nth name (so `factory dev-manager 2 loop` means the second)
  factory_roles.py work <role> [--name N]      exit 0 and one line per thing to do, or exit 3 "nothing to do"
  factory_roles.py prompt <role> <name> [arg]  the prompt a pass starts with (ends with a marker for factory usage)
  factory_roles.py claude-flags <role>         the settings flags for the role's sessions, one per line
  factory_roles.py choose                      ask for a role and a name (factory loop -i); prints "role name"
  factory_roles.py init [--force]              scaffold the role folders (factory init-roles)
  factory_roles.py reads [role]                every path in reads.md that does not exist (exit 1 when any)
"""
import glob, json, os, re, shlex, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import (DEFAULTS, ROLE_NAMES, load, role_names, role_setting, role_wait, roles_dir,  # noqa: E402
                            safe_agent)

ROLE_DEFS = {
    "coding-agent": {"title": "coding agent", "kind": "task", "skill": "next-task", "model": "builder",
                     "notes": "next-task"},
    "dev-manager": {"title": "dev manager", "kind": "orchestrator", "skill": "manage-pass", "model": "manager",
                    "notes": "manager"},
    "product-owner": {"title": "product owner", "kind": "claude", "skill": "product-pass", "model": "product-owner",
                      "notes": "product-owner"},
}
MARK = "factory-role"


def need(role):
    if role not in ROLE_DEFS:
        raise SystemExit(f"factory: '{role}' isn't a role. The roles are {', '.join(ROLE_NAMES)}.")
    return ROLE_DEFS[role]


def role_dir(cfg, role):
    """The project's folder for `role` when it exists, else None."""
    path = os.path.join(roles_dir(cfg), role)
    return path if os.path.isdir(path) else None


def notes_file(cfg, role):
    """The old-style note (`<notes>/<name>.md`) for the role when it exists, else None."""
    folder = cfg.get("notes") or DEFAULTS["notes"]
    path = os.path.join(folder, f"{need(role)['notes']}.md")
    return path if os.path.isfile(path) else None


def context_line(cfg, role):
    """The sentence a pass starts with so it reads the project's instructions first, and nothing else up front."""
    folder = role_dir(cfg, role)
    if folder:
        return (f"Read {folder}/README.md first, then {folder}/reads.md, and open only the documents it lists "
                "that this work needs.")
    note = notes_file(cfg, role)
    if note:
        return f"Read {note} first (this project's additions for the {need(role)['title']})."
    return ""


def prompt(cfg, role, name, item="", extra=""):
    """The prompt a pass starts with: the skill (and the item), `extra` (the dev manager's fact sheet and thread note),
    the line telling it to read the project's instructions, and the marker `factory usage --by role` reads."""
    d = need(role)
    first = f"/{d['skill']}" + (f" {item}" if item else "")
    ctx = context_line(cfg, role)
    return "\n\n".join(x for x in (first, extra.strip(), ctx, f"<!-- {MARK} role={role} name={name} -->") if x)


# --- reads.md ------------------------------------------------------------------------------------------------------

def parse_reads(text):
    """[(path, section, reason)] from a reads.md: `- path#section - why` or `path  why`, `#` lines are comments."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("<!--"):
            continue
        line = re.sub(r"^[-*]\s+", "", line)
        m = re.match(r"`([^`]+)`\s*(?:[-:–—]\s*)?(.*)$", line) or re.match(r"(\S+)\s*(?:[-:–—]\s+)?(.*)$", line)
        if not m:
            continue
        target, why = m.group(1), m.group(2).strip()
        path, _, section = target.partition("#")
        out.append((path, section, why))
    return out


def missing_reads(cfg, role):
    """The paths in the role's reads.md that don't exist (a glob must match something), or None without a file."""
    folder = role_dir(cfg, role)
    reads = os.path.join(folder, "reads.md") if folder else ""
    if not folder or not os.path.isfile(reads):
        return None
    bad = []
    for path, _, _ in parse_reads(open(reads, encoding="utf-8").read()):
        if "://" in path:
            continue
        if not (glob.glob(path) if any(c in path for c in "*?[") else os.path.exists(path)):
            bad.append(path)
    return bad


# --- scaffolding ---------------------------------------------------------------------------------------------------

README = {
    "coding-agent": """# Coding agent: this project's instructions

The factory's `next-task` skill says how a task is built. This file is what the skill cannot know about this
project: known flaky tests, protected paths, numbering rules for decisions and migrations, who the owner is, the
product's voice. Keep it short; the agent reads it before every task.

- Protected paths (a person merges these): see `protected` in `.claude/factory.json`.
- Known flakes:
- Numbering rules:
- Who the owner is:
""",
    "dev-manager": """# Dev manager: this project's instructions

The factory's `manage-pass` skill holds the standing rules (what the manager does on its own, what it asks the owner,
the markers, the merge command). This file is what is specific to this project. It is read before every item.

- Known flaky CI jobs (the only ones a manager may re-run):
- Protected paths (the owner merges these):
- Decision and migration number rules:
- Who the owner is, and how to reach them (the login to mention in a question):
- Watch items for review:
""",
    "product-owner": """# Product owner: this project's instructions

The factory's `product-pass` skill says how a pass runs. This file is what is specific to this project: the product,
who it is for, the voice, what the owner decides alone, and where the PRD and the designs live (see `reads.md`).

- The product in one paragraph:
- The owner decides alone:
- Voice and wording rules:
- Where open product questions are asked (the owner queue):
""",
}


def default_reads(cfg, role):
    """The reads.md a new role folder starts with: the project's own documents that exist, each with a reason."""
    rows = {
        "coding-agent": [("CLAUDE.md", "the project's rules"), (cfg.get("plan"), "the build plan: the task's section"),
                         (cfg.get("prd"), "the PRD: only the sections a task points to"),
                         (cfg.get("decisions"), "decision records the task names")],
        "dev-manager": [("CLAUDE.md", "the project's rules, the review checklist"),
                        (cfg.get("plan"), "the build plan, to place a task"),
                        (cfg.get("blocked"), "what is blocked and why"),
                        (cfg.get("decisions"), "the decisions index, for the numbering rule"),
                        (".claude/hooks/pr-gate.py", "the PR gate: what an agent may merge")],
        "product-owner": [("CLAUDE.md", "the project's rules"), (cfg.get("prd"), "the PRD: user stories and decisions"),
                          ("design", "design references, STYLE.md first"), (cfg.get("decisions"), "decision records"),
                          ("research", "research notes")],
    }[role]
    lines = [f"- {path} - {why}" for path, why in rows if path and os.path.exists(path)]
    head = ("# What this role reads\n\n"
            "One document per line: `path` or `path#section`, then a dash and why. The role's skill reads this list\n"
            "first and nothing else up front, so a pass does not load the whole PRD or the repo's docs. A section lets\n"
            "the role `grep -n` for it. `factory doctor` checks that every path exists.\n\n")
    return head + ("\n".join(lines) + "\n" if lines else "- CLAUDE.md - the project's rules\n")


def init(cfg, force=False):
    """Creates <roles.dir>/<role>/README.md and reads.md for every role; never overwrites unless force."""
    made = []
    for role in ROLE_NAMES:
        folder = os.path.join(roles_dir(cfg), role)
        os.makedirs(folder, exist_ok=True)
        for name, text in (("README.md", README[role]), ("reads.md", default_reads(cfg, role))):
            path = os.path.join(folder, name)
            if force or not os.path.exists(path):
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
                made.append(path)
    return made


# --- the loop runner's questions -----------------------------------------------------------------------------------

def shell_vars(cfg, role):
    d = need(role)
    wait = lambda kind: role_wait(cfg, role, kind)  # noqa: E731
    pairs = {"kind": d["kind"], "skill": d["skill"], "model_role": d["model"], "title": d["title"],
             "busy": f"{wait('busy'):g}" if role != "coding-agent" else "0",
             "idle": f"{wait('idle'):g}" if role != "coding-agent" else "0",
             "profile": str(role_setting(cfg, role, "profile", "") or "")}
    return "\n".join(f"role_{k}={shlex.quote(str(v))}" for k, v in pairs.items())


def profile_flags(cfg, role):
    """The settings flags for a role's sessions. With a profile file, the session reads only the user's settings and
    that profile (the project's own settings deny `gh api`, and the profile has to allow it): `--setting-sources user
    --settings <profile + no claude.ai connectors>`. Without one, today's flags."""
    off = {"disableClaudeAiConnectors": True}
    path = str(role_setting(cfg, role, "profile", "") or "")
    if role == "coding-agent" or not path or not os.path.isfile(path):
        return ["--settings", json.dumps(off)]
    try:
        profile = json.load(open(path))
    except (OSError, ValueError) as e:
        raise SystemExit(f"factory: the {role} profile {path} isn't valid JSON ({e}). Fix it, or set "
                         f"`roles.{role}.profile` to another file.")
    return ["--setting-sources", "user", "--settings", json.dumps({**profile, **off}, separators=(",", ":"))]


def session_flags(cfg, role):
    """The `claude` arguments for a session of `role` started from Python (the orchestrator's sub-managers), the same
    the loop script builds: only the project's MCP servers as main has them, the role's profile, and the model."""
    import subprocess
    mcp = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "factory_mcp.py")],
                         capture_output=True, text=True).stdout.strip() or '{"mcpServers":{}}'
    flags = ["--mcp-config", mcp, "--strict-mcp-config", *profile_flags(cfg, role)]
    import factory_models
    try:
        flags += factory_models.flags(need(role)["model"], factory_models.validate(cfg.get("models", {})))
    except ValueError as e:
        raise SystemExit(f"factory: {e} Fix it with `factory settings set models '<json>'`.")
    return flags


def work(cfg, role, name=""):
    """What `role` has to do now, one line each, empty when nothing. Reads GitHub only."""
    if role == "product-owner":
        import factory_issues as fi
        label = str(role_setting(cfg, role, "workLabel", "") or "")
        if not label:
            return []
        items = fi.gh_all(f"repos/{{owner}}/{{repo}}/issues?state=open&labels={label}")
        return [f"{'PR' if i.get('pull_request') else 'issue'} #{i['number']}: {i['title']} ({label})" for i in items]
    if role == "dev-manager":
        import factory_wait
        return factory_wait.precheck(cfg)
    raise SystemExit("factory: a coding agent's work is `factory next`.")


def choose(stdin=None, out=None):
    """Asks which role and which name (factory loop -i with no role). Returns (role, name)."""
    stdin, out = stdin or sys.stdin, out or sys.stderr
    cfg = load()
    from factory_claims import free_names
    roles = list(ROLE_NAMES)
    out.write("Which role?\n" + "".join(f"  {i}) {ROLE_DEFS[r]['title']}\n" for i, r in enumerate(roles, 1)) + "[1]: ")
    out.flush()
    pick = (stdin.readline() or "").strip()
    if not pick:
        role = roles[0]
    elif pick.isdigit() and 1 <= int(pick) <= len(roles):
        role = roles[int(pick) - 1]
    elif pick in roles:
        role = pick
    else:
        raise SystemExit(f"factory: '{pick}' isn't one of the roles (1 to {len(roles)}, or {', '.join(roles)}).")
    try:
        free = free_names(role, float(cfg.get("claimStaleHours", 6)))
    except SystemExit:
        free = []
    out.write(f"Which name? Free names: {', '.join(free) or '(none; type a new one)'}\n"
              f"Press Enter for {free[0] if free else 'the first'}, or type one: ")
    out.flush()
    name = (stdin.readline() or "").strip()
    if name:
        name = safe_agent(name)
    elif free:
        name = free[0]
    return role, name


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd, rest = argv[0], argv[1:]
    cfg = load()
    if cmd == "choose":
        role, name = choose()
        print(role, name)
    elif cmd == "init":
        made = init(cfg, force="--force" in rest)
        for p in made:
            print(f"added    {p}")
        print(f"The role folders are in {roles_dir(cfg)}/." if made else f"{roles_dir(cfg)}/ already has them.")
    elif cmd == "reads":
        roles = rest or list(ROLE_NAMES)
        bad = 0
        for role in roles:
            miss = missing_reads(cfg, need(role) and role)
            if miss is None:
                continue
            for p in miss:
                bad += 1
                print(f"{role}: {p} (listed in {roles_dir(cfg)}/{role}/reads.md) does not exist")
        sys.exit(1 if bad else 0)
    elif cmd in ("vars", "names", "nth", "work", "prompt", "claude-flags"):
        role = need(rest[0]) and rest[0] if rest else sys.exit(f"usage: factory_roles.py {cmd} <role>")
        if cmd == "vars":
            print(shell_vars(cfg, role))
        elif cmd == "names":
            print("\n".join(role_names(cfg, role)))
        elif cmd == "nth":
            names = role_names(cfg, role)
            n = int(rest[1]) if len(rest) > 1 and rest[1].isdigit() else 0
            if not 1 <= n <= len(names):
                sys.exit(f"factory: there is no {role} number {rest[1:] or ''}; the names are {', '.join(names)}.")
            print(names[n - 1])
        elif cmd == "work":
            lines = work(cfg, role)
            print("\n".join(lines) if lines else "nothing to do")
            sys.exit(0 if lines else 3)
        elif cmd == "prompt":
            print(prompt(cfg, role, rest[1] if len(rest) > 1 else "", " ".join(rest[2:])))
        else:
            print("\n".join(profile_flags(cfg, role)))
    else:
        sys.exit(f"factory_roles.py: unknown command '{cmd}'.\n{__doc__}")


if __name__ == "__main__":
    main(sys.argv[1:])
