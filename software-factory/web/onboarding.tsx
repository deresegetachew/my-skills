// First launch (#457), after the owner's Welcome.dc.html, MachineCheck.dc.html and JoinHub.dc.html: the onboarding layout
// of Add a project (a centred white card on the subtle background, the setup stepper on top). Welcome offers three ways
// in; Machine check shows this machine's checks from Health (`factory doctor --json`, nothing changes by checking) with
// the one admin step that must be typed with sudo; Join my factory reads a join code and joins after a confirm. The rules
// are in onboarding_model.ts; no command is shown on screen apart from that admin step.
import { useCallback, useEffect, useState } from "react";
import { Check, Stepper } from "./add_project.tsx";
import { Avatar } from "./avatar_view.tsx";
import { firstLaunch, joinHolds, type JoinPreview, joinProblem, machineCheck, type MachineRow, WELCOME_CHOICES } from "./onboarding_model.ts";
import type { HealthData } from "./ops_model.ts";
import { ConfirmDialog, ListRow, StatusDot } from "./parts.tsx";
import type { ConfirmSpec } from "./parts_model.ts";

type Get = <T>(path: string) => Promise<T>;
type Post = (path: string, body: unknown) => Promise<Record<string, unknown>>;

const WELCOMED_KEY = "factory-ui-welcomed";

/** This browser left Welcome once (kept, so it doesn't open by itself again). */
export function welcomed(): boolean {
  try {
    return localStorage.getItem(WELCOMED_KEY) === "1";
  } catch {
    return false;
  }
}

export function keepWelcomed(): void {
  try {
    localStorage.setItem(WELCOMED_KEY, "1");
  } catch {
    // a private window: Welcome may show again next time
  }
}

/** Welcome opens by itself on this first visit. */
export function opensWelcome(storedProject: string | null, hash: string): boolean {
  return firstLaunch(storedProject, welcomed(), hash);
}

function Top({ status }: { status: string }) {
  return (
    <header className="ap-top">
      <span className="ap-logo"><span aria-hidden="true">F</span>factory</span>
      <span className="ap-hint" role="status">{status}</span>
    </header>
  );
}

// --- Welcome -------------------------------------------------------------------------------------------------------------

const TEAM = [["mentewab", "product-owner", "Product owner"], ["fasil", "dev-manager", "Dev manager"], ["haile", "coding-agent", "Builder"],
  ["taytu", "coding-agent", "Builder"], ["menelik", "coding-agent", "Builder"]];

export function WelcomePage({ go, skip }: { go: (hash: string) => void; skip: () => void }) {
  return (
    <div className="ap-page">
      <Top status="Not set up yet" />
      <Stepper current={0} />
      <main className="ap-card wide">
        <div className="ob-hero">
          <div className="ob-team" aria-hidden="true">
            {TEAM.map(([n, role, words]) => (
              <span key={n} className="ob-member"><Avatar name={n as string} role={role} size={56} /><strong>{n}</strong><span className="ap-hint">{words}</span></span>
            ))}
          </div>
          <h1>Welcome to your factory</h1>
          <p>Five AI agents build your project one task at a time. They write the tests first, open a pull request and review each other.
            You decide what only a person should: product calls, protected merges and releases.</p>
        </div>
        <section className="ap-section" aria-labelledby="ob-how">
          <h2 id="ob-how" className="ap-h2 big">How do you want to start?</h2>
          <div className="ob-choices">
            {WELCOME_CHOICES.map((c) => (
              <article key={c.id} className="ob-choice">
                <span className="ob-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true"><path d={c.icon} /></svg>
                </span>
                <h3>{c.title}</h3>
                <p className="ap-hint">{c.body}</p>
                <a href={c.hash} className={`btn${c.primary ? " primary" : ""}`} onClick={(e) => { e.preventDefault(); keepWelcomed(); go(c.hash); }}>{c.cta}</a>
              </article>
            ))}
          </div>
        </section>
        <div className="ap-foot">
          <span className="ap-hint">Already set up? Your projects are one click away.</span>
          <button className="btn" onClick={() => { keepWelcomed(); skip(); }}>Go to my projects</button>
        </div>
      </main>
    </div>
  );
}

// --- Machine check -------------------------------------------------------------------------------------------------------

function RowMark({ row }: { row: MachineRow }) {
  if (row.state === "Ready") return <span className="ob-ok"><Check /></span>;
  return <span className="ob-dotwrap"><StatusDot state={row.tone === "bad" ? "red" : "waiting"} /></span>;
}

function AdminStep({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ob-admin">
      <pre><code>{text}</code></pre>
      <button className="btn" aria-label="Copy the command" onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false));
      }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

