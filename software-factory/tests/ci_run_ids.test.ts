// `factory ci status --json` gives each run its GitHub id (#396), which the web UI's CI channel names a run by.
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CI, envWith, git, sh, tmp, write } from "./support.ts";

type Obj = Record<string, unknown>;

const STATUS_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log("acme/Widget"); process.exit(0); }
if (a[0] !== "api") { console.error("no answer"); process.exit(1); }
const path = a.filter((x) => !x.startsWith("-"))[1] ?? "";
const p = path.split("?")[0];
if (p.includes("/actions/variables/")) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
const created = new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const data: Record<string, unknown> = {
  "repos/acme/Widget": { default_branch: "main" },
  "repos/acme/Widget/actions/runs": { workflow_runs: [
    { id: 777001, head_branch: "main", status: "completed", conclusion: "failure", created_at: created, name: "CI" },
    { id: 777002, head_branch: "feat", status: "queued", conclusion: null, created_at: created, name: "CI" } ] },
  "repos/acme/Widget/pulls": [{ number: 12, head: { ref: "feat" } }],
  "repos/acme/Widget/actions/runners": { runners: [] },
};
if (!(p in data)) { console.error("no answer for " + p); process.exit(1); }
console.log(JSON.stringify(data[p]));
`;

test("factory ci status --json gives each run its GitHub run id", () => {
  const root = tmp();
  const d = join(root, "work");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const x of [d, bin, home]) mkdirSync(x);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  git(d, "remote", "add", "origin", "git@github.com:acme/Widget.git");
  write(join(d, ".claude", "factory.json"), "{}");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "x");
  write(join(bin, "gh"), STATUS_GH, 0o755);
  const env = envWith(bin, { HOME: home, XDG_STATE_HOME: undefined });
  const p = sh(["bash", join(CI, "ci.sh"), "status", "--json"], { cwd: d, env, timeoutMs: 120_000 });
  expect(p.code, p.out).toBe(0);
  const j = JSON.parse(p.stdout) as { runs: Obj[] };
  expect(j.runs.map((r) => [r.ref, r.id])).toEqual([["main", 777001], ["#12", 777002]]);
}, 60_000);
