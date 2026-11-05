// Answering an owner ask in place (#395): Enter on an ask in Needs you shows it whole with its options; picking one,
// or typing an answer, posts it through `factory owner answer` after a y/N. The ask's words come from `factory prs
// --json` (`text`), and a talk's summary on the owner queue (`factory-cockpit-chat`) never counts as the owner's answer.
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { drawNeeds, type NeedsProps } from "../cockpit/testing.tsx";
import { approvals } from "../hooks/factory_flow.ts";
import { envWith, gitRepo, HOOKS, type Proc, SF, sh, tmp, write, writeExe } from "./support.ts";

type Obj = Record<string, unknown>;

const ASK: Obj = { kind: "owner-ask", id: "palette", issue: 7, url: "https://github.com/o/r/issues/7#issuecomment-1", ageMinutes: 5,
  state: "open", text: "Which palette for the board?\n\n- Warm amber\n- Cool blue\n\nSay which one." };

function needs(rows: Obj[], acted: string[][], output = "Answered palette on #7."): ReturnType<typeof drawNeeds> {
  const props: NeedsProps = { repo: "work", snapshot: { generatedAt: new Date().toISOString(), needsYou: rows }, cols: 100, rows: 30,
    color: false, load: async () => ({ generatedAt: new Date().toISOString(), needsYou: rows }),
    act: async (words) => {
      acted.push(words);
      return output;
    } };
  return drawNeeds(props);
}

test("Enter on an ask shows it whole, with its options and a line to type one's own, the first selected", async () => {
  const acted: string[][] = [];
  const v = needs([ASK], acted);
  await v.press("\r");
  const f = v.frame();
  expect(f).toContain("Which palette for the board?");
  expect(f).toContain("Say which one.");
  expect(f).toMatch(/› .*Warm amber/);
  expect(f).toContain("Cool blue");
  expect(f).toContain("Type your own answer");
  expect(acted).toEqual([]);
  v.unmount();
});

test("picking an option asks first, and y posts it through factory owner answer and shows what it said", async () => {
  const acted: string[][] = [];
  const v = needs([ASK], acted);
  await v.press("\r");
  await v.press("j");
  await v.press("\r");
  expect(v.frame()).toContain("Cool blue");
  expect(v.frame()).toContain("[y/N]");
  expect(acted).toEqual([]);
  await v.press("y");
  await v.settle();
  expect(acted).toEqual([["owner", "answer", "palette", "Cool blue"]]);
  expect(v.frame()).toContain("Answered palette on #7.");
  v.unmount();
});

test("any answer but y posts nothing and says so", async () => {
  const acted: string[][] = [];
  const v = needs([ASK], acted);
  await v.press("\r");
  await v.press("\r");
  await v.press("n");
  await v.settle();
  expect(acted).toEqual([]);
  expect(v.frame()).toContain("Not run: nothing changed.");
  v.unmount();
});

test("an answer of one's own is typed in, then asked about, then posted", async () => {
  const acted: string[][] = [];
  const v = needs([ASK], acted);
  await v.press("\r");
  await v.press("j");
  await v.press("j");
  await v.press("\r");
  await v.press("Neither, use grey");
  expect(v.frame()).toContain("Neither, use grey");
  await v.press("\r");
  expect(v.frame()).toContain("[y/N]");
  await v.press("y");
  await v.settle();
  expect(acted).toEqual([["owner", "answer", "palette", "Neither, use grey"]]);
  v.unmount();
});

test("numbered and lettered lists are options too", async () => {
  const acted: string[][] = [];
  const v = needs([{ ...ASK, text: "When do we ship?\n1. Ship now\n2) Wait a week\nA) Ask the PO" }], acted);
  await v.press("\r");
  const f = v.frame();
  expect(f).toMatch(/› .*Ship now/);
  expect(f).toContain("Wait a week");
  expect(f).toContain("Ask the PO");
  await v.press("j");
  await v.press("\r");
  await v.press("y");
  await v.settle();
  expect(acted).toEqual([["owner", "answer", "palette", "Wait a week"]]);
  v.unmount();
});

test("Esc goes back to the list without posting", async () => {
  const acted: string[][] = [];
  const v = needs([ASK], acted);
  await v.press("\r");
  await v.press("\x1b");
  await v.settle();
  expect(v.frame()).toContain("Owner ask palette");
  expect(v.frame()).not.toContain("Type your own answer");
  expect(acted).toEqual([]);
  v.unmount();
});

test("Enter on a pull request only a person merges posts nothing", async () => {
  const acted: string[][] = [];
  const v = needs([{ kind: "owner-merges", number: 12, title: "x", url: "u" }], acted);
  await v.press("\r");
  await v.press("y");
  await v.settle();
  expect(acted).toEqual([]);
  v.unmount();
});

test("an ask with no text (an older cache) opens with only the line to type an answer", async () => {
  const acted: string[][] = [];
  const { text: _, ...bare } = ASK;
  const v = needs([bare], acted);
  await v.press("\r");
  expect(v.frame()).toMatch(/› .*Type your own answer/);
  v.unmount();
});

// --- factory prs --json: the ask's words, and a talk's summary ------------------------------------------------------

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
