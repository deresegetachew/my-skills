// A first release install makes the tasks choice visible and one step (#245): `factory update vX --tasks plan|issues`
// writes tasks.source into the install's factory.json, and without the flag the install prints where the tasks come from
// and how to change it. It never runs `factory issues setup` (that writes to GitHub).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commit, fac, snapshot, stackWorld, UNITTEST_TESTS } from "./release_support.ts";
import { readmeAndWiki, SF, sh } from "./support.ts";

const LINE = "Tasks: from the build plan (docs/build-plan.md). For GitHub issues: run again with --tasks issues, or " +
  "`factory settings set tasks.source issues`, then `factory issues setup` for the labels.";

const cfg = (d: string): Record<string, Record<string, string>> =>
  JSON.parse(readFileSync(join(d, ".claude/factory.json"), "utf8")) as Record<string, Record<string, string>>;
const source = (d: string): string => cfg(d).tasks?.source ?? "plan";

test("without the flag the install says where tasks come from and how to change it", async () => {
  const [, d, env] = await stackWorld({ "package.json": "{}\n" });
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc, out).toBe(0);
  expect(out).toContain(LINE);
  expect(source(d)).toBe("plan");
});

test("tasks issues writes the setting and names the next step without running it", async () => {
  const [gh, d, env] = await stackWorld({ "package.json": "{}\n" });
  const [rc, out] = await fac(d, env, "update", "v1.0.0", "--tasks", "issues");
  expect(rc, out).toBe(0);
  expect(source(d)).toBe("issues");
  expect(out.includes("Tasks: from GitHub issues") && out.includes("`factory issues setup`") && !out.includes(LINE), out).toBe(true);
  expect(out.includes("does not run it") || out.includes("not run"), out).toBe(true);
  expect(gh.hits.length > 0 && gh.hits.every((h) => h.includes("/releases") || h.startsWith("/dl/")),
    "only release downloads, nothing written to GitHub").toBe(true);
});

test("tasks issues also works in a python project", async () => {
  const [, d, env] = await stackWorld({ "tests/test_a.py": UNITTEST_TESTS });
  const [rc, out] = await fac(d, env, "update", "v1.0.0", "--tasks", "issues");
  expect(rc, out).toBe(0);
  const c = cfg(d);
  expect(c.tasks?.source).toBe("issues");
  expect(c.commands?.test).toBe("python3 -m unittest discover -s tests"); // #244: the folder the tests are in
});

test("tasks plan is written explicitly", async () => {
  const [, d, env] = await stackWorld({ "package.json": "{}\n" });
  const [rc, out] = await fac(d, env, "update", "v1.0.0", "--tasks", "plan");
  expect(rc, out).toBe(0);
  expect(cfg(d).tasks?.source).toBe("plan");
  expect(out).toContain("Tasks: from the build plan");
});

test("a wrong value is code message fix and changes nothing", async () => {
  const [gh, d, env] = await stackWorld({ "package.json": "{}\n" });
  const before = snapshot(d);
  const [rc, out] = await fac(d, env, "update", "v1.0.0", "--tasks", "jira");
  expect(rc === 1 && out.includes("[bad_tasks]") && out.includes("Fix:") && out.includes("plan") && out.includes("issues"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
  expect(gh.hits).toEqual([]);
});

test("a later update keeps the choice and prints no tasks line", async () => {
  const [gh, d, env] = await stackWorld({ "package.json": "{}\n" });
  expect((await fac(d, env, "update", "v1.0.0", "--tasks", "issues"))[0]).toBe(0);
  commit(d, "install");
  gh.add("1.1.0");
  const [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(source(d) === "issues" && !out.includes("Tasks:"), out).toBe(true);
});

test("help and readme mention the flag", () => {
  const helped = sh(["bash", join(SF, "factory"), "help"]).stdout;
  expect(helped).toContain("--tasks");
  const row = readmeAndWiki().split("\n").find((l) => l.startsWith("| `factory update [version]`"));
  expect(row).toContain("--tasks");
});
