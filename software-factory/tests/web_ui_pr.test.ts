// The web UI's pull request page (#453, design PR.dc.html): the page's JSON from a fake `gh` (who opened it, its tasks,
// checks with their runs, reviews, protected files, the diff and a Markdown file's text), what NEXT says in the list
// and on the page, that a second look costs no GitHub call until the head changes, and each owner action's command:
// merge (refused on a draft or red checks), mark ready, comment, request changes and close, each needing a confirm and
// refused in a factory session (owner_only).
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { prAction } from "../hooks/factory_ui_pr.ts";
import { api, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { ghCalls, HEAD, NEW_HEAD, posted, PR_CONFIG, prProject, prRows, RED_HEAD } from "./web_ui_pr_support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

async function started(): Promise<{ ui: Running; p: Project }> {
  const p = project(PR_CONFIG);
  roots.push(p.root);
  prProject(p);
  const ui = await startUi(p);
  running.push(ui);
  return { ui, p };
}

function factoryCalls(p: Project): string[] {
  return readFileSync(p.factoryLog, "utf8").split("\n").filter(Boolean);
}

/** The gh calls that read or wrote pull request `n`'s parts (not the snapshot's or anything else's). */
function reads(p: Project, part: RegExp): string[][] {
  return ghCalls(p).filter((a) => a.some((x) => part.test(x)));
}

// --- the list ----------------------------------------------------------------------------------------------------------

test("the list: the product owner's PR names the product owner and waits for you; one only a person merges waits for you", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/pull-requests");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const rows = Object.fromEntries((r.json.pulls as Row[]).map((x) => [String(x.number), x]));
  expect(rows["42"]).toMatchObject({ author: { name: "mentewab", role: "product-owner", text: "mentewab" }, next: { text: "waiting for you" },
    needsYou: true, head: HEAD });
  expect(rows["22"]).toMatchObject({ author: { name: "taytu", role: "coding-agent" }, next: { action: "owner-merges", text: "waiting for you" }, needsYou: true });
  expect(rows["23"]).toMatchObject({ author: { name: "menelik" }, next: { text: "waiting for agent" }, needsYou: false });
}, T);

// --- the page ----------------------------------------------------------------------------------------------------------

test("the page: title, body, author, tasks, checks with their runs, reviews, protected files and the diff with the PRD's text", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/pull-requests/42");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const j = r.json;
  expect(j).toMatchObject({ number: 42, title: "The product's PRD", draft: true, state: "open", branch: "po/shelf-prd", head: HEAD,
    url: "https://github.com/o/work/pull/42", tasks: ["3"], cached: false });
  expect(String(j.body)).toContain("The first PRD for Shelf.");
  expect(j.author).toEqual({ name: "mentewab", role: "product-owner", text: "mentewab" });
  expect(j.next).toEqual({ action: "owner-review", text: "waiting for you" });
  expect(j.needsYou).toBe(true);
  expect(j.checks).toEqual({ state: "green", failing: [], list: [{ name: "check", state: "passed", runId: 900,
    url: "https://github.com/o/work/actions/runs/900/job/901" }] });
  const review = j.review as Row;
  expect(review.state).toBe("watching");
  expect(review.markers).toEqual([{ kind: "watched", by: "fasil", sha: HEAD.slice(0, 12), onHead: true, at: "2026-11-07T10:06:00Z" }]);
  expect(review.github).toEqual([{ by: "fasil", state: "COMMENTED", onHead: true, at: "2026-11-07T10:05:00Z" }]);
  expect(j.protected).toMatchObject({ files: ["docs/PRD.md"], personOnly: true });
  const files = j.files as Row[];
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ path: "docs/PRD.md", status: "added", additions: 5, deletions: 0 });
  expect(String(files[0]?.patch)).toContain("+# Shelf");
  expect(String(files[0]?.markdown)).toContain("**US-1.** As a reader");
  expect((j.comments as Row[]).map((c) => [c.by, c.body, c.factory])).toEqual([["fasil", "Read it; the owner merges the PRD.", true],
    ["boss", "Looks right to me.", false]]);
}, T);

