// The Messaging port's contract (decision 0003, #376). Every adapter passes it: the in-memory one
// (messaging_memory.test.ts) and the GitHub one against the fake `gh` (messaging_github.test.ts). Not a test file:
// those files call messagingContract with a way to make a fresh port.
import { expect, test } from "bun:test";
import { Message } from "../../hooks/core/domain/message.ts";
import type { Messaging } from "../../hooks/core/ports/messaging.ts";

/** A fresh port with two open threads to send to, and nothing said in them yet. */
export interface Fixture {
  port: Messaging;
  ref: string; // issue#<n> or pr#<n>
  other: string;
}

function question(id: string, ref: string): Message {
  return new Message({ id, kind: "question", frm: "haile", to: "po", state: "submitted", ref });
}

const ids = (messages: Message[]): string[] => messages.map((m) => m.id);

/** What a refusal carries: the {code, message, fix} every factory error has. */
function refusal(f: () => unknown): { code: string; message: string; fix: string } {
  try {
    f();
  } catch (e) {
    const { code, fix } = e as { code?: unknown; fix?: unknown };
    expect(typeof code).toBe("string");
    expect(typeof fix).toBe("string");
    expect((e as Error).message).toBeTruthy();
    return { code: code as string, message: (e as Error).message, fix: fix as string };
  }
  throw new Error("expected an error with code, message and fix");
}

export function messagingContract(name: string, make: () => Fixture): void {
  test(`${name}: nothing said yet reads nothing and still gives a cursor`, () => {
    const { port } = make();
    const got = port.read(null);
    expect(got.messages).toEqual([]);
    expect(typeof got.cursor).toBe("string");
    expect(port.read(got.cursor).messages).toEqual([]);
  });

  test(`${name}: a sent message is read once after its cursor`, () => {
    const { port, ref } = make();
    const before = port.read(null).cursor;
    port.send(question("q1abc", ref), "Which colour?");
    const first = port.read(before);
    expect(ids(first.messages)).toEqual(["q1abc"]);
    expect(port.read(first.cursor).messages).toEqual([]);
  });

  test(`${name}: a cursor from before any message reads every later one, in order`, () => {
    const { port, ref } = make();
    const start = port.read(null).cursor;
    port.send(question("q1abc", ref), "First?");
    port.send(question("q2abc", ref), "Second?");
    port.send(question("q3abc", ref), "Third?");
    expect(ids(port.read(start).messages)).toEqual(["q1abc", "q2abc", "q3abc"]);
    expect(ids(port.read(null).messages)).toEqual(["q1abc", "q2abc", "q3abc"]); // no cursor: everything
  });

  test(`${name}: a cursor past the last message reads nothing until something new is sent`, () => {
    const { port, ref } = make();
    port.send(question("q1abc", ref), "First?");
    const end = port.read(null).cursor;
    expect(port.read(end).messages).toEqual([]);
    expect(port.read(end).messages).toEqual([]); // reading again does not move it
    port.send(question("q2abc", ref), "Second?");
    expect(ids(port.read(end).messages)).toEqual(["q2abc"]);
  });

  test(`${name}: a message sent twice with one id is read once`, () => {
    const { port, ref } = make();
    const start = port.read(null).cursor;
    port.send(question("q1abc", ref), "Which colour?");
    port.send(question("q1abc", ref), "Which colour?");
    expect(ids(port.read(start).messages)).toEqual(["q1abc"]);
  });

  test(`${name}: what is read is the message that was sent, in the thread it went to`, () => {
    const { port, ref } = make();
    const start = port.read(null).cursor;
    const sha = "a".repeat(40);
    port.send(new Message({ id: "s1abc", kind: "status", frm: "haile", to: "po", state: "working", ref,
      inReplyTo: "q1abc", sha }), "On it.\nMore text.");
    const [m] = port.read(start).messages;
    expect(m).toBeDefined();
    const got = m as Message;
    expect([got.id, got.kind, got.frm, got.to, got.state, got.ref, got.inReplyTo, got.sha, got.summary, got.thread])
      .toEqual(["s1abc", "status", "haile", "po", "working", ref, "q1abc", sha, "On it.", ref]);
  });

  test(`${name}: a read can be kept to one thread`, () => {
    const { port, ref, other } = make();
    const start = port.read(null).cursor;
    port.send(question("q1abc", ref), "Here?");
    port.send(question("q2abc", other), "There?");
    expect(ids(port.read(start, { ref: other }).messages)).toEqual(["q2abc"]);
    expect(ids(port.read(null, { ref }).messages)).toEqual(["q1abc"]);
    expect(ids(port.read(start).messages).sort()).toEqual(["q1abc", "q2abc"]);
  });

  test(`${name}: acknowledging a message read or sent is fine; an unknown id is an error with code message fix`, () => {
    const { port, ref } = make();
    port.send(question("q1abc", ref), "Which colour?");
    port.ack("q1abc");
    const r = refusal(() => port.ack("nosuchid"));
    expect(r.code).toBe("unknown-message");
    expect(r.message).toContain("nosuchid");
  });

  test(`${name}: a message with no thread to go in is refused with code message fix`, () => {
    const { port } = make();
    const r = refusal(() => port.send(new Message({ id: "q1abc", kind: "question", frm: "haile" }), "Where?"));
    expect(r.code).toBe("needs-ref");
  });

  test(`${name}: a cursor the port did not give is refused with code message fix`, () => {
    const { port } = make();
    expect(refusal(() => port.read("not a cursor")).code).toBe("bad-cursor");
  });
}
