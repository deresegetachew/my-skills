// Answering an owner ask in place (#395): in the Needs you view, Enter on an ask shows all of it with its options, a digit
// picks one, and `y` runs `factory owner answer` through the view's `act`. The options come from the ask's body in
// `factory prs --json` (a fake `gh`), tested at the end.
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { drawNeeds, type NeedsProps } from "../cockpit/testing.tsx";
import { envWith, gitRepo, HOOKS, SF, sh, tmp, write, writeExe } from "./support.ts";

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-10-31T12:00:00Z");

const SNAP: Row = {
  generatedAt: "2026-10-31T11:57:00Z",
  needsYou: [
    { kind: "owner-ask", id: "ship-it", issue: 77, url: "https://github.com/o/r/issues/77#c1", ageMinutes: 8, state: "owner",
      text: "this needs your yes: ship 1.4?\nThe tests are green.", options: ["yes, ship it", "wait a week", "other"] },
    { kind: "owner-merges", number: 9, title: "Update the factory", url: "https://github.com/o/r/pull/9" },
  ],
};

type Props = NeedsProps & { act?: (words: string[]) => Promise<string> };

function needsProps(o: Partial<Props> = {}): Props {
  return { repo: "work", snapshot: SNAP, cols: 120, rows: 30, color: false, load: () => Promise.resolve(SNAP), now: () => NOW, ...o };
}

function recorder(output = "Answered ship-it on #7."): { calls: string[][]; act: (words: string[]) => Promise<string> } {
  const calls: string[][] = [];
  return { calls, act: (words) => {
    calls.push(words);
    return Promise.resolve(output);
  } };
}

const QUESTION = (id: string, option: string) => `Run \`factory owner answer ${id} ${option}\`? It changes the owner queue. [y/N]`;

test("Enter on an owner ask shows its whole text and its options, numbered", async () => {
  const { act, calls } = recorder();
  const v = drawNeeds(needsProps({ act }));
  await v.settle();
  await v.press("\r");
  const f = v.frame();
  expect(f).toContain("this needs your yes: ship 1.4?");
  expect(f).toContain("The tests are green.");
  expect(f).toMatch(/^\s*1 yes, ship it$/m);
  expect(f).toMatch(/^\s*2 wait a week$/m);
  expect(f).toMatch(/^\s*3 other$/m);
  expect(calls).toEqual([]);
  v.unmount();
});

test("a digit picks an option and asks before anything runs", async () => {
  const { act, calls } = recorder();
  const v = drawNeeds(needsProps({ act }));
  await v.settle();
  await v.press("\r");
  await v.press("2");
  expect(v.frame()).toContain(QUESTION("ship-it", "wait a week"));
  expect(calls).toEqual([]);
  v.unmount();
});

test("y runs factory owner answer once and shows its output", async () => {
  const { act, calls } = recorder("Answered ship-it on #7.");
  const v = drawNeeds(needsProps({ act }));
  await v.settle();
  await v.press("\r");
  await v.press("2");
  await v.press("y");
  await v.settle();
  expect(calls).toEqual([["owner", "answer", "ship-it", "wait a week"]]);
  expect(v.frame()).toContain("Answered ship-it on #7.");
  v.unmount();
});

test("any other key after the question runs nothing and says so", async () => {
  const { act, calls } = recorder();
  const v = drawNeeds(needsProps({ act }));
  await v.settle();
  await v.press("\r");
  await v.press("1");
  expect(v.frame()).toContain(QUESTION("ship-it", "yes, ship it"));
  await v.press("n");
  await v.settle();
  expect(calls).toEqual([]);
  expect(v.frame()).toContain("Not run: nothing changed.");
  v.unmount();
});

test("Esc in the ask goes back to the list", async () => {
  const { act, calls } = recorder();
  const v = drawNeeds(needsProps({ act }));
  await v.settle();
  await v.press("\r");
  expect(v.frame()).toContain("1 yes, ship it");
  await v.press("\x1b");
  await v.settle();
  const f = v.frame();
  expect(f).not.toContain("1 yes, ship it");
  expect(f).toContain("FOR YOU");
  expect(f).toMatch(/PR #9 Update the factory/);
  expect(calls).toEqual([]);
  v.unmount();
});

test("Enter on an owner-merges row opens no ask and runs nothing", async () => {
  const { act, calls } = recorder();
  const v = drawNeeds(needsProps({ act }));
  await v.settle();
  await v.press("j");
  await v.press("\r");
  await v.settle();
  const f = v.frame();
  expect(f).toMatch(/PR #9 Update the factory/);
  expect(f).not.toContain("1 yes, ship it");
  expect(f).not.toContain("[y/N]");
  expect(calls).toEqual([]);
  v.unmount();
});

// --- the options, from the ask's body ---------------------------------------------------------------------------------

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.PRS_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const path = new URL(raw.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json") out(s.main_settings ?? {});
if (path in s) out(s[path]);
if (path === "branches") out([]);
console.error("fake gh: no answer for " + path);
process.exit(1);
`;

function asksFor(bodies: string[]): Row[] {
  const root = tmp();
  const d = join(root, "work");
  sh(["mkdir", "-p", d]);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik"] }));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  const comments = bodies.map((body, i) => ({ id: i + 1, body, created_at: `2020-01-01T0${i + 1}:00:00Z`,
    html_url: `https://github.com/o/r/issues/60#c${i + 1}`, issue_url: "x/issues/60" }));
  write(join(root, "scenario.json"), JSON.stringify({ pulls: [], issues: [{ number: 60, title: "Dev manager: needs the owner", state: "open",
    labels: [], body: "" }], "issues/comments": [], "issues/60/comments": comments, main_settings: {} }));
  const env = envWith(join(root, "bin"), { PRS_SCENARIO: join(root, "scenario.json"), FACTORY_AGENT: undefined, FACTORY_LOOP: undefined,
    CLAUDE_PROJECT_DIR: undefined });
  const p = sh(["bash", join(SF, "factory"), "prs", "--json"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  return (JSON.parse(p.stdout) as { ownerAsks: Row[] }).ownerAsks;
}

test("an ask's text has no marker and its list items become the options", () => {
  const [ask] = asksFor(["<!-- factory-owner-ask id=ship-it -->\nthis needs your yes: ship 1.4?\n\n- yes, ship it\n- wait a week\n1. other"]);
  expect(ask?.text).toContain("ship 1.4?");
  expect(String(ask?.text)).not.toContain("<!--");
  expect(ask?.options).toEqual(["yes, ship it", "wait a week", "other"]);
});

test("list items may start with *, 1), or a)", () => {
  const [ask] = asksFor(["<!-- factory-owner-ask id=pick -->\nwhich?\n* red\n1) green\na) blue"]);
  expect(ask?.options).toEqual(["red", "green", "blue"]);
});

test("an ask with no list has the options yes and no", () => {
  const [ask] = asksFor(["<!-- factory-owner-ask id=plain -->\nthis needs your yes: renumber?"]);
  expect(ask?.options).toEqual(["yes", "no"]);
});
