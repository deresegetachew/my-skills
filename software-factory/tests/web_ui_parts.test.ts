// The web app's shared parts (#450) that aren't drawing, from web/parts_model.ts as it is (no React): the
// confirm-with-preconditions dialog (a checklist that keeps the button off, what happens and what doesn't, the name typed
// for serious ones), what stopping and starting an agent ask, and the "Talk about this" box's words and thread.
import { expect, test } from "bun:test";
import type { ChatItemView } from "../web/chat_model.ts";
import { talkText as epicTalkText } from "../web/epics_model.ts";
import { type ConfirmSpec, confirmState, itemThread, startAgentAsk, stopAgentAsk, talkTargets, talkText } from "../web/parts_model.ts";

const spec = (more: Partial<ConfirmSpec> = {}): ConfirmSpec => ({
  title: "Remove the Mac?",
  checks: [{ title: "Its agents are stopped", met: true }, { title: "It is not the hub", met: true }],
  happens: "The Mac leaves the factory.",
  doesNot: "Nothing on the Mac itself is deleted.",
  action: "Remove the Mac",
  tone: "danger",
  ...more,
});

test("the button is on only when every precondition is met", () => {
  expect(confirmState(spec(), "")).toEqual({ ready: true, unmet: [], nameOk: true });
  const s = spec({ checks: [{ title: "Its agents are stopped", met: false, fix: "Stop them" }, { title: "It is not the hub", met: true }] });
  const st = confirmState(s, "");
  expect(st.ready).toBe(false);
  expect(st.unmet.map((c) => [c.title, c.fix])).toEqual([["Its agents are stopped", "Stop them"]]);
});

test("a serious one also needs its name typed, exactly", () => {
  const s = spec({ typeName: "Mac" });
  expect(confirmState(s, "").ready).toBe(false);
  expect(confirmState(s, "mac").ready).toBe(false);
  expect(confirmState(s, "Ma").nameOk).toBe(false);
  expect(confirmState(s, " Mac ")).toEqual({ ready: true, unmet: [], nameOk: true });
  const unmet = spec({ typeName: "Mac", checks: [{ title: "It is not the hub", met: false }] });
  expect(confirmState(unmet, "Mac")).toEqual({ ready: false, unmet: [{ title: "It is not the hub", met: false }], nameOk: true });
});

const agent = { name: "haile", here: true, state: "working", machineName: "dev-pc", task: "437" };

test("stopping an agent: it must run, on this machine; what stops and what stays, in plain words", () => {
  const s = stopAgentAsk(agent);
  expect(s.title).toBe("Stop haile?");
  expect(s.action).toBe("Stop haile");
  expect(s.tone).toBe("danger");
  expect(s.typeName).toBeUndefined();
  expect(s.checks.map((c) => [c.title, c.met])).toEqual([["haile is running", true], ["haile runs on this machine", true]]);
  expect(s.happens).toContain("haile's session on dev-pc ends");
  expect(s.doesNot).toContain("#437 stays claimed for haile");
  expect(confirmState(s, "").ready).toBe(true);
});

test("stopping an agent that runs elsewhere, or not at all, keeps the button off and says why", () => {
  const away = stopAgentAsk({ ...agent, here: false, machineName: "Mac" });
  const c = away.checks.find((x) => !x.met);
  expect(c?.title).toBe("haile runs on this machine");
  expect(c?.sub).toContain("It runs on Mac");
  expect(confirmState(away, "").ready).toBe(false);
  const down = stopAgentAsk({ ...agent, state: "down" });
  expect(down.checks.find((x) => !x.met)?.title).toBe("haile is running");
  const idle = stopAgentAsk({ ...agent, task: null });
  expect(idle.doesNot).not.toContain("#");
});

