// The chat in each agent's channel and the owner-queue channel (#423), drawn from factory_ui_chat.ts's API. app.tsx
// passes every WebSocket message here (dispatchLive); a chat or the queue takes what is about it.
//
// A chat shows what the agent said and was told (its messages) and what the owner sent; the box under it sends one
// message: to a coding agent as `factory say`, to the dev manager or the product owner as one turn of a talk (`factory talk`),
// whose answer arrives later. The owner queue shows each ask as a card with its options as buttons; a tap asks first,
// then runs `factory owner answer`.
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { type AskView, type ChatItemView, emptyQueueText, itemLabel, mergeItems, orderAsks, type ProblemView, type QueueView } from "./chat_model.ts";
import { Avatar } from "./avatar_view.tsx";
import { ago } from "./model.ts";

interface LiveMessage {
  type: string;
  project?: string;
  agent?: string;
  items?: ChatItemView[];
  pending?: boolean;
  queue?: QueueView;
}

const bus = new EventTarget();

/** Hands a WebSocket message to the chats and the owner queue on the page. */
export function dispatchLive(m: { type: string }): void {
  if (m.type === "chat" || m.type === "owner-queue") bus.dispatchEvent(new CustomEvent<LiveMessage>("live", { detail: m }));
}

function useLive(on: (m: LiveMessage) => void): void {
  useEffect(() => {
    const h = (e: Event): void => on((e as CustomEvent<LiveMessage>).detail);
    bus.addEventListener("live", h);
    return () => bus.removeEventListener("live", h);
  }, [on]);
}

type Json = { [key: string]: unknown };

const TOKEN_REFUSED: ProblemView = { code: "ui_token_wrong", message: "The server refused this page's token.",
  fix: "Open the address `factory ui` printed again (it ends in ?token=...)." };
const UNREACHABLE: ProblemView = { code: "ui_unreachable", message: "The server can't be reached.", fix: "Is `factory ui` still running?" };

async function call(token: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  try {
    const r = await fetch(path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Json };
  } catch {
    return { status: 0, json: {} };
  }
}

function problemOf(r: { status: number; json: Json }): ProblemView {
  if (r.status === 401) return TOKEN_REFUSED;
  if (r.status === 0) return UNREACHABLE;
  const j = r.json;
  return { code: String(j.code ?? "failed"), message: String(j.message ?? "It didn't work."), fix: String(j.fix ?? "") };
}

const base = (project: string): string => `/api/projects/${encodeURIComponent(project)}`;

// --- an agent's chat ---------------------------------------------------------------------------------------------------

export interface Chat {
  items: ChatItemView[];
  pending: boolean;
  loaded: boolean;
  problems: ProblemView[];
  send: (text: string) => Promise<ProblemView | null>;
}

/** The chat with `agent` in `project`: read once, then kept up to date over the WebSocket. */
export function useChat(token: string, project: string, agent: string): Chat {
  const [items, setItems] = useState<ChatItemView[]>([]);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [problems, setProblems] = useState<ProblemView[]>([]);

  useEffect(() => {
    let gone = false;
    setItems([]);
    setPending(false);
    setLoaded(false);
    setProblems([]);
    void call(token, `${base(project)}/agents/${encodeURIComponent(agent)}/chat`).then((r) => {
      if (gone) return;
      setLoaded(true);
      if (r.status !== 200) {
        setProblems([problemOf(r)]);
        return;
      }
      setItems((before) => mergeItems(before, (r.json.items as ChatItemView[] | undefined) ?? []));
      setPending(Boolean(r.json.pending));
      setProblems((r.json.problems as ProblemView[] | undefined) ?? []);
    });
    return () => {
      gone = true;
    };
  }, [token, project, agent]);

  useLive(useCallback((m: LiveMessage) => {
    if (m.type !== "chat" || m.project !== project || m.agent !== agent) return;
    setItems((before) => mergeItems(before, m.items ?? []));
    setPending(Boolean(m.pending));
  }, [project, agent]));

  const send = useCallback(async (text: string): Promise<ProblemView | null> => {
    const r = await call(token, `${base(project)}/agents/${encodeURIComponent(agent)}/chat`, { text });
    if (r.status !== 200 && r.status !== 202) return problemOf(r);
    const item = r.json.item as ChatItemView | undefined;
    if (item) setItems((before) => mergeItems(before, [item]));
    if (r.status === 202) setPending(true);
    return null;
  }, [token, project, agent]);

  return { items, pending, loaded, problems, send };
}

