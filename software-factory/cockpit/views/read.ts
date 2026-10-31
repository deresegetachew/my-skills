// How a view reads its data and runs the owner's action (#367): the command the hook names, never a factory call of its
// own. A read has a time limit and doesn't wait for the pipes after it: a grandchild (gh) can hold them open after the
// kill, which is how `factory cockpit --prs` hung off a terminal (bug 3 in #362).
import type { Obj } from "./lines.tsx";

/** What a read gave: the JSON object, `null` when the command printed none, `"late"` past the time limit. */
export type Got = Obj | null | "late";

export async function readJson(cmd: string[], limitMs: number): Promise<Got> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((done) => {
    timer = setTimeout(() => {
      p.kill(9);
      done("late");
    }, limitMs);
  });
  const text = new Response(p.stdout as ReadableStream<Uint8Array>).text();
  const got = await Promise.race([text, late]);
  clearTimeout(timer);
  if (got === "late") return got;
  try {
    const data: unknown = JSON.parse(got);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Obj) : null;
  } catch {
    return null;
  }
}

/** Runs an action and gives its output (stdout and stderr) and exit code, as text for the view to show. TMUX is
 *  dropped: the owner's actions run on this machine's tmux, never the cockpit's own server. */
export async function runAction(cmd: string[]): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TMUX;
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return `${out}${err}`.trimEnd() + (code === 0 ? "" : `\n(exit ${code})`);
  } catch (e) {
    return `It could not run: ${e instanceof Error ? e.message : String(e)}`;
  }
}
