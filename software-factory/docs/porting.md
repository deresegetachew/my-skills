# Porting a script from Python to Bun (#252)

Temporary: this page goes when no `.py` is left. The epic (#252) is the source of the rules; this is how to apply them.

## The rule

No co-existence: the factory ends with no `.py` file and no `python3` call. The Python files on this branch are only
the reference a port is written from.

A script is ported to the **same path with `.ts`** (`hooks/factory_issues.py` becomes `hooks/factory_issues.ts`), and
its tests are ported **one to one** to `bun test` (`tests/test_issues.py` becomes `tests/issues.test.ts`). Each Python
test has a Bun twin that checks the same thing: the same commands, output, exit codes, files, what a fake `gh` was
asked. Assertions are never weakened, skipped or deleted. Same test names, as sentences
(`test_claim_takes_the_oldest` becomes `test("claim takes the oldest", ...)`).

Scripts are ported in the order of their imports, so a `.ts` only ever imports `.ts`. When a script and its tests
pass in Bun, delete the `.py`, its Python test file and its forwarder link in `kit/.claude/hooks/` (or `kit/.claude/ci/`)
in the same commit. Nothing runs the Python tests any more: the Bun tests are the check.

Behaviour stays the same. Where a change is on purpose (a Python-only quirk), say so in the commit message and in your
report.

## TypeScript

- Strict (see `software-factory/tsconfig.json`), no `any` (`unknown` and narrow it), no `@ts-ignore`.
- Bun and Node built-ins only (`Bun.spawnSync`, `node:fs`, `node:path`, `node:os`, `node:crypto`). No npm package.
- `hooks/factory_lib.ts` has the shared pieces. Use them rather than writing your own:
  - `run(cmd, {cwd, env, input, timeoutMs, inherit})` → `{code, stdout, stderr}`, never throws (subprocess.run).
    `gh(args)`, `git(args)`, `which(prog)`.
  - `die("text")` / `die(2)`: Python's `raise SystemExit("text")` / `SystemExit(2)`. It throws an `Exit`, so a caller
    that caught SystemExit can catch it. `fail(code, message, fix)` for `{code, message, fix}` errors.
  - `runMain(main)`: the entry point. `if (import.meta.main) await runMain(() => main(process.argv.slice(2)));`
  - `pyDumps(value, {indent, sortKeys})`: JSON exactly as Python's `json.dumps` wrote it (`", "`, `": "`, ASCII
    escapes). Use it for anything printed or written that a test, a person or another program compares to the old
    output. Note that Python writes `1.0` for floats where JS writes `1`: handle it where a test sees it.
  - `readJson`, `readText`, `writeAtomic`, `splitLines`, `fnmatch`, `shQuote` (shlex.quote), `shSplit` (shlex.split),
    `now()`, `sleepSync`, `isoUtc`, `parseIso`.
- Names: module file names stay (`factory_config.ts`, `pr-gate.ts`). Functions become camelCase
  (`load_from_main` → `loadFromMain`), constants keep their names (`DEFAULTS`, `ROLE_NAMES`). A module that other
  modules import exports what they use, under those names. Keep the Python docstrings as comments.
- Synchronous like the Python (`Bun.spawnSync`, `readFileSync`) unless the Python was concurrent.
- Imports between scripts are relative with the extension: `import { load } from "./factory_config.ts";`
- An entry script starts with `#!/usr/bin/env -S bun --no-env-file` and has mode 755 (`chmod 755`); a module only
  imported has no shebang and mode 644. `--no-env-file`: Bun would otherwise load the project's `.env`.
- Python's `os.chdir` in `factory_config.load()` is `process.chdir` in the port; keep it.
- Argument parsing: port argparse by hand (a small loop), keeping the same flags, usage text and errors (exit 2 and
  `usage: ...` on stderr where argparse did that and a test or a script relies on it).

## Calls between scripts

Every place that runs a script you port must run the `.ts`:

- Shell (`factory`, `factory-loop.sh`, `ci/ci.sh`, `install.sh`): they call `fh <path-without-extension>`, which runs
  `<path>.ts` with `bun --no-env-file`. Change any line that still says `python3 ... <name>.py`.
- `kit/.claude/settings.json`, `kit/.claude/manager/settings.json`, the agents and skills under `kit/.claude/`:
  `python3 .claude/hooks/<name>.py` becomes `bun --no-env-file .claude/hooks/<name>.ts`.
- `grep -rn "<name>\.py" software-factory tools .github CLAUDE.md README.md .claude --exclude-dir=node_modules`
  before you commit: in code you own, nothing may still run the old file. Prose in docs is updated at the end
  (wave 5), but command lines you see on your way, fix.

## Tests

- `tests/support.ts`: `SF`, `HOOKS`, `KIT`, `runHook(name, args, {cwd, env, input})`, `runBun(path, ...)`,
  `runCode(ts)` (for `python3 -c`), `sh(cmd)`, `tmp()`, `write`, `writeExe`, `git(dir, ...)`, `gitRepo()`,
  `envWith(bin, extra)`, `readmeAndWiki(page)`.
- `tests/fakegh.ts`: the shared stateful fake `gh` (`installFakeGh(dir)`). A test file with its own inline fake `gh`
  (or fake `docker`, `claude`, `tmux`) ports it as a Bun script in a string, starting `#!/usr/bin/env bun`, written
  with `writeExe`. Fakes inside strings are not type-checked; keep them small and plain.
- A Python test that imported a hook in-process imports the `.ts` module the same way.
- Python test files that import helpers from another test file (`from test_roles import ...`): put shared helpers in
  `tests/<topic>_support.ts` (not `*.test.ts`) when two Bun test files need them.
- Run your files: `bun tools/run_tests.ts <name> [<name> ...]`. Before you finish: `bun tools/run_tests.ts` (all Bun
  tests; every one must pass), and `cd software-factory && tsc --noEmit -p tsconfig.json` (no errors).
  `bun tools/check_skills.ts` fails while any `.py` is left on the branch; only its other lines matter until the end.

## This repo's own links

`.claude/hooks/` here holds links into `software-factory/hooks/`. After you add a `.ts` or delete a `.py`, run
`bash software-factory/install.sh . --link --layout new` from the repo root and delete any link left dangling
(`find .claude -xtype l -delete`). The forwarders in `kit/.claude/hooks/` and `kit/.claude/ci/` (symlinks to the
`.py`): delete the one for a `.py` you delete; never add one for a `.ts`.

## Commits

One commit per script family, with its tests, on your branch. The message lists the scripts and tests ported and any
behaviour changed on purpose. End it with:

    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_015CpzC1knNH9iUmWvJmgxUp
