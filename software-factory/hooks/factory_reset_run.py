#!/usr/bin/env python3
"""`factory reset-run`: lists, and with --apply cleans, what an earlier run left in this project before a test run (#229).

  python3 .claude/hooks/factory_reset_run.py            the plan, one line per thing; nothing is changed
  python3 .claude/hooks/factory_reset_run.py --apply    does each step and says what it did; a second run finds nothing

Four kinds of leftovers, all of this project (its checkout, its repo, its CI containers) and nothing else:
  claim      this machine's local claims whose process is gone (what `factory release` lets go)
  agent      open Agent issues of an agent that is down for good, or whose name is not a configured agent (it never ran);
             never one whose agent is alive here
  container  exited CI containers of this project's compose projects (<ci name>, <ci name>-N, <ci name>-light)
  runner     this project's registered self-hosted runners (<ci name>-...) that are offline and idle
  variable   CI_RUNS_ON or CI_RUNS_ON_LIGHT that asks for self-hosted runners when none with those labels is online (it is
             deleted, so jobs use GitHub's runners)
Errors are {code, message, fix} on stderr with exit 1. Every GitHub and Docker call goes through gh_api() and docker().
"""
import json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load, role_names, task_source, ROLE_NAMES  # noqa: E402

REPO = "repos/{owner}/{repo}/"
VARIABLES = ("CI_RUNS_ON", "CI_RUNS_ON_LIGHT")


class Refusal(Exception):
    def __init__(self, code, message, fix):
        super().__init__(message)
        self.body = {"code": code, "message": message, "fix": fix}


