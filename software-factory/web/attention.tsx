// Needs attention at the top of Home (#579): each stuck thing with its reason and one action. Release and Close open the
// same confirm as a card's actions (board.tsx AskDialog), Start the same as an agent's page (the app's confirm), Start work
// (#591) a confirm that sends one line to the agent's session as its chat does (POST .../agents/:name/chat, `factory
// say`), and the others open the page they name (its output, the pull request, CI, Health). A question an agent asks in
// its picker (#644) shows each option as a button, whose confirm types that option's number into its session (POST
// .../agents/:name/chat {choose}, `factory say --choose`); a loop that can't start for leftover changes in its folder
// (#640) has Save them aside and start (POST .../agents/:name/start {confirm, stash}). The words are in attention_model.ts.
import { useState } from "react";
import { type AttentionAction, type AttentionItem, attentionDot, buttonsOf, chooseAsk, doOf, sayAsk, stashAsk } from "./attention_model.ts";
import { type Ask, AskDialog, useEscape } from "./board.tsx";
import { ListRow, StatusDot } from "./parts.tsx";
import type { Post, Say } from "./views.tsx";

/** A confirm that posts one request about an agent: a line to its session, an answer to its picker, or a start that saves
 *  its leftover changes aside first. */
interface AgentAsk {
  agent: string;
  heading: string;
  button: string;
  words: { happens: string; doesNot: string };
  path: "chat" | "start";
  body: Record<string, unknown>;
  done: string;
}

function AgentDialog({ ask, project, post, say, close }: { ask: AgentAsk; project: { id: string; name: string }; post: Post; say: Say; close: () => void }) {
  const [busy, setBusy] = useState(false);
  useEscape(close, busy);
  const go = async (): Promise<void> => {
    if (busy) return; // a second click while it runs does nothing
    setBusy(true);
    try {
      const r = await post(`/api/projects/${encodeURIComponent(project.id)}/agents/${encodeURIComponent(ask.agent)}/${ask.path}`, ask.body);
      say(r.ok === true ? { title: ask.done, text: typeof r.output === "string" ? r.output : "", tone: "good" }
        : { title: String(r.message ?? "It didn't run."), text: [r.fix, r.output].filter((x) => typeof x === "string" && x).join("\n\n"), tone: "bad" });
    } finally {
      setBusy(false);
      close();
    }
  };
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) close(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="agent-ask">
        <h2 id="agent-ask">{ask.heading}</h2>
        <div className="confirm-what">
          <strong>What happens</strong><p>{ask.words.happens}</p>
          <strong>What doesn't</strong><p>{ask.words.doesNot}</p>
        </div>
        <p className="muted">It runs in {project.name} on the machine that serves this page.</p>
        <div className="actions">
          <button className="btn primary" onClick={() => void go()} disabled={busy} autoFocus>{busy ? "Sending…" : ask.button}</button>
          <button className="btn plain" onClick={close} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function AttentionList({ items, project, post, say, open, startAgent }: { items: AttentionItem[]; project: { id: string; name: string }; post: Post;
  say: Say; open: (channel: string, find?: string) => void; startAgent?: (name: string) => void }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [agentAsk, setAgentAsk] = useState<AgentAsk | null>(null);
  const run = (i: AttentionItem, action: AttentionAction): void => {
    const a = doOf(action);
    if (a.do === "task") setAsk({ task: { id: a.task, title: i.title.replace(/^(#\d+|b\d+) /, ""), holders: i.agent && i.kind === "task-quiet" ? [i.agent] : [] }, action: a.action });
    else if (a.do === "start" && a.stash) {
      setAgentAsk({ agent: a.agent, heading: `Save ${a.agent}'s leftover changes aside and start it?`, button: "Save them aside and start",
        words: stashAsk(a.agent), path: "start", body: { confirm: true, stash: true }, done: `Saved the changes aside and started ${a.agent}.` });
    } else if (a.do === "start") (startAgent ? startAgent(a.agent) : open(`agent:${a.agent}`));
    else if (a.do === "say") {
      setAgentAsk({ agent: a.agent, heading: `Start work for ${a.agent}?`, button: "Start work", words: sayAsk(a.agent, a.text), path: "chat",
        body: { text: a.text }, done: `Sent ${a.text} to ${a.agent}.` });
    } else if (a.do === "choose") {
      setAgentAsk({ agent: a.agent, heading: `Answer ${a.agent}: ${a.label}?`, button: "Answer", words: chooseAsk(a.agent, a.key, a.label), path: "chat",
        body: { choose: a.key }, done: `Answered ${a.agent}: ${a.label}.` });
    } else if (a.do === "open") open(a.link);
  };
  return (
    <>
      <ul className="lrows" aria-label="Needs attention">
        {items.map((i, n) => {
          const buttons = buttonsOf(i);
          return (
            <ListRow key={i.id} lead={<StatusDot state={attentionDot(i)} />} title={i.title} sub={i.reason}
              action={buttons.length ? <span className="actions">{buttons.map((b, k) => (
                <button key={`${b.kind}:${b.key ?? k}`} className={`btn small${n === 0 && k === 0 ? " primary" : ""}`} onClick={() => run(i, b)}>{b.label}</button>
              ))}</span> : undefined} />
          );
        })}
      </ul>
      {ask && <AskDialog ask={ask} project={project} post={post} say={say} close={() => setAsk(null)} />}
      {agentAsk && <AgentDialog ask={agentAsk} project={project} post={post} say={say} close={() => setAgentAsk(null)} />}
    </>
  );
}
