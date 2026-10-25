#!/usr/bin/env python3
"""The interactive `factory settings` (#49): a plain-terminal menu to browse, understand and change settings.

Only input() and print(), so it works over SSH, in a plain TTY and from a script that feeds stdin. Changes are held
in memory until `s` reviews them (a unified diff) and saves; quitting, or the input ending, writes nothing.

  main menu      a number opens a section, /text searches names and descriptions, s saves, q quits
  a section      a number opens a setting, b goes back
  a setting      c change, r reset to default, ? help, b back
  lists, objects add / edit / remove one item at a time; regex lists can be tested against example paths
"""
import copy, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_settings_schema as schema  # noqa: E402
import factory_settings_store as store  # noqa: E402
from factory_settings_schema import MISSING, SECTIONS, SettingError, as_text  # noqa: E402


class Quit(Exception):
    pass


class State:
    def __init__(self):
        self.project, self.indent = store.read_project()
        self.machine = store.read_machine()
        self.orig_project = copy.deepcopy(self.project)
        self.orig_machine = copy.deepcopy(self.machine)

    def data(self, scope):
        return self.machine if scope == "machine" else self.project

    def dirty(self):
        return self.project != self.orig_project or self.machine != self.orig_machine

    def reload(self):
        self.__init__()


def ask(prompt):
    try:
        return input(prompt).strip()
    except EOFError:
        print()
        raise Quit()


def value_of(st, s):
    here = store.lookup(st.data(s.scope), s.key) if s.scope == "project" else st.machine.get(s.key, MISSING)
    return here


def short_value(value):
    text = as_text(value)
    return text if len(text) <= 60 else text[:57] + "..."


def status(st, s):
    here = value_of(st, s)
    if here is MISSING:
        return short_value(s.default), "(default)"
    if here == s.default:
        return short_value(here), "(same as the default)"
    return short_value(here), f"(default {short_value(s.default)}, overridden)"


def describe(st, s, number=None):
    shown, flag = status(st, s)
    head = f"{number:3}  " if number else ""
    print(f"{head}{s.key:32} {shown}  {flag}")
    print(f"{'':{5 if number else 0}}{'':32} {s.short}")


def search(text):
    needle = text.strip().lower()
    found = []
    for table in (schema.SETTINGS, schema.MACHINE):
        for s in table.values():
            if needle and (needle in s.key.lower() or needle in s.short.lower()):
                found.append(s)
    return found


def say_refusal(action):
    try:
        action()
        return False
    except SystemExit as e:
        print(e.code if isinstance(e.code, str) else "")
        return True


def project_agents(st):
    names = st.project.get("agents")
    return names if isinstance(names, list) else schema.DEFAULTS["agents"]


# --- help -------------------------------------------------------------------------------------------------------

def help_text(s, current=MISSING):
    lines = [s.key + ("  (this machine only)" if s.scope == "machine" else ""),
             f"  {s.short}"]
    if s.long:
        lines += ["", "  " + s.long]
    lines += ["", f"  Type: {s.kind}" + (f" ({', '.join(s.options)})" if s.options else "") + f"; takes {schema.hint(s)}.",
              f"  Default: {as_text(s.default)}"]
    if current is not MISSING:
        lines.append(f"  Here: {as_text(current)}")
    lines.append(f"  Section: {schema.SECTION_TITLE[s.section]}")
    lines.append(f"  Read by: {s.read_by}.")
    if s.scope == "project":
        lines.append(f"  A change needs: {s.needs + '. Also: ' if s.needs else ''}{schema.DEFAULT_REVIEW}")
    else:
        lines.append(f"  A change needs: {s.needs}.")
    examples = s.examples or ([f"factory settings set {s.key} {as_text(s.default)}"] if s.scope == "project" and s.default not in (None, "", [], {}) else [])
    for ex in examples:
        lines.append(f"  Example: {ex}")
    return "\n".join(lines)


