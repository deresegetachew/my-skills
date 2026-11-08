// The Messaging port on GitHub (decision 0003, #376): the factory's messages are comments on the issues and PRs, and
// an agent's status is the envelope on its agent issue (its card). A read asks GitHub what `factory messages ls`
// always has: the open issues and PRs (or the one a scope names), then the comments of each one that has any.
//
// The cursor holds, for each thread, its newest comment's time and the ids of the comments at that time, so a comment
// is read once even when several share a second, and a comment on one thread is never hidden by a newer one on
// another. A card is what an agent is now, not something said: it is read only with no cursor.
//
// Each thread's comments are kept between reads in a file on this machine (#473), with the issue's `updated_at` and
// comment count when they were read: a thread whose two are unchanged is not asked for its comments again, so a read
// where nothing moved costs one call (the list of open issues and PRs).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Comment, gh, ghAll, type Issue } from "../../../factory_issues.ts";
import { CoreError } from "../../domain/error.ts";
import { badCursor, commentBody, type CommentLike, type Message, messagesOf, needsRef, parseComment, REF, refNumber,
  unknownMessage } from "../../domain/message.ts";
import type { Cursor, Messaging, Read, Scope } from "../../ports/messaging.ts";

const PREFIX = "gh1:";

interface Mark {
  at: string; // created_at of the newest comment read
  ids: string[]; // the comments read at that time
}

/** A thread's comments as last read, and what its issue said then. */
interface Kept {
  updated: string;
  count: number;
  comments: Comment[];
}

export class GithubMessaging implements Messaging {
  private known = new Set<string>();

  /** `threadsFile`: where each thread's comments are kept between reads; null keeps nothing (each read asks for all). */
  constructor(private readonly threadsFile: string | null = null) {}

  send(m: Message, text: string): Message {
    const ref = REF.exec(m.ref);
    if (!ref) throw needsRef(m);
    gh("POST", `repos/{owner}/{repo}/issues/${ref[2]}/comments`, { body: commentBody(m, text) });
    this.known.add(m.id);
    return m;
  }

  read(cursor: Cursor | null, scope: Scope = {}): Read {
    const after = cursor === null ? null : decode(cursor);
    const marks: Record<string, Mark> = { ...(after ?? {}) };
    const messages: Message[] = [];
    const kept = this.keptThreads();
    const seen: Record<string, Kept> = scope.ref ? { ...kept } : {}; // a whole read drops the threads that closed
    for (const item of items(scope.ref)) {
      const thread = (item.pull_request ? "pr#" : "issue#") + item.number;
      const ids = new Set<string>(); // per thread, as fold reads it: the same message twice (posted again) is read once
      const take = (m: Message, card: boolean): void => {
        m.thread = thread;
        m.card = card;
        if (ids.has(m.id)) return;
        ids.add(m.id);
        this.known.add(m.id);
        messages.push(m);
      };
      if (item.labels.some((x) => x.name === "factory:agent")) {
        if (!after) for (const m of messagesOf([{ body: item.body || "", html_url: item.html_url ?? null }], thread)) take(m, true);
        continue;
      }
      if (!(item.comments ?? 1)) continue; // nothing was said there: no call
      const comments = this.commentsOf(item, kept[thread], (k) => { seen[thread] = k; });
      const before = after?.[thread] ?? null;
      const mark: Mark = { at: before?.at ?? "", ids: [...(before?.ids ?? [])] };
      comments.forEach((c, i) => {
        if (!isNew(c, before)) return;
        advance(mark, c);
        for (const m of parseComment(c as CommentLike, i)) {
          m.ref = m.ref || thread;
          take(m, false);
        }
      });
      if (mark.at) marks[thread] = mark;
    }
    this.keep(seen);
    return { messages, cursor: PREFIX + Buffer.from(JSON.stringify(marks)).toString("base64url") };
  }

  /** `item`'s comments: the kept ones while its `updated_at` and comment count are what they were, else read now. */
  private commentsOf(item: Issue, before: Kept | undefined, keep: (k: Kept) => void): Comment[] {
    const updated = item.updated_at ?? "";
    const count = item.comments ?? -1;
    if (before && updated && before.updated === updated && before.count === count) {
      keep(before);
      return before.comments;
    }
    const comments = once(ghAll<Comment>(`repos/{owner}/{repo}/issues/${item.number}/comments`));
    if (updated) keep({ updated, count, comments });
    return comments;
  }

  private keptThreads(): Record<string, Kept> {
    if (!this.threadsFile) return {};
    try {
      const data = JSON.parse(readFileSync(this.threadsFile, "utf8")) as unknown;
      return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, Kept>) : {};
    } catch {
      return {}; // none yet, or unreadable: read every thread
    }
  }

  /** Writes the kept threads; one that can't be written only means the next read asks again. */
  private keep(threads: Record<string, Kept>): void {
    if (!this.threadsFile) return;
    try {
      mkdirSync(dirname(this.threadsFile), { recursive: true });
      const tmp = `${this.threadsFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(threads), { mode: 0o600 });
      renameSync(tmp, this.threadsFile);
    } catch {
      // said above
    }
  }

  ack(id: string): void {
    if (!this.known.has(id)) throw unknownMessage(id);
  }
}

/** The open issues and PRs, or the one item `ref` names (open or not). */
function items(ref: string | undefined): Issue[] {
  if (!ref) return ghAll("repos/{owner}/{repo}/issues?state=open");
  const number = refNumber(ref);
  if (!number) throw new CoreError("bad-ref", `'${ref}' isn't an issue or PR number.`, "Use a number, or issue#<n> / pr#<n>.");
  const item = gh<Issue | null>("GET", `repos/{owner}/{repo}/issues/${number}`, undefined, true);
  if (!item || typeof item.number !== "number") {
    throw new CoreError("no-such-item", `There is no issue or PR #${number}.`, "Check the number with `gh pr list`.");
  }
  return [item];
}

/** Each comment once, by its id: a page boundary that moves while reading can repeat one. */
function once(comments: Comment[]): Comment[] {
  const seen = new Set<string>();
  return comments.filter((c) => {
    if (c.id === undefined) return true;
    const key = String(c.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isNew(c: Comment, after: Mark | null): boolean {
  if (!after) return true;
  const at = c.created_at ?? "";
  return at > after.at || (at === after.at && !after.ids.includes(String(c.id ?? "")));
}

function advance(mark: Mark, c: Comment): void {
  const at = c.created_at ?? "";
  if (at > mark.at) {
    mark.at = at;
    mark.ids = [];
  }
  if (at === mark.at) mark.ids.push(String(c.id ?? ""));
}

/** {thread: mark} from a cursor this adapter gave. */
function decode(cursor: Cursor): Record<string, Mark> {
  if (!cursor.startsWith(PREFIX)) throw badCursor(cursor);
  let got: unknown;
  try {
    got = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw badCursor(cursor);
  }
  if (!got || typeof got !== "object" || Array.isArray(got)) throw badCursor(cursor);
  const out: Record<string, Mark> = {};
  for (const [thread, v] of Object.entries(got)) {
    const mark = v as { at?: unknown; ids?: unknown };
    if (!REF.test(thread) || typeof mark.at !== "string" || !Array.isArray(mark.ids) || !mark.ids.every((x) => typeof x === "string")) {
      throw badCursor(cursor);
    }
    out[thread] = { at: mark.at, ids: mark.ids as string[] };
  }
  return out;
}
