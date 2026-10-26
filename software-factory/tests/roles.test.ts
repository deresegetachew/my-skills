// Generic roles (#102): `factory <role> [name] loop [-i] [--once] [--dry-run]`, one loop runner for the coding agent,
// the dev manager and the product owner, and the project's role folder.
//
// Runs the real factory, factory-loop.sh and hooks in a throwaway project (a bare origin and a clone) with a fake
// `claude` (logs its arguments) and a fake `gh` (a JSON file). Waits are 0 minutes.
// (The `factory doctor` test stays in test_roles.py until factory_doctor is ported.)
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCalls, type Env, factory, log, porcelain, project, type Row } from "./roles_support.ts";
import { HOOKS, runCode, write } from "./support.ts";

const UNREVIEWED = { pulls: [{ number: 5, title: "x", draft: false, head: { sha: "a".repeat(40) }, user: { login: "me" } }] };
const PO_WORK = { issues: [{ number: 7, title: "Pick the palette", labels: [{ name: "factory:needs-product" }] }] };

// --- done when 1: dry runs --------------------------------------------------------------------------------------------

test("dev manager dry run prints what it would do and writes nothing", () => {
  const [, work, env] = project({ db: UNREVIEWED });
  const p = factory(work, env, ["dev-manager", "lead", "loop", "--once", "--dry-run"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("[lead] dev-manager (dry run)");
  expect(p.stdout).toContain("PR #5: commit aaaaaaa not reviewed yet");
  expect(p.stdout).toContain("would run: claude");
  expect(p.stdout).toContain("/manage-pass");
  expect(claudeCalls(env), "a dry run must not start claude").toEqual([]);
  expect(existsSync(work + "-agents"), "a dry run must not create a worktree").toBe(false);
  expect(porcelain(work)).toBe("");
  // (the Python check's precedence: a gh line with -X POST, or any line with -X PATCH)
  expect(log(env).filter((l) => (l.startsWith("gh ") && l.includes("-X POST")) || l.includes("-X PATCH"))).toEqual([]);
});

test("dev manager dry run with nothing to do says so", () => {
  const [, work, env] = project({ db: {} });
  const p = factory(work, env, ["dev-manager", "loop", "--once", "--dry-run"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("nothing to do");
  expect(p.stdout).toContain("[lead]");
  expect(claudeCalls(env)).toEqual([]);
});

test("product owner dry run names the work and the skill", () => {
  const [, work, env] = project({ db: PO_WORK });
  const p = factory(work, env, ["product-owner", "loop", "--once", "--dry-run"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("[eleni] product-owner (dry run)");
  expect(p.stdout).toContain("issue #7: Pick the palette");
  expect(p.stdout).toContain("/product-pass");
  expect(claudeCalls(env)).toEqual([]);
  expect(existsSync(work + "-agents")).toBe(false);
});

// --- done when 2: the coding agent is unchanged ----------------------------------------------------------------------

test("factory loop and coding agent loop are the same thing", () => {
  const [, work, env] = project();
  const a = factory(work, env, ["loop", "--dry-run"]);
  const b = factory(work, env, ["coding-agent", "loop", "--dry-run"]);
  expect(a.code, a.stderr).toBe(0);
  expect(b.code, b.stderr).toBe(0);
  expect(a.stdout).toBe(b.stdout);
  expect(a.stdout).toContain("[menelik] coding-agent (dry run)");
  expect(a.stdout).toContain("next task: 1.1 First task");
  const c = factory(work, env, ["coding-agent", "taytu", "loop", "--dry-run"]);
  expect(c.stdout).toContain("[taytu] coding-agent (dry run)");
  const n = factory(work, env, ["coding-agent", "2", "loop", "--dry-run"]); // the second name
  expect(n.stdout).toContain("[taytu]");
});

test("a coding agent pass runs next task exactly as before", () => {
  const [, work, env] = project();
  const p = factory(work, env, ["loop", "1"]);
  expect(p.code, p.out).toBe(0);
  const calls = claudeCalls(env);
  expect(calls.length, calls.join("\n")).toBe(1);
  expect(calls[0]).toContain("-p /next-task 1.1");
  expect(calls[0]).toContain('--settings {"disableClaudeAiConnectors": true}');
  expect(calls[0]).not.toContain("--setting-sources"); // a builder keeps the project's settings
  expect(calls[0]).not.toContain("factory-role");
});

// --- a real pass of the other roles ---------------------------------------------------------------------------------

test("a product owner pass runs its skill in its own worktree with its profile", () => {
  const prof = { permissions: { allow: ["Bash(gh api *)"] } };
  const [, work, env] = project({ db: PO_WORK, cfg: { roles: { "product-owner": { names: ["eleni"], busyMinutes: 0,
    idleMinutes: 0, profile: ".claude/manager/settings.json" } } } });
  const p = factory(work, env, ["product-owner", "loop", "--once"]);
  expect(p.code, p.out).toBe(0);
  const calls = claudeCalls(env);
  expect(calls.length, calls.join("\n")).toBe(1);
  const c = calls[0] as string;
  expect(c).toContain("-p /product-pass");
  expect(c).toContain("<!-- factory-role role=product-owner name=eleni -->");
  expect(c).toContain("--setting-sources user");
  expect(c).toContain("Bash(gh api *)");
  expect(c).toContain("disableClaudeAiConnectors");
  expect(c).toContain("--strict-mcp-config");
  expect(existsSync(work + "-agents/eleni"), "the role works in its own worktree").toBe(true);
  expect(c).toContain(prof.permissions.allow[0] as string);
});

test("without work a pass starts no session", () => {
  const [, work, env] = project({ db: {} });
  const p = factory(work, env, ["product-owner", "loop", "--once"]);
  expect(p.code, p.out).toBe(0);
  expect(claudeCalls(env)).toEqual([]);
});

test("a role with no profile file keeps the default flags", () => {
  const [, work, env] = project({ db: PO_WORK }); // roles.product-owner.profile points at a file that does not exist
  factory(work, env, ["product-owner", "loop", "--once"]);
  const c = claudeCalls(env)[0] as string;
  expect(c).not.toContain("--setting-sources");
  expect(c).toContain('disableClaudeAiConnectors": true');
});

test("models setting reaches a product owner session", () => {
  const [, work, env] = project({ db: PO_WORK, cfg: { models: { "product-owner": { model: "opus", effort: "high" } } } });
  factory(work, env, ["product-owner", "loop", "--once"]);
  const c = claudeCalls(env)[0] as string;
  expect(c).toContain("--model opus");
  expect(c).toContain("--effort high");
});

/** A hook for the fake claude: takes the first issue off the fake GitHub, then runs `tail`. */
function popIssueHook(d: string, tail: string): string {
  const hook = join(d, "hook.sh");
  writeFileSync(hook, `bun --no-env-file -e 'const fs = require("node:fs"); const f = process.env.FAKE_DB; ` +
    `const db = JSON.parse(fs.readFileSync(f, "utf8")); db.issues.shift(); fs.writeFileSync(f, JSON.stringify(db));'\n${tail}`);
  return hook;
}

test("three failed passes in a row stop the loop", () => {
  // each failed run takes its issue off the list (the fake claude removes the label), so it is not "the same item"
  const db = { issues: [1, 2, 3, 4].map((n) => ({ number: n, title: `Q${n}`, labels: [{ name: "factory:needs-product" }] })) };
  const [d, work, env] = project({ db });
  env.FAKE_CLAUDE_HOOK = popIssueHook(d, "exit 1\n");
  const p = factory(work, env, ["product-owner", "loop"]);
  expect(p.code, p.out).toBe(1);
  expect(claudeCalls(env).length).toBe(3);
  expect(p.stdout).toContain("3 passes failed in a row");
});

test("a failed pass is logged and the loop carries on", () => {
  const db = { issues: [1, 2].map((n) => ({ number: n, title: `Q${n}`, labels: [{ name: "factory:needs-product" }] })) };
  const [d, work, env] = project({ db });
  env.FAKE_CLAUDE_HOOK = popIssueHook(d, '[ "$(grep -c "^claude" "$LOOP_LOG")" -gt 1 ] && exit 0; exit 1\n');
  const p = factory(work, env, ["product-owner", "loop", "2"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("the pass exited with an error");
  expect(claudeCalls(env).length).toBe(2);
});

test("the same item three times stops the loop", () => {
  const [, work, env] = project({ db: PO_WORK }); // the fake claude succeeds and the label stays: nothing changed
  const p = factory(work, env, ["product-owner", "loop"]);
  expect(p.code, p.out).toBe(1);
  expect(p.stdout).toContain("came up 3 times in a row");
  expect(claudeCalls(env).length).toBe(2);
});

// --- done when 3: two of a kind side by side --------------------------------------------------------------------------

test("two roles of one kind run side by side without a shared lock or log", async () => {
  const [d, work, env] = project({ db: PO_WORK });
  const hook = join(d, "hook.sh");
  // each session records itself and waits (up to 30 s) until the other is also running
  writeFileSync(hook, 'name=$(printf "%s" "$*" | sed -n "s/.*name=\\([a-z]*\\).*/\\1/p")\n' +
    'touch "$LOOP_LOG.$name"\n' +
    'for i in $(seq 1 150); do [ -e "$LOOP_LOG.eleni" ] && [ -e "$LOOP_LOG.sabla" ] && exit 0; sleep 0.2; done\nexit 1\n');
  env.FAKE_CLAUDE_HOOK = hook;
  const start = (name: string) => Bun.spawn(["bash", "-c", 'exec "$@" 2>&1', "_", "bash", "./factory", "product-owner", name, "loop", "--once"],
    { cwd: work, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const a = start("eleni");
  const b = start("sabla");
  const [oa, ob] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
  expect(await a.exited, oa).toBe(0);
  expect(await b.exited, ob).toBe(0);
  expect(existsSync(work + "-agents/eleni")).toBe(true);
  expect(existsSync(work + "-agents/sabla")).toBe(true);
  expect(oa).toContain("[eleni]");
  expect(ob).toContain("[sabla]");
  expect(oa).not.toContain("[sabla]");
}, 120_000);

test("a name belongs to one loop whatever its role", () => {
  const [, work, env] = project({ db: PO_WORK, cfg: { roles: { "dev-manager": { names: ["taytu"] } } } });
  const p = factory(work, env, ["dev-manager", "loop", "--once", "--dry-run"]);
  expect(p.code).toBe(0); // a dry run starts nothing
  const q = factory(work, env, ["dev-manager", "loop", "--once"]);
  expect(q.code, q.out).not.toBe(0);
  expect(q.out).toContain("coding agent's name");
});

// --- done when 4: settings and the role folder -----------------------------------------------------------------------

test("settings list the role settings", () => {
  const [, work, env] = project();
  const p = factory(work, env, ["settings"]);
  for (const key of ["roles.dir", "roles.dev-manager.names", "roles.product-owner.names", "manager.busyMinutes", "manager.idleMinutes"]) {
    expect(p.stdout, key).toContain(key);
  }
  const q = factory(work, env, ["settings", "show", "roles.dir"]);
  expect(q.stdout).toContain(".claude/factory/roles");
});

test("a missing role folder falls back to notes and a present one wins", () => {
  const [, work, env] = project({ files: { ".claude/factory/notes/manager.md": "watch the flaky job\n" } });
  const code = `import * as fr from ${JSON.stringify(join(HOOKS, "factory_roles.ts"))};
import { load } from ${JSON.stringify(join(HOOKS, "factory_config.ts"))};
const cfg = load();
const a = fr.prompt(cfg, "dev-manager", "lead");
const made = fr.init(cfg);
const b = fr.prompt(cfg, "dev-manager", "lead", "pr-5");
console.log(JSON.stringify([a, made, b]));`;
  const p = runCode(code, { cwd: work, env });
  expect(p.code, p.out).toBe(0);
  const [text, made, after] = JSON.parse(p.stdout) as [string, string[], string];
  expect(text.startsWith("/manage-pass"), text).toBe(true);
  expect(text).toContain(".claude/factory/notes/manager.md");
  expect(text).not.toContain("roles/dev-manager");
  expect(text.trimEnd().endsWith("<!-- factory-role role=dev-manager name=lead -->"), text).toBe(true);
  expect(made.length, made.join(", ")).toBe(6);
  expect(after.startsWith("/manage-pass pr-5"), after).toBe(true);
  expect(after).toContain(".claude/factory/roles/dev-manager/README.md");
  expect(after).toContain("reads.md");
  expect(after).not.toContain("notes/manager.md");
});

test("init roles scaffolds each role and never overwrites", () => {
  const [, work, env] = project({ files: { ".claude/factory/roles/dev-manager/README.md": "mine\n" } });
  const p = factory(work, env, ["init-roles"]);
  expect(p.code, p.stderr).toBe(0);
  const base = join(work, ".claude", "factory", "roles");
  for (const role of ["coding-agent", "dev-manager", "product-owner"]) {
    expect(existsSync(join(base, role, "README.md"))).toBe(true);
    expect(existsSync(join(base, role, "reads.md"))).toBe(true);
  }
  expect(readFileSync(join(base, "dev-manager", "README.md"), "utf8")).toBe("mine\n");
  const reads = readFileSync(join(base, "dev-manager", "reads.md"), "utf8");
  expect(reads).toContain("CLAUDE.md"); // the project's own documents that exist
  expect(reads).toContain("docs/build-plan.md");
  const again = factory(work, env, ["init-roles"]);
  expect(again.stdout).toContain("already has them");
});

test("reads md lines name a path a section and a reason", async () => {
  const fr = await import("../hooks/factory_roles.ts");
  const got = fr.parseReads("# head\n\n- CLAUDE.md - rules\n* `docs/PRD.md#user-stories` - the stories\ndesign/STYLE.md  voice\n");
  expect(got).toEqual([["CLAUDE.md", "", "rules"], ["docs/PRD.md", "user-stories", "the stories"], ["design/STYLE.md", "", "voice"]]);
});

// --- `factory loop -i` with no role asks ------------------------------------------------------------------------------

/** Runs `factory <args>` on a pseudo-terminal, typing `answers`: [exit code, everything it showed]. */
async function runOnATerminal(work: string, env: Env, args: string[], answers: string): Promise<[number, string]> {
  let shown = "";
  const p = Bun.spawn(["bash", "./factory", ...args], {
    cwd: work, env: env as Record<string, string>,
    terminal: { cols: 200, rows: 50, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  if (answers) p.terminal?.write(answers);
  const timer = setTimeout(() => p.kill(9), 60_000);
  const code = await p.exited;
  clearTimeout(timer);
  await Bun.sleep(50);
  p.terminal?.close();
  return [code, shown];
}

test("loop dash i on a terminal asks for a role and a name", async () => {
  const [, work, env] = project({ db: PO_WORK });
  const [rc, shown] = await runOnATerminal(work, env, ["loop", "-i", "--dry-run"], "3\nsabla\n");
  expect(rc, shown).toBe(0);
  expect(shown).toContain("Which role?");
  expect(shown).toContain("product owner");
  expect(shown).toContain("Which name?");
  expect(shown).toContain("[sabla] product-owner (dry run)");
}, 90_000);

test("loop dash i on a terminal takes the first free name on enter", async () => {
  const [, work, env] = project();
  const [rc, shown] = await runOnATerminal(work, env, ["loop", "-i", "--dry-run"], "2\n\n");
  expect(rc, shown).toBe(0);
  expect(shown).toContain("[lead] dev-manager (dry run)");
}, 90_000);

test("a role word or the env skips the question", async () => {
  const [, work, env] = project();
  let [rc, shown] = await runOnATerminal(work, env, ["loop", "-i", "dev-manager", "--dry-run"], "");
  expect(rc, shown).toBe(0);
  expect(shown).toContain("[lead] dev-manager (dry run)");
  expect(shown).not.toContain("Which role?");
  [rc, shown] = await runOnATerminal(work, { ...env, FACTORY_ROLE: "product-owner" }, ["loop", "-i", "--dry-run"], "");
  expect(rc, shown).toBe(0);
  expect(shown).toContain("product-owner (dry run)");
  expect(shown).not.toContain("Which role?");
}, 90_000);

test("unattended loop never asks and stays a coding agent", () => {
  const [, work, env] = project();
  const p = factory(work, env, ["loop", "-i", "--dry-run"]); // -i, but stdin is not a terminal
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("coding-agent (dry run)");
  expect(p.out).not.toContain("Which role?");
});

// --- usage by role -----------------------------------------------------------------------------------------------------

test("usage by role separates the sessions by the marker in their first prompt", () => {
  const [d, work, env] = project();
  const real = realpathSync(work);
  const slug = [...real].map((c) => (/[A-Za-z0-9]/.test(c) ? c : "-")).join("");
  const logs = join(d, ".claude", "projects", slug);
  mkdirSync(logs, { recursive: true });
  const session = (name: string, prompt: unknown, outTokens: number): void => {
    const rows: Row[] = [{ type: "user", message: { role: "user", content: prompt }, timestamp: "2026-10-25T09:00:00Z" },
      { type: "assistant", timestamp: "2026-10-25T09:00:05Z", gitBranch: "main", cwd: real,
        message: { id: "m-" + name, model: "sonnet", usage: { input_tokens: 10, output_tokens: outTokens,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
    write(join(logs, name + ".jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };
  session("a", "/manage-pass\n\n<!-- factory-role role=dev-manager name=lead -->", 111);
  session("b", [{ type: "text", text: "/product-pass\n<!-- factory-role role=product-owner name=eleni -->" }], 222);
  session("c", "/next-task 1.1", 333);
  const p = factory(work, env, ["usage", "--by", "role", "--since", "2026-10-24", "--until", "2026-10-26", "--json"]);
  expect(p.code, p.out).toBe(0);
  const groups = (JSON.parse(p.stdout) as { groups: Record<string, { tokens: { output: number } }> }).groups;
  const got: Record<string, number> = {};
  for (const [k, v] of Object.entries(groups)) got[k] = v.tokens.output;
  expect(got).toEqual({ manager: 111, "product-owner": 222, builder: 333 });
});