def gh_api(path, method="GET"):
    """One `gh api` call; the parsed answer ({} for an empty one). Raises Refusal when gh fails."""
    try:
        p = subprocess.run(["gh", "api", "-X", method, path], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Refusal("github-unreachable", f"gh did not answer ({e}).", "check the connection and `gh auth status`, then run it again.")
    if p.returncode != 0:
        raise Refusal("github-failed", f"gh api {method} {path} failed: {(p.stderr or p.stdout).strip()[:200]}",
                      "sign in with `gh auth login` (the repo needs admin rights for runners and variables), then run it again.")
    return json.loads(p.stdout) if p.stdout.strip() else {}


def docker(*args):
    """(exit code, output) of one `docker` call; (127, "") when docker is not installed or does not answer."""
    try:
        p = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""
    return p.returncode, p.stdout.strip()


# --- what is there ---------------------------------------------------------------------------------------------------------

def stale_claims(cfg):
    """[(agent, why)] for this machine's checkout claims whose loop is gone. Reads the claims file; changes nothing."""
    import factory_claims as fc
    common = os.path.abspath(fc.git("rev-parse", "--git-common-dir") or ".git")
    try:
        with open(os.path.join(common, "factory", "claims.json")) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    hours = cfg.get("claimStaleHours", 6)
    out = []
    for agent, claim in sorted((data.get("checkouts") or {}).items()):
        if not fc.alive(claim, hours, loop=True):
            out.append((agent, f"pid {claim.get('pid')} is gone"))
    for tid, claim in sorted((data.get("tasks") or {}).items()):
        if claim.get("agent") not in (data.get("checkouts") or {}) and not fc.alive(claim, hours):
            out.append((claim.get("agent"), f"its task claim {tid} is stale"))
    return out


def dead_agent_issues(cfg):
    """[(number, name, why)] for open Agent issues to close. Issues mode only."""
    if task_source(cfg) != "issues":
        return []
    import factory_agents, factory_heartbeat
    configured = set(cfg.get("agents") or []) | {n for role in ROLE_NAMES for n in role_names(cfg, role)}
    out = []
    for name, found in factory_agents.by_agent(factory_agents.agent_issues()).items():
        issue = found[0]
        if issue.get("state") != "open" or factory_heartbeat.alive_here(name):
            continue
        st = factory_agents.state_of(cfg, issue)
        status = st[1] if st else None
        if status in ("down", "silent"):
            out.append((issue["number"], name, f"{name} is {status}"))
        elif name not in configured and status is None:
            out.append((issue["number"], name, f"{name} never ran here (not in `agents`)"))
    return sorted(out)


def ci_names(cfg):
    """This project's CI names (ci_names.py), or None when it can't tell the repository."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ci"))
    try:
        import ci_names
        return ci_names.names(cfg.get("ci") or {})
    except SystemExit:
        return None


def exited_containers(name):
    """[(id, container name)] of exited containers of this project's compose projects."""
    rc, out = docker("ps", "-a", "--filter", "status=exited", "--format", '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}')
    mine = re.compile(rf"{re.escape(name)}(-([1-9]|1[0-6]|light))?")
    found = []
    for line in out.splitlines() if rc == 0 else []:
        cid, cname, project = (line.split("\t") + ["", ""])[:3]
        if cid and mine.fullmatch(project):
            found.append((cid, cname))
    return found


def runners_of(repo_path):
    found = gh_api(repo_path + "actions/runners?per_page=100")
    return found.get("runners") if isinstance(found, dict) else None


def offline_runners(pool, name):
    return [(x["id"], x.get("name", "")) for x in pool or []
            if x.get("status") == "offline" and not x.get("busy") and str(x.get("name", "")).startswith(name + "-")]


def labels_of(value):
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        parsed = value
    if isinstance(parsed, str):
        return [parsed]
    return [l for l in parsed if isinstance(l, str)] if isinstance(parsed, list) else []


def dangling_variables(pool):
    """[(variable, labels)] that ask for self-hosted runners when no online runner has those labels. Unknown pool: none."""
    if pool is None:
        return []
    found = gh_api(REPO + "actions/variables")
    out = []
    for v in (found.get("variables") or []) if isinstance(found, dict) else []:
        if v.get("name") not in VARIABLES:
            continue
        labels = labels_of(v.get("value"))
        need = {l.lower() for l in labels}
        if "self-hosted" not in need:
            continue
        online = [x for x in pool if x.get("status") == "online" and need <= {(l.get("name") or "").lower() for l in x.get("labels", [])}]
        if not online:
            out.append((v["name"], labels))
    return out


# --- the plan --------------------------------------------------------------------------------------------------------------

def plan(cfg):
    """[(kind, description, action)]: each action is a callable that does the step."""
    import factory_claims as fc
    steps = []
    for agent, why in stale_claims(cfg):
        steps.append(("claim", f"release the claims of {agent} ({why})", lambda a=agent: fc.release(a)))
    for number, name, why in dead_agent_issues(cfg):
        steps.append(("agent", f"close Agent issue #{number} ({why})",
                      lambda n=number: close_issue(n)))
    names = ci_names(cfg)
    if names is None:
        steps.append(("note", "skipped the CI containers, runners and variables: can't tell this project's repository "
                      "(set ci.repo in .claude/factory.json or sign in with `gh auth login`)", None))
        return steps
    for cid, cname in exited_containers(names["CI_NAME"]):
        steps.append(("container", f"remove the exited container {cname} ({cid})", lambda c=cid: docker("rm", c)))
    try:
        pool = runners_of(REPO)
    except Refusal:
        pool = None  # no admin on the repo: the runner steps are skipped, the others still run
    for rid, rname in offline_runners(pool, names["CI_NAME"]):
        steps.append(("runner", f"remove the offline runner {rname} (id {rid})",
                      lambda i=rid: gh_api(REPO + f"actions/runners/{i}", "DELETE")))
    for var, labels in dangling_variables(pool):
        steps.append(("variable", f"delete {var} (no online runner has {labels}); jobs then use GitHub's runners",
                      lambda v=var: gh_api(REPO + f"actions/variables/{v}", "DELETE")))
    return steps


def close_issue(number):
    from factory_issues import gh
    gh("PATCH", f"repos/{{owner}}/{{repo}}/issues/{number}", {"state": "closed", "state_reason": "not_planned"})


def main(argv):
    if any(a not in ("--apply",) for a in argv):
        print(json.dumps({"code": "usage", "message": f"unknown option {' '.join(argv)}.", "fix": "Use: factory reset-run [--apply]."}), file=sys.stderr)
        return 1
    apply = "--apply" in argv
    try:
        gh_api("user")
        steps = plan(load())
        print("factory reset-run --apply" if apply else "factory reset-run (a plan: nothing is changed; add --apply to do it)")
        todo = [s for s in steps if s[2] is not None]
        for kind, text, action in steps:
            if action is None:
                print(f"  {kind}: {text}")
            elif apply:
                action()
                print(f"  done, {kind}: {text}")
            else:
                print(f"  {kind}: {text}")
        if not todo:
            print("  Nothing to reset.")
    except Refusal as e:
        print(json.dumps(e.body), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
