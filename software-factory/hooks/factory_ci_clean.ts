#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory ci clean [--apply]` (#282): this project's offline idle runners (<ci name>-...) and its exited CI containers.
//
//   factory ci clean            lists them; nothing is changed
//   factory ci clean --apply    removes each and says so; a second run finds nothing
//
// The same code as `factory reset-run` (factory_reset_run.ts ciSteps()), so the two cannot drift. It never deletes the
// runs-on variables (CI_RUNS_ON, CI_RUNS_ON_LIGHT): that changes where jobs run, which is `factory ci use`. It only
// says so when no online runner has their labels. Errors are {code, message, fix} on stderr with exit 1.
import { load } from "./factory_config.ts";
import { pyDumps, runMain } from "./factory_lib.ts";
import { ciSteps, ghApi, refused, runSteps } from "./factory_reset_run.ts";

export function main(argv: string[]): number {
  const unknown = argv.filter((a) => a !== "--apply");
  if (unknown.length) {
    process.stderr.write(pyDumps({ code: "usage", message: `unknown option ${unknown.join(" ")}.`,
      fix: "Use: factory ci clean (lists) or factory ci clean --apply (removes)." }) + "\n");
    return 1;
  }
  try {
    ghApi("user");
    runSteps(ciSteps(load(), "note"), argv.includes("--apply"), "factory ci clean", "Nothing to clean.");
  } catch (e) {
    return refused(e);
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
