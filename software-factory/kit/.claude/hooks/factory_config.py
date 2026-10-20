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
    """task/1-3-validators -> '1.3'; anything else -> None."""
    m = re.match(r"task/(\d+(?:-\d+)*?)-[a-z]", branch) or re.match(r"task/(\d+(?:-\d+)*)$", branch)
    return m.group(1).replace("-", ".") if m else None
