"""Execute notebooks in place so their saved outputs (shown in the lessons) are real.

    code/.venv/bin/python code/run_notebooks.py                 # every notebook under code/
    code/.venv/bin/python code/run_notebooks.py path/to/x.ipynb # just these

Each notebook runs top to bottom in its own folder.
A failing cell stops that notebook and the script exits non-zero.

Cells tagged "needs-llm" use Colab's built-in models, which only exist in Colab. They are
skipped here and keep the outputs they already have, e.g. from a Colab run saved back to
GitHub (File → Save a copy in GitHub).
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
    skipped = {}
    for i, cell in enumerate(nb.cells):
        if cell.cell_type == "code" and "needs-llm" in cell.metadata.get("tags", []):
            skipped[i] = (cell.source, cell.outputs, cell.execution_count)
            cell.source = ""                      # run nothing in its place
    client = NotebookClient(nb, timeout=180, kernel_name="python3",
                            resources={"metadata": {"path": str(path.parent)}})
    try:
        client.execute()
    except CellExecutionError as e:
        print(f"✗ {path.relative_to(ROOT)}\n{str(e).splitlines()[-1]}")
        return False
    for i, (source, outputs, count) in skipped.items():
        nb.cells[i].source, nb.cells[i].outputs, nb.cells[i].execution_count = source, outputs, count
    nbformat.write(nb, path)
    note = f" ({len(skipped)} needs-llm cell(s) kept as saved from Colab)" if skipped else ""
    print(f"✓ {path.relative_to(ROOT)}{note}")
    return True


if __name__ == "__main__":
    targets = [Path(a).resolve() for a in sys.argv[1:]] or sorted(
        p for p in ROOT.rglob("*.ipynb") if ".ipynb_checkpoints" not in p.parts and ".venv" not in p.parts)
    results = [run(p) for p in targets]
    sys.exit(0 if all(results) else 1)
