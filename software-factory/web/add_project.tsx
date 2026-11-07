// Add a project (#447), after the owner's AddProject.dc.html and ProjectWizard.dc.html: where the project comes from
// (clone a repo, a folder on this machine, or a new repo), then Set it up in five tabs (about, tasks, team, CI, review),
// then the run, each step as it goes, with Retry where it stopped. The server does the work (hooks/factory_ui_add.ts);
// the rules are in add_project_model.ts. It is drawn with the theme's variables and the shared parts (parts.tsx): underline
// tabs, list rows with a status, the buttons and the confirm dialog before Create. No command is shown on screen.
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { addPick, addProtected, avatarProblem, createsOf, emptyForm, filterRepos, type Form, LEGEND_WHO, LEGENDS, picksOf, presetOf, type Problem,
  renamePick, type Repo, requestOf, roleNameOf, type Run, runProgress, SETUP_STEPS, setupProblem, SOURCES, sourceProblem, TEAM_PRESETS, togglePick,
  WIZARD, withPreset, withRepo } from "./add_project_model.ts";
import { Avatar } from "./avatar_view.tsx";
import { ConfirmDialog, type DotState, ListRow, StatusDot, Tabs } from "./parts.tsx";
import type { ConfirmSpec } from "./parts_model.ts";

interface Info {
  repos: Repo[];
  folder: string;
  projects: { id: string; name: string; path: string }[];
  messaging: string;
  problems: Problem[];
  /** This machine has a message board, so tasks can come from it (#540). */
  board?: boolean;
  /** The GitHub login signed in here: the trusted reviewer unless the owner types another. */
  login?: string;
}

type Post = (path: string, body: unknown) => Promise<Record<string, unknown>>;

export function Check() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

export function Stepper({ current }: { current: number }) {
  return (
    <ol className="ap-steps" aria-label="Setup steps">
      {SETUP_STEPS.map((label, i) => (
        <li key={label} aria-current={i === current ? "step" : undefined} className={i === current ? "on" : i < current ? "past" : ""}>
          <span className="ap-mark">{i < current ? "✓" : i + 1}</span>{label}
        </li>
      ))}
    </ol>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="ap-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="ap-hint">{hint}</span>}
    </div>
  );
}

function Choice({ name, checked, onPick, title, note, children }: { name: string; checked: boolean; onPick: () => void; title: string; note?: string;
  children?: ReactNode }) {
  return (
    <label className={`ap-choice${checked ? " on" : ""}`}>
      <input type="radio" name={name} checked={checked} onChange={onPick} />
      <span><strong>{title}{note && <span className="ap-hint"> · {note}</span>}</strong><span className="ap-hint">{children}</span></span>
    </label>
  );
}

// --- Add a project -----------------------------------------------------------------------------------------------------

