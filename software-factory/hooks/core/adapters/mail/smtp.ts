// The Notifications port's SMTP adapter (#542): plain SMTP over node:tls, no npm package. `tls` is implicit TLS (port
// 465); `starttls` connects in the clear and must be offered STARTTLS before anything else is sent (port 587), so the
// password never goes over an unencrypted connection. AUTH PLAIN or LOGIN, as the server offers (PLAIN first), or as
// `auth` says. The body is sent base64, so no line of it can end the message early.
//
// The certificate is checked against the system's CAs, or `caFile` (a PEM file) for a relay with its own. The password
// never shows in an error: the server's answer is cut short and the password taken out of it.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { CoreError } from "../../domain/error.ts";
import type { Notifier } from "../../ports/notifications.ts";
import { scrub } from "./http.ts";

export interface SmtpMail {
  host: string;
  port: number;
  security: "starttls" | "tls";
  user: string;
  secret: string;
  from: string;
  /** PLAIN or LOGIN; empty: what the server offers, PLAIN first. */
  auth?: "plain" | "login" | "";
  /** A PEM file of the CA that signed the server's certificate, when it isn't a public one. */
  caFile?: string;
}

const FIX = "Check the SMTP settings with `factory ui mail show`, set them again with `factory ui mail set smtp`, then `factory ui mail test <address>`.";

interface Reply {
  code: number;
  lines: string[];
}

/** The address in `Name <a@b>` (or the whole text). */
export function addressOf(text: string): string {
  const m = /<([^<>]*)>\s*$/.exec(text);
  return (m ? m[1] as string : text).trim();
}

/** Null when the settings can be used, else what is wrong (said without the password). */
export function problemOf(m: Omit<SmtpMail, "secret">): string | null {
  if (!/^[A-Za-z0-9.-]+$/.test(m.host)) return "the host isn't a host name";
  if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return "the port isn't a number from 1 to 65535";
  if (m.security !== "starttls" && m.security !== "tls") return "security must be starttls or tls";
  if (m.auth && m.auth !== "plain" && m.auth !== "login") return "auth must be plain or login";
  if (/[\r\n]/.test(m.user)) return "the user has a line break";
  const from = addressOf(m.from);
  if (!from || /[\r\n<>\s]/.test(from) || !from.includes("@") || /[\r\n]/.test(m.from)) return "the from address isn't an email address";
  return null;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** The message as sent after DATA, with its end line. */
export function message(from: string, to: string, subject: string, text: string, now = new Date()): string {
  // an ASCII-only subject stays readable; any other is encoded (RFC 2047)
  const subj = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${b64(subject)}?=`;
  const host = addressOf(from).split("@")[1] ?? "localhost";
  const body = (b64(text.replace(/\r?\n/g, "\r\n")).match(/.{1,76}/g) ?? []).join("\r\n");
  return [`From: ${from}`, `To: ${to}`, `Subject: ${subj}`, `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${host}>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64", "", body, "."].join("\r\n") + "\r\n";
}

/** One SMTP conversation: lines in, replies out. */
class Conversation {
  private socket: Socket | TLSSocket;
  private buffer = "";
  private lines: string[] = [];
  private waiting: { done: (r: Reply) => void; failed: (e: Error) => void } | null = null;
  private gone: Error | null = null;
  private readonly onData = (d: Buffer): void => {
    this.buffer += d.toString("utf8");
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      this.lines.push(this.buffer.slice(0, i).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(i + 1);
    }
    this.pump();
  };

  constructor(socket: Socket | TLSSocket, private readonly secret: string) {
    this.socket = socket;
    this.watch(socket);
  }

  private watch(s: Socket | TLSSocket): void {
    s.on("data", this.onData);
    s.on("error", (e: Error) => this.fail(e));
    s.on("close", () => this.fail(new Error("the server closed the connection")));
  }

  private fail(e: Error): void {
    if (!this.gone) this.gone = e;
    const w = this.waiting;
    this.waiting = null;
    w?.failed(this.gone);
  }

  /** A whole reply (`250-...` lines up to `250 ...`) once it is there. */
  private pump(): void {
    if (!this.waiting) return;
    const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end < 0) return;
    const got = this.lines.splice(0, end + 1);
    const w = this.waiting;
    this.waiting = null;
    w.done({ code: Number(got[end]?.slice(0, 3)), lines: got.map((l) => l.slice(4)) });
  }

  reply(): Promise<Reply> {
    return new Promise((done, failed) => {
      if (this.gone) return failed(this.gone);
      this.waiting = { done, failed };
      this.pump();
    });
  }

  /** Sends `line` and reads the reply; refuses unless its code is one of `ok`. `what` names it in an error. */
  async ask(line: string, ok: number[], what = line.split(" ")[0] ?? line): Promise<Reply> {
    this.socket.write(line + "\r\n");
    return this.expect(ok, what);
  }

  async expect(ok: number[], what: string): Promise<Reply> {
    const r = await this.reply();
    if (!ok.includes(r.code)) {
      throw new CoreError("mail_smtp_refused", `The SMTP server answered ${r.code} to ${what}: ${scrub(r.lines.join(" "), this.secret)}.`, FIX);
    }
    return r;
  }

  /** STARTTLS: the same connection, now encrypted. */
  async secure(host: string, ca: Buffer | undefined): Promise<void> {
    const plain = this.socket;
    plain.removeListener("data", this.onData);
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    const t = tlsConnect({ socket: plain as Socket, servername: host, ca });
    await new Promise<void>((done, failed) => {
      t.once("secureConnect", () => done());
      t.once("error", failed);
    });
    this.socket = t;
    this.buffer = "";
    this.lines = [];
    this.watch(t);
  }

  close(): void {
    this.socket.destroy();
  }
}

