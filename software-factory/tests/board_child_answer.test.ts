// What the factory says when the board's child ends without an answer (#639). The child always prints one JSON line;
// when none comes back (it was cut short, or the child broke), the error says what happened, with the child's stderr,
// and does not call the board out of reach: the calls may have run, so nothing falls back to GitHub on it.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { BoardChild } from "../hooks/core/adapters/board/child.ts";
import { CoreError } from "../hooks/core/domain/error.ts";
import { tmp, write } from "./support.ts";

const dir = tmp("factory-board-child-");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for the board's child: a Bun script with this body. */
function fakeChild(name: string, body: string): BoardChild {
  return new BoardChild({ url: "postgres://u:secret@127.0.0.1:1/board", path: write(join(dir, `${name}.ts`), body), timeoutMs: 15_000 });
}

function refusal(c: BoardChild): CoreError {
  try {
    c.call("haile", [{ op: "tasks", args: [] }]);
  } catch (e) {
    if (e instanceof CoreError) return e;
    throw e;
  }
  throw new Error("the call did not fail");
}

test("a child that exits 0 with no output: the error says it gave no answer, not that the board can't be reached", () => {
  const e = refusal(fakeChild("silent", "await Bun.stdin.text();\nprocess.exit(0);\n"));
  expect(e.code).toBe("board-child-failed");
  expect(e.message).toContain("exited 0");
  expect(e.message).toContain("printed nothing");
  expect(e.message).not.toContain("can't be reached");
  expect(e.fix).toContain("factory board status");
});

test("a child whose answer is cut short: the error says how much came and that the calls may have run", () => {
  const e = refusal(fakeChild("cut", "await Bun.stdin.text();\nprocess.stdout.write('{\"ok\":true,\"results\":[\"abc');\nprocess.exit(0);\n"));
  expect(e.code).toBe("board-child-failed");
  expect(e.message).toContain("exited 0");
  expect(e.message).toContain("printed 26 bytes");
  expect(e.message).toContain("may have run");
});

test("the child's stderr is in the message, and the URL's password never is", () => {
  const e = refusal(fakeChild("noisy", "await Bun.stdin.text();\nconsole.error('error: postgres://u:secret@127.0.0.1:1/board refused');\nprocess.exit(0);\n"));
  expect(e.code).toBe("board-child-failed");
  expect(e.message).toContain("refused");
  expect(e.message).not.toContain("secret");
});

test("a child that crashes (exit 1) says its exit code and its stderr", () => {
  const e = refusal(fakeChild("crash", "await Bun.stdin.text();\nthrow new Error('boom in the child');\n"));
  expect(e.code).toBe("board-child-failed");
  expect(e.message).toContain("exited 1");
  expect(e.message).toContain("boom in the child");
});

test("a child that answers is still read as before", () => {
  const c = fakeChild("fine", "await Bun.stdin.text();\nconsole.log(JSON.stringify({ ok: true, results: [42] }));\n");
  expect(c.call("haile", [{ op: "tasks", args: [] }])).toEqual([42]);
});