function SourceStep({ form, set, info }: { form: Form; set: (f: Form) => void; info: Info | null }) {
  const [query, setQuery] = useState("");
  const repos = useMemo(() => filterRepos(info?.repos ?? [], query), [info, query]);
  const here = info?.projects ?? [];
  return (
    <>
      <div className="ap-head">
        <h1>Add a project</h1>
        <p>Each project is one GitHub repo. Bring one you have, or start a new one; you set it up on the next step.</p>
      </div>
      <Tabs label="Where the project comes from" tabs={SOURCES.map((x) => ({ id: x.id, label: x.title }))} value={form.source}
        onChange={(source) => set({ ...form, source, repo: "", path: "", pathEdited: false })} />
      {form.source === "clone" && (
        <section aria-label="Clone from GitHub" className="ap-section">
          <label className="ap-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input aria-label="Search your repositories" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your repositories" />
          </label>
          {!info && <p className="ap-hint">Reading your repos…</p>}
          {info && !info.repos.length && !info.problems.length && <p className="ap-hint">No repos on this GitHub account yet. Create a new repo instead.</p>}
          {info && info.repos.length > 0 && !repos.length && <p className="ap-hint">No repo matches "{query}".</p>}
          <ul role="listbox" aria-label="Your repositories" className="ap-repos">
            {repos.map((r) => {
              const on = form.repo === r.name;
              return (
                <li key={r.name} role="option" aria-selected={on} aria-disabled={r.inFactory !== null} className={on ? "on" : ""}
                  onClick={() => { if (r.inFactory === null) set(withRepo(form, r.name)); }}>
                  <span className="ap-grow"><strong>{r.name}</strong>
                    <span className="ap-hint">{r.inFactory !== null ? `Already in this factory, as ${r.inFactory}` : `${r.private ? "Private" : "Public"}${r.updatedAt ? ` · updated ${r.updatedAt.slice(0, 10)}` : ""}`}</span>
                  </span>
                  {on && <Check />}
                </li>
              );
            })}
          </ul>
          <Field id="ap-clone-to" label="Clone into">
            <input id="ap-clone-to" className="mono" value={form.path} placeholder={`${info?.folder ?? ""}/…`}
              onChange={(e) => set({ ...form, path: e.target.value, pathEdited: true })} />
          </Field>
        </section>
      )}
      {form.source === "folder" && (
        <section aria-label="A folder on this machine" className="ap-section">
          <Field id="ap-folder" label="The project's folder" hint="A git checkout of the repo, with nothing left uncommitted.">
            <input id="ap-folder" className="mono" value={form.path} placeholder={`${info?.folder ?? ""}/…`}
              onChange={(e) => set({ ...form, path: e.target.value, pathEdited: true })} />
          </Field>
        </section>
      )}
      {form.source === "new" && (
        <section aria-label="Create a new repo" className="ap-section">
          <Field id="ap-new-repo" label="Name on GitHub" hint="owner/name: the owner is your account or an organisation you belong to.">
            <input id="ap-new-repo" value={form.repo} placeholder={`${info?.repos[0]?.name.split("/")[0] ?? "you"}/new-project`}
              onChange={(e) => set(withRepo(form, e.target.value.trim()))} />
          </Field>
          <div role="radiogroup" aria-label="Who can see it" className="ap-grid">
            <Choice name="ap-vis" checked={form.visibility === "private"} onPick={() => set({ ...form, visibility: "private" })} title="Private">Only you and the people you add.</Choice>
            <Choice name="ap-vis" checked={form.visibility === "public"} onPick={() => set({ ...form, visibility: "public" })} title="Public">Anyone can see it.</Choice>
          </div>
          <Field id="ap-new-to" label="Clone into">
            <input id="ap-new-to" className="mono" value={form.path} onChange={(e) => set({ ...form, path: e.target.value, pathEdited: true })} />
          </Field>
        </section>
      )}
      {(info?.problems ?? []).map((p) => (
        <p key={p.code} className="ap-hint" role="status">{p.message} {p.fix}</p>
      ))}
      {here.length > 0 && (
        <p className="ap-hint">Already in this factory: {here.map((p, i) => <span key={p.id}>{i ? ", " : ""}<strong className="ap-ink">{p.name}</strong></span>)}.</p>
      )}
    </>
  );
}

// --- Set it up ---------------------------------------------------------------------------------------------------------

function AboutTab({ form, set }: { form: Form; set: (f: Form) => void }) {
  const from = form.source === "clone" ? `Cloned from ${form.repo}` : form.source === "new" ? `A new ${form.visibility} repo, ${form.repo}` : "A folder on this machine";
  return (
    <div className="ap-section">
      <dl className="ap-facts">
        <div><dt>Project</dt><dd>{form.repo ? form.repo.split("/").pop() : form.path.split("/").pop()}</dd></div>
        <div><dt>Comes from</dt><dd>{from}</dd></div>
      </dl>
      <Field id="ap-about-path" label="Folder on this machine" hint="The agents on this machine work here.">
        <input id="ap-about-path" className="mono" value={form.path} onChange={(e) => set({ ...form, path: e.target.value, pathEdited: true })} />
      </Field>
    </div>
  );
}

/** The commands the owner gives (#540): each written as given; an empty one is left out. */
const COMMAND_FIELDS: { key: "install" | "typecheck" | "lint" | "test" | "build"; label: string; hint: string }[] = [
  { key: "test", label: "Test command", hint: "Agents run it unattended before every pull request, and CI runs it." },
  { key: "lint", label: "Lint command", hint: "Empty: no lint step." },
  { key: "typecheck", label: "Type check command", hint: "Empty: no type check step." },
  { key: "install", label: "Install command", hint: "CI runs it first. Empty: nothing to install." },
  { key: "build", label: "Build command", hint: "Empty: no build step." },
];