/** What the agent said and was told, oldest first. */
export function ChatLog({ chat, agent }: { chat: Chat; agent: string }) {
  const end = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  useEffect(() => {
    // follow new lines, but not on the first read (the status above stays in view)
    if (seen.current && chat.items.length > seen.current) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    seen.current = chat.items.length;
  }, [chat.items.length]);
  return (
    <section className="card" aria-label="Chat">
      <h3>Chat</h3>
      {chat.problems.map((p) => <p key={p.code} className="chat-problem"><strong>{p.message}</strong> {p.fix}</p>)}
      {!chat.loaded ? <p className="empty" style={{ margin: 0 }}>Reading the messages…</p>
        : !chat.items.length ? <p className="empty" style={{ margin: 0 }}>Nothing said yet. What {agent} asks, answers and hands on shows up here, with what you send.</p>
        : (
          <ol className="chat">
            {chat.items.map((x) => {
              const l = itemLabel(x, agent);
              return (
                <li key={x.id} className={`msg${l.mine ? " mine" : ""}${x.kind === "error" ? " bad" : ""}`}>
                  <p className="msg-head">
                    {!l.mine && x.from && <Avatar name={x.from} size={22} />}
                    <strong>{l.who}</strong>
                    {l.what && <span>{l.what}</span>}
                    {x.state && x.kind !== "owner" && x.kind !== "reply" && <span className="tag quiet">{x.state}</span>}
                    <time dateTime={x.at} title={x.at}>{ago(x.at)}</time>
                    {x.url && <a href={x.url} target="_blank" rel="noreferrer">on GitHub</a>}
                  </p>
                  <p className="msg-text">{x.text}</p>
                  {x.error?.fix && <p className="msg-fix">{x.error.fix}</p>}
                </li>
              );
            })}
          </ol>
        )}
      {chat.pending && <p className="typing" role="status">{agent} is answering… (a fresh session reads its context first; it can take a few minutes)</p>}
      <div ref={end} />
    </section>
  );
}

const TALKS: Record<string, string> = { "dev-manager": "the dev manager", "product-owner": "the product owner" };

