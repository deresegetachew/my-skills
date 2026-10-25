#!/usr/bin/env python3
"""Run the software factory's tests without pytest: each tests/test_*.py file in its own process, calling every
top-level test_* function. Exits 1 if any test fails, so CI goes red."""
import glob
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = r"""
import importlib.util, os, sys, traceback
path = sys.argv[1]
sys.path.insert(0, os.path.dirname(path))
spec = importlib.util.spec_from_file_location("t", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
bad = 0
names = sorted(n for n in dir(mod) if n.startswith("test_") and callable(getattr(mod, n)))
for name in names:
    try:
        getattr(mod, name)()
    except Exception:
        bad += 1
        print(f"FAIL {name}")
        traceback.print_exc()
print(f"{len(names) - bad} passed, {bad} failed")
sys.exit(1 if bad else 0)
"""


def hermetic_env():
    """The tests make their own throwaway repos and commit in them. A developer's global git config may sign every commit
    through a helper that can fail under load (and CI has none), so no test commit is signed."""
    env = dict(os.environ)
    n = int(env.get("GIT_CONFIG_COUNT", "0") or 0)
    env.update({"GIT_CONFIG_COUNT": str(n + 1), f"GIT_CONFIG_KEY_{n}": "commit.gpgsign", f"GIT_CONFIG_VALUE_{n}": "false"})
    return env


def main():
    files = sorted(glob.glob(os.path.join(ROOT, "software-factory", "tests", "test_*.py")))
    if not files:
        print("no test files found")
        return 1
    failed = []
    for path in files:
        start = time.time()
        rel = os.path.relpath(path, ROOT)
        try:
            proc = subprocess.run([sys.executable, "-I", "-c", RUNNER, path], capture_output=True, text=True,
                                  timeout=600, cwd=ROOT, env=hermetic_env())
            out, code = proc.stdout + proc.stderr, proc.returncode
        except subprocess.TimeoutExpired:
            out, code = "timed out after 600 s\n", 1
        last = out.strip().splitlines()[-1] if out.strip() else "no output"
        print(f"{rel}: {last} ({time.time() - start:.0f} s)")
        if code:
            failed.append(rel)
            print(out)
    print(f"{len(files) - len(failed)} of {len(files)} test files passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
