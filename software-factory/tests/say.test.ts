// `factory say` into a Claude session that is busy (#3 of the liveness issue): the text must not stay typed and unsent in
// the session's prompt box.
//
// tmux is a fake that plays a Claude session: what is typed goes into the prompt box (`❯ <text>`), Enter submits it, but
// while the session is busy (its screen shows "esc to interrupt", for the next N looks at it) or while it is set to drop
// Enters, an Enter does nothing and the text stays in the box. Every call is logged.
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Proc, read, runHook, sh, tmp, write, writeExe } from "./support.ts";

const FAKE_TMUX = `#!/usr/bin/env bash
d="$FAKE_TMUX_DIR"; echo "$*" >>"$d/tmux.log"
num() { cat "$d/$1" 2>/dev/null || echo 0; }
case "$1" in
  list-sessions) cat "$d/sessions" ;;
  has-session) grep -qx -- "\${3#=}" "$d/sessions" ;;
  capture-pane)
    cat "$d/history" 2>/dev/null
    b=$(num busy); if [ "$b" -gt 0 ]; then echo "✻ Thinking… (esc to interrupt)"; echo $((b - 1)) >"$d/busy"; fi
    if [ -f "$d/survey" ]; then echo "● How is Claude doing this session? (optional)"; echo "  1: Bad    2: Fine   3: Good   0: Dismiss"; fi
    printf '❯ %s\\n' "$(cat "$d/box" 2>/dev/null)" ;;
  send-keys)
    if [ -f "$d/survey" ]; then [ "$4" = "0" ] && rm -f "$d/survey"; exit 0; fi # the survey takes every key
    if [ "$4" = "-l" ]; then printf '%s' "$6" >>"$d/box"; exit 0; fi
    b=$(num busy); x=$(num drop)
    if [ "$b" -gt 0 ]; then exit 0; fi
    if [ "$x" -gt 0 ]; then echo $((x - 1)) >"$d/drop"; exit 0; fi
    printf '> %s\\n' "$(cat "$d/box" 2>/dev/null)" >>"$d/history"; : >"$d/box" ;;
esac
`;

interface World { repo: string; dir: string; env: Record<string, string | undefined> }

