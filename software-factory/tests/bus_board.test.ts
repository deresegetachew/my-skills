// Leases, wake-ups and the pull request feed on the message board (#500, decision 0007 point 10): the board gives
// everything the factory sent over NATS (messaging.kinds claim, wake and pr), and passes the same contract
// (contracts/bus.ts) against a real Postgres. Each fixture is a project of its own on one board.
import { afterAll, beforeAll, setDefaultTimeout } from "bun:test";
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
