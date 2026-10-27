// Per-machine agent names and a machine id in claims and agent pings (#45).
// (test_the_report_reads_claims_with_a_machine is in report.test.ts.)
import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { checkout as takeCheckout, project } from "./claims_support.ts";
import { agents, type Env, type IssueRow, issue, labels, loadDb, run, saveDb, setup } from "./issues_support.ts";
import { setup as loopSetup } from "./loop_support.ts";
import { read, runHook, sh, tmp, write, writeExe } from "./support.ts";

const loops: { kill(): void }[] = [];
afterAll(() => loops.forEach((l) => l.kill()));

function withMachine(env: Env, machine: string, extra: Record<string, string> = {}): Env {
  return { ...env, FACTORY_MACHINE_ID: machine, ...extra };
}

function claimsIn(db: string, n: number): string[] {
  return (loadDb(db).comments?.[String(n)] ?? []).map((c) => c.body);
}

function checkout(clone: string, configDir: string, machine: string, names?: string) {
  const [p, l] = takeCheckout(clone, names, { FACTORY_CONFIG_DIR: configDir, FACTORY_MACHINE_ID: machine });
  loops.push(l);
  return p;
}

// --- per-machine names -------------------------------------------------------------------------------------------

test("each machine takes names from its own config file", () => {
  const names: Record<string, string> = {};
  for (const [machine, mine] of [["aaaa1111", ["menelik", "taytu"]], ["bbbb2222", ["haile", "tewodros"]]] as const) {
    const clone = project(); // same factory.json, a different machine each
    const cfgdir = tmp();
    write(join(cfgdir, "proj.json"), JSON.stringify({ agents: mine }));
    const p = checkout(clone, cfgdir, machine);
    expect(p.code, p.out).toBe(0);
    names[machine] = p.stdout.split(/\s+/)[0] as string;
  }
  expect(names).toEqual({ aaaa1111: "menelik", bbbb2222: "haile" });
});

test("the environment beats the config file and an unknown name is refused", () => {
  const clone = project();
  const cfgdir = tmp();
  write(join(cfgdir, "proj.json"), JSON.stringify({ agents: ["menelik"] }));
  let p = checkout(clone, cfgdir, "aaaa1111", "tewodros");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split(/\s+/)[0]).toBe("tewodros");
  write(join(cfgdir, "proj.json"), JSON.stringify({ agents: ["nobody"] }));
  p = checkout(clone, cfgdir, "aaaa1111");
  expect(p.code).not.toBe(0);
  expect(p.stderr).toContain("nobody");
});

test("without any machine config names are as before", () => {
  const p = checkout(project(), tmp(), "aaaa1111");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split(/\s+/)[0]).toBe("menelik");
});

test("a machine id is made once and kept", () => {
  const cfgdir = tmp();
  const env: Env = { ...process.env, FACTORY_CONFIG_DIR: cfgdir };
  delete env.FACTORY_MACHINE_ID;
  const ids = new Set([0, 1].map(() => runHook("factory_machine", ["id"], { env }).stdout.trim()));
  expect(ids.size).toBe(1);
  expect(([...ids][0] as string).length).toBeGreaterThanOrEqual(8);
  expect(existsSync(join(cfgdir, "machine-id"))).toBe(true);
});

// --- claims carry the machine ------------------------------------------------------------------------------------

test("a claim says which machine made it", () => {
  const [d, db, env] = setup([issue(1)]);
  expect(run(d, withMachine(env, "mach-a"), "pick", "--agent", "menelik")[1]).toBe("issue-1 Task 1");
  expect(claimsIn(db, 1)[0]).toContain("<!-- factory-claim agent=menelik machine=mach-a -->");
});

