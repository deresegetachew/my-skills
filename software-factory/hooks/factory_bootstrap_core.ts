// The parts `factory bootstrap` is built from (#105): a step is data (what to check, what to do), so the same list can
// be shown as a plan, written as a shell script for the owner to review, or run. Nothing here runs by itself.
//
//   Run(argv)            a command (as another user with `asUser`)
//   Write(path, text)    a file with a mode and an owner; `text` may be a function of the Context
//   Mkdir(path)          a folder with a mode and an owner
//   Call(fn, label)      code for the few things a command line cannot do (a checksum-verified download)
//
// A Step has a `done()` check, so a second run changes nothing, and `privileged`: such a step runs only through
// `--apply` and as root. Errors are `{code, message, fix}`.
import { chmodSync, chownSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FactoryError, pyDumps, shQuote } from "./factory_lib.ts";

export class BootstrapError extends FactoryError {
  /** The error as Python's json.dumps wrote it: {"code": ..., "message": ..., "fix": ...}. */
  asJson(): string {
    return pyDumps({ code: this.code, message: this.message, fix: this.fix });
  }
}

export class Run {
  readonly argv: string[];
  readonly asUser: string | null;
  readonly env: Record<string, string>;
  readonly stdin: string | null;
  readonly ok: number[];
  constructor(argv: readonly string[], o: { asUser?: string | null; env?: Record<string, string>; stdin?: string | null; ok?: number[] } = {}) {
    this.argv = [...argv];
    this.asUser = o.asUser ?? null;
    this.env = { ...(o.env ?? {}) };
    this.stdin = o.stdin ?? null;
    this.ok = [...(o.ok ?? [0])];
  }
}

export type Text = string | ((ctx: Context) => string);

export class Write {
  constructor(readonly path: string, readonly text: Text, readonly mode: number = 0o644, readonly owner: string | null = null) {}
}

export class Mkdir {
  constructor(readonly path: string, readonly mode: number = 0o755, readonly owner: string | null = null) {}
}

export class Call {
  constructor(readonly fn: () => void | Promise<void>, readonly label: string) {}
}

export type Action = Run | Write | Mkdir | Call;

/** What a step records in the manifest (files, units, the user it made). */
export type StepRecord = { [key: string]: unknown };

export class Step {
  readonly id: string;
  readonly title: string;
  readonly actions: Action[];
  readonly done: () => boolean;
  readonly privileged: boolean;
  readonly record: StepRecord;
  readonly manual: string;
  /** The actions are idempotent commands whose result can't be checked (the project's own install command). */
  readonly trust: boolean;
  constructor(id: string, title: string, actions: Action[], o: { done?: () => boolean; privileged?: boolean; record?: StepRecord;
    manual?: string; trust?: boolean } = {}) {
    this.id = id;
    this.title = title;
    this.actions = actions;
    this.done = o.done ?? (() => false);
    this.privileged = o.privileged ?? false;
    this.record = o.record ?? {};
    this.manual = o.manual ?? "";
    this.trust = o.trust ?? false;
  }
}

/** A line of /etc/passwd (Python's pwd.getpwnam), or null when the user is not there. */
export interface Passwd {
  name: string;
  uid: number;
  gid: number;
  dir: string;
}

export function getpwnam(name: string): Passwd | null {
  if (!name) return null;
  let text = "";
  try {
    text = readFileSync("/etc/passwd", "utf8");
  } catch {
    // no passwd file: ask getent below
  }
  const parse = (body: string): Passwd | null => {
    for (const line of body.split("\n")) {
      const f = line.split(":");
      if (f.length >= 7 && f[0] === name && /^\d+$/.test(f[2] as string) && /^\d+$/.test(f[3] as string)) {
        return { name, uid: Number(f[2]), gid: Number(f[3]), dir: f[5] as string };
      }
    }
    return null;
  };
  const found = parse(text);
  if (found) return found;
  // Users from NSS (LDAP, systemd-homed) are not in /etc/passwd; getpwnam would find them, so ask getent.
  if (!Bun.which("getent")) return null;
  const [rc, out] = probe(["getent", "passwd", name]);
  return rc === 0 ? parse(out) : null;
}

/** Is this process root? (os.geteuid() == 0; true where there is no geteuid, as the Python did.) */
export function isRootUser(): boolean {
  return typeof process.geteuid !== "function" || process.geteuid() === 0;
}

/** What the actions may ask for: the dedicated user, its uid (a shell variable while only planning). */
export class Context {
  constructor(readonly user: string, readonly applying: boolean) {}

  uid(): number | string {
    if (!this.applying) return "$UID_F";
    const pw = getpwnam(this.user);
    if (pw) return pw.uid;
    const [rc, out] = probe(["id", "-u", this.user]);
    if (rc === 0 && /^\d+$/.test(out.trim())) return Number(out.trim());
    throw new BootstrapError("no-user", `The user ${this.user} does not exist yet.`,
      "Run the user step first (`factory bootstrap machine --apply`).");
  }
}

export function textOf(action: Write, ctx: Context): string {
  const t = action.text;
  return typeof t === "function" ? t(ctx) : t;
}

