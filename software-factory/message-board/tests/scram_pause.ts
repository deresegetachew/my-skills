// A Postgres login that starts its SCRAM handshake now and finishes it later (#514's security review). Postgres reads
// the role's password when the handshake starts, and a login still in its handshake isn't in pg_stat_activity, so a
// copy of a join code could start one before the redeem commits and finish it afterwards. Not a test file.
//
// In a test: `const p = await pausedLogin(url); ...; const r = await p.finish("select 1")`.
// As a program (for a test that runs the join in another process, which blocks the test's own event loop):
//   PAUSE_URL=<url> PAUSE_GO=<file> bun scram_pause.ts
// prints "paused" once the server's first message came, waits until the file PAUSE_GO exists, finishes, and prints
// "ok" or "refused: <the server's message>".
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";

interface Msg { t: string; b: Buffer }

export interface Paused {
  /** Finish the handshake and run `query`: "ok", or "refused: <message>". */
  finish(query?: string): Promise<string>;
}

function reader(s: Socket): () => Promise<Msg> {
  let buf = Buffer.alloc(0);
  const waiters: ((m: Msg) => void)[] = [];
  const queue: Msg[] = [];
  const push = (m: Msg): void => {
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  };
  s.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) break;
      push({ t: String.fromCharCode(buf[0] as number), b: buf.subarray(5, 1 + len) });
      buf = buf.subarray(1 + len);
    }
  });
  s.on("close", () => push({ t: "closed", b: Buffer.alloc(0) }));
  return () => new Promise((r) => {
    const q = queue.shift();
    if (q) r(q);
    else waiters.push(r);
  });
}

const cstr = (x: string): Buffer => Buffer.from(x + "\0");
const errorText = (m: Msg): string => m.b.toString().split("\0").filter((f) => f.startsWith("M")).map((f) => f.slice(1)).join(" ") || "error";

/** Starts a login to `url` and stops after the server's first SCRAM message. */
export async function pausedLogin(url: string): Promise<Paused> {
  const u = new URL(url);
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const s = connect(Number(u.port || 5432), u.hostname);
  const next = reader(s);
  const send = (t: string, body: Buffer): void => {
    const h = Buffer.alloc(5);
    h.write(t, 0);
    h.writeInt32BE(body.length + 4, 1);
    s.write(Buffer.concat([h, body]));
  };
  await new Promise((r) => s.once("connect", r));
  const params = Buffer.concat([cstr("user"), cstr(user), cstr("database"), cstr(u.pathname.slice(1)), Buffer.from([0])]);
  const start = Buffer.alloc(8);
  start.writeInt32BE(params.length + 8, 0);
  start.writeInt32BE(196608, 4);
  s.write(Buffer.concat([start, params]));
  let m = await next();
  if (m.t !== "R" || m.b.readInt32BE(0) !== 10) throw new Error(`the server didn't ask for SASL (${m.t}: ${errorText(m)})`);
  const clientFirstBare = `n=*,r=${randomBytes(18).toString("base64")}`;
  const first = Buffer.from("n,," + clientFirstBare);
  const n = Buffer.alloc(4);
  n.writeInt32BE(first.length);
  send("p", Buffer.concat([cstr("SCRAM-SHA-256"), n, first]));
  m = await next();
  const serverFirst = m.b.subarray(4).toString();
  return {
    async finish(query = "select 1"): Promise<string> {
      const a = Object.fromEntries(serverFirst.split(",").map((kv) => [kv[0], kv.slice(2)])) as Record<string, string>;
      const salted = pbkdf2Sync(password, Buffer.from(a.s ?? "", "base64"), Number(a.i), 32, "sha256");
      const clientKey = createHmac("sha256", salted).update("Client Key").digest();
      const storedKey = createHash("sha256").update(clientKey).digest();
      const withoutProof = `c=biws,r=${a.r}`;
      const sig = createHmac("sha256", storedKey).update(`${clientFirstBare},${serverFirst},${withoutProof}`).digest();
      const proof = Buffer.from(clientKey.map((b, i) => b ^ (sig[i] as number)));
      send("p", Buffer.from(`${withoutProof},p=${proof.toString("base64")}`));
      try {
        for (;;) {
          const r = await next();
          if (r.t === "E") return `refused: ${errorText(r)}`;
          if (r.t === "closed") return "refused: the server closed the connection";
          if (r.t === "Z") break;
        }
        send("Q", cstr(query));
        for (;;) {
          const r = await next();
          if (r.t === "E") return `refused: ${errorText(r)}`;
          if (r.t === "closed") return "refused: the server closed the connection";
          if (r.t === "Z") return "ok";
        }
      } finally {
        s.destroy();
      }
    },
  };
}

if (import.meta.main) {
  const p = await pausedLogin(process.env.PAUSE_URL ?? "");
  console.log("paused");
  const go = process.env.PAUSE_GO ?? "";
  while (!existsSync(go)) await Bun.sleep(50);
  console.log(await p.finish());
  process.exit(0);
}
