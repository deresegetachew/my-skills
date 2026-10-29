// GitHub being busy is not a failure (#347): a rate-limit or transient answer from `gh api` makes a factory command exit 4,
// the loops wait (on the fake clock FACTORY_NOW time stands still, so nothing really sleeps) and carry on, and the idle
// waits get longer when few calls are left. `factory_views_cache.ts limit-wait|limit-idle` read `gh api rate_limit` through
// one small cache.
//
// Runs the real hooks and loop script in a throwaway project with a fake `gh` that logs every call and answers a rate-limit
// error for the first calls, and a fake `claude`. The comment memo and the cached `watch --json` are in views_cache.test.ts.
import { expect, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comment, cycle, GH as ORCH_GH, hook, iso, posted, world } from "./orchestrator_support.ts";
import { type Env, factory, log, project, type Row } from "./roles_support.ts";
import { envWith, gitRepo, HOOKS, type Proc, runBun, sh, tmp, write, writeExe } from "./support.ts";

const NOW = 1_900_000_000;
const hhmm = (epoch: number): string => new Date(epoch * 1000).toISOString().slice(11, 16);
const LIMIT_MSG = "gh: API rate limit exceeded for user ID 1. (HTTP 403)";
const SECONDARY_MSG = "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)";
const TLS_MSG = 'Get "https://api.github.com/repos/o/r/issues": net/http: TLS handshake timeout';

function limitJson(remaining: number, reset: number): string {
  return JSON.stringify({ resources: { core: { limit: 5000, remaining, reset, used: 5000 - remaining } } });
}

// A gh in front of the real fake: logs every call to RL_LOG, answers `rate_limit` from the file RL_JSON (and logs it to
// RL_LOG.rl), fails the first FAIL_FIRST calls whose arguments match FAIL_MATCH with FAIL_MSG on stderr and exit 1, then
// hands over to gh-real.
const WRAPPER = String.raw`#!/usr/bin/env bash
echo "gh $*" >> "$RL_LOG"
case "$*" in *rate_limit*) echo "rate_limit" >> "$RL_LOG.rl"; cat "$RL_JSON"; exit $?;; esac
if echo "$*" | grep -Eq "$FAIL_MATCH"; then
  n=$(cat "$RL_COUNT" 2>/dev/null || echo 0)
  if [ "$n" -lt "$FAIL_FIRST" ]; then echo $((n+1)) > "$RL_COUNT"; echo "$FAIL_MSG" >&2; exit 1; fi
fi
exec "$(dirname "$0")/gh-real" "$@"
`;

interface Busy {
  message: string;
  failFirst: number;
  remaining: number;
  reset: number;
  match?: string;
}

/** Puts the wrapper in front of the gh the project already has, and sets the environment it reads. */
function busyGh(d: string, env: Env, o: Busy): void {
  const bin = join(d, "bin");
  sh(["mv", join(bin, "gh"), join(bin, "gh-real")]);
  writeExe(join(bin, "gh"), WRAPPER);
  write(join(d, "rl.json"), limitJson(o.remaining, o.reset));
  write(join(d, "rl.log"), "");
  Object.assign(env, { RL_LOG: join(d, "rl.log"), RL_JSON: join(d, "rl.json"), RL_COUNT: join(d, "rl.count"),
    FAIL_MSG: o.message, FAIL_FIRST: String(o.failFirst), FAIL_MATCH: o.match ?? ".", FACTORY_NOW: String(NOW),
    XDG_STATE_HOME: join(d, "state") });
}

function rlLog(d: string): string[] {
  return readFileSync(join(d, "rl.log"), "utf8").split("\n").filter(Boolean);
}

