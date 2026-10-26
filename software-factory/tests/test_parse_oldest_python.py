#!/usr/bin/env python3
"""Every factory script parses under the oldest Python we can run here (#213). CI runs one Python only, so a
newer-only syntax (a backslash inside an f-string expression, 3.12) went unseen. The oldest of python3.9, 3.10 and 3.11
that is installed is used; macOS ships 3.9. With none of them installed the test says so and skips; it never fails for that.
  python3 software-factory/tests/test_parse_oldest_python.py"""
import glob, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.dirname(SF)
CANDIDATES = ("python3.9", "python3.10", "python3.11")
PARSER = "import ast, sys\nfor p in sys.argv[1:]:\n    try:\n        ast.parse(open(p, encoding='utf-8').read(), p)\n    except SyntaxError as e:\n        print(f'{p}:{e.lineno}: {e.msg}')\n"


def oldest():
    for name in CANDIDATES:
        path = shutil.which(name)
        if path:
            return name, path
    return None, None


def scripts():
    found = []
    for pattern in ("*.py", "hooks/*.py", "ci/*.py", "tests/*.py", "kit/**/*.py"):
        found += glob.glob(os.path.join(SF, pattern), recursive=True)
    found += glob.glob(os.path.join(REPO, "tools", "*.py"))
    return sorted(f for f in set(found) if os.path.isfile(f) and "__pycache__" not in f)


def test_every_script_parses_under_the_oldest_python_installed():
    name, path = oldest()
    if not path:
        print("skipped: none of " + ", ".join(CANDIDATES) + " is installed, so the old-Python parse was not checked")
        return
    files = scripts()
    assert files, "no scripts found"
    p = subprocess.run([path, "-c", PARSER, *files], capture_output=True, text=True)
    assert p.returncode == 0 and not p.stdout.strip(), f"{name} cannot parse:\n{p.stdout}{p.stderr}"


if __name__ == "__main__":
    test_every_script_parses_under_the_oldest_python_installed()
    print("ok test_every_script_parses_under_the_oldest_python_installed")
