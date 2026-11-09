// Needs attention for an agent nobody is watching (#644, #640), through the real server (startUi) with a fake `factory`:
//   - a coding agent waiting at a question in its picker shows "<name> asks: <question>", with each option as a button that
//     types that option into its session (POST .../chat {choose}: `factory say <name> --choose <n>`);
//   - an agent whose loop stopped at start for leftover changes in its folder shows "<name> can't start: leftover changes
//     in its folder", with Save them aside and start (POST .../start {confirm, stash}: `factory owner start ... --stash`);
//   - Start watches the loop for a few seconds: one that stopped at once is not "Started", it says why, with its last lines.
// And the page's model: the buttons a row shows and what each one does.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, heartbeat, hbRow, project, type Project, startUi, type Running } from "./web_ui_support.ts";
import { type AttentionItem, actionOf, attentionDot, buttonsOf, doOf, stuckMarks } from "../web/attention_model.ts";
import { git, write, writeExe } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const ASK = { question: "How should I scope it?", options: [{ key: "1", label: "Split it (Recommended)" }, { key: "2", label: "All in one PR" },
  { key: "3", label: "Close as mostly done" }] };
const DOWN = { code: "dirty_worktree", message: "leftover changes in its folder /w/work-agents/haile", dir: "/w/work-agents/haile",
  fix: "Save them aside and start (the web UI's Needs attention), or `factory owner start coding-agent haile --stash`.",
  lines: [" M notes.md", "?? scratch.txt"] };

function workProject(): Project {
  const p = project({ ...CONFIG, agents: ["menelik", "taytu", "haile"] });
  roots.push(p.root);
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], missing: [], needsYou: [],
    tasks: { source: "issues", tasks: [{ id: "7", title: "Scope the UI calls", state: "in-progress", holders: ["taytu"], group: "", todos: [], dependsOn: [] }], epics: [] },
    pulls: [], ci: { mode: "github", repo: "o/work", runners: [], errors: [], runs: [] } }));
  heartbeat(p, [hbRow("menelik"), hbRow("taytu", { state: "working", detail: "working on #7", task: "7" }), hbRow("haile")]);
  return p;
}

async function started(p: Project, env: Record<string, string> = {}): Promise<Running> {
  const ui = await startUi(p, ["--port", "0"], null, { FACTORY_UI_START_CHECK_SECONDS: "0", ...env });
  running.push(ui);
  return ui;
}

type Item = AttentionItem;

async function until(ui: Running, ok: (x: Item[]) => boolean, ms = 15_000): Promise<Item[]> {
  const deadline = Date.now() + ms;
  let last: Item[] = [];
  while (Date.now() < deadline) {
    const r = await api(ui, "/api/projects/work/attention");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    last = r.json.items as Item[];
    if (ok(last)) break;
    await Bun.sleep(150);
  }
  return last;
}

const one = (x: Item[], id: string): Item | undefined => x.find((i) => i.id === id);