function TasksTab({ form, set, board }: { form: Form; set: (f: Form) => void; board: boolean }) {
  const [adding, setAdding] = useState("");
  return (
    <div className="ap-section">
      <fieldset className="ap-fieldset">
        <legend>Where do tasks come from?</legend>
        <div role="radiogroup" aria-label="Task source" className="ap-grid">
          <Choice name="ap-source" checked={form.tasks === "issues"} onPick={() => set({ ...form, tasks: "issues" })} title="GitHub issues" note="recommended">
            Each task is an issue. Agents claim one with a label, and you see the board on GitHub too.
          </Choice>
          <Choice name="ap-source" checked={form.tasks === "plan"} onPick={() => set({ ...form, tasks: "plan" })} title="A build plan file">
            A checklist in the repo; agents tick a box when a task merges. Good for a small project.
          </Choice>
          {board && (
            <Choice name="ap-source" checked={form.tasks === "board"} onPick={() => set({ ...form, tasks: "board" })} title="The message board">
              Tasks live on this machine's message board, where the agents already talk. GitHub gets a copy.
            </Choice>
          )}
        </div>
        {form.tasks === "issues" && <span className="ap-hint">We add four labels on GitHub: ready, in progress, in review and blocked. Labels that already exist are left as they are.</span>}
      </fieldset>
      <div className="ap-grid">
        <Field id="ap-main" label="Main branch" hint="Agents never push here.">
          <input id="ap-main" value={form.mainBranch} onChange={(e) => set({ ...form, mainBranch: e.target.value })} />
        </Field>
        {COMMAND_FIELDS.map((c) => (
          <Field key={c.key} id={`ap-${c.key}`} label={c.label} hint={c.hint}>
            <input id={`ap-${c.key}`} className="mono" value={form[c.key]} onChange={(e) => set({ ...form, [c.key]: e.target.value })} />
          </Field>
        ))}
        <Field id="ap-reviewer" label="Trusted reviewer" hint="The GitHub login whose reviews count at a merge. It starts as the one signed in here.">
          <input id="ap-reviewer" className="mono" value={form.reviewer} onChange={(e) => set({ ...form, reviewer: e.target.value })} />
        </Field>
      </div>
      <div className="ap-field">
        <strong>Protected paths</strong>
        <span className="ap-hint">A pull request that touches one of these waits for you. The agent that wrote it can never merge it. A folder ends in /; a file is matched whole.</span>
        <div className="ap-chips">
          {form.protected.map((p) => (
            <span key={p} className="ap-chip"><code>{p}</code>
              <button aria-label={`Remove ${p}`} onClick={() => set({ ...form, protected: form.protected.filter((x) => x !== p) })}>×</button>
            </span>
          ))}
        </div>
        <form className="ap-row" onSubmit={(e) => { e.preventDefault(); set({ ...form, protected: addProtected(form.protected, adding) }); setAdding(""); }}>
          <input aria-label="Add a protected path" placeholder="Add a path, e.g. migrations/" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <button type="submit" className="btn">Add</button>
        </form>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Choose your team (#457, ChooseTeam.dc.html): a team size, the 12 legends (tap to add or take out), your own agent. */
function TeamTab({ form, set }: { form: Form; set: (f: Form) => void }) {
  const picks = picksOf(form.team);
  const preset = presetOf(form.team);
  const own = picks.filter((n) => !LEGENDS.includes(n));
  return (
    <div className="ap-section">
      <div className="ap-head">
        <h2 className="ap-h2 big">Choose your team</h2>
        <p>Pick how many agents work on this project and who they are. Start small: you can add or rename agents later.</p>
      </div>
      <div role="group" aria-label="Team size" className="ct-presets">
        {TEAM_PRESETS.map((p) => (
          <button key={p.id} type="button" aria-pressed={preset === p.id} className={`ct-preset${preset === p.id ? " on" : ""}`}
            onClick={() => set(withPreset(form, p.id))}>
            <strong>{p.name}</strong>
            <span className="ap-hint">{p.what}</span>
            <span className="ct-count">{(p.picks ?? picks).length} {(p.picks ?? picks).length === 1 ? "agent" : "agents"}</span>
          </button>
        ))}
      </div>
      <div className="ct-legends-head">
        <h3 className="ap-h2">The legends</h3>
        <span className="ap-hint">Tap to add or remove</span>
      </div>
      <div className="ct-legends">
        {[...LEGENDS, ...own].map((n) => {
          const on = picks.includes(n);
          return (
            <button key={n} type="button" aria-pressed={on} className={`ct-legend${on ? " on" : ""}`} onClick={() => set(togglePick(form, n))}>
              <Avatar name={n} role={roleIdOf(picks.indexOf(n), picks.length)} size={64} image={form.avatars[n]} />
              <strong>{n}</strong>
              <span className="ap-hint">{LEGEND_WHO[n] ?? "Your own"}</span>
              {on && <span className="ct-tick" aria-hidden="true"><Check /></span>}
            </button>
          );
        })}
        <button type="button" className="ct-legend ct-own" onClick={() => set(addPick(form))}>
          <span className="ct-plus"><PlusIcon /></span>
          <strong>Your own</strong>
          <span className="ap-hint">Any name, your picture</span>
        </button>
      </div>
    </div>
  );
}

/** The role's id for the avatar's drawing: the `i`th of `n` picks. */
function roleIdOf(i: number, n: number): string {
  const r = roleNameOf(Math.max(i, 0), n);
  return r === "Product owner" ? "product-owner" : r === "Dev manager" ? "dev-manager" : "coding-agent";
}

/** Your team (n), beside Choose your team: each agent's name to rename, its role, and its picture. */
function YourTeam({ form, set }: { form: Form; set: (f: Form) => void }) {
  const picks = picksOf(form.team);
  const [names, setNames] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<{ name: string; text: string } | null>(null);
  const pick = (name: string, file: File | undefined): void => {
    if (!file) return;
    const wrong = avatarProblem({ type: file.type, size: file.size });
    if (wrong) {
      setBad({ name, text: wrong });
      return;
    }
    setBad(null);
    const reader = new FileReader();
    reader.onload = () => set({ ...form, avatars: { ...form.avatars, [name]: String(reader.result) } });
    reader.readAsDataURL(file);
  };
  return (
    <aside aria-label="Your team" className="ap-aside">
      <h2 className="ap-h2">Your team ({picks.length})</h2>
      <ul className="ct-team">
        {picks.map((n, i) => (
          <li key={`${i}-${n}`}>
            <Avatar name={n} role={roleIdOf(i, picks.length)} size={36} image={form.avatars[n]} />
            <span className="ap-grow">
              <input type="text" aria-label={`Name for the ${roleNameOf(i, picks.length).toLowerCase()}`} value={names[n] ?? n}
                onChange={(e) => setNames({ ...names, [n]: e.target.value })}
                onBlur={() => {
                  const to = (names[n] ?? n).trim();
                  setNames({});
                  if (to && to !== n) set(renamePick(form, n, to));
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              <span className="ap-hint">{roleNameOf(i, picks.length)}</span>
            </span>
            <label className="btn ct-pic">
              Picture
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label={`Change picture for ${n}`}
                onChange={(e) => pick(n, e.target.files?.[0])} />
            </label>
          </li>
        ))}
      </ul>
      {bad && <p className="ap-hint" role="alert"><span className="ap-ink">{bad.name}:</span> {bad.text}</p>}
      <p className="ap-hint">The first one plans the product, the next reviews and merges, the rest build. Just a builder: you review and merge yourself.</p>
    </aside>
  );
}

function CiTab({ form }: { form: Form }) {
  return (
    <div className="ap-section">
      <p>The checks run on GitHub Actions: the kit adds the workflow. Every pull request gets the factory's guard (tests not weakened,
        no new dependency unreviewed, protected paths respected) and the commands you gave on Tasks
        {form.test ? <> (tests: <code>{form.test}</code>)</> : " (none yet)"}. A project with no package.json gets no pnpm or Node steps.</p>
      <p className="ap-hint">Runners on your own machines come later, on Machines; nothing to choose here now.</p>
    </div>
  );
}

function ReviewTab({ steps, problem, checking, warnings }: { steps: { id: string; title: string; detail: string }[]; problem: Problem | null;
  checking: boolean; warnings: string[] }) {
  return (
    <div className="ap-section">
      {checking && <p className="ap-hint">Checking…</p>}
      {problem && <div className="ap-problem" role="alert"><StatusDot state="down" /><span><strong>{problem.message}</strong> <span className="ap-hint">{problem.fix}</span></span></div>}
      {warnings.map((w) => <div key={w} className="ap-problem" role="status"><StatusDot state="waiting" /><span>{w}</span></div>)}
      {steps.length > 0 && (
        <>
          <h2 className="ap-h2">What Create will do</h2>
          <ul className="lrows ap-rows">
            {steps.map((s) => <ListRow key={s.id} title={s.title} sub={s.detail} />)}
          </ul>
          <p className="ap-hint">It won't push to the main branch or start any agent: you merge the setup pull request and start the team when you are ready.
            Each step can be retried, and running it again adds nothing twice.</p>
        </>
      )}
    </div>
  );
}

// --- the run -----------------------------------------------------------------------------------------------------------

const STATE_WORDS: Record<string, string> = { waiting: "Waiting", running: "Running", done: "Done", skipped: "Nothing to do", failed: "Stopped" };

/** A step's state as the shared status dot and its words. */
const STATE_DOT: Record<string, DotState> = { waiting: "idle", running: "waiting", done: "working", skipped: "working", failed: "down" };

function RunView({ run }: { run: Run }) {
  return (
    <ul className="lrows ap-rows" aria-label="Steps">
      {run.steps.map((s) => (
        <ListRow key={s.id} title={<span className={s.state === "waiting" ? "ap-later" : ""}>{s.title}</span>}
          sub={<>
            {s.state === "failed" && s.problem ? s.problem.message : s.detail}
            {s.state === "failed" && s.problem?.fix && <span className="ap-fix">{s.problem.fix}</span>}
            {(s.todos ?? []).length > 0 && (
              <ul className="ap-todos" aria-label="To do, only you can">
                {(s.todos ?? []).map((t) => <li key={t.what}><strong>To do: {t.what}.</strong> <span className="ap-fix">{t.fix}</span></li>)}
              </ul>
            )}
            {s.output && (s.state === "failed" || s.state === "done") && (
              <details open={s.state === "failed"}><summary>What it printed</summary><pre className="ap-log">{s.output}</pre></details>
            )}
          </>}
          status={{ state: STATE_DOT[s.state] ?? "idle", text: STATE_WORDS[s.state] ?? s.state }} />
      ))}
    </ul>
  );
}

// --- the page ----------------------------------------------------------------------------------------------------------

export function AddProjectPage({ get, post, run, setRun, open, close, live }: {
  get: <T>(path: string) => Promise<T>;
  post: Post;
  run: Run | null;
  setRun: (r: Run | null) => void;
  open: (project: string) => void;
  close: () => void;
  live: boolean;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [form, setForm] = useState<Form>(() => emptyForm(""));
  const [stage, setStage] = useState<"source" | "setup">("source");
  const [tab, setTab] = useState(0);
  const [steps, setSteps] = useState<{ id: string; title: string; detail: string }[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    get<Info>("/api/add-project").then((i) => {
      setInfo(i);
      setForm((f) => ({ ...f, folder: f.folder || i.folder, reviewer: f.reviewer || (i.login ?? "") }));
    }).catch(() => setInfo({ repos: [], folder: "", projects: [], messaging: "github",
      problems: [{ code: "ui_add_unreachable", message: "The server can't be reached.", fix: "Is the web UI still running?" }] }));
  }, [get]);

  // Review asks the server what Create would do (it changes nothing)
  useEffect(() => {
    if (stage !== "setup" || tab !== WIZARD.length - 1) return;
    let gone = false;
    setBusy(true);
    post("/api/add-project/check", requestOf(form)).then((r) => {
      if (gone) return;
      setSteps(r.ok ? (r.steps as typeof steps) : []);
      setWarnings(r.ok && Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : []);
      setProblem(r.ok ? null : { code: String(r.code ?? ""), message: String(r.message ?? "It can't be added."), fix: String(r.fix ?? "") });
    }).finally(() => { if (!gone) setBusy(false); });
    return () => {
      gone = true;
    };
  }, [stage, tab, form, post]);

  const act = async (path: string, body: unknown): Promise<void> => {
    setBusy(true);
    const r = await post(path, body);
    setBusy(false);
    if (r.run) setRun(r.run as Run);
    else setProblem({ code: String(r.code ?? ""), message: String(r.message ?? "It didn't start."), fix: String(r.fix ?? "") });
  };

  const blocked = stage === "source" ? sourceProblem(form) : setupProblem(form);
  const last = tab === WIZARD.length - 1;
  const progress = run ? runProgress(run) : null;
  const name = form.repo ? form.repo.split("/").pop() : form.path.split("/").pop();
  const createAsk: ConfirmSpec = {
    title: `Create ${name ?? "the project"}?`,
    checks: [{ title: "Review found nothing in the way", met: problem === null && steps.length > 0 && blocked === null,
      ...(problem ? { sub: problem.message } : blocked ? { sub: blocked } : {}) }],
    happens: "Each step on Review runs on this machine, one after another, and you see each one as it goes. Everything is committed on a setup branch and opened as a pull request for you to merge.",
    doesNot: `Nothing is pushed to ${form.mainBranch || "the main branch"}, and no agent is started.`,
    action: "Create",
    tone: "primary",
  };

  return (
    <div className="ap-page">
      <header className="ap-top">
        <span className="ap-logo"><span aria-hidden="true">F</span>factory</span>
        <span className="ap-hint" role="status"><StatusDot state={live ? "working" : "waiting"} />{live ? "Live" : "Reconnecting…"}</span>
      </header>
      <Stepper current={run || stage === "setup" ? 4 : 3} />
      <main className={`ap-card${stage === "setup" || run ? " wide" : ""}`}>
        {run ? (
          <>
            <div className="ap-head">
              <h1>Setting up {run.name ?? name}</h1>
              <p role="status"><StatusDot state={progress?.tone === "bad" ? "down" : progress?.tone === "good" ? "working" : "waiting"} />{progress?.text}</p>
            </div>
            <RunView run={run} />
            <div className="ap-foot">
              <span className="ap-hint">{run.state === "failed" ? "The steps before it are kept: Retry goes on from there." : run.state === "done"
                ? "Merge the setup pull request on GitHub, then start the team from the project." : "You can leave this page; it goes on."}</span>
              <div className="ap-row">
                {run.state !== "running" && <button className="btn" onClick={() => { setRun(null); close(); }}>Close</button>}
                {run.state === "failed" && run.id && (
                  <button className="btn primary" disabled={busy} onClick={() => void act(`/api/add-project/runs/${encodeURIComponent(run.id as string)}/retry`, { confirm: true })}>
                    {busy ? "Starting…" : "Retry"}</button>
                )}
                {run.project && run.state !== "running" && (
                  <button className="btn primary" onClick={() => { const p = run.project as string; setRun(null); open(p); }}>Open {run.name ?? name}</button>
                )}
              </div>
            </div>
          </>
        ) : stage === "source" ? (
          <>
            <SourceStep form={form} set={setForm} info={info} />
            <div className="ap-foot">
              <span className="ap-hint">{blocked ?? "Nothing changes in the repo yet."}</span>
              <div className="ap-row">
                <button className="btn" onClick={close}>Back</button>
                <button className="btn primary" disabled={blocked !== null} onClick={() => { setStage("setup"); setTab(0); }}>Continue</button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="ap-head">
              <h1>Set up {name}</h1>
              <p>Five short steps. Your answers are saved in the project; you can change any of them later in Settings.</p>
            </div>
            <nav aria-label="Wizard steps" className="tabs ap-wizard">
              {WIZARD.map((w, i) => (
                <button key={w} aria-current={i === tab ? "step" : undefined} onClick={() => setTab(i)}>{i < tab && <Check />}{w}</button>
              ))}
            </nav>
            <div className="ap-split">
              <div className="ap-main">
                {tab === 0 && <AboutTab form={form} set={setForm} />}
                {tab === 1 && <TasksTab form={form} set={setForm} board={info?.board === true} />}
                {tab === 2 && <TeamTab form={form} set={setForm} />}
                {tab === 3 && <CiTab form={form} />}
                {last && <ReviewTab steps={steps} problem={problem} checking={busy && !steps.length} warnings={warnings} />}
                <div className="ap-foot">
                  <button className="btn" onClick={() => (tab ? setTab(tab - 1) : setStage("source"))}>Back</button>
                  {!last && <button className="btn primary" onClick={() => setTab(tab + 1)}>Next: {WIZARD[tab + 1]}</button>}
                  {last && (
                    <button className="btn primary" disabled={busy || blocked !== null || problem !== null || !steps.length}
                      onClick={() => setConfirming(true)}>Create</button>
                  )}
                </div>
                {last && blocked && <p className="ap-hint" role="status">{blocked}</p>}
              </div>
              {tab === 2 ? <YourTeam form={form} set={setForm} /> : <aside aria-label="What will be created" className="ap-aside">
                <h2 className="ap-h2">What will be created</h2>
                <ul className="lrows ap-rows">
                  {createsOf(form).map((c) => (
                    <ListRow key={c.title} title={c.title} sub={c.detail} action={<span className="ap-where">{c.where}</span>} />
                  ))}
                </ul>
                <p className="ap-hint">Nothing is pushed until you press Create on Review. Running it twice adds nothing twice.</p>
              </aside>}
            </div>
          </>
        )}
      </main>
      {confirming && !run && (
        <ConfirmDialog spec={createAsk} busy={busy} onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); void act("/api/add-project", { confirm: true, ...requestOf(form) }); }} />
      )}
    </div>
  );
}

/** The screens' look: the onboarding layout of the design (a centred white card on the subtle background, a stepper on
 * top), only with the theme's variables; tabs, list rows, buttons and the dialog come from the shared parts. */
export const ADD_CSS = String.raw`
.ap-page { min-height: 100%; background: var(--bg-subtle); color: var(--text); display: flex; flex-direction: column; align-items: center; gap: 28px;
  padding: 28px 16px 64px; }
.ap-top { width: 100%; max-width: 1040px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.ap-logo { display: flex; align-items: center; gap: 10px; font: 700 18px/1 var(--title-font); }
.ap-logo span { width: 32px; height: 32px; border-radius: 10px; background: var(--primary); color: var(--on-primary); display: inline-flex;
  align-items: center; justify-content: center; }
.ap-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 24px; }
.ap-steps li { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
.ap-steps li.on { color: var(--text); font-weight: 600; }
.ap-mark { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border-strong); display: inline-flex; align-items: center;
  justify-content: center; font-size: 11px; font-weight: 600; background: var(--surface); color: var(--text-3); }
.ap-steps li.past .ap-mark { color: var(--text); }
.ap-steps li.on .ap-mark { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.ap-card { width: 100%; max-width: 880px; min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 48px;
  display: flex; flex-direction: column; gap: 28px; }
.ap-card.wide { max-width: 1040px; }
.ap-head { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ap-head h1 { margin: 0; font: 700 34px/1.15 var(--title-font); overflow-wrap: anywhere; }
.ap-head p { margin: 0; color: var(--text-2); display: flex; align-items: center; gap: 8px; }
.ap-top .ap-hint { display: inline-flex; align-items: center; gap: 8px; }
.ap-card .tabs { flex-wrap: wrap; column-gap: 24px; overflow: visible; }
.ap-card .tabs button { min-height: 44px; }
.ap-wizard button[aria-current="step"] { border-bottom-color: var(--text); color: var(--text); font-weight: 600; }
.ap-section { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.ap-section p { margin: 0; }
.ap-search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border-strong); border-radius: 10px; padding: 0 12px; height: 44px;
  color: var(--text-3); background: var(--surface); }
.ap-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font: inherit; color: var(--text); }
.ap-repos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; max-height: 340px; overflow-y: auto; }
.ap-repos li { display: flex; align-items: center; gap: 14px; padding: 12px; min-height: 48px; border-radius: 10px; cursor: pointer; }
.ap-repos li:hover, .ap-repos li.on { background: var(--bg-active); }
.ap-repos li[aria-disabled="true"] { cursor: default; color: var(--text-2); }
.ap-repos strong { overflow-wrap: anywhere; }
.ap-grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ap-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ap-field label, .ap-fieldset legend { font-weight: 600; }
.ap-fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ap-fieldset legend { font-size: 20px; margin-bottom: 4px; padding: 0; }
.ap-page input:not([type]), .ap-page input[type="text"], .ap-page select { height: 44px; border: 1px solid var(--border-strong);
  border-radius: 10px; padding: 0 12px; font: inherit; background: var(--surface); color: var(--text); min-width: 0; width: 100%; }
.ap-search input:not([type]) { border: 0; height: auto; padding: 0; }
.ap-page .mono { font-family: var(--mono); font-size: 13px; }
.ap-hint { font-size: 13px; color: var(--text-2); }
.ap-ink { color: var(--text); }
.ap-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 12px 20px; }
.ap-choice { border: 1px solid var(--border-strong); border-radius: 14px; padding: 16px; display: flex; gap: 12px; cursor: pointer; background: var(--surface); }
.ap-choice.on { border: 1.5px solid var(--text); }
.ap-choice input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--primary); flex: none; }
.ap-choice > span { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ap-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.ap-chip { display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 4px 0 12px; border-radius: 999px; border: 1px solid var(--border-strong);
  font-size: 13px; background: var(--surface); max-width: 100%; }
.ap-chip code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-chip button { width: 24px; height: 24px; border-radius: 50%; border: 0; background: transparent; color: var(--text-3); cursor: pointer; flex: none; }
.ap-pick { display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--border-strong);
  background: var(--surface); cursor: pointer; }
.ap-pick.on { background: var(--primary); border-color: var(--primary); color: var(--on-primary); font-weight: 600; }
.ap-pick input { accent-color: var(--primary); }
.ap-row { display: flex; gap: 10px; flex-wrap: wrap; min-width: 0; }
.ap-row input { flex: 1 1 180px; }
.ap-foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--border); padding-top: 24px; }
.ap-split { display: flex; flex-wrap: wrap; gap: 56px; align-items: flex-start; }
.ap-main { flex: 3 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 32px; }
.ap-aside { flex: 2 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.ap-h2 { margin: 0; font-size: 15px; font-weight: 600; }
.ap-rows .lrow-who { display: none; }
.ap-rows .lrow { align-items: flex-start; }
.ap-rows .lrow-sub { white-space: normal; overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 4px; }
.ap-where { font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text-3); white-space: nowrap; }
.ap-later { color: var(--text-2); font-weight: 500; }
.ap-fix { color: var(--text); }
.ap-todos { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 4px; }
.ap-log { margin: 6px 0 0; padding: 10px 12px; background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 10px; font-size: 12px;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; color: var(--text); }
.ap-rows details summary { cursor: pointer; color: var(--text-2); }
.ap-facts { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 12px; }
.ap-facts dt { font-size: 13px; color: var(--text-3); }
.ap-facts dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.ap-problem { display: flex; gap: 10px; align-items: baseline; }
.ap-h2.big { font-size: 20px; }
.ct-presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 12px; }
.ct-preset { text-align: left; border: 1px solid var(--border-strong); border-radius: 14px; padding: 16px; background: var(--surface); color: var(--text);
  font: inherit; display: flex; flex-direction: column; gap: 6px; cursor: pointer; min-height: 44px; }
.ct-preset.on { border: 2px solid var(--text); padding: 15px; }
.ct-count { font-size: 12px; color: var(--text-3); margin-top: auto; }
.ct-legends-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.ct-legends { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 12px; }
.ct-legend { position: relative; border: 1px solid var(--border); border-radius: 14px; padding: 16px 8px 12px; background: var(--surface); color: var(--text);
  font: inherit; display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; text-align: center; min-width: 0; }
.ct-legend.on { border: 2px solid var(--text); padding: 15px 7px 11px; }
.ct-legend strong { overflow-wrap: anywhere; }
.ct-legend .ap-hint { font-size: 12px; }
.ct-tick { position: absolute; top: 8px; right: 8px; width: 20px; height: 20px; border-radius: 50%; background: var(--primary); color: var(--on-primary);
  display: inline-flex; align-items: center; justify-content: center; }
.ct-tick svg { width: 12px; height: 12px; }
.ct-own { border-style: dashed; }
.ct-plus { width: 64px; height: 64px; border-radius: 50%; border: 1px dashed var(--border-strong); display: inline-flex; align-items: center;
  justify-content: center; color: var(--text-2); }
.ct-team { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ct-team li { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.ct-team input[type="text"] { height: 36px; }
.ct-pic { position: relative; flex: none; cursor: pointer; }
.ct-pic input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
.ct-pic:focus-within { outline: 2px solid var(--text); outline-offset: 2px; }
@media (max-width: 640px) { .ap-card { padding: 24px 18px; } .ap-head h1 { font-size: 26px; } .ap-split { gap: 32px; } }
`;
