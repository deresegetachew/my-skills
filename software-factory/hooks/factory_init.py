#!/usr/bin/env python3
"""`factory init` (#103): the project's own scaffold, after `install.sh` has put the kit in the folder.

  factory init [--dry-run]

Makes what is missing, and says what it made (running it again adds nothing and posts nothing twice):
  - the role folders and their reads.md (`factory init-roles`)
  - the labels the factory uses (`factory issues setup`)
  - the owner queue issue, "Dev manager: needs the owner", where the roles ask the owner (stage approvals too)
  - a starter PRD at the `prd` path, with the story format `factory prd` reads
  - the pull request template for a PRD change (`.github/PULL_REQUEST_TEMPLATE/prd-change.md`; `install.sh` adds it too)
It never overwrites a file. Then it prints the next steps from an empty folder to a first milestone. Needs `gh` signed in.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402
import factory_roles  # noqa: E402
from factory_config import load, roles_dir  # noqa: E402

PRD_STUB = """# Product requirements

## Vision

<!-- Who it is for, what they can do that they could not, and why now. A short paragraph. -->

## Users

## User stories

<!-- One line each, numbered once and never reused: `- US-1: <what the person can do>`. Tasks say `PRD: US-1`. -->

- US-1: 

## Rules that must never break

## Out of scope
"""
PR_TEMPLATE = os.path.join(".github", "PULL_REQUEST_TEMPLATE", "prd-change.md")
PR_TEXT = """## What changes in the PRD

<!-- Why now (the user need or what the sign-off and testing queue showed), in two or three lines. Never a number you did not read from `factory prd`, the usage log or a test result. -->

## Stories this touches

<!-- One line each: added, changed, removed or split. Keep the numbers (US-<n>); a removed story keeps its number. -->

- 

## Tasks that move

<!-- One line each, with the issue number: added (new issue), changed (what in "Done when"), frozen (`factory-hold`) or closed as not planned. Running agents pick this up from the issues, so say it here and in the issue. -->

- 

## Decision record

<!-- The new file in docs/decisions/ (take the next free number on main and in open PRs), or "none: nothing to decide". -->

## Owner's yes

<!-- Scope and order are the owner's. Link the owner-queue reply or say who agreed and where. -->

- [ ] The owner agreed to this scope and order
- [ ] `factory prd` run after the change: no story used twice, no task naming a missing story
"""  # the same text as kit/.github/PULL_REQUEST_TEMPLATE/prd-change.md (a test checks)

NEXT = """Next, from here to a first milestone (each gate is the owner's yes):
  1. factory product-owner loop -i        the product owner interviews you and writes the vision and the PRD
  2. factory prd --stage --ask vision      then design, then plan: `factory prd --stage` shows where you are
  3. factory dev-manager loop              the orchestrator and its sub-managers, once the plan is approved
  4. factory coding-agent loop             the builders take the ready tasks
Change direction later with a pull request from the PRD-change template; `factory prd` shows what moves."""


def write_once(path, text, dry):
    if os.path.exists(path):
        return f"exists   {path}"
    if not dry:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    return f"{'would add' if dry else 'added   '} {path}"


def init(cfg, dry=False):
    import factory_orchestrator as orch
    out = []
    for role in factory_roles.ROLE_NAMES:
        folder = os.path.join(roles_dir(cfg), role)
        for name in ("README.md", "reads.md"):
            if os.path.exists(os.path.join(folder, name)):
                continue
            if dry:
                out.append(f"would add {os.path.join(folder, name)}")
    if not dry:
        out += [f"added    {p}" for p in factory_roles.init(cfg)]
    elif not out:
        out.append(f"exists   {roles_dir(cfg)}/ (the role folders)")
    have = {x["name"] for x in fi.gh_all("repos/{owner}/{repo}/labels")}
    labels = fi.setup_labels(cfg) if not dry else None
    if dry:
        out.append("would create the factory labels that are missing" if have else "would create the factory labels")
    else:
        out.append(f"created  {len(labels)} labels" if labels else "exists   the factory labels")
    queue = orch.owner_queue(cfg, create=False)
    if queue:
        out.append(f"exists   owner queue #{queue}")
    elif dry:
        out.append("would make the owner queue issue")
    else:
        out.append(f"made     owner queue #{orch.owner_queue(cfg, create=True)}")
    out.append(write_once(cfg.get("prd") or "docs/PRD.md", PRD_STUB, dry))
    out.append(write_once(PR_TEMPLATE, PR_TEXT, dry))
    return out


def main(argv=None):
    a = argv if argv is not None else sys.argv[1:]
    if any(x not in ("--dry-run",) for x in a):
        sys.exit(__doc__)
    cfg = load()
    print("\n".join(init(cfg, "--dry-run" in a)))
    print("\n" + NEXT)


if __name__ == "__main__":
    main()
