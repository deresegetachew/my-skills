#!/usr/bin/env python3
"""`factory settings`: browse, understand and change the factory's settings (.claude/factory.json) without editing JSON.

  factory settings                       the interactive menu in a terminal; elsewhere (a pipe, a script) the list
  factory settings interactive           the menu, even when stdin is a pipe (a scripted session)
  factory settings list [--section S] [--json]
                                         every setting: value, default, whether it is overridden, what it does
  factory settings get <key>             just the value, as JSON (dotted keys: tasks.source, commands.test)
  factory settings set <key> <value>     change it; checked against the setting's type and limits (JSON for lists/objects)
  factory settings unset <key>           back to the default (the key leaves the file)
  factory settings help [<key>]          the long help for one setting, or the list of sections
  factory settings diff                  what the project file sets differently from the defaults
  factory settings validate              exit 1 with clear messages when a value is wrong (usable in CI)
  factory settings pr [--ready]          propose the edited .claude/factory.json as a pull request (a draft by default)
  factory settings docs [--check|--write] [--file F]
                                         the README's settings tables, generated from the metadata table
  factory settings --local ...           the same commands for this machine's own settings (outside the repo)

The table that describes every setting is factory_settings_schema.py; the list, help, validate, the menu and the README
all come from it. `set`, `unset`, `pr` and saving in the menu only write files: `.claude/` is protected, so a project
change goes to main through a pull request. Only people change settings: inside an agent session (FACTORY_AGENT,
FACTORY_LOOP or CLAUDECODE set) they refuse, because the PR gate itself reads these settings.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_settings_schema as schema  # noqa: E402
import factory_settings_store as store  # noqa: E402
from factory_settings_schema import MISSING, SettingError, as_text  # noqa: E402

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
    "commands.stackUp": ("str", "Brings the dev stack up (Postgres, MinIO ...); `factory resume` runs it at boot. Should return once the stack is started. Empty: no stack at boot.", None, ""),
    "commands.stackHealth": ("str", "Passes (exit 0) once the stack is healthy; `factory resume` asks until it does. Empty: stackUp is enough.", None, ""),
    "commands.agentSetup": ("str", "Runs once per loop after the env is set, e.g. to create the slot's database.", None, ""),
    "commands.typecheckChanged": ("str", "The Stop check's typecheck, for the changed packages only (saves time and tokens). Empty: use commands.typecheck.", None, ""),
    "commands.ci": ("str", "What CI runs (typecheck, lint, test, build), for `factory verify`; `{base}` is origin/<main>. When set on main, a ready PR needs it passed for its commit.", None, ""),
    "commands.fix": ("str", "Formats and auto-fixes the files this branch changed, e.g. `prettier --write {files} && eslint --fix {files}` (`{files}` is the quoted list; without it the list is appended). The Stop check and `factory verify` run it first, so agents never spend a turn on style.", None, ""),
    "fixPaths": ("list", "Regexes: commands.fix gets only changed files matching one of them. Empty: every changed file.", None, []),
    "commands.testChanged": ("str", "The Stop check's tests, for the changed packages only. Empty: use commands.test.", None, ""),
    "codePaths": ("list", "Folders with code: the Stop check runs only when they changed.", None, None),
    "checkRequires": ("list", "Paths that must exist before the Stop check runs, e.g. [\"node_modules\"].", None, None),
    "checkOutputLines": ("int", "How many lines of a failing check the agent is shown (failures first).", None, None),
    "checkLogDir": ("str", "Where a check's full output is saved; the agent sees a capped summary and this path.", None, "tmp/checks"),
    "protected": ("list", "Regexes of files an agent may not merge.", None, None),
    "alwaysAllowed": ("list", "Files that are never protected (the plan, the blocked list).", None, None),
    "testPaths": ("list", "Regexes the Factory guard treats as tests.", None, None),
    "goldenPaths": ("list", "Regexes the guard treats as expected outputs.", None, None),
    "dependencyManifests": ("list", "Regexes of dependency manifests (a new dependency needs deps-reviewed).", None, None),
    "maxOpenPRs": ("int", "Ready PRs the account may have open at once. About the number of agents + 1.", None, None),
    "prSizeWarn": ("int", "The guard warns above this many changed lines.", None, None),
    "reviewMarkers": ("str", "Where review passes are written.", None, None),
    "reReviewPercent": ("int", "A reviewer's second round reads only what changed since its last round, unless that is more than this percent of the branch diff (or touches a new file): then it is a full review. 0: always a full review.", None, None),
    "lessons": ("str", "The curated lessons file: one-line rules the builder and the reviewers read first (`factory lessons`).", None, None),
    "lessonsCap": ("int", "The most lessons the file may hold; `factory lessons check` fails above it and add refuses. Prune what a check enforces now.", None, None),
    "trustedReviewers": ("list", "GitHub logins whose approvals count. Empty: any.", None, []),
    "holdLabel": ("str", "The label the dev manager puts on a PR it is reviewing.", None, None),
    "agents": ("list", "The agents' names, in order (lowercase letters, digits, dashes).", None, None),
    "agentEnv": ("dict", "Per-loop variables: {\"API_PORT\": \"{port:4100}\", \"DATABASE_URL\": \"...{suffix}\"}.", None, None),
    "portStep": ("int", "How far each agent's ports move from the previous agent's.", None, None),
    "claimStaleHours": ("int", "How long a local claim or a pushed task branch holds a task.", None, None),
    "waitMinutes": ("int", "How often an idle loop looks for work. 0: it exits instead.", None, 1),
    "models": ("dict", "The model per role (builder, manager, test-writer, reviewer, architecture-reviewer, safety-auditor, security-reviewer): {\"builder\": {\"model\": \"opus\", \"effort\": \"high\"}, \"reviewer\": {\"model\": \"sonnet\", \"escalateTo\": \"opus\"}}. effort (low, medium, high, xhigh, max) is for builder and manager only. A role with no entry keeps today's model: the agent file's, or Claude Code's default.", None, {}),
    "manager.claimMinutes": ("int", "How long a dev manager's review or answer claim holds a PR or question before another manager may take it (a lease; it ends sooner when the review marker or the answer is posted).", None, None),
    "manager.flakes": ("list", "Names of CI jobs known to fail now and then for no reason. `factory prs` says `rerun flake` for a PR whose only red jobs are these, failing for the first time on that commit; a second failure goes back to the agent.", None, []),
    "tasks.source": ("enum", "Where tasks come from.", ["plan", "issues"], None),
    "tasks.staleHours": ("int", "An in-progress issue with no activity this long counts as stale.", None, None),
    "tasks.pingMinutes": ("int", "How often a working agent pings its agent issue, at most.", None, None),
    "tasks.downMinutes": ("int", "No ping for this long: the agent counts as down.", None, None),
    "tasks.heartbeatSeconds": ("int", "How often the heartbeat daemon (`factory heartbeat`) looks at this machine's agents. It writes to GitHub only on a change, and every pingMinutes as a keepalive.", None, None),
    "tasks.heartbeatMissMinutes": ("int", "An agent the daemon writes for counts as silent after this many minutes without a keepalive (instead of downMinutes).", None, None),
    "tasks.releaseDownMinutes": ("int", "An agent that is plainly down (its loop or the daemon said so) gets its in-progress issues back to ready by the sweep after this long.", None, None),
    "tasks.showWhere": ("bool", "Post the machine, folder, tmux session and Remote Control link on agent issues (anyone who can read the repo sees them).", None, False),
    "reviews.safety-auditor.paths": ("list", "Regexes of paths that need the safety auditor.", None, None),
    "reviews.security-reviewer.paths": ("list", "Regexes of paths that need the security reviewer.", None, None),
    "eval.command": ("str", "The eval command (e.g. `pnpm golden`). Empty: no eval yet.", None, ""),
    "eval.baseline": ("str", "The eval's baseline file.", None, ""),
    "design.references": ("str", "The folder of design references. Empty: no design check.", None, ""),
    "notes": ("str", "The folder of project notes for the shared agents and skills.", None, None),
    "usageLog": ("str", "Where `factory usage --record` appends its rows (commit it to keep the history).", None, "docs/factory-usage.md"),
    "styles": ("list", "Style guides per path: [{\"paths\": [...], \"skills\": [...], \"check\": \"...\"}].", None, None),
    "release.repo": ("str", "The GitHub repository whose releases `factory update` installs (owner/name). Default: the factory's own, deresegetachew/my-skills.", None, "deresegetachew/my-skills"),
    "ci.name": ("str", "The self-hosted runner's name (default `<repo>-ci`).", None, ""),
    "ci.label": ("str", "The runner label CI jobs ask for (default `<repo>-local`).", None, ""),
    "ci.runners": ("int", "Heavy runner loops per machine (each with its own Docker); FACTORY_CI_RUNNERS overrides it on one machine.", None, 1),
    "ci.light": ("bool", "Also run one small runner without Docker for light jobs (the Factory guard), label `<repo>-light`.", None, True),
    "ci.image": ("str", "The heavy runners' image: build (with the project's Node, pnpm and Playwright, faster jobs) or base.", ["build", "base"], "build"),
    "ci.caches": ("bool", "Keep a pull-through Docker Hub mirror between jobs (heavy runners; read-only to jobs, no workspace or secrets).", None, True),
    "ci.lightLabel": ("str", "The light runner's label (default `<repo>-light`).", None, ""),
}
PATH = store.PATH
SETTINGS = schema.SETTINGS  # the table of project settings, for callers of the older module (key -> Setting)


def default_of(key):
    """The default of a project setting, as `factory_config.py` has it."""
    return schema.SETTINGS[key].default
READ_ONLY = ("list", "ls", "get", "show", "help", "options", "diff", "validate", "docs")
VALUE_FLAGS = ("--section", "--file")
USAGE = ("usage: factory settings [--local] [list [--section S] [--json] | get <key> | set <key> <value> | unset <key> | "
         "help [<key>] | diff | validate | interactive | pr [--ready] | docs [--check|--write]]")


def die(message):
    raise SystemExit(f"factory settings: {message}")


def parse_args(argv):
    flags, values, rest, i = set(), {}, [], 0
    while i < len(argv):
        a = argv[i]
        if a in VALUE_FLAGS:
            if i + 1 >= len(argv):
                die(f"{a} needs a value. {USAGE}")
            values[a] = argv[i + 1]
            i += 2
        elif a.startswith("--") and "=" in a and a.split("=")[0] in VALUE_FLAGS:
            values[a.split("=")[0]] = a.split("=", 1)[1]
            i += 1
        elif a in ("--local", "--json", "--draft", "--ready", "--check", "--write", "-i"):
            flags.add(a)
            i += 1
        else:
            rest.append(a)
            i += 1
    return flags, values, rest


def known(key, local):
    table = schema.table(local)
    if key not in table:
        near = [k for k in table if key.split(".")[0] == k.split(".")[0]]
        hint = f" Settings under `{key.split('.')[0]}`: {', '.join(near)}." if near and len(near) < 15 else ""
        scope = "a machine setting (--local)" if not local and key in schema.MACHINE else (
            "a project setting (leave out --local)" if local and key in schema.SETTINGS else "a setting")
        die(f"`{key}` isn't {scope}.{hint} `factory settings{' --local' if local else ''}` lists them all.")
    return table[key]


def read_scope(local):
    """(data, indent) of the scope's file."""
    return (store.read_machine(), 2) if local else store.read_project()


