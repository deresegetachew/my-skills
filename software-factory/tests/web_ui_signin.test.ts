// Signing in to the web UI with a code sent by email (#542). Two halves:
//
// - The sign-in's own answers (factory_ui_auth.ts's SignIn, as the server asks it), with a fake mail adapter that
//   records what it was asked to send and a clock the test moves: one mail for an allowed address and none for
//   another, the same answer for both; a code right once, then refused reused, expired and wrong; the limits and the
//   lockout; the cookie's flags.
// - The real server (`factory ui`, on a free port) with its mail going to a fake HTTP mail API in this process: the
//   session opens the API and the WebSocket, a cross-origin request with the cookie is refused, `factory ui sessions`
//   lists and revokes, and the token still works.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notifier } from "../hooks/core/ports/notifications.ts";
import { type Limits, LIMIT_DEFAULTS, SignIn } from "../hooks/factory_ui_auth.ts";
import { api, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { BUN, HOOKS, sh, write } from "./support.ts";

const T = 60_000;
const roots: string[] = [];
const running: Running[] = [];
let configDir = "";
const before = process.env.FACTORY_CONFIG_DIR;
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "signin-config-"));
  process.env.FACTORY_CONFIG_DIR = configDir; // the sessions file of the in-process half
});
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of [...roots, configDir]) rmSync(d, { recursive: true, force: true });
  if (before === undefined) delete process.env.FACTORY_CONFIG_DIR;
  else process.env.FACTORY_CONFIG_DIR = before;
});

// --- the sign-in's answers, with a fake mail adapter ------------------------------------------------------------------

interface Mail {
  to: string;
  subject: string;
  text: string;
}

class FakeMail implements Notifier {
  sent: Mail[] = [];
  hold: Promise<void> | null = null;
  async send(to: string, subject: string, text: string): Promise<void> {
    this.sent.push({ to, subject, text });
    if (this.hold) await this.hold;
  }
}

const OWNER = "owner@example.com";

function signIn(o: { mail?: FakeMail | null; limits?: Partial<Limits>; allowed?: string[] } = {}) {
  let t = Date.parse("2026-11-07T10:00:00Z");
  const mail = o.mail === undefined ? new FakeMail() : o.mail;
  const s = new SignIn({ port: 4747, notifier: () => mail, now: () => t,
    settings: () => ({ allowed: o.allowed ?? [OWNER], limits: { ...LIMIT_DEFAULTS, ...o.limits } }) });
  const ask = async (path: string, body: unknown, more: { ip?: string; url?: string; headers?: Record<string, string> } = {}) => {
    const url = new URL((more.url ?? "http://127.0.0.1:4747") + path);
    const req = new Request(url, { method: "POST", headers: { host: url.host, "content-type": "application/json", ...more.headers }, body: JSON.stringify(body) });
    const a = await s.api(req, url, more.ip ?? "10.0.0.1");
    if (!a) throw new Error(`no answer for ${path}`);
    return a;
  };
  return { s, mail, ask, move: (ms: number) => { t += ms; } };
}

/** Lets the mail that goes out after the answer go. */
const settle = (): Promise<void> => Bun.sleep(20);

function codeIn(m: Mail | undefined): string {
  return /\b(\d{6})\b/.exec(m?.text ?? "")?.[1] ?? "";
}

test("an allowed address gets exactly one mail with a 6-digit code; another gets none; both get the same answer", async () => {
  const { mail, ask } = signIn();
  const allowed = await ask("/api/auth/code", { email: "Owner@Example.com " });
  const other = await ask("/api/auth/code", { email: "stranger@example.com" });
  await settle();
  expect(allowed.status).toBe(202);
  expect(other.status).toBe(allowed.status);
  expect(other.body).toEqual(allowed.body);
  expect(String(allowed.body.message)).toContain("If this address is allowed, a code is on its way");
  expect(mail?.sent.length).toBe(1);
  expect(mail?.sent[0]?.to).toBe(OWNER);
  expect(codeIn(mail?.sent[0])).toMatch(/^\d{6}$/);
  expect(mail?.sent[0]?.text).toContain("10 minutes");
});

test("the answer doesn't wait for the mail, so its time doesn't say whether the address is allowed", async () => {
  const fake = new FakeMail();
  let release = (): void => {};
  fake.hold = new Promise<void>((done) => { release = done; }); // the mail service never answers while we look
  const { ask } = signIn({ mail: fake });
  const started = performance.now();
  const a = await ask("/api/auth/code", { email: OWNER });
  const took = performance.now() - started;
  expect(a.status).toBe(202);
  expect(took).toBeLessThan(500);
  await settle();
  expect(fake.sent.length).toBe(1); // it went out after the answer
  release();
});

