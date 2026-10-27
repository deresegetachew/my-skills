#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Which extra reviews and checks a change needs, from `reviews`, `eval`, `design` and `styles` in factory.json.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_reviews.ts            the current branch against origin/<mainBranch>
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_reviews.ts --json
//
// Paths are matched as regexes, ignoring case; committed, uncommitted and untracked changes all count.
// Prints one line per needed review or check with the first changed files that triggered it, for example
//   safety-auditor       packages/validators/src/rules.ts
//   architecture-reviewer apps/api/src/brands/brands.controller.ts
// `reviewer` is always needed and isn't listed. next-task runs each listed one; the reviewer checks they ran.
import { type Config, type Json, load, styled } from "./factory_config.ts";
import { git, pyDumps, runMain } from "./factory_lib.ts";

function strings(v: Json | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Python's truthiness for a JSON value. */
function truthy(v: Json | undefined): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/** {review or check: [changed paths that need it]}, in the order Python built it. */
export function needed(changed: string[], cfg: Config): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const match = (name: string, rxs: string[]): void => {
    const res = rxs.map((rx) => new RegExp(rx, "i"));
    const hits = changed.filter((p) => res.some((r) => r.test(p)));
    if (hits.length) out[name] = hits;
  };
  for (const [name, rule] of Object.entries(cfg.reviews ?? {})) {
    if (!name.startsWith("_")) match(name, strings((rule ?? {}).paths));
  }
  const ev = cfg.eval ?? {};
  if (truthy(ev.command)) match(typeof ev.skill === "string" ? ev.skill : "eval", strings(ev.paths));
  const design = cfg.design ?? {};
  if (truthy(design.references)) {
    match(typeof design.skill === "string" ? design.skill : "design-check", strings(design.paths));
  }
  const hits = changed.filter((p) => styled([p], cfg).length);
  if (hits.length) out["architecture-reviewer"] = hits;
  return out;
}

function words(args: string[]): string[] {
  return git(args).stdout.split(/\s+/).filter(Boolean);
}

export function main(argv: string[]): number {
  const cfg = load();
  const diff = [
    ...words(["diff", "--name-only", `origin/${cfg.mainBranch}...HEAD`]),
    ...words(["diff", "--name-only", "HEAD"]),
    ...words(["ls-files", "--others", "--exclude-standard"]),
  ];
  const res = needed([...new Set(diff)].sort(), cfg);
  if (argv.includes("--json")) {
    process.stdout.write(pyDumps(res, { indent: 2 }) + "\n");
  } else {
    for (const [name, hits] of Object.entries(res)) {
      process.stdout.write(`${name.padEnd(21)} ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? " ..." : ""}\n`);
    }
    if (!Object.keys(res).length) process.stdout.write("only the reviewer\n");
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
