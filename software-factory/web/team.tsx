// The Team page (#581): every role in one place (the product owner, the dev manager and each coding agent) with its
// avatar, name, role, machine, state and task, and Start or Stop; add a coding agent (a free legend name and where it
// runs), remove one, rename one, and set how many coding agents run at once on this machine. Every change asks first,
// saying what happens and what doesn't. It reuses Factory settings' pieces (settings.tsx): the settings read, the
// staged changes and their pull request, and the remove dialog's own Stop and Release buttons; Start and Stop open the
// shell's confirm (app.tsx). The rules and words are in team_model.ts and settings_model.ts. Nothing here shows a command.
import { useMemo, useState } from "react";
import { Avatar } from "./avatar_view.tsx";
import { ConfirmDialog, ListRow } from "./parts.tsx";
import type { ConfirmSpec } from "./parts_model.ts";
import { Notice, PrNotice, type Props, StagedBar, useAct, useFixDialog, useSettingsData } from "./settings.tsx";
import { addAgentAsk, nameProblem, removeAgentAsk } from "./settings_model.ts";
import { atOnceAsk, atOnceText, codingHere, machineChoices, renameAgentAsk, teamRows, type TeamRowView } from "./team_model.ts";

export interface TeamProps extends Props {
  /** The machines the agents report from (the live state), this one marked. */
  machines: { name: string; here: boolean }[];
  /** Start or Stop through the shell's confirm; a start passes this machine's limit (#581). */
  askAgent: (verb: "start" | "stop", name: string, atOnce: { max: number; running: string[] } | null) => void;
}

type Dialog = { kind: "remove" | "rename"; name: string; role: string; to?: string };

