// The Messaging port (decision 0003, #376): how the roles send the factory's messages and read what is new. GitHub
// comments are one transport (adapters/github), memory another (adapters/memory, for tests); NATS (#373) is next.
// Its contract is tests/contracts/messaging.ts, and every adapter passes it.
import type { Message } from "../domain/message.ts";

/** Where a read stopped. Opaque: only the adapter that gave it reads it. */
export type Cursor = string;

/** What a read is kept to: one issue or PR (7, #7, issue#7 or pr#7). */
export interface Scope {
  ref?: string;
}

export interface Read {
  messages: Message[]; // in the order they were said; each id once; `thread` says where each was read
  cursor: Cursor; // pass it to the next read to get only what came after
}

export interface Messaging {
  /** Post `m` with `text` under it, in the thread its `ref` names. Refuses (`needs-ref`) a message with no ref. */
  send(m: Message, text: string): Message;
  /** The messages said after `cursor` (everything when null), kept to `scope`. A message read once is not read again
   * after the cursor this read gives. Refuses (`bad-cursor`) a cursor it did not give. */
  read(cursor: Cursor | null, scope?: Scope): Read;
  /** Mark a message read or sent here as handled. Refuses (`unknown-message`) an id it never saw. */
  ack(id: string): void;
}
