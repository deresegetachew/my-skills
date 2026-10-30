// Owner alerts (#303): `factory alerts check` rings the terminal bell and shows a desktop notice for each new open
// owner-queue ask. Runs the hook in a throwaway project (roles_support.ts) with the stateful fake gh and a minimal PATH,
// so a real notify-send or osascript on the developer's machine is never seen.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, issue, poProject, SF } from "./roles_support.ts";
import { type Proc, readJson, sh, WIKI, writeExe } from "./support.ts";

const BEL = "\x07";
const ask = (id: string, text: string) => `<!-- factory-owner-ask id=${id} -->\n${text}`;
const DB = (...comments: string[]) => ({ issues: [issue(40, "Dev manager: needs the owner")], comments: { "40": comments } });

interface Rig { d: string; work: string; env: Env }

/** A project with a minimal PATH (bun, git, the fake gh) plus the named fake notifiers, each logging to notices.log. */
function rig(comments: string[], notifiers: string[] = ["notify-send"], display: Env = { DISPLAY: ":0" }): Rig {
  const [d, work, base] = poProject({ db: DB(...comments) });
  const bin = join(d, "minbin");
  writeExe(join(bin, "bun"), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  symlinkSync(Bun.which("git") as string, join(bin, "git"));
  symlinkSync(join(d, "bin", "gh"), join(bin, "gh"));
  for (const n of notifiers) writeExe(join(bin, n), `#!/bin/sh\nprintf '${n}: %s\\n' "$*" >> ${join(d, "notices.log")}\n`);
  const env: Env = { ...base, PATH: bin, XDG_STATE_HOME: join(d, "state") };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  return { d, work, env: { ...env, ...display } };
}

function check(r: Rig): Proc {
  return sh([process.execPath, "--no-env-file", join(r.work, ".claude", "hooks", "factory_alerts.ts"), "check"],
    { cwd: r.work, env: r.env });
}

function addComments(r: Rig, ...bodies: string[]): void {
  const file = join(r.d, "db.json");
  const db = JSON.parse(readFileSync(file, "utf8")) as { comments: Record<string, string[]> };
  db.comments["40"]?.push(...bodies);
  writeFileSync(file, JSON.stringify(db));
}

function notices(r: Rig): string[] {
  const f = join(r.d, "notices.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l !== "") : [];
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

test("the first look records the asks already open without a bell or a notice", () => {
  const r = rig([ask("renumber", "renumber the stories?"), ask("palette", "pick a palette")]);
  const p = check(r);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).not.toContain(BEL);
  expect(p.stdout).toContain("already waiting: renumber: renumber the stories?");
  expect(p.stdout).toContain("already waiting: palette: pick a palette");
  expect(notices(r)).toEqual([]);
});

test("a new ask rings once, shows one notice, and never alerts twice", () => {
  const r = rig([]);
  check(r);
  addComments(r, ask("deploy", "ok to deploy?\nmore detail"));
  const p = check(r);
  expect(p.code, p.out).toBe(0);
  expect(count(p.stdout, BEL)).toBe(1);
  expect(p.stdout).toContain("needs you: deploy: ok to deploy?\n");
  expect(p.stdout).not.toContain("more detail");
  expect(notices(r)).toHaveLength(1);
  expect(notices(r)[0]).toContain("Factory: needs you");
  expect(notices(r)[0]).toContain("deploy");
  const again = check(r);
  expect(again.stdout).not.toContain(BEL);
  expect(again.stdout).toContain("nothing new");
  expect(notices(r)).toHaveLength(1);
});

test("several new asks at once give one bell and one notice each", () => {
  const r = rig([]);
  check(r);
  addComments(r, ask("one", "first"), ask("two", "second"));
  const p = check(r);
  expect(count(p.stdout, BEL)).toBe(2);
  expect(p.stdout).toContain("needs you: one: first");
  expect(p.stdout).toContain("needs you: two: second");
  const log = notices(r);
  expect(log).toHaveLength(2);
  expect(log.filter((l) => l.includes("one"))).toHaveLength(1);
  expect(log.filter((l) => l.includes("two"))).toHaveLength(1);
});

test("a comment with two ask markers alerts both, each with the ask's text (#357)", () => {
  const r = rig([]);
  check(r);
  addComments(r, `<!-- factory-owner-ask id=one -->\n${ask("two", "both of these?")}`);
  const p = check(r);
  expect(count(p.stdout, BEL)).toBe(2);
  expect(p.stdout).toContain("needs you: one: both of these?");
  expect(p.stdout).toContain("needs you: two: both of these?");
});

test("an answered ask is never alerted", () => {
  const r = rig([]);
  check(r);
  addComments(r, ask("done", "already handled"), "<!-- factory-owner-answer id=done -->\nyes", ask("open", "still open"));
  const p = check(r);
  expect(count(p.stdout, BEL)).toBe(1);
  expect(p.stdout).toContain("needs you: open: still open");
  expect(p.stdout).not.toContain("needs you: done");
  expect(notices(r)).toHaveLength(1);
});

test("osascript is used when present, and notify-send is not called", () => {
  const r = rig([], ["osascript", "notify-send"]);
  check(r);
  addComments(r, ask("deploy", "ok to deploy?"));
  const p = check(r);
  expect(count(p.stdout, BEL)).toBe(1);
  expect(notices(r)).toHaveLength(1);
  expect(notices(r)[0]).toStartWith("osascript:");
  expect(notices(r)[0]).toContain("Factory: needs you");
  expect(notices(r)[0]).toContain("deploy");
});

test("with no notifier the bell still rings and the reason is logged once", () => {
  const r = rig([], []);
  check(r);
  addComments(r, ask("one", "first"));
  const p = check(r);
  expect(count(p.stdout, BEL)).toBe(1);
  expect(count(p.stderr, "no desktop notice:")).toBe(1);
  addComments(r, ask("two", "second"));
  const later = check(r);
  expect(count(later.stdout, BEL)).toBe(1);
  expect(later.stderr).not.toContain("no desktop notice:");
});

test("notify-send without a desktop session (ssh only) is not called", () => {
  const r = rig([], ["notify-send"], {});
  check(r);
  addComments(r, ask("one", "first"));
  const p = check(r);
  expect(count(p.stdout, BEL)).toBe(1);
  expect(p.stderr).toMatch(/no desktop notice:.*(desktop|display)/i);
  expect(notices(r)).toEqual([]);
});

test("github unreachable is a json error, and the ask added meanwhile alerts once afterwards", () => {
  const r = rig([]);
  check(r);
  addComments(r, ask("during", "added while offline"));
  const gh = join(r.d, "minbin", "gh");
  const real = join(r.d, "bin", "gh");
  sh(["rm", gh]);
  writeExe(gh, "#!/bin/sh\nexit 1\n");
  const bad = check(r);
  expect(bad.code).toBe(1);
  const err = JSON.parse(bad.stderr.trim().split("\n").pop() as string) as { code: string; message: string; fix: string };
  expect(err.code).toBe("alerts-github");
  expect(err.message).not.toBe("");
  expect(err.fix).not.toBe("");
  expect(bad.stdout).not.toContain(BEL);
  expect(readJson(join(r.d, "state", readdirOne(join(r.d, "state")), "alerts.json"))).toBeTruthy();
  sh(["rm", gh]);
  symlinkSync(real, gh);
  const good = check(r);
  expect(count(good.stdout, BEL)).toBe(1);
  expect(good.stdout).toContain("needs you: during");
  expect(notices(r)).toHaveLength(1);
});

test("factory help and the commands page list alerts", () => {
  expect(sh(["bash", join(SF, "factory"), "help"]).stdout).toContain("alerts check|watch");
  expect(readFileSync(join(WIKI, "commands.md"), "utf8")).toContain("| `factory alerts");
});

function readdirOne(dir: string): string {
  return (Bun.spawnSync(["ls", dir]).stdout.toString().trim().split("\n")[0]) as string;
}
