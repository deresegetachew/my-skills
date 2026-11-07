// The sign-in page (#542): with mail set up on the server, an email address, then the 6-digit code it mailed; the
// token stays one click away (and is the only way when no mail is set up). The cookie is set by the server; the page
// never sees it.
import { useState } from "react";
import { type AuthInfo, gateLead } from "./signin_model.ts";

interface Said {
  message?: string;
  fix?: string;
}

async function post(path: string, body: unknown): Promise<{ status: number; said: Said }> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, said: (await r.json().catch(() => ({}))) as Said };
  } catch {
    return { status: 0, said: { message: "The server can't be reached.", fix: "Check that the web UI still runs on that machine." } };
  }
}

export function SignInGate({ info, wrong, onToken, onSession }: { info: AuthInfo | null; wrong: boolean; onToken: (t: string) => void;
  onSession: () => void }) {
  const [step, setStep] = useState<"email" | "code" | "token">(info?.mail ? "email" : "token");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState<Said | null>(null);
  const [busy, setBusy] = useState(false);

  const askCode = async (): Promise<void> => {
    setBusy(true);
    const r = await post("/api/auth/code", { email });
    setBusy(false);
    setNote(r.said);
    if (r.status === 202) setStep("code");
  };
  const verify = async (): Promise<void> => {
    setBusy(true);
    const r = await post("/api/auth/verify", { email, code });
    setBusy(false);
    if (r.status === 200) onSession();
    else setNote(r.said);
  };

  return (
    <main className="gate">
      <h1>Factory</h1>
      {step !== "code" && <p>{step === "token" && info?.mail ? "Paste the token the server printed when it started (it is kept in .git/factory/ui-token)." : gateLead(info, wrong)}</p>}
      {step === "email" && (
        <form onSubmit={(e) => { e.preventDefault(); if (email.trim() && !busy) void askCode(); }}>
          <input aria-label="Email address" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com" autoFocus />
          <button className="btn primary" type="submit" disabled={busy}>Send code</button>
        </form>
      )}
      {step === "code" && (
        <>
          <p>{note?.message ?? "If this address is allowed, a code is on its way."} Type the 6 digits.</p>
          <form onSubmit={(e) => { e.preventDefault(); if (code.trim() && !busy) void verify(); }}>
            <input aria-label="Code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" autoFocus />
            <button className="btn primary" type="submit" disabled={busy}>Sign in</button>
          </form>
        </>
      )}
      {step === "token" && (
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) onToken(text.trim()); }}>
          <input aria-label="Token" value={text} onChange={(e) => setText(e.target.value)} placeholder="token" autoFocus />
          <button className="btn primary" type="submit">Open</button>
        </form>
      )}
      {note && step !== "code" && note.message && <p role="alert">{note.message} {note.fix}</p>}
      {note && step === "code" && note.fix && <p role="alert">{note.fix}</p>}
      {info?.mail && (
        <p>
          {step !== "email" && <button className="btn" type="button" onClick={() => { setStep("email"); setCode(""); setNote(null); }}>Use a code by email</button>}
          {" "}
          {step !== "token" && <button className="btn" type="button" onClick={() => { setStep("token"); setNote(null); }}>Use the token</button>}
        </p>
      )}
    </main>
  );
}
