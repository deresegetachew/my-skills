// The Messaging port on the message board (#500, decision 0007 point 10) passes the port's contract against a real
// Postgres, and a message sent is on the board as its sender said it, where the web UI and `factory board` read it.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Message } from "../hooks/core/domain/message.ts";
import type { Message as BoardMessage } from "../message-board/src/index.ts";
import { type BoardWorld, boardWorld } from "./board_support.ts";
import { messagingContract } from "./contracts/messaging.ts";

setDefaultTimeout(120_000);

let world: BoardWorld;

beforeAll(async () => {
  world = await boardWorld();
}, 600_000);

afterAll(async () => {
  await world?.end();
}, 120_000);

messagingContract("board", () => world.messaging());

test("board: a sent message is on the board, from its sender, to its addressee, with the board's kind", () => {
  const { port, ref } = world.messaging();
  const before = (world.child.call("system", [{ op: "messages", args: [] }])[0] as { cursor: number }).cursor;
  port.send(new Message({ id: "q9abc", kind: "question", frm: "haile", to: "po", state: "submitted", ref }), "Which colour?");
  port.send(new Message({ id: "m9abc", kind: "mustfix", frm: "dev-manager", to: "haile", state: "submitted", ref: "pr#7" }), "Fix the test.");
  const got = (world.child.call("system", [{ op: "messages", args: [{ after: before }] }])[0] as { messages: BoardMessage[] }).messages;
  expect(got.map((m) => [m.from, m.to, m.kind, m.state])).toEqual([["haile", "po", "question", "open"], ["dev-manager", "haile", "verdict", "closed"]]);
  expect(got[0]?.body).toContain("Which colour?");
  expect(got[0]?.body).toContain("id=q9abc");
});
