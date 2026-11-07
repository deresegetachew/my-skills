// An epic's page and the "New epic" form (#440), from the owner's reference design (Epic.dc.html, Epics.dc.html): the
// stage bar, the tasks, where it is written down, and the "Talk about this" box, whose thread is the owner's messages
// about the epic to the product owner or the dev manager, and their answers. Nothing here shows a command.
import { type FormEvent, useContext, useState } from "react";
import { AttentionContext, StuckMark } from "./attention_context.tsx";
import { Avatar } from "./avatar_view.tsx";
import { type Chat, useChat } from "./chat.tsx";
import { itemLabel } from "./chat_model.ts";
import { epicCostFacts } from "./cost_model.ts";
import { CostFacts, useCosts } from "./costs.tsx";
import { Cited } from "./docs.tsx";
import type { DocPage } from "./docs_model.ts";
import { epicThread, stageSteps, writtenDown } from "./epics_model.ts";
import { StatusDot, type Talker, Tabs, TalkBox } from "./parts.tsx";
import type { EpicRow, TaskRow } from "./views_model.ts";

export type { Talker };

interface Common {
  token: string;
  project: string;
  /** The product owner and the dev manager of this project, whom the box can talk to. */
  talkers: Talker[];
  docs: DocPage[] | undefined;
  open: (channel: string, find?: string) => void;
}

/** What a task of the epic shows: its title and state from the open tasks, or "done" when it is no longer open. */
function taskLine(t: { id: string; done: boolean }, tasks: TaskRow[]): { title: string; state: string; dot: "working" | "waiting" | "idle"; holder: string | null } {
  const row = tasks.find((x) => x.id === t.id);
  if (row) return { title: row.title, state: row.stateText, dot: row.state === "ready" ? "waiting" : "working", holder: row.holders[0] ?? null };
  return { title: "", state: t.done ? "Done" : "Not an open task", dot: "idle", holder: null };
}

