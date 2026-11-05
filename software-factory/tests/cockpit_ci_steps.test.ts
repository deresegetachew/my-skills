// How the CI view's keys run their steps (#396): `runSteps` runs each in order under a `$ <command>` line, a step that
// starts with "factory" through the factory command the hook gives, any other as it is, and stops at the first that
// fails, so `factory settings pr` never runs after a failed `factory settings set --stage`.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runSteps } from "../cockpit/views/read.ts";
import { tmp, write } from "./support.ts";

/** A fake `factory` script that logs its words and fails when the words are `settings set ... fail`. */
function fakeFactory(): { cmd: string[]; log: string } {
  const d = tmp();
  const log = join(d, "calls.log");
  const script = write(join(d, "factory"), `#!/usr/bin/env bash
echo "$*" >>"${log}"
echo "factory said: $*"
[ "\${*: -1}" = fail ] && { echo "it failed" >&2; exit 3; }
exit 0
`, 0o755);
  return { cmd: ["bash", script], log };
}

const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

test("runSteps runs each factory step in order through the factory command, each under its command line", async () => {
  const f = fakeFactory();
  const out = await runSteps(f.cmd, [["factory", "settings", "set", "--stage", "ci.light", "false"], ["factory", "settings", "pr"]]);
  expect(calls(f.log)).toEqual(["settings set --stage ci.light false", "settings pr"]);
  expect(out).toContain("$ factory settings set --stage ci.light false\nfactory said: settings set --stage ci.light false");
  expect(out).toContain("$ factory settings pr\nfactory said: settings pr");
});

test("runSteps stops at the first step that fails and shows its exit code", async () => {
  const f = fakeFactory();
  const out = await runSteps(f.cmd, [["factory", "settings", "set", "--stage", "fail"], ["factory", "settings", "pr"]]);
  expect(calls(f.log)).toEqual(["settings set --stage fail"]);
  expect(out).toContain("it failed");
  expect(out).toContain("(exit 3)");
  expect(out).not.toContain("$ factory settings pr");
});

test("runSteps runs a step that is not factory's as it is", async () => {
  const f = fakeFactory();
  const out = await runSteps(f.cmd, [["echo", "gh-like", "step"]]);
  expect(calls(f.log)).toEqual([]);
  expect(out).toBe("$ echo gh-like step\ngh-like step");
});

test("runSteps says a command that can't start could not run, and runs nothing after it", async () => {
  const f = fakeFactory();
  const out = await runSteps(f.cmd, [["/no/such/program-396"], ["factory", "ci", "install"]]);
  expect(out).toContain("It could not run");
  expect(calls(f.log)).toEqual([]);
});
