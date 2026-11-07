// Needs attention at the top of Home (#579): each stuck thing with its reason and one action. Release and Close open the
// same confirm as a card's actions (board.tsx AskDialog), Start the same as an agent's page (the app's confirm), Start work
// (#591) a confirm that sends one line to the agent's session as its chat does (POST .../agents/:name/chat, `factory
// say`), and the others open the page they name (its output, the pull request, CI, Health). The words are in
// attention_model.ts.
import { useState } from "react";
import { type AttentionItem, actionOf, attentionDot, sayAsk } from "./attention_model.ts";
import { type Ask, AskDialog, useEscape } from "./board.tsx";
import { ListRow, StatusDot } from "./parts.tsx";
import type { Post, Say } from "./views.tsx";

interface SayAsk {
  agent: string;
  text: string;
}

function SayDialog({ ask, project, post, say, close }: { ask: SayAsk; project: { id: string; name: string }; post: Post; say: Say; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const words = sayAsk(ask.agent, ask.text);
  useEscape(close, busy);
  const go = async (): Promise<void> => {
    if (busy) return; // a second click while it runs does nothing
    setBusy(true);
    try {
      const r = await post(`/api/projects/${encodeURIComponent(project.id)}/agents/${encodeURIComponent(ask.agent)}/chat`, { text: ask.text });
      say(r.ok === true ? { title: `Sent ${ask.text} to ${ask.agent}.`, text: "", tone: "good" }
        : { title: String(r.message ?? "It wasn't sent."), text: String(r.fix ?? ""), tone: "bad" });
    } finally {
      setBusy(false);
      close();
    }
  };
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) close(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="say-ask">
        <h2 id="say-ask">Start work for {ask.agent}?</h2>
        <div className="confirm-what">
          <strong>What happens</strong><p>{words.happens}</p>
          <strong>What doesn't</strong><p>{words.doesNot}</p>
        </div>
        <p className="muted">It runs in {project.name} on the machine that serves this page.</p>
        <div className="actions">
          <button className="btn primary" onClick={() => void go()} disabled={busy} autoFocus>{busy ? "Sending…" : "Start work"}</button>
          <button className="btn plain" onClick={close} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function AttentionList({ items, project, post, say, open, startAgent }: { items: AttentionItem[]; project: { id: string; name: string }; post: Post;
  say: Say; open: (channel: string, find?: string) => void; startAgent?: (name: string) => void }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [sayTo, setSayTo] = useState<SayAsk | null>(null);
  const run = (i: AttentionItem): void => {
    const a = actionOf(i);
    if (a.do === "task") setAsk({ task: { id: a.task, title: i.title.replace(/^(#\d+|b\d+) /, ""), holders: i.agent && i.kind === "task-quiet" ? [i.agent] : [] }, action: a.action });
    else if (a.do === "start") (startAgent ? startAgent(a.agent) : open(`agent:${a.agent}`));
    else if (a.do === "say") setSayTo({ agent: a.agent, text: a.text });
    else open(a.link);
  };
  return (
    <>
      <ul className="lrows" aria-label="Needs attention">
        {items.map((i, n) => (
          <ListRow key={i.id} lead={<StatusDot state={attentionDot(i)} />} title={i.title} sub={i.reason}
            action={<button className={`btn small${n === 0 ? " primary" : ""}`} onClick={() => run(i)}>{i.action.label}</button>} />
        ))}
      </ul>
      {ask && <AskDialog ask={ask} project={project} post={post} say={say} close={() => setAsk(null)} />}
      {sayTo && <SayDialog ask={sayTo} project={project} post={post} say={say} close={() => setSayTo(null)} />}
    </>
  );
}
