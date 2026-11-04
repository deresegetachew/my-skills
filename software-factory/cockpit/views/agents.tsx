// The Agents & machines view (#367), towards its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VAgents.dc.html): each
// machine with its sessions (name, role, state, what it does, where), this machine first, from the cockpit's snapshot
// (`sessions`, which is `factory agents ls --json`). It only reads: starting, stopping and messaging a session are the
// owner's actions in the command bar (`owner start`, `owner stop`, `say`).
import { type Line, list, type Obj, plain, seg, type Style } from "./lines.tsx";
import { clip, heading, padStr, para } from "./doc.tsx";
import type { Got } from "./read.ts";

const GLYPH: Record<string, [string, Style]> = { working: ["●", "blue"], waiting: ["◐", "amber"], "input-required": ["◐", "amber"],
  idle: ["○", "dim"], down: ["✕", "red"] };

function glyph(state: string): [string, Style] {
  return GLYPH[state] ?? ["·", "dim"];
}

function machineOf(r: Obj, host: string): string {
  if (r.source === "local") return plain(r.machineName) || host || "this machine";
  return plain(r.machineName) || plain(r.machine) || plain(r.where) || "another machine";
}

function doing(r: Obj): string {
  const detail = plain(r.detail) || plain(r.state);
  const task = plain(r.task);
  return task && !detail.includes(task) ? `${detail} · ${/^\d+$/.test(task) ? `#${task}` : task}` : detail;
}

function where(r: Obj): string {
  return plain(r.session) || (r.source === "local" ? "" : plain(r.where));
}

function rowsOf(rows: Obj[], w: number): Line[] {
  const out: Line[] = [];
  const nameW = Math.min(Math.max(...rows.map((r) => [...plain(r.name)].length), 4) + 2, 22);
  if (w >= 90) {
    out.push([seg(`  ${padStr("name", nameW)}  ${padStr("role", 15)}${padStr("state", 16)}${padStr("doing", w - nameW - 2 - 15 - 16 - 24)}where`, "dim")]);
  }
  for (const r of rows) {
    const state = plain(r.state) || "unknown";
    const [g, gs] = glyph(state);
    if (w >= 90) {
      const doingW = w - nameW - 2 - 15 - 16 - 24;
      out.push([seg(`  ${g} `, gs), seg(padStr(plain(r.name), nameW), "bold"), seg(padStr(plain(r.kind), 15), "dim"),
        seg(padStr(state, 16), gs), seg(padStr(doing(r), doingW)), seg(clip(where(r), 24), "dim")]);
    } else {
      out.push([seg(`  ${g} `, gs), seg(plain(r.name), "bold"), seg(`  ${state}`, gs), seg(`  ${plain(r.kind)}`, "dim")]);
      out.push([seg(`    ${clip(doing(r), w - 4)}`)]);
      if (where(r)) out.push([seg(`    ${clip(where(r), w - 4)}`, "dim")]);
    }
  }
  return out;
}

const KEYS = "watch one: factory follow <name> · message: factory say <name> <text> · start: factory owner start · " +
  "stop: factory owner stop <name> · every agent: factory agents ls · this machine's setup: factory machine show";

/** Every line of the Agents & machines view for a snapshot (undefined: still reading), at most `w` wide. */
export function agentsLines(snap: Got | undefined, repo: string, host: string, w: number): Line[] {
  const out: Line[] = [...heading([seg("factory", "amber"), seg(`  ${repo} · Agents and machines`, "dim")],
    "factory agents ls · factory machine show", w), []];
  if (snap === undefined) return [...out, [seg("Reading the snapshot…")]];
  if (snap === "late") return [...out, ...para("The snapshot took too long to read: run `factory cockpit --json` to see why.", w)];
  if (snap === null) return [...out, ...para("No snapshot yet: `factory cockpit --json` reads one now.", w)];
  const sessions = list(snap.sessions);
  const machines = new Map<string, Obj[]>();
  for (const r of [...sessions.filter((r) => r.source === "local"), ...sessions.filter((r) => r.source !== "local")]) {
    const m = machineOf(r, host);
    machines.set(m, [...(machines.get(m) ?? []), r]);
  }
  if (!machines.size) out.push(...para("No sessions on any machine. Start one: factory loop -i", w));
  for (const [m, rows] of machines) {
    const here = rows.some((r) => r.source === "local");
    const down = rows.filter((r) => plain(r.state) === "down").length;
    out.push([seg(m, "bold"), seg(`  ${here ? "this machine" : "from its agent issues on GitHub"}`, "dim"),
      seg(`  ${rows.length} session${rows.length === 1 ? "" : "s"}${down ? `, ${down} down` : ""}`, down ? "red" : "dim")]);
    out.push(...rowsOf(rows, w), []);
  }
  for (const p of list(snap.missing).filter((p) => /sessions/.test(plain(p.code)))) {
    out.push(...para(plain(p.message), w, "red"), ...para(`fix: ${plain(p.fix)}`, w, "dim"), []);
  }
  out.push(...para(KEYS, w, "dim", " · "));
  return out;
}
