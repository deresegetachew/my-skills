#!/usr/bin/env python3
"""Incremental re-review (#70): a reviewer's second round checks only what changed since its last pass.

  python3 .claude/hooks/factory_rereview.py plan   --kind reviewer     full or delta, and why (JSON)
  python3 .claude/hooks/factory_rereview.py prompt --kind reviewer     the instructions for this round
  python3 .claude/hooks/factory_rereview.py record --kind reviewer --result pass|fail --findings "..."
  python3 .claude/hooks/factory_rereview.py reply  --kind reviewer --text "what was changed for each finding"

`--kind` names the reviewer: reviewer, arch (the architecture reviewer), safety, security. Each has its own history
in <reviewMarkers>/<branch>.reviews.json: the commit it reviewed, whether it passed, its findings, the files and
line count of the branch diff then, and the author's reply. The pass marker the PR gate reads (<branch>.ok, holding
HEAD's id) is a separate file and is never touched here: a delta review still ends with the reviewer's pass for HEAD.

The next round is a delta (`git diff <last reviewed commit>..HEAD`, with the earlier findings and the reply) unless:
there is no earlier round, `reReviewPercent` is 0, the earlier commit isn't in HEAD's history any more (rebase), the
branch's base moved (main merged in), the change touches a file the branch diff didn't have before, or it is more
than `reReviewPercent` (default 30) percent of the branch diff's changed lines. Then it is a full review.
"""
import argparse, json, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402

KINDS = ("reviewer", "arch", "safety", "security")
KEEP = 10             # rounds remembered per reviewer
MAX_TEXT = 6000       # a findings summary or reply, in characters
MAX_DIFF = 120000     # the delta shown in a prompt, in characters


def git(*a):
    p = subprocess.run(["git", *a], capture_output=True, text=True)
    return p.returncode, p.stdout.strip()


def numstat(spec):
    """{file: changed lines} for a git range such as `a..b` or `base...HEAD`."""
    rc, out = git("diff", "--numstat", spec)
    res = {}
    for line in out.splitlines() if rc == 0 else []:
        add, rem, name = (line.split("\t", 2) + ["", ""])[:3]
        res[name] = (int(add) if add.isdigit() else 0) + (int(rem) if rem.isdigit() else 0)
    return res


def state_file(cfg, branch):
    return os.path.join(cfg["reviewMarkers"], branch.replace("/", "_") + ".reviews.json")


def read_state(cfg, branch):
    try:
        with open(state_file(cfg, branch)) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(cfg, branch, data):
    os.makedirs(cfg["reviewMarkers"], exist_ok=True)
    path = state_file(cfg, branch)
    with open(path + ".tmp", "w") as f:
        json.dump(data, f, indent=1)
    os.replace(path + ".tmp", path)


def percent_limit(cfg):
    try:
        return max(int(cfg.get("reReviewPercent", 30)), 0)
    except (TypeError, ValueError):
        return 30


def snapshot(base):
    """What the branch looks like now: HEAD, the merge base with `base`, and the branch diff's files and lines."""
    head = git("rev-parse", "HEAD")[1]
    mb = git("merge-base", base, "HEAD")[1]
    files = numstat(f"{base}...HEAD")
    return {"sha": head, "base": mb, "files": sorted(files), "lines": sum(files.values())}


def plan(cfg, branch, kind, base):
    now = snapshot(base)
    entries = read_state(cfg, branch).get(kind, [])
    out = {"kind": kind, "branch": branch, "head": now["sha"], "mode": "full", "reason": "", "last": None,
           "delta": None, "dirty": bool(git("status", "--porcelain")[1])}
    if percent_limit(cfg) == 0:
        out["reason"] = "re-review by delta is off (reReviewPercent is 0)"
        return out
    if not entries:
        out["reason"] = "first review of this branch by this reviewer"
        return out
    last = entries[-1]
    out["last"] = {k: last.get(k) for k in ("sha", "result", "ts")}
    if last["sha"] == now["sha"]:
        out.update(mode="unchanged", reason="no commit since this reviewer's last round")
        return out
    if git("merge-base", "--is-ancestor", last["sha"], now["sha"])[0] != 0:
        out["reason"] = "the commit last reviewed is not in the branch's history any more (rebased or reset)"
        return out
    if last.get("base") != now["base"]:
        out["reason"] = "the branch's base moved (main was merged in or the branch was rebased)"
        return out
    delta = numstat(f"{last['sha']}..{now['sha']}")
    lines = sum(delta.values())
    pct = round(lines * 100 / max(now["lines"], 1), 1)
    out["delta"] = {"files": sorted(delta), "lines": lines, "branchLines": now["lines"], "percent": pct}
    new = [f for f in sorted(delta) if f not in set(last.get("files", []))]
    if new:
        out["reason"] = "the change touches files the earlier round did not see: " + ", ".join(new[:5])
    elif pct > percent_limit(cfg):
        out["reason"] = f"the change is {pct}% of the branch diff, over the {percent_limit(cfg)}% limit"
    else:
        out.update(mode="delta", reason=f"{pct}% of the branch diff, in files the earlier round saw")
    return out


def earlier(cfg, branch, kind):
    entries = read_state(cfg, branch).get(kind, [])
    return entries[-1] if entries else None


