// `factory messages ls` on GitHub (#473): a thread's comments are fetched again only when its issue's updated_at or
// comments count changed since the last read; otherwise they come from a cache in the project's state folder. Run
// against a fake `gh` that reads a JSON file and logs every call.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRepo, runHook, tmp, write, writeExe } from "./support.ts";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
type Row = Record<string, any>;
const db: Row = JSON.parse(readFileSync(process.env.FAKE_DB as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG as string, a.join(" ") + "\n");
function fail(t: string): never { process.stderr.write(t + "\n"); process.exit(1); }
if (a[0] !== "api") fail("fake gh: only gh api");
const path = a.slice(1).filter((x) => !x.startsWith("-") && !["GET", "Accept: application/vnd.github+json"].includes(x))[0] as string;
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1); const q = u.searchParams; const page = Number(q.get("page") ?? "1");
function out(x: unknown): never { process.stdout.write(JSON.stringify(x) + "\n"); process.exit(0); }
function paged(x: unknown[]): never { out(page === 1 ? x : []); }
if (p === "issues") paged(db.items.filter((i: Row) => i.state === (q.get("state") ?? "open")));
const m = /^issues\/(\d+)\/comments$/.exec(p);
if (m) paged((db.comments ?? {})[m[1] as string] ?? []);
fail("fake gh: no route for " + p);
`;

type Row = Record<string, any>;

function issue(n: number, comments: number, updated: string): Row {
  return { number: n, title: "t" + n, state: "open", comments, labels: [], html_url: `https://github.test/r/${n}`, body: "",
    updated_at: updated };
}

function comment(id: number, text: string): Row {
  return { id, body: `<!-- factory-msg v=1 id=${text} kind=question from=haile to=dev-manager state=submitted -->\nWhy ${text}?`,
    user: { login: "me" }, created_at: "2026-10-25T10:00:00Z", html_url: `https://github.test/c/${id}` };
}

interface World { d: string; env: Record<string, string | undefined>; db: Row; save: () => void }

function world(): World {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), "{}");
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "home"));
  const db: Row = {
    items: [issue(1, 1, "2026-10-25T10:00:00Z"), issue(2, 1, "2026-10-25T10:05:00Z")],
    comments: { "1": [comment(11, "qone")], "2": [comment(21, "qtwo")] },
  };
  const w: World = { d, db, save: () => writeFileSync(join(root, "db.json"), JSON.stringify(db)),
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FAKE_DB: join(root, "db.json"), FAKE_LOG: join(root, "log"),
      XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), HOME: join(root, "home"), FACTORY_AGENT: undefined,
      FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENTS: undefined, FACTORY_CONFIG_DIR: undefined } };
  w.save();
  writeFileSync(join(root, "log"), "");
  return w;
}

/** One `factory messages ls --kind all --all --json --fresh`: its rows and the gh calls it made. */
function ls(w: World): { rows: Row[]; calls: string[] } {
  const log = w.env.FAKE_LOG as string;
  writeFileSync(log, "");
  const r = runHook("factory_messages", ["ls", "--kind", "all", "--all", "--json", "--fresh"], { cwd: w.d, env: w.env, timeoutMs: 60_000 });
  expect(r.code, r.out).toBe(0);
  return { rows: JSON.parse(r.stdout) as Row[], calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

const commentCalls = (calls: string[]): string[] => calls.filter((c) => /issues\/\d+\/comments/.test(c));
const ids = (rows: Row[]): string[] => rows.map((r) => String(r.id)).sort();

test("a second read of unchanged issues lists them but fetches no comments, and prints the same rows", () => {
  const w = world();
  const first = ls(w);
  expect(ids(first.rows)).toEqual(["qone", "qtwo"]);
  expect(commentCalls(first.calls).length, first.calls.join("\n")).toBe(2);
  const second = ls(w);
  expect(second.calls.some((c) => /issues\?/.test(c) || /\bissues$/.test(c)), second.calls.join("\n")).toBe(true);
  expect(commentCalls(second.calls)).toEqual([]);
  expect(second.rows).toEqual(first.rows);
}, 120_000);

test("an issue whose updated_at changed has its comments fetched again, and only that one; the new message shows", () => {
  const w = world();
  ls(w);
  ls(w);
  w.db.items[1].updated_at = "2026-10-25T11:00:00Z";
  w.db.items[1].comments = 2;
  w.db.comments["2"].push(comment(22, "qnew"));
  w.save();
  const third = ls(w);
  expect(commentCalls(third.calls).length, third.calls.join("\n")).toBe(1);
  expect(commentCalls(third.calls)[0]).toMatch(/issues\/2\/comments/);
  expect(ids(third.rows)).toEqual(["qnew", "qone", "qtwo"]);
  const fourth = ls(w); // and then it is cached again
  expect(commentCalls(fourth.calls)).toEqual([]);
  expect(ids(fourth.rows)).toEqual(["qnew", "qone", "qtwo"]);
}, 120_000);

test("a changed comments count with the same updated_at fetches that issue's comments again", () => {
  const w = world();
  ls(w);
  w.db.items[0].comments = 2;
  w.db.comments["1"].push(comment(12, "qlate"));
  w.save();
  const again = ls(w);
  expect(commentCalls(again.calls).length, again.calls.join("\n")).toBe(1);
  expect(commentCalls(again.calls)[0]).toMatch(/issues\/1\/comments/);
  expect(ids(again.rows)).toEqual(["qlate", "qone", "qtwo"]);
}, 120_000);