function open(m: SmtpMail, ca: Buffer | undefined): Promise<Socket | TLSSocket> {
  return new Promise((done, failed) => {
    const s = m.security === "tls" ? tlsConnect({ host: m.host, port: m.port, servername: m.host, ca })
      : netConnect({ host: m.host, port: m.port });
    s.once(m.security === "tls" ? "secureConnect" : "connect", () => done(s));
    s.once("error", failed);
  });
}

function heloName(): string {
  const h = hostname().replace(/[^A-Za-z0-9.-]/g, "");
  return h || "localhost";
}

export class SmtpNotifier implements Notifier {
  constructor(private readonly m: SmtpMail, private readonly timeoutMs = 30_000) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    const bad = problemOf(this.m);
    if (bad) throw new CoreError("mail_settings_bad", `The SMTP settings can't be used: ${bad}.`, FIX);
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(to)) throw new CoreError("mail_address_bad", `${JSON.stringify(to)} isn't an email address.`, "Give one address, like me@example.com.");
    if (/[\r\n]/.test(subject)) throw new CoreError("mail_subject_bad", "A subject can't have a line break.", "Use one line.");
    let ca: Buffer | undefined;
    try {
      ca = this.m.caFile ? readFileSync(this.m.caFile) : undefined;
    } catch {
      throw new CoreError("mail_ca_missing", `The SMTP CA file ${this.m.caFile} can't be read.`, FIX);
    }
    let conv: Conversation | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, failed) => {
      timer = setTimeout(() => {
        conv?.close();
        failed(new CoreError("mail_smtp_timeout", `The SMTP server ${this.m.host}:${this.m.port} didn't finish in ${Math.round(this.timeoutMs / 1000)} s.`, FIX));
      }, this.timeoutMs);
    });
    const talk = async (): Promise<void> => {
      let socket: Socket | TLSSocket;
      try {
        socket = await open(this.m, ca);
      } catch (e) {
        throw new CoreError("mail_smtp_unreachable", `The SMTP server ${this.m.host}:${this.m.port} can't be reached ` +
          `(${scrub(e instanceof Error ? e.message : String(e), this.m.secret)}).`, FIX);
      }
      conv = new Conversation(socket, this.m.secret);
      const c = conv;
      try {
        await c.expect([220], "the greeting");
        let ehlo = await c.ask(`EHLO ${heloName()}`, [250]);
        if (this.m.security === "starttls") {
          if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
            throw new CoreError("mail_smtp_no_starttls", `The SMTP server ${this.m.host}:${this.m.port} doesn't offer STARTTLS, so nothing was sent.`,
              "Use its TLS port with `--security tls` (often 465), or a server that offers STARTTLS.");
          }
          await c.ask("STARTTLS", [220]);
          await c.secure(this.m.host, ca);
          ehlo = await c.ask(`EHLO ${heloName()}`, [250]);
        }
        if (this.m.user) {
          const offered = (ehlo.lines.find((l) => /^AUTH[ =]/i.test(l)) ?? "").toUpperCase().split(/[ =]/);
          const how = this.m.auth || (offered.includes("PLAIN") || !offered.includes("LOGIN") ? "plain" : "login");
          if (how === "plain") await c.ask(`AUTH PLAIN ${b64(`\0${this.m.user}\0${this.m.secret}`)}`, [235], "AUTH PLAIN");
          else {
            await c.ask("AUTH LOGIN", [334], "AUTH LOGIN");
            await c.ask(b64(this.m.user), [334], "AUTH LOGIN (the user)");
            await c.ask(b64(this.m.secret), [235], "AUTH LOGIN (the password)");
          }
        }
        await c.ask(`MAIL FROM:<${addressOf(this.m.from)}>`, [250], "MAIL FROM");
        await c.ask(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
        await c.ask("DATA", [354]);
        await c.ask(message(this.m.from, to, subject, text).replace(/\r\n$/, ""), [250], "the message");
        await c.ask("QUIT", [221]).catch(() => undefined);
      } catch (e) {
        if (e instanceof CoreError) throw e;
        throw new CoreError("mail_smtp_failed", `The SMTP conversation with ${this.m.host}:${this.m.port} broke off ` +
          `(${scrub(e instanceof Error ? e.message : String(e), this.m.secret)}).`, FIX);
      }
    };
    try {
      await Promise.race([talk(), timeout]);
    } finally {
      clearTimeout(timer);
      (conv as Conversation | null)?.close();
    }
  }
}
