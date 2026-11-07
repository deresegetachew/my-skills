// The talks with a role running on this machine (#3 of the liveness issue): `factory talk <role>` writes a small file
// while its session runs, so `factory agents ls` (and the web UI) shows that role as working, "talking with the owner",
// instead of down. The file is `talks/<role>-<pid>.json` in this machine's state folder (factory_machine.ts):
// {role, name, pid, at}. It is removed when the talk ends; one whose process has gone (a talk that was killed) counts for
// nothing and is removed by the next reader.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./factory_claims.ts";
import { stateDir } from "./factory_machine.ts";
import { now as clockNow } from "./factory_clock.ts";

export const TALKING = "talking with the owner";

export interface Talk {
  role: string;
  name: string;
  pid: number;
  at: number;
}

function folder(): string {
  return join(stateDir(), "talks");
}

/** Marks a talk with `name` (of `role`) as running in this process; returns the file to pass to talkEnd. */
export function talkBegin(role: string, name: string): string {
  const dir = folder();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${role}-${process.pid}.json`);
  const talk: Talk = { role, name, pid: process.pid, at: clockNow() };
  writeFileSync(`${file}.tmp`, JSON.stringify(talk));
  renameSync(`${file}.tmp`, file);
  return file;
}

export function talkEnd(file: string): void {
  rmSync(file, { force: true });
}

function parse(text: string): Talk | null {
  try {
    const t = JSON.parse(text) as Partial<Talk>;
    if (typeof t.role !== "string" || typeof t.name !== "string" || typeof t.pid !== "number") return null;
    return { role: t.role, name: t.name, pid: t.pid, at: typeof t.at === "number" ? t.at : 0 };
  } catch {
    return null;
  }
}

/** The talks running now. `isTalk(pid)` says whether that process is still a talk (a pid can be reused); by default a
 * live pid is enough. Files of talks that ended are removed. */
export function talksNow(isTalk: (pid: number) => boolean = pidAlive): Talk[] {
  let files: string[];
  try {
    files = readdirSync(folder()).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no talk has run here
  }
  const out: Talk[] = [];
  for (const f of files) {
    const path = join(folder(), f);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // it ended between the listing and the read
    }
    const t = parse(text);
    if (t && pidAlive(t.pid) && isTalk(t.pid)) out.push(t);
    else rmSync(path, { force: true });
  }
  return out;
}
