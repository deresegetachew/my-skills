// The TaskTracker port on the message board (#500, decision 0007 point 10) passes the port's contract against a real
// Postgres, and keeps what only the board has: a claim's token on this machine (mode 600), sent with every later write;
// tasks of other projects on the same board left out; a filed task's own board id; a board out of reach said plainly.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { BoardChild } from "../hooks/core/adapters/board/child.ts";
import { BoardTaskTracker } from "../hooks/core/adapters/board/task_tracker.ts";
import { ClaimTokens } from "../hooks/core/adapters/board/tokens.ts";
import type { Task as BoardTask } from "../message-board/src/index.ts";
import { type BoardWorld, boardWorld } from "./board_support.ts";
import { taskTrackerContract } from "./contracts/task_tracker.ts";

setDefaultTimeout(120_000);

let world: BoardWorld;

beforeAll(async () => {
  world = await boardWorld();
}, 600_000);

afterAll(async () => {
  await world?.end();
}, 120_000);

taskTrackerContract("board", (specs) => world.tracker(specs));

const haile = { agent: "haile", machine: "m1" };
const taytu = { agent: "taytu", machine: "m2" };

function onBoard(id: number): BoardTask {
  return world.child.call("system", [{ op: "get", args: [id] }])[0] as BoardTask;
}

function refusal(f: () => unknown): { code: string; message: string; fix: string } {
  try {
    f();
  } catch (e) {
    const x = e as { code: string; message: string; fix: string };
    expect(x.fix.length).toBeGreaterThan(0);
    return { code: x.code, message: x.message, fix: x.fix };
  }
  throw new Error("expected a refusal");
}

test("board: a claim's token is kept on this machine, mode 600, and the release sends it", () => {
  const f = world.tracker([{ title: "One" }]);
  f.port.claim("101", haile);
  expect(onBoard(f.boardIds[0] as number)).toMatchObject({ holder: "haile", status: "in_progress" });
  expect(statSync(f.tokens).mode & 0o777).toBe(0o600);
  const kept = JSON.parse(readFileSync(f.tokens, "utf8")) as Record<string, { agent: string; machine: string; token: string }>;
  expect(kept[String(f.boardIds[0])]).toMatchObject({ agent: "haile", machine: "m1" });
  f.port.release("101", "the run ended");
  expect(onBoard(f.boardIds[0] as number)).toMatchObject({ holder: null, status: "open" });
  expect(JSON.parse(readFileSync(f.tokens, "utf8"))[String(f.boardIds[0])]).toBeUndefined();
});

test("board: in review and done land on the board with the token; done ends the claim", () => {
  const f = world.tracker([{ title: "One" }, { title: "Two" }]);
  expect(f.port.pick(haile).task?.id).toBe("101");
  expect(f.port.setState("101", "in-review")).toContain("101");
  expect(onBoard(f.boardIds[0] as number)).toMatchObject({ holder: "haile", status: "in_review" });
  f.port.setState("101", "done");
  expect(onBoard(f.boardIds[0] as number)).toMatchObject({ holder: null, status: "done", outcome: "done" });
});

test("board: a block says why on the board, as a blocker note, and takes the task out of the queue", () => {
  const f = world.tracker([{ title: "One" }]);
  f.port.claim("101", haile);
  f.port.block("101", "needs the Stripe keys");
  expect(onBoard(f.boardIds[0] as number)).toMatchObject({ holder: null, status: "deferred" });
  const notes = world.child.call("system", [{ op: "contextFor", args: [f.boardIds[0]] }])[0] as { kind: string; body: string }[];
  expect(notes.map((n) => [n.kind, n.body])).toContainEqual(["blocker", "needs the Stripe keys"]);
  expect(f.port.show("101")).toContain("needs the Stripe keys");
});

test("board: a task another agent holds is not released without its token, and nothing changes", () => {
  const f = world.tracker([{ title: "One" }]);
  f.port.claim("101", taytu);
  const other = new BoardTaskTracker({ child: world.child, repo: f.repo, tokens: new ClaimTokens(`${world.dir}/other-machine.json`) });
  const r = refusal(() => other.release("101", "went quiet"));
  expect(r.code).toBe("task-held");
  expect(r.message).toContain("taytu");
  expect(r.fix).toContain("factory board sweep");
  expect(onBoard(f.boardIds[0] as number)).toMatchObject({ holder: "taytu" });
});

test("board: another project's tasks on the same board are not this project's", () => {
  const mine = world.tracker([{ title: "Mine" }]);
  const theirs = world.tracker([{ title: "Theirs" }]);
  expect(mine.port.list().map((t) => t.title)).toEqual(["Mine"]);
  expect(theirs.port.pick(haile).task?.title).toBe("Theirs");
  expect(mine.port.next()?.title).toBe("Mine");
});

test("board: a filed task gets a board id, is this project's, and can be claimed by it", () => {
  const f = world.tracker([]);
  const filed = f.port.file({ title: "Board only", body: "- [ ] one", group: "M1", tags: ["bug"] });
  expect(filed.id).toMatch(/^b\d+$/);
  const t = f.port.list()[0];
  expect([t?.id, t?.title, t?.group, t?.todos.length]).toEqual([filed.id, "Board only", "M1", 1]);
  expect(f.port.claim(filed.id, haile).id).toBe(filed.id);
  expect(onBoard(Number(filed.id.slice(1)))).toMatchObject({ kind: "bug", holder: "haile" });
});

test("board: a board that can't be reached is a refusal with code, message and fix, and no token is written", () => {
  const down = new URL(world.url);
  down.port = "1";
  const tokens = `${world.dir}/down.json`;
  const port = new BoardTaskTracker({ child: new BoardChild({ url: down.toString(), timeoutMs: 15_000 }), repo: "acme/down",
    tokens: new ClaimTokens(tokens) });
  const r = refusal(() => port.pick(haile));
  expect(r.code).toBe("board-unreachable");
  expect(r.fix).toContain("factory board up");
  expect(r.message).not.toContain(new URL(world.url).password);
  expect(existsSync(tokens)).toBe(false);
});
