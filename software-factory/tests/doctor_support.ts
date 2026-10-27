// Shared helpers for the `factory doctor` tests (doctor, doctor_manager, doctor_models, trust, permission_mode, ...):
// a PATH of stub tools so a run doesn't depend on what this machine has installed, and a throwaway project whose
// .claude/hooks links the real hooks. Not a test file.
import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, type Proc, SF, sh, tmp, write, writeExe } from "./support.ts";

export type Env = { PATH: string; HOME: string; [key: string]: string };

export function stub(bin: string, name: string, body: string): void {
  writeExe(join(bin, name), "#!/bin/sh\n" + body + "\n");
}

export interface MachineOptions {
  ghSignedIn?: boolean;
  node?: string | null;
  extra?: string[];
  gh?: string;
  /** Leave bun off the PATH (the doctor itself is then started by path). */
  noBun?: boolean;
}

/** A bin folder with git, bun, python3 (for a Python project's own test command) and the basics linked in, plus stub
 * gh, claude and node. */
export function machine(o: MachineOptions = {}): Env {
  const bin = tmp("doctor-bin-");
  const tools = ["git", "python3", "bash", "sh", "env", "uname", "dirname", "basename", "cat"];
  for (const tool of o.noBun ? tools : [...tools, "bun"]) {
    const found = tool === "bun" ? process.execPath : Bun.which(tool);
    if (found) symlinkSync(found, join(bin, tool));
  }
  // signed out: every gh call fails, as it does with no token (`gh api` too, since #157)
  stub(bin, "gh", o.gh ?? ((o.ghSignedIn ?? true) ? "exit 0" : "echo 'gh: run gh auth login or set GH_TOKEN' >&2; exit 1"));
  stub(bin, "claude", "echo '2.1.310 (Claude Code)'");
  const node = o.node === undefined ? "v22.11.0" : o.node;
  if (node) stub(bin, "node", `echo ${node}`);
  for (const name of o.extra ?? []) stub(bin, name, "echo 9.0.0");
  return { PATH: bin, HOME: tmp("doctor-home-") };
}

/** A git project with the factory's hooks linked in, factory.json (`cfg`), an empty settings.json and `files`. */
export function project(files: Record<string, string> = {}, cfg: Record<string, unknown> | null = null): string {
  const d = tmp("doctor-project-");
  sh(["git", "init", "-q", "-b", "main", d]);
  const hooks = join(d, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(hooks, f));
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg ?? { agents: ["menelik", "taytu"] }));
  write(join(d, ".claude", "factory", "settings.json"), JSON.stringify({ hooks: {} })); // the agents' rules (#258)
  for (const [name, text] of Object.entries(files)) write(join(d, name), text);
  return d;
}

/** `factory doctor` in `d`, as a person runs it. */
export function doctor(d: string, env: Record<string, string>, ...args: string[]): Proc {
  return sh(["bash", join(SF, "factory"), "doctor", ...args], { cwd: d, env, timeoutMs: 60_000 });
}

export function lines(p: Proc, kind: string): string[] {
  return p.stdout.split("\n").filter((l) => l.startsWith(kind));
}

/** The kit's hook line for a Bun hook, as `factory update` writes it into settings.json. */
export function hookLine(name: string): string {
  return `bun --no-env-file "$CLAUDE_PROJECT_DIR"/.claude/hooks/${name}.ts`;
}