# --- changing a value -----------------------------------------------------------------------------------------

def note_if_missing_path(s, value):
    if s.key in ("prd", "plan", "blocked", "decisions") and value and not os.path.exists(value):
        print(f"  Note: {value} doesn't exist here.")


def commit_value(st, s, value):
    try:
        schema.check_value(s, value, project_agents(st) if s.scope == "machine" else None)
    except SettingError as e:
        print(f"  {s.key}: {e}")
        return False
    if s.scope == "machine":
        st.machine[s.key] = value
    else:
        store.assign(st.project, s.key, value)
    print(f"  {s.key} is now {short_value(value)} (not saved yet; s saves).")
    return True


def change(st, s):
    """True when the person is done with this setting (changed it or left an editor); False when they cancelled."""
    if say_refusal(store.refuse_in_agent_session):
        return False
    if s.kind == "list":
        return edit_list(st, s)
    if s.kind == "dict":
        return edit_dict(st, s)
    while True:
        raw = ask(f"New value for {s.key} ({schema.hint(s)}; blank cancels) > ")
        if raw == "":
            return False
        try:
            value = schema.parse(s, raw)
        except SettingError as e:
            print(f"  {s.key} {e}")
            continue
        note_if_missing_path(s, value)
        if commit_value(st, s, value):
            return True


def current_value(st, s):
    here = value_of(st, s)
    return copy.deepcopy(s.default if here is MISSING else here)


def parse_item(s, raw):
    if s.items == "any":
        import json
        try:
            return json.loads(raw)
        except ValueError:
            raise SettingError(f"takes a JSON value, e.g. {{\"paths\": [...]}}; got {raw!r}.")
    return raw


def show_items(items):
    if not items:
        print("  (empty)")
    for i, item in enumerate(items, 1):
        print(f"  {i:2}  {item if isinstance(item, str) else as_text(item)}")


def test_regexes(items):
    print("  Type example paths, separated by spaces; blank stops.")
    while True:
        line = ask("Paths to test > ")
        if not line:
            return
        for path in line.split():
            hits = [i for i, rx in enumerate(items, 1) if isinstance(rx, str) and re.search(rx, path)]
            if hits:
                print(f"  {path}  matches " + ", ".join(f"{i} ({items[i - 1]})" for i in hits))
            else:
                print(f"  {path}  no match")


def item_number(items, prompt):
    raw = ask(prompt)
    if raw.isdigit() and 1 <= int(raw) <= len(items):
        return int(raw) - 1
    if raw:
        print(f"  Choose a number from 1 to {len(items)}.")
    return None


def edit_list(st, s):
    items = current_value(st, s)
    while True:
        print(f"{s.key} ({len(items)} items)")
        show_items(items)
        menu = "[a]dd, [e]dit N, [r]emove N, [w] replace all (JSON)" + (", [t]est paths" if s.regex else "") + ", [b]ack > "
        c = ask(menu).lower()
        new = None
        if c in ("b", ""):
            return True
        elif c == "a":
            raw = ask("Item to add (blank cancels) > ")
            if raw:
                try:
                    new = items + [parse_item(s, raw)]
                except SettingError as e:
                    print(f"  {e}")
        elif c == "e" and items:
            i = item_number(items, "Item number to edit > ")
            if i is not None:
                raw = ask("New value (blank cancels) > ")
                if raw:
                    try:
                        new = items[:i] + [parse_item(s, raw)] + items[i + 1:]
                    except SettingError as e:
                        print(f"  {e}")
        elif c == "r" and items:
            i = item_number(items, "Item number to remove > ")
            if i is not None:
                new = items[:i] + items[i + 1:]
        elif c == "w":
            raw = ask("New list as JSON (blank cancels) > ")
            if raw:
                try:
                    new = schema.parse(s, raw, project_agents(st) if s.scope == "machine" else None)
                except SettingError as e:
                    print(f"  {s.key} {e}")
        elif c == "t" and s.regex:
            test_regexes(items)
        else:
            print("  Not a choice here.")
        if new is not None and commit_value(st, s, new):
            items = new


