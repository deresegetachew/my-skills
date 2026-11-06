// An epic's page (#440): its summary and citations read from the issue, carried to the web UI's epics API, and the rules
// of its thread (the owner's messages about one epic and the answers that follow them).
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseEpic } from "../hooks/core/domain/epic.ts";
import { epicThread, stageSteps, talkText } from "../web/epics_model.ts";
import { api, project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write } from "./support.ts";

function parse(body: string, title = "Search") {
  return parseEpic({ number: 40, title, body, labels: ["epic"], closed: false, openIds: new Set() });
}

test("the summary is the first plain line of the body, not a task, PRD or Decisions line", () => {
  const e = parse("\n- [ ] #1 first\nPRD: docs/a.md\nDecisions: 0003\nFind things fast.\nSecond line.\n");
  expect(e.summary).toBe("Find things fast.");
});

test("a body with no plain line has an empty summary; a long one is cut at 300 characters", () => {
  expect(parse("- [ ] #1 first").summary).toBe("");
  expect(parse("x".repeat(500)).summary.length).toBe(300);
});

test("the citations are those of the title and the body, each once, as written", () => {
  const e = parse("Per decision 0004 and US-12.\nAgain decision 0004.", "Epic for ADR 5");
  expect(e.cites).toEqual(["ADR 5", "decision 0004", "US-12"]);
});

const item = (id: string, kind: string, text: string, at: string) => ({ id, at, from: kind === "owner" ? "owner" : "mentewab", to: "x", kind, text });

test("the talk text names the epic so the product owner knows what it is about", () => {
  expect(talkText({ id: "440", title: "Epics above tasks" }, "Is this an issue?")).toBe("About epic #440 (Epics above tasks): Is this an issue?");
});

test("the thread holds the messages about the epic and the answers that follow, up to the next message about something else", () => {
  const a = talkText({ id: "440", title: "T" }, "first");
  const b = talkText({ id: "441", title: "U" }, "other epic");
  const items = [
    item("1", "owner", "plain chat", "2026-11-06T10:00:00Z"),
    item("2", "owner", a, "2026-11-06T10:01:00Z"),
    item("3", "reply", "an answer", "2026-11-06T10:02:00Z"),
    item("4", "owner", b, "2026-11-06T10:03:00Z"),
    item("5", "reply", "answer to the other", "2026-11-06T10:04:00Z"),
    item("6", "owner", talkText({ id: "440", title: "T" }, "second"), "2026-11-06T10:05:00Z"),
  ];
  expect(epicThread(items, "440").map((x) => x.id)).toEqual(["2", "3", "6"]);
  expect(epicThread(items, "999")).toEqual([]);
});

test("the stage steps: the stages before the current are done, the current is now, the rest are later; parked is none of them", () => {
  expect(stageSteps("building").map((s) => [s.stage, s.state])).toEqual([["investigating", "done"], ["prd", "done"], ["decision", "done"],
    ["planned", "done"], ["building", "now"], ["done", "later"]]);
  expect(stageSteps("investigating")[0]?.state).toBe("now");
  expect(stageSteps("parked").every((s) => s.state === "later")).toBe(true);
});

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

test("the epics API gives each epic's summary and citations (none when the cache has none)", async () => {
  const p = project();
  roots.push(p.root);
  const epics: Row[] = [{ id: "40", title: "Accounts", stage: "building", tasks: [], prd: "", decisions: [], summary: "Sign in.", cites: ["decision 0004"] },
    { id: "41", title: "Billing", stage: "planned", tasks: [], prd: "", decisions: [] }];
  write(join(p.state, "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: [], epics }, pulls: [], ci: { mode: "local", repo: "o/work", label: "", runners: [], runs: [], errors: [] } }));
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  const got = (await api(ui, "/api/projects/work/epics")).json.epics as Row[];
  expect(got[0]).toMatchObject({ summary: "Sign in.", cites: ["decision 0004"] });
  expect(got[1]).toMatchObject({ summary: "", cites: [] });
}, T);
