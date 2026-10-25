#!/usr/bin/env python3
"""CI guard for factory pull requests. Runs in CI, where the coding agent can't edit around it.

Checks the PR's commits against the base branch and fails (exit 1) on:
  - existing tests weakened: a test file deleted, or a line with an assertion or a     } need the
    test case removed or rewritten (adding new tests and assertions is fine)            } `tests-reviewed`
  - tests weakened in a commit after implementation started (even tests new in this PR) } label
  - golden/expected outputs that existed on the base changed or deleted                 }
  - new .skip / .only / xit / xdescribe / test.todo in test files                        }
  - new dependencies in a package manifest                         (needs the `deps-reviewed` label)
  - two decision files with the same number                        (no label overrides this)
  - a task branch ticking a task other than its own in the plan    (no label overrides this)
  - a workflow using `pull_request_target`                         (no label overrides this)
and warns (no failure) when the PR is larger than `prSizeWarn` changed lines.

The dev manager adds the labels after reading the change; the agent's own token shouldn't.
Usage (CI): python3 .claude/hooks/factory_guard.py --base origin/main --branch "$HEAD_REF" --labels "$LABELS_JSON"
"""
import argparse, json, os, re, subprocess, sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import branch_task, load, matches, tasks  # noqa: E402


def git(*a, check=True):
    p = subprocess.run(["git", *a], capture_output=True, text=True)
    if check and p.returncode != 0:
        raise SystemExit(f"git {' '.join(a)} failed: {p.stderr.strip()}")
    return p.stdout


