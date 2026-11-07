// The parts every screen shares (#450), from the owner's design (docs/design/web-ui/Palette.dc.html and RULES.md):
// underline tabs, filter chips, the list row (avatar, title, one grey line, one status, one action), the "Talk about
// this" box and the confirm-with-preconditions dialog. Their rules are in parts_model.ts; nothing here shows a command.
import { type FormEvent, type ReactNode, useState } from "react";
import { Avatar } from "./avatar_view.tsx";
import type { Chat } from "./chat.tsx";
import { type Check, type ConfirmSpec, confirmState, type TalkItem, talkText } from "./parts_model.ts";

/** A state's dot; "red" is the one accent for the single thing that needs the owner, and "ink" a finished thing that
 * failed (dark, so a list of results stays calm). */
export type DotState = "working" | "waiting" | "idle" | "down" | "red" | "ink";

/** An 8px dot in a state's colour, beside words that say the same. */
export function StatusDot({ state }: { state: DotState }) {
  return <span className={`sdot ${state}`} aria-hidden="true" />;
}

/** Underline tabs: the selected one is underlined and bold. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string; count?: number }>; value: T;
  onChange: (id: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="tabs">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          {t.label}{t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Filter chips: the selected one is a solid pill; the others white, each with its category's dot. */
export function Chips<T extends string>({ chips, value, onChange, label }: { chips: Array<{ id: T; label: string; dot?: string }>; value: T;
  onChange: (id: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="chips">
      {chips.map((c) => (
        <button key={c.id} className="chip" aria-pressed={c.id === value} onClick={() => onChange(c.id)}>
          {c.dot && c.id !== value && <span className="chip-dot" style={{ background: `var(--${c.dot}-dot)` }} aria-hidden="true" />}
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** One row of a list: avatar, title, one grey line, one status, one action. Everything else is on the item's page. */
export function ListRow({ avatar, lead, title, sub, status, action }: { avatar?: { name: string; role?: string } | null;
  /** In the avatar's place, for a row about a thing (an artifact's icon). */
  lead?: ReactNode; title: ReactNode; sub?: ReactNode; status?: { state: DotState; text: string } | null; action?: ReactNode }) {
  return (
    <li className="lrow">
      <span className="lrow-who">{lead ?? (avatar ? <Avatar name={avatar.name} role={avatar.role} size={32} /> : null)}</span>
      <span className="lrow-main"><span className="lrow-title">{title}</span>{sub && <span className="lrow-sub">{sub}</span>}</span>
      {status && <span className="lrow-status"><StatusDot state={status.state} />{status.text}</span>}
      {action && <span className="lrow-action">{action}</span>}
    </li>
  );
}

export interface Talker {
  name: string;
  role: string;
  words: string;
}

/** "Talk about this": To the product owner or the dev manager, one line, Send. The line goes on the item's thread (the
 * chat with whom it is sent to, led by what it is about); the answer shows on the page and in the Inbox. The page owns
 * the chat (`useChat` with `to`), so it can show the thread. */
export function TalkBox({ item, talkers, to, setTo, chat }: { item: TalkItem; talkers: Talker[]; to: string; setTo: (name: string) => void;
  chat: Chat }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!talkers.length) return <p className="empty">This project has no product owner or dev manager to talk to yet.</p>;
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!text.trim() || busy || chat.pending) return;
    setBusy(true);
    setProblem(null);
    const p = await chat.send(talkText(item, text));
    setBusy(false);
    if (p) setProblem(`${p.message} ${p.fix}`);
    else setText("");
  };
  const what = item.kind === "pr" ? "pull request" : item.kind === "signoff" ? "item" : item.kind;
  return (
    <form className="talk" aria-labelledby="talk-h" onSubmit={(e) => void submit(e)}>
      <h2 id="talk-h">Talk about this</h2>
      <div role="radiogroup" aria-label="To" className="talk-to">
        <span className="talk-label">To</span>
        {talkers.map((t) => (
          <button key={t.name} type="button" role="radio" aria-checked={t.name === to} onClick={() => setTo(t.name)}>
            <Avatar name={t.name} role={t.role} size={28} />
            <span><strong>{t.name}</strong> <span className="muted">({t.words})</span></span>
          </button>
        ))}
      </div>
      {problem && <p className="send-problem" role="alert">{problem}</p>}
      <span className="talk-row">
        <input type="text" aria-label={`Your message about ${item.kind === "decision" ? "decision " : "#"}${item.id}`} placeholder="Ask or tell them something"
          maxLength={1500} value={text} onChange={(e) => setText(e.target.value)} disabled={busy || chat.pending} />
        <button className="btn primary" type="submit" disabled={busy || chat.pending || !text.trim()}>{busy ? "Sending…" : "Send"}</button>
      </span>
      <span className="talk-hint">Your message goes on this {what}'s thread; their answer appears here and in your Inbox.</span>
    </form>
  );
}

function CheckRow({ c, onFix }: { c: Check; onFix?: (c: Check) => void }) {
  return (
    <li className="check">
      <StatusDot state={c.met ? "working" : "down"} />
      <span className="check-main"><strong>{c.title}</strong>{c.sub && <span>{c.sub}</span>}</span>
      <span className="check-end">
        {c.met ? <span className="muted">Done</span> : c.waiting ? <span className="muted" role="status">{c.waiting}</span> : c.fix && onFix ? <button className="btn" type="button" onClick={() => onFix(c)}>{c.fix}</button> : <span className="muted">Not yet</span>}
      </span>
    </li>
  );
}

/** The confirm for anything that removes, stops or merges: its preconditions as a checklist (the button stays off until
 * each is met, an unmet one with its own fix button), what will happen and what won't, and for a serious one the name
 * typed. */
export function ConfirmDialog({ spec, busy, onConfirm, onCancel, onFix }: { spec: ConfirmSpec; busy: boolean; onConfirm: () => void;
  onCancel: () => void; onFix?: (c: Check) => void }) {
  const [typed, setTyped] = useState("");
  const st = confirmState(spec, typed);
  const n = spec.checks.length;
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-h">
        <h2 id="confirm-h">{spec.title}</h2>
        {n > 0 && (
          <>
            <p className="muted">{n === 1 ? "This must be true before it turns on." : `All ${n} must be true before it turns on.`}</p>
            <ul className="checks">{spec.checks.map((c) => <CheckRow key={c.title} c={c} onFix={onFix} />)}</ul>
          </>
        )}
        <div className="confirm-what">
          <strong>What happens</strong><p>{spec.happens}</p>
          <strong>What doesn't</strong><p>{spec.doesNot}</p>
        </div>
        {spec.typeName !== undefined && (
          <label className="confirm-name">Type {spec.typeName} to confirm
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={`Type ${spec.typeName} to confirm`} />
          </label>
        )}
        <div className="actions">
          <button className={`btn ${spec.tone}`} onClick={onConfirm} disabled={busy || !st.ready}>{busy ? "Working…" : spec.action}</button>
          <button className="btn plain" onClick={onCancel} disabled={busy} autoFocus>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export const PARTS_CSS = String.raw`
.sdot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: var(--idle); }
.sdot.working { background: var(--working); }
.sdot.waiting { background: var(--waiting); }
.sdot.down { background: var(--down); }
.sdot.red { background: var(--red-dot); }
.sdot.ink { background: var(--text); }

.tabs { display: flex; gap: 28px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 0; font: inherit; color: var(--text-2); cursor: pointer;
  white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.tabs button[aria-selected="true"] { border-bottom-color: var(--text); color: var(--text); font-weight: 600; }
.tab-count { color: var(--text-3); font-weight: 400; }

.chips { display: flex; flex-wrap: wrap; gap: 10px; }
.chip { height: 40px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
  font: inherit; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--primary); color: var(--on-primary); border-color: var(--primary); font-weight: 600; }
.chip-dot { width: 9px; height: 9px; border-radius: 50%; }

.lrows { list-style: none; margin: 0; padding: 0; }
.lrow { display: flex; align-items: center; gap: 14px; padding: 14px 4px; border-bottom: 1px solid var(--border); }
.lrow-who { width: 32px; flex: none; display: flex; }
.lrow-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.lrow-title { font-weight: 600; overflow-wrap: anywhere; }
.lrow-sub { color: var(--text-2); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrow-status { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 13px; white-space: nowrap; }
.lrow-action { flex: none; }

.talk { border: 1px solid var(--border); border-radius: 14px; background: var(--surface); padding: 18px; display: flex; flex-direction: column; gap: 12px;
  flex: 0 1 360px; min-width: 0; }
.talk h2 { margin: 0; font-size: 15px; }
.talk-to { display: flex; flex-direction: column; gap: 6px; }
.talk-label { font-size: 13px; color: var(--text-3); }
.talk-to button { min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 4px 10px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.talk-to button[aria-checked="true"] { border: 1.5px solid var(--text); background: var(--bg-subtle); }
.talk-row { display: flex; gap: 8px; }
.talk-row input { flex: 1; min-width: 0; height: 44px; border: 1px solid var(--border-strong); border-radius: 10px; padding: 0 12px; font: inherit;
  background: var(--surface); color: var(--text); }
.talk-hint { font-size: 13px; color: var(--text-3); line-height: 1.5; }

.checks { list-style: none; margin: 0; padding: 0; }
.check { display: flex; align-items: center; gap: 16px; padding: 12px 4px; border-bottom: 1px solid var(--border); }
.check-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.check-main span { color: var(--text-2); font-size: 13px; line-height: 1.45; }
.check-end { flex: none; display: flex; justify-content: flex-end; font-size: 13px; }
.confirm-what { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 13px; }
.confirm-what p { margin: 0; color: var(--text-2); line-height: 1.5; }
.confirm-name { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-2); }
.confirm-name input { height: 44px; max-width: 260px; border: 1px solid var(--border-strong); border-radius: 10px; padding: 0 12px;
  background: var(--surface); color: var(--text); font: inherit; }
@media (max-width: 760px) { .confirm-what { grid-template-columns: 1fr; } }
`;
