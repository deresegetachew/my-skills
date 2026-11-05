// Messaging with transport nats (decision 0004 points 1 and 8, #409/#410): the kinds in `messaging.kinds` go over NATS
// and, for their first week, to GitHub too; every other kind stays on GitHub. A read gives both, each message once.
// Here both transports are in memory; plugins/nats/tests runs the real NATS one.
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

test("a kind in messaging.kinds is sent to NATS and to GitHub; any other kind only to GitHub", () => {
  const github = new MemoryMessaging();
  const nats = new MemoryMessaging();
  const port = new RoutedMessaging(github, nats, ["question"]);
  port.send(msg("q1abc", "question"), "Moved?");
  port.send(msg("s1abc", "status"), "Stayed.");
  expect(nats.read(null).messages.map((m) => m.id)).toEqual(["q1abc"]);
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

test("a wake-up in messaging.kinds goes over NATS and is double-sent to GitHub; without it, only GitHub", () => {
  const github = new Recorder();
  const nats = new Recorder();
  new RoutedMessaging(github, nats, ["wake"]).send(msg("w1abc", "wake"), "CI finished.");
  expect(nats.sent).toEqual(["wake w1abc"]);
  expect(github.sent).toEqual(["wake w1abc"]);
  const github2 = new Recorder();
  const nats2 = new Recorder();
  new RoutedMessaging(github2, nats2, ["question"]).send(msg("w2abc", "wake"), "CI finished.");
  expect(nats2.sent).toEqual([]);
  expect(github2.sent).toEqual(["wake w2abc"]);
});

test("a send NATS refuses still goes to GitHub, and the fallback is told", () => {
  const github = new Recorder();
  const down = new Recorder();
  down.send = () => {
    throw new CoreError("nats-unreachable", "The NATS server at nats://x can't be reached.", "Check it.");
  };
  const told: string[] = [];
  new RoutedMessaging(github, down, ["question"], (e) => told.push(e.code)).send(msg("q1abc", "question"), "Still sent?");
  expect(github.sent).toEqual(["question q1abc"]);
  expect(told).toEqual(["nats-unreachable"]);
});

test("a read gives what either transport holds, each message once, and its cursor moves both", () => {
  const github = new MemoryMessaging();
  const nats = new MemoryMessaging();
  const port = new RoutedMessaging(github, nats, ["question"]);
  const start = port.read(null).cursor;
  port.send(msg("q1abc", "question"), "Both?");
  github.send(msg("q2abc", "question"), "Only on GitHub (an older kit)."); // said by a reader that has not moved
  nats.send(msg("q3abc", "question"), "Only on NATS.");
  const got = port.read(start);
  expect(got.messages.map((m) => m.id).sort()).toEqual(["q1abc", "q2abc", "q3abc"]);
  expect(port.read(got.cursor).messages).toEqual([]);
  port.ack("q3abc");
});
