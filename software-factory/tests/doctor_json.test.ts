// `factory doctor --json` (#455): the same checks as the text, as JSON, each in its group (this machine, the project,
// the board, GitHub, CI runners), for the web UI's Health page. The text output stays as it was.
import { expect, test } from "bun:test";
import { doctor, lines, machine, project } from "./doctor_support.ts";

interface Check { group: string; level: string; what: string; how: string }
interface Out { ok: boolean; fixes: number; checks: Check[] }

const GROUPS = ["machine", "project", "board", "github", "ci"];

test("--json gives every check the text gives, each with its group, level and fix", () => {
  const ci = ["name: CI", "on: [pull_request]", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:",
    "      - run: bun --no-env-file .claude/hooks/no_such_hook.ts", ""].join("\n");
  const d = project({ ".github/workflows/ci.yml": ci });
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  const text = doctor(d, env);
  const json = doctor(d, env, "--json");
  expect(json.code, json.out).toBe(text.code); // exit 1 with a fix, in both forms
  const out = JSON.parse(json.stdout) as Out;
  expect(out.ok).toBe(false);
  expect(out.fixes).toBe(lines(text, "fix").length);
  for (const level of ["ok", "fix", "note"]) {
    expect(out.checks.filter((c) => c.level === level).length, level).toBe(lines(text, level).length);
  }
  for (const c of out.checks) expect(GROUPS, JSON.stringify(c)).toContain(c.group);
  const hook = out.checks.find((c) => c.what.includes("no_such_hook.ts"));
  expect(hook).toMatchObject({ group: "ci", level: "fix" });
  expect(hook?.how).toContain("CI calls a hook script that is not in .claude/hooks");
  expect(out.checks.find((c) => c.what === "git")).toMatchObject({ group: "machine", level: "ok", how: "" });
  expect(out.checks.find((c) => c.what === "gh is signed in")).toMatchObject({ group: "github", level: "ok" });
  expect(out.checks.some((c) => c.group === "project" && c.what.startsWith(".claude/factory/settings.json"))).toBe(true);
  // nothing but the JSON on stdout
  expect(json.stdout.trim().startsWith("{")).toBe(true);
  expect(json.stdout).not.toContain("to fix.");
}, 60_000);

test("the text output is unchanged by the JSON form: same lines, same summary", () => {
  const d = project();
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.trim().split("\n").at(-1)).toBe("All the checks pass.");
  expect(p.stdout).not.toContain('"checks"');
  for (const l of p.stdout.split("\n").filter(Boolean).slice(0, -1)) expect(l, l).toMatch(/^(ok {4}|fix {3}|note {2})\S/);
}, 60_000);

test("--json on a clean machine is ok with no fix", () => {
  const d = project();
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" }, "--json");
  expect(p.code, p.out).toBe(0);
  const out = JSON.parse(p.stdout) as Out;
  expect(out).toMatchObject({ ok: true, fixes: 0 });
  expect(out.checks.length).toBeGreaterThan(3);
}, 60_000);