test("same name on two machines exactly one wins", () => {
  const [d, db, env] = setup([issue(1), issue(2)]);
  let state = loadDb(db);
  state.comments = { 1: [{ body: "<!-- factory-claim agent=menelik machine=mach-a -->", at: 0 }] };
  saveDb(db, state);
  expect(run(d, withMachine(env, "mach-b"), "pick", "--agent", "menelik")[1]).toBe("issue-2 Task 2"); // mach-b lost #1
  // the shared agent:menelik label is the winner's: the loser must not strip it from #1
  expect(labels(db, 1)).toEqual(["agent:menelik", "factory:in-progress"]);
  // and the first machine still wins it
  state = loadDb(db);
  (state.issues[0] as IssueRow).labels = [{ name: "factory:in-progress" }, { name: "agent:menelik" }];
  saveDb(db, state);
  expect(run(d, withMachine(env, "mach-a"), "pick", "--agent", "menelik")[1]).toBe("issue-1 Task 1");
});

test("an old claim without a machine still counts as before", () => {
  let [d, db, env] = setup([issue(1), issue(2)]);
  let state = loadDb(db);
  state.comments = { 1: [{ body: "<!-- factory-claim agent=taytu -->", at: 0 }] };
  saveDb(db, state);
  expect(run(d, withMachine(env, "mach-b"), "pick", "--agent", "menelik")[1]).toBe("issue-2 Task 2");
  [d, db, env] = setup([issue(1)]);
  state = loadDb(db);
  state.comments = { 1: [{ body: "<!-- factory-claim agent=menelik -->", at: 0 }] };
  saveDb(db, state);
  expect(run(d, withMachine(env, "mach-b"), "pick", "--agent", "menelik")[1]).toBe("issue-1 Task 1"); // as today
});

test("an agent never resumes an issue claimed from another machine", () => {
  let [d, db, env] = setup([issue(1, ["factory:in-progress", "agent:menelik"]), issue(2)]);
  const state = loadDb(db);
  state.comments = { 1: [{ body: "<!-- factory-claim agent=menelik machine=mach-a -->", at: 0 }] };
  saveDb(db, state);
  expect(run(d, withMachine(env, "mach-b"), "pick", "--agent", "menelik")[1]).toBe("issue-2 Task 2");
  expect(run(d, withMachine(env, "mach-a"), "pick", "--agent", "menelik")[1]).toBe("issue-1 Task 1");
  // an in-progress issue with no machine in its claim is resumed by the name, as today
  [d, db, env] = setup([issue(1, ["factory:in-progress", "agent:menelik"])]);
  expect(run(d, withMachine(env, "mach-b"), "pick", "--agent", "menelik")[1]).toBe("issue-1 Task 1");
});

// --- agent issues ------------------------------------------------------------------------------------------------

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function agentIssue(n: number, name: string, ping: string, machine: string | null = null, status = "idle", state = "open"): IssueRow {
  const m = machine ? ` machine=${machine}` : "";
  const body = `<!-- factory-agent name=${name} status=${status} ping=${ping}${m} -->\n**Started:** x\n**Where:** y`;
  return { number: n, title: `Agent: ${name} · ${status}`, body, state, labels: [{ name: "factory:agent" }], milestone: null,
    updated_at: "2020-01-01T00:00:00Z" };
}

function register(d: string, env: Env, machine: string, agent = "menelik"): [number, string] {
  return agents(d, withMachine(env, machine), "register", "--agent", agent);
}

test("register is refused while another machine has that name live", () => {
  const [d, db, env] = setup([agentIssue(1, "menelik", ago(2), "mach-a")]);
  const p = runHook("factory_agents", ["register", "--agent", "menelik"], { cwd: d, env: withMachine(env, "mach-b") });
  expect(p.code, p.out).toBe(3);
  const lines = p.stderr.trim().split("\n");
  const err = JSON.parse(lines[lines.length - 1] as string) as Record<string, string>;
  expect(Object.keys(err).sort()).toEqual(["code", "fix", "message"]);
  expect(err.code).toBe("agent-name-in-use");
  expect(JSON.stringify(loadDb(db).issues)).not.toContain("mach-b"); // register must not touch the issue
  expect(loadDb(db).issues[0]?.body).toContain("machine=mach-a");
});