test("the right code works once; then it is refused reused, and a wrong or expired code is refused", async () => {
  const { mail, ask, move } = signIn();
  await ask("/api/auth/code", { email: OWNER });
  await settle();
  const code = codeIn(mail?.sent[0]);
  const wrongCode = code === "000000" ? "111111" : "000000";
  const wrong = await ask("/api/auth/verify", { email: OWNER, code: wrongCode });
  expect(wrong.status).toBe(401);
  expect(wrong.body.code).toBe("ui_code_wrong");
  const right = await ask("/api/auth/verify", { email: OWNER, code });
  expect(right.status).toBe(200);
  expect(right.body).toMatchObject({ ok: true, email: OWNER });
  const reused = await ask("/api/auth/verify", { email: OWNER, code });
  expect(reused.status).toBe(401);
  expect(reused.body.code).toBe("ui_code_wrong");

  await ask("/api/auth/code", { email: OWNER });
  await settle();
  const late = codeIn(mail?.sent[1]);
  move(10 * 60_000 + 1000);
  const expired = await ask("/api/auth/verify", { email: OWNER, code: late });
  expect(expired.status).toBe(401);
  expect(expired.body).toMatchObject({ code: "ui_code_wrong" });
  expect(Object.keys(expired.body).sort()).toEqual(["code", "fix", "message"]);
});

test("a code for an address that isn't allowed never works, and the refusal is the same as for a wrong one", async () => {
  const { ask } = signIn();
  await ask("/api/auth/code", { email: "stranger@example.com" });
  const r = await ask("/api/auth/verify", { email: "stranger@example.com", code: "123456" });
  expect(r.status).toBe(401);
  expect(r.body.code).toBe("ui_code_wrong");
});

test("too many wrong codes lock the address, even for the right code, until the lockout ends", async () => {
  const { mail, ask, move } = signIn({ limits: { maxWrongCodes: 3, lockoutMinutes: 15 } });
  await ask("/api/auth/code", { email: OWNER });
  await settle();
  const code = codeIn(mail?.sent[0]);
  const bad = code === "999999" ? "888888" : "999999";
  expect((await ask("/api/auth/verify", { email: OWNER, code: bad })).status).toBe(401);
  expect((await ask("/api/auth/verify", { email: OWNER, code: bad }, { ip: "10.0.0.2" })).status).toBe(401);
  const third = await ask("/api/auth/verify", { email: OWNER, code: bad }, { ip: "10.0.0.3" }); // per address, from any IP
  expect(third.status).toBe(429);
  expect(third.body.code).toBe("ui_signin_locked");
  const locked = await ask("/api/auth/verify", { email: OWNER, code });
  expect(locked.status).toBe(429);
  expect(locked.body.code).toBe("ui_signin_locked");
  move(15 * 60_000 + 1000);
  const after = await ask("/api/auth/verify", { email: OWNER, code }); // the lock threw that code away
  expect(after.status).toBe(401);
  await ask("/api/auth/code", { email: OWNER });
  await settle();
  expect((await ask("/api/auth/verify", { email: OWNER, code: codeIn(mail?.sent.at(-1)) })).status).toBe(200);
});

test("wrong codes from one IP across many addresses lock that IP", async () => {
  const { ask } = signIn({ limits: { maxWrongCodes: 2 } }); // an IP: 4 times that
  for (let i = 0; i < 7; i++) expect((await ask("/api/auth/verify", { email: `x${i}@example.com`, code: "123456" }, { ip: "10.9.9.9" })).status).toBe(401);
  const eighth = await ask("/api/auth/verify", { email: "x8@example.com", code: "123456" }, { ip: "10.9.9.9" });
  expect(eighth.status).toBe(429);
  expect((await ask("/api/auth/verify", { email: "y@example.com", code: "123456" }, { ip: "10.9.9.9" })).status).toBe(429);
  expect((await ask("/api/auth/verify", { email: "y@example.com", code: "123456" }, { ip: "10.1.1.1" })).status).toBe(401);
});

test("guessing codes for an address with no code waiting never locks its owner out", async () => {
  const { mail, ask } = signIn({ limits: { maxWrongCodes: 3 } });
  const answers: number[] = [];
  for (let i = 0; i < 10; i++) answers.push((await ask("/api/auth/verify", { email: OWNER, code: "123456" }, { ip: `10.3.0.${i}` })).status);
  expect(answers.slice(0, 2)).toEqual([401, 401]);
  expect(answers.slice(2).every((s) => s === 429)).toBe(true); // answered as a lock, the same as for any address
  expect((await ask("/api/auth/code", { email: OWNER })).status).toBe(202);
  await settle();
  expect(mail?.sent.length).toBe(1);
  expect((await ask("/api/auth/verify", { email: OWNER, code: codeIn(mail?.sent[0]) })).status).toBe(200);
});

