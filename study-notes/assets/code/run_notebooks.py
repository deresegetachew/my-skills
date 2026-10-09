"""Execute notebooks in place so their saved outputs (shown in the lessons) are real.

    code/.venv/bin/python code/run_notebooks.py                 # every notebook under code/
    code/.venv/bin/python code/run_notebooks.py path/to/x.ipynb # just these

Each notebook runs top to bottom in its own folder (so relative paths like
../../shared/llm.py resolve). A failing cell stops that notebook and the script
exits non-zero, so a broken example never reaches the notes silently.
"""
from __future__ import annotations

import sys
from pathlib import Path

import nbformat
from nbclient import NotebookClient
from nbclient.exceptions import CellExecutionError

ROOT = Path(__file__).resolve().parent


def run(path: Path) -> bool:
    nb = nbformat.read(path, as_version=4)
    client = NotebookClient(nb, timeout=120, kernel_name="python3",
                            resources={"metadata": {"path": str(path.parent)}})
    try:
        client.execute()
    except CellExecutionError as e:
        print(f"✗ {path.relative_to(ROOT)}\n{str(e).splitlines()[-1]}")
        return False
    nbformat.write(nb, path)
    print(f"✓ {path.relative_to(ROOT)}")
    return True


if __name__ == "__main__":
    targets = [Path(a).resolve() for a in sys.argv[1:]] or sorted(
        p for p in ROOT.rglob("*.ipynb") if ".ipynb_checkpoints" not in p.parts and ".venv" not in p.parts)
    results = [run(p) for p in targets]
    sys.exit(0 if all(results) else 1)
