#!/usr/bin/env python3
"""install.sh finds the project's stack on a first install (#199, install side): a project with no package.json and
Python files gets a Python CI workflow and matching `commands.*`; Node keeps the pnpm template; an unknown stack keeps
it too and the output names the file to edit. An existing workflow is never overwritten, and a re-run changes nothing.
  python3 software-factory/tests/test_install_stack.py"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
WORKFLOW = os.path.join(".github", "workflows", "ci.yml")


def project(files):
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q"], cwd=d, check=True)
    for rel, body in files.items():
        os.makedirs(os.path.dirname(os.path.join(d, rel)) or d, exist_ok=True)
        open(os.path.join(d, rel), "w").write(body)
    return d


def install(d):
    p = subprocess.run(["bash", os.path.join(SF, "install.sh"), d], cwd=d, capture_output=True, text=True,
                       env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    assert p.returncode == 0, p
    return p.stdout + p.stderr


def read(d, rel):
    return open(os.path.join(d, rel)).read()


def commands(d):
    return json.loads(read(d, ".claude/factory.json"))["commands"]


UNITTEST = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n"
PLAIN = "def test_a():\n    assert True\n"


def test_a_python_project_with_unittest_tests_gets_the_python_workflow_and_a_test_command():
    d = project({"src/textkit.py": "x = 1\n", "tests/test_textkit.py": UNITTEST})
    out = install(d)
    wf = read(d, WORKFLOW)
    assert "pnpm" not in wf and "setup-python" in wf and "commands" in wf and "Factory guard" in wf, wf
    c = commands(d)
    assert c["test"] == "python3 -m unittest discover -s tests", c
    assert not (c["install"] or c["typecheck"] or c["lint"] or c["build"]), c
    assert "Python" in out and "ci.yml" in out, out
    assert not os.path.exists(os.path.join(d, ".github/workflows/ci-python.yml.template")), "the template itself is not installed"


def test_the_test_command_runs_at_least_one_test_when_tests_has_no_init_file():
    # Python 3.11+: `unittest discover` from the top does not enter a folder without __init__.py (#244)
    for files in ({"tests/test_textkit.py": UNITTEST}, {"tests/unit/test_textkit.py": UNITTEST},
                  {"tests/test_a.py": UNITTEST, "tests/sub/test_b.py": UNITTEST}):
        d = project({"src/textkit.py": "x = 1\n", **files})
        install(d)
        p = subprocess.run(commands(d)["test"], shell=True, cwd=d, capture_output=True, text=True)
        assert p.returncode == 0 and "NO TESTS RAN" not in p.stderr and "Ran 0 tests" not in p.stderr, (files, p)


def test_python_tests_that_are_not_unittest_leave_the_test_command_empty_and_say_so():
    d = project({"tests/test_textkit.py": PLAIN, "pyproject.toml": "[project]\nname='x'\n"})
    out = install(d)
    assert commands(d)["test"] == "", commands(d)
    assert "commands.test" in out and "unittest" in out, out


def test_a_requirements_file_gives_an_install_command():
    d = project({"requirements.txt": "requests\n", "tests/test_a.py": UNITTEST})
    install(d)
    assert commands(d)["install"] == "python3 -m pip install -r requirements.txt", commands(d)


def test_a_node_project_keeps_the_pnpm_template_and_commands():
    d = project({"package.json": "{}\n"})
    out = install(d)
    assert "pnpm/action-setup" in read(d, WORKFLOW)
    assert commands(d)["test"] == "pnpm -s test" and "Python" not in out, (commands(d), out)


def test_an_unknown_stack_keeps_the_pnpm_template_and_names_the_file_to_edit():
    d = project({"main.c": "int main(){return 0;}\n"})
    out = install(d)
    assert "pnpm/action-setup" in read(d, WORKFLOW)
    assert "could not tell" in out and WORKFLOW in out and ".claude/factory.json" in out, out


def test_an_existing_workflow_is_never_overwritten():
    d = project({"tests/test_a.py": UNITTEST, WORKFLOW: "name: mine\n"})
    out = install(d)
    assert read(d, WORKFLOW) == "name: mine\n", read(d, WORKFLOW)
    assert "kept" in out and "ci.yml" in out, out


def test_a_second_run_changes_nothing():
    d = project({"tests/test_a.py": UNITTEST})
    install(d)
    before = (read(d, WORKFLOW), read(d, ".claude/factory.json"))
    install(d)
    assert (read(d, WORKFLOW), read(d, ".claude/factory.json")) == before


def run_cmd(d, name):
    return subprocess.run([sys.executable, os.path.join(SF, "hooks", "factory_stack.py"), "run", name], cwd=d,
                          capture_output=True, text=True)


def test_the_workflow_runs_a_command_from_factory_json_and_an_empty_one_is_a_warning_not_a_failure():
    d = project({".claude/factory.json": json.dumps({"commands": {"test": "exit 3", "install": ""}})})
    assert run_cmd(d, "test").returncode == 3
    p = run_cmd(d, "install")
    assert p.returncode == 0 and "commands.install is empty" in p.stdout, p


def test_the_python_template_is_not_a_workflow_a_release_install_would_add():
    sys.path.insert(0, os.path.join(SF, "hooks"))
    import factory_release as fr
    assert fr.classify("kit/.github/workflows/ci-python.yml.template") is None
    assert fr.classify("kit/.github/workflows/ci.yml") == ("template", ".github/workflows/ci.yml")


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_") and callable(v):
            v()
            print("ok", k)
