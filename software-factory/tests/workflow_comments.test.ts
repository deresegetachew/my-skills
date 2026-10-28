// A hook named in a YAML comment of a CI workflow is not a step that runs it (#278): remanual's ci.yml says
// `# The factory guard (.claude/hooks/factory_guard.py): ...` above the step, and `factory doctor` named it as a call
// to a removed Python hook. Neither doctor nor `factory update`'s workflow rewrite looks at comments.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { doctor, lines, machine, project } from "./doctor_support.ts";
import { commit, fac, world } from "./release_support.ts";

const CI = ["name: CI", "on: [pull_request]", "jobs:",
  "  guard:", "    runs-on: ubuntu-latest", "    steps:",
  "      - uses: actions/checkout@v4",
  "      # The factory guard (.claude/hooks/factory_guard.py): it was python3 .claude/hooks/factory_guard.py before #252",
  "      - uses: oven-sh/setup-bun@v2",
  "      - run: bun --no-env-file --config=/dev/null .claude/hooks/factory_guard.ts --base main  # not .claude/hooks/gone.py",
  ""].join("\n");

test("doctor ignores a hook named in a workflow comment", () => {
  const d = project({ ".github/workflows/ci.yml": CI });
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "fix").filter((l) => l.includes(".github/workflows")), p.stdout).toEqual([]);
  expect(lines(p, "ok").some((l) => l.includes("CI workflows")), p.stdout).toBe(true);
});

test("doctor still names a removed hook a step calls", () => {
  const d = project({ ".github/workflows/ci.yml": CI.replace("factory_guard.ts --base", "factory_gone.ts --base") });
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "fix").join("\n"), p.stdout).toContain(".github/workflows/ci.yml: .claude/hooks/factory_gone.ts");
  expect(lines(p, "fix").join("\n"), p.stdout).not.toContain("factory_guard.py");
});

test("update leaves a workflow comment that names a python hook as it is", async () => {
  const [gh, d, env] = await world();
  gh.add("0.1.0", { date: "2026-10-01T10:00:00Z", files: { "hooks/factory_x.ts": null, "hooks/factory_x.py": "X = 1\n",
    "kit/.claude/factory/settings.json": null } });
  expect((await fac(d, env, "update", "v0.1.0"))[0]).toBe(0);
  const ci = join(d, ".github/workflows/ci.yml");
  mkdirSync(dirname(ci), { recursive: true });
  const text = ["name: CI", "jobs:", "  docs:", "    runs-on: ubuntu-latest", "    steps:",
    "      # we used to run python3 .claude/hooks/factory_x.py here", "      - run: echo hi", ""].join("\n");
  writeFileSync(ci, text);
  commit(d, "on the python release");
  gh.add("0.2.0", { date: "2026-11-01T10:00:00Z" });
  const [rc, out] = await fac(d, env, "update", "v0.2.0");
  expect(rc, out).toBe(0);
  expect(readFileSync(ci, "utf8"), "no rewrite and no Bun setup step for a comment").toBe(text);
  expect(out).not.toContain("Changed .github");
});
