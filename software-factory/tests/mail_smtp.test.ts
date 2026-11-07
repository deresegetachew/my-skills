// The SMTP adapter of the notifications port (#542, hooks/core/adapters/mail/smtp.ts), against a fake SMTP server on
// localhost with a certificate made for the test: STARTTLS and implicit TLS, AUTH PLAIN and LOGIN, the message as it
// arrives, and the refusals (no STARTTLS offered, a wrong password, a certificate that isn't trusted), whose text never
// holds the password. Also `factory ui mail set smtp` then `factory ui mail test` through the same fake server.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { CoreError } from "../hooks/core/domain/error.ts";
import { SmtpNotifier, type SmtpMail } from "../hooks/core/adapters/mail/smtp.ts";
import { project } from "./web_ui_support.ts";
import { BUN, HOOKS, sh } from "./support.ts";

const PASSWORD = "smtp-Pa55word-never-shown";
let dir = "";
let key: Buffer;
let cert: Buffer;
let caFile = "";
const servers: Server[] = [];
const roots: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "smtp-test-"));
  const made = sh(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
  if (made.code !== 0) throw new Error(`openssl could not make the test certificate: ${made.out}`);
  key = readFileSync(join(dir, "key.pem"));
  cert = readFileSync(join(dir, "cert.pem"));
  caFile = join(dir, "cert.pem");
});
afterAll(() => {
  for (const s of servers) s.close();
  for (const d of [dir, ...roots]) rmSync(d, { recursive: true, force: true });
});

interface Fake {
  port: number;
  /** Each command as the server read it, with whether the connection was encrypted then. */
  log: { line: string; tls: boolean }[];
  messages: string[];
}

interface FakeOptions {
  implicit?: boolean;
  starttls?: boolean;
  auth?: string[];
}

function fakeSmtp(o: FakeOptions = {}): Promise<Fake> {
  const fake: Fake = { port: 0, log: [], messages: [] };
  const offers = (tls: boolean): string[] => ["fake.local", ...(!tls && o.starttls !== false ? ["STARTTLS"] : []), `AUTH ${(o.auth ?? ["PLAIN", "LOGIN"]).join(" ")}`];
  const talk = (first: Socket | TLSSocket, startTls: boolean): void => {
    let sock: Socket | TLSSocket = first;
    let tls = startTls;
    let buffer = "";
    let data: string[] | null = null;
    let login: "user" | "pass" | null = null;
    let user = "";
    const say = (line: string): void => {
      sock.write(line + "\r\n");
    };
    const onLine = (line: string): void => {
      if (data) {
        if (line === ".") {
          fake.messages.push(data.join("\r\n"));
          data = null;
          say("250 2.0.0 queued");
        } else data.push(line);
        return;
      }
      fake.log.push({ line, tls });
      if (login === "user") {
        user = Buffer.from(line, "base64").toString();
        login = "pass";
        return say("334 UGFzc3dvcmQ6");
      }
      if (login === "pass") {
        login = null;
        const pass = Buffer.from(line, "base64").toString();
        return say(pass === PASSWORD && user === "bot" ? "235 ok" : `535 5.7.8 bad login ${user}/${pass}`);
      }
      const verb = line.split(" ")[0]?.toUpperCase();
      if (verb === "EHLO") {
        const lines = offers(tls);
        lines.forEach((l, i) => say(`250${i === lines.length - 1 ? " " : "-"}${l}`));
      } else if (verb === "STARTTLS") {
        say("220 go ahead");
        sock.removeAllListeners("data");
        const t = new TLSSocket(sock as Socket, { isServer: true, key, cert });
        t.on("error", () => undefined);
        sock = t;
        tls = true;
        buffer = "";
        t.on("data", onData);
      } else if (verb === "AUTH") {
        const [, mech, arg] = line.split(" ");
        if (mech === "PLAIN") {
          const [, u, p] = Buffer.from(arg ?? "", "base64").toString().split("\0");
          say(p === PASSWORD && u === "bot" ? "235 ok" : `535 5.7.8 bad login ${u}/${p}`);
        } else {
          login = "user";
          say("334 VXNlcm5hbWU6");
        }
      } else if (verb === "MAIL" || verb === "RCPT") say("250 ok");
      else if (verb === "DATA") {
        data = [];
        say("354 go");
      } else if (verb === "QUIT") {
        say("221 bye");
        sock.end();
      } else say("502 no");
    };
    const onData = (d: Buffer): void => {
      buffer += d.toString();
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        onLine(line);
      }
    };
    sock.on("data", onData);
    sock.on("error", () => undefined);
    say("220 fake ESMTP");
  };
  const server = o.implicit ? createTlsServer({ key, cert }, (s) => talk(s, true)) : createServer((s) => talk(s, false));
  servers.push(server);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    fake.port = (server.address() as { port: number }).port;
    done(fake);
  }));
}

function mail(fake: Fake, more: Partial<SmtpMail> = {}): SmtpMail {
  return { host: "localhost", port: fake.port, security: "starttls", user: "bot", secret: PASSWORD, from: "Factory <factory@example.com>",
    caFile, ...more };
}

async function refusal(p: Promise<void>): Promise<CoreError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CoreError) return e;
    throw e;
  }
  throw new Error("it was sent");
}

/** The body of a message the fake got, decoded. */
function bodyOf(message: string): string {
  const [, body = ""] = message.split("\r\n\r\n");
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString();
}

