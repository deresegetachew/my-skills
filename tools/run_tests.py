#!/usr/bin/env python3
"""Run the software factory's tests without pytest: each tests/test_*.py file in its own process, calling every
top-level test_* function. Exits 1 if any test fails, so CI goes red.

Files run in parallel (--jobs N, or FACTORY_TEST_JOBS, default min(CPU count, 8)); a file with many tests is split
over several processes. Each file's report is printed whole when it finishes, so output never interleaves."""
import glob
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = r"""
import importlib.util, os, sys, traceback
sys.dont_write_bytecode = True  # -I ignores PYTHONDONTWRITEBYTECODE, and tests import the hooks in this process
path = sys.argv[1]
sys.path.insert(0, os.path.dirname(path))
spec = importlib.util.spec_from_file_location("t", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
bad = 0
names = sorted(n for n in dir(mod) if n.startswith("test_") and callable(getattr(mod, n)))
if len(sys.argv) > 3:  # shard i of k: every k-th test, so one big file can run in several processes
    names = names[int(sys.argv[2])::int(sys.argv[3])]
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


def run_file(path, shard=0, shards=1):
    """Run one test file (or one shard of it) in its own process. Returns (rel, code, output, seconds)."""
    start = time.time()
    rel = os.path.relpath(path, ROOT)
    # Output goes to a temp file, not a pipe: a test that leaves a background process behind (a fake loop that
    # sleeps) would hold a pipe open and make this wait for it, but a file does not wait.
    with tempfile.TemporaryFile("w+", encoding="utf-8", errors="replace") as sink, \
            tempfile.TemporaryDirectory(prefix="factory-test-", ignore_cleanup_errors=True) as scratch:
        # Files run side by side, so none may write to the real machine-wide places (the machine id, the boot log):
        # each gets its own. A test that wants other folders sets them in its own environment, as before.
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "FACTORY_CONFIG_DIR": os.path.join(scratch, "config"),
               "XDG_STATE_HOME": os.path.join(scratch, "state"),
               # The tests make their folders with mkdtemp and never remove them: point that at the scratch folder,
               # which goes when the file's processes end, so a run leaves nothing behind in /tmp.
               "TMPDIR": os.path.join(scratch, "tmp"),
               # `pick` waits 2 s after claiming for a simultaneous claim; the tests' claims are made up in advance.
               "FACTORY_CLAIM_SETTLE_SECONDS": "0"}
        # The tests commit in throwaway repos. A developer's global commit.gpgsign calls a signing helper that fails
        # under load (and CI has none), so no test commit is signed.
        n = int(env.get("GIT_CONFIG_COUNT", "0") or 0)
        env.update({"GIT_CONFIG_COUNT": str(n + 1), f"GIT_CONFIG_KEY_{n}": "commit.gpgsign", f"GIT_CONFIG_VALUE_{n}": "false"})
        os.makedirs(env["TMPDIR"])
        cmd = [sys.executable, "-I", "-c", RUNNER, path] + ([str(shard), str(shards)] if shards > 1 else [])
        try:
            proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=sink, stderr=subprocess.STDOUT, text=True,
                                  timeout=600, cwd=ROOT, env=env)
            code, note = proc.returncode, ""
        except subprocess.TimeoutExpired:
            code, note = 1, "timed out after 600 s\n"
        sink.seek(0)
        out = sink.read() + note
    return rel, code, out, time.time() - start


def run_file_safely(path, shard, shards):
    """run_file, but a problem in the runner itself (no disk, no process) is reported as that file's failure with
    its traceback, instead of ending the whole run before the other files print anything."""
    try:
        return run_file(path, shard, shards)
    except Exception:  # noqa: BLE001 - any failure here must be shown, not raised
        return os.path.relpath(path, ROOT), 1, "test runner error:\n" + traceback.format_exc(), 0.0


def annotate(rel, out):
    """On GitHub Actions, put the first lines of a failure in an annotation, which can be read without the log."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    lines = [line for line in out.strip().splitlines() if line.strip()]
    text = "\n".join(lines[:25])[:1800]
    text = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::error file={rel},title=test failure::{text}", flush=True)


def shard_count(path, jobs):
    """Big files are split so one of them does not set the total time: about 8 tests per process, at most `jobs`."""
    with open(path, encoding="utf-8") as f:
        tests = sum(1 for line in f if line.startswith("def test_"))
    return max(1, min(jobs, -(-tests // 8)))


def job_count(argv):
    """--jobs N beats FACTORY_TEST_JOBS beats min(cpu count, 8)."""
    value = None
    for i, arg in enumerate(argv):
        if arg == "--jobs" and i + 1 < len(argv):
            value = argv[i + 1]
        elif arg.startswith("--jobs="):
            value = arg.split("=", 1)[1]
    value = value or os.environ.get("FACTORY_TEST_JOBS")
    try:
        return max(1, int(value)) if value else min(os.cpu_count() or 1, 8)
    except ValueError:
        sys.exit(f"jobs must be a whole number, got {value!r}")


def summary_line(results):
    """One line for a file: the shards' 'N passed, M failed' lines added up, else the last line of the output."""
    passed = failed = 0
    for _, code, out, _ in results:
        last = out.strip().splitlines()[-1] if out.strip() else "no output"
        found = re.fullmatch(r"(\d+) passed, (\d+) failed", last)
        if not found:
            return last
        passed, failed = passed + int(found.group(1)), failed + int(found.group(2))
    return f"{passed} passed, {failed} failed"


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    files = sorted(glob.glob(os.path.join(ROOT, "software-factory", "tests", "test_*.py")))
    if not files:
        print("no test files found")
        return 1
    jobs = job_count(argv)
    # Biggest files first: they are the slowest, so starting them early keeps every worker busy to the end.
    queue = sorted(files, key=lambda f: -os.path.getsize(f))
    shards = {f: shard_count(f, jobs) for f in files}
    failed = []
    done = {}
    start = time.time()
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(run_file_safely, f, i, shards[f]): f for f in queue for i in range(shards[f])}
        # A file's report is printed whole once all its processes have finished, so output never interleaves.
        for future in as_completed(futures):
            path = futures[future]
            done.setdefault(path, []).append(future.result())
            if len(done[path]) < shards[path]:
                continue
            results = done[path]
            rel = results[0][0]
            print(f"{rel}: {summary_line(results)} ({max(r[3] for r in results):.0f} s)", flush=True)
            if any(r[1] for r in results):
                failed.append(rel)
                for _, code, out, _ in results:
                    if code:
                        print(out, flush=True)
                        annotate(rel, out)
    print(f"{len(files) - len(failed)} of {len(files)} test files passed")
    print(f"{jobs} jobs, {time.time() - start:.0f} s in all")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