def value_in(data, s):
    return data.get(s.key, MISSING) if s.scope == "machine" else store.lookup(data, s.key)


def row(data, s):
    here = value_in(data, s)
    default = s.default
    value = default if here is MISSING else here
    return {"key": s.key, "section": s.section, "scope": s.scope, "type": s.kind, "value": value, "default": default,
            "overridden": here is not MISSING and here != default, "set": here is not MISSING,
            "description": s.short + (f" Options: {', '.join(s.options)}." if s.options else ""),
            "needs": s.needs}


def flag_of(r):
    if r["overridden"]:
        return f"(default {as_text(r['default'])}, overridden)"
    return "(same as the default)" if r["set"] else "(default)"


def cmd_list(data, local, section, as_json):
    slug = None
    if section:
        slug = schema.section_of(section)
        if not slug:
            die(f"`{section}` isn't a section. Sections: " + ", ".join(f"{s} ({t})" for s, t, _ in schema.SECTIONS) + ".")
    rows = [row(data, s) for s in schema.table(local).values() if not slug or s.section == slug]
    if as_json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return
    where = store.machine_path() if local else PATH
    print(f"Factory settings ({where}). `factory settings help <key>` for one in full.\n")
    for r in rows:
        shown = as_text(r["value"])
        if len(shown) > 70:
            shown = shown[:67] + "..."
        print(f"{r['key']:34} {shown}  {flag_of(r)}")
        print(f"{'':34} {r['description']}")
    if not local:
        other = [k for k in data if not k.startswith("_") and not any(s == k or s.startswith(k + ".") for s in schema.SETTINGS)]
        if other:
            print(f"\nOther keys in {PATH}, kept as they are: {', '.join(other)}")
        if not slug:
            print("\nThis machine's own settings (" + ", ".join(schema.MACHINE) + "): `factory settings --local`.")