test("STARTTLS: the password goes only after TLS, by AUTH PLAIN, and the message arrives whole", async () => {
  const fake = await fakeSmtp();
  await new SmtpNotifier(mail(fake)).send("owner@example.com", "Factory sign-in code: 123456", "Your code is 123456.\n.\nBye.");
  const verbs = fake.log.map((l) => `${l.line.split(" ").slice(0, 2).join(" ")}${l.tls ? " (tls)" : ""}`);
  expect(verbs.slice(0, 4)).toEqual([expect.stringMatching(/^EHLO /), "STARTTLS", expect.stringMatching(/^EHLO .* \(tls\)$/), "AUTH PLAIN (tls)"]);
  expect(fake.log.filter((l) => !l.tls).map((l) => l.line.split(" ")[0])).toEqual(["EHLO", "STARTTLS"]);
  expect(fake.log.map((l) => l.line)).toContain("MAIL FROM:<factory@example.com>");
  expect(fake.log.map((l) => l.line)).toContain("RCPT TO:<owner@example.com>");
  expect(fake.messages.length).toBe(1);
  const m = fake.messages[0] as string;
  expect(m).toContain("Subject: Factory sign-in code: 123456");
  expect(m).toContain("To: owner@example.com");
  expect(m).toContain("From: Factory <factory@example.com>");
  expect(bodyOf(m)).toBe("Your code is 123456.\r\n.\r\nBye.");
});

test("implicit TLS with AUTH LOGIN when that is all the server offers", async () => {
  const fake = await fakeSmtp({ implicit: true, auth: ["LOGIN"] });
  await new SmtpNotifier(mail(fake, { security: "tls" })).send("owner@example.com", "Hi", "Text");
  expect(fake.log.every((l) => l.tls)).toBe(true);
  expect(fake.log.map((l) => l.line)).toContain("AUTH LOGIN");
  expect(fake.messages.length).toBe(1);
});

test("a server that doesn't offer STARTTLS gets no password and no message", async () => {
  const fake = await fakeSmtp({ starttls: false });
  const e = await refusal(new SmtpNotifier(mail(fake)).send("owner@example.com", "Hi", "Text"));
  expect(e.code).toBe("mail_smtp_no_starttls");
  expect(fake.log.some((l) => l.line.startsWith("AUTH"))).toBe(false);
  expect(fake.messages.length).toBe(0);
});

test("a wrong password is refused, and the error never holds the password, even when the server echoes it", async () => {
  const fake = await fakeSmtp();
  for (const auth of ["plain", "login"] as const) {
    const wrong = `${PASSWORD}-wrong`;
    const e = await refusal(new SmtpNotifier(mail(fake, { secret: wrong, auth })).send("owner@example.com", "Hi", "Text"));
    expect(e.code).toBe("mail_smtp_refused");
    expect(e.message).toContain("535");
    expect(JSON.stringify(e.toJSON())).not.toContain(wrong);
    expect(JSON.stringify(e.toJSON())).not.toContain(Buffer.from(wrong).toString("base64"));
  }
  expect(fake.messages.length).toBe(0);
});

test("a certificate the machine doesn't trust stops it before anything is sent", async () => {
  const fake = await fakeSmtp({ implicit: true });
  const e = await refusal(new SmtpNotifier(mail(fake, { security: "tls", caFile: "" })).send("owner@example.com", "Hi", "Text"));
  expect(["mail_smtp_unreachable", "mail_smtp_failed"]).toContain(e.code);
  expect(fake.log.length).toBe(0);
});

test("a subject or address with a line break is refused, so no header can be added", async () => {
  const fake = await fakeSmtp();
  expect((await refusal(new SmtpNotifier(mail(fake)).send("owner@example.com", "Hi\r\nBcc: x@example.com", "Text"))).code).toBe("mail_subject_bad");
  expect((await refusal(new SmtpNotifier(mail(fake)).send("owner@example.com>\r\nRCPT TO:<x@example.com", "Hi", "Text"))).code).toBe("mail_address_bad");
  expect(fake.log.length).toBe(0);
});

/** A command run without blocking this process (the fake server answers from it). */
async function run(cmd: string[], cwd: string, env: Record<string, string | undefined>, input = ""): Promise<{ code: number; out: string; stdout: string; stderr: string }> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const p = Bun.spawn(cmd, { cwd, env: clean, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: stdout + stderr, stdout, stderr };
}

test("factory ui mail set smtp, then mail test, sends through the server; the password is never printed", async () => {
  const fake = await fakeSmtp();
  const p = project();
  roots.push(p.root);
  const ui = [...BUN, join(HOOKS, "factory_ui.ts")];
  const set = await run([...ui, "mail", "set", "smtp", "--host", "localhost", "--port", String(fake.port), "--user", "bot", "--ca-file", caFile,
    "--from", "Factory <factory@example.com>"], p.d, p.env, PASSWORD + "\n");
  expect(set.code, set.out).toBe(0);
  expect(set.out).not.toContain(PASSWORD);
  const show = await run([...ui, "mail", "show"], p.d, p.env);
  expect(show.stdout).toContain("password  set (not shown)");
  expect(show.out).not.toContain(PASSWORD);
  const sent = await run([...ui, "mail", "test", "owner@example.com"], p.d, p.env);
  expect(sent.code, sent.out).toBe(0);
  expect(sent.stdout).toContain(`Sent a test mail to owner@example.com through SMTP localhost:${fake.port}`);
  expect(sent.out).not.toContain(PASSWORD);
  expect(fake.messages.length).toBe(1);
  expect(fake.messages[0]).toContain("Subject: Factory: test mail");
  expect(existsSync(join(p.root, "config", "software-factory", "ui", "mail.json"))).toBe(true);
});
