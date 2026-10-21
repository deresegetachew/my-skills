#!/usr/bin/env python3
"""Which extra reviews and checks a change needs, from `reviews`, `eval`, `design` and `styles` in factory.json.

  python3 .claude/hooks/factory_reviews.py            the current branch against origin/<mainBranch>
  python3 .claude/hooks/factory_reviews.py --json

Prints one line per needed review or check with the first changed files that triggered it, for example
  safety-auditor       packages/validators/src/rules.ts
  architecture-reviewer apps/api/src/brands/brands.controller.ts
`reviewer` is always needed and isn't listed. next-task runs each listed one; the reviewer checks they ran.
"""
import json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load, styled  # noqa: E402


def needed(changed, cfg):
    out = {}
    def match(name, rxs):
        hits = [p for p in changed if any(re.search(rx, p) for rx in rxs)]
        if hits:
            out[name] = hits
    for name, rule in cfg.get("reviews", {}).items():
        if not name.startswith("_"):
            match(name, rule.get("paths", []))
    if cfg.get("eval", {}).get("command"):
        match(cfg["eval"].get("skill", "eval"), cfg["eval"].get("paths", []))
    if cfg.get("design", {}).get("references"):
        match(cfg["design"].get("skill", "design-check"), cfg["design"].get("paths", []))
    hits = [p for p in changed if styled([p], cfg)]
    if hits:
        out["architecture-reviewer"] = hits
    return out


if __name__ == "__main__":
    cfg = load()
    diff = subprocess.run(["git", "diff", "--name-only", f"origin/{cfg['mainBranch']}...HEAD"],
                          capture_output=True, text=True).stdout.split()
    diff += subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], capture_output=True,
                           text=True).stdout.split()
    res = needed(sorted(set(diff)), cfg)
    if "--json" in sys.argv:
        print(json.dumps(res, indent=2))
    else:
        for name, hits in res.items():
            print(f"{name:21} {', '.join(hits[:3])}{' ...' if len(hits) > 3 else ''}")
        if not res:
            print("only the reviewer")