def cmd_help(local, key):
    if not key:
        print("Sections (`factory settings list --section <name>`; `factory settings help <key>` for one setting):\n")
        for slug, title, readers in schema.SECTIONS:
            n = len([s for s in list(schema.SETTINGS.values()) + list(schema.MACHINE.values()) if s.section == slug])
            print(f"  {slug:9} {title}  ({n} settings)")
        return
    s = known(key, local) if (local or key not in schema.MACHINE or key in schema.SETTINGS) else known(key, True)
    from factory_settings_interactive import help_text
    data, _ = read_scope(s.scope == "machine")
    print(help_text(s, value_in(data, s)))


def cmd_show(data, local, key):
    s = known(key, local)
    here = value_in(data, s)
    print(s.key)
    print(f"  {s.short}")
    print(f"  type: {s.kind}" + (f" ({', '.join(s.options)})" if s.options else ""))
    print(f"  default: {as_text(s.default)}")
    print(f"  here: {'(default)' if here is MISSING else as_text(here)}")
    print(f"  More: factory settings help {s.key}")


def cmd_get(data, local, key):
    s = known(key, local)
    here = value_in(data, s)
    print(as_text(s.default if here is MISSING else here))


def project_agents():
    data, _ = store.read_project()
    names = data.get("agents")
    return names if isinstance(names, list) else schema.DEFAULTS["agents"]