export function MachineCheckPage({ project, get, post, go }: { project: string; get: Get; post: Post; go: (hash: string) => void }) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(project)}/health`;
  const read = useCallback(() => get<HealthData>(base).then(setHealth).catch(() => setHealth({ ranAt: null, ok: null, running: false,
    counts: { ok: 0, warning: 0, failed: 0 }, groups: [], problems: [{ code: "ui_unreachable", message: "The server can't be reached.", fix: "Is the web UI still running?" }] })),
  [get, base]);
  useEffect(() => {
    void read();
  }, [read]);
  useEffect(() => { // the first run goes on in the background: look again until it is done
    if (!health?.running) return;
    const t = setTimeout(() => void read(), 3000);
    return () => clearTimeout(t);
  }, [health, read]);
  const again = async (): Promise<void> => {
    setBusy(true);
    setHealth((h) => (h ? { ...h, running: true } : h));
    try {
      setHealth((await post(`${base}/check`, {})) as unknown as HealthData);
    } finally {
      setBusy(false);
    }
  };
  const m = machineCheck(health);
  const checking = busy || health?.running === true;
  return (
    <div className="ap-page">
      <Top status="Checking this machine" />
      <Stepper current={1} />
      <main className="ap-card wide">
        <div className="ob-headrow">
          <div className="ap-head">
            <h1>Check this machine</h1>
            <p role="status">{checking && health?.ranAt ? <><StatusDot state="waiting" />Checking again…</> : m.summary}</p>
          </div>
          <div className="ap-row">
            <button className="btn" disabled={checking} onClick={() => void again()}>Check again</button>
            <button className="btn primary" disabled={!m.ready || checking} onClick={() => go("#/add-project")}>Continue</button>
          </div>
        </div>
        {m.groups.map((g) => (
          <section key={g.id} className="ob-group" aria-labelledby={`ob-g-${g.id}`}>
            <div className="ob-grouphead"><h2 id={`ob-g-${g.id}`} className="ap-h2">{g.title}</h2><span className="ap-hint">{g.note}</span></div>
            <ul className="ob-rows">
              {g.rows.map((r, i) => (
                <li key={`${i}-${r.name}`}>
                  <div className="ob-row">
                    <RowMark row={r} />
                    <span className="ap-grow"><span className="ob-name">{r.name}</span>{r.fix && <span className="ap-hint ob-fix">{r.fix}</span>}</span>
                    <span className={`ob-state ${r.tone}`}>{r.state}</span>
                  </div>
                  {r.admin && (
                    <div className="ob-adminbox">
                      <p className="ap-hint">This needs root, and this page never asks for your password, so type it once yourself in a terminal on this machine.
                        When it is done, press Check again.</p>
                      <AdminStep text={r.admin} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
        <div className="ap-foot">
          <button className="btn" onClick={() => go("#/welcome")}>Back</button>
          <span className="ap-hint">{m.ready ? "Next: add a project." : "Continue turns on once nothing needs a fix. A note is worth a look but doesn't stop you."}</span>
        </div>
      </main>
    </div>
  );
}

// --- Join my factory -----------------------------------------------------------------------------------------------------

interface Answer {
  ok?: boolean;
  code?: string;
  message?: string;
  fix?: string;
  output?: string;
}

export function JoinPage({ post, go }: { post: Post; go: (hash: string) => void }) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [refused, setRefused] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Answer | null>(null);
  const wrong = joinProblem(code);

  useEffect(() => { // read the code as soon as it looks like one: what it connects to, nothing changed
    setPreview(null);
    setRefused(null);
    if (wrong) return;
    let gone = false;
    void post("/api/setup/join/preview", { code }).then((r) => {
      if (gone) return;
      if (typeof r.machine === "string") setPreview(r as unknown as JoinPreview);
      else setRefused(r as Answer);
    });
    return () => {
      gone = true;
    };
  }, [code, wrong, post]);

  const hub = preview?.hub ?? "the hub";
  const spec: ConfirmSpec = {
    title: `Join ${hub}?`,
    checks: [{ title: "The code is a join code that hasn't expired", met: preview !== null && (preview.expiresAt * 1000 > Date.now()) }],
    happens: `This machine checks it can reach ${hub} over Tailscale, uses the code once to get its own login to the message board (kept on this machine only), then checks this machine.`,
    doesNot: "No agent is started, and nothing changes on the hub apart from the code being used. If it fails, nothing is changed here.",
    action: `Join ${hub}`,
    tone: "primary",
  };
  const join = async (): Promise<void> => {
    setAsking(false);
    setBusy(true);
    try {
      setDone((await post("/api/setup/join", { code, confirm: true })) as Answer);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ap-page">
      <Top status={preview ? `Joining ${preview.hub}` : "Joining a factory"} />
      <Stepper current={2} />
      <main className="ap-card">
        <div className="ap-head">
          <h1>{done?.ok ? "This machine is part of your factory" : "Join my factory"}</h1>
          <p>{done?.ok ? "It talks to the message board on the hub now. Add a project to start its agents here."
            : "Paste the code from the machine that runs your factory. It holds everything this machine needs to connect."}</p>
        </div>
        {done?.ok ? (
          <>
            {done.output && <details><summary className="ap-hint">What it did</summary><pre className="ap-log">{done.output}</pre></details>}
            <div className="ap-foot">
              <span className="ap-hint">Next: add a project.</span>
              <button className="btn primary" onClick={() => go("#/add-project")}>Add a project</button>
            </div>
          </>
        ) : (
          <>
            <div className="ap-field">
              <label htmlFor="ob-join-code">Join code</label>
              <input id="ob-join-code" type="text" className="mono" value={code} autoComplete="off" spellCheck={false}
                placeholder="FM1-…" onChange={(e) => setCode(e.target.value)} />
              <span className="ap-hint">{code.trim() && wrong ? wrong : "No code yet? On the hub open Machines › Add machine."}</span>
            </div>
            {refused && <p className="ap-hint ob-problem" role="alert"><StatusDot state="red" /><span><span className="ap-ink">{refused.message}</span> {refused.fix}</span></p>}
            {preview && (
              <section aria-label="What this code holds" className="ap-section">
                <h2 className="ap-h2">This code connects you to</h2>
                <ul className="lrows ap-rows">
                  {joinHolds(preview).map((h) => <ListRow key={h.label} title={h.value} sub={h.sub} action={<span className="ap-where">{h.label}</span>} />)}
                </ul>
              </section>
            )}
            {done && !done.ok && (
              <p className="ap-hint ob-problem" role="alert"><StatusDot state="red" /><span><span className="ap-ink">{done.message}</span> {done.fix}</span></p>
            )}
            <div className="ap-foot">
              <button className="btn" onClick={() => go("#/welcome")}>Not mine, go back</button>
              <button className="btn primary" disabled={!preview || busy} onClick={() => setAsking(true)}>{busy ? "Joining…" : `Join ${preview?.hub ?? ""}`.trim()}</button>
            </div>
            <p className="ap-hint">If the code has expired, nothing is changed here: ask for a new code on the hub in Machines › Add machine and paste it above.</p>
          </>
        )}
      </main>
      {asking && <ConfirmDialog spec={spec} busy={busy} onCancel={() => setAsking(false)} onConfirm={() => void join()} />}
    </div>
  );
}

export const ONBOARDING_CSS = String.raw`
.ob-hero { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 16px; }
.ob-hero h1 { margin: 0; font: 700 40px/1.1 var(--title-font); }
.ob-hero p { margin: 0; max-width: 640px; color: var(--text-2); font-size: 16px; line-height: 1.5; }
.ob-team { display: flex; flex-wrap: wrap; justify-content: center; gap: 20px; }
.ob-member { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 72px; }
.ob-member .ap-hint { font-size: 12px; }
.ob-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px; }
.ob-choice { border: 1px solid var(--border); border-radius: 14px; padding: 20px; display: flex; flex-direction: column; gap: 10px; background: var(--surface); }
.ob-choice h3 { margin: 0; font-size: 16px; }
.ob-choice p { margin: 0; flex: 1; }
.ob-choice .btn { align-self: flex-start; text-decoration: none; display: inline-flex; align-items: center; }
.ob-icon { width: 44px; height: 44px; border-radius: 12px; background: var(--bg-subtle); display: inline-flex; align-items: center; justify-content: center; }
.ob-headrow { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 16px; }
.ob-group { display: flex; flex-direction: column; gap: 8px; }
.ob-grouphead { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.ob-rows { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 14px; }
.ob-rows > li + li { border-top: 1px solid var(--border); }
.ob-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; min-height: 44px; }
.ob-name { font-weight: 600; overflow-wrap: anywhere; }
.ob-fix { white-space: pre-line; overflow-wrap: anywhere; }
.ob-ok, .ob-dotwrap { width: 24px; height: 24px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text); }
.ob-ok svg { width: 16px; height: 16px; }
.ob-state { font-size: 13px; color: var(--text-2); white-space: nowrap; }
.ob-state.bad { color: var(--text); font-weight: 600; }
.ob-adminbox { padding: 0 16px 16px 52px; display: flex; flex-direction: column; gap: 8px; }
.ob-adminbox p { margin: 0; }
.ob-admin { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
.ob-admin pre { flex: 1 1 260px; min-width: 0; margin: 0; padding: 12px; background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 10px;
  font: 13px/1.5 var(--mono); overflow-x: auto; color: var(--text); }
.ob-problem { display: flex; gap: 8px; align-items: baseline; margin: 0; }
@media (max-width: 640px) { .ob-hero h1 { font-size: 28px; } .ob-adminbox { padding-left: 16px; } .ob-row { flex-wrap: wrap; } }
`;