def prompt(cfg, branch, kind, base):
    p = plan(cfg, branch, kind, base)
    last = earlier(cfg, branch, kind)
    L = []
    if p["mode"] == "delta":
        L += [f"## Re-review of {branch} ({kind}): only the changes since your last round",
              f"You reviewed {p['last']['sha'][:12]} earlier and the result was: {p['last']['result']}. Check only the "
              f"delta below ({len(p['delta']['files'])} files, {p['delta']['lines']} changed lines, "
              f"{p['delta']['percent']}% of the branch diff). Do not read the rest of the branch diff again.", ""]
    elif p["mode"] == "unchanged":
        L += [f"## Nothing new for {branch} ({kind})",
              f"HEAD is {p['head'][:12]}, the commit you already reviewed ({p['last']['result']}). There is no delta. "
              "Re-check only your earlier findings below.", ""]
    else:
        L += [f"## Full review of {branch} ({kind})", f"Read the whole branch diff (`git diff {base}...HEAD`): "
              f"{p['reason']}.", ""]
    if last:
        L += [f"### Your earlier findings (round at {last['sha'][:12]}, {last['result']})", last.get("findings") or "(none recorded)", ""]
        if last.get("reply"):
            L += ["### The author's reply to them", last["reply"], ""]
    if p["mode"] in ("delta", "unchanged"):
        L += ["### What to do",
              "1. For each earlier must-fix, check that the delta fixes it and say how.",
              "2. Check the new changes in the delta are fine (the same checks as a first review, on these lines only).",
              "3. Run the project's checks as usual. Read a file outside the delta only when a changed line depends on it.",
              f"4. Record your result for HEAD ({p['head'][:12]}): `factory_rereview.py record`, then the pass marker if there "
              "is no must-fix. The pass names HEAD, not the delta.", ""]
    else:
        L += ["After the review, record your result with `factory_rereview.py record`, then the pass marker if there is "
              "no must-fix.", ""]
    if p["dirty"]:
        L += ["Note: the working tree has uncommitted changes. They are not part of this review; ask for them to be committed.", ""]
    if p["mode"] == "delta":
        rc, diff = git("diff", f"{p['last']['sha']}..{p['head']}")
        if len(diff) > MAX_DIFF:
            diff = diff[:MAX_DIFF] + f"\n[delta cut at {MAX_DIFF} characters; read the rest with git diff {p['last']['sha'][:12]}..HEAD]"
        L += [f"BEGIN DELTA ({p['last']['sha'][:12]}..{p['head'][:12]})", diff, "END DELTA"]
    return "\n".join(L).rstrip() + "\n"


def record(cfg, branch, kind, base, result, findings):
    data = read_state(cfg, branch)
    entry = {**snapshot(base), "result": result, "findings": findings[:MAX_TEXT], "ts": int(time.time())}
    data[kind] = (data.get(kind, []) + [entry])[-KEEP:]
    write_state(cfg, branch, data)
    return entry


def reply(cfg, branch, kind, text):
    data = read_state(cfg, branch)
    if not data.get(kind):
        return False
    data[kind][-1]["reply"] = text[:MAX_TEXT]
    write_state(cfg, branch, data)
    return True


def text_arg(args, name):
    path = getattr(args, name + "_file", None)
    if path:
        with open(path) as f:
            return f.read()
    return getattr(args, name, None)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("command", choices=["plan", "prompt", "record", "reply"])
    ap.add_argument("--kind", default="reviewer", choices=KINDS)
    ap.add_argument("--base", help="the main branch to compare with (default origin/<mainBranch>)")
    ap.add_argument("--branch", help="default: the current branch")
    ap.add_argument("--result", choices=["pass", "fail"])
    ap.add_argument("--findings")
    ap.add_argument("--findings-file", dest="findings_file")
    ap.add_argument("--text")
    ap.add_argument("--text-file", dest="text_file")
    args = ap.parse_args(argv)
    cfg = load()
    branch = args.branch or git("branch", "--show-current")[1]
    if not branch:
        print("factory rereview: not on a branch. Check out the task branch first.", file=sys.stderr)
        return 1
    base = args.base or f"origin/{cfg['mainBranch']}"
    if git("rev-parse", "--verify", "-q", base)[0] != 0:
        print(f"factory rereview: {base} not found. Run `git fetch origin` or pass --base.", file=sys.stderr)
        return 1
    if args.command == "plan":
        print(json.dumps(plan(cfg, branch, args.kind, base), indent=2))
    elif args.command == "prompt":
        sys.stdout.write(prompt(cfg, branch, args.kind, base))
    elif args.command == "record":
        findings = text_arg(args, "findings")
        if not args.result or not findings:
            print("factory rereview: record needs --result pass|fail and --findings (a short summary; "
                  "'no must-fix' for a clean pass).", file=sys.stderr)
            return 1
        e = record(cfg, branch, args.kind, base, args.result, findings)
        print(f"factory rereview: recorded {args.kind} {args.result} for {e['sha'][:12]}.")
    else:
        text = text_arg(args, "text")
        if not text:
            print("factory rereview: reply needs --text (what you changed for each finding).", file=sys.stderr)
            return 1
        if not reply(cfg, branch, args.kind, text):
            print(f"factory rereview: no earlier {args.kind} round on {branch}, so the reply has nothing to attach to; "
                  "the next review is a full one.", file=sys.stderr)
            return 1
        print(f"factory rereview: reply saved for the next {args.kind} round.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