def cmd_set(data, indent, local, key, raw):
    s = known(key, local)
    store.refuse_in_agent_session()
    try:
        value = schema.parse(s, raw, project_agents() if local else None)
    except SettingError as e:
        die(f"`{key}` {e}")
    if local:
        if key == "agents":
            from factory_config import load
            from factory_machine import checked_names
            checked_names(load(), ",".join(value), "factory settings --local set agents")
        data[key] = value
        path = store.write_machine(data)
        print(f"{key} = {as_text(value)} in {path} (this machine only, not committed).")
        return
    store.assign(data, key, value)
    store.write_project(data, indent)
    print(f"{key} = {as_text(value)} in {PATH}. Commit it on a branch and merge it in a pull request "
          "(`factory settings pr` does that).")


def cmd_unset(data, indent, local, key):
    s = known(key, local)
    store.refuse_in_agent_session()
    if local:
        if data.pop(key, MISSING) is not MISSING:
            store.write_machine(data)
    elif store.remove(data, key):
        store.write_project(data, indent)
    print(f"{key} is back to its default ({as_text(s.default)}).")


def cmd_diff(data, local):
    rows = [row(data, s) for s in schema.table(local).values()]
    rows = [r for r in rows if r["overridden"]]
    other = [] if local else [k for k in data if not k.startswith("_") and not any(s == k or s.startswith(k + ".") for s in schema.SETTINGS)]
    if not rows and not other:
        print("No differences: every setting has its default value.")
        return
    for r in rows:
        print(f"{r['key']}: {as_text(r['value'])}  (default {as_text(r['default'])})")
    for k in other:
        print(f"{k}: {as_text(data[k])}  (not a factory setting; kept as it is)")


