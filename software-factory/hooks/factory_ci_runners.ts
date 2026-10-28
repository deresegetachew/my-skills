#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory ci runners [<n>]` (#282): how many heavy CI runners this machine runs for this project.
//
//   factory ci runners        the count here and where it comes from
//   factory ci runners 4      saves 4 for this project on this machine (this machine's settings file, `ci.runners`; not
//                             committed), then reinstalls the runners as `factory ci install` does
//
// Which count wins (ci_names.ts runnerSetting(), the one every reader uses): FACTORY_CI_RUNNERS, then this machine's
// saved count, then `ci.runners` in .claude/factory.json, then 1. `factory update` keeps it and never scales a
// machine down. Errors are {code, message, fix} on stderr with exit 1; a refused count saves nothing.
import { join } from "node:path";
import { config, runnerCount, sourceText } from "../ci/ci_names.ts";
import { pyDumps, run, runMain } from "./factory_lib.ts";
import { saveMachineSettings, namesFile } from "./factory_machine.ts";
import { MACHINE, parse, type Setting, SettingError } from "./factory_settings_schema.ts";

const USAGE_FIX = "Give a whole number from 1 to 16, for example: factory ci runners 4";

function refuse(code: string, message: string, fix: string): number {
  process.stderr.write(pyDumps({ code, message, fix }) + "\n");
  return 1;
}

function show(): number {
  const cfg = config();
  const { runners, source } = runnerCount(cfg);
  const where = source === "machine" ? `${sourceText(source)} (${namesFile()})` : sourceText(source);
  const light = cfg.light !== false ? ", plus the light lane" : "";
  console.log(`${runners} heavy CI runner(s) for this project on this machine${light}, from ${where}.`);
  console.log("Change it for this machine with `factory ci runners <n>` (saved here, not committed, then installed).");
  return 0;
}

function save(raw: string): number {
  let n: number;
  try {
    n = parse(MACHINE["ci.runners"] as Setting, raw) as number;
  } catch (e) {
    if (!(e instanceof SettingError)) throw e;
    return refuse("bad-runner-count", `${JSON.stringify(raw)} isn't a runner count: it ${e.message}`, USAGE_FIX);
  }
  const path = saveMachineSettings({ "ci.runners": n });
  console.log(`Saved ${n} heavy CI runner(s) for this project on this machine in ${path} (not committed).`);
  const env: Record<string, string | undefined> = { ...process.env };
  const given = env.FACTORY_CI_RUNNERS;
  if (given) {
    console.log(`FACTORY_CI_RUNNERS=${given} is set in this shell and wins over the saved count in later commands; ` +
      "unset FACTORY_CI_RUNNERS to use it.");
    delete env.FACTORY_CI_RUNNERS; // this install applies what was just saved
  }
  console.log("Installing the runners (`factory ci install`)...");
  const p = run(["bash", join(import.meta.dir, "..", "ci", "ci.sh"), "install"], { env, inherit: true });
  if (p.code !== 0) {
    return refuse("install-failed", `Saved ${n} for this machine, but \`factory ci install\` failed (see above).`,
      "Fix what it says, then run `factory ci install` again; the saved count stays.");
  }
  return 0;
}

export function main(argv: string[]): number {
  if (argv.length === 0) return show();
  if (argv.length > 1) return refuse("usage", `factory ci runners takes one number, not ${argv.join(" ")}.`, USAGE_FIX);
  return save(argv[0] as string);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
