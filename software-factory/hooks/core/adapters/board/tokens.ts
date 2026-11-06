// The board's claim tokens on this machine (#500). A claim on the board gives a token, and every later write by the
// holder (release, in review, done, block, heartbeat) must name it, so a builder whose task went to someone else can't
// close it. The port's later calls don't say who is calling, so the token is kept here by the board's task id, with the
// agent and machine that claimed it: a small JSON file in the project's state folder, mode 600 (a token is a right to
// write), changed under a lock so two loops on this machine don't lose each other's.
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { flock } from "../../../factory_lib.ts";
import { CoreError } from "../../domain/error.ts";

export interface Held {
  agent: string;
  machine: string;
  token: string;
  at: string;
}

type Kept = Record<string, Held>;

export class ClaimTokens {
  constructor(readonly file: string) {}

  get(boardId: number): Held | null {
    return this.read()[String(boardId)] ?? null;
  }

  put(boardId: number, held: Omit<Held, "at">): void {
    this.change((k) => {
      k[String(boardId)] = { ...held, at: new Date().toISOString() };
    });
  }

  drop(boardId: number): void {
    this.change((k) => {
      delete k[String(boardId)];
    });
  }

  /** What is kept: {} when the file isn't there yet. A file that can't be read as tokens is refused, never written
   * over, so no claim's token is lost without a word. */
  private read(): Kept {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return {};
      throw this.corrupt(e instanceof Error ? e.message : String(e));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw this.corrupt("it isn't JSON");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      !Object.values(raw).every((h) => h && typeof h === "object" && typeof (h as Held).token === "string" && typeof (h as Held).agent === "string")) {
      throw this.corrupt("it isn't a set of claim tokens");
    }
    return raw as Kept;
  }

  private corrupt(why: string): CoreError {
    return new CoreError("board-claims-corrupt", `The board's claim tokens on this machine can't be read (${this.file}): ${why}. Nothing was changed.`,
      `Move it aside (\`mv ${this.file} ${this.file}.bad\`), then run the command again: an agent that holds a task on the board ` +
      "takes its claim back with a new token on its next pick.");
  }

  private change(f: (k: Kept) => void): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const fd = openSync(`${this.file}.lock`, "w", 0o600);
    try {
      flock(fd);
      const kept = this.read();
      f(kept);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(kept, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } finally {
      closeSync(fd);
    }
  }
}
