// The pull request watcher's GitHub side and its events (factory_pr_feed.ts; the board's end of it is in
// bus_pr_feed.test.ts): it asks with the ETag of the last answer, so an unchanged list comes back as
// 304 Not Modified and is answered from what it kept; and it says each change once.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, runCode, tmp, writeExe } from "./support.ts";
import { changes } from "../hooks/factory_pr_feed.ts";
import type { PrSnapshot, PrState } from "../hooks/core/ports/messaging.ts";

// A gh that answers `gh api -i` with headers: an ETag, and 304 when If-None-Match names it. Each call is logged with
// the status it got.
const GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const a = process.argv.slice(2);
const sent = a.find((x) => x.startsWith("If-None-Match: "))?.slice(15) ?? "";
const etag = 'W/"' + readFileSync(process.env.FAKE_VERSION, "utf8").trim() + '"';
const status = sent === etag ? 304 : 200;
appendFileSync(process.env.LOOP_LOG, status + "\n");
if (status === 304) { process.stdout.write("HTTP/2.0 304 Not Modified\r\nEtag: " + etag + "\r\n\r\n"); console.error("gh: HTTP 304"); process.exit(1); }
process.stdout.write("HTTP/2.0 200 OK\r\nEtag: " + etag + "\r\n\r\n" + JSON.stringify([{ number: 7, v: readFileSync(process.env.FAKE_VERSION, "utf8").trim() }]));
`;

test("a conditional read sends the last ETag: unchanged is a 304 answered from what was kept, changed is read anew", () => {
  const d = tmp();
  writeExe(join(d, "bin", "gh"), GH);
  const version = join(d, "version");
  writeFileSync(version, "1");
  const code = `
    import { getConditional } from ${JSON.stringify(join(HOOKS, "factory_pr_feed.ts"))};
    const state = { paths: {}, headAt: {} };
    const read = () => JSON.stringify(getConditional("repos/{owner}/{repo}/pulls?state=open", state, new Set()));
    const out = [read(), read()];
    await Bun.write(${JSON.stringify(version)}, "2");
    out.push(read(), read());
    console.log(out.join("\\n"));`;
  const env = { ...process.env, PATH: `${join(d, "bin")}:${process.env.PATH}`, LOOP_LOG: join(d, "log"), FAKE_VERSION: version };
  const r = runCode(code, { cwd: d, env });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.trim().split("\n")).toEqual([
    '[{"number":7,"v":"1"}]', '[{"number":7,"v":"1"}]', '[{"number":7,"v":"2"}]', '[{"number":7,"v":"2"}]']);
  expect(readFileSync(join(d, "log"), "utf8").trim().split("\n")).toEqual(["200", "304", "200", "304"]);
});

function state(n: number, o: Partial<PrState> = {}): PrState {
  return { number: n, title: "t", body: "", author: "me", draft: false, branch: `task/${n}-x`, base: "main", headRepo: "o/r",
    head: "a".repeat(40), headAt: null, labels: [], updated: "", mergeable: "clean", checks: "pending", runs: [], statuses: [], ...o };
}

function snap(prs: PrState[], closed: PrSnapshot["closed"] = []): PrSnapshot {
  return { v: 1, at: Date.parse("2026-11-06T10:00:00Z"), by: "lead", login: "me", repo: "o/r", prs, closed };
}

test("each change is one event; a first snapshot and an unchanged one say nothing", () => {
  const before = snap([state(5), state(6), state(7), state(8)]);
  expect(changes(null, before)).toEqual([]);
  expect(changes(before, snap([state(5), state(6), state(7), state(8)]))).toEqual([]);
  const after = snap([state(5, { head: "b".repeat(40) }), state(6, { checks: "green" }), state(8, { labels: ["factory-hold"], draft: true }),
    state(9)], [{ number: 7, merged: true, at: "2026-11-06T09:59:00Z" }]);
  expect(changes(before, after).map((e) => [e.pr, e.change, e.checks])).toEqual([
    [5, "head", "pending"], [6, "checks", "green"], [8, "labels", "pending"], [8, "draft", "pending"], [9, "opened", "pending"],
    [7, "merged", "pending"]]);
  expect(changes(before, snap([state(5), state(6), state(8)], [{ number: 7, merged: false, at: "" }])).map((e) => e.change))
    .toEqual(["closed"]);
});
