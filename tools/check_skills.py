#!/usr/bin/env python3
"""CI check: every top-level skill folder is well-formed.

- SKILL.md exists, with frontmatter: `name:` matching the folder and a non-empty `description:`.
- Every .sh parses (bash -n), every .py compiles, every .json loads.
- No compiled .pyc file is tracked by git (they are rewritten on every run; .gitignore covers them).
"""
import json, pathlib, py_compile, re, subprocess, sys

root = pathlib.Path(__file__).resolve().parent.parent
errors = []
skills = [d for d in root.iterdir()
          if d.is_dir() and not d.name.startswith('.') and d.name != 'tools']
if not skills:
    errors.append('no skill folders found')
for d in skills:
    md = d / 'SKILL.md'
    if not md.exists():
        errors.append(f'{d.name}: no SKILL.md')
        continue
    m = re.match(r'^---\nname: (\S+)\ndescription: (.+?)\n---\n', md.read_text(), re.S)
    if not m:
        errors.append(f'{d.name}/SKILL.md: frontmatter must be ---\\nname: ...\\ndescription: ...\\n---')
    elif m.group(1) != d.name:
        errors.append(f'{d.name}/SKILL.md: name "{m.group(1)}" must match the folder name')
    elif not m.group(2).strip():
        errors.append(f'{d.name}/SKILL.md: empty description')
for f in root.rglob('*.sh'):
    if '.git' in f.parts: continue
    if subprocess.run(['bash', '-n', str(f)], capture_output=True).returncode:
        errors.append(f'{f.relative_to(root)}: bash -n fails')
for f in root.rglob('*.py'):
    if '.git' in f.parts or f.name == 'check_skills.py': continue
    try: py_compile.compile(str(f), doraise=True)
    except py_compile.PyCompileError as e: errors.append(f'{f.relative_to(root)}: {e.msg}')
for f in root.rglob('*.json'):
    if '.git' in f.parts: continue
    try: json.load(open(f))
    except Exception as e: errors.append(f'{f.relative_to(root)}: invalid JSON: {e}')
tracked = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, text=True)
for name in (tracked.stdout.split('\0') if tracked.returncode == 0 else []):
    if name.endswith('.pyc') or '__pycache__/' in name:
        errors.append(f'{name}: compiled file is tracked; run: git rm --cached {name}')
print('\n'.join(errors) if errors else f'ok: {len(skills)} skills checked')
sys.exit(1 if errors else 0)