test("this machine's own address is never locked or limited per IP: agents share it with the owner", async () => {
  const { mail, ask } = signIn({ limits: { maxWrongCodes: 2, codesPerHour: 1 } }); // per IP: 8 wrong codes, 4 codes
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    for (let i = 0; i < 12; i++) expect((await ask("/api/auth/verify", { email: `${ip.length}a${i}@example.com`, code: "123456" }, { ip })).status).toBe(401);
    for (let i = 0; i < 6; i++) expect((await ask("/api/auth/code", { email: `${ip.length}x${i}@example.com` }, { ip })).status).toBe(202);
  }
  expect((await ask("/api/auth/code", { email: OWNER }, { ip: "127.0.0.1" })).status).toBe(202);
  await settle();
  expect((await ask("/api/auth/verify", { email: OWNER, code: codeIn(mail?.sent.at(-1)) }, { ip: "127.0.0.1" })).status).toBe(200);
  // another IP still gets its lock
  for (let i = 0; i < 7; i++) await ask("/api/auth/verify", { email: `z${i}@example.com`, code: "123456" }, { ip: "10.4.4.4" });
  expect((await ask("/api/auth/verify", { email: "z8@example.com", code: "123456" }, { ip: "10.4.4.4" })).status).toBe(429);
});

test("a sign-in body over 4 KB is refused with 413, whether its length is declared or streamed", async () => {
  const { s, mail } = signIn();
  const big = JSON.stringify({ email: OWNER, pad: "x".repeat(5000) });
  for (const path of ["/api/auth/code", "/api/auth/verify"]) {
    const url = new URL("http://127.0.0.1:4747" + path);
    const declared = new Request(url, { method: "POST", headers: { host: url.host, "content-type": "application/json" }, body: big });
    const streamed = new Request(url, { method: "POST", headers: { host: url.host, "content-type": "application/json" },
      body: new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000))); c.close(); } }) });
    for (const req of [declared, streamed]) {
      const a = await s.api(req, url, "10.0.0.1");
      expect(a?.status).toBe(413);
      expect(a?.body.code).toBe("ui_body_too_large");
      expect(Object.keys(a?.body ?? {}).sort()).toEqual(["code", "fix", "message"]);
    }
  }
  await settle();
  expect(mail?.sent.length).toBe(0);
});

test("asking for codes is limited per address, allowed or not alike, and per IP", async () => {
  const { mail, ask } = signIn({ limits: { codesPerHour: 2 } });
  for (const email of [OWNER, "stranger@example.com"]) {
    expect((await ask("/api/auth/code", { email }, { ip: `10.0.1.${email.length}` })).status).toBe(202);
    expect((await ask("/api/auth/code", { email }, { ip: `10.0.2.${email.length}` })).status).toBe(202);
    const third = await ask("/api/auth/code", { email }, { ip: `10.0.3.${email.length}` });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("ui_codes_limit");
  }
  await settle();
  expect(mail?.sent.length).toBe(2);
  for (let i = 0; i < 8; i++) expect((await ask("/api/auth/code", { email: `n${i}@example.com` }, { ip: "10.7.7.7" })).status).toBe(202);
  expect((await ask("/api/auth/code", { email: "n9@example.com" }, { ip: "10.7.7.7" })).status).toBe(429);
});

