// The GitHub Messaging adapter (decision 0003, #376): it passes the port's contract against the fake `gh`
// (fakegh.ts), and reads GitHub the way `factory messages ls` always has: the open issues and PRs, then the comments
// of each one that has any, an agent's card from its issue body, and no envelope of another version.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GithubMessaging } from "../hooks/core/adapters/github/messaging.ts";
import { Message } from "../hooks/core/domain/message.ts";
import { messagingContract } from "./contracts/messaging.ts";
import { installFakeGh } from "./fakegh.ts";
import { tmp, write } from "./support.ts";

const dirs: string[] = [];
const PATH = process.env.PATH;
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Row = Record<string, unknown>;

function issue(number: number, extra: Row = {}): Row {
  return { number, title: `t${number}`, body: "", state: "open", labels: [], html_url: `https://github.test/r/${number}`, ...extra };
}

/** A fake GitHub holding `issues` and `comments` ({"<n>": [body or comment object]}); the adapter's gh is it. */
function world(issues: Row[], comments: Record<string, unknown[]> = {}): string {
  const d = tmp();
  dirs.push(d);
  const bin = installFakeGh(d);
  write(join(d, "db.json"), JSON.stringify({ issues, comments }));
  Object.assign(process.env, { PATH: `${bin}:${PATH}`, FAKE_DB: join(d, "db.json"), LOOP_LOG: join(d, "log"),
    XDG_STATE_HOME: join(d, "state") });
  return d;
}

const calls = (d: string): string[] => readFileSync(join(d, "log"), "utf8").trim().split("\n").filter(Boolean);
const ids = (messages: Message[]): string[] => messages.map((m) => m.id);

messagingContract("github", () => {
  world([issue(5), issue(7, { pull_request: { url: "x" } })]);
  return { port: new GithubMessaging(), ref: "issue#5", other: "pr#7" };
});

test("github: a message is posted as one comment with its envelope, the old marker and the text", () => {
  const d = world([issue(5)]);
  new GithubMessaging().send(new Message({ id: "q1abc", kind: "question", frm: "haile", to: "po", ref: "issue#5" }), "Which colour?");
  const db = JSON.parse(readFileSync(join(d, "db.json"), "utf8")) as { posted: { issue: number; body: string }[] };
  expect(db.posted.map((p) => [p.issue, p.body])).toEqual([[5,
    "<!-- factory-msg v=1 id=q1abc kind=question from=haile to=po state=submitted ref=issue#5 -->\n<!-- factory-question -->\nWhich colour?"]]);
});

test("github: an empty repository reads nothing with one call", () => {
  const d = world([]);
  const got = new GithubMessaging().read(null);
  expect(got.messages).toEqual([]);
  expect(calls(d)).toHaveLength(1);
  expect(calls(d)[0]).toContain("issues?state=open");
});

test("github: an envelope of another version is not read, and an item with no comments costs no call", () => {
  const d = world([issue(5), issue(6, { comments: 0 })], {
    5: ["<!-- factory-msg v=2 id=q1abc kind=question from=haile -->\nFrom a newer kit?",
      "<!-- factory-msg v=1 id=q2abc kind=question from=haile -->\nThis one?"],
  });
  expect(ids(new GithubMessaging().read(null).messages)).toEqual(["q2abc"]);
  expect(calls(d).join("\n")).not.toContain("issues/6/comments");
});

test("github: a comment read twice (across pages) gives its message once", () => {
  const twice = { id: 77, body: "<!-- factory-msg v=1 id=q1abc kind=question from=haile -->\nOnce?", created_at: "2026-10-25T10:00:00Z" };
  world([issue(5)], { 5: [twice, twice] });
  const port = new GithubMessaging();
  const all = port.read(null);
  expect(ids(all.messages)).toEqual(["q1abc"]);
  expect(port.read(all.cursor).messages).toEqual([]);
});

test("github: a comment newer than the cursor is read, an older one is not", () => {
  const d = world([issue(5)], { 5: [{ id: 10, body: "<!-- factory-question -->\nOld?", created_at: "2026-10-25T09:00:00Z" }] });
  const port = new GithubMessaging();
  const first = port.read(null);
  expect(ids(first.messages)).toEqual(["c10"]); // an old marker is still read, with its comment's id
  const db = JSON.parse(readFileSync(join(d, "db.json"), "utf8")) as { comments: Record<string, unknown[]> };
  db.comments["5"]?.push({ id: 11, body: "<!-- factory-question -->\nNew?", created_at: "2026-10-25T09:30:00Z" });
  write(join(d, "db.json"), JSON.stringify(db));
  expect(ids(port.read(first.cursor).messages)).toEqual(["c11"]);
});

test("github: a comment on one thread is not hidden by a newer one already read on another", () => {
  const d = world([issue(5), issue(7)], {
    5: [{ id: 10, body: "<!-- factory-question -->\nFive?", created_at: "2026-10-25T09:00:00Z" }],
    7: [{ id: 20, body: "<!-- factory-question -->\nSeven?", created_at: "2026-10-25T10:00:00Z" }],
  });
  const port = new GithubMessaging();
  const first = port.read(null);
  expect(ids(first.messages)).toEqual(["c10", "c20"]);
  const db = JSON.parse(readFileSync(join(d, "db.json"), "utf8")) as { comments: Record<string, unknown[]> };
  db.comments["5"]?.push({ id: 11, body: "<!-- factory-question -->\nLater on five?", created_at: "2026-10-25T09:30:00Z" });
  write(join(d, "db.json"), JSON.stringify(db));
  expect(ids(port.read(first.cursor).messages)).toEqual(["c11"]);
});

test("github: the same message id in two threads is read in each, as each thread is folded on its own", () => {
  const q = "<!-- factory-msg v=1 id=q1abc kind=question from=haile -->\nSame?";
  world([issue(5), issue(7)], { 5: [q], 7: [q] });
  expect(new GithubMessaging().read(null).messages.map((m) => [m.id, m.thread])).toEqual([["q1abc", "issue#5"], ["q1abc", "issue#7"]]);
});

test("github: an agent's card is read from its issue body on a full read, without reading its comments", () => {
  const card = "<!-- factory-msg v=1 id=st1abc kind=status from=haile to=dev-manager state=idle -->\nhaile is idle";
  const d = world([issue(9, { body: card, labels: [{ name: "factory:agent" }] })], { 9: ["<!-- factory-question -->\nNot read?"] });
  const port = new GithubMessaging();
  const all = port.read(null);
  expect(all.messages.map((m) => [m.id, m.kind, m.state, m.card, m.thread])).toEqual([["st1abc", "status", "idle", true, "issue#9"]]);
  expect(calls(d).join("\n")).not.toContain("issues/9/comments");
  expect(port.read(all.cursor).messages).toEqual([]); // a card is what an agent is now, not a new message
});

test("github: a read kept to a missing item or a bad ref is refused with code message fix", () => {
  world([issue(5)]);
  const port = new GithubMessaging();
  for (const [ref, code] of [["99", "no-such-item"], ["five", "bad-ref"]] as const) {
    let got: unknown = null;
    try {
      port.read(null, { ref });
    } catch (e) {
      got = e;
    }
    expect((got as { code?: string } | null)?.code, ref).toBe(code);
    expect(typeof (got as { fix?: string }).fix).toBe("string");
  }
});
