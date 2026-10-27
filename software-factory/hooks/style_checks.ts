#!/usr/bin/env -S bun --no-env-file
// CI: run every style `check` command from .claude/factory.json (`styles[].check`), once each.
//
// Exit 1 if any fails. With no styles, prints that and passes.
import { load } from "./factory_config.ts";
import { run, runMain } from "./factory_lib.ts";

export function main(): number {
  const cfg = load();
  const checks: string[] = [];
  for (const style of cfg.styles ?? []) {
    const c = style.check;
    if (c && !checks.includes(c)) checks.push(c);
  }
  if (!checks.length) {
    process.stdout.write("no style checks configured\n");
    return 0;
  }
  let failed = false;
  for (const c of checks) {
    process.stdout.write(`$ ${c}\n`);
    if (run(["/bin/sh", "-c", c], { inherit: true }).code !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (import.meta.main) await runMain(() => main());
