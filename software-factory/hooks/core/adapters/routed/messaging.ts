// Messaging over two transports (decision 0004 points 1 and 8, #409/#410): with `messaging.transport` "nats", the kinds
// in `messaging.kinds` go over NATS, and for their first week also to GitHub (the double send that shows nothing was
// missed); every other kind stays on GitHub. A read gives what either holds, each message once per thread (the NATS
// copy when both have it), so a reader sees a kind that has moved and one that hasn't alike.
//
// The cursor holds both transports' cursors. The GitHub copy of a moved kind stops when the owner says so (#247): until
// a setting for that exists, every moved kind is double-sent.
import { CoreError } from "../../domain/error.ts";
import { badCursor, type Message, unknownMessage } from "../../domain/message.ts";
import type { Cursor, Messaging, Read, Scope } from "../../ports/messaging.ts";

const PREFIX = "route1:";

interface Both {
  github: Cursor;
  nats: Cursor;
}

export class RoutedMessaging implements Messaging {
  private readonly github: Messaging;
  private readonly nats: Messaging;
  private readonly kinds: Set<string>;
  private readonly warn: (e: CoreError) => void;

  /** `warn` hears of a send NATS refused (it went to GitHub anyway). */
  constructor(github: Messaging, nats: Messaging, kinds: string[], warn: (e: CoreError) => void = () => {}) {
    this.github = github;
    this.nats = nats;
    this.kinds = new Set(kinds);
    this.warn = warn;
  }

  send(m: Message, text: string): Message {
    if (this.kinds.has(m.kind)) {
      try {
        this.nats.send(m, text);
      } catch (e) {
        if (!(e instanceof CoreError) || e.code === "needs-ref") throw e;
        this.warn(e); // the GitHub copy below still carries it (decision 0004 point 3)
      }
    }
    return this.github.send(m, text);
  }

  read(cursor: Cursor | null, scope: Scope = {}): Read {
    const after = cursor === null ? null : decode(cursor);
    const fromNats = this.nats.read(after?.nats ?? null, scope);
    const fromGithub = this.github.read(after?.github ?? null, scope);
    const seen = new Set<string>();
    const messages: Message[] = [];
    for (const m of [...fromNats.messages, ...fromGithub.messages]) {
      const key = `${m.thread} ${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(m);
    }
    messages.sort((a, b) => (a.created && b.created && a.created !== b.created ? (a.created < b.created ? -1 : 1) : 0));
    const both: Both = { github: fromGithub.cursor, nats: fromNats.cursor };
    return { messages, cursor: PREFIX + Buffer.from(JSON.stringify(both)).toString("base64url") };
  }

  ack(id: string): void {
    for (const port of [this.nats, this.github]) {
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
    if (typeof both.github === "string" && typeof both.nats === "string") return { github: both.github, nats: both.nats };
  } catch {
    // not ours
  }
  throw badCursor(cursor);
}