function rlReads(d: string): number {
  try {
    return readFileSync(join(d, "rl.log.rl"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** The dev manager's project with the stateful fake gh (as in orchestrator.test.ts). */
function orchestratorProject(): [string, string, Env] {
  const db: Row = { pulls: [], issues: [], comments: {}, events: {}, commits: {}, checks: {} };
  const [d, work, env] = project({ cfg: { tasks: { source: "issues" } }, db });
  writeExe(join(d, "bin", "gh"), ORCH_GH);
  writeFileSync(join(d, "db.json"), JSON.stringify(db));
  return [d, work, env];
}

// --- exit 4: GitHub was busy ----------------------------------------------------------------------------------------

const BUSY: [string, string][] = [
  [LIMIT_MSG, "API rate limit exceeded"],
  [SECONDARY_MSG, "secondary rate limit"],
  ["gh: Too Many Requests (HTTP 429)", "HTTP 429"],
  [TLS_MSG, "TLS handshake timeout"],
  ["read tcp 10.0.0.1:1->140.82.0.1:443: read: connection reset by peer", "connection reset by peer"],
  ["dial tcp 140.82.0.1:443: i/o timeout", "i/o timeout"],
  ["gh: Bad Gateway (HTTP 502)", "HTTP 502"],
  ["gh: Service Unavailable (HTTP 503)", "HTTP 503"],
  ["gh: Gateway Timeout (HTTP 504)", "HTTP 504"],
];

function failingGh(d: string, message: string): void {
  writeExe(join(d, "bin", "gh"), `#!/usr/bin/env bash\necho ${JSON.stringify(message)} >&2\nexit 1\n`);
}

test("every busy answer makes the orchestrator cycle exit 4 with the same error on stderr", () => {
  const [d, work, env] = orchestratorProject();
  for (const [message, key] of BUSY) {
    failingGh(d, message);
    const p = hook(work, env, "factory_orchestrator.ts", "cycle", "--name", "lead");
    expect(p.code, `${key}: ${p.out}`).toBe(4);
    expect(p.stderr, key).toContain(key);
  }
});

test("a plain failure still exits 1", () => {
  const [d, work, env] = orchestratorProject();
  failingGh(d, "boom");
  const p = hook(work, env, "factory_orchestrator.ts", "cycle", "--name", "lead");
  expect(p.code, p.out).toBe(1);
});

test("the product owner's work lookup and the builder's next task exit 4 on a rate limit, and 1 on a plain failure", () => {
  const [d, work, env] = project({ cfg: { tasks: { source: "issues" } }, db: {} });
  for (const [message, code] of [[LIMIT_MSG, 4], [SECONDARY_MSG, 4], ["boom", 1]] as [string, number][]) {
    failingGh(d, message);
    const po = hook(work, env, "factory_roles.ts", "work", "product-owner");
    expect(po.code, `work product-owner / ${message}: ${po.out}`).toBe(code);
    const next = hook(work, env, "next_task.ts");
    expect(next.code, `next_task / ${message}: ${next.out}`).toBe(code);
  }
});

// --- the orchestrator's thread notes read an issue's comments only when the issue changed ----------------------------

const NOTE_OPEN = (n: number): string => `<!-- factory-manager-note thread=issue-${n} status=open -->\nNote.\n- opened`;

function commentReads(env: Env, n: number): number {
  return log(env).filter((l) => l.startsWith("gh ") && l.includes(`issues/${n}/comments`) && !/ (POST|PATCH) /.test(l)).length;
}

/** Three cycles on one task issue: [the dev manager's folder, its comment reads]. The watcher's own checks read an
 * in-progress issue's comments too, so a test compares with the same issue updated just now (`iso(0)`: under a minute
 * old, so the thread-note step reads it every cycle). */
function threeCycles(n: number, state: string, label: string, updatedAt: string, note: boolean): [string, number] {
  const task = { number: n, state, title: "Task", body: "", labels: [{ name: label }], updated_at: updatedAt };
  const [d, work, env] = world({ db: { issues: [task], comments: note ? { [String(n)]: [comment(7, NOTE_OPEN(n), 120)] } : {} } });
  for (let i = 0; i < 3; i++) cycle(work, env);
  return [d, commentReads(env, n)];
}

test("an unchanged in-progress issue that has its note is not read again by the thread-note step", () => {
  const [, kept] = threeCycles(20, "open", "factory:in-progress", iso(120), true);
  const [, fresh] = threeCycles(20, "open", "factory:in-progress", iso(0), true);
  expect(kept, "read once, then kept for two cycles").toBe(fresh - 2);
});

test("an issue with no note yet is read again, so its note is posted once even when updated_at stays the same", () => {
  const [d, kept] = threeCycles(21, "open", "factory:in-progress", iso(120), false);
  const [, fresh] = threeCycles(21, "open", "factory:in-progress", iso(0), false);
  expect(posted(d, 21).filter((b) => b.includes("factory-manager-note")).length).toBe(1);
  expect(kept, "read and posted; read and found; then kept").toBe(fresh - 1);
});

test("a closed issue's note is closed once, and the issue is not read again until it changes", () => {
  const [d, kept] = threeCycles(22, "closed", "factory:in-review", iso(120), true);
  expect((posted(d, 22)[0] as string).split("issue was closed").length - 1).toBe(1);
  expect(kept).toBe(1);
  const [, fresh] = threeCycles(22, "closed", "factory:in-review", iso(0), true);
  expect(fresh, "updated under a minute ago: read every cycle").toBe(3);
});

// --- the dev manager's loop -----------------------------------------------------------------------------------------

/** The cycle's first GitHub call (the open pull requests): failing it makes one busy pass, whatever else the loop reads. */
const CYCLE = "pulls\\?state=open";

test("a rate limit does not stop the dev manager's loop: it waits until the reset and carries on", () => {
  const [d, work, env] = orchestratorProject();
  busyGh(d, env, { message: LIMIT_MSG, failFirst: 4, remaining: 0, reset: NOW + 600, match: CYCLE });
  const p = factory(work, env, ["dev-manager", "lead", "loop"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`[lead] GitHub limit reached; waiting until ${hhmm(NOW + 600)} UTC`);
  expect(p.out).not.toContain("passes failed in a row");
  expect(rlReads(d), "the reset time comes from gh api rate_limit").toBeGreaterThan(0);
  expect(rlLog(d).length, "after the waits the loop went on to read GitHub").toBeGreaterThan(5);
}, 120_000);

test("a secondary limit waits one, two, then four minutes and is still not a stop", () => {
  const [d, work, env] = orchestratorProject();
  busyGh(d, env, { message: SECONDARY_MSG, failFirst: 3, remaining: 4000, reset: NOW + 600, match: CYCLE });
  const p = factory(work, env, ["dev-manager", "lead", "loop"]);
  expect(p.code, p.out).toBe(0);
  const at = ["1", "2", "4"].map((m) => p.stdout.indexOf(`GitHub did not answer; trying again in ${m} min`));
  expect(at.every((i) => i >= 0), p.stdout).toBe(true);
  expect(at[0] as number).toBeLessThan(at[1] as number);
  expect(at[1] as number).toBeLessThan(at[2] as number);
  expect(p.stdout).not.toContain("GitHub limit reached");
  expect(p.out).not.toContain("passes failed in a row");
}, 120_000);

test("a network timeout is retried the same way and is not a stop", () => {
  const [d, work, env] = orchestratorProject();
  busyGh(d, env, { message: TLS_MSG, failFirst: 3, remaining: 4000, reset: NOW + 600, match: CYCLE });
  const p = factory(work, env, ["dev-manager", "lead", "loop"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("GitHub did not answer; trying again in 1 min");
  expect(p.stdout).toContain("GitHub did not answer; trying again in 2 min");
  expect(p.stdout).toContain("GitHub did not answer; trying again in 4 min");
  expect(p.out).not.toContain("passes failed in a row");
}, 120_000);

test("a plain failure still stops the dev manager's loop after three passes", () => {
  const [d, work, env] = orchestratorProject();
  busyGh(d, env, { message: "boom", failFirst: 100, remaining: 4000, reset: NOW + 600 });
  const p = factory(work, env, ["dev-manager", "lead", "loop"]);
  expect(p.code, p.out).toBe(1);
  expect(p.stdout).toContain("3 passes failed in a row");
  expect(p.stdout).not.toContain("GitHub did not answer");
}, 120_000);

// --- the product owner's loop and the builder's loop ----------------------------------------------------------------

test("a rate-limited product owner pass waits and carries on instead of stopping", () => {
  const [d, work, env] = project({ db: {} });
  busyGh(d, env, { message: LIMIT_MSG, failFirst: 4, remaining: 0, reset: NOW + 600 });
  const p = factory(work, env, ["product-owner", "loop"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`[eleni] GitHub limit reached; waiting until ${hhmm(NOW + 600)} UTC`);
  expect(p.out).not.toContain("passes failed in a row");
}, 120_000);

test("a rate-limited issue lookup in the builder's loop waits, looks again, and ends when nothing is ready", () => {
  const [d, work, env] = project({ cfg: { tasks: { source: "issues" } }, db: { issues: [] } });
  busyGh(d, env, { message: SECONDARY_MSG, failFirst: 1, remaining: 4000, reset: NOW + 600, match: "labels=agent:menelik" });
  const p = factory(work, env, ["loop"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("[menelik] GitHub did not answer; trying again in 1 min");
  expect(p.stdout).toContain("Nothing left for this loop");
  expect(rlLog(d).filter((l) => l.includes("labels=agent:menelik")).length, "the lookup was made again after the wait").toBeGreaterThanOrEqual(2);
}, 120_000);

// --- factory_views_cache.ts limit-wait and limit-idle ---------------------------------------------------------------

const RL_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$RL_LOG"
cat "$RL_JSON"
`;

interface Lone {
  d: string;
  env: Env;
}

/** A bare project with the hooks and a gh that only knows `rate_limit`; `cat` fails when the file is missing. */
function lone(cfg: Row = {}): Lone {
  const root = tmp();
  const d = join(root, "work");
  sh(["mkdir", "-p", d]);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik", "taytu"], ...cfg }));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  writeExe(join(root, "bin", "gh"), RL_GH);
  write(join(root, "rl.log"), "");
  const env = envWith(join(root, "bin"), { RL_LOG: join(root, "rl.log"), RL_JSON: join(root, "rl.json"), XDG_STATE_HOME: join(root, "state"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_NOW: String(NOW) });
  return { d, env: { ...env, ROOT: root } };
}

function setLimit(c: Lone, remaining: number, reset: number): void {
  write(join(c.env.ROOT as string, "rl.json"), limitJson(remaining, reset));
}

function reads(c: Lone): number {
  return readFileSync(c.env.RL_LOG as string, "utf8").split("\n").filter((l) => l.includes("rate_limit")).length;
}

/** `wait ...` or `idle ...`: the limit-wait and limit-idle commands of factory_views_cache.ts. */
function ratelimit(c: Lone, args: string[], now: number = NOW): Proc {
  const [cmd, ...rest] = args;
  return runBun(join(HOOKS, "factory_views_cache.ts"), [`limit-${cmd}`, ...rest],
    { cwd: c.d, env: { ...c.env, FACTORY_NOW: String(now) }, timeoutMs: 30_000 });
}

test("wait with the limit used up names the reset time in UTC, returns at once on the fake clock and exits 0", () => {
  const c = lone();
  setLimit(c, 0, NOW + 600);
  const p = ratelimit(c, ["wait", "--attempt", "1"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.trim()).toBe(`GitHub limit reached; waiting until ${hhmm(NOW + 600)} UTC`);
});

test("wait --name starts the line with the agent's name", () => {
  const c = lone();
  setLimit(c, 0, NOW + 600);
  expect(ratelimit(c, ["wait", "--attempt", "1", "--name", "lead"]).stdout.trim())
    .toBe(`[lead] GitHub limit reached; waiting until ${hhmm(NOW + 600)} UTC`);
  const other = lone();
  setLimit(other, 4000, NOW + 600);
  expect(ratelimit(other, ["wait", "--attempt", "1", "--name", "eleni"]).stdout.trim()).toBe("[eleni] GitHub did not answer; trying again in 1 min");
});

test("wait backs off 1, 2, 4, 8, 15, 15 minutes when the limit is not used up", () => {
  const c = lone();
  setLimit(c, 4000, NOW + 600);
  const got = [1, 2, 3, 4, 5, 6].map((n) => ratelimit(c, ["wait", "--attempt", String(n)]).stdout.trim());
  expect(got).toEqual(["1", "2", "4", "8", "15", "15"].map((m) => `GitHub did not answer; trying again in ${m} min`));
});

test("wait with a reset that has passed, or a limit that cannot be read, backs off instead", () => {
  const c = lone();
  setLimit(c, 0, NOW - 60);
  expect(ratelimit(c, ["wait", "--attempt", "2"]).stdout.trim()).toBe("GitHub did not answer; trying again in 2 min");
  const broken = lone(); // no rl.json: the fake gh fails
  const p = ratelimit(broken, ["wait", "--attempt", "3"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.trim()).toBe("GitHub did not answer; trying again in 4 min");
});

test("idle doubles the wait below github.reserve and says how many calls are left on stderr", () => {
  const c = lone();
  setLimit(c, 100, NOW + 600);
  const p = ratelimit(c, ["idle", "5"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.trim()).toBe("10");
  expect(p.stderr).toContain("100");
});

test("idle keeps the wait with plenty of calls left, with github.reserve 0, and when the limit cannot be read", () => {
  const plenty = lone();
  setLimit(plenty, 4000, NOW + 600);
  const a = ratelimit(plenty, ["idle", "5"]);
  expect(a.stdout.trim()).toBe("5");
  expect(a.stderr).toBe("");
  const never = lone({ github: { reserve: 0 } });
  setLimit(never, 100, NOW + 600);
  expect(ratelimit(never, ["idle", "5"]).stdout.trim()).toBe("5");
  const unreadable = lone();
  const u = ratelimit(unreadable, ["idle", "5"]);
  expect(u.code, u.out).toBe(0);
  expect(u.stdout.trim()).toBe("5");
});

test("github.reserve is a setting: the reserve of 500 can be changed and idle follows it", () => {
  const c = lone({ github: { reserve: 50 } });
  setLimit(c, 100, NOW + 600);
  expect(ratelimit(c, ["idle", "5"]).stdout.trim()).toBe("5");
  setLimit(c, 40, NOW + 600);
  expect(ratelimit(c, ["idle", "5"], NOW + 120).stdout.trim()).toBe("10");
});

test("settings get github.reserve prints the default of 500 and settings help names it", () => {
  const c = lone();
  const got = runBun(join(HOOKS, "factory_settings.ts"), ["get", "github.reserve"], { cwd: c.d, env: c.env });
  expect(got.code, got.out).toBe(0);
  expect(got.stdout.trim()).toBe("500");
  const help = runBun(join(HOOKS, "factory_settings.ts"), ["help", "github.reserve"], { cwd: c.d, env: c.env });
  expect(help.code, help.out).toBe(0);
  expect(help.stdout).toContain("github.reserve");
  expect(help.stdout).toContain("500");
});

// --- the shared rate_limit cache --------------------------------------------------------------------------------------

test("two idle calls within 60 seconds make one rate_limit call, and one 90 seconds later makes a second", () => {
  const c = lone();
  setLimit(c, 4000, NOW + 600);
  ratelimit(c, ["idle", "5"], NOW);
  ratelimit(c, ["idle", "5"], NOW + 30);
  expect(reads(c)).toBe(1);
  ratelimit(c, ["idle", "5"], NOW + 90);
  expect(reads(c)).toBe(2);
});

test("wait and idle share the cache, and a cached answer still gives the same result", () => {
  const c = lone();
  setLimit(c, 0, NOW + 600);
  const first = ratelimit(c, ["wait", "--attempt", "1"], NOW);
  setLimit(c, 4000, NOW + 600); // GitHub changed, but the cache is fresh
  const idle = ratelimit(c, ["idle", "5"], NOW + 10);
  expect(reads(c)).toBe(1);
  expect(first.stdout).toContain("GitHub limit reached");
  expect(idle.stdout.trim()).toBe("10"); // the cached answer says 0 calls left, below the reserve
});