test("the session cookie is HttpOnly, SameSite=Strict, for /api only, lasts the set days, and is Secure over HTTPS", async () => {
  for (const [url, secure] of [["http://127.0.0.1:4747", false], ["https://hub.example.ts.net", true]] as const) {
    const { mail, ask } = signIn({ limits: { sessionDays: 7 } });
    await ask("/api/auth/code", { email: OWNER }, { url });
    await settle();
    const r = await ask("/api/auth/verify", { email: OWNER, code: codeIn(mail?.sent[0]) }, { url });
    expect(r.status).toBe(200);
    const cookie = r.headers?.["set-cookie"] ?? "";
    expect(cookie).toMatch(/^factory_session_4747=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toContain("; Path=/api;");
    expect(cookie).toContain(`; Max-Age=${7 * 86_400};`);
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; SameSite=Strict");
    expect(cookie.includes("; Secure")).toBe(secure);
  }
});

test("a sign-in request from another origin is refused, and nothing is mailed", async () => {
  const { mail, ask } = signIn();
  const r = await ask("/api/auth/code", { email: OWNER }, { headers: { origin: "http://127.0.0.1:4748" } });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe("ui_cross_origin");
  await settle();
  expect(mail?.sent.length).toBe(0);
});

test("with no mail set up, asking for a code says to sign in with the token", async () => {
  const { s, ask } = signIn({ mail: null });
  const r = await ask("/api/auth/code", { email: OWNER });
  expect(r.status).toBe(503);
  expect(r.body.code).toBe("ui_mail_unset");
  expect(String(r.body.fix)).toContain("?token=");
  const url = new URL("http://127.0.0.1:4747/api/auth");
  const info = await s.api(new Request(url, { headers: { host: url.host } }), url, "10.0.0.1");
  expect(info?.body).toMatchObject({ signedIn: false, mail: false });
});

// --- the real server, its mail going to a fake HTTP mail API ----------------------------------------------------------

interface Got {
  headers: Record<string, string>;
  body: Row;
}

const got: Got[] = [];
let fakeApi: ReturnType<typeof Bun.serve> | null = null;
function mailApi(): string {
  fakeApi ??= Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    got.push({ headers: Object.fromEntries(req.headers.entries()), body: (await req.json()) as Row });
    return Response.json({ id: "fake" });
  } });
  return `http://127.0.0.1:${fakeApi.port}/emails`;
}
afterAll(() => {
  fakeApi?.stop(true);
});

const SECRET = "re_fake_key_never_printed_42";

/** A project whose machine has mail set (to the fake API) and OWNER allowed; its server started. */
async function hub(): Promise<{ p: Project; ui: Running; config: string }> {
  const p = project();
  roots.push(p.root);
  const config = join(p.root, "config", "software-factory");
  write(join(config, "ui", "mail.json"), JSON.stringify({ kind: "http", preset: "", url: mailApi(), header: "Authorization: Bearer {{secret}}",
    body: '{"from": {{from}}, "to": [{{to}}], "subject": {{subject}}, "text": {{text}}}', from: "Factory <factory@example.com>", secret: SECRET }), 0o600);
  write(join(config, "work.json"), JSON.stringify({ "ui.signIn.allowed": [OWNER] }));
  const ui = await startUi(p);
  running.push(ui);
  return { p, ui, config };
}

async function post(ui: Running, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Row; cookie: string }> {
  const r = await fetch(ui.url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Row, cookie: r.headers.get("set-cookie") ?? "" };
}

async function codeFor(email: string, since: number): Promise<string> {
  for (let i = 0; i < 100 && got.length <= since; i++) await Bun.sleep(50);
  const text = String(got[since]?.body.text ?? "");
  expect(got[since]?.body.to).toEqual([email]);
  return /\b(\d{6})\b/.exec(text)?.[1] ?? "";
}

/** Signs OWNER in on `ui`; the cookie as a browser sends it back. */
async function signedIn(ui: Running): Promise<string> {
  const since = got.length;
  expect((await post(ui, "/api/auth/code", { email: OWNER })).status).toBe(202);
  const code = await codeFor(OWNER, since);
  const r = await post(ui, "/api/auth/verify", { email: OWNER, code });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.cookie.split(";")[0] ?? "";
}

async function get(ui: Running, path: string, headers: Record<string, string>): Promise<{ status: number; json: Row }> {
  const r = await fetch(ui.url + path, { headers });
  return { status: r.status, json: (await r.json()) as Row };
}

function wsHello(ui: Running, headers: Record<string, string>, query = ""): Promise<string> {
  return new Promise((done) => {
    const ws = new WebSocket(ui.url.replace("http", "ws") + "/api/ws" + query, { headers } as unknown as string[]);
    const timer = setTimeout(() => { ws.close(); done("timeout"); }, 10_000);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      ws.close();
      done(String((JSON.parse(String(e.data)) as Row).type));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done("refused");
    };
  });
}

