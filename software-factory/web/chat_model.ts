// The chat's and the owner queue's rules in the page (#423) that aren't drawing: merging a chat's items as they arrive,
// the order of the owner queue's asks, and the words a chat item is shown with. No React here, so
// tests/web_ui_chat_model.test.ts runs it as it is.

export interface ProblemView {
  code: string;
  message: string;
  fix: string;
}

/** One line of a chat, as factory_ui_chat.ts sends it. */
export interface ChatItemView {
  id: string;
  at: string;
  from: string;
  to: string;
  /** owner (the owner said it here), reply (the dev manager's or product owner's answer), error, or a message's kind. */
  kind: string;
  text: string;
  state?: string;
  ref?: string;
  url?: string;
  error?: ProblemView;
}

export interface AskView {
  id: string;
  issue: number;
  text: string;
  options: string[];
  state: "open" | "answered";
  forProduct: boolean;
  url: string | null;
  created: string | null;
  answer: string | null;
  from?: string | null;
  task?: string | null;
}

export interface QueueView {
  issue: number | null;
  url: string | null;
  asks: AskView[];
  problem: ProblemView | null;
  source?: "board" | "github";
}

/** Who asked and about which task, for an ask's card: "mentewab asked about #101", "mentewab asked", or "" when the
 * asker isn't known. */
export function askedBy(a: AskView): string {
  if (!a.from) return "";
  return `${a.from} asked${a.task ? ` about ${a.task}` : ""}`;
}

/** What the Inbox says when nothing has been asked: with the board as the record, where questions come from; on GitHub,
 * that the owner-queue issue isn't open yet. */
export function emptyQueueText(q: QueueView): string {
  return q.source === "board" ? "Nothing waiting for you. Questions the agents ask you appear here."
    : "There is no owner queue yet: the dev manager opens the issue “Dev manager: needs the owner” with its first ask.";
}

/** `before` and `more` as one chat: each id once (the newer copy wins), in time order. */
export function mergeItems(before: ChatItemView[], more: ChatItemView[]): ChatItemView[] {
  const by = new Map<string, ChatItemView>();
  for (const x of [...before, ...more]) by.set(x.id, x);
  return [...by.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The asks the owner still has to answer first, oldest first, then the answered ones, newest first. */
export function orderAsks(asks: AskView[]): AskView[] {
  const t = (a: AskView): string => a.created ?? "";
  const open = asks.filter((a) => a.state === "open").sort((a, b) => (t(a) < t(b) ? -1 : t(a) > t(b) ? 1 : 0));
  const done = asks.filter((a) => a.state !== "open").sort((a, b) => (t(a) < t(b) ? 1 : t(a) > t(b) ? -1 : 0));
  return [...open, ...done];
}

/** Who said an item ("You" for the owner), what it is (a message's kind and where it was said), and whether it is the
 * owner's own. A plain talk answer needs no words. */
export function itemLabel(item: ChatItemView, _channel: string): { who: string; what: string; mine: boolean } {
  if (item.kind === "owner") return { who: "You", what: "", mine: true };
  if (item.kind === "reply") return { who: item.from, what: "", mine: false };
  if (item.kind === "error") return { who: item.from, what: "didn't answer", mine: false };
  const what = [item.kind, item.to ? `to ${item.to}` : "", item.ref ? `on ${item.ref}` : ""].filter(Boolean).join(" ");
  return { who: item.from || "someone", what, mine: false };
}
