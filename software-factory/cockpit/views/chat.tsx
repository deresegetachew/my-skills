// Talking to the dev manager or the product owner (#395): views 9 and 0 of the cockpit, or Enter on that role in the
// list. The owner types a line and Enter sends it; the role answers in a fresh session that reads its context and acts
// within its rules (`factory cockpit --chat-send`, the view's `send`), and a summary goes to the owner queue so the next
// pass sees it. The conversation so far goes with each line. Esc closes; while the role answers, the line can't be sent
// again.
import { useApp, useInput } from "ink";
import { type ReactElement, useState } from "react";
import { backspace, erased, typedText } from "./filter.ts";
import { cut, type Line, Lines, seg, spread, wrap } from "./lines.tsx";

export type Turn = { who: "owner" | "role"; text: string };
export type ChatProblem = { code: string; message: string; fix: string };
export type ChatReply = { answer: string; summary: string } | { problem: ChatProblem };

export const CHAT_KEYS = "type a line · Enter send · Esc close";

const TITLE: Record<string, string> = { "dev-manager": "the dev manager", "product-owner": "the product owner" };

/** What the pane shows besides the turns: the role answering, the summary's place, or a refusal. */
export interface ChatNote {
  busy: boolean;
  summary: string;
  problem: ChatProblem | null;
}

/** One screen of the pane, `rows` lines at most, each at most `cols` wide; the newest turns show. */
export function chatLines(role: string, name: string, repo: string, turns: Turn[], note: ChatNote, typed: string, cols: number,
  rows: number): Line[] {
  const title = TITLE[role] ?? role;
  const heading = spread([seg("factory", "amber"), seg(`  ${repo} · Talk to ${title}`)], [seg(`${name}, a fresh session each line`, "dim")], cols);
  const body: Line[] = [];
  if (!turns.length && !note.busy) {
    body.push(...wrap(`Ask ${title} anything: what is waiting, why a PR is held, to merge or to wait. It answers within its ` +
      "rules, and a summary of each answer goes to the owner queue.", cols, "dim"));
  }
  for (const t of turns) {
    body.push(...(t.who === "owner" ? wrap(`you: ${t.text}`, cols, "bold") : [[seg(`${name}:`, "amber")], ...wrap(t.text, cols)]), []);
  }
  if (note.busy) body.push([seg(`${name} is answering… (a fresh session reads its context first, so it can take a minute)`, "dim")]);
  if (note.summary) body.push(...wrap(note.summary, cols, "dim"));
  if (note.problem) body.push(...wrap(note.problem.message, cols, "red"), ...wrap(`fix: ${note.problem.fix}`, cols, "dim"));
  const input: Line = [seg("› "), seg(typed)];
  const room = Math.max(rows - 4, 1); // the heading, a blank, the input line, the keys
  return [heading, [], ...body.slice(-room), input, [seg(CHAT_KEYS, "dim")]].map((l) => cut(l, cols)).slice(-Math.max(rows, 1));
}

export interface ChatProps {
  repo: string;
  role: "dev-manager" | "product-owner";
  /** The role's agent name, as the answers are signed. */
  name: string;
  cols: number;
  rows: number;
  color: boolean;
  /** Sends a line with the conversation before it, and gives the answer and where its summary went, or the refusal. */
  send: (text: string, history: Turn[]) => Promise<ChatReply>;
}

export function ChatView(props: ChatProps): ReactElement {
  const { exit } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<ChatNote>({ busy: false, summary: "", problem: null });
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || key.escape) return exit();
    if (note.busy) return; // one line at a time
    if (key.return) {
      const text = typed.trim();
      if (!text) return;
      const history = turns;
      setTurns([...history, { who: "owner", text }]);
      setTyped("");
      setNote({ busy: true, summary: "", problem: null });
      void props.send(text, history).then((reply) => {
        if ("problem" in reply) {
          setNote({ busy: false, summary: "", problem: reply.problem });
          return;
        }
        setTurns((ts) => [...ts, { who: "role", text: reply.answer }]);
        setNote({ busy: false, summary: reply.summary, problem: null });
      });
      return;
    }
    const back = erased(input, key);
    setTyped((t) => (back ? backspace(t, back) : t + typedText(input, key)));
  });
  const lines = chatLines(props.role, props.name, props.repo, turns, note, typed, props.cols, props.rows);
  return <Lines lines={lines} color={props.color} />;
}
