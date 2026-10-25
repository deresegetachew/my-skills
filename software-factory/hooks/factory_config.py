"""Reads .claude/factory.json for the factory hooks and scripts. Missing keys fall back to these defaults."""
import json, os, re

DEFAULTS = {
    "prd": "docs/PRD.md",
    "plan": "docs/build-plan.md",
    "blocked": "docs/blocked.md",
    "decisions": "docs/decisions",
    # More folders of numbered files besides `decisions` (for example ["db/migrations"]): a new file there must take
    # a number neither main nor another open PR has (factory_numbers.py, checked by the PR gate).
    "numberedDirs": [],
    "mainBranch": "main",
    # typecheckChanged / testChanged: the Stop check runs these instead of typecheck / test when set, for the
    # changed packages only (for example `pnpm -s turbo run test --filter=...[origin/main]`). Fewer test lines in
    # the agent's context, and a faster turn.
    # fix: a formatter and auto-fixer for the files this branch changed, e.g. `prettier --write {files} && eslint --fix
    # {files}` (#69). The Stop check and `factory verify` run it first; `factory fix` runs it by hand.
    # ci: what CI runs, for `factory verify`; when set on main, the PR gate needs it passed for the PR's commit.
    # stackUp / stackHealth: what `factory resume` runs at boot to bring the dev stack back (for example `pnpm stack:up`),
    # and an optional command that passes once the stack is healthy (#88).
    "commands": {"typecheck": "", "lint": "", "test": "", "build": "", "smoke": "",
                 "typecheckChanged": "", "testChanged": "", "ci": "", "fix": "", "stackUp": "", "stackHealth": ""},
    "codePaths": ["src"],
    # Regexes: when set, `commands.fix` gets only changed files matching one of them (empty: every changed file).
    "fixPaths": [],
    # How many lines of a failing Stop check the agent sees: the failing lines first, then the end of the output.
    "checkOutputLines": 40,
    # Where the full output of a failed check is saved (the agent sees only a capped summary and this path).
    "checkLogDir": "tmp/checks",
    "protected": [r"^CLAUDE\.md$", r"^\.claude/", r"^\.github/", r"^\.mcp\.json$", r"\.env",
                  r"(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$"],
    "alwaysAllowed": ["docs/build-plan.md", "docs/blocked.md"],
    # Tests and expected outputs: the implementer must not quietly change them (factory_guard.py).
    "testPaths": [r"(^|/)__tests__/", r"\.(test|spec)\.[cm]?[jt]sx?$", r"(^|/)e2e/", r"(^|/)tests?/",
                  r"_test\.(py|go)$", r"(^|/)test_[^/]*\.py$"],
    "goldenPaths": [r"(^|/)__snapshots__/", r"(^|/)fixtures?/", r"(^|/)golden[^/]*/"],
    "dependencyManifests": [r"(^|/)package\.json$"],
    "maxOpenPRs": 3,
    # The agents' names, one per loop: the first works in the project folder, the others in
    # <project>-agents/<name>. Labels (`agent:<name>`), claims and logs use them.
    "agents": ["menelik", "taytu", "haile", "tewodros", "yohannes", "zewditu", "lalibela", "ezana", "alula", "abebe"],
    # Roles other than the coding agent (#102): `factory dev-manager [name] loop`, `factory product-owner [name] loop`.
    # `dir` is the project's role folder (<dir>/<role>/README.md and reads.md, committed in the project); a project
    # without it falls back to its `notes`. Per role: `names` (like `agents`; the coding agent's are `agents`),
    # `profile` (a Claude settings file, used when it exists), and for the product owner `busyMinutes` (wait after a
    # pass that had work), `idleMinutes` (wait when there is none; 0: exit instead) and `workLabel`: an open issue or
    # pull request with that label is work for it. The dev manager's waits are `manager.busyMinutes` and
    # `manager.idleMinutes`.
    "roles": {
        "dir": ".claude/factory/roles",
        "dev-manager": {"names": ["fasil", "yekuno", "amda", "sarsa", "susenyos"],
                        "profile": ".claude/manager/settings.json"},
        "product-owner": {"names": ["mentewab", "eleni", "sabla"], "busyMinutes": 30, "idleMinutes": 60,
                          "profile": ".claude/product-owner/settings.json", "workLabel": "factory:needs-product"},
    },
    # The dev manager's waits (#102): minutes after a cycle that had work / none (0: the loop exits instead).
    "manager": {"busyMinutes": 10, "idleMinutes": 30},
    # Where tasks live. "plan": unticked lines of the build plan (the classic mode). "issues": open GitHub issues
    # with the `ready` label, claimed with labels and a claim comment (factory_issues.py); the plan is an overview.
    "tasks": {
        "source": "plan",
        "labels": {"ready": "factory:ready", "inProgress": "factory:in-progress", "inReview": "factory:in-review",
                   "blocked": "factory:blocked", "agentPrefix": "agent:"},
        "staleHours": 3,  # an in-progress issue with no activity for this long goes back to ready (dev manager)
        "pingMinutes": 5,  # an agent pings its agent issue at most this often while it works
        "downMinutes": 30,  # no ping for this long: the agent counts as down, and the sweep releases its issues
        # The heartbeat daemon (factory_heartbeat.py, #108): how often it looks at this machine's agents, how long a
        # missed keepalive may last before an agent it writes for counts as silent, and how long an agent that is
        # plainly down waits before the sweep gives its in-progress issues back.
        "heartbeatSeconds": 20,
        "heartbeatMissMinutes": 12,
        "releaseDownMinutes": 10,
    },
    "claimStaleHours": 6,  # a loop's task claim lapses after this (or when its process exits)
    "prSizeWarn": 600,
    "reviewMarkers": "tmp/reviews",
    # A reviewer's second round reads only the delta since its last round (factory_rereview.py): the limit, as a
    # percent of the branch diff's changed lines, above which it is a full review. 0: always a full review.
    "reReviewPercent": 30,
    # The curated lessons file (factory_lessons.py): one-line rules the builder and the reviewers read first, and the most
    # lessons it may hold. `factory lessons suggest` proposes new ones; the dev manager adds them.
    "lessons": ".claude/factory/lessons.md",
    "lessonsCap": 40,
    # Style guides per path: [{"paths": ["apps/api/**"], "skills": ["nestjs-clean-code-ddd-hexagonal"],
    #   "check": "python3 .claude/hooks/check_structure.py"}]. The architecture reviewer and CI use them.
    "styles": [],
    # Per-loop environment for parallel loops (factory_env.py): {"API_PORT": "{port:4100}",
    #   "DATABASE_URL": "postgres://app:app@localhost:5432/app{suffix}"}. Slot 1 keeps the defaults.
    # The Stop check skips while any of these is missing, e.g. ["node_modules"] before the first install.
    "checkRequires": [],
    # The label the dev manager puts on a PR it is reviewing: agents skip it (no rework) and can't merge it.
    "holdLabel": "factory-hold",
    "agentEnv": {},
    "portStep": 10,
    # Project additions for the shared agents and skills: <notes>/<agent or skill name>.md, read first if present.
    "notes": ".claude/factory/notes",
    # Which changes need which extra review or check (regexes on changed paths, like `protected`).
    # factory_reviews.py lists the ones a diff needs; next-task runs them and the reviewer checks they ran.
    "reviews": {
        "safety-auditor": {"paths": []},     # the rules CLAUDE.md says must never break
        "security-reviewer": {"paths": []},  # auth, payments, public endpoints, uploads, storage, tenancy, secrets
    },
    # The eval skill: {"command": "pnpm golden", "baseline": "path", "mustNotDrop": ["warning recall 100%"],
    #   "metrics": ["..."], "paths": ["regex", ...]}. Empty command: no eval yet.
    "eval": {},
    # The shared Turborepo remote cache (factory_turbo.py, `factory turbo`, #59). api: the address agents and CI use
    # (empty: off). team: default the repository's name. bind/port: where the server listens on its machine.
    # secretsCommand: prints TURBO_TOKEN=... lines (the token is never in this file).
    "turbo": {"api": "", "team": "", "bind": "127.0.0.1", "port": 3335, "secretsCommand": ""},
    # The design-check skill: {"references": "design/screens", "renders": "design/screens/png",
    #   "preview": "pnpm --filter web preview", "paths": ["regex", ...]}. Empty references: no design check.
    "design": {},
    # Where `factory update` finds releases of the factory (#113): {"repo": "owner/name"}. Default: my-skills.
    "release": {"repo": "deresegetachew/my-skills"},
}


