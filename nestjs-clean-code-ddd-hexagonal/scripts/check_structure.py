#!/usr/bin/env python3
"""One thing per file, a pure domain (nestjs-clean-code-ddd-hexagonal, section 7b). No dependencies.

Copy into a project (the software-factory installs it as .claude/hooks/check_structure.py) and run it in CI.
Every non-test .ts file under the configured roots must follow:
  one-class      at most one class per file
  class-alone    a file that declares a class declares no top-level functions beside it
  one-export     a file without a class exports at most one function (index.ts re-exports don't count)
  kebab-case     file names are kebab-case
  domain-pure    files under a `domain/` folder import no NestJS, pg, express, node:http(s) or infrastructure code

Config, in .claude/factory.json (or pass --root and --legacy):
  "structure": { "roots": ["apps/api/src", "packages/ingest/src"], "legacy": "tools/structure-legacy.txt" }

Files listed in the legacy file are exempt while a refactor moves them. The list may only shrink: a listed file that
now passes, or is gone, is an error too. New files are never exempt.

  check_structure.py            check, exit 1 on any finding
  check_structure.py --legacy   print today's violators (to seed the legacy file)
"""
import argparse, json, os, re, sys

CLASS = re.compile(r"^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+\w+", re.M)
FUNC = re.compile(
    r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*\w+"
    r"|^(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>",
    re.M,
)
EXPORTED_FUNC = re.compile(
    r"^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*\w+"
    r"|^export\s+const\s+\w+\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>",
    re.M,
)
IMPORT = re.compile(r"^\s*import\s[^;]*?from\s+['\"]([^'\"]+)['\"]|^\s*import\s+['\"]([^'\"]+)['\"]", re.M)
KEBAB = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\.ts$")
DOMAIN_FORBIDDEN = re.compile(r"^(?:@nestjs/|pg$|pg/|express|node:https?$|https?$)|/infrastructure/")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def findings(path, rel):
    out = []
    if not KEBAB.match(os.path.basename(path)):
        out.append("kebab-case")
    text = strip_comments(open(path, encoding="utf-8").read())
    classes = CLASS.findall(text)
    if len(classes) > 1:
        out.append(f"one-class ({len(classes)} classes)")
    if classes and FUNC.search(text):
        out.append("class-alone (a class and top-level functions)")
    exported = EXPORTED_FUNC.findall(text)
    if not classes and len(exported) > 1:
        out.append(f"one-export ({len(exported)} exported functions)")
    if "/domain/" in "/" + rel:
        for m in IMPORT.finditer(text):
            spec = m.group(1) or m.group(2)
            if DOMAIN_FORBIDDEN.search(spec):
                out.append(f"domain-pure (imports {spec})")
    return out


def scan(repo, roots):
    result = {}
    for root in roots:
        for dirpath, _, files in os.walk(os.path.join(repo, root)):
            if "node_modules" in dirpath or "/dist" in dirpath:
                continue
            for f in files:
                if not f.endswith(".ts") or f.endswith(".d.ts") or re.search(r"\.(test|spec)\.ts$", f):
                    continue
                path = os.path.join(dirpath, f)
                rel = os.path.relpath(path, repo)
                if "/test-support/" in "/" + rel:
                    continue
                found = findings(path, rel)
                if found:
                    result[rel] = found
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", action="append", default=[])
    ap.add_argument("--legacy", nargs="?", const="__print__", default=None)
    ap.add_argument("--legacy-file", default=None)
    a = ap.parse_args()
    repo = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    cfg = {}
    try:
        cfg = json.load(open(os.path.join(repo, ".claude", "factory.json"))).get("structure", {})
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    roots = a.root or cfg.get("roots", [])
    if not roots:
        print("no roots: set structure.roots in .claude/factory.json, or pass --root")
        return 2
    found = scan(repo, roots)
    if a.legacy == "__print__":
        print("\n".join(sorted(found)))
        return 0
    legacy_path = a.legacy_file or cfg.get("legacy")
    legacy = set()
    if legacy_path and os.path.exists(os.path.join(repo, legacy_path)):
        legacy = {l.strip() for l in open(os.path.join(repo, legacy_path)) if l.strip() and not l.startswith("#")}
    errors = [f"{rel}: {i}" for rel, items in sorted(found.items()) if rel not in legacy for i in items]
    errors += [f"{rel}: listed in the legacy file but passes or is gone; remove it from the list"
               for rel in sorted(legacy - set(found))]
    print("## Structure (one thing per file, pure domain)")
    print("\n".join(f"- ❌ {e}" for e in errors) if errors else f"- ✅ no findings ({len(legacy)} legacy files left)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
