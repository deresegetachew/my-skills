#!/usr/bin/env python3
"""The `models` setting: which model (and effort) each factory role runs on (#94).

  "models": {"builder": {"model": "opus", "effort": "high"}, "manager": {"model": "sonnet"},
             "reviewer": {"model": "sonnet", "escalateTo": "opus"}, "test-writer": {"model": "haiku"}}

No entry for a role = today's behaviour: a subagent keeps the `model:` in its agent file, and the builder and the
manager keep Claude Code's own default. Nothing changes until a project sets a value.

How a value reaches Claude Code (the spike, #94):
  - builder, manager: `claude --model <m> --effort <e>`.
  - subagents: `claude --agents <json>` redefines the agent of that name for the session, and beats the project's
    `.claude/agents/<name>.md` (a symlink into the kit, which stays untouched). It replaces the whole definition, so the
    JSON carries the file's own prompt, tools and description with only `model` changed. The env var
    CLAUDE_CODE_SUBAGENT_MODEL does not do it: it loses to the file's `model:`, and with
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 it forces ONE model on every subagent, not one per role.

  python3 .claude/hooks/factory_models.py flags <role>      one argument per line, for factory-loop.sh and `factory agent`
  python3 .claude/hooks/factory_models.py table             the effective model per role and what set it (factory doctor)
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SUBAGENTS = ("test-writer", "reviewer", "architecture-reviewer", "safety-auditor", "security-reviewer")
ROLES = ("builder", "manager") + SUBAGENTS
EFFORTS = ("low", "medium", "high", "xhigh", "max")
WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:\[\]@/-]*")  # an alias or a full id; never an option-looking word
AGENTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agents")


def check_name(role, field, value):
    if not isinstance(value, str) or not WORD.fullmatch(value):
        raise ValueError(f"models.{role}.{field} must be a model name such as sonnet, opus or a full model id; got {value!r}.")


def validate(models):
    """The setting's value, or ValueError saying what is wrong and what to do."""
    if not isinstance(models, dict):
        raise ValueError('models takes an object: {"builder": {"model": "opus"}}.')
    for role, entry in models.items():
        if role not in ROLES:
            raise ValueError(f"models.{role}: not a role. Roles: {', '.join(ROLES)}.")
        if not isinstance(entry, dict):
            raise ValueError(f'models.{role} takes an object, e.g. {{"model": "sonnet"}}.')
        allowed = {"model", "effort"} if role in ("builder", "manager") else {"model"}
        if role == "reviewer":
            allowed = {"model", "escalateTo"}
        for field in entry:
            if field not in allowed:
                raise ValueError(f"models.{role}.{field}: not a field of {role}. Fields: {', '.join(sorted(allowed))}.")
        if entry and "model" not in entry and "escalateTo" not in entry:
            raise ValueError(f"models.{role} needs a model.")
        if "model" in entry:
            check_name(role, "model", entry["model"])
        if "escalateTo" in entry:
            check_name(role, "escalateTo", entry["escalateTo"])
        if "effort" in entry and entry["effort"] not in EFFORTS:
            raise ValueError(f"models.{role}.effort takes one of {', '.join(EFFORTS)}; got {entry['effort']!r}.")
    return models


def configured():
    from factory_config import load
    return validate(load().get("models", {}))


def frontmatter(role):
    """(fields, body) of a kit agent file, or None when the project has no such file."""
    try:
        text = open(os.path.join(AGENTS_DIR, f"{role}.md")).read()
    except OSError:
        return None
    m = re.match(r"---\n(.*?)\n---\n(.*)", text, re.S)
    if not m:
        return None
    fields = {k.strip(): v.strip() for k, v in (l.split(":", 1) for l in m.group(1).splitlines() if ":" in l)}
    return fields, m.group(2)


def agent_flags(models):
    """`--agents <json>`: the agents whose model the project sets, with their own prompt, tools and description."""
    out = {}
    for role in SUBAGENTS:
        model = models.get(role, {}).get("model")
        parsed = frontmatter(role) if model else None
        if not parsed:
            continue
        fields, body = parsed
        agent = {"description": fields.get("description", ""), "prompt": body.lstrip("\n"), "model": model}
        if fields.get("tools"):
            agent["tools"] = [t.strip() for t in fields["tools"].split(",") if t.strip()]
        out[role] = agent
    return ["--agents", json.dumps(out, separators=(",", ":"), ensure_ascii=False)] if out else []


def flags(role, models):
    """The `claude` arguments for a session of this role. Empty when the project sets nothing."""
    entry = models.get(role, {}) if role in ("builder", "manager") else {}
    args = []
    if entry.get("model"):
        args += ["--model", entry["model"]]
    if entry.get("effort"):
        args += ["--effort", entry["effort"]]
    # Subagents are started by the builder and the manager sessions, so these carry the subagent settings.
    return args + agent_flags(models)


def table(models):
    """(role, model, source) per role."""
    rows = []
    for role in ROLES:
        model = models.get(role, {}).get("model")
        if model:
            rows.append((role, model, "setting `models` in .claude/factory.json"))
        elif role in SUBAGENTS:
            parsed = frontmatter(role)
            fm = (parsed[0].get("model") if parsed else None)
            rows.append((role, fm or "(no model:)", "agent file" if fm else "Claude Code default"))
        else:
            rows.append((role, "Claude Code default", "Claude Code default"))
    return rows


def main(argv):
    try:
        models = configured()
    except ValueError as e:
        print(f"factory: {e} Fix it with `factory settings set models '<json>'`.", file=sys.stderr)
        return 1
    if argv[:1] == ["flags"] and len(argv) == 2 and argv[1] in ("builder", "manager"):
        args = flags(argv[1], models)
        if args:
            print("\n".join(args))
        return 0
    if argv[:1] == ["table"]:
        for role, model, source in table(models):
            print(f"{role:22} {model:22} {source}")
        return 0
    print("usage: factory_models.py flags builder|manager | table", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
