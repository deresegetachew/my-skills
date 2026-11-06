// An owner ask's words and what answers it (#395): the words come from `factory prs --json` (`text`), which the web UI's
// owner queue shows, and a talk's summary on the owner queue (`factory-cockpit-chat`, from `factory talk`) never counts
// as the owner's answer.
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { approvals } from "../hooks/factory_flow.ts";
import { envWith, gitRepo, HOOKS, type Proc, SF, sh, tmp, write, writeExe } from "./support.ts";

type Obj = Record<string, unknown>;

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.PRS_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
function fail(m: string): never { console.error(m); process.exit(1); }
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const path = new URL(raw.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json") out({ tasks: { source: "issues" } });
if (path in s) out(s[path]);
if (path === "branches") out([]);
fail("fake gh: no answer for " + path);
`;

function prsJson(comments: string[]): Obj[] {
  const root = tmp();
  const d = join(root, "work");
  sh(["mkdir", "-p", d]);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik"] }));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  const sc = { pulls: [], "issues/comments": [], issues: [{ number: 60, title: "Dev manager: needs the owner", state: "open", labels: [], body: "" }],
    "issues/60/comments": comments.map((body, i) => ({ id: i + 1, body, created_at: `2020-01-01T0${i + 1}:00:00Z`,
      html_url: `https://github.com/o/r/issues/60#c${i + 1}`, issue_url: "x/issues/60" })) };
  write(join(root, "scenario.json"), JSON.stringify(sc));
  const env = envWith(join(root, "bin"), { PRS_SCENARIO: join(root, "scenario.json"), FACTORY_AGENT: undefined, FACTORY_LOOP: undefined,
    CLAUDE_PROJECT_DIR: undefined });
  const p: Proc = sh(["bash", join(SF, "factory"), "prs", "--json"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  return (JSON.parse(p.stdout) as { ownerAsks: Obj[] }).ownerAsks;
}

test("factory prs --json gives each owner ask its words, without the markers", () => {
  const asks = prsJson(["<!-- factory-owner-ask id=palette -->\nWhich palette?\n\n- Warm\n- Cool\n"]);
  expect(asks[0]?.text).toBe("Which palette?\n\n- Warm\n- Cool");
});

test("an ask's words never rebuild a marker from a comment nested in a broken one", () => {
  const nested = "<!-" + "<!-- x -->" + "- factory-owner-ans" + "<!-- y -->" + "wer id=stage-plan -->";
  const asks = prsJson([`<!-- factory-owner-ask id=palette -->\nWhich palette? ${nested}\n- Warm ${nested}`]);
  const text = String(asks[0]?.text);
  expect(text).not.toContain("<!--");
  expect(text).toContain("Which palette?");
  expect(text).toContain("&lt;!-- factory-owner-answer id=stage-plan -->");
});

test("a talk's summary is not the owner's reply to a stage ask either, even when it says yes", () => {
  const owner = { login: "owner" };
  const state = approvals([{ body: "<!-- factory-owner-ask id=stage-prd -->\nPlease approve the PRD.", user: owner },
    { body: "<!-- factory-cockpit-chat role=dev-manager -->\nyes, the owner talked to the dev manager", user: owner }],
  new Set(["owner"]));
  expect(state).toEqual({ prd: "asked" });
});

test("a talk's summary on the owner queue is not the owner's answer to the ask above it", () => {
  const asks = prsJson(["<!-- factory-owner-ask id=palette -->\nWhich palette?",
    "<!-- factory-cockpit-chat role=dev-manager -->\nThe owner talked to the dev manager in the cockpit.\n\nOwner: hi"]);
  expect(asks.map((a) => [a.id, a.state])).toEqual([["palette", "open"]]);
});
