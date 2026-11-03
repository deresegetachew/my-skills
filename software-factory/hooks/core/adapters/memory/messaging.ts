// The Messaging port in memory (decision 0003, #376): for tests of the roles, with no fake `gh`. A sent message is
// kept as the comment GitHub would hold and parsed back, so it reads exactly as the GitHub adapter's do.
import { badCursor, commentBody, type Message, needsRef, parseComment, REF, refMatches, unknownMessage } from "../../domain/message.ts";
import type { Cursor, Messaging, Read, Scope } from "../../ports/messaging.ts";

const PREFIX = "mem1:";

export class MemoryMessaging implements Messaging {
  private said: Message[] = []; // every message sent, in order; a cursor is how many were read
  private known = new Set<string>();

  send(m: Message, text: string): Message {
    if (!REF.test(m.ref)) throw needsRef(m);
    const n = this.said.length + 1;
    for (const got of parseComment({ id: n, body: commentBody(m, text), created_at: new Date().toISOString() })) {
      got.thread = m.ref;
      this.said.push(got);
    }
    this.known.add(m.id);
    return m;
  }

  read(cursor: Cursor | null, scope: Scope = {}): Read {
    const from = cursor === null ? 0 : position(cursor);
    const key = (m: Message): string => `${m.thread} ${m.id}`; // an id is read once per thread, as GitHub's is
    const before = new Set(this.said.slice(0, from).map(key));
    const messages: Message[] = [];
    for (const m of this.said.slice(from)) {
      if (before.has(key(m)) || (scope.ref && !refMatches(m.thread, scope.ref))) continue;
      before.add(key(m));
      this.known.add(m.id);
      messages.push(m);
    }
    return { messages, cursor: PREFIX + this.said.length };
  }

  ack(id: string): void {
    if (!this.known.has(id)) throw unknownMessage(id);
  }
}

function position(cursor: Cursor): number {
  const m = /^mem1:(\d+)$/.exec(cursor);
  if (!m) throw badCursor(cursor);
  return Number(m[1]);
}
