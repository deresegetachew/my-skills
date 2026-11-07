// Needs attention at the top of Home (#579): each stuck thing with its reason and one action. Release and Close open the
// same confirm as a card's actions (board.tsx AskDialog), Start the same as an agent's page (the app's confirm), and the
// others open the page they name (its output, the pull request, CI, Health). The words are in attention_model.ts.
import { useState } from "react";
import { type AttentionItem, actionOf, attentionDot } from "./attention_model.ts";
import { type Ask, AskDialog } from "./board.tsx";
import { ListRow, StatusDot } from "./parts.tsx";
import type { Post, Say } from "./views.tsx";

export function AttentionList({ items, project, post, say, open, startAgent }: { items: AttentionItem[]; project: { id: string; name: string }; post: Post;
  say: Say; open: (channel: string, find?: string) => void; startAgent?: (name: string) => void }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const run = (i: AttentionItem): void => {
    const a = actionOf(i);
    if (a.do === "task") setAsk({ task: { id: a.task, title: i.title.replace(/^(#\d+|b\d+) /, ""), holders: i.agent && i.kind === "task-quiet" ? [i.agent] : [] }, action: a.action });
    else if (a.do === "start") (startAgent ? startAgent(a.agent) : open(`agent:${a.agent}`));
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
    </>
  );
}
