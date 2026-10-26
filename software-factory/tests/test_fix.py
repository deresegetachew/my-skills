#!/usr/bin/env python3
"""Auto-format and auto-fix the changed files before the checks (#69): `commands.fix` runs on the files this branch
changed and no others, the agent hears one line, the Stop check and `factory verify` run it first.
Ported to fix.test.ts (#252); this case stays until factory_settings is ported.
  python3 software-factory/tests/test_fix.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t"}
for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE", "CLAUDE_PROJECT_DIR"):
    ENV.pop(var, None)

def test_the_fix_settings_are_listed_in_the_template_and_the_registry():
    tpl = json.load(open(os.path.join(SF, "kit", ".claude", "factory.json")))
    assert tpl["commands"]["fix"] == "" and tpl["fixPaths"] == []
    out = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_settings.py")], cwd=tempfile.mkdtemp(),
                         capture_output=True, text=True, env=ENV).stdout
    assert "commands.fix" in out and "fixPaths" in out
