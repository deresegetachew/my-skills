// `bun tools/run_tests.ts <names>` picks test files by name (#579 review): a bare name, a path or a `.test.ts` name picks
// that file, and a name ending in `*` picks every file it starts. Run the way a person would, on a folder of small test
// files (FACTORY_TEST_DIR, as tests/test_cleanup.test.ts does), reading the files the runner reports.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { BUN, ROOT, sh, tmp, write } from "./support.ts";

function folder(): string {
  const d = tmp();
  for (const n of ["web_ui_attention", "web_ui_attention_board", "web_ui_attention_model", "web_ui_board"]) {
    write(join(d, `${n}.test.ts`), `import { test } from "bun:test";\ntest("ok", () => {});\n`);
  }
  return d;
}

function ran(dir: string, args: string[]): string[] {
  const p = sh([...BUN, "--config=/dev/null", join(ROOT, "tools", "run_tests.ts"), "--jobs", "2", ...args],
    { cwd: ROOT, env: { ...process.env, FACTORY_TEST_DIR: dir }, timeoutMs: 120_000 });
  expect(p.code, p.stdout + p.stderr).toBe(0);
  return [...p.stdout.matchAll(/([\w-]+)\.test\.ts: \d+ passed/g)].map((m) => m[1] as string).sort();
}

test("a name, a path or a .test.ts name picks one file; a name ending in * picks every file it starts", () => {
  const d = folder();
  expect(ran(d, ["web_ui_attention_board"])).toEqual(["web_ui_attention_board"]);
  expect(ran(d, ["software-factory/tests/web_ui_attention_board.test.ts"])).toEqual(["web_ui_attention_board"]);
  expect(ran(d, ["web_ui_attention*"])).toEqual(["web_ui_attention", "web_ui_attention_board", "web_ui_attention_model"]);
  expect(ran(d, [])).toEqual(["web_ui_attention", "web_ui_attention_board", "web_ui_attention_model", "web_ui_board"]);
}, 120_000);
