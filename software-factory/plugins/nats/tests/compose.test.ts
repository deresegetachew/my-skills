// The composition root with `messaging.transport: "nats"` (#409, decision 0004 point 3 and 5): `factory messages ls`
// reads NATS and GitHub together when the server answers; when it doesn't, the command goes on over GitHub and says
// nats-unreachable once (fallback "github", the default), or stops with it (fallback "none").
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Message } from "../../../hooks/core/domain/message.ts";
import { runHook, sh, tmp, write, writeExe } from "../../../tests/support.ts";
import { createMessaging } from "../index.ts";
import { MISSING, NATS_SERVER, type Server, startServer } from "./server.ts";

let server: Server | null = null;
beforeAll(async () => {
  if (NATS_SERVER) server = await startServer();
});
afterAll(() => server?.stop());

const FAKE_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
const path = a.slice(1).filter((x) => !x.startsWith("-") && !["GET", "Accept: application/vnd.github+json"].includes(x))[0] as string;
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1); const page = Number(u.searchParams.get("page") ?? "1");
const item = { number: 7, title: "t", state: "open", comments: 1, labels: [], html_url: "https://github.test/r/7", body: "" };
const note = { id: 1, body: "<!-- factory-msg v=1 id=01abc23def kind=question from=haile to=po state=submitted ref=issue#7 -->\nWhich colour?",
  user: { login: "me" }, created_at: "2026-10-25T10:00:00Z", html_url: "https://github.test/c/1" };
const out = (x: unknown) => { process.stdout.write(JSON.stringify(x) + "\n"); process.exit(0); };
if (a[0] === "api" && p === "issues") out(page === 1 ? [item] : []);
if (a[0] === "api" && p === "issues/7/comments") out(page === 1 ? [note] : []);
if (a[0] === "api" && p === "issues/7") out(item);
process.stderr.write("fake gh: no route for " + a.join(" ") + "\n");
process.exit(1);
`;

/** A project whose origin is github.com/o/<repo> (its NATS project name), with `messaging` set, and `factory messages
 * ls` run in it against the fake gh. */
function ls(repo: string, messaging: unknown) {
  const d = tmp();
  sh(["git", "init", "-q", d]);
  sh(["git", "-C", d, "remote", "add", "origin", `git@github.com:o/${repo}.git`]);
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ messaging }));
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, HOME: d };
  delete env.FACTORY_AGENT;
  return runHook("factory_messages", ["ls", "--fresh"], { cwd: d, env, timeoutMs: 60_000 });
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const DOWN = "nats://127.0.0.1:9";

if (!NATS_SERVER) {
  test.skip(MISSING, () => {});
} else {
  test("transport nats with a server that answers lists NATS and GitHub messages together, with no notice", () => {
    createMessaging({ url: (server as Server).url, project: "shop" }).send(new Message({ id: "n1abc", kind: "question",
      frm: "abebe", to: "po", state: "submitted", ref: "issue#8" }), "Over NATS?");
    const p = ls("Shop", { transport: "nats", url: (server as Server).url, kinds: ["question"] });
    expect(p.code, p.out).toBe(0);
    expect(p.stdout).toContain("haile"); // GitHub's
    expect(p.stdout).toContain("Over NATS?"); // NATS's
    expect(p.stderr).not.toContain("nats-unreachable");
    expect(p.stderr).not.toContain("plugin-");
  });
}

test("transport nats with no server goes on over GitHub and says nats-unreachable once", () => {
  const base = ls("shop", { transport: "github" });
  const p = ls("shop", { transport: "nats", url: DOWN });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toBe(base.stdout);
  expect(count(p.stderr, "nats-unreachable")).toBe(1);
  expect(p.stderr).toContain(DOWN);
});

test("transport nats with no server and fallback none stops with nats-unreachable", () => {
  const p = ls("shop", { transport: "nats", url: DOWN, fallback: "none" });
  expect(p.code).not.toBe(0);
  expect(p.out).toContain("nats-unreachable");
  expect(p.stdout).not.toContain("haile");
});