/** The box that sends one message to `agent`. Enter sends; Shift+Enter starts a new line. */
export function Composer({ chat, agent, role }: { chat: Chat; agent: string; role: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const talk = TALKS[role];
  const waiting = Boolean(talk) && chat.pending;
  const submit = async (): Promise<void> => {
    const t = text.trim();
    if (!t || busy || waiting) return;
    setBusy(true);
    setProblem(null);
    const p = await chat.send(t);
    setBusy(false);
    if (p) setProblem(p);
    else setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <form className="composer send" aria-label="Message" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {problem && <p className="send-problem" role="alert"><strong>{problem.message}</strong> {problem.fix}</p>}
      <span className="send-row">
        <textarea aria-label={`Message ${agent}`} rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder={waiting ? `${agent} is answering…` : `Message ${agent}`} disabled={busy || waiting} />
        <button className="btn primary" type="submit" disabled={busy || waiting || !text.trim()}>{busy ? "Sending…" : "Send"}</button>
      </span>
      <span className="send-hint">
        {talk ? <>One turn of a talk with {agent}, {talk}, in a fresh session; a summary goes on the owner queue.</>
          : <>Typed into {agent}'s session as one line, like <code>factory say {agent} …</code></>}
      </span>
    </form>
  );
}

// --- the owner queue ---------------------------------------------------------------------------------------------------

interface Confirm {
  ask: AskView;
  answer: string;
}

/** The owner queue: each ask as a card, its options as buttons; a tap asks first, then answers it. */
export function OwnerQueueChannel({ token, project }: { token: string; project: string }) {
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [problem, setProblem] = useState<ProblemView | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [own, setOwn] = useState<Record<string, string>>({});

  useEffect(() => {
    let gone = false;
    setQueue(null);
    setProblem(null);
    void call(token, `${base(project)}/owner-queue`).then((r) => {
      if (gone) return;
      if (r.status === 200) setQueue(r.json as unknown as QueueView);
      else setProblem(problemOf(r));
    });
    return () => {
      gone = true;
    };
  }, [token, project]);

  useLive(useCallback((m: LiveMessage) => {
    if (m.type === "owner-queue" && m.project === project && m.queue) setQueue(m.queue);
  }, [project]));

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) setConfirm(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [confirm, busy]);

  const answer = async (): Promise<void> => {
    if (!confirm) return;
    setBusy(true);
    const r = await call(token, `${base(project)}/owner-queue/${encodeURIComponent(confirm.ask.id)}/answer`, { answer: confirm.answer, confirm: true });
    setBusy(false);
    if (r.status === 200) {
      setProblem(null);
      setDone(`Answered ${confirm.ask.id}: “${confirm.answer}”.`);
      if (r.json.queue) setQueue(r.json.queue as QueueView);
      setOwn((o) => ({ ...o, [confirm.ask.id]: "" }));
    } else {
      setDone(null);
      setProblem(problemOf(r));
    }
    setConfirm(null);
  };

  const asks = queue ? orderAsks(queue.asks) : [];
  const open = asks.filter((a) => a.state === "open");
  return (
    <div className="body">
      {problem && <div className="notice bad" role="alert"><span className="dot bad" aria-hidden="true" /><div><strong>{problem.message}</strong><p>{problem.fix}</p></div></div>}
      {queue?.problem && <div className="notice bad" role="alert"><span className="dot bad" aria-hidden="true" /><div><strong>{queue.problem.message}</strong><p>{queue.problem.fix}</p></div></div>}
      {done && <div className="notice good" role="status"><span className="dot good" aria-hidden="true" /><div><strong>{done}</strong><p>Posted on the owner queue; the dev manager reads it on its next pass.</p></div></div>}
      {!queue && !problem && <p className="empty">Reading the owner queue…</p>}
      {queue && queue.issue === null && !queue.problem && (
        <p className="empty">{emptyQueueText(queue.from)}</p>
      )}
      {queue && queue.issue !== null && (
        <p className="queue-head">
          {open.length ? `${open.length} ask${open.length > 1 ? "s" : ""} wait${open.length > 1 ? "" : "s"} for you` : "Nothing waits for you"} on
          {" "}{queue.url ? <a href={queue.url} target="_blank" rel="noreferrer">#{queue.issue}</a> : `#${queue.issue}`}.
        </p>
      )}
      {asks.map((a) => (
        <section key={a.id} className={`card ask${a.state === "open" ? "" : " answered"}`} aria-label={`Ask ${a.id}`}>
          <h3>
            <span className="dot" aria-hidden="true" style={a.state === "open" ? { background: "var(--waiting)" } : undefined} />
            <code>{a.id}</code>
            {a.state === "open" ? <span className="tag">waiting for you</span> : <span className="tag quiet">answered</span>}
            {a.forProduct && <span className="tag quiet">product</span>}
            {a.created && <span className="ask-age">{ago(a.created)}</span>}
            {a.url && <a className="ask-link" href={a.url} target="_blank" rel="noreferrer">on GitHub</a>}
          </h3>
          <p className="ask-text">{a.text}</p>
          {a.state === "open" ? (
            <>
              {a.options.length > 0 && (
                <span className="options">
                  {a.options.map((o) => <button key={o} className="btn" onClick={() => setConfirm({ ask: a, answer: o })}>{o}</button>)}
                </span>
              )}
              <form className="own" onSubmit={(e) => { e.preventDefault(); const t = (own[a.id] ?? "").trim(); if (t) setConfirm({ ask: a, answer: t }); }}>
                <input aria-label={`Your own answer to ${a.id}`} placeholder="Or type your own answer" value={own[a.id] ?? ""} maxLength={2000}
                  onChange={(e) => setOwn((o) => ({ ...o, [a.id]: e.target.value }))} />
                <button className="btn" type="submit" disabled={!(own[a.id] ?? "").trim()}>Answer</button>
              </form>
            </>
          ) : a.answer && <p className="ask-answer"><strong>Your answer:</strong> {a.answer}</p>}
        </section>
      ))}
      {confirm && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) setConfirm(null); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="answer-title">
            <h3 id="answer-title">Answer {confirm.ask.id}?</h3>
            <p>“{confirm.answer}”</p>
            <p>This runs <code>factory owner answer {confirm.ask.id} …</code> and posts it on the owner queue (#{confirm.ask.issue}) as you.</p>
            <div className="actions">
              <button className="btn" onClick={() => setConfirm(null)} disabled={busy} autoFocus>Cancel</button>
              <button className="btn primary" onClick={() => void answer()} disabled={busy}>{busy ? "Answering…" : "Answer"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- the look ----------------------------------------------------------------------------------------------------------

const CHAT_CSS = String.raw`
.chat { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: min(680px, 92%); background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 12px; padding: 8px 12px; }
.msg.mine { align-self: flex-end; background: var(--bg-active); border-color: transparent; }
.msg.bad { border-color: var(--red-dot); }
.msg p { margin: 0; }
.msg-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px; font-size: 12px; color: var(--text-2); }
.msg-head strong { color: var(--text); font-size: 13px; }
.msg-head time { color: var(--text-3); }
.msg-head a { color: var(--blue-ink); }
.msg-text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px !important; }
.msg-fix { color: var(--text-2); font-size: 13px; margin-top: 4px !important; }
.typing { color: var(--text-2); font-style: italic; margin: 12px 0 0; }
.chat-problem, .send-problem { color: var(--red-ink); margin: 0 0 10px; font-size: 13px; }
.chat-problem strong, .send-problem strong { font-weight: 600; }
form.send { display: flex; flex-direction: column; gap: 6px; }
.send-row { display: flex; gap: 8px; align-items: flex-end; }
.send textarea { flex: 1; resize: vertical; min-height: 44px; max-height: 240px; border: 1px solid var(--border-strong); border-radius: 10px; padding: 10px 12px;
  background: var(--surface); color: var(--text); font: inherit; }
.send textarea:disabled { background: var(--bg-subtle); }
.send .btn { height: 44px; }
.send-hint { font-size: 12px; color: var(--text-3); }
.send-hint code { background: var(--bg-subtle); padding: 0 4px; border-radius: 4px; }
.queue-head { color: var(--text-2); margin: 0; }
.queue-head a { color: var(--blue-ink); }
.ask h3 { flex-wrap: wrap; }
.ask h3 code { color: var(--text); font-size: 13px; background: none; padding: 0; }
.ask .ask-age { color: var(--text-3); font-weight: 400; }
.ask .ask-link { margin-left: auto; color: var(--blue-ink); font-weight: 400; }
.ask.answered { opacity: .75; }
.ask-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 12px; }
.options { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.own { display: flex; gap: 8px; }
.own input { flex: 1; min-width: 0; border: 1px solid var(--border-strong); border-radius: 10px; padding: 0 12px; height: 44px; background: var(--surface); color: var(--text); font: inherit; }
.ask-answer { margin: 0; color: var(--text-2); }
`;

if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.textContent = CHAT_CSS;
  document.head.append(style);
}
