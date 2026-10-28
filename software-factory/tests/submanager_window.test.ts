// Sub-managers get a screen (#307): each one-item session of the dev manager runs in its own tmux window, started through
// the shared step of #300, and `factory cockpit watch <item>` shows it read-only. tmux is a fake first on PATH whose
// new-session really runs the command in the background (a real tmux never runs); claude and gh are fakes.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeExe } from "./support.ts";
import { type Env, factory } from "./roles_support.ts";
import { cycle, iso, pr, runSub, UNREVIEWED, world } from "./orchestrator_support.ts";

const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/tmux.log"
d="$FAKE_TMUX"; mkdir -p "$d"
alive() {
  [ -f "$d/$1" ] || return 1
  p="$(cat "$d/$1")"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null || return 1
  ! grep -q '^State:.*Z' "/proc/$p/status" 2>/dev/null
}
case "$1" in
  -V) echo "tmux 3.4" ;;
  has-session) alive "\${3#=}" ;;
  kill-session) n="\${3#=}"; [ -f "$d/$n" ] && kill "$(cat "$d/$n")" 2>/dev/null; true ;;
  new-session)
    shift; name=""; dir="."
    while [ $# -gt 0 ]; do
      case "$1" in -s) name="$2"; shift 2 ;; -c) dir="$2"; shift 2 ;; -n) shift 2 ;; -d) shift ;; *) break ;; esac
    done
    cmd="$1"
    ( cd "$dir" && exec setsid bash -c 'echo $$ >"$0"; exec bash -c "$1"' "$d/$name" "$cmd" >/dev/null 2>&1 </dev/null ) &
    for _ in $(seq 1 100); do [ -s "$d/$name" ] && break; sleep 0.05; done ;;
  *) ;;
