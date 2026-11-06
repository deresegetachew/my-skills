// A message board for the factory's tests of the board adapters (#500): one real Postgres database (board_pg.ts),
// migrated, and the adapters' fixtures. Each fixture takes a GitHub repo name of its own, so the tasks and messages of
// one never show in another's port, though they share the database (as projects share a machine's board). Not a test file.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { BoardBus } from "../hooks/core/adapters/board/bus.ts";
import { BoardChild } from "../hooks/core/adapters/board/child.ts";
import { BoardMessaging } from "../hooks/core/adapters/board/messaging.ts";
import { BoardTaskTracker } from "../hooks/core/adapters/board/task_tracker.ts";
import { ClaimTokens } from "../hooks/core/adapters/board/tokens.ts";
import type { Claimant } from "../hooks/core/domain/claim.ts";
import type { Task as BoardTask } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import type { Fixture as MessagingFixture } from "./contracts/messaging.ts";
import type { Fixture as TrackerFixture, Spec } from "./contracts/task_tracker.ts";
import { tmp } from "./support.ts";

export interface BoardWorld {
  url: string;
  child: BoardChild;
  dir: string;
  /** A repo name no other fixture in this run has. */
  repo(): string;
  tracker(specs: Spec[]): TrackerFixture & { repo: string; boardIds: number[]; tokens: string; port: BoardTaskTracker };
  messaging(): MessagingFixture;
  bus(): BoardBus;
  end(): Promise<void>;
}

let started: { pg: Pg; db: { url: string; drop(): Promise<void> } } | null = null;

export async function boardWorld(): Promise<BoardWorld> {
  const pg = await startPg();
  const db = await freshDb(pg);
  started = { pg, db };
  const child = new BoardChild({ url: db.url, timeoutMs: 30_000 });
  child.call("system", [{ op: "migrate" }]);
  const dir = tmp("factory-board-");
  let k = 0;
  const repo = (): string => `acme/shop${++k}-${process.pid}`;
  return {
    url: db.url,
    child,
    dir,
    repo,
    tracker(specs) {
      const r = repo();
      const tokens = join(dir, `${r.replace("/", "-")}.claims.json`);
      const port = new BoardTaskTracker({ child, repo: r, tokens: new ClaimTokens(tokens), actor: "factory" });
      const made = specs.length ? child.call("system", specs.map((s, i) => ({ op: "create", args: [{ title: s.title ?? `Task ${i + 1}`,
        body: Array.from({ length: s.todos ?? 0 }, (_, j) => `- [ ] todo ${j + 1}`).join("\n"), ref: `github:${r}#${101 + i}` }] }))) as BoardTask[] : [];
      const boardIds = made.map((t) => t.id);
      const after: { op: string; args: unknown[] }[] = [];
      specs.forEach((s, i) => {
        for (const d of s.dependsOn ?? []) after.push({ op: "link", args: [boardIds[d], boardIds[i], "blocks"] });
      });
      specs.forEach((s, i) => {
        if (s.state === "done") after.push({ op: "close", args: [boardIds[i], { outcome: "done" }] });
        if (s.state === "blocked") after.push({ op: "update", args: [boardIds[i], { version: 1, status: "deferred" }] });
      });
      if (after.length) child.call("system", after);
      const ids = specs.map((_, i) => String(101 + i));
      const rival = (id: string, who: Claimant): void => {
        child.call(who.agent, [{ op: "claim", args: [boardIds[ids.indexOf(id)]] }]);
      };
      return { port, ids, missing: "99", foreign: "1.3", rival, repo: r, boardIds, tokens };
    },
    messaging() {
      return { port: new BoardMessaging({ child, repo: repo() }), ref: "issue#5", other: "pr#7" };
    },
    bus() {
      return new BoardBus({ child, project: repo().replace("/", "-") });
    },
    async end() {
      rmSync(dir, { recursive: true, force: true });
      await started?.db.drop().catch(() => {});
      started?.pg.stop();
      started = null;
    },
  };
}
