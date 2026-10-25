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