def cmd_validate(data, local):
    if local:
        errors, warnings = [], []
        for key, value in data.items():
            if key not in schema.MACHINE:
                warnings.append(f"{key}: not a machine setting.")
                continue
            try:
                schema.check_value(schema.MACHINE[key], value, project_agents())
            except SettingError as e:
                errors.append(f"{key}: {e}")
    else:
        errors, warnings = schema.validate_all(data)
    for w in warnings:
        print(f"warning: {w}")
    for e in errors:
        print(f"error: {e}", file=sys.stderr)
    if errors:
        print(f"{len(errors)} problem{'s' if len(errors) != 1 else ''} in {store.machine_path() if local else PATH}. "
              "Fix each value, or `factory settings unset <key>` for the default.", file=sys.stderr)
        raise SystemExit(1)
    print(f"ok: {store.machine_path() if local else PATH} is valid" + (f" ({len(warnings)} warning{'s' if len(warnings) != 1 else ''})" if warnings else "") + ".")


def cmd_docs(flags, values):
    path = values.get("--file") or os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "README.md")
    block = f"{schema.README_BEGIN}\n{schema.markdown()}\n{schema.README_END}"
    if not ("--check" in flags or "--write" in flags):
        print(block)
        return
    try:
        text = open(path).read()
    except OSError as e:
        die(f"can't read {path}: {e}")
    if schema.README_BEGIN not in text or schema.README_END not in text:
        die(f"{path} has no {schema.README_BEGIN} ... {schema.README_END} block to fill.")
    head, rest = text.split(schema.README_BEGIN, 1)
    tail = rest.split(schema.README_END, 1)[1]
    new = head + block + tail
    if "--check" in flags:
        if new != text:
            print(f"{path}: the settings tables are out of date. Run `factory settings docs --write --file {path}`.", file=sys.stderr)
            raise SystemExit(1)
        print(f"ok: {path} matches the settings table.")
        return
    store.refuse_in_agent_session()
    store.write_atomic(path, new)
    print(f"Wrote the settings tables into {path}.")


def main(argv):
    flags, values, rest = parse_args(argv)
    local = "--local" in flags
    cmd = "interactive" if "-i" in flags else (rest[0] if rest else None)
    args = rest[1:] if rest and "-i" not in flags else rest
    if cmd is None:
        cmd = "interactive" if sys.stdin.isatty() and sys.stdout.isatty() else "list"
    if cmd == "interactive":
        from factory_settings_interactive import run
        return run()
    if cmd == "docs":
        return cmd_docs(flags, values)
    if cmd == "pr":
        store.refuse_in_agent_session()
        from factory_settings_save import open_pr
        return open_pr(draft="--ready" not in flags)
    data, indent = read_scope(local)
    if cmd in ("list", "ls") and not args:
        return cmd_list(data, local, values.get("--section"), "--json" in flags)
    if cmd == "help":
        return cmd_help(local, args[0] if args else None)
    if cmd in ("show", "options") and len(args) == 1:
        return cmd_show(data, local, args[0])
    if cmd == "get" and len(args) == 1:
        return cmd_get(data, local, args[0])
    if cmd == "set" and len(args) == 2:
        return cmd_set(data, indent, local, args[0], args[1])
    if cmd == "unset" and len(args) == 1:
        return cmd_unset(data, indent, local, args[0])
    if cmd == "diff" and not args:
        return cmd_diff(data, local)
    if cmd == "validate" and not args:
        return cmd_validate(data, local)
    raise SystemExit(USAGE)


if __name__ == "__main__":
    main(sys.argv[1:])