esac
`;

/** A manager project with the fake tmux first on PATH. `window`: the dev manager itself runs in a window (FACTORY_WINDOW). */
function setup(o: { window?: boolean; cfg?: Record<string, unknown>; db?: Record<string, unknown> } = {}): [string, string, Env] {
  const [d, work, env] = world({ db: o.db ?? UNREVIEWED, cfg: o.cfg });
  writeExe(join(d, "bin", "tmux"), FAKE_TMUX);
  const log = join(d, "tmuxlog");
  mkdirSync(log, { recursive: true });
  delete env.TMUX;
  delete env.FACTORY_WINDOW;
  if (o.window) env.FACTORY_WINDOW = "dev-manager-lead";
  Object.assign(env, { FAKE_LOG: log, FAKE_TMUX: join(d, "tmux-sessions"), GH_TOKEN: "ghp_secret_value_123" });
  return [d, work, env];
}

const tmuxLog = (env: Env): string[] => {
  const f = join(env.FAKE_LOG as string, "tmux.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};
const starts = (env: Env) => tmuxLog(env).filter((l) => l.startsWith("new-session"));
const hookFile = (d: string, env: Env, body: string): void => {
  const h = join(d, "hook.sh");
  writeFileSync(h, body);
  env.FAKE_CLAUDE_HOOK = h;
};
const subDir = (work: string) => join(work, ".git", "factory-manager", "lead.d");
const lastJson = (text: string): Record<string, string> => JSON.parse(text.trim().split("\n").filter(Boolean).pop() as string);

test("without a window of its own the sub-manager runs as before and tmux is never asked to start anything", () => {
  const [d, work, env] = setup({ window: false });
  hookFile(d, env, "exit 0\n");
  const p = runSub(work, env);
  expect(p.code, p.out).toBe(0);
  expect(starts(env)).toEqual([]);
  const calls = readFileSync(env.LOOP_LOG as string, "utf8");
  expect(calls).toContain("/manage-pass pr-5");
  expect(calls).not.toContain("stream-json");
  expect(existsSync(join(subDir(work), "pr-5.out"))).toBe(true);
});

test("inside a window the sub-manager starts its own tmux window with the job runner, no prompt and no secret on the line", () => {
  const [d, work, env] = setup({ window: true });
  hookFile(d, env, "exit 0\n");
  const p = runSub(work, env);
  expect(p.code, p.out).toBe(0);
  const all = starts(env);
  expect(all.length, tmuxLog(env).join("\n")).toBe(1);
  const m = /^new-session -d -s (\S+) -c (\S+) -n (\S+) (.+)$/.exec(all[0] as string);
  expect(m, all[0]).not.toBeNull();
  expect(m?.[1]).toBe("work-lead-pr-5");
  expect(m?.[2]).toBe(work);
  expect(m?.[3]).toBe("dev-manager-lead-pr-5");
  expect(m?.[4]).toContain("factory_window.ts");
  expect(m?.[4]).toContain("job");
  const text = tmuxLog(env).join("\n");
  expect(text).not.toContain("/manage-pass");
  expect(text).not.toContain("ghp_secret_value_123");
});

test("the claude in the window gets the same prompt, the profile flags and its own FACTORY variables", () => {
  const [d, work, env] = setup({ window: true });
  hookFile(d, env, "env | grep '^FACTORY_' | sort >\"$FAKE_LOG/claude-env\"\nexit 0\n");
  const p = runSub(work, env);
  expect(p.code, p.out).toBe(0);
  const calls = readFileSync(env.LOOP_LOG as string, "utf8").split("\n").filter((l) => l.startsWith("claude "));
  expect(calls.length).toBe(1);
  expect(calls[0]).toContain("/manage-pass pr-5");
  expect(calls[0]).toContain(" -p ");
  expect(calls[0]).toContain("--settings");
  expect(calls[0]).toContain("--output-format stream-json --verbose");
  const seen = readFileSync(join(env.FAKE_LOG as string, "claude-env"), "utf8").split("\n");
  for (const v of ["FACTORY_AGENT=lead", "FACTORY_ROLE=dev-manager", "FACTORY_ITEM=pr-5", "FACTORY_WINDOW=dev-manager-lead-pr-5"]) {
    expect(seen).toContain(v);
  }
});

test("the stream becomes readable lines in the out file: text, the tool used and the result, no raw JSON", () => {
  const [d, work, env] = setup({ window: true });
  const a = { type: "assistant", message: { content: [{ type: "text", text: "Looking at PR 12" },
    { type: "tool_use", name: "Bash", input: { command: "gh pr view 12" } }] } };
  const r = { type: "result", result: "Reviewed: pass" };
  writeFileSync(join(d, "stream.txt"), `${JSON.stringify(a)}\nnot json at all\n${JSON.stringify(r)}\n`);
  hookFile(d, env, `cat "${join(d, "stream.txt")}"\nexit 0\n`);
  const p = runSub(work, env);
  expect(p.code, p.out).toBe(0);
  const out = readFileSync(join(subDir(work), "pr-5.out"), "utf8");
  expect(out).toContain("Looking at PR 12");
  expect(out).toContain("Bash");
  expect(out).toContain("Reviewed: pass");
  expect(out).toContain("not json at all");
  expect(out).not.toContain('{"type"');
});

test("the session is reachable by name while the sub-manager runs", () => {
  const [d, work, env] = setup({ window: true });
  hookFile(d, env, 'tmux has-session -t =work-lead-pr-5; echo "rc=$?" >"$FAKE_LOG/during"\nexit 0\n');
  const p = runSub(work, env);
  expect(p.code, p.out).toBe(0);
  expect(readFileSync(join(env.FAKE_LOG as string, "during"), "utf8").trim()).toBe("rc=0");
});

test("a failing claude in a window counts as a failed run: pid file removed, lease released", () => {
  const [d, work, env] = setup({ window: true });
  hookFile(d, env, "exit 1\n");
  const p = runSub(work, env);
  expect(p.code, p.out).toBe(1);
  expect(p.stdout).toContain("exit 1");
  expect(readdirSync(subDir(work)).filter((f) => f.endsWith(".pid"))).toEqual([]);
  const db = JSON.parse(readFileSync(join(d, "db.json"), "utf8")) as { comments: Record<string, { body: string }[]> };
  expect((db.comments["5"] ?? []).some((c) => c.body.includes("-claim manager=lead"))).toBe(true);
});

test("several sub-managers at once each get their own session, named after the item", () => {
  const db = { pulls: [pr(1, { sha: "1".repeat(40) }), pr(2, { sha: "2".repeat(40) })],
    commits: { ["1".repeat(40)]: iso(60), ["2".repeat(40)]: iso(50) } };
  const [d, work, env] = setup({ window: true, db, cfg: { manager: { maxSubManagers: 2 } } });
  hookFile(d, env, "sleep 1\nexit 0\n");
  const p = cycle(work, env, "--wait");
  expect(p.code, p.out).toBe(0);
  const sessions = starts(env).map((l) => /^new-session -d -s (\S+) /.exec(l)?.[1]).sort();
  expect(sessions).toEqual(["work-lead-pr-1", "work-lead-pr-2"]);
  expect(starts(env).some((l) => l.includes("-n dev-manager-lead-pr-1 "))).toBe(true);
  expect(starts(env).some((l) => l.includes("-n dev-manager-lead-pr-2 "))).toBe(true);
});

test("a window still open from an earlier run is left alone: no skip comment, no owner ask, its out file kept", () => {
  const [d, work, env] = setup({ window: true });
  hookFile(d, env, "exit 0\n");
  mkdirSync(subDir(work), { recursive: true });
  writeFileSync(join(subDir(work), "pr-5.out"), "still working\n");
  mkdirSync(env.FAKE_TMUX as string, { recursive: true });
  writeFileSync(join(env.FAKE_TMUX as string, "work-lead-pr-5"), String(process.pid));
  const p = runSub(work, env);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("still open");
  expect(starts(env)).toEqual([]);
  expect(readFileSync(join(subDir(work), "pr-5.out"), "utf8")).toBe("still working\n");
  const db = readFileSync(join(d, "db.json"), "utf8");
  expect(db).not.toContain("factory-manager-skip");
  expect(db).not.toContain("review-failed");
});

// --- factory cockpit watch ---------------------------------------------------------------------------------------------

/** A live sub-manager for `ref` as the orchestrator leaves it: a pid file with a live pid, and optionally its session. */
function live(work: string, env: Env, ref: string, session: boolean): void {
  mkdirSync(subDir(work), { recursive: true });
  writeFileSync(join(subDir(work), `${ref}.pid`), String(process.pid));
  writeFileSync(join(subDir(work), `${ref}.out`), "working\n");
  if (session) {
    mkdirSync(env.FAKE_TMUX as string, { recursive: true });
    writeFileSync(join(env.FAKE_TMUX as string, `work-lead-${ref}`), String(process.pid));
  }
}

test("cockpit watch attaches read-only to the live sub-manager's session and never sends keys", () => {
  const [, work, env] = setup();
  live(work, env, "pr-12", true);
  const p = factory(work, env, ["cockpit", "watch", "pr-12"]);
  expect(p.code, p.out).toBe(0);
  const calls = tmuxLog(env);
  expect(calls).toContain("attach-session -r -t =work-lead-pr-12");
  expect(calls.some((l) => l.startsWith("send-keys"))).toBe(false);
  expect(calls.some((l) => l.startsWith("switch-client") && !l.includes(" -r"))).toBe(false);
});

test("cockpit watch on a sub-manager that already ended says so and names the out file", () => {
  const [, work, env] = setup();
  mkdirSync(subDir(work), { recursive: true });
  writeFileSync(join(subDir(work), "pr-12.out"), "done\n");
  const p = factory(work, env, ["cockpit", "watch", "pr-12"]);
  expect(p.code).toBe(1);
  const e = lastJson(p.stderr);
  expect(e.code).toBe("sub-manager-ended");
  expect(e.message).toBeTruthy();
  expect(e.fix).toContain(join(subDir(work), "pr-12.out"));
  expect(tmuxLog(env).some((l) => l.startsWith("attach-session"))).toBe(false);
});

test("cockpit watch on an item with no sub-manager is a no-sub-manager error with a fix", () => {
  const [, work, env] = setup();
  const p = factory(work, env, ["cockpit", "watch", "pr-99"]);
  expect(p.code).toBe(1);
  const e = lastJson(p.stderr);
  expect(e.code).toBe("no-sub-manager");
  expect(e.message).toBeTruthy();
  expect(e.fix).toBeTruthy();
  expect(tmuxLog(env).some((l) => l.startsWith("attach-session"))).toBe(false);
});

test("cockpit watch on a live sub-manager that has no window points at its out file", () => {
  const [, work, env] = setup();
  live(work, env, "pr-12", false);
  const p = factory(work, env, ["cockpit", "watch", "pr-12"]);
  expect(p.code).toBe(1);
  const e = lastJson(p.stderr);
  expect(e.code).toBe("no-window");
  expect(e.fix).toContain(join(subDir(work), "pr-12.out"));
  expect(tmuxLog(env).some((l) => l.startsWith("attach-session"))).toBe(false);
});

test("cockpit watch without an item is a usage error as {code, message, fix}", () => {
  const [, work, env] = setup();
  const p = factory(work, env, ["cockpit", "watch"]);
  expect(p.code).toBe(2);
  const e = lastJson(p.stderr);
  expect(e.code).toBeTruthy();
  expect(e.message).toBeTruthy();
  expect(e.fix).toContain("cockpit watch <item>");
});

test("factory help lists cockpit watch", () => {
  const [, work, env] = setup();
  const p = factory(work, env, ["help"]);
  expect(p.stdout).toContain("cockpit watch");
});