function Thread({ chat, epic }: { chat: Chat; epic: EpicRow }) {
  const items = epicThread(chat.items, epic.id);
  if (!chat.loaded) return <p className="empty">Reading the thread…</p>;
  if (!items.length) return <p className="empty">Nothing yet. Use "Talk about this" to ask or tell them something.</p>;
  return (
    <ul className="ethread" aria-label="Thread">
      {items.map((x) => {
        const l = itemLabel(x, "");
        return (
          <li key={x.id}>
            {l.mine ? <span className="you">You</span> : <Avatar name={x.from} size={28} />}
            <p><strong>{l.who}</strong> {x.text.replace(/^About epic #\d+ \([^)]*\): /, "")}{l.what ? ` (${l.what})` : ""}</p>
          </li>
        );
      })}
      {chat.pending && <li className="empty">They are answering…</li>}
    </ul>
  );
}

type Tab = "overview" | "tasks" | "thread";

export function EpicPage({ epic, tasks, token, project, talkers, docs, open, back }: Common & { epic: EpicRow; tasks: TaskRow[]; back: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [to, setTo] = useState(talkers[0]?.name ?? "");
  const chat = useChat(token, project, to);
  const steps = stageSteps(epic.stage);
  const progress = epic.all ? `${epic.done} of ${epic.all} tasks done` : "No tasks yet";
  const stuck = useContext(AttentionContext).tasks[epic.id]; // Needs attention (#579)
  const lines = epic.tasks.map((t) => ({ t, ...taskLine(t, tasks) }));
  const list = tab === "tasks" ? lines : lines.slice(0, 8);
  const links = writtenDown(epic, docs ?? []);
  const latest = epicThread(chat.items, epic.id).filter((x) => x.kind !== "owner").at(-1);
  const cost = useCosts(project, token)?.epics.find((e) => e.epic === epic.id) ?? null; // what its tasks took (#580)
  return (
    <div className="body epage">
      <button className="link" onClick={back}>‹ All epics</button>
      <div className="ehead">
        <header>
          <span className="empty">Epic #{epic.id}</span>
          <h2><Cited text={epic.title} docs={docs} open={open} /></h2>
          {epic.summary && <p>{epic.summary}</p>}
          <span className="vstate"><StatusDot state={epic.stage === "building" ? "working" : "idle"} />{epic.stageText.charAt(0).toUpperCase() + epic.stageText.slice(1)} · {progress}</span>
          {stuck && <StuckMark reason={stuck} />}
        </header>
        <TalkBox item={{ kind: "epic", id: epic.id, title: epic.title }} to={to} setTo={setTo} chat={chat} talkers={talkers} />
      </div>
      <Tabs label="Epic views" value={tab} onChange={setTab}
        tabs={[{ id: "overview", label: "Overview" }, { id: "tasks", label: "Tasks" }, { id: "thread", label: "Thread" }]} />
      <ol aria-label="Stage" className="estages">
        {steps.map((s) => (
          <li key={s.stage} aria-current={s.state === "now" ? "step" : undefined} className={s.state}>
            <span className="bar" /><span className="name">{s.name}</span>
          </li>
        ))}
      </ol>
      {epic.stage === "parked" && <p className="empty">Parked: not being worked on now.</p>}
      {tab !== "thread" && (
        <div className="ecols">
          <section aria-label="Tasks">
            <h3>Tasks</h3>
            {!lines.length ? <p className="empty">Not split into tasks yet.</p> : (
              <ul className="etasklist">
                {list.map((l) => (
                  <li key={l.t.id}>
                    <span className="who">{l.holder ? <Avatar name={l.holder} size={28} /> : null}</span>
                    <button className="link" onClick={() => open("view:tasks", `#${l.t.id}`)}>{l.title || "Task"} <span className="empty">#{l.t.id}</span></button>
                    <span className="vstate"><StatusDot state={l.dot} />{l.state}</span>
                  </li>
                ))}
              </ul>
            )}
            {tab === "overview" && lines.length > list.length && <button className="link" onClick={() => setTab("tasks")}>Show all {lines.length} tasks ›</button>}
          </section>
          {tab === "overview" && (
            <aside>
              <section>
                <h3>Where it's written down</h3>
                {!links.length && <p className="empty">Nothing linked yet.</p>}
                {links.map((l) => l.channel
                  ? <button key={l.name} className="elink" onClick={() => open(l.channel ?? "")}><span>{l.name}</span><span className="empty">{l.tag}</span></button>
                  : <span key={l.name} className="elink"><span>{l.name}</span><span className="empty">{l.tag}</span></span>)}
              </section>
              {cost && <CostFacts title="What it took" facts={epicCostFacts(cost)} />}
              <section>
                <h3>Latest on the thread</h3>
                {latest ? <p className="vsub"><strong>{latest.from}</strong> {latest.text}</p> : <p className="empty">Nothing yet.</p>}
              </section>
            </aside>
          )}
        </div>
      )}
      {tab === "thread" && <Thread chat={chat} epic={epic} />}
    </div>
  );
}

/** The "New epic" form: the owner's ask, handed to the product owner, who investigates it and asks what is unclear. */
export function NewEpic({ token, project, talkers, close }: Pick<Common, "token" | "project" | "talkers"> & { close: () => void }) {
  const po = talkers.find((t) => t.role === "product-owner");
  const chat = useChat(token, project, po?.name ?? "");
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || !po) return;
    const p = await chat.send(`New epic: ${title.trim()}.${why.trim() ? ` Why: ${why.trim()}` : ""} Please investigate it, ask me what is unclear, then propose the PRD change.`);
    if (p) setProblem(`${p.message} ${p.fix}`);
    else setSent(true);
  };
  if (!po) return <p className="empty">This project has no product owner to give an epic to yet.</p>;
  return (
    <form className="enew" aria-labelledby="ne-h" onSubmit={(e) => void submit(e)}>
      <div className="ehead-row"><Avatar name={po.name} role={po.role} size={36} />
        <div><h3 id="ne-h">New epic</h3><span className="vsub">{po.name} investigates it, asks you what is unclear, then proposes the PRD change.</span></div></div>
      <label>What do you want?<input type="text" aria-label="Epic title" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Why, in a sentence or two<textarea aria-label="Why" rows={3} value={why} onChange={(e) => setWhy(e.target.value)} /></label>
      {problem && <p className="send-problem" role="alert">{problem}</p>}
      {sent && <p role="status">Given to {po.name}. Their answer is in their channel.</p>}
      <span className="send-row">
        <button className="btn primary" type="submit" disabled={!title.trim() || chat.pending || sent}>Give it to {po.name}</button>
        <button className="btn" type="button" onClick={close}>{sent ? "Close" : "Cancel"}</button>
      </span>
      <span className="send-hint">Nothing is built until you accept its PRD change.</span>
    </form>
  );
}

export const EPICS_CSS = String.raw`
.epage { gap: 18px; }
.ehead { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; justify-content: space-between; }
.ehead header { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.ehead h2 { margin: 0; font-size: 22px; }
.ehead p { margin: 0; color: var(--text-2); line-height: 1.5; }
.enew { max-width: 640px; padding: 8px 0; display: flex; flex-direction: column; gap: 10px; }
.enew label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; }
.enew input, .enew textarea { border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); border-radius: 10px; padding: 10px 12px; font: inherit; font-weight: 400; }
.enew h3 { margin: 0; font-size: 15px; }
.ehead-row { display: flex; align-items: center; gap: 12px; }
.estages { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
.estages li { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--text-3); }
.estages .bar { height: 3px; border-radius: 999px; background: var(--border); }
.estages li.done .bar { background: var(--text-3); }
.estages li.done { color: var(--text-2); }
.estages li.now .bar { background: var(--text); }
.estages li.now { color: var(--text); font-weight: 700; }
.ecols { display: flex; flex-wrap: wrap; gap: 40px; align-items: flex-start; }
.ecols > section { flex: 999 1 420px; min-width: 0; }
.ecols > aside { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 24px; }
.ecols h3 { margin: 0 0 6px; font-size: 15px; }
.etasklist { list-style: none; margin: 0; padding: 0; }
.etasklist li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.etasklist .who { width: 28px; flex-shrink: 0; display: flex; }
.etasklist .link { flex: 1; text-align: left; min-width: 0; }
.elink { display: flex; justify-content: space-between; gap: 8px; width: 100%; min-height: 44px; align-items: center; background: none; border: 0; border-bottom: 1px solid var(--border); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.ethread { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.ethread li { display: flex; gap: 10px; align-items: flex-start; }
.ethread p { margin: 0; line-height: 1.5; }
.ethread .you { width: 28px; height: 28px; border-radius: 50%; background: var(--bg-active); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; }
.eboard { display: grid; grid-template-columns: repeat(6, minmax(160px, 1fr)); gap: 16px; min-width: 1000px; align-items: start; }
.eboard h4 { margin: 0 0 10px; font-size: 13px; padding-bottom: 8px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: center; }
.eboard article { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px; }
.eboard article .link { text-align: left; }
@media (max-width: 760px) { .estages { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
`;
