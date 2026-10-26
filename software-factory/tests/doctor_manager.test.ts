// `factory doctor` and the dev manager's settings profile (#172): the note for a missing `.claude/manager/settings.json`
// points at something that works. A project on a release that does not carry the file is told so, and to look for a
// newer release, because `factory update` at that release answers "nothing to install"; a release that does carry it
// is restored by `factory update`; a project with no pin keeps the old advice.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { doctor, machine, project } from "./doctor_support.ts";
import { type Proc, write } from "./support.ts";

const PROFILE = ".claude/manager/settings.json";

function pin(d: string, files: Record<string, string>): void {
  const p = { schema: "factory-pin/1", repo: "acme/factory", tag: "v0.1.0-alpha.1", version: "0.1.0-alpha.1",
    sha256: "0".repeat(64), previous: null, executable: [], files };
  write(join(d, ".claude", "factory", "release.json"), JSON.stringify(p));
}

function managerLines(d: string): [string[], Proc] {
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  return [p.stdout.split("\n").filter((l) => l.includes("manager profile")), p];
}

test("a release without the profile is named and a newer release is suggested", () => {
  const d = project();
  pin(d, { ".claude/hooks/factory_demo.ts": "0".repeat(64) }); // the pinned release lists no manager profile
  const [ls] = managerLines(d);
  expect(ls.length, ls.join("\n")).toBe(1);
  const line = ls[0] as string;
  expect(line.startsWith("note") && line.includes("v0.1.0-alpha.1") && line.includes("doesn't carry"), line).toBe(true);
  expect(line.includes("factory releases") && line.includes("roles.dev-manager.profile"), line).toBe(true);
  expect(line).not.toContain("nothing to install");
});

test("a release that carries the profile is restored by update", () => {
  const d = project();
  pin(d, { [PROFILE]: "0".repeat(64) });
  const [ls] = managerLines(d);
  expect(ls.length, ls.join("\n")).toBe(1);
  const line = ls[0] as string;
  expect(line.startsWith("note") && line.includes("run `factory update`") && !line.includes("doesn't carry"), line).toBe(true);
});

test("a project with no pin keeps the old advice", () => {
  const d = project();
  const [ls] = managerLines(d);
  expect(ls.length, ls.join("\n")).toBe(1);
  const line = ls[0] as string;
  expect(line.startsWith("note") && line.includes("run `factory update`"), line).toBe(true);
});

test("with the profile there all is ok", () => {
  const d = project();
  write(join(d, PROFILE), JSON.stringify({ hooks: {} }));
  const [ls] = managerLines(d);
  expect(ls.length, ls.join("\n")).toBe(1);
  const line = ls[0] as string;
  expect(line.startsWith("ok") && line.includes("resolves"), line).toBe(true);
});
