// The Messaging port on the message board (#500, decision 0007 point 10): with `tasks.source` "board", the factory's
// messages follow the tasks there. Each call runs the board's child (child.ts).
//
// A message is posted as its sender (`frm`), to its addressee, with the board's kind for it (a must-fix or an approval
// is a verdict), and its body is the comment GitHub would hold: the factory's envelope, then the text. So a read parses
// it back exactly as the GitHub adapter does, and the board's own readers (the web UI, `factory board show`) see it too.
// Its tag is `msg:<owner>/<repo>`, the project it belongs to, so projects sharing a board don't read each other's; the
// thread is the envelope's ref (issue#<n> or pr#<n>). Messages imported from GitHub (`factory board import github`) are
// read too, on the project's tasks, in the thread of the issue they came from (all of them on a first read, with no cursor;
// after that, what was posted since).
//
// The cursor is the board's own (`mb1:<event seq>`): the order the messages were posted in.
import type { Message as BoardMessage, Task as BoardTask } from "../../../../message-board/src/index.ts";
import { badCursor, commentBody, type Message, needsRef, parseComment, REF, refMatches, unknownMessage } from "../../domain/message.ts";
import type { Cursor, Messaging, Read, Scope } from "../../ports/messaging.ts";
import type { BoardChild } from "./child.ts";

const PREFIX = "mb1:";
/** The factory's kinds as the board's (question, answer, status, note, verdict, ask). */
const KIND: Record<string, string> = { question: "question", answer: "answer", status: "status", mustfix: "verdict", approval: "verdict" };

export interface BoardMessagingOptions {
  child: BoardChild;
  /** The project's GitHub repo, owner/name ("" when it has none). */
  repo: string;
}

export class BoardMessaging implements Messaging {
  private known = new Set<string>();
  private readonly tag: string;

  constructor(private readonly o: BoardMessagingOptions) {
    this.tag = `msg:${(o.repo || "local").toLowerCase()}`;
  }

  send(m: Message, text: string): Message {
    if (!REF.test(m.ref)) throw needsRef(m);
    const kind = KIND[m.kind] ?? "note";
    this.o.child.one(m.frm || process.env.FACTORY_AGENT || "factory", "post", { kind, tag: this.tag, to: m.to || null, body: commentBody(m, text) });
    this.known.add(m.id);
    return m;
  }

  read(cursor: Cursor | null, scope: Scope = {}): Read {
    const after = cursor === null ? undefined : position(cursor);
    const calls: { op: string; args: unknown[] }[] = [{ op: "messages", args: [after === undefined ? {} : { after }] }];
    const imported = Boolean(this.o.repo);
    if (imported) calls.push({ op: "tasks", args: [{ all: true, limit: 100_000 }] });
    const [got, all] = this.o.child.call("factory", calls) as [{ messages: BoardMessage[]; cursor: number }, BoardTask[] | undefined];
    const threads = imported ? issueThreads(all ?? [], this.o.repo) : new Map<number, string>();
    const messages: Message[] = [];
    const seen = new Set<string>(); // a message posted twice with one id is read once, per thread, as GitHub's are
    for (const b of got.messages) {
      const fromTask = b.taskId === null ? undefined : threads.get(b.taskId);
      if (b.tag !== this.tag && !fromTask) continue;
      for (const m of parseComment({ id: b.id, body: b.body, created_at: new Date(b.createdAt).toISOString(), user: { login: b.from } })) {
        m.ref = m.ref || fromTask || "";
        m.thread = m.ref;
        if (!m.thread || (scope.ref && !refMatches(m.thread, scope.ref))) continue;
        const key = `${m.thread} ${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.known.add(m.id);
        messages.push(m);
      }
    }
    return { messages, cursor: PREFIX + got.cursor };
  }

  ack(id: string): void {
    if (!this.known.has(id)) throw unknownMessage(id);
  }
}

/** issue#<n> for each of the project's tasks that came from GitHub, by board id. */
function issueThreads(all: BoardTask[], repo: string): Map<number, string> {
  const prefix = `github:${repo.toLowerCase()}#`;
  const out = new Map<number, string>();
  for (const t of all) {
    const ref = (t.ref ?? "").toLowerCase();
    if (ref.startsWith(prefix) && /^\d+$/.test(ref.slice(prefix.length))) out.set(t.id, `issue#${ref.slice(prefix.length)}`);
  }
  return out;
}

function position(cursor: Cursor): number {
  const m = /^mb1:(\d+)$/.exec(cursor);
  if (!m) throw badCursor(cursor);
  return Number(m[1]);
}
