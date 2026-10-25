#!/usr/bin/env python3
"""CI: run every style `check` command from .claude/factory.json (`styles[].check`), once each.

Exit 1 if any fails. With no styles, prints that and passes.
"""
import os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402

cfg = load()
checks = []
for style in cfg.get("styles", []):
    c = style.get("check")
    if c and c not in checks:
        checks.append(c)
if not checks:
    print("no style checks configured")
    sys.exit(0)
failed = False
for c in checks:
    print(f"$ {c}", flush=True)
    if subprocess.run(c, shell=True).returncode != 0:
        failed = True
sys.exit(1 if failed else 0)