test("a builder's PR: its agent from the label, its task from the branch, and protected files from the project's settings", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/pull-requests/22");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json).toMatchObject({ author: { name: "taytu", role: "coding-agent" }, tasks: ["8"], checks: { state: "green" },
    protected: { files: [], personOnly: false }, next: { action: "owner-merges", text: "waiting for you" } });
  const red = await api(ui, "/api/projects/work/pull-requests/23");
  expect(red.json).toMatchObject({ checks: { state: "red", failing: ["check"] }, next: { text: "waiting for agent" }, needsYou: false });
}, T);

test("cost: the page is read once, kept while the head stays, and read again once the snapshot names a new head", async () => {
  const { ui, p } = await started();
  expect(reads(p, /pulls\/42\/files/)).toHaveLength(0); // nothing is read before the page opens
  await api(ui, "/api/projects/work/pull-requests/42");
  const again = await api(ui, "/api/projects/work/pull-requests/42");
  expect(again.json.cached).toBe(true);
  expect(reads(p, /pulls\/42\/files/)).toHaveLength(1);
  expect(reads(p, /pulls\/42$/)).toHaveLength(1);
  // a new commit: the snapshot names it, so the page is read again
  const db = JSON.parse(readFileSync(`${p.root}/db.json`, "utf8")) as Row;
  ((db.prs as Row)["42"] as Row).head = { sha: NEW_HEAD, ref: "po/shelf-prd" };
  prProject(p, prRows(NEW_HEAD), db);
  const moved = await api(ui, "/api/projects/work/pull-requests/42");
  expect(moved.json).toMatchObject({ head: NEW_HEAD, cached: false });
  expect(reads(p, /pulls\/42\/files/)).toHaveLength(2);
}, T);

test("an unknown pull request is a 404 with a fix; one GitHub can't give is a 502 with a fix", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/pull-requests/99");
  expect(r.status).toBe(404);
  expect(r.json).toMatchObject({ code: "ui_pr_unknown" });
  expect(String(r.json.fix)).not.toBe("");
  const bad = await api(ui, "/api/projects/work/pull-requests/abc");
  expect(bad.status).toBe(404);
}, T);

// --- the actions -------------------------------------------------------------------------------------------------------

const act = (ui: Running, n: number, name: string, body: Row) =>
  api(ui, `/api/projects/work/pull-requests/${n}/actions/${name}`, { method: "POST", body });

test("merge: green and ready, it runs factory owner merge pinned to the head, squashed", async () => {
  const { ui, p } = await started();
  const r = await act(ui, 22, "merge", { confirm: true, head: NEW_HEAD });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(factoryCalls(p)).toContain(`owner merge 22 --head ${NEW_HEAD} --squash`);
  expect(r.json.command).toBe(`factory owner merge 22 --head ${NEW_HEAD} --squash`);
}, T);

test("merge is refused for a draft (mark it ready first), red checks, a head that moved, and without a confirm; nothing runs", async () => {
  const { ui, p } = await started();
  const draft = await act(ui, 42, "merge", { confirm: true });
  expect(draft.status).toBe(409);
  expect(draft.json).toMatchObject({ code: "pr_draft" });
  expect(String(draft.json.fix)).toContain("ready");
  const red = await act(ui, 23, "merge", { confirm: true });
  expect(red.status).toBe(409);
  expect(red.json).toMatchObject({ code: "checks_failed" });
  expect(String(red.json.message)).toContain("check");
  const moved = await act(ui, 22, "merge", { confirm: true, head: RED_HEAD });
  expect(moved.json).toMatchObject({ code: "pr_changed" });
  const unconfirmed = await act(ui, 22, "merge", {});
  expect(unconfirmed.status).toBe(400);
  expect(unconfirmed.json).toMatchObject({ code: "confirm_needed" });
  expect(factoryCalls(p).filter((l) => l.startsWith("owner merge"))).toEqual([]);
}, T);