test("register goes ahead when the name is ours down silent or from an old kit", () => {
  for (const issues of [[agentIssue(1, "menelik", ago(2), "mach-b")], // ours
    [agentIssue(1, "menelik", ago(2), "mach-a", "down")],
    [agentIssue(1, "menelik", ago(90), "mach-a")], // silent past downMinutes
    [agentIssue(1, "menelik", ago(2))], // an old ping, no machine
    []]) {
    const [d, db, env] = setup(issues);
    const [rc, out] = register(d, env, "mach-b");
    expect(rc, out).toBe(0);
    expect(loadDb(db).issues[0]?.body).toContain("machine=mach-b");
  }
});

test("the ping marker has the machine and the hostname only with show where", () => {
  const [d, db, env] = setup([]);
  register(d, env, "mach-b");
  let body = loadDb(db).issues[0]?.body as string;
  expect(body).toContain("machine=mach-b");
  expect(body).not.toContain(hostname());
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues", showWhere: true }, agents: ["menelik"] }));
  agents(d, withMachine(env, "mach-b"), "ping", "--agent", "menelik", "--force");
  body = loadDb(db).issues[0]?.body as string;
  expect(body).toContain(hostname());
});

test("list and sweep still read markers with and without a machine", () => {
  const [d, , env] = setup([agentIssue(1, "menelik", ago(2), "mach-a"), agentIssue(2, "taytu", ago(3))]);
  const [, out] = agents(d, withMachine(env, "mach-b"), "list");
  for (const w of ["menelik", "taytu", "mach-a"]) expect(out).toContain(w);
  expect(agents(d, env, "sweep")[1]).toBe("");
});

test("machine setup refuses a name that is live on another machine", () => {
  const [d, , env0] = setup([agentIssue(1, "menelik", ago(2), "mach-a")]);
  const cfgdir = tmp();
  const env = withMachine(env0, "mach-b", { FACTORY_CONFIG_DIR: cfgdir });
  let p = runHook("factory_machine", ["setup", "menelik,taytu"], { cwd: d, env });
  expect(p.code, p.out).toBe(1);
  let lines = p.stderr.trim().split("\n");
  const err = JSON.parse(lines[lines.length - 1] as string) as Record<string, string>;
  expect(err.code).toBe("agent-name-in-use");
  expect(err.message).toContain("menelik");
  expect(err.fix).toBeTruthy();
  expect(readdirSync(cfgdir)).toEqual([]); // nothing is written when a name is refused
  p = runHook("factory_machine", ["setup", "taytu"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  const key = basename(realpathSync(d));
  expect(JSON.parse(read(join(cfgdir, `${key}.json`)))).toEqual({ agents: ["taytu"] });
  p = runHook("factory_machine", ["setup", "nobody"], { cwd: d, env });
  expect(p.code).toBe(1);
  lines = p.stderr.trim().split("\n");
  expect((JSON.parse(lines[lines.length - 1] as string) as Record<string, string>).code).toBe("unknown-agent");
});

test("a loop whose name is live elsewhere stops and does not mark that agent down", () => {
  const [work, env] = loopSetup();
  const stub = '#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\n' +
    'appendFileSync(process.env.LOOP_LOG as string, "factory_agents.ts " + process.argv.slice(2).join(" ") + "\\n");\n' +
    'if (process.argv[2] === "register") {\n' +
    '  process.stderr.write(\'{"code": "agent-name-in-use", "message": "solo runs elsewhere", "fix": "x"}\\n\');\n' +
    "  process.exit(3);\n}\n";
  writeExe(join(work, ".claude", "hooks", "factory_agents.ts"), stub);
  const p = sh(["bash", "./factory-loop.sh"], { cwd: work, env, timeoutMs: 60_000 });
  const log = read(env.LOOP_LOG as string);
  expect(p.code, p.out).toBe(1);
  expect(p.stderr).toContain("agent-name-in-use");
  expect(log).not.toContain("next_task.ts"); // no task is claimed
  expect(log).not.toContain("factory_agents.ts down"); // the other machine's agent must not be marked down
  expect(log).toContain("factory_claims.ts release"); // this clone's checkout is let go
});
