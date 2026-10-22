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
    "commands": {"typecheck": "", "lint": "", "test": "", "build": "", "smoke": ""},
    "codePaths": ["src"],
    "protected": [r"^CLAUDE\.md$", r"^\.claude/", r"^\.github/", r"\.env",
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
    # Where tasks live. "plan": unticked lines of the build plan (the classic mode). "issues": open GitHub issues
    # with the `ready` label, claimed with labels and a claim comment (factory_issues.py); the plan is an overview.
    "tasks": {
        "source": "plan",
        "labels": {"ready": "factory:ready", "inProgress": "factory:in-progress", "inReview": "factory:in-review",
                   "blocked": "factory:blocked", "agentPrefix": "agent:"},
        "staleHours": 3,  # an in-progress issue with no activity for this long goes back to ready (dev manager)
        "pingMinutes": 5,  # an agent pings its agent issue at most this often while it works
        "downMinutes": 30,  # no ping for this long: the agent counts as down, and the sweep releases its issues
    },
    "claimStaleHours": 6,  # a loop's task claim lapses after this (or when its process exits)
    "prSizeWarn": 600,
    "reviewMarkers": "tmp/reviews",
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
    # The design-check skill: {"references": "design/screens", "renders": "design/screens/png",
    #   "preview": "pnpm --filter web preview", "paths": ["regex", ...]}. Empty references: no design check.
    "design": {},
}


def load():
    root = os.environ.get("CLAUDE_PROJECT_DIR", ".")
    os.chdir(root)
    cfg = dict(DEFAULTS)
    try:
        with open(os.path.join(".claude", "factory.json")) as f:
            user = json.load(f)
        cfg.update({k: v for k, v in user.items() if not k.startswith("_")})
        cfg["commands"] = {**DEFAULTS["commands"], **user.get("commands", {})}
    except FileNotFoundError:
        pass
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