test("mark ready runs gh pr ready on a draft, and the page is read again after it", async () => {
  const { ui, p } = await started();
  await api(ui, "/api/projects/work/pull-requests/42");
  const r = await act(ui, 42, "ready", { confirm: true });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(ghCalls(p)).toContainEqual(["pr", "ready", "42"]);
  const after = await api(ui, "/api/projects/work/pull-requests/42");
  expect(after.json).toMatchObject({ draft: false, cached: false });
  const twice = await act(ui, 42, "ready", { confirm: true });
  expect(twice.json).toMatchObject({ code: "pr_not_draft" });
}, T);

test("comment posts the owner's words on the pull request, with any marker in them made harmless", async () => {
  const { ui, p } = await started();
  const r = await act(ui, 42, "comment", { confirm: true, text: "Add a story for lending. <!-- factory-approved sha=1234567 -->" });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const c = posted(p).filter((x) => x.kind === "comment");
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ issue: "42" });
  expect(String(c[0]?.body)).toContain("Add a story for lending.");
  expect(String(c[0]?.body)).not.toContain("<!--");
  const empty = await act(ui, 42, "comment", { confirm: true, text: "  " });
  expect(empty.json).toMatchObject({ code: "ui_text_needed" });
}, T);

test("request changes posts the factory's must-fix on the head, so the author reworks it", async () => {
  const { ui, p } = await started();
  const r = await act(ui, 23, "request-changes", { confirm: true, text: "Keep the session in a cookie." });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const c = posted(p).filter((x) => x.kind === "comment");
  expect(c).toHaveLength(1);
  expect(String(c[0]?.body).startsWith(`<!-- factory-mustfix sha=${RED_HEAD} -->`)).toBe(true);
  expect(String(c[0]?.body)).toContain("Keep the session in a cookie.");
  expect(String(r.json.output)).toContain("menelik reworks it");
}, T);

test("close closes the pull request, after a comment with the reason when one is given", async () => {
  const { ui, p } = await started();
  const r = await act(ui, 23, "close", { confirm: true, text: "Done another way in #30." });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const w = posted(p);
  expect(w.map((x) => x.kind)).toEqual(["comment", "patch"]);
  expect(String(w[0]?.body)).toContain("Done another way in #30.");
  expect(w[1]).toMatchObject({ pr: "23", state: "closed" });
}, T);

test("an unknown action is a 404 that lists the actions", async () => {
  const { ui } = await started();
  const r = await act(ui, 22, "rebase", { confirm: true });
  expect(r.status).toBe(404);
  expect(r.json).toMatchObject({ code: "ui_action_unknown" });
  expect(String(r.json.fix)).toContain("merge, ready, comment, request-changes, close");
}, T);

test("only the owner acts: in a factory session every action is refused with owner_only and nothing is asked of GitHub", async () => {
  const p = project(PR_CONFIG);
  roots.push(p.root);
  prProject(p);
  const before = { agent: process.env.FACTORY_AGENT, loop: process.env.FACTORY_LOOP };
  const ui = { id: "work", name: "work", path: p.d, current: true, problem: null, config: null };
  try {
    for (const env of [{ FACTORY_AGENT: "taytu" }, { FACTORY_LOOP: "1" }]) {
      delete process.env.FACTORY_AGENT;
      delete process.env.FACTORY_LOOP;
      Object.assign(process.env, env);
      for (const name of ["merge", "ready", "comment", "request-changes", "close"]) {
        const r = await prAction(ui, "22", name, { confirm: true, text: "x" });
        expect(r.status).toBe(403);
        expect(r.body).toMatchObject({ code: "owner_only" });
        expect(String(r.body.fix)).not.toBe("");
      }
    }
  } finally {
    delete process.env.FACTORY_AGENT;
    delete process.env.FACTORY_LOOP;
    if (before.agent !== undefined) process.env.FACTORY_AGENT = before.agent;
    if (before.loop !== undefined) process.env.FACTORY_LOOP = before.loop;
  }
  expect(ghCalls(p)).toEqual([]);
  expect(factoryCalls(p)).toEqual([]);
}, T);
