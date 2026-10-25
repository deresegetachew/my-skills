#!/usr/bin/env python3
"""`factory settings`: see and change the project's factory settings (.claude/factory.json) without editing JSON.

  factory settings                 every setting: its value here (or the default) and what it does
  factory settings show <key>      one setting in full: what it does, its type, default, current value, options
  factory settings get <key>       just the value, as JSON (for scripts)
  factory settings set <key> <v>   change it; the value is checked against the setting's type and options
  factory settings unset <key>     back to the default

Keys use dots for nested settings: `tasks.source`, `commands.test`, `reviews.safety-auditor.paths`. A list or an
object is given as JSON: `factory settings set agents '["ada","grace"]'`. `set` and `unset` only write the file:
commit it on a branch and merge it in a pull request like any other change (`.claude/` is protected).

Only people change settings. Inside an agent session (FACTORY_AGENT, FACTORY_LOOP or CLAUDECODE set) `set` and
`unset` refuse, because the PR gate itself reads these settings.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import DEFAULTS  # noqa: E402

PATH = os.path.join(".claude", "factory.json")


def _default(key):
    node = DEFAULTS
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


# key: (type, what it does, options or None, default when DEFAULTS has none). Types: str, int, bool, list, dict,
# enum. Only these keys can be set; anything else in factory.json is kept and listed as "other".
SETTINGS = {
    "prd": ("str", "Where the PRD lives. Agents read the sections a task points to.", None, None),
    "plan": ("str", "The build plan (plan mode: its unticked lines are the tasks).", None, None),
    "blocked": ("str", "The blocked list (plan mode): `- 1.3: needs ...` lines are skipped.", None, None),
    "decisions": ("str", "The folder of numbered decision records.", None, None),
    "numberedDirs": ("list", "More folders of numbered files (migrations): a new file takes a free number.", None, None),
    "mainBranch": ("str", "The main branch.", None, None),
    "commands.install": ("str", "Installs dependencies in a new worktree (start it with `git submodule update --init`).", None, ""),
    "commands.typecheck": ("str", "The typecheck CI and the Stop check run.", None, None),
    "commands.lint": ("str", "The lint command.", None, None),
    "commands.test": ("str", "The full test command.", None, None),
    "commands.build": ("str", "The build command.", None, None),
    "commands.smoke": ("str", "A quick command proving main still works.", None, None),
    "commands.agentSetup": ("str", "Runs once per loop after the env is set, e.g. to create the slot's database.", None, ""),
    "commands.typecheckChanged": ("str", "The Stop check's typecheck, for the changed packages only (saves time and tokens). Empty: use commands.typecheck.", None, ""),
    "commands.ci": ("str", "What CI runs (typecheck, lint, test, build), for `factory verify`; `{base}` is origin/<main>. When set on main, a ready PR needs it passed for its commit.", None, ""),
    "commands.testChanged": ("str", "The Stop check's tests, for the changed packages only. Empty: use commands.test.", None, ""),
    "codePaths": ("list", "Folders with code: the Stop check runs only when they changed.", None, None),
    "checkRequires": ("list", "Paths that must exist before the Stop check runs, e.g. [\"node_modules\"].", None, None),
    "checkOutputLines": ("int", "How many lines of a failing check the agent is shown (failures first).", None, None),
    "protected": ("list", "Regexes of files an agent may not merge.", None, None),
    "alwaysAllowed": ("list", "Files that are never protected (the plan, the blocked list).", None, None),
    "testPaths": ("list", "Regexes the Factory guard treats as tests.", None, None),
    "goldenPaths": ("list", "Regexes the guard treats as expected outputs.", None, None),
    "dependencyManifests": ("list", "Regexes of dependency manifests (a new dependency needs deps-reviewed).", None, None),
    "maxOpenPRs": ("int", "Ready PRs the account may have open at once. About the number of agents + 1.", None, None),
    "prSizeWarn": ("int", "The guard warns above this many changed lines.", None, None),
    "reviewMarkers": ("str", "Where review passes are written.", None, None),
    "trustedReviewers": ("list", "GitHub logins whose approvals count. Empty: any.", None, []),
    "holdLabel": ("str", "The label the dev manager puts on a PR it is reviewing.", None, None),
    "agents": ("list", "The agents' names, in order (lowercase letters, digits, dashes).", None, None),
    "agentEnv": ("dict", "Per-loop variables: {\"API_PORT\": \"{port:4100}\", \"DATABASE_URL\": \"...{suffix}\"}.", None, None),
    "portStep": ("int", "How far each agent's ports move from the previous agent's.", None, None),
    "claimStaleHours": ("int", "How long a local claim or a pushed task branch holds a task.", None, None),
    "waitMinutes": ("int", "How often an idle loop looks for work. 0: it exits instead.", None, 1),
    "models": ("dict", "The model per role (builder, manager, test-writer, reviewer, architecture-reviewer, safety-auditor, security-reviewer): {\"builder\": {\"model\": \"opus\", \"effort\": \"high\"}, \"reviewer\": {\"model\": \"sonnet\", \"escalateTo\": \"opus\"}}. effort (low, medium, high, xhigh, max) is for builder and manager only. A role with no entry keeps today's model: the agent file's, or Claude Code's default.", None, {}),
    "tasks.source": ("enum", "Where tasks come from.", ["plan", "issues"], None),
    "tasks.staleHours": ("int", "An in-progress issue with no activity this long counts as stale.", None, None),
    "tasks.pingMinutes": ("int", "How often a working agent pings its agent issue, at most.", None, None),
    "tasks.downMinutes": ("int", "No ping for this long: the agent counts as down.", None, None),
    "tasks.showWhere": ("bool", "Post the machine and folder name on agent issues.", None, False),
    "reviews.safety-auditor.paths": ("list", "Regexes of paths that need the safety auditor.", None, None),
    "reviews.security-reviewer.paths": ("list", "Regexes of paths that need the security reviewer.", None, None),
    "eval.command": ("str", "The eval command (e.g. `pnpm golden`). Empty: no eval yet.", None, ""),
    "eval.baseline": ("str", "The eval's baseline file.", None, ""),
    "design.references": ("str", "The folder of design references. Empty: no design check.", None, ""),
    "notes": ("str", "The folder of project notes for the shared agents and skills.", None, None),
    "usageLog": ("str", "Where `factory usage --record` appends its rows (commit it to keep the history).", None, "docs/factory-usage.md"),
    "styles": ("list", "Style guides per path: [{\"paths\": [...], \"skills\": [...], \"check\": \"...\"}].", None, None),
    "ci.name": ("str", "The self-hosted runner's name (default `<repo>-ci`).", None, ""),
    "ci.label": ("str", "The runner label CI jobs ask for (default `<repo>-local`).", None, ""),
    "ci.runners": ("int", "Heavy runner loops per machine (each with its own Docker); FACTORY_CI_RUNNERS overrides it on one machine.", None, 1),
    "ci.light": ("bool", "Also run one small runner without Docker for light jobs (the Factory guard), label `<repo>-light`.", None, True),
    "ci.image": ("str", "The heavy runners' image: build (with the project's Node, pnpm and Playwright, faster jobs) or base.", ["build", "base"], "build"),
    "ci.caches": ("bool", "Keep a pull-through Docker Hub mirror between jobs (heavy runners; read-only to jobs, no workspace or secrets).", None, True),
    "ci.lightLabel": ("str", "The light runner's label (default `<repo>-light`).", None, ""),
}


def default_of(key):
    d = _default(key)
    return d if d is not None else SETTINGS[key][3]


def read():
    try:
        with open(PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except ValueError as e:
        raise SystemExit(f"{PATH} isn't valid JSON ({e}). Fix it by hand first.")


def write(data):
    with open(PATH, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


MISSING = object()


def lookup(data, key):
    node = data
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return MISSING
        node = node[part]
    return node


def known(key):
    if key not in SETTINGS:
        near = [k for k in SETTINGS if key.split(".")[0] == k.split(".")[0]]
        hint = f" Settings under `{key.split('.')[0]}`: {', '.join(near)}." if near else ""
        raise SystemExit(f"factory settings: `{key}` isn't a setting.{hint} `factory settings` lists them all.")


def parse(key, raw):
    kind, _, options, _ = SETTINGS[key]
    if kind == "str":
        return raw
    if kind == "enum":
        if raw not in options:
            raise SystemExit(f"factory settings: `{key}` takes one of {', '.join(options)}; got {raw!r}.")
        return raw
    if kind == "int":
        try:
            value = int(raw)
        except ValueError:
            raise SystemExit(f"factory settings: `{key}` takes a whole number; got {raw!r}.")
        if value < 0:
            raise SystemExit(f"factory settings: `{key}` can't be negative.")
        return value
    if kind == "bool":
        if raw.lower() in ("true", "yes", "on", "1"):
            return True
        if raw.lower() in ("false", "no", "off", "0"):
            return False
        raise SystemExit(f"factory settings: `{key}` takes true or false; got {raw!r}.")
    try:
        value = json.loads(raw)
    except ValueError:
        example = '["a","b"]' if kind == "list" else '{"KEY": "value"}'
        raise SystemExit(f"factory settings: `{key}` takes a JSON {kind}, e.g. '{example}'; got {raw!r}.")
    if not isinstance(value, list if kind == "list" else dict):
        raise SystemExit(f"factory settings: `{key}` takes a JSON {kind}.")
    if key == "models":
        from factory_models import validate
        try:
            validate(value)
        except ValueError as e:
            raise SystemExit(f"factory settings: {e}")
    if key == "agents":
        from factory_config import safe_agent
        for name in value:
            safe_agent(name if isinstance(name, str) else "")
    return value


def as_text(value):
    return json.dumps(value, ensure_ascii=False)


def refuse_in_agent_session():
    for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
        if var in os.environ:  # set at all, even to an empty string
            raise SystemExit("factory settings: only a person changes the factory's settings, in their own "
                             f"terminal ({var} is set, so this looks like an agent session). The PR gate reads "
                             "these settings, so an agent never changes them.")


def cmd_list(data):
    print(f"Factory settings ({PATH}). `factory settings show <key>` for one in full.\n")
    for key, (kind, about, options, _) in SETTINGS.items():
        here = lookup(data, key)
        if here is MISSING:
            shown = f"{as_text(default_of(key))}  (default)"
        else:
            shown = as_text(here)
        if len(shown) > 70:
            shown = shown[:67] + "..."
        print(f"{key:34} {shown}")
        print(f"{'':34} {about}" + (f" Options: {', '.join(options)}." if options else ""))
    other = [k for k in data if not k.startswith("_") and not any(s == k or s.startswith(k + ".") for s in SETTINGS)]
    if other:
        print(f"\nOther keys in {PATH}, kept as they are: {', '.join(other)}")


def cmd_show(data, key):
    known(key)
    kind, about, options, _ = SETTINGS[key]
    here = lookup(data, key)
    print(key)
    print(f"  {about}")
    print(f"  type: {kind}" + (f" ({', '.join(options)})" if options else ""))
    print(f"  default: {as_text(default_of(key))}")
    print(f"  here: {'(default)' if here is MISSING else as_text(here)}")


def cmd_get(data, key):
    known(key)
    here = lookup(data, key)
    print(as_text(default_of(key) if here is MISSING else here))


def cmd_set(data, key, raw):
    known(key)
    refuse_in_agent_session()
    value = parse(key, raw)
    node = data
    parts = key.split(".")
    for part in parts[:-1]:
        if not isinstance(node.get(part), dict):
            node[part] = {}
        node = node[part]
    node[parts[-1]] = value
    write(data)
    print(f"{key} = {as_text(value)} in {PATH}. Commit it on a branch and merge it in a pull request.")


def cmd_unset(data, key):
    known(key)
    refuse_in_agent_session()
    parts = key.split(".")
    node = data
    for part in parts[:-1]:
        node = node.get(part) if isinstance(node, dict) else None
        if not isinstance(node, dict):
            break
    if isinstance(node, dict) and parts[-1] in node:
        del node[parts[-1]]
        write(data)
    print(f"{key} is back to its default ({as_text(default_of(key))}).")


def main(argv):
    data = read()
    if not argv or argv[0] in ("list", "ls"):
        return cmd_list(data)
    cmd, args = argv[0], argv[1:]
    if cmd in ("show", "help", "options") and len(args) == 1:
        return cmd_show(data, args[0])
    if cmd == "get" and len(args) == 1:
        return cmd_get(data, args[0])
    if cmd == "set" and len(args) == 2:
        return cmd_set(data, args[0], args[1])
    if cmd == "unset" and len(args) == 1:
        return cmd_unset(data, args[0])
    raise SystemExit("usage: factory settings [list] | show <key> | get <key> | set <key> <value> | unset <key>")


if __name__ == "__main__":
    main(sys.argv[1:])
