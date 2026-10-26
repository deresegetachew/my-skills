#!/usr/bin/env python3
"""The project's stack (#199): what install.sh finds on a first install, and how the Python CI workflow runs a command.

  python3 factory_stack.py detect <project>         prints JSON: {stack, reason, commands, notes}
                                                    stack is node (package.json), python, or unknown
  python3 factory_stack.py apply <project>          writes the Python `commands.*` into <project>/.claude/factory.json
                                                    (does nothing for node or an unknown stack)
  python3 .claude/hooks/factory_stack.py run <name> runs commands.<name> from .claude/factory.json in the current
                                                    folder; empty: says so and exits 0 (CI's Python template uses it)
"""
import glob, json, os, re, subprocess, sys

PYTHON_MARKERS = ("pyproject.toml", "setup.py", "setup.cfg")


def python_tests(root):
    return sorted(glob.glob(os.path.join(root, "tests", "**", "test_*.py"), recursive=True))


def is_python(root):
    if any(os.path.isfile(os.path.join(root, m)) for m in PYTHON_MARKERS) or glob.glob(os.path.join(root, "requirements*.txt")):
        return True
    return bool(python_tests(root))


def uses_unittest(root):
    for path in python_tests(root):
        try:
            if re.search(r"unittest\.TestCase|^\s*(import unittest|from unittest)", open(path, encoding="utf-8").read(), re.M):
                return True
        except (OSError, UnicodeDecodeError):
            continue
    return False


def detect(root):
    if os.path.isfile(os.path.join(root, "package.json")):
        return {"stack": "node", "reason": "package.json", "commands": {}, "notes": []}
    if not is_python(root):
        return {"stack": "unknown", "reason": "no package.json, and no Python files it knows", "commands": {}, "notes": []}
    cmds, notes = {"install": "", "typecheck": "", "lint": "", "build": "", "test": ""}, []
    if glob.glob(os.path.join(root, "requirements.txt")):
        cmds["install"] = "python3 -m pip install -r requirements.txt"
    if uses_unittest(root):
        cmds["test"] = "python3 -m unittest discover"
    else:
        notes.append("no unittest-style tests found, so commands.test is empty: set it in .claude/factory.json "
                     "(for example `python3 tests/test_x.py` or `python3 -m pytest`).")
    return {"stack": "python", "reason": "Python files", "commands": cmds, "notes": notes}


def apply(root):
    found = detect(root)
    if found["stack"] != "python":
        return found
    path = os.path.join(root, ".claude", "factory.json")
    cfg = json.load(open(path))
    cfg.setdefault("commands", {}).update(found["commands"])
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return found


def run(name):
    command = (json.load(open(os.path.join(".claude", "factory.json"))).get("commands") or {}).get(name, "")
    if not command:
        print(f"::warning::commands.{name} is empty in .claude/factory.json, so nothing ran.")
        return 0
    print(f"+ {command}", flush=True)
    return subprocess.run(command, shell=True).returncode


def main(argv):
    if len(argv) == 2 and argv[0] in ("detect", "apply"):
        print(json.dumps((detect if argv[0] == "detect" else apply)(argv[1]), indent=2))
        return 0
    if len(argv) == 2 and argv[0] == "run":
        return run(argv[1])
    print(json.dumps({"code": "usage", "message": "unknown command.", "fix": "Use: detect <project>, apply <project> or run <name>."}),
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