def show(rev, path):
    p = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True, text=True)
    return p.stdout if p.returncode == 0 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="origin/main")
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--branch", default="")
    ap.add_argument("--labels", default="[]")
    a = ap.parse_args()
    cfg = load()
    labels = set(json.loads(a.labels or "[]"))
    base = git("merge-base", a.base, a.head).strip()
    fails, needs_tests, needs_deps, warns = [], [], [], []

    is_test = lambda p: matches(p, cfg["testPaths"])
    is_golden = lambda p: matches(p, cfg["goldenPaths"])
    is_code = lambda p: any(p == c or p.startswith(c.rstrip("/") + "/") for c in cfg["codePaths"]) \
        and not is_test(p) and not is_golden(p)

    # A line that asserts or defines a test case. Removing or rewriting one is "weakening"; adding is fine.
    weak = re.compile(r"\b(expect|assert\w*|should)\b|\b(it|test|describe)\s*\(|\bto(Be|Equal|Match|Throw|Contain|Have)\w*")

    def weakened(diff_args):
        out = []
        for ln in git("diff", "-U0", *diff_args).splitlines():
            if ln.startswith("-") and not ln.startswith("---") and weak.search(ln):
                out.append(ln[1:].strip()[:70])
        return out

    # 1. Existing tests weakened; existing golden outputs changed.
    for line in git("diff", "--name-status", "--no-renames", f"{base}...{a.head}").splitlines():
        status, _, path = line.partition("\t")
        if status[0] not in "MD":
            continue
        if is_golden(path):
            needs_tests.append(f"{'deleted' if status[0] == 'D' else 'changed'} existing expected output `{path}`")
        elif is_test(path):
            if status[0] == "D":
                needs_tests.append(f"deleted existing test `{path}`")
            elif (gone := weakened([f"{base}...{a.head}", "--", path])):
                needs_tests.append(f"removes or rewrites {len(gone)} assertion/test line(s) in `{path}`, e.g. `{gone[0]}`")

    # 2. Tests weakened after implementation started (catches tests written in this PR and then softened).
    started = False
    for sha in git("rev-list", "--reverse", "--no-merges", f"{base}..{a.head}").split():
        files = git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).split()
        if started:
            for f in (f for f in files if is_test(f)):
                if (gone := weakened([f"{sha}^", sha, "--", f])):
                    needs_tests.append(f"commit {sha[:8]} (after implementation started) removes or rewrites "
                                       f"assertion/test line(s) in `{f}`, e.g. `{gone[0]}`")
        if any(is_code(f) for f in files):
            started = True

    # 3. Skip / only markers added.
    marker = re.compile(r"\b(it|test|describe)\.(skip|only|todo)\s*\(|\bx(it|describe|test)\s*\(|\bfit\s*\(|@pytest\.mark\.skip")
    for path in git("diff", "--name-only", f"{base}...{a.head}").split():
        if not is_test(path):
            continue
        for ln in git("diff", "-U0", f"{base}...{a.head}", "--", path).splitlines():
            if ln.startswith("+") and not ln.startswith("+++") and marker.search(ln):
                needs_tests.append(f"adds a skip/only/todo in `{path}`: `{ln[1:].strip()[:80]}`")

    # 4. New dependencies.
    for path in git("diff", "--name-only", f"{base}...{a.head}").split():
        if not matches(path, cfg["dependencyManifests"]) or not path.endswith("package.json"):
            continue
        try:
            old = json.loads(show(base, path) or "{}")
            new = json.loads(show(a.head, path) or "{}")
        except json.JSONDecodeError:
            fails.append(f"`{path}` isn't valid JSON")
            continue
        for sect in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            added = sorted(set(new.get(sect, {})) - set(old.get(sect, {})))
            if added:
                needs_deps.append(f"`{path}` {sect}: " + ", ".join(f"`{d}`" for d in added))

    # 5. Decision numbers.
    ddir = cfg["decisions"].rstrip("/")
    names = [n for n in git("ls-tree", "--name-only", f"{a.head}:{ddir}", check=False).split()]
    nums = Counter(m.group(1) for n in names if (m := re.match(r"(\d{4})-", n)))
    for num, count in nums.items():
        if count > 1 and num != "0000":
            dup = ", ".join(n for n in names if n.startswith(num + "-"))
            fails.append(f"decision number {num} is used {count} times ({dup}); renumber yours to the next free number")

    # 6. A task branch may only tick its own task.
    tid = branch_task(a.branch)
    plan_old, plan_new = show(base, cfg["plan"]), show(a.head, cfg["plan"])
    if plan_old is not None and plan_new is not None:
        before = {i for i, done, _ in tasks(plan_old) if done}
        newly = [i for i, done, _ in tasks(plan_new) if done and i not in before]
        wrong = [i for i in newly if i != tid]
        if wrong:
            fails.append(f"ticks task(s) {', '.join(wrong)} in `{cfg['plan']}`, but this branch "
                         + (f"is task {tid}" if tid else "isn't a task branch"))

    # 7. Workflows with pull_request_target.
    for path in git("ls-tree", "-r", "--name-only", a.head, ".github/workflows", check=False).split():
        text = show(a.head, path) or ""
        if re.search(r"^\s*pull_request_target\s*:", text, re.M) or re.search(r"on:\s*\[?[^\]\n]*pull_request_target", text):
            fails.append(f"`{path}` uses `pull_request_target`, which runs PR code with repo secrets")

    # 8. Size.
    total = 0
    for ln in git("diff", "--numstat", f"{base}...{a.head}").splitlines():
        add, rem, path = (ln.split("\t") + ["", "", ""])[:3]
        if add == "-" or is_golden(path) or re.search(r"(lock\.(yaml|json)|\.lock|\.lockb)$", path):
            continue
        total += int(add) + int(rem)
    if total > int(cfg["prSizeWarn"]):
        warns.append(f"{total} changed lines (over {cfg['prSizeWarn']}): consider splitting; review findings rise with size")

    if needs_tests and "tests-reviewed" not in labels:
        fails += [f"{x} (needs the `tests-reviewed` label from the dev manager)" for x in needs_tests]
    if needs_deps and "deps-reviewed" not in labels:
        fails += [f"new dependency: {x} (needs the `deps-reviewed` label after checking each package exists, "
                  "is maintained and is the one intended)" for x in needs_deps]

    report = ["## Factory guard", ""]
    report += [f"- ❌ {f}" for f in fails] or ["- ✅ no blocking findings"]
    report += [f"- ⚠️ {w}" for w in warns]
    if (needs_tests or needs_deps) and not fails:
        report += [f"- ✅ reviewed by label: {x}" for x in needs_tests + needs_deps]
    text = "\n".join(report)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(text + "\n")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