def merged_section(name, user):
    """A nested setting (`roles`, `manager`) with the defaults under it: a project that sets one field of one role
    keeps the rest."""
    base = DEFAULTS[name]
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in base.items()}
    if isinstance(user, dict):
        for key, value in user.items():
            if isinstance(value, dict) and isinstance(out.get(key), dict):
                out[key].update(value)
            else:
                out[key] = value
    return out


def merged_roles(user):
    return merged_section("roles", user)


def load():
    root = os.environ.get("CLAUDE_PROJECT_DIR", ".")
    os.chdir(root)
    cfg = dict(DEFAULTS)
    try:
        with open(os.path.join(".claude", "factory.json")) as f:
            user = json.load(f)
        cfg.update({k: v for k, v in user.items() if not k.startswith("_")})
        cfg["commands"] = {**DEFAULTS["commands"], **user.get("commands", {})}
        cfg["roles"] = merged_roles(user.get("roles"))
        cfg["manager"] = merged_section("manager", user.get("manager"))
    except FileNotFoundError:
        pass
    return cfg


def load_from_main(local=None):
    """The settings as the repository's default branch has them on GitHub, never this machine's copy or refs.

    The PR gate enforces these settings, so an agent must not be able to change them from its worktree (#51): not
    by editing `.claude/factory.json`, not by setting `mainBranch`, and not by planting a local ref or tag named
    `origin/<main>`. So the branch comes from GitHub (`gh repo view`) and the file is read through the API at that
    branch. A 404 (no file on main yet) gives the defaults; any other failure raises, so the gate fails closed.
    `local` is unused and kept for callers."""
    import subprocess
    p = subprocess.run(["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
                       capture_output=True, text=True)
    main = p.stdout.strip()
    if p.returncode != 0 or not re.fullmatch(r"[\w./-]+", main or ""):
        raise RuntimeError("could not ask GitHub for the default branch (gh repo view): " + p.stderr.strip()[:200])
    p = subprocess.run(["gh", "api", f"repos/{{owner}}/{{repo}}/contents/.claude/factory.json?ref={main}",
                        "-H", "Accept: application/vnd.github.raw"], capture_output=True, text=True)
    cfg = dict(DEFAULTS)
    if p.returncode != 0:
        if "404" in p.stderr or "Not Found" in p.stderr:
            cfg["mainBranch"] = main
            return cfg  # main has no factory.json yet: the defaults
        raise RuntimeError(f"could not read .claude/factory.json on {main} from GitHub: " + p.stderr.strip()[:200])
    user = json.loads(p.stdout)
    cfg.update({k: v for k, v in user.items() if not k.startswith("_")})
    cfg["commands"] = {**DEFAULTS["commands"], **user.get("commands", {})}
    cfg["roles"] = merged_roles(user.get("roles"))
    cfg["manager"] = merged_section("manager", user.get("manager"))
    cfg["mainBranch"] = main  # GitHub's default branch wins over the file's own `mainBranch`
    return cfg


def matches(path, patterns):
    return any(re.search(rx, path) for rx in patterns)


def tasks(plan_text):
    """[(id, done, title)] in plan order. Title is the bold text after the id."""
    out = []
    for m in re.finditer(r"^\s*- \[( |x|X)\] \*\*(\d+(?:\.\d+)*)\s*([^*]*)\*\*", plan_text, re.M):
        out.append((m.group(2), m.group(1).lower() == "x", m.group(3).strip().rstrip(".")))
    return out


def blocked_ids(blocked_text):
    return {m.group(1) for m in re.finditer(r"^\s*-\s*(\d+(?:\.\d+)*)\s*:", blocked_text, re.M)}


def branch_task(branch):
    """task/1-3-validators or task/1.3-validators -> '1.3'; anything else -> None."""
    m = re.match(r"task/(\d+(?:[.-]\d+)*?)-[a-z]", branch) or re.match(r"task/(\d+(?:[.-]\d+)*)$", branch)
    return m.group(1).replace("-", ".") if m else None


def styled(paths, cfg):
    """The style entries whose `paths` globs match any of `paths` (fnmatch; `**` matches across folders)."""
    import fnmatch
    out = []
    for style in cfg.get("styles", []):
        globs = style.get("paths", [])
        if any(fnmatch.fnmatch(p, g) for p in paths for g in globs):
            out.append(style)
    return out


def safe_agent(name):
    """`name` if it's a valid agent name (lowercase letters, digits, dashes), else stop. Names become folder and
    file names and labels, so a name like ../x must never reach a path."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", name or ""):
        raise SystemExit(f"{name!r} isn't a valid agent name: use lowercase letters, digits and dashes "
                         "(`agents` in .claude/factory.json, or FACTORY_AGENT).")
    return name


def agent_name(cfg, slot):
    """The name of the agent in slot `slot` (1 = the project folder)."""
    names = cfg.get("agents") or []
    return safe_agent(names[slot - 1]) if 0 < slot <= len(names) else f"agent-{slot}"


def agent_slot(cfg, name):
    """The slot of agent `name` ("taytu", or the old "agent-2"); None when it isn't one."""
    names = cfg.get("agents") or []
    if name in names:
        return names.index(name) + 1
    m = re.fullmatch(r"agent-(\d+)", name or "")
    return int(m.group(1)) if m else None


def task_source(cfg):
    return (cfg.get("tasks") or {}).get("source", "plan")


def task_labels(cfg):
    return {**DEFAULTS["tasks"]["labels"], **((cfg.get("tasks") or {}).get("labels") or {})}



ROLE_NAMES = ("coding-agent", "dev-manager", "product-owner")


def roles_dir(cfg):
    """The project's role folder (`roles.dir`), relative to the project root."""
    return str((cfg.get("roles") or {}).get("dir") or DEFAULTS["roles"]["dir"]).rstrip("/")


def role_setting(cfg, role, key, default=None):
    """One field of a role's `roles.<role>` setting, else its default."""
    mine = (cfg.get("roles") or {}).get(role)
    if isinstance(mine, dict) and key in mine:
        return mine[key]
    base = DEFAULTS["roles"].get(role)
    return base.get(key, default) if isinstance(base, dict) else default


def role_names(cfg, role):
    """The names a role's loops take, in order: `agents` for the coding agent, `roles.<role>.names` for the others."""
    names = (cfg.get("agents") if role == "coding-agent" else role_setting(cfg, role, "names", [])) or []
    return [safe_agent(n if isinstance(n, str) else "") for n in names]


def manager_setting(cfg, key):
    """One field of the `manager` setting (#97), else its default."""
    mine = cfg.get("manager")
    return mine[key] if isinstance(mine, dict) and key in mine else DEFAULTS["manager"][key]


def role_wait(cfg, role, kind):
    """Minutes a loop of `role` waits after a pass: kind is "busy" (the pass had work) or "idle" (it had none; 0 means
    the loop exits instead). The dev manager's are `manager.busyMinutes` / `manager.idleMinutes`, the product owner's
    `roles.product-owner.*`; the coding agent waits `waitMinutes` inside its own loop."""
    key = f"{kind}Minutes"
    value = manager_setting(cfg, key) if role == "dev-manager" else role_setting(cfg, role, key, 1)
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return float(DEFAULTS["manager"][key]) if role == "dev-manager" else 1.0