def edit_dict(st, s):
    obj = current_value(st, s)
    while True:
        print(f"{s.key} ({len(obj)} entries)")
        for k, v in obj.items():
            print(f"  {k}: {v if isinstance(v, str) else as_text(v)}")
        if not obj:
            print("  (empty)")
        c = ask("[a]dd or change a key, [r]emove a key, [w] replace all (JSON), [b]ack > ").lower()
        new = None
        if c in ("b", ""):
            return True
        elif c == "a":
            key = ask("Key (blank cancels) > ")
            raw = ask(f"Value for {key} > ") if key else ""
            if key and raw:
                new = dict(obj)
                new[key] = raw
                try:
                    schema.check_value(s, new)
                except SettingError:
                    try:
                        import json
                        new[key] = json.loads(raw)  # an object or number: models take objects
                    except ValueError:
                        pass
        elif c == "r" and obj:
            key = ask("Key to remove > ")
            if key in obj:
                new = {k: v for k, v in obj.items() if k != key}
            elif key:
                print(f"  There is no key {key}.")
        elif c == "w":
            raw = ask("New object as JSON (blank cancels) > ")
            if raw:
                try:
                    new = schema.parse(s, raw)
                except SettingError as e:
                    print(f"  {s.key} {e}")
        else:
            print("  Not a choice here.")
        if new is not None and commit_value(st, s, new):
            obj = new


def reset(st, s):
    if say_refusal(store.refuse_in_agent_session):
        return False
    if s.scope == "machine":
        st.machine.pop(s.key, None)
    else:
        store.remove(st.project, s.key)
    print(f"  {s.key} is back to its default, {short_value(s.default)} (not saved yet; s saves).")
    return True


# --- menus --------------------------------------------------------------------------------------------------------

def quit_ok(st):
    if not st.dirty():
        return True
    return ask("You have unsaved changes. Discard them and quit? [y/N] ").lower() in ("y", "yes")


def setting_menu(st, s):
    while True:
        print()
        describe(st, s)
        c = ask("[c]hange, [r]eset to default, [?] help, [b]ack > ").lower()
        if c in ("b", ""):
            return
        if c == "c":
            if change(st, s):
                return
        elif c == "r":
            if reset(st, s):
                return
        elif c == "?":
            print()
            print(help_text(s, value_of(st, s)))
        elif c == "s":
            save(st)
        elif c == "q":
            if quit_ok(st):
                raise Quit()
        else:
            print("  Not a choice here: c, r, ?, b.")


def listing(st, entries, heading):
    while True:
        print()
        print(heading)
        for i, s in enumerate(entries, 1):
            describe(st, s, i)
        c = ask("Number to open, /text to search, s to save, b to go back, q to quit > ")
        if c.lower() in ("b", ""):
            return
        if c.lower() == "q":
            if quit_ok(st):
                raise Quit()
        elif c.lower() == "s":
            save(st)
        elif c.startswith("/"):
            found = search(c[1:])
            if found:
                listing(st, found, f"Matches for {c[1:].strip()!r}:")
            else:
                print(f"  No setting matches {c[1:].strip()!r}.")
        elif c.isdigit() and 1 <= int(c) <= len(entries):
            setting_menu(st, entries[int(c) - 1])
        else:
            print(f"  Choose a number from 1 to {len(entries)}.")


def section_entries(slug):
    return [s for s in list(schema.SETTINGS.values()) + list(schema.MACHINE.values()) if s.section == slug]


