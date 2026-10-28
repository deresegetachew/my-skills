#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Owner alerts (#303, PRD US-7): when a new item needs the owner, the terminal rings and a desktop notice appears.
//
// An item is an open owner-queue ask: a `<!-- factory-owner-ask id=<slug> -->` comment on the "Dev manager: needs the
// owner" issue that nobody has answered (openOwnerAsks in factory_prs.ts). Each new one gives one bell (BEL on stdout)
// and one desktop notice: osascript when it is on the PATH (macOS), else notify-send when there is a desktop session
// (DISPLAY or WAYLAND_DISPLAY; over plain ssh there is none). Nothing to install. With no notice possible the bell still
// rings, and the reason is said once (kept until a notice works again).
//
// What it has seen is kept in `alerts.json` in this project's state folder (`factory machine show`), so an ask alerts
// once, however often it looks, and asks that came while the machine slept alert at the next look. The first look
// records the asks already open without ringing: they are not new.
//
//   factory alerts check              one look: a bell and a notice per new ask, else `nothing new`
//   factory alerts watch [--every S]  look every S seconds (default 60, at least 10) in this terminal, until stopped
//
// Read only on GitHub. The cockpit shows the same alerts in its own window later (US-12).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ghAll } from "./factory_issues.ts";
import { Exit, FactoryError, fail, pyDumps, pyRepr, run, runMain, which } from "./factory_lib.ts";
import { refuse, stateDir } from "./factory_machine.ts";
import { OWNER_ASK, OWNER_QUEUE_TITLE, openOwnerAsks } from "./factory_prs.ts";

const FILE = "alerts.json";
const TITLE = "Factory: needs you";
const BEL = "\x07";
const KEEP = 500; // seen asks remembered, newest last
const USAGE = "usage: factory alerts check | watch [--every SECONDS]";

type Obj = { [key: string]: unknown };

export interface Ask {
  key: string;
  slug: string;
  text: string;
  url: string | null;
}

interface Seen {
  seen: string[];
  trouble: string | null;
}

// --- what needs the owner --------------------------------------------------------------------------------------------

/** The first line of an ask's text after its marker. */
function firstLine(body: string): string {
  const rest = body.replace(OWNER_ASK, "");
  return rest.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
}

/** The open owner-queue asks, oldest first. Stops with {code: alerts-github} when GitHub can't be read. */
export function openAsks(): Ask[] {
  try {
    const asks: Ask[] = [];
    for (const i of ghAll<Obj>("repos/{owner}/{repo}/issues?state=open")) {
      if (i.title !== OWNER_QUEUE_TITLE || "pull_request" in i) continue;
      for (const [slug, c] of openOwnerAsks(ghAll<Obj>(`repos/{owner}/{repo}/issues/${i.number}/comments`))) {
        asks.push({ key: `${i.number}:${slug}`, slug, text: firstLine(String(c.body ?? "")),
          url: typeof c.html_url === "string" ? c.html_url : null });
      }
    }
    return asks;
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    return fail("alerts-github", `Could not read the owner queue from GitHub: ${String(e.text ?? "gh failed").slice(0, 200)}`,
      "Check the network and `gh auth status`, then run `factory alerts check` again. Nothing was marked as seen.");
  }
}

// --- what was seen ---------------------------------------------------------------------------------------------------

function seenPath(): string {
  return join(stateDir(), FILE);
}

function loadSeen(): Seen | null {
  try {
    const data = JSON.parse(readFileSync(seenPath(), "utf8")) as Obj;
    const seen = Array.isArray(data.seen) ? data.seen.filter((x): x is string => typeof x === "string") : [];
    return { seen, trouble: typeof data.trouble === "string" ? data.trouble : null };
  } catch {
    return null;
  }
}

function saveSeen(s: Seen): void {
  mkdirSync(stateDir(), { recursive: true });
  const path = seenPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pyDumps({ seen: s.seen.slice(-KEEP), trouble: s.trouble }, { indent: 1 }));
  renameSync(tmp, path);
}

// --- the desktop notice ----------------------------------------------------------------------------------------------

/** Shows one desktop notice. Returns null when it was shown, else why not. */
export function notify(title: string, body: string): string | null {
  if (which("osascript")) {
    const p = run(["osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e", "end run", title, body], { timeoutMs: 15_000 });
    return p.code === 0 ? null : `osascript failed: ${(p.stderr || p.stdout).trim().slice(0, 160) || `exit ${p.code}`}`;
  }
  if (which("notify-send")) {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return "no desktop session here (DISPLAY and WAYLAND_DISPLAY are unset, as over plain ssh)";
    }
    const p = run(["notify-send", title, body], { timeoutMs: 15_000 });
    return p.code === 0 ? null : `notify-send failed: ${(p.stderr || p.stdout).trim().slice(0, 160) || `exit ${p.code}`}`;
  }
  return "neither osascript (macOS) nor notify-send (Linux, package libnotify-bin) is on the PATH";
}

// --- one look --------------------------------------------------------------------------------------------------------

function shown(a: Ask): string {
  return `${a.slug}: ${a.text}` + (a.url ? ` (${a.url})` : "");
}

/** One look: a bell and a notice per new ask. Returns how many alerted. */
export function check(): number {
  const asks = openAsks();
  const before = loadSeen();
  if (before === null) {
    for (const a of asks) console.log(`already waiting: ${shown(a)}`);
    if (!asks.length) console.log("nothing waiting");
    saveSeen({ seen: asks.map((a) => a.key), trouble: null });
    return 0;
  }
  const known = new Set(before.seen);
  const fresh = asks.filter((a) => !known.has(a.key));
  let trouble = before.trouble;
  for (const a of fresh) {
    process.stdout.write(`${BEL}needs you: ${shown(a)}\n`);
    const why = notify(TITLE, `${a.slug}: ${a.text}`);
    if (why && why !== trouble) process.stderr.write(`no desktop notice: ${why}. The bell still rings.\n`);
    trouble = why;
  }
  if (!fresh.length) console.log("nothing new");
  saveSeen({ seen: [...before.seen, ...fresh.map((a) => a.key)], trouble });
  return fresh.length;
}

/** Looks every `every` seconds until stopped. A failed look is said and retried; it never ends the watch. */
async function watch(every: number): Promise<void> {
  let stop = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stop = true));
  let failing = false;
  while (!stop) {
    try {
      check();
      failing = false;
    } catch (e) {
      if (!(e instanceof FactoryError)) throw e;
      if (!failing) process.stderr.write(`${JSON.stringify(e.toJSON())}\nTrying again every ${every} s.\n`);
      failing = true;
    }
    for (let waited = 0; waited < every && !stop; waited += 1) await Bun.sleep(1000);
  }
}

function everyOf(args: string[]): number {
  const i = args.indexOf("--every");
  if (i < 0) return 60;
  const n = Number(args[i + 1]);
  if (!Number.isFinite(n) || n < 10) {
    refuse("bad-every", `--every ${pyRepr(args[i + 1] ?? "")} isn't a number of seconds of 10 or more.`,
      "Use for example `factory alerts watch --every 60`.");
  }
  return n;
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "check";
  if (cmd === "check") {
    check();
    return;
  }
  if (cmd === "watch") return watch(everyOf(argv.slice(1)));
  refuse("unknown-command", `unknown command ${pyRepr(cmd)}.`, USAGE.replace("usage: ", "Use "));
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
