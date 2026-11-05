// The chat pane (#395): the owner talks to the dev manager or the product owner. Each message is sent with `factory owner
// chat <role> <message>` (the hook names the command): a fresh session as that role answers, and its summary goes to
// the owner queue. The earlier turns (the role's chat file) show first. Type, Enter sends, Esc closes.
import { useApp, useInput } from "ink";
import { type ReactElement, useState } from "react";
import { cut, type Line, Lines, plain, screen, seg, spread, wrap } from "./lines.tsx";

export type Reply = { answer: string; summary: string; posted: string | null };
export type ChatProblem = { code: string; message: string; fix: string };
export type ChatTurn = { you: string; answer: string };

const TITLE: Record<string, string> = { "dev-manager": "Dev manager", "product-owner": "Product owner" };
export const CHAT_KEYS = "type a message · Enter sends · Esc closes";

/** One exchange as the pane shows it: the owner's message, then the answer, or the refusal, or "thinking". */
type Shown = { you: string; reply: Reply | ChatProblem | null; old?: boolean };

function isProblem(r: Reply | ChatProblem): r is ChatProblem {
  return "code" in r;
}

function turnLines(t: Shown, title: string, cols: number): Line[] {
  const out: Line[] = [...wrap(`You: ${plain(t.you)}`, cols, "bold")];
  if (t.reply === null) {
    out.push([seg(`${title} is thinking…`, "dim")],
      [seg("Esc closes the pane; the answer still comes, is posted and shows here next time.", "dim")]);
  }
  else if (isProblem(t.reply)) out.push(...wrap(plain(t.reply.message), cols, "red"), ...wrap(plain(t.reply.fix), cols));
  else {
    out.push(...t.reply.answer.split(/\r?\n/).flatMap((l) => wrap(plain(l), cols)));
    if (!t.old) {
      out.push(t.reply.posted ? [seg(`Summary on the owner queue: ${plain(t.reply.posted)}`, "dim")]
        : [seg("The summary was not posted: there is no open owner queue issue.", "dim")]);
    }
  }
  return [...out, []];
}

/** One screen of the pane: the heading, the latest turns that fit, the line being typed and the keys. */
export function chatLines(role: string, turns: Shown[], typed: string, cols: number, rows: number): Line[] {
  const title = TITLE[role] ?? role;
  const heading = spread([seg("factory", "amber"), seg(`  ${title}`)],
    [seg("each message starts a fresh session; its summary goes to the owner queue", "dim")], cols);
  const talk = turns.flatMap((t) => turnLines(t, title, cols));
  const room = Math.max(rows - 4, 1); // the heading, a blank, the line typed, the keys
  const shown = talk.length ? talk.slice(-room) : [[seg(`Say something to the ${title.toLowerCase()}.`, "dim")]];
  return screen([heading, [], ...shown, [seg("› "), seg(plain(typed)), seg("▏", "dim")]], CHAT_KEYS, cols, rows);
}

export interface ChatProps {
  role: "dev-manager" | "product-owner";
  cols: number;
  rows: number;
  color: boolean;
  /** The earlier turns, oldest first. */
  history?: ChatTurn[];
  /** Sends one message; the answer, or the refusal. */
  send: (text: string) => Promise<Reply | ChatProblem>;
}

export function ChatView(props: ChatProps): ReactElement {
  const { exit } = useApp();
  const [turns, setTurns] = useState<Shown[]>(() =>
    (props.history ?? []).map((t) => ({ you: t.you, reply: { answer: t.answer, summary: "", posted: null }, old: true })));
  const [typed, setTyped] = useState("");
  const waiting = turns.some((t) => t.reply === null);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return exit();
    if (key.return) {
      const text = typed.trim();
      if (!text || waiting) return;
      setTyped("");
      setTurns((ts) => [...ts, { you: text, reply: null }]);
      void props.send(text).then((reply) => setTurns((ts) => ts.map((t) => (t.reply === null ? { ...t, reply } : t))));
      return;
    }
    if (key.backspace || key.delete) setTyped((t) => t.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setTyped((t) => t + input.replace(/[\r\n]/g, " "));
  });
  const lines = chatLines(props.role, turns, typed, props.cols, props.rows);
  return <Lines lines={lines.map((l) => cut(l, props.cols))} color={props.color} />;
}