test("the page learns that codes can be mailed; the mail goes to the API with the key, which is never in the answer", async () => {
  const { ui } = await hub();
  const info = await get(ui, "/api/auth", {});
  expect(info.status).toBe(200);
  expect(info.json).toMatchObject({ signedIn: false, mail: true, codeMinutes: 10 });
  expect(JSON.stringify(info.json)).not.toContain(OWNER);
  const since = got.length;
  const r = await post(ui, "/api/auth/code", { email: OWNER });
  expect(r.status).toBe(202);
  await codeFor(OWNER, since);
  expect(got[since]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  expect(got[since]?.body.from).toBe("Factory <factory@example.com>");
  const other = await post(ui, "/api/auth/code", { email: "stranger@example.com" });
  expect(other.json).toEqual(r.json);
  await Bun.sleep(300);
  expect(got.length).toBe(since + 1);
  expect(ui.out).not.toContain(SECRET);
}, T);

test("the session opens the API and the WebSocket; without it both are refused; GET /api/auth says who is signed in", async () => {
  const { ui } = await hub();
  const cookie = await signedIn(ui);
  expect(cookie).toMatch(/^factory_session_\d+=/);
  const projects = await get(ui, "/api/projects", { cookie });
  expect(projects.status).toBe(200);
  expect((projects.json.projects as Row[])[0]?.name).toBe("work");
  expect((await get(ui, "/api/auth", { cookie })).json).toMatchObject({ signedIn: true, email: OWNER });
  expect(await wsHello(ui, { cookie })).toBe("hello");
  expect((await get(ui, "/api/projects", {})).status).toBe(401);
  expect(await wsHello(ui, {})).toBe("refused");
  const forged = await get(ui, "/api/projects", { cookie: cookie.replace(/=.*/, "=" + "A".repeat(43)) });
  expect(forged.status).toBe(401);
}, T);

test("a cross-origin request with the cookie is refused, over HTTP and the WebSocket", async () => {
  const { ui } = await hub();
  const cookie = await signedIn(ui);
  const port = new URL(ui.url).port;
  const preview = `http://127.0.0.1:${Number(port) + 1}`; // another port of the same host: the same site, another origin
  const r = await get(ui, "/api/projects", { cookie, origin: preview });
  expect(r.status).toBe(403);
  expect(r.json.code).toBe("ui_cross_origin");
  expect((await get(ui, "/api/projects", { cookie, "sec-fetch-site": "same-site" })).status).toBe(403);
  const posted = await fetch(`${ui.url}/api/projects/work/agents/menelik/stop`, { method: "POST", headers: { cookie, origin: preview,
    "content-type": "text/plain" }, body: '{"confirm": true}' });
  expect(posted.status).toBe(403);
  expect(await wsHello(ui, { cookie, origin: preview })).toBe("refused");
  expect((await get(ui, "/api/projects", { cookie, origin: ui.url, "sec-fetch-site": "same-origin" })).status).toBe(200);
}, T);

function factoryUi(p: Project, args: string[]) {
  return sh([...BUN, join(HOOKS, "factory_ui.ts"), ...args], { cwd: p.d, env: p.env, timeoutMs: 30_000 });
}

test("factory ui sessions ls lists the session without its secret; revoke ends it at once; revoke all ends every one", async () => {
  const { p, ui, config } = await hub();
  const cookie = await signedIn(ui);
  const file = join(config, "ui", "sessions.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(config, "ui")).mode & 0o777).toBe(0o700);
  const value = cookie.split("=")[1] ?? "";
  expect(readFileSync(file, "utf8")).not.toContain(value); // only its hash is kept
  const ls = factoryUi(p, ["sessions", "ls", "--json"]);
  expect(ls.code, ls.out).toBe(0);
  const sessions = (JSON.parse(ls.stdout) as { sessions: Row[] }).sessions;
  expect(sessions.length).toBe(1);
  expect(sessions[0]).toMatchObject({ email: OWNER, ip: "127.0.0.1" });
  expect(Object.keys(sessions[0] as Row)).not.toContain("hash");
  const text = factoryUi(p, ["sessions", "ls"]);
  expect(text.stdout).toContain(OWNER);
  expect(text.stdout).toContain(String(sessions[0]?.id));
  expect(text.out).not.toContain(value);

  const revoked = factoryUi(p, ["sessions", "revoke", String(sessions[0]?.id)]);
  expect(revoked.code, revoked.out).toBe(0);
  expect(revoked.stdout).toContain(`Revoked session ${sessions[0]?.id}.`);
  const after = await get(ui, "/api/projects", { cookie });
  expect(after.status).toBe(401);
  expect(after.json.code).toBe("ui_session_ended");
  expect(await wsHello(ui, { cookie })).toBe("refused");

  const unknown = factoryUi(p, ["sessions", "revoke", "nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('"code": "ui_session_unknown"');
  const a = await signedIn(ui);
  const b = await signedIn(ui);
  const all = factoryUi(p, ["sessions", "revoke", "all"]);
  expect(all.stdout).toContain("Revoked 2 sessions.");
  for (const c of [a, b]) expect((await get(ui, "/api/projects", { cookie: c })).status).toBe(401);
  expect(factoryUi(p, ["sessions", "ls"]).stdout).toContain("No sign-in sessions on this machine.");
}, T);

/** A WebSocket opened with `cookie`, once it said hello; `closed` gives its close code (or "open" after `ms`). */
async function openSocket(ui: Running, cookie: string): Promise<{ closed: (ms: number) => Promise<number | "open">; ws: WebSocket }> {
  const ws = new WebSocket(ui.url.replace("http", "ws") + "/api/ws", { headers: { cookie } } as unknown as string[]);
  let code: number | null = null;
  ws.onclose = (e) => { code = e.code; };
  await new Promise<void>((done, failed) => {
    ws.onmessage = () => done();
    ws.onerror = () => failed(new Error("the socket was refused"));
  });
  return {
    ws,
    closed: async (ms) => {
      const end = Date.now() + ms;
      while (code === null && Date.now() < end) await Bun.sleep(50);
      return code ?? "open";
    },
  };
}

test("an open WebSocket is closed (4401) within a poll once its session is revoked or signed out", async () => {
  const { p, ui } = await hub(); // ui.pollSeconds is 1
  const a = await signedIn(ui);
  const b = await signedIn(ui);
  const sa = await openSocket(ui, a);
  const sb = await openSocket(ui, b);
  const tokenWs = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  let tokenClosed = false;
  tokenWs.onclose = () => { tokenClosed = true; };
  const ids = (JSON.parse(factoryUi(p, ["sessions", "ls", "--json"]).stdout) as { sessions: Row[] }).sessions.map((s) => String(s.id));
  const first = ids[0] as string; // made first: a's
  expect(factoryUi(p, ["sessions", "revoke", first]).code).toBe(0);
  expect(await sa.closed(4000)).toBe(4401);
  expect(await sb.closed(1500)).toBe("open"); // the other session's socket stays
  expect((await post(ui, "/api/auth/signout", {}, { cookie: b })).status).toBe(200);
  expect(await sb.closed(4000)).toBe(4401);
  expect(tokenClosed).toBe(false); // the token's socket isn't a session's
  tokenWs.close();
}, T);

test("session writes wait for the lock, so a revoke and a sign-in never undo each other; a dead holder's lock is taken over", async () => {
  const { p, ui, config } = await hub();
  const file = join(config, "ui", "sessions.json");
  const lock = `${file}.lock`;
  const cookie = await signedIn(ui);
  write(lock, "held");
  const revoking = Bun.spawn([...BUN, join(HOOKS, "factory_ui.ts"), "sessions", "revoke", "all"], { cwd: p.d,
    env: Object.fromEntries(Object.entries(p.env).filter((e): e is [string, string] => e[1] !== undefined)), stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(700);
  expect(revoking.exitCode).toBe(null); // waiting for the lock
  expect((await get(ui, "/api/projects", { cookie })).status).toBe(200);
  rmSync(lock);
  expect(await revoking.exited).toBe(0);
  expect(await new Response(revoking.stdout).text()).toContain("Revoked 1 session.");
  expect((await get(ui, "/api/projects", { cookie })).status).toBe(401);
  // a lock left by a process that died: older than 10 s, taken over
  write(lock, "left");
  utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const again = await signedIn(ui);
  expect((await get(ui, "/api/projects", { cookie: again })).status).toBe(200);
  expect(existsSync(lock)).toBe(false);
  expect(readFileSync(file, "utf8")).toContain('"sessions"');
}, T);

test("an over-long sign-in body is refused by the real server with 413", async () => {
  const { ui } = await hub();
  const r = await post(ui, "/api/auth/code", { email: OWNER, pad: "x".repeat(5000) });
  expect(r.status).toBe(413);
  expect(r.json.code).toBe("ui_body_too_large");
}, T);

test("signing out ends the session and clears the cookie", async () => {
  const { ui } = await hub();
  const cookie = await signedIn(ui);
  const r = await post(ui, "/api/auth/signout", {}, { cookie });
  expect(r.status).toBe(200);
  expect(r.cookie).toContain("Max-Age=0");
  expect((await get(ui, "/api/projects", { cookie })).status).toBe(401);
}, T);

test("the token still works for the API and the WebSocket, beside sign-in", async () => {
  const { ui } = await hub();
  const r = await api(ui, "/api/projects");
  expect(r.status).toBe(200);
  expect(await wsHello(ui, {}, `?token=${ui.token}`)).toBe("hello");
  expect((await api(ui, "/api/projects", { token: "wrong".repeat(10) })).json.code).toBe("ui_token_wrong");
}, T);

test("with no mail set up the server says so, and the token is the way in", async () => {
  const p = project();
  roots.push(p.root);
  const ui = await startUi(p);
  running.push(ui);
  expect((await get(ui, "/api/auth", {})).json).toMatchObject({ signedIn: false, mail: false });
  const r = await post(ui, "/api/auth/code", { email: OWNER });
  expect(r.status).toBe(503);
  expect(r.json.code).toBe("ui_mail_unset");
  expect((await api(ui, "/api/projects")).status).toBe(200);
}, T);

// --- the sessions lock names its holder (#607) ------------------------------------------------------------------------

import { writeFileSync } from "node:fs";

/** A process that stays alive until killed: its pid is a live holder for a lock. */
function sleeper() {
  return Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const s = Bun.spawn(["true"]);
  await s.exited;
  return s.pid;
}

function revokeAll(p: Project) {
  return Bun.spawn([...BUN, join(HOOKS, "factory_ui.ts"), "sessions", "revoke", "all"], { cwd: p.d,
    env: Object.fromEntries(Object.entries(p.env).filter((e): e is [string, string] => e[1] !== undefined)), stdout: "pipe", stderr: "pipe" });
}

function oldLock(lock: string, pid: number, ageMs: number): void {
  write(lock, `${pid}\n`);
  const t = new Date(Date.now() - ageMs);
  utimesSync(lock, t, t);
}

test("a lock naming a live process is never taken over, however old; it is when that process is gone", async () => {
  const { p, ui, config } = await hub();
  const lock = join(config, "ui", "sessions.json.lock");
  const cookie = await signedIn(ui);
  const holder = sleeper();
  oldLock(lock, holder.pid, 60_000);
  const revoking = revokeAll(p);
  await Bun.sleep(1200);
  expect(revoking.exitCode).toBe(null); // still waiting: the holder is alive
  expect((await get(ui, "/api/projects", { cookie })).status).toBe(200);
  holder.kill();
  await holder.exited;
  expect(await revoking.exited).toBe(0);
  expect(await new Response(revoking.stdout).text()).toContain("Revoked 1 session.");
}, T);

test("a lock naming a process that died is taken over at once, even when it is fresh", async () => {
  const { p, ui, config } = await hub();
  const lock = join(config, "ui", "sessions.json.lock");
  await signedIn(ui);
  write(lock, `${await deadPid()}\n`); // mtime is now
  const started = Date.now();
  const revoking = revokeAll(p);
  expect(await revoking.exited).toBe(0);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await new Response(revoking.stdout).text()).toContain("Revoked 1 session.");
}, T);

test("the server keeps answering while one of its own session writes waits for the lock", async () => {
  const { ui, config } = await hub();
  const lock = join(config, "ui", "sessions.json.lock");
  const cookie = await signedIn(ui);
  const holder = sleeper();
  oldLock(lock, holder.pid, 0); // fresh: today it is waited for, with the server frozen
  const signingOut = post(ui, "/api/auth/signout", {}, { cookie });
  await Bun.sleep(200);
  const started = Date.now();
  const other = await Promise.race([api(ui, "/api/projects"), Bun.sleep(3000).then(() => null)]);
  expect(other, "the server did not answer while a sign-out waited for the lock").not.toBe(null);
  expect(other?.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(1500);
  holder.kill();
  await holder.exited;
  expect((await signingOut).status).toBe(200);
}, T);

test("an open WebSocket is closed (4401) once its session has expired; a token socket stays open", async () => {
  const { ui, config } = await hub();
  const file = join(config, "ui", "sessions.json");
  const cookie = await signedIn(ui);
  const s = await openSocket(ui, cookie);
  const tokenWs = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  let tokenClosed = false;
  tokenWs.onclose = () => { tokenClosed = true; };
  const data = JSON.parse(readFileSync(file, "utf8")) as { sessions: Row[] };
  for (const x of data.sessions) x.expires = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  expect(await s.closed(6000)).toBe(4401);
  expect(tokenClosed).toBe(false);
  tokenWs.close();
}, T);

// --- takeovers are one at a time; the wait is bounded (#607) -----------------------------------------------------------

function revokeAllEnv(p: Project, extra: Record<string, string>) {
  const env = Object.fromEntries(Object.entries({ ...p.env, ...extra }).filter((e): e is [string, string] => e[1] !== undefined));
  return Bun.spawn([...BUN, join(HOOKS, "factory_ui.ts"), "sessions", "revoke", "all"], { cwd: p.d, env, stdout: "pipe", stderr: "pipe" });
}

test("a stale lock is taken over one waiter at a time: while another process holds the takeover flock the revoke waits", async () => {
  const { p, ui, config } = await hub();
  const lock = join(config, "ui", "sessions.json.lock");
  const takeover = join(config, "ui", "sessions.json.lock.takeover");
  await signedIn(ui);
  write(lock, `${await deadPid()}\n`);
  const script = join(p.d, "hold_takeover.ts");
  const ready = join(p.d, "takeover.ready");
  write(script, `import { openSync, writeFileSync } from "node:fs";
import { flock } from ${JSON.stringify(join(HOOKS, "factory_lib.ts"))};
const fd = openSync(${JSON.stringify(takeover)}, "a");
flock(fd, true);
writeFileSync(${JSON.stringify(ready)}, "held");
await Bun.sleep(60000);
`);
  const holder = Bun.spawn([...BUN, script], { stdout: "ignore", stderr: "ignore" });
  const revoking = revokeAll(p);
  try {
    for (let i = 0; i < 50 && !existsSync(ready); i++) await Bun.sleep(100);
    expect(existsSync(ready), "the helper never took the takeover flock").toBe(true);
    await Bun.sleep(1000);
    expect(revoking.exitCode, "the revoke finished while another process held the takeover flock").toBe(null);
    holder.kill();
    await holder.exited;
    const code = await Promise.race([revoking.exited, Bun.sleep(8000).then(() => -1)]);
    expect(code).toBe(0);
    expect(await new Response(revoking.stdout).text()).toContain("Revoked 1 session.");
  } finally {
    holder.kill();
    revoking.kill();
  }
}, T);

test("the wait for a lock is bounded: FACTORY_UI_LOCK_WAIT_MS, then exit 1 with ui_sessions_locked naming the lock file", async () => {
  const { p, ui, config } = await hub();
  const lock = join(config, "ui", "sessions.json.lock");
  const file = join(config, "ui", "sessions.json");
  const cookie = await signedIn(ui);
  const before = readFileSync(file, "utf8");
  const holder = sleeper();
  oldLock(lock, holder.pid, 0);
  const revoking = revokeAllEnv(p, { FACTORY_UI_LOCK_WAIT_MS: "1500" });
  try {
    const code = await Promise.race([revoking.exited, Bun.sleep(5000).then(() => null)]);
    expect(code, "the revoke was still waiting after 5 s; the wait is not bounded").toBe(1);
    const err = JSON.parse((await new Response(revoking.stderr).text()).trim()) as { code: string; message: string; fix: string };
    expect(err.code).toBe("ui_sessions_locked");
    expect(err.message).toContain(lock);
    expect(err.fix.length).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((await get(ui, "/api/projects", { cookie })).status).toBe(200);
  } finally {
    revoking.kill();
    holder.kill();
  }
}, T);

test("a sign-in whose session write gives up on the lock answers 503 with no file path, and the same code works after (#607)", async () => {
  const p = project();
  roots.push(p.root);
  const config = join(p.root, "config", "software-factory");
  write(join(config, "ui", "mail.json"), JSON.stringify({ kind: "http", preset: "", url: mailApi(), header: "Authorization: Bearer {{secret}}",
    body: '{"from": {{from}}, "to": [{{to}}], "subject": {{subject}}, "text": {{text}}}', from: "Factory <factory@example.com>", secret: SECRET }), 0o600);
  write(join(config, "work.json"), JSON.stringify({ "ui.signIn.allowed": [OWNER] }));
  p.env.FACTORY_UI_LOCK_WAIT_MS = "1000";
  const ui = await startUi(p);
  running.push(ui);
  const lock = join(config, "ui", "sessions.json.lock");
  const since = got.length;
  expect((await post(ui, "/api/auth/code", { email: OWNER })).status).toBe(202);
  const code = await codeFor(OWNER, since);
  const holder = sleeper();
  oldLock(lock, holder.pid, 0);
  try {
    const busy = await post(ui, "/api/auth/verify", { email: OWNER, code });
    expect(busy.status, JSON.stringify(busy.json)).toBe(503);
    expect(busy.json.code).toBe("ui_sessions_locked");
    expect(JSON.stringify(busy.json), "the page is told no path on this machine").not.toContain(config);
    expect(String(busy.json.fix).length).toBeGreaterThan(0);
  } finally {
    holder.kill();
    await holder.exited;
  }
  const again = await post(ui, "/api/auth/verify", { email: OWNER, code });
  expect(again.status, JSON.stringify(again.json)).toBe(200);
}, T);
