// Leases and wake-ups on the message board (#500, decision 0007 point 10), against a real Postgres: one holder per key
// until its time runs out, a release only by the holder, a drop by anyone; a wake-up said before the wait or during it
// ends the wait, one for someone else or said by the waiter does not, and a wait with none gives null at its limit.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { type BoardWorld, boardWorld } from "./board_support.ts";

setDefaultTimeout(120_000);

let world: BoardWorld;

beforeAll(async () => {
  world = await boardWorld();
}, 600_000);

afterAll(async () => {
  await world?.end();
}, 120_000);

test("board leases: one holder per key; taking it again refreshes it; release by the holder; drop by anyone", () => {
  const bus = world.bus();
  expect(bus.claim("review.12.abcdef0", "haile@m1", 60)).toEqual({ held: true, holder: "haile@m1" });
  expect(bus.claim("review.12.abcdef0", "taytu@m2", 60)).toEqual({ held: false, holder: "haile@m1" });
  expect(bus.claim("review.12.abcdef0", "haile@m1", 60)).toEqual({ held: true, holder: "haile@m1" });
  expect(bus.holder("review.12.abcdef0")).toBe("haile@m1");
  expect(bus.release("review.12.abcdef0", "taytu@m2")).toBe(false);
  expect(bus.release("review.12.abcdef0", "haile@m1")).toBe(true);
  expect(bus.holder("review.12.abcdef0")).toBe("");
  bus.claim("task.7", "taytu@m2", 60);
  expect(bus.drop("task.7")).toBe(true);
  expect(bus.drop("task.7")).toBe(false);
  expect(world.bus().holder("review.12.abcdef0")).toBe(""); // another project's keys are its own
});

test("board leases: a project's key is not another project's", () => {
  const a = world.bus();
  const b = world.bus();
  a.claim("rework.3", "haile@m1", 60);
  expect(b.holder("rework.3")).toBe("");
  expect(b.claim("rework.3", "taytu@m2", 60).held).toBe(true);
});

test("board wakes: a wake said since the wait's time ends it; one for someone else, or the waiter's own, does not", () => {
  const bus = world.bus();
  const since = Date.now();
  bus.wake({ from: "haile", to: "taytu", ref: "", why: "not for po" });
  bus.wake({ from: "po", to: "po", ref: "", why: "my own" });
  bus.wake({ from: "dev-manager", to: "po", ref: "pr#4", why: "merged" });
  const got = bus.waitWake({ names: ["po", "po", "all"], since, seconds: 5 });
  expect(got).toMatchObject({ from: "dev-manager", to: "po", ref: "pr#4", why: "merged" });
  const started = Date.now();
  expect(bus.waitWake({ names: ["po", "po", "all"], since: Date.now(), seconds: 1 })).toBeNull();
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect(world.bus().waitWake({ names: ["po", "po", "all"], since, seconds: 1 })).toBeNull(); // another project's wakes
});
