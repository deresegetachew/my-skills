// factory-loop.sh restarts itself when main brings a newer factory-loop.sh, keeping its pid, agent and folder.
// Runs the real loop script in a throwaway repo with stub hooks and a stub `claude`.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { read, sh, writeExe } from "./support.ts";
import { type Env, loopRepo } from "./loop_support.ts";

// The stub `claude` does the task by pushing a new factory-loop.sh to main, as a factory update would.
const CLAUDE = String.raw`#!/usr/bin/env bash
set -e
echo "claude $*" >> "$LOOP_LOG"
d=$(mktemp -d); git clone -q "$LOOP_ORIGIN" "$d/c"; cd "$d/c"
bun --no-env-file -e '
const fs = require("node:fs"); const p = "factory-loop.sh"; const s = fs.readFileSync(p, "utf8");
fs.writeFileSync(p, s.replace("set -uo pipefail\n", () => "set -uo pipefail\necho \"RELOADED pid=$$ args=$*\" >> \"$LOOP_LOG\"\n"));'
git -c user.email=t@t -c user.name=t commit -qam "new loop" && git push -q origin HEAD:main
`;

function setup(): [string, string, Env] {
  const [d, work] = loopRepo();
  writeExe(join(d, "bin", "claude"), CLAUDE);
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, LOOP_LOG: join(d, "log"),
    LOOP_STATE: join(d, "state"), LOOP_ORIGIN: join(d, "origin.git") };
  for (const k of ["FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR"]) delete env[k];
  return [d, work, env];
}

test("loop restarts itself with the new script on main", async () => {
  const [, work, env] = setup();
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const p = Bun.spawn(["bash", "./factory-loop.sh", "3"], { cwd: work, env: clean, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const log = read(env.LOOP_LOG as string).split("\n");
  expect(p.exitCode, out + err).toBe(0);
  expect(out + err).toContain("the factory loop changed on main: restarting with the new version");
  expect(log).toContain(`RELOADED pid=${p.pid} args=2`); // same process; 3 tasks allowed, 1 done
  expect(log.filter((l) => l.startsWith("factory_claims.ts checkout")).length).toBe(1); // kept its agent and folder
  expect(log.filter((l) => l.startsWith("claude ")).length).toBe(1); // the task ran once
  expect(log.filter((l) => l.startsWith("factory_agents.ts down")).length).toBe(1); // down only at the real exit
});

test("loop without changes does not restart", () => {
  const [d, work, env] = setup();
  writeExe(join(d, "bin", "claude"), '#!/usr/bin/env bash\necho "claude $*" >> "$LOOP_LOG"\n');
  const out = sh(["bash", "./factory-loop.sh", "3"], { cwd: work, env, timeoutMs: 60_000 }).stdout;
  expect(out).not.toContain("restarting");
  expect(read(env.LOOP_LOG as string).split("\n").some((l) => l.startsWith("RELOADED"))).toBe(false);
});
