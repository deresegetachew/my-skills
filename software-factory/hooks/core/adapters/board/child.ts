// The message board from synchronous code (#500, decision 0007 point 10). The ports are synchronous and the board's API
// is async, so each call runs the board's child (message-board/src/child.ts) with Bun.spawnSync, the way the NATS plugin
// does: one JSON request on stdin (the URL in it, never on a command line), one JSON answer on stdout. About 100 ms a
// call; no shared state. The child is run by its path; only the board's public entry is imported here, for its types.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChildAnswer, ChildCall } from "../../../../message-board/src/index.ts";
import { CoreError } from "../../domain/error.ts";

/** Where the board's child is: beside the hooks folder (my-skills, a linked project, and a release's .claude/). */
export const CHILD = join(import.meta.dir, "..", "..", "..", "..", "message-board", "src", "child.ts");

export interface ChildOptions {
  /** The board's URL; "" or unset: the child finds it as `factory board` does (MB_URL, else the machine's url file). */
  url?: string;
  /** How long one call may take (default 15 s). */
  timeoutMs?: number;
  /** The child's path (default CHILD). */
  path?: string;
}

export const UNREACHABLE_FIX = "Start it (`factory board up` on the machine that keeps it) or check its address (MB_URL, or " +
  "`factory board status`); `factory doctor` checks it. Or set `factory settings set tasks.source issues` to use GitHub.";

function unreachable(why: string): CoreError {
  return new CoreError("board-unreachable", `The message board can't be reached: ${why.replace(/\/\/[^@\s]*@/g, "//***@").slice(0, 300)}`,
    UNREACHABLE_FIX);
}

export class BoardChild {
  constructor(readonly opts: ChildOptions = {}) {}

  /** Make `calls` in order as `as`, in one child; their results, or the first refusal as a CoreError. `longerMs` is added
   * to the time limit (a wait). */
  call(as: string, calls: ChildCall[], longerMs = 0): unknown[] {
    const path = this.opts.path ?? CHILD;
    if (!existsSync(path)) {
      throw new CoreError("board-missing", `This install has no message board: ${path} is missing.`,
        "Run `factory update` to a release that ships it, or set `factory settings set tasks.source issues`.");
    }
    const timeout = (this.opts.timeoutMs ?? 15_000) + longerMs;
    const request = JSON.stringify({ url: this.opts.url ?? "", as, calls });
    let p: ReturnType<typeof Bun.spawnSync>;
    try {
      p = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", path], {
        stdin: Buffer.from(request), stdout: "pipe", stderr: "pipe", timeout, env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (e) {
      throw unreachable(e instanceof Error ? e.message : String(e));
    }
    let answer: ChildAnswer | null = null;
    try {
      answer = JSON.parse((p.stdout ?? Buffer.alloc(0)).toString().trim().split("\n").at(-1) ?? "") as ChildAnswer;
    } catch {
      answer = null;
    }
    if (!answer) {
      const err = (p.stderr ?? Buffer.alloc(0)).toString().trim().split("\n").at(-1);
      throw unreachable(p.signalCode ? `it took longer than ${Math.round(timeout / 1000)} s` : err || `the child exited ${p.exitCode}`);
    }
    if (answer.ok) return answer.results;
    if (answer.code === "no-answer") throw unreachable(answer.message);
    throw new CoreError(answer.code, answer.message, answer.fix);
  }

  /** One call's result. */
  one(as: string, op: string, ...args: unknown[]): unknown {
    return this.call(as, [{ op, args }])[0];
  }
}
