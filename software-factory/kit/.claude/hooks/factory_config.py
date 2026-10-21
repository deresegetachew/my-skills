"""Reads .claude/factory.json for the factory hooks and scripts. Missing keys fall back to these defaults."""
import json, os, re

DEFAULTS = {
    "prd": "docs/PRD.md",
    "plan": "docs/build-plan.md",
    "blocked": "docs/blocked.md",
    "decisions": "docs/decisions",
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
