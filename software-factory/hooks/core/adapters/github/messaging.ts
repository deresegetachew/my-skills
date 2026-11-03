// The Messaging port on GitHub (decision 0003, #376): the factory's messages are comments on the issues and PRs, and
// an agent's status is the envelope on its agent issue (its card). A read asks GitHub what `factory messages ls`
// always has: the open issues and PRs (or the one a scope names), then the comments of each one that has any.
//
// The cursor is the newest comment's time and the ids of the comments at that time, so a comment is read once even
// when several share a second. A card is what an agent is now, not something said: it is read only with no cursor.
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

export class GithubMessaging implements Messaging {
  private known = new Set<string>();

  send(m: Message, text: string): Message {
    const ref = REF.exec(m.ref);
    if (!ref) throw needsRef(m);
    gh("POST", `repos/{owner}/{repo}/issues/${ref[2]}/comments`, { body: commentBody(m, text) });
    this.known.add(m.id);
    return m;
  }

  read(cursor: Cursor | null, scope: Scope = {}): Read {
    const after = cursor === null ? null : decode(cursor);
    const mark: Mark = { at: after?.at ?? "", ids: [...(after?.ids ?? [])] };
    const messages: Message[] = [];
    const ids = new Set<string>();
    const take = (m: Message, thread: string, card: boolean): void => {
      m.thread = thread;
      m.card = card;
      if (ids.has(m.id)) return; // the same message twice (posted again, or a comment on two pages): read once
      ids.add(m.id);
      this.known.add(m.id);
      messages.push(m);
    };
    for (const item of items(scope.ref)) {
      const thread = (item.pull_request ? "pr#" : "issue#") + item.number;
      if (item.labels.some((x) => x.name === "factory:agent")) {
        if (!after) for (const m of messagesOf([{ body: item.body || "", html_url: item.html_url ?? null }], thread)) take(m, thread, true);
        continue;
      }
      if (!(item.comments ?? 1)) continue; // nothing was said there: no call
      const comments = once(ghAll<Comment>(`repos/{owner}/{repo}/issues/${item.number}/comments`));
      comments.forEach((c, i) => {
        if (!isNew(c, after)) return;
        advance(mark, c);
        for (const m of parseComment(c as CommentLike, i)) {
          m.ref = m.ref || thread;
          take(m, thread, false);
        }
      });
    }
    return { messages, cursor: `${PREFIX}${mark.at}|${mark.ids.join(",")}` };
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

function decode(cursor: Cursor): Mark {
  const m = /^gh1:([^|]*)\|([\w,]*)$/.exec(cursor);
  if (!m) throw badCursor(cursor);
  return { at: m[1] as string, ids: m[2] ? (m[2] as string).split(",") : [] };
}