export function TeamPage(p: TeamProps) {
  const { data, problem, load } = useSettingsData(p);
  const { busy, act } = useAct(p, load);
  const fixer = useFixDialog(p, act);
  const [ask, setAsk] = useState<{ spec: ConfirmSpec; run: () => Promise<unknown> } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; role: string; to: string } | null>(null);

  if (!data) return <div className="body">{problem ? <Notice p={problem} /> : <p className="empty">Reading the team…</p>}</div>;

  const hereName = p.machines.find((m) => m.here)?.name ?? null;
  const rows = teamRows({ team: data.team, live: p.agents, machine: data.machine, hereName });
  const taken = [...new Set([...data.team.agents.map((a) => a.name), ...Object.values(data.team.next).flat()])];
  const running = codingHere(data.team.agents, p.agents);
  const maxRow = data.machine.rows.find((r) => r.key === "maxCodingAgents");
  const max = typeof maxRow?.value === "number" ? maxRow.value : null;
  const open = (d: Dialog): void => {
    fixer.setTarget(d.name);
    setDialog(d);
  };
  const close = (): void => {
    fixer.setTarget(null);
    setDialog(null);
  };
  const dialogSpec = (d: Dialog): ConfirmSpec => (d.kind === "remove" ? removeAgentAsk(fixer.facts(d.name, d.role))
    : renameAgentAsk(fixer.facts(d.name, d.role), d.to ?? "", taken));
  const confirmDialog = async (d: Dialog): Promise<void> => {
    const ok = d.kind === "remove"
      ? await act(`settings/team/${encodeURIComponent(d.name)}/remove`, { confirm: true }, { title: `${d.name} leaves the team once you propose and merge it.` })
      : await act(`settings/team/${encodeURIComponent(d.name)}/rename`, { confirm: true, to: d.to }, { title: `${d.name} becomes ${d.to} once you propose and merge it.` });
    if (ok) close();
  };

  return (
    <div className="body settings team">
      {problem && <Notice p={problem} />}
      {data.problems.map((x) => <Notice key={x.code} p={x} tone="quiet" />)}
      <PrNotice pr={data.pr} />
      <section className="card" aria-labelledby="team-list-h">
        <h3 id="team-list-h">Everyone on the team</h3>
        <ul className="lrows">
          {rows.map((r) => <TeamRow key={r.name} r={r} busy={busy} openAgent={() => p.open(`agent:${r.name}`)}
            start={() => p.askAgent("start", r.name, r.role === "coding-agent" && max !== null ? { max, running } : null)}
            stop={() => p.askAgent("stop", r.name, null)}
            rename={() => setRenaming({ name: r.name, role: r.role, to: "" })}
            remove={() => open({ kind: "remove", name: r.name, role: r.role })} />)}
        </ul>
        {renaming && (
          <RenameForm key={renaming.name} name={renaming.name} free={data.team.free} taken={taken} cancel={() => setRenaming(null)}
            next={(to) => { open({ kind: "rename", name: renaming.name, role: renaming.role, to }); setRenaming(null); }} />
        )}
      </section>
      <AddAgent free={data.team.free} taken={taken} busy={busy} machines={p.machines}
        add={(name, machine, label) => setAsk({ spec: addAgentAsk(name, { machine, label, ownList: data.machine.from === "machine" }),
          run: () => act("settings/team", { name, machine }, { title: `${name} is staged.`, text: "Propose the staged changes when you are ready." }) })} />
      <AtOnce key={String(max)} max={max} running={running} busy={busy}
        save={(n) => setAsk({ spec: atOnceAsk(n, running), run: () => act("settings/machine", n === null ? { key: "maxCodingAgents", unset: true }
          : { key: "maxCodingAgents", value: String(n) }, { title: n === null ? "No limit on this machine." : `At most ${n} at once on this machine.` }) })} />
      <p className="hint">A change to the team is staged, then proposed with the other staged changes as one pull request only you merge. How many
        run at once is this machine's own setting and saves at once.</p>
      <StagedBar changes={data.staged.changes} busy={busy} act={act} ask={setAsk} />
      {ask && <ConfirmDialog key={ask.spec.title} spec={ask.spec} busy={busy} onCancel={() => setAsk(null)}
        onConfirm={() => void ask.run().then(() => setAsk(null))} />}
      {dialog && <ConfirmDialog key={`${dialog.kind}/${dialog.name}`} spec={dialogSpec(dialog)} busy={busy} onCancel={close}
        onConfirm={() => void confirmDialog(dialog)} onFix={fixer.fix} />}
    </div>
  );
}

function TeamRow({ r, busy, openAgent, start, stop, rename, remove }: { r: TeamRowView; busy: boolean; openAgent: () => void; start: () => void;
  stop: () => void; rename: () => void; remove: () => void }) {
  const sub = [r.roleTitle, r.machine, r.task ? `holds #${r.task}` : "", r.former.length ? `formerly ${r.former.join(", ")}` : "",
    r.change === "joins" ? "staged to join" : r.change === "leaves" ? "staged to leave" : ""].filter(Boolean).join(" · ");
  const settled = r.change === null;
  return (
    <ListRow avatar={{ name: r.name, role: r.role }} title={<button className="link" onClick={openAgent}>{r.name}</button>} sub={sub}
      status={{ state: r.change === "joins" ? "waiting" : r.running ? "working" : "idle", text: r.change === "joins" ? "Staged" : r.stateText }}
      action={settled ? (
        <span className="row-actions">
          {r.running && !r.here ? <span className="tag quiet">on {r.machine}</span>
            : r.running ? <button className="btn small danger" disabled={busy} onClick={stop}>Stop</button>
            : <button className="btn small primary" disabled={busy} onClick={start}>Start</button>}
          <button className="btn small" disabled={busy} onClick={rename}>Rename</button>
          <button className="btn small" disabled={busy} onClick={remove}>Remove</button>
        </span>
      ) : null} />
  );
}

function FreeNames({ free, picked, pick }: { free: string[]; picked: string; pick: (n: string) => void }) {
  if (!free.length) return null;
  return (
    <div className="chips" role="group" aria-label="Free names">
      {free.map((n) => (
        <button key={n} type="button" className="chip" aria-pressed={picked === n} onClick={() => pick(n)}>
          <Avatar name={n} role="coding-agent" size={20} />{n}</button>
      ))}
    </div>
  );
}