/** A project called app with the agent taytu, whose session app-taytu runs on this machine. */
function world(o: { busy?: number; drop?: number } = {}): World {
  const base = tmp();
  const repo = join(base, "app");
  const dir = join(base, "tmux");
  mkdirSync(dir, { recursive: true });
  sh(["git", "init", "-q", "-b", "main", repo]);
  write(join(repo, ".claude", "factory.json"), JSON.stringify({ agents: ["taytu"] }));
  writeExe(join(base, "bin", "tmux"), FAKE_TMUX);
  write(join(dir, "sessions"), "app-taytu\n");
  write(join(dir, "history"), "Claude Code\n");
  write(join(dir, "busy"), String(o.busy ?? 0));
  write(join(dir, "drop"), String(o.drop ?? 0));
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${join(base, "bin")}:${process.env.PATH ?? ""}`, FAKE_TMUX_DIR: dir, HOME: base,
    FACTORY_CONFIG_DIR: join(base, "config"), XDG_STATE_HOME: join(base, "state"), XDG_CACHE_HOME: join(base, "cache"),
    USER: "owner", CLAUDE_PROJECT_DIR: repo, FACTORY_SAY_WAIT_SECONDS: "5" };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE", "TMUX"]) delete env[k];
  return { repo, dir, env };
}

function say(w: World, text: string, env: Record<string, string> = {}): Proc {
  return runHook("factory_follow", ["say", "taytu", text], { cwd: w.repo, env: { ...w.env, ...env }, timeoutMs: 90_000 });
}

const box = (w: World): string => read(join(w.dir, "box")).trim();
const submitted = (w: World): string[] => read(join(w.dir, "history")).split("\n").filter((l) => l.startsWith("> "));
const calls = (w: World): string[] => read(join(w.dir, "tmux.log")).split("\n").filter(Boolean);

function error(p: Proc): { code: string; message: string; fix: string } {
  return JSON.parse(p.stderr.trim().split("\n").pop() as string) as { code: string; message: string; fix: string };
}

test("say to an idle session types the text and presses Enter once", () => {
  const w = world();
  const p = say(w, "/next-task b12");
  expect(p.code, p.out).toBe(0);
  expect(box(w)).toBe("");
  expect(submitted(w)).toEqual(["> /next-task b12"]);
  expect(calls(w).filter((l) => l.startsWith("send-keys"))).toEqual(["send-keys -t =app-taytu: -l -- /next-task b12",
    "send-keys -t =app-taytu: Enter"]);
});

test("say to a busy session waits until it is idle, then the text is submitted, not left in the prompt box", () => {
  const w = world({ busy: 3 });
  const p = say(w, "/next-task b12");
  expect(p.code, p.out).toBe(0);
  expect(box(w)).toBe("");
  expect(submitted(w)).toEqual(["> /next-task b12"]);
  // it looked at the screen before it typed
  const log = calls(w);
  expect(log.findIndex((l) => l.startsWith("capture-pane"))).toBeLessThan(log.findIndex((l) => l.includes(" -l -- ")));
});

test("Claude Code's feedback survey on screen is dismissed with 0 first, then the text is typed and submitted", () => {
  const w = world();
  write(join(w.dir, "survey"), "");
  const p = say(w, "Take b16 next.");
  expect(p.code, p.out).toBe(0);
  expect(box(w)).toBe("");
  expect(submitted(w)).toEqual(["> Take b16 next."]);
  const keys = calls(w).filter((l) => l.startsWith("send-keys"));
  expect(keys).toEqual(["send-keys -t =app-taytu: 0", "send-keys -t =app-taytu: -l -- Take b16 next.", "send-keys -t =app-taytu: Enter"]);
});

test("an Enter the session drops is pressed again while the text is still in the box", () => {
  const w = world({ drop: 2 });
  const p = say(w, "please look at the failing test");
  expect(p.code, p.out).toBe(0);
  expect(box(w)).toBe("");
  expect(submitted(w)).toEqual(["> please look at the failing test"]);
  expect(calls(w).filter((l) => l.endsWith(" Enter"))).toHaveLength(3);
  expect(calls(w).filter((l) => l.includes(" -l -- "))).toHaveLength(1); // typed once
});

test("a session that never takes the text: say stops after a few Enters with say-unsent and the fix, typed only once", () => {
  const w = world({ drop: 100 });
  const started = Date.now();
  const p = say(w, "hello there", { FACTORY_SAY_ENTERS: "3" });
  expect(p.code).not.toBe(0);
  const e = error(p);
  expect(e.code).toBe("say-unsent");
  expect(e.message).toContain("taytu");
  expect(e.fix).toContain("factory follow taytu");
  expect(calls(w).filter((l) => l.endsWith(" Enter"))).toHaveLength(4);
  expect(calls(w).filter((l) => l.includes(" -l -- "))).toHaveLength(1);
  expect(Date.now() - started).toBeLessThan(30_000);
  // the use is logged without the text, as for a message that went through
  const log = read(join(w.env.XDG_STATE_HOME as string, "software-factory", "say.log"));
  expect(log).toContain("agent=app-taytu");
  expect(log).not.toContain("hello there");
});

test("a session busy for longer than the wait: say is bounded and does not hang", () => {
  const w = world({ busy: 100_000 });
  const started = Date.now();
  const p = say(w, "hi", { FACTORY_SAY_WAIT_SECONDS: "1", FACTORY_SAY_ENTERS: "2" });
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(p.code).not.toBe(0);
  expect(error(p).code).toBe("say-unsent");
});

test("the same text already typed and unsent in the box (an earlier say, #591): say presses Enter, it doesn't type it twice", () => {
  const w = world();
  write(join(w.dir, "box"), "/next-task");
  const p = say(w, "/next-task");
  expect(p.code, p.out).toBe(0);
  expect(box(w)).toBe("");
  expect(submitted(w)).toEqual(["> /next-task"]);
  expect(calls(w).filter((l) => l.includes(" -l -- "))).toEqual([]);
});
