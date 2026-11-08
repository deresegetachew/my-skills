// Sign-off and testing (#454), from the owner's design (docs/design/web-ui/Signoff.dc.html and SignoffItem.dc.html): the
// list of what only a person can check, in tabs and groups, and an item's page with its steps (what you should see, pass
// or fail, a note), its outcome, its history and the "Talk about this" box. The rules are in signoff_model.ts; the data
// and the actions go through GET|POST /api/projects/:p/signoff. Nothing here shows a command.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Attachments } from "./attachments.tsx";
import { Avatar } from "./avatar_view.tsx";
import { useChat } from "./chat.tsx";
import { itemLabel } from "./chat_model.ts";
import { PageHead, PlusIcon } from "./page_head.tsx";
import { type DotState, ListRow, StatusDot, type Talker, Tabs, TalkBox } from "./parts.tsx";
import { itemThread, talkText } from "./parts_model.ts";
import { addOutcome, type Dot, filterGroups, groupOf, historyOf, listOf, type Mark, noteOf, outcomeOf, passWhen, type SignoffItem, statusOf, stepsOf, type Tab, taskInputOk, taskLabel, failedAsk,
  titleOf, whenText } from "./signoff_model.ts";
import type { Post, Say } from "./views.tsx";

interface Problem {
  code: string;
  message: string;
  fix: string;
}

interface Queue {
  queue: number | null;
  items: SignoffItem[];
  problems: Problem[];
}

interface Props {
  project: { id: string; name: string };
  /** The item whose page is open, else the list. */
  id: string | null;
  token: string;
  talkers: Talker[];
  get: <T>(path: string) => Promise<T>;
  post: Post;
  say: Say;
  open: (channel: string, find?: string) => void;
  onMenu: () => void;
}

/** The model's dot as drawn: a failed result is dark, so the one red stays for what needs the owner. */
function drawn(d: Dot): DotState {
  return d === "down" ? "ink" : d;
}

function Problems({ list }: { list: Problem[] }) {
  return (
    <>
      {list.map((p) => (
        <div key={p.code + p.message} className="notice bad" role="alert">
          <StatusDot state="red" /><div><strong>{p.message}</strong><p>{p.fix}</p></div>
        </div>
      ))}
    </>
  );
}

/** Says how an action went: nothing on success but `done`, else its message and fix. */
function told(r: Record<string, unknown>, say: Say, done: string): boolean {
  if (r.ok === true) {
    say({ title: done, text: "", tone: "good" });
    return true;
  }
  say({ title: String(r.message ?? "It didn't save."), text: String(r.fix ?? ""), tone: "bad" });
  return false;
}

export function SignoffPage(p: Props) {
  const [data, setData] = useState<Queue | null>(null);
  const base = `/api/projects/${encodeURIComponent(p.project.id)}/signoff`;
  const load = useCallback(() => {
    p.get<Queue>(base).then(setData).catch(() => setData({ queue: null, items: [], problems: [{ code: "unreachable",
      message: "The server can't be reached.", fix: "Check that the web UI is still running on its machine, then reload the page." }] }));
  }, [p.get, base]);
  useEffect(load, [load]);
  if (p.id !== null) {
    const item = data?.items.find((x) => x.id === p.id);
    if (!data || !item) {
      return (
        <>
          <PageHead title="Sign-off and testing" onMenu={p.onMenu} />
          <div className="body">
            <button className="link back" onClick={() => p.open("page:signoff")}>‹ Sign-off and testing</button>
            {!data ? <p className="empty">Reading the sign-off queue…</p>
              : <><Problems list={data.problems} />{!data.problems.length && <p className="empty">There is no item {p.id} in the queue.</p>}</>}
          </div>
        </>
      );
    }
    return <ItemPage key={item.id} {...p} item={item} base={base} reload={load} />;
  }
  return <ListPage {...p} data={data} base={base} reload={load} />;
}

// --- the list -----------------------------------------------------------------------------------------------------------

