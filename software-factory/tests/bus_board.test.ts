// Leases, wake-ups and the pull request feed on the message board (#500, decision 0007 point 10): the board gives
// everything the factory sent over NATS (messaging.kinds claim, wake and pr), and passes the same contract
// (contracts/bus.ts) against a real Postgres. Each fixture is a project of its own on one board.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { type BoardWorld, boardWorld } from "./board_support.ts";
import { busContract } from "./contracts/bus.ts";

setDefaultTimeout(120_000);

let world: BoardWorld;

beforeAll(async () => {
  world = await boardWorld();
}, 600_000);

afterAll(async () => {
  await world?.end();
}, 120_000);

busContract("board", () => world.bus());

test("board wakes and pull request events: a caller whose clock runs a minute fast still hears what was said since its `since`", () => {
  const bus = world.bus();
  const real = Date.now;
  try {
    Date.now = () => real() + 60_000;
    const since = Date.now();
    bus.wake({ from: "lead", to: "po", ref: "", why: "skewed" });
    bus.putPrs({ v: 1, at: Date.now(), by: "lead", login: "bot", repo: "o/r", closed: [], prs: [] },
      [{ pr: 5, change: "merged", from: "lead", head: "a".repeat(40), checks: "green", labels: [], at: new Date().toISOString() }]);
    expect(bus.waitWake({ names: ["po", "po", "all"], since, seconds: 2 })?.why).toBe("skewed");
    expect(bus.prEvents({ since, seconds: 1 }).map((e) => e.change)).toEqual(["merged"]);
  } finally {
    Date.now = real;
  }
});
