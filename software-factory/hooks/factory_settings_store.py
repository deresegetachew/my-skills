#!/usr/bin/env python3
"""Reading and writing the two settings files for `factory settings` (#49).

  project   .claude/factory.json in the repo (committed through a pull request)
  machine   this machine's own file outside the repo (factory_machine.names_file())

Writes keep the file readable: key order and `_about` entries stay, the file's own indent is kept (2 spaces when it
has none), a trailing newline ends it, and the write is atomic (a temp file, then a rename).
"""
import difflib, json, os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_settings_schema import MISSING, SETTINGS, lookup  # noqa: E402

PATH = os.path.join(".claude", "factory.json")


def fail(message):
    raise SystemExit(f"factory settings: {message}")


def detect_indent(text):
    for line in text.splitlines():
        stripped = line.lstrip(" \t")
        if stripped and stripped != line and line.startswith(("\t", " ")):
            lead = line[:len(line) - len(stripped)]
            return "\t" if lead.startswith("\t") else len(lead)
    return 2


def read_project(path=PATH):
    """(data, indent). {} and 2 when there is no file yet."""
    try:
        text = open(path).read()
    except FileNotFoundError:
        return {}, 2
    try:
        data = json.loads(text)
    except ValueError as e:
        fail(f"{path} isn't valid JSON ({e}). Fix it by hand first.")
    if not isinstance(data, dict):
        fail(f"{path} must hold a JSON object.")
    return data, detect_indent(text)


def dump(data, indent=2):
    return json.dumps(data, indent=indent, ensure_ascii=False) + "\n"


def write_atomic(path, text):
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".factory-settings-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        try:
            os.chmod(tmp, os.stat(path).st_mode & 0o777)
        except FileNotFoundError:
            os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_project(data, indent=2, path=PATH):
    write_atomic(path, dump(data, indent))


def read_machine():
    from factory_machine import machine_settings
    return machine_settings()


def machine_path():
    from factory_machine import names_file
    return names_file()


def write_machine(data):
    from factory_machine import write_machine_settings
    return write_machine_settings(data)


def assign(data, key, value):
    node = data
    parts = key.split(".")
    for part in parts[:-1]:
        if not isinstance(node.get(part), dict):
            node[part] = {}
        node = node[part]
    node[parts[-1]] = value


def remove(data, key):
    """Takes `key` out; a group left empty by it goes too. True when something was removed."""
    parts = key.split(".")
    node = data
    for part in parts[:-1]:
        node = node.get(part) if isinstance(node, dict) else None
        if not isinstance(node, dict):
            return False
    if not isinstance(node, dict) or parts[-1] not in node:
        return False
    del node[parts[-1]]
    # walk back up, dropping groups the removal emptied (but never `_about`-style keys)
    nodes = [data]
    for part in parts[:-1]:
        nodes.append(nodes[-1][part])
    for i in range(len(parts) - 2, -1, -1):
        if nodes[i + 1] == {}:
            del nodes[i][parts[i]]
        else:
            break
    return True


def changes(old, new):
    """[(key, old value or MISSING, new value or MISSING)] between two project dicts, by setting, then other keys."""
    out = []
    for key in SETTINGS:
        a, b = lookup(old, key), lookup(new, key)
        if a is MISSING and b is MISSING:
            continue
        if a is MISSING or b is MISSING or a != b:
            out.append((key, a, b))
    covered = {k.split(".")[0] for k in SETTINGS}
    for key in list(old) + [k for k in new if k not in old]:
        if key in covered or key.startswith("_"):
            continue
        a, b = old.get(key, MISSING), new.get(key, MISSING)
        if a is MISSING or b is MISSING or a != b:
            out.append((key, a, b))
    return out


def unified_diff(old_text, new_text, name):
    return "".join(difflib.unified_diff(old_text.splitlines(True), new_text.splitlines(True), f"a/{name}", f"b/{name}"))


def refuse_in_agent_session():
    for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
        if var in os.environ:  # set at all, even to an empty string
            raise SystemExit("factory settings: only a person changes the factory's settings, in their own "
                             f"terminal ({var} is set, so this looks like an agent session). The PR gate reads "
                             "these settings, so an agent never changes them.")