function ListPage(p: Props & { data: Queue | null; base: string; reload: () => void }) {
  const [tab, setTab] = useState<Tab>("all");
  const [adding, setAdding] = useState(false);
  const list = listOf(p.data?.items ?? [], new Date());
  const groups = filterGroups(list, tab);
  return (
    <>
      <PageHead title="Sign-off and testing" purpose={p.data ? list.line : "What only a person can check."} onMenu={p.onMenu}
        actions={<button className="btn primary" onClick={() => setAdding(true)}><PlusIcon />Add something to check</button>} />
      <div className="body">
        {p.data && <Problems list={p.data.problems} />}
        <Tabs label="Filter" value={tab} onChange={setTab} tabs={list.tabs.map((t) => ({ id: t.id, label: t.label, count: t.count }))} />
        {!p.data && <p className="empty">Reading the sign-off queue…</p>}
        {p.data && !p.data.problems.length && !list.groups.length && (
          <p className="empty">When a task needs a person's eyes, the product owner adds it here. Or add one yourself.</p>)}
        {p.data && list.groups.length > 0 && !groups.length && <p className="empty">Nothing here now.</p>}
        {groups.map((g) => (
          <section key={g.id} className="sgroup" aria-labelledby={`sg-${g.id}`}>
            <h2 id={`sg-${g.id}`}>{g.title} <span className="tab-count">{g.rows.length}</span></h2>
            <ul className="lrows">
              {g.rows.map((r) => (
                <ListRow key={r.id} avatar={r.who ? { name: r.who } : null} sub={r.sub} status={{ state: drawn(r.status.dot), text: r.status.text }}
                  title={<button className="link srow-title" onClick={() => p.open(`signoff:${r.id}`)}>{r.title}</button>}
                  action={<button className={`btn small${r.primary ? " primary" : ""}`} onClick={() => p.open(`signoff:${r.id}`)}>{r.action}</button>} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {adding && <AddDialog base={p.base} post={p.post} say={p.say} close={(added) => { setAdding(false); if (added) p.reload(); }} />}
    </>
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

function AddDialog({ base, post, say, close }: { base: string; post: Post; say: Say; close: (added: boolean) => void }) {
  const [check, setCheck] = useState("");
  const [task, setTask] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix: string } | null>(null);
  const id = name.trim() || slug(check.split("\n")[0] ?? "");
  const ready = check.trim() !== "" && taskInputOk(task) && /^[A-Za-z0-9][\w.-]{0,63}$/.test(id);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const r = await post(base, { id, task: task.trim(), check: check.trim() });
    setBusy(false);
    // a failed add keeps the dialog open with what was typed, and says what went wrong and what to do (#552)
    const out = addOutcome(r);
    if (!out.close) {
      setError(out.error);
      return;
    }
    say({ title: "Added to the sign-off queue.", text: "", tone: "good" });
    close(true);
  };
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) close(false); }}>
      <form className="dialog sform" role="dialog" aria-modal="true" aria-labelledby="add-h" onSubmit={(e) => void submit(e)}>
        <h2 id="add-h">Add something to check</h2>
        <p className="muted">Something a person has to look at before a task counts as done. It goes on the sign-off queue for you or the product
          owner to check.</p>
        <label>What should a person check?
          <textarea rows={3} value={check} onChange={(e) => setCheck(e.target.value)} placeholder="Open the guide in Arabic and read the warning" autoFocus />
        </label>
        <label>For task
          <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="b12 or 437" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <span className="muted">Its number as the board shows it: b12 for a task made on the board, 437 for an issue.</span>
        </label>
        <label>Short name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={id || "arabic-warning"} />
          <span className="muted">Letters, digits and dashes. It names the item on the queue.</span>
        </label>
        {error && (
          <div className="notice bad" role="alert">
            <StatusDot state="red" /><div><strong>{error.message}</strong><p>{error.fix}</p></div>
          </div>
        )}
        <div className="actions">
          <button className="btn primary" type="submit" disabled={!ready || busy}>{busy ? "Adding…" : "Add it"}</button>
          <button className="btn plain" type="button" onClick={() => close(false)} disabled={busy}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

// --- an item ------------------------------------------------------------------------------------------------------------

const HEAD: Record<string, string> = {
  proposed: "Proposed · waiting for you to confirm the plan",
  confirmed: "Confirmed · waiting for your result",
  open: "To check · waiting for your result",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
};

const GROUP_TITLE: Record<string, string> = { proposed: "Proposed", ready: "Ready to test", results: "Results" };

function ItemPage(p: Props & { item: SignoffItem; base: string; reload: () => void }) {
  const { item } = p;
  const now = new Date();
  const steps = stepsOf(item.text);
  const [marks, setMarks] = useState<Mark[]>(() => steps.map(() => ({ result: null, note: "" })));
  const [done, setDone] = useState<boolean[]>(() => steps.map(() => false));
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState(p.talkers[0]?.name ?? "");
  const chat = useChat(p.token, p.project.id, to);
  const po = p.talkers.find((t) => t.role === "product-owner");
  const poChat = useChat(p.token, p.project.id, po?.name ?? "");
  const group = groupOf(item);
  const ready = group === "ready";
  const title = titleOf(item);
  const talkItem = { kind: "signoff", id: item.id, title };
  const thread = itemThread(chat.items, talkItem).filter((x) => x.kind !== "owner");
  const status = statusOf(item);
  const headDot: DotState = group === "proposed" || ready ? "red" : drawn(status.dot);
  const checked = steps.filter((_, i) => done[i] || marks[i]?.result).length;
  const last = item.results.at(-1);
  const when = (iso: string): string => {
    const w = whenText(iso, now);
    return !w ? "" : /^\d/.test(w) ? `on ${w}` : w.charAt(0).toLowerCase() + w.slice(1);
  };

  const setMark = (i: number, m: Partial<Mark>): void => setMarks((all) => all.map((x, j) => (j === i ? { ...x, ...m } : x)));
  const act = async (path: string, body: unknown, doneText: string): Promise<boolean> => {
    setBusy(true);
    const r = await p.post(`${p.base}/${encodeURIComponent(item.id)}/${path}`, body);
    setBusy(false);
    const ok = told(r, p.say, doneText);
    if (ok) p.reload();
    return ok;
  };
  const note = noteOf(steps, marks, extra);
  const failed = async (): Promise<void> => {
    if (!(await act("result", { outcome: "fail", note }, "Recorded as failed."))) return;
    if (po) await poChat.send(talkText(talkItem, failedAsk(item, note)));
  };
  const askChange = (): void => {
    if (po) setTo(po.name);
    document.querySelector<HTMLInputElement>(".talk input")?.focus();
  };

  return (
    <>
      <PageHead onMenu={p.onMenu} title={title}
        before={(
          <nav aria-label="Breadcrumb" className="crumbs">
            <button className="link" onClick={() => p.open("page:signoff")}>Sign-off and testing</button><span aria-hidden="true">/</span>
            <span>{GROUP_TITLE[group]}</span>
          </nav>
        )} />
      <div className="body sitem">
        <div className="shead">
          <header>
            <span className="vstate"><StatusDot state={headDot} />{HEAD[item.state] ?? status.text}</span>
            <div className="sby">
              {item.by && <Avatar name={item.by} size={32} />}
              <p>
                {item.by ? <strong>{item.by}</strong> : "Someone"} {item.kind === "testplan" ? "proposed this" : "added this"} {when(item.at)}.
                {item.task && <> It is for <button className="link" onClick={() => p.open("view:tasks", taskLabel(item.task as string))}>task {taskLabel(item.task)}</button>.</>}
              </p>
            </div>
          </header>
          <TalkBox item={talkItem} talkers={p.talkers} to={to} setTo={setTo} chat={chat} />
        </div>

        <div className="scols">
          <section aria-labelledby="plan-h" className="splan">
            <div className="splan-head">
              <h2 id="plan-h">{item.kind === "testplan" ? "Test plan" : "What to check"}</h2>
              {steps.length > 0 && <span className="muted">{checked} of {steps.length} checked</span>}
            </div>
            {!steps.length && <p className="stext">{item.text.replace(/^to check:\s*/i, "")}</p>}
            {steps.length > 0 && (
              <ol className="ssteps">
                {steps.map((s, i) => {
                  const m = marks[i] as Mark;
                  return (
                    <li key={s.n}>
                      <label className="sstep">
                        <input type="checkbox" checked={done[i] ?? false} disabled={!ready} aria-label={`Step ${s.n} done`}
                          onChange={(e) => setDone((all) => all.map((x, j) => (j === i ? e.target.checked : x)))} />
                        <span><span className="muted">{s.n}.</span> {s.text}{s.expect && <span className="sexpect">You should see: {s.expect}</span>}</span>
                      </label>
                      <div className="smark">
                        <div role="radiogroup" aria-label={`Step ${s.n} result`} className="spills">
                          {(["pass", "fail"] as const).map((r) => (
                            <button key={r} type="button" role="radio" aria-checked={m.result === r} disabled={!ready}
                              onClick={() => setMark(i, { result: m.result === r ? null : r })}>{r === "pass" ? "Pass" : "Fail"}</button>
                          ))}
                        </div>
                        <input type="text" value={m.note} disabled={!ready} placeholder="Note (optional)" aria-label={`Step ${s.n} note`} maxLength={500}
                          onChange={(e) => setMark(i, { note: e.target.value })} />
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            {passWhen(item.text) && <p className="muted">{passWhen(item.text)}</p>}
            {group === "proposed" && (
              <>
                <div className="actions">
                  <button className="btn primary" disabled={busy} onClick={() => void act("confirm", {}, "Plan confirmed: it is ready to test.")}>
                    {busy ? "Saving…" : "Confirm plan"}</button>
                  {po && <button className="btn" onClick={askChange} disabled={busy}>Ask {po.name} to change it</button>}
                </div>
                <span className="hint">Until you confirm the plan, the steps are locked: a result for a plan nobody confirmed counts for nothing.</span>
              </>
            )}
            {ready && (
              <>
                <label className="sextra">Anything else (optional)
                  <textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={2000} />
                </label>
                <div className="actions">
                  <button className="btn primary" disabled={busy || outcomeOf(marks) === "fail"}
                    onClick={() => void act("result", { outcome: "pass", ...(note ? { note } : {}) }, "Recorded as passed.")}>Passed</button>
                  <button className="btn" disabled={busy} onClick={() => void failed()}>{po ? "Failed: make it a task" : "Failed"}</button>
                </div>
                <span className="hint">{po ? `Failed records your notes and asks ${po.name} to make it a task for the builders.` : "Failed records your notes."}</span>
              </>
            )}
            {group === "results" && last && (
              <div className="sresult">
                <strong>{status.text}{last[1] ? ` · recorded by ${last[1]}` : ""}</strong>
                {last[2] && <p className="stext">{last[2]}</p>}
              </div>
            )}
            <Attachments project={p.project.id} target={`signoff:${item.id}`} token={p.token} />
          </section>

          <aside className="saside">
            <h2>History</h2>
            <ol className="shist">
              {historyOf(item, now).map((h, i) => (
                <li key={i}><StatusDot state="idle" /><span><span>{h.text}</span><span className="muted">{h.when}</span></span></li>
              ))}
            </ol>
            {thread.length > 0 && (
              <>
                <h2>On the thread</h2>
                <ul className="shist">
                  {thread.map((x) => <li key={x.id}><Avatar name={x.from} size={24} /><span><strong>{itemLabel(x, "").who}</strong> {x.text}</span></li>)}
                </ul>
              </>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}

export const SIGNOFF_CSS = String.raw`
.link.back { align-self: flex-start; color: var(--text-2); font-weight: 500; }
.srow-title { font-size: 15px; text-align: left; }
.sgroup h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.crumbs { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--text-3); margin-bottom: 10px; }
.crumbs .link { color: var(--text-2); font-weight: 400; }
.crumbs span:last-child { color: var(--text); }
.shead { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start; justify-content: space-between; }
.shead header { flex: 1 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.vstate { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 13px; }
.sby { display: flex; gap: 12px; align-items: flex-start; }
.sby p { margin: 0; color: var(--text-2); line-height: 1.55; }
.sby strong { color: var(--text); }
.scols { display: flex; flex-wrap: wrap; gap: 48px; align-items: flex-start; }
.splan { flex: 2 1 480px; min-width: 0; max-width: 700px; display: flex; flex-direction: column; gap: 12px; }
.splan-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.splan h2, .saside h2 { margin: 0; font-size: 20px; font-weight: 600; }
.saside h2 { font-size: 15px; }
.ssteps { list-style: none; margin: 0; padding: 0; }
.ssteps li { display: flex; flex-direction: column; gap: 12px; padding: 18px 0; border-bottom: 1px solid var(--border); }
.sstep { display: flex; gap: 12px; align-items: flex-start; line-height: 1.5; cursor: pointer; }
.sstep input { width: 20px; height: 20px; margin: 2px 0 0; flex: none; }
.sstep > span { display: flex; flex-direction: column; gap: 4px; }
.sexpect { font-size: 13px; color: var(--text-2); }
.smark { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-left: 32px; }
.spills { display: flex; gap: 6px; }
.spills button { height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
  font: inherit; font-size: 13px; cursor: pointer; }
.spills button[aria-checked="true"] { background: var(--primary); border-color: var(--text); color: var(--on-primary); font-weight: 600; }
.spills button:disabled, .smark input:disabled, .sstep input:disabled { opacity: .5; cursor: not-allowed; }
.smark input { flex: 1 1 180px; min-width: 0; height: 36px; border-radius: 10px; border: 1px solid var(--border-strong); background: var(--surface);
  color: var(--text); font: inherit; font-size: 13px; padding: 0 10px; }
.stext { margin: 0; white-space: pre-wrap; line-height: 1.55; }
.sextra, .sform label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-2); }
.sextra textarea, .sform textarea, .sform input { border: 1px solid var(--border-strong); border-radius: 10px; padding: 10px 12px; background: var(--surface);
  color: var(--text); font: inherit; font-size: 14px; }
.sform input { height: 44px; padding: 0 12px; box-sizing: border-box; }
.splan .actions { display: flex; flex-wrap: wrap; gap: 10px; padding-top: 4px; }
.hint { font-size: 12px; color: var(--text-3); line-height: 1.45; }
.sresult { display: flex; flex-direction: column; gap: 6px; }
.saside { flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.shist { list-style: none; margin: 0; padding: 0; }
.shist li { display: flex; gap: 10px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.shist li .sdot { margin-top: 6px; }
.shist li > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.shist .muted { font-size: 12px; color: var(--text-3); }
@media (max-width: 760px) { .smark { padding-left: 0; } .scols { gap: 28px; } }
`;