test("an agent asking in its picker: the question, each option a button that types it into its session; it clears once answered", async () => {
  const p = workProject();
  const ui = await started(p);
  heartbeat(p, [hbRow("menelik"), hbRow("taytu", { state: "waiting", detail: "asks the owner: How should I scope it?", task: "7", on: "owner", ask: ASK }), hbRow("haile")]);
  const x = await until(ui, (l) => Boolean(one(l, "agent-asks:taytu")));
  const it = one(x, "agent-asks:taytu");
  expect(it).toMatchObject({ kind: "agent-asks", agent: "taytu", task: "7", title: "taytu asks: How should I scope it?",
    action: { kind: "choose", label: "Split it (Recommended)", agent: "taytu", key: "1" } });
  expect(it?.reason).toContain("waits for an answer in its session");
  expect(it?.options).toEqual([{ kind: "choose", label: "Split it (Recommended)", agent: "taytu", key: "1" },
    { kind: "choose", label: "All in one PR", agent: "taytu", key: "2" }, { kind: "choose", label: "Close as mostly done", agent: "taytu", key: "3" }]);
  // the button: the chat route types the option there
  const r = await api(ui, "/api/projects/work/agents/taytu/chat", { method: "POST", body: { choose: "2" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(readFileSync(p.factoryLog, "utf8")).toContain("say taytu --choose 2");
  const bad = await api(ui, "/api/projects/work/agents/taytu/chat", { method: "POST", body: { choose: "2; rm -rf /" } });
  expect([bad.status, bad.json.code]).toEqual([400, "chat_choice_needed"]);
  expect(readFileSync(p.factoryLog, "utf8").split("\n").filter((l) => l.startsWith("say"))).toEqual(["say taytu --choose 2"]);
  heartbeat(p, [hbRow("menelik"), hbRow("taytu", { state: "working", detail: "working on #7", task: "7" }), hbRow("haile")]);
  expect(one(await until(ui, (l) => !one(l, "agent-asks:taytu")), "agent-asks:taytu")).toBeUndefined();
}, T);

test("a loop that can't start for leftover changes: one item, Save them aside and start; the button runs owner start --stash", async () => {
  const p = workProject();
  const ui = await started(p);
  heartbeat(p, [hbRow("menelik"), hbRow("taytu"), hbRow("haile", { state: "down", detail: `down: ${DOWN.message}`, since: null, down: DOWN })]);
  const x = await until(ui, (l) => Boolean(one(l, "agent-cant-start:haile")));
  expect(one(x, "agent-cant-start:haile")).toMatchObject({ kind: "agent-cant-start", agent: "haile",
    title: "haile can't start: leftover changes in its folder",
    reason: "leftover changes in its folder /w/work-agents/haile ( M notes.md, ?? scratch.txt)",
    action: { kind: "start", label: "Save them aside and start", agent: "haile", stash: true } });
  const r = await api(ui, "/api/projects/work/agents/haile/start", { method: "POST", body: { confirm: true, stash: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.command).toBe("factory owner start coding-agent haile --stash");
  // a plain Start is still plain
  await api(ui, "/api/projects/work/agents/menelik/start", { method: "POST", body: { confirm: true } });
  expect(readFileSync(p.factoryLog, "utf8").trim().split("\n").filter((l) => l.startsWith("owner"))).toEqual(["owner start coding-agent haile --stash",
    "owner start coding-agent menelik"]);
}, T);

test("Start watches the loop: one that stopped at once says why, with its last lines, instead of Started", async () => {
  const p = workProject();
  // the loop as it stops at start: it writes its reason where the heartbeat reads it (factory_loop_watch.ts down)
  const common = git(p.d, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  writeExe(join(p.d, "factory"), `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
mkdir -p ${common}/factory
printf '{"code":"dirty_worktree","message":"leftover changes in its folder /w/work-agents/%s","fix":"Save them aside and start.","dir":"/w","lines":[" M notes.md"],"at":%s}' "$4" "$(date +%s)" > ${common}/factory/down-$4.json
echo "Started coding-agent-$4 in tmux session work-$4."
`);
  const ui = await started(p, { FACTORY_UI_START_CHECK_SECONDS: "3" });
  const r = await api(ui, "/api/projects/work/agents/haile/start", { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(500);
  expect(r.json).toMatchObject({ ok: false, code: "ui_start_died", message: "haile started, but its loop stopped at once: leftover changes in its folder /w/work-agents/haile.",
    fix: "Save them aside and start." });
  expect(String(r.json.output)).toContain(" M notes.md");
}, T);

test("Start of a loop that keeps running still says Started, after its few seconds", async () => {
  const p = workProject();
  const ui = await started(p, { FACTORY_UI_START_CHECK_SECONDS: "1" });
  const t0 = Date.now();
  const r = await api(ui, "/api/projects/work/agents/haile/start", { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
}, T);

// --- the page's model -----------------------------------------------------------------------------------------------

const item = (kind: string, more: Partial<AttentionItem>): AttentionItem => ({ id: `${kind}:x`, kind, title: "t", reason: `${kind} reason`, task: null, agent: null,
  pr: null, epic: null, action: { kind: "open", label: "Open", link: "page:home" }, ...more });

test("the model: a question's row has one button per option, each typing its key; Save them aside starts with stash", () => {
  const options = ASK.options.map((o) => ({ kind: "choose" as const, label: o.label, agent: "taytu", key: o.key }));
  const asks = item("agent-asks", { agent: "taytu", title: "taytu asks: How should I scope it?", action: options[0] as AttentionItem["action"], options });
  expect(buttonsOf(asks).map((b) => b.label)).toEqual(["Split it (Recommended)", "All in one PR", "Close as mostly done"]);
  expect(buttonsOf(asks).map(doOf)).toEqual([{ do: "choose", agent: "taytu", key: "1", label: "Split it (Recommended)" },
    { do: "choose", agent: "taytu", key: "2", label: "All in one PR" }, { do: "choose", agent: "taytu", key: "3", label: "Close as mostly done" }]);
  const cant = item("agent-cant-start", { agent: "haile", reason: "leftover changes", action: { kind: "start", label: "Save them aside and start", agent: "haile", stash: true } });
  expect(actionOf(cant)).toEqual({ do: "start", agent: "haile", stash: true });
  expect(buttonsOf(cant).map((b) => b.label)).toEqual(["Save them aside and start"]);
  expect([attentionDot(asks), attentionDot(cant)]).toEqual(["red", "red"]);
  expect(stuckMarks([asks, cant]).agents).toEqual({ taytu: "taytu asks: How should I scope it?", haile: "leftover changes" });
  // a key that isn't an option's number is never typed: the button opens Home instead
  expect(doOf({ kind: "choose", label: "x", agent: "taytu", key: "1; rm" })).toEqual({ do: "open", link: "page:home" });
  expect(buttonsOf(item("claude-limit", { action: { kind: "none", label: "" } }))).toEqual([]);
});
