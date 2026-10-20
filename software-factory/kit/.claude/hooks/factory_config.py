"""Reads .claude/factory.json for the factory hooks. Missing keys fall back to these defaults."""
import json, os

DEFAULTS = {
    "plan": "docs/build-plan.md",
    "blocked": "docs/blocked.md",
    "mainBranch": "main",
    "commands": {"typecheck": "", "lint": "", "test": "", "build": ""},
    "codePaths": ["src"],
    "protected": [r"^CLAUDE\.md$", r"^\.claude/", r"^\.github/workflows/", r"\.env"],
    "alwaysAllowed": ["docs/build-plan.md", "docs/blocked.md"],
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
