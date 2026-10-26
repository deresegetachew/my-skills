#!/usr/bin/env python3
"""What `factory doctor` says about CI and the agents before a test run (#205, and the doctor part of #199).

Four read-only checks, each an `ok`, `fix` (with the step) or `note`; everything it asks of GitHub is a `gh api` GET:

  1. the repo variables CI_RUNS_ON and CI_RUNS_ON_LIGHT, and whether a runner with that label is online
  2. whether the newest run of the workflows on the main branch is green
  3. in-progress issues held by an agent that is down (issues mode), and open Agent issues for names that are not
     configured agents or roles (they never ran here)
  4. a workflow whose setup does not match .claude/factory.json (pnpm/Node steps with no package.json, or a command
     the workflow runs that factory.json leaves empty)

A GitHub answer it can't read (no admin for the runners, gh signed out) is skipped or a note, never a fix.
"""
import glob, json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import role_names, task_source, ROLE_NAMES  # noqa: E402

REPO = "repos/{owner}/{repo}/"
VARIABLES = ("CI_RUNS_ON", "CI_RUNS_ON_LIGHT")
RUN_COMMANDS = ("typecheck", "lint", "test", "build")


def get(path):
    """A `gh api` GET as JSON, or None when it fails or answers nothing readable."""
    try:
        p = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if p.returncode != 0 or not p.stdout.strip():
        return None
    try:
        return json.loads(p.stdout)
    except ValueError:
        return None


def labels_of(value):
    """The runner labels a runs-on variable asks for: a JSON list, or one JSON string."""
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        parsed = value
    if isinstance(parsed, str):
        return [parsed]
    return [l for l in parsed if isinstance(l, str)] if isinstance(parsed, list) else []


def runners(r, variables):
    wanted = {v["name"]: v.get("value") for v in variables if isinstance(v, dict) and v.get("name") in VARIABLES}
    if not wanted:
        return
    found = get(REPO + "actions/runners")
    pool = found.get("runners") if isinstance(found, dict) else None
    for name in VARIABLES:
        if name not in wanted:
            continue
        labels = labels_of(wanted[name])
        if "self-hosted" not in [l.lower() for l in labels]:
            r.ok(f"{name} {wanted[name]}: GitHub's own runners, nothing to keep online")
            continue
        if pool is None:
            r.note(f"{name} runner", f"can't read the repo's runners (it needs admin on the repo), so I can't tell whether one with "
                   f"{labels} is online: check Settings > Actions > Runners")
            continue
        need = {l.lower() for l in labels}
        online = [x for x in pool if x.get("status") == "online" and need <= {(l.get("name") or "").lower() for l in x.get("labels", [])}]
        if online:
            r.ok(f"{name} {wanted[name]}: runner {online[0].get('name')} is online")
        else:
            r.fix(f"{name} {wanted[name]}", f"no online runner has the labels {labels}, so jobs wait for ever: start it with `factory ci install` "
                  f"(`factory ci status` shows the runners), or point the variable at one that exists (Settings > Secrets and variables > "
                  f"Actions > Variables), or delete it to use GitHub's runners")


def newest_run(r, main):
    found = get(REPO + f"actions/runs?branch={main}&per_page=1")
    runs = found.get("workflow_runs") if isinstance(found, dict) else None
    if runs is None:
        return
    if not runs:
        r.note(f"CI on {main}", "no workflow run on the main branch yet")
        return
    run = runs[0]
    if run.get("status") not in (None, "completed"):
        r.note(f"CI on {main}", f"the newest run is {run.get('status')} ({run.get('html_url', '')})")
    elif run.get("conclusion") == "success":
        r.ok(f"CI on {main}: the newest run is green")
    else:
        r.fix(f"CI on {main}", f"the newest run {run.get('conclusion')} ({run.get('html_url', '')}), so every agent pull request will fail too: "
              "open it, fix the workflow or the code, and merge that before agents start")


def agents(r, cfg):
    import factory_agents
    try:
        stale = factory_agents.stale_claims(cfg)
        issues = factory_agents.agent_issues()
    except SystemExit:
        return
    for number, name, status in stale:
        r.note(f"#{number} held by {name} ({status})", f"`factory next` skips it until the sweep frees it: run `factory issues release {number}` "
               "now, or start the agent again")
    configured = set(cfg.get("agents") or []) | {n for role in ROLE_NAMES for n in role_names(cfg, role)}
    for name, found in factory_agents.by_agent(issues).items():
        issue = found[0]
        if issue.get("state") == "open" and name not in configured:
            r.note(f"Agent issue #{issue['number']} for {name}", f"{name} is not an agent or role name in .claude/factory.json, so it never ran "
                   f"here: close #{issue['number']} (an old test run left it)")


def workflow(r, cfg):
    files = sorted(glob.glob(".github/workflows/*.yml") + glob.glob(".github/workflows/*.yaml"))
    commands = cfg.get("commands") or {}
    for path in files:
        try:
            text = open(path).read()
        except OSError:
            continue
        name = os.path.basename(path)
        if re.search(r"pnpm/action-setup|actions/setup-node|\bpnpm (install|i)\b", text) and not os.path.exists("package.json"):
            test = commands.get("test") or ""
            r.fix(name, "it installs pnpm and Node but the project has no package.json, so CI fails before any agent runs: replace those "
                  f"steps with this project's own setup and commands" + (f" (commands.test is `{test}`)" if test else " (set commands.test in .claude/factory.json first)"))
        for cmd in RUN_COMMANDS:
            if re.search(rf"run:\s*pnpm (run )?{cmd}\b", text) and not commands.get(cmd):
                r.fix(f"{name} runs `pnpm {cmd}`", f"commands.{cmd} in .claude/factory.json is empty, so the Stop check and `factory verify` "
                      f"skip what CI runs: set it with `factory settings set commands.{cmd} '<command>'`, or take the step out of the workflow")


def checks(r, cfg):
    variables = get(REPO + "actions/variables")
    if isinstance(variables, dict):
        runners(r, variables.get("variables") or [])
    newest_run(r, cfg.get("mainBranch") or "main")
    if task_source(cfg) == "issues":
        agents(r, cfg)
    workflow(r, cfg)
