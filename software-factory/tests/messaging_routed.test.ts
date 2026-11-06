// Messaging with transport board (#409/#410, #500): the kinds in `messaging.kinds` go to the message board and, for
// their first week, to GitHub too; every other kind stays on GitHub. A read gives both, each message once.
// Here both transports are in memory; board_mode.test.ts runs the real board.
import { expect, test } from "bun:test";
import { MemoryMessaging } from "../hooks/core/adapters/memory/messaging.ts";
import { RoutedMessaging } from "../hooks/core/adapters/routed/messaging.ts";
import { CoreError } from "../hooks/core/domain/error.ts";
import { Message } from "../hooks/core/domain/message.ts";
import { messagingContract } from "./contracts/messaging.ts";

messagingContract("routed, question moved", () => ({ port: new RoutedMessaging(new MemoryMessaging(), new MemoryMessaging(), ["question"]),
  ref: "issue#5", other: "pr#7" }));
messagingContract("routed, nothing moved", () => ({ port: new RoutedMessaging(new MemoryMessaging(), new MemoryMessaging(), []),
  ref: "issue#5", other: "pr#7" }));

const msg = (id: string, kind: string): Message =>
  new Message({ id, kind, frm: "haile", to: "dev-manager", state: kind === "answer" ? "completed" : "submitted", ref: "pr#3" });

test("a kind in messaging.kinds is sent to the board and to GitHub; any other kind only to GitHub", () => {
  const github = new MemoryMessaging();
  const board = new MemoryMessaging();
  const port = new RoutedMessaging(github, board, ["question"]);
  port.send(msg("q1abc", "question"), "Moved?");
  port.send(msg("s1abc", "status"), "Stayed.");
  expect(board.read(null).messages.map((m) => m.id)).toEqual(["q1abc"]);
  expect(github.read(null).messages.map((m) => m.id)).toEqual(["q1abc", "s1abc"]);
});

/** A transport that only records what it was handed. */
class Recorder extends MemoryMessaging {
  sent: string[] = [];
  override send(m: Message, text: string): Message {
    this.sent.push(`${m.kind} ${m.id}`);
    return super.send(m, text);
  }
}

test("a wake-up in messaging.kinds goes to the board and is double-sent to GitHub; without it, only GitHub", () => {
  const github = new Recorder();
  const board = new Recorder();
  new RoutedMessaging(github, board, ["wake"]).send(msg("w1abc", "wake"), "CI finished.");
  expect(board.sent).toEqual(["wake w1abc"]);
  expect(github.sent).toEqual(["wake w1abc"]);
  const github2 = new Recorder();
  const board2 = new Recorder();
  new RoutedMessaging(github2, board2, ["question"]).send(msg("w2abc", "wake"), "CI finished.");
  expect(board2.sent).toEqual([]);
  expect(github2.sent).toEqual(["wake w2abc"]);
});

test("a send the board refuses still goes to GitHub, and the fallback is told", () => {
  const github = new Recorder();
  const down = new Recorder();
  down.send = () => {
    throw new CoreError("board-unreachable", "The message board can't be reached.", "Check it.");
  };
  const told: string[] = [];
  new RoutedMessaging(github, down, ["question"], (e) => told.push(e.code)).send(msg("q1abc", "question"), "Still sent?");
  expect(github.sent).toEqual(["question q1abc"]);
  expect(told).toEqual(["board-unreachable"]);
});

test("a read gives what either transport holds, each message once, and its cursor moves both", () => {
  const github = new MemoryMessaging();
  const board = new MemoryMessaging();
  const port = new RoutedMessaging(github, board, ["question"]);
  const start = port.read(null).cursor;
  port.send(msg("q1abc", "question"), "Both?");
  github.send(msg("q2abc", "question"), "Only on GitHub (an older kit)."); // said by a reader that has not moved
  board.send(msg("q3abc", "question"), "Only on the board.");
  const got = port.read(start);
  expect(got.messages.map((m) => m.id).sort()).toEqual(["q1abc", "q2abc", "q3abc"]);
  expect(port.read(got.cursor).messages).toEqual([]);
  port.ack("q3abc");
});
