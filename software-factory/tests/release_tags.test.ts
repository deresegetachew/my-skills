// A release starts only from the owner's tag (#337): the release workflow publishes only a tag whose commit is on main
// and whose name matches software-factory/VERSION.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitRepo, ROOT, sh, tmp, write } from "./support.ts";

/** The `run: |` script of the release workflow's step called `name`. */
function step(name: string): string {
  const lines = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  expect(at, name).toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > at && l.trim() === "run: |");
  const indent = (lines[run] as string).search(/\S/);
  const body: string[] = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    body.push(l);
  }
  return body.join("\n");
}

function runStep(name: string, cwd: string, env: Record<string, string>) {
  return sh(["bash", "-e", "-c", step(name)], { cwd, env: { ...process.env, ...env } });
}

test("the release workflow publishes only a tag on main", () => {
  const origin = tmp();
  git(origin, "init", "-q", "--bare", "-b", "main");
  const work = gitRepo();
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  const onMain = git(work, "rev-parse", "HEAD").trim();
  git(work, "checkout", "-q", "-b", "side");
  git(work, "commit", "-q", "--allow-empty", "-m", "not merged");
  const offMain = git(work, "rev-parse", "HEAD").trim();
  const off = runStep("Tag must be on main", work, { TAG: "v1.0.0", GITHUB_SHA: offMain });
  expect(off.code, off.out).not.toBe(0);
  expect(off.out).toContain("is not on main");
  const on = runStep("Tag must be on main", work, { TAG: "v1.0.0", GITHUB_SHA: onMain });
  expect(on.code, on.out).toBe(0);
});

test("the release workflow publishes only the tag software-factory/VERSION names", () => {
  const work = tmp();
  write(join(work, "software-factory", "VERSION"), "1.2.0\n");
  const wrong = runStep("Tag must match the manifest version", work, { TAG: "v1.2.1" });
  expect(wrong.code, wrong.out).not.toBe(0);
  expect(wrong.out).toContain("does not match software-factory/VERSION (v1.2.0)");
  expect(runStep("Tag must match the manifest version", work, { TAG: "v1.2.0" }).code).toBe(0);
});

test("the release workflow checks the tag before it builds or publishes", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const at = (name: string): number => text.indexOf(`- name: ${name}`);
  for (const later of ["Build", "Publish"]) {
    expect(at("Tag must be on main"), later).toBeLessThan(at(later));
    expect(at("Tag must match the manifest version"), later).toBeLessThan(at(later));
  }
});
