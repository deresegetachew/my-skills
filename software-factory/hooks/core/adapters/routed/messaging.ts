// Messaging over two transports (#409/#410, #500): with `messaging.transport` "board", the kinds in `messaging.kinds` go
// to the message board, and for their first week also to GitHub (the double send that shows nothing was missed); every
// other kind stays on GitHub. A read gives what either holds, each message once per thread (the board's copy when both
// have it), so a reader sees a kind that has moved and one that hasn't alike.
//
// The cursor holds both transports' cursors. The kinds that go through this port (question, answer, mustfix, approval,
// status) are always written to GitHub too: the board's copy is not the record (6 Nov 2026). Only claims and wake-ups,
// which don't go through here, may drop their GitHub copy (messaging.githubCopy).
import { CoreError } from "../../domain/error.ts";
import { badCursor, type Message, unknownMessage } from "../../domain/message.ts";
import type { Cursor, Messaging, Read, Scope } from "../../ports/messaging.ts";

const PREFIX = "route1:";

interface Both {
  github: Cursor;
  other: Cursor;
}

export class RoutedMessaging implements Messaging {
  private readonly github: Messaging;
  private readonly other: Messaging;
  private readonly kinds: Set<string>;
  private readonly warn: (e: CoreError) => void;

  /** `other` is the board's messaging; `warn` hears of a send it refused (it went to GitHub anyway). */
  constructor(github: Messaging, other: Messaging, kinds: string[], warn: (e: CoreError) => void = () => {}) {
    this.github = github;
    this.other = other;
    this.kinds = new Set(kinds);
    this.warn = warn;
  }

  send(m: Message, text: string): Message {
    if (this.kinds.has(m.kind)) {
      try {
        this.other.send(m, text);
      } catch (e) {
        if (!(e instanceof CoreError) || e.code === "needs-ref") throw e;
        this.warn(e); // the GitHub copy below still carries it
      }
    }
    return this.github.send(m, text);
  }

  read(cursor: Cursor | null, scope: Scope = {}): Read {
    const after = cursor === null ? null : decode(cursor);
    const fromOther = this.other.read(after?.other ?? null, scope);
    const fromGithub = this.github.read(after?.github ?? null, scope);
    const seen = new Set<string>();
    const messages: Message[] = [];
    for (const m of [...fromOther.messages, ...fromGithub.messages]) {
      const key = `${m.thread} ${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(m);
    }
    messages.sort((a, b) => (a.created && b.created && a.created !== b.created ? (a.created < b.created ? -1 : 1) : 0));
    const both: Both = { github: fromGithub.cursor, other: fromOther.cursor };
    return { messages, cursor: PREFIX + Buffer.from(JSON.stringify(both)).toString("base64url") };
  }

  ack(id: string): void {
    for (const port of [this.other, this.github]) {
      try {
        port.ack(id);
        return;
      } catch {
        // not this one's
      }
    }
    throw unknownMessage(id);
  }
}

function decode(cursor: Cursor): Both {
  if (!cursor.startsWith(PREFIX)) throw badCursor(cursor);
  try {
    const both = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), "base64url").toString("utf8")) as Partial<Both>;
    if (typeof both.github === "string" && typeof both.other === "string") return { github: both.github, other: both.other };
  } catch {
    // not ours
  }
  throw badCursor(cursor);
}