function RenameForm({ name, free, taken, next, cancel }: { name: string; free: string[]; taken: string[]; next: (to: string) => void; cancel: () => void }) {
  const [to, setTo] = useState("");
  const why = to ? nameProblem(to.trim(), taken) : null;
  return (
    <form className="add-agent" aria-label={`Rename ${name}`} onSubmit={(e) => { e.preventDefault(); if (!why && to.trim()) next(to.trim()); }}>
      <label htmlFor="rename-to">Rename {name} to</label>
      <FreeNames free={free} picked={to} pick={setTo} />
      <span className="add-row">
        <input id="rename-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Pick a name above, or type one"
          aria-invalid={!!why} aria-describedby={why ? "rename-err" : undefined} />
        <button className="btn primary" type="submit" disabled={!to.trim() || !!why}>Next</button>
        <button className="btn plain" type="button" onClick={cancel}>Cancel</button>
      </span>
      {why && <span id="rename-err" className="send-problem">{why}</span>}
    </form>
  );
}

function AddAgent({ free, taken, busy, machines, add }: { free: string[]; taken: string[]; busy: boolean; machines: { name: string; here: boolean }[];
  add: (name: string, machine: string, label: string) => void }) {
  const [name, setName] = useState("");
  const choices = useMemo(() => machineChoices(machines), [machines]);
  const [machine, setMachine] = useState("here");
  const why = name ? nameProblem(name.trim(), taken) : null;
  const label = choices.find((c) => c.id === machine)?.label ?? machine;
  return (
    <section className="card" aria-labelledby="add-h">
      <h3 id="add-h">Add a coding agent</h3>
      <form className="add-agent" onSubmit={(e) => { e.preventDefault(); if (!why && name.trim()) { add(name.trim(), machine, label); setName(""); } }}>
        <label htmlFor="agent-name">Its name</label>
        <FreeNames free={free} picked={name} pick={setName} />
        <span className="add-row">
          <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pick a name above, or type one"
            aria-invalid={!!why} aria-describedby={why ? "agent-err" : undefined} />
        </span>
        {why && <span id="agent-err" className="send-problem">{why}</span>}
        <label htmlFor="agent-machine">Where it runs</label>
        <span className="add-row">
          <select id="agent-machine" value={machine} onChange={(e) => setMachine(e.target.value)}>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <button className="btn primary" type="submit" disabled={busy || !name.trim() || !!why}>Add</button>
        </span>
      </form>
    </section>
  );
}

function AtOnce({ max, running, busy, save }: { max: number | null; running: string[]; busy: boolean; save: (n: number | null) => void }) {
  const [text, setText] = useState(max === null ? "" : String(max));
  const n = Number(text);
  const good = text.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 32;
  return (
    <section className="card" aria-labelledby="atonce-h">
      <h3 id="atonce-h">Coding agents at once on this machine</h3>
      <p className="muted card-text">{atOnceText(max, running.length)}. Starting one more than this here is refused; other machines set their own.</p>
      <form className="add-agent" onSubmit={(e) => { e.preventDefault(); if (good) save(n); }}>
        <span className="add-row">
          <input aria-label="How many coding agents at once" type="number" min={1} max={32} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="No limit" />
          <button className="btn primary" type="submit" disabled={busy || !good || n === max}>Save</button>
          {max !== null && <button className="btn" type="button" disabled={busy} onClick={() => save(null)}>No limit</button>}
        </span>
      </form>
    </section>
  );
}

export const TEAM_CSS = String.raw`
.team .add-row select { min-width: 0; flex: 1; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface);
  color: var(--text); font: inherit; padding: 0 12px; height: 44px; }
.team .lrow .row-actions { flex-wrap: wrap; justify-content: flex-end; }
`;