/** One action as shell text (for the plan and for --script). */
export function shellOf(action: Action, ctx: Context): string {
  if (action instanceof Run) {
    const argv = action.argv.map(shQuote).join(" ");
    const envs = Object.entries(action.env).map(([k, v]) => `${k}=${shQuote(v)}`).join(" ");
    let line = (envs ? `${envs} ` : "") + argv;
    if (action.asUser) line = `runuser -u ${shQuote(action.asUser)} -- ` + (envs ? `env ${envs} ` : "") + argv;
    return line + (action.stdin ? " <<'EOF'\n" + action.stdin + "EOF" : "");
  }
  if (action instanceof Write) {
    const text = textOf(action, ctx);
    const own = action.owner ? ` -o ${shQuote(action.owner)} -g ${shQuote(action.owner)}` : "";
    const marker = "FACTORY_EOF";
    // The heredoc is unquoted only where the text holds the uid variable.
    const quote = text.includes("$UID_F") ? "" : "'";
    return `install -d -m 755 ${shQuote(dirname(action.path))}\n` +
      `install -m ${action.mode.toString(8)}${own} /dev/stdin ${shQuote(action.path)} <<${quote}${marker}${quote}\n` +
      `${text.replace(/\n+$/, "")}\n${marker}`;
  }
  if (action instanceof Mkdir) {
    const own = action.owner ? ` -o ${shQuote(action.owner)} -g ${shQuote(action.owner)}` : "";
    return `install -d -m ${action.mode.toString(8)}${own} ${shQuote(action.path)}`;
  }
  return `# ${action.label} (done by factory bootstrap itself; see the plan for what it does)`;
}

function chownTo(path: string, owner: string | null): void {
  if (!owner || typeof process.geteuid !== "function" || process.geteuid() !== 0) return;
  const pw = getpwnam(owner);
  if (pw) chownSync(path, pw.uid, pw.gid);
}

/** Runs actions. `echo` prints one line per action as it goes; secrets never pass through here (no env value is
 * printed, and `Run.env` holds only non-secret settings). */
export class Executor {
  constructor(readonly ctx: Context, readonly echo: (line: string) => void = (l) => console.log(l)) {}

  runArgv(argv: readonly string[], env: Record<string, string> | null = null, stdin: string | null = null,
    asUser: string | null = null): [number, string, string] {
    let full = [...argv];
    let extra = env;
    if (asUser && isRootUser()) {
      full = ["runuser", "-u", asUser, "--", ...(env && Object.keys(env).length ? ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)] : []), ...full];
      extra = null;
    }
    try {
      const p = Bun.spawnSync(full, {
        env: { ...(process.env as Record<string, string>), ...(extra ?? {}) },
        stdin: stdin !== null ? new TextEncoder().encode(stdin) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return [p.exitCode ?? 1, p.stdout.toString(), p.stderr.toString()];
    } catch (e) {
      return [127, "", e instanceof Error ? e.message : String(e)];
    }
  }

  async do(action: Action): Promise<void> {
    if (action instanceof Run) {
      const [rc, out, err] = this.runArgv(action.argv, action.env, action.stdin, action.asUser);
      if (!action.ok.includes(rc)) {
        const text = (err || out).trim();
        const lines = text ? text.split(/\r\n|\r|\n/) : [];
        const tail = lines.length ? (lines[lines.length - 1] as string) : "no output";
        throw new BootstrapError("command-failed", `\`${action.argv.slice(0, 3).join(" ")}\` failed (exit ${rc}): ${tail.slice(0, 160)}`,
          "Read the message, fix the cause and run the same command again: finished steps are skipped.");
      }
    } else if (action instanceof Write) {
      mkdirSync(dirname(action.path), { recursive: true });
      const tmp = action.path + ".tmp";
      writeFileSync(tmp, textOf(action, this.ctx));
      chmodSync(tmp, action.mode);
      chownTo(tmp, action.owner);
      renameSync(tmp, action.path);
    } else if (action instanceof Mkdir) {
      mkdirSync(action.path, { recursive: true });
      chmodSync(action.path, action.mode);
      chownTo(action.path, action.owner);
    } else {
      await action.fn();
    }
  }
}

/** [returncode, stdout, stderr] of a read-only command; [127, "", reason] when it cannot start or runs too long. */
export function probe(argv: readonly string[], env: Record<string, string> | null = null, timeout = 20): [number, string, string] {
  try {
    const p = Bun.spawnSync([...argv], {
      env: { ...(process.env as Record<string, string>), ...(env ?? {}) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeout * 1000,
    });
    if (p.exitedDueToTimeout) return [127, "", `Command '${JSON.stringify(argv)}' timed out after ${timeout} seconds`];
    return [p.exitCode ?? 1, p.stdout.toString(), p.stderr.toString()];
  } catch (e) {
    return [127, "", e instanceof Error ? e.message : String(e)];
  }
}

export function refuse(err: BootstrapError, code = 1): number {
  process.stderr.write(err.asJson() + "\n");
  return code;
}