test("stopping a sub-manager (#585): its parent goes on; one whose session can't be reached keeps the button off and says why", () => {
  const sub = { name: "fasil-board-m12", here: true, state: "stuck", machineName: "sandbox", task: null,
    sub: { parent: "fasil", item: "board-m12", stoppable: true } };
  const s = stopAgentAsk(sub);
  expect(s.checks.map((c) => [c.title, c.met])).toEqual([["fasil-board-m12 is running", true],
    ["fasil-board-m12 runs on this machine", true], ["Its session can be reached", true]]);
  expect(s.happens).toContain("fasil's sub-manager on board-m12 ends");
  expect(s.happens).toContain("fasil goes on with its pass");
  expect(confirmState(s, "").ready).toBe(true);
  const lost = stopAgentAsk({ ...sub, sub: { ...sub.sub, stoppable: false } });
  const c = lost.checks.find((x) => !x.met);
  expect(c?.title).toBe("Its session can be reached");
  expect(c?.sub).toContain("Stop fasil instead");
  expect(confirmState(lost, "").ready).toBe(false);
});

test("starting an agent: it must not be running already; it starts on this machine", () => {
  const s = startAgentAsk({ ...agent, state: "down" });
  expect(s.title).toBe("Start haile?");
  expect(s.action).toBe("Start haile");
  expect(s.tone).toBe("primary");
  expect(s.checks.map((c) => [c.title, c.met])).toEqual([["haile isn't running yet", true]]);
  expect(s.happens).toContain("on this machine");
  expect(confirmState(startAgentAsk(agent), "").ready).toBe(false);
  expect(confirmState(startAgentAsk(undefinedAgent("ezana")), "").ready).toBe(true);
});

function undefinedAgent(name: string) {
  return { name, here: false, state: "down", machineName: null, task: null };
}

test("no confirm shows a command, a flag or a setting key", () => {
  for (const s of [stopAgentAsk(agent), stopAgentAsk({ ...agent, here: false }), startAgentAsk(undefinedAgent("ezana"))]) {
    const words = [s.title, s.happens, s.doesNot, s.action, ...s.checks.flatMap((c) => [c.title, c.sub ?? "", c.fix ?? ""])].join(" ");
    expect(words).not.toMatch(/factory [a-z]|--[a-z]|tmux|owner (start|stop)/);
  }
});

test("Talk about this: the line says what it is about, for each kind of item", () => {
  expect(talkText({ kind: "task", id: "437", title: "An avatar for every agent" }, " Is it done? ")).toBe("About task #437 (An avatar for every agent): Is it done?");
  expect(talkText({ kind: "pr", id: "402", title: "Product owner:  try\nwhat was built" }, "Why protected?")).toBe("About PR #402 (Product owner: try what was built): Why protected?");
  expect(talkText({ kind: "decision", id: "0004", title: "NATS" }, "Still right?")).toBe("About decision 0004 (NATS): Still right?");
  expect(talkText({ kind: "signoff", id: "12", title: "The board" }, "Looks fine")).toBe("About sign-off #12 (The board): Looks fine");
  expect(talkText({ kind: "epic", id: "440", title: "Epics above tasks" }, "x")).toBe(epicTalkText({ id: "440", title: "Epics above tasks" }, "x"));
});

const item = (id: string, kind: string, text: string): ChatItemView => ({ id, at: `2026-11-06T10:0${id}:00Z`, from: kind === "owner" ? "owner" : "fasil", to: "fasil", kind, text });

test("an item's thread: the owner's lines about it and the answers after each, up to a line about something else", () => {
  const task = { kind: "task", id: "437", title: "Avatars" };
  const items = [
    item("1", "owner", "hello"),
    item("2", "owner", talkText(task, "first")),
    item("3", "reply", "an answer"),
    item("4", "owner", talkText({ kind: "pr", id: "437", title: "Avatars" }, "the PR, not the task")),
    item("5", "reply", "about the PR"),
    item("6", "owner", talkText(task, "second")),
    item("7", "reply", "another answer"),
  ];
  expect(itemThread(items, task).map((x) => x.id)).toEqual(["2", "3", "6", "7"]);
  expect(itemThread(items, { kind: "task", id: "1", title: "" })).toEqual([]);
});

test("the box talks to the product owner first, then the dev manager; coding agents aren't offered", () => {
  const t = talkTargets([
    { name: "haile", role: "coding-agent" },
    { name: "fasil", role: "dev-manager" },
    { name: "mentewab", role: "product-owner" },
  ]);
  expect(t).toEqual([
    { name: "mentewab", role: "product-owner", words: "product owner" },
    { name: "fasil", role: "dev-manager", words: "dev manager" },
  ]);
  expect(talkTargets([{ name: "haile", role: "coding-agent" }])).toEqual([]);
});
