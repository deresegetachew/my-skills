#!/usr/bin/env python3
"""`factory autostart` (#88): the check left in Python until factory_doctor and factory_settings are ported (#252);
everything else is in autostart.test.ts.  python3 software-factory/tests/test_autostart.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
FACTORY = os.path.join(SF, "factory")

sys.path.insert(0, HERE)
import test_doctor as D  # noqa: E402


def test_help_doctor_and_settings_know_about_autostart():
    d = D.project()
    env = D.machine(extra=("tmux",))
    out = subprocess.run(["bash", FACTORY, "help"], cwd=d, env=env, capture_output=True, text=True).stdout
    assert "autostart" in out and "resume" in out, out
    # off: a note that says how to turn it on
    p = D.doctor(d, env)
    assert any("autostart" in l and "factory autostart install" in l for l in D.lines(p, "note")), p.stdout
    # on, but no tmux and no service: fixes that say what to do
    cfg = tempfile.mkdtemp()
    json.dump({"autostart": True, "autostartAgents": ["menelik"]},
              open(os.path.join(cfg, os.path.basename(d) + ".json"), "w"))
    env = {**D.machine(), "FACTORY_CONFIG_DIR": cfg, "FACTORY_AUTOSTART_PLATFORM": "linux"}
    p = D.doctor(d, env)
    fixes = "\n".join(D.lines(p, "fix"))
    assert "tmux" in fixes and "factory autostart install" in fixes, p.stdout
    # settings lists the stack commands and this machine's autostart
    senv = {**os.environ, "FACTORY_CONFIG_DIR": cfg}
    out = subprocess.run(["bash", FACTORY, "settings"], cwd=d, env=senv, capture_output=True, text=True).stdout
    assert "commands.stackUp" in out and "commands.stackHealth" in out, out
    assert "autostart" in out and "autostartAgents" in out, out
    shown = subprocess.run(["bash", FACTORY, "settings", "show", "commands.stackUp"], cwd=d, env=senv,
                           capture_output=True, text=True)
    assert shown.returncode == 0 and "stack" in shown.stdout.lower(), shown


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