def main_menu(st):
    while True:
        print()
        print(f"Factory settings ({store.PATH}; this machine: {store.machine_path()})")
        for i, (slug, title, _) in enumerate(SECTIONS, 1):
            print(f"  {i:2}  {title}  ({len(section_entries(slug))})")
        c = ask("Choose a number, /text to search, s to review and save, q to quit > ")
        if c.lower() == "q":
            if quit_ok(st):
                return
        elif c.lower() == "s":
            save(st)
        elif c.startswith("/"):
            found = search(c[1:])
            if found:
                listing(st, found, f"Matches for {c[1:].strip()!r}:")
            else:
                print(f"  No setting matches {c[1:].strip()!r}.")
        elif c.isdigit() and 1 <= int(c) <= len(SECTIONS):
            slug, title, _ = SECTIONS[int(c) - 1]
            listing(st, section_entries(slug), title)
        elif c:
            print(f"  Choose a number from 1 to {len(SECTIONS)}, or / to search, s to save, q to quit.")


# --- saving -------------------------------------------------------------------------------------------------------

def save(st):
    if say_refusal(store.refuse_in_agent_session):
        return
    project_changed = st.project != st.orig_project
    machine_changed = st.machine != st.orig_machine
    if not (project_changed or machine_changed):
        print("  Nothing to save.")
        return
    if project_changed:
        errors, _ = schema.validate_all(st.project)
        old, new = store.dump(st.orig_project, st.indent), store.dump(st.project, st.indent)
        print()
        print(store.unified_diff(old, new, store.PATH).rstrip("\n"))
        flagged = [(k, a, b) for k, a, b in store.changes(st.orig_project, st.project) if k in schema.NEEDS]
        if flagged:
            print("\nThese changes need a review:")
            for key, _, _ in flagged:
                print(f"  {key}: {schema.NEEDS[key]}")
        print(f"\n{schema.DEFAULT_REVIEW}")
        if errors:
            print("\nThese would not pass `factory settings validate`:")
            for e in errors:
                print(f"  {e}")
            if ask("Save anyway? [y/N] ").lower() not in ("y", "yes"):
                return
    if machine_changed:
        print(f"\nThis machine's file {store.machine_path()} (not committed):")
        print(store.unified_diff(store.dump(st.orig_machine), store.dump(st.machine), "machine.json").rstrip("\n"))
        if "agents" in st.machine and st.machine.get("agents") != st.orig_machine.get("agents"):
            from factory_config import load
            from factory_machine import checked_names
            try:
                checked_names(load(), ",".join(st.machine["agents"]), "factory settings --local set agents")
            except SystemExit:
                print("  Not saved: fix the agent names first.")
                return
    if project_changed:
        c = ask("\nSave how? [w] write the file only, [b] branch and pull request, [c] cancel > ").lower()
    else:
        c = ask("\nSave to this machine's file? [w] yes, [c] cancel > ").lower()
    if c == "w":
        write_all(st, project_changed, machine_changed)
        print("Saved." + (f" Commit {store.PATH} on a branch and merge it in a pull request (`factory settings pr` does it)." if project_changed else ""))
        st.orig_project, st.orig_machine = copy.deepcopy(st.project), copy.deepcopy(st.machine)
    elif c == "b" and project_changed:
        kind = ask("Open the pull request as a [d]raft or [r]eady? [D/r] > ").lower()
        write_all(st, True, machine_changed)
        from factory_settings_save import open_pr
        try:
            open_pr(draft=kind not in ("r", "ready"))
        except SystemExit as e:
            print(e.code if isinstance(e.code, str) else "")
            print(f"  {store.PATH} is written here; fix the problem and run `factory settings pr`.")
            return
        st.reload()
    else:
        print("  Not saved.")


def write_all(st, project, machine):
    if project:
        store.write_project(st.project, st.indent)
    if machine:
        store.write_machine(st.machine)


def run():
    st = State()
    print("Browse, explain and change the factory's settings. Nothing is written until you save (s).")
    try:
        main_menu(st)
    except Quit:
        pass
    if st.dirty():
        print("Unsaved changes were discarded.")
