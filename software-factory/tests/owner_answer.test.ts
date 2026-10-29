// An owner answer is the owner's (#337): the dev manager's gate refuses to post the `<!-- factory-owner-answer` marker,
// and with `trustedReviewers` set the readers count a marked answer, or a stage's yes, only from those logins.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { comment, GATE, gate, world } from "./manager_support.ts";
import { type Env, factory, issue, poProject, type Row } from "./roles_support.ts";
import { runBun, write } from "./support.ts";

const MARK = "<!-- factory-owner-answer id=ci-queued -->";

function refusedByGate(command: string, files: Record<string, string> = {}): void {
  const [d, env] = world({ comments: [comment("hi")] });
  for (const [name, text] of Object.entries(files)) write(join(d, name), text);
  const [rc, err] = gate(d, env, command);
  expect(rc, `${command} ${err}`).toBe(2);
  expect(err).toContain("owner");
}

test("the manager gate refuses a comment that carries the owner answer marker", () => {
  refusedByGate(`gh issue comment 40 --body "${MARK} ok"`);
  refusedByGate(`gh api -X POST repos/{owner}/{repo}/issues/40/comments -f body="${MARK}"`);
  refusedByGate(`gh api repos/{owner}/{repo}/issues/comments/9 -X PATCH -f 'body=<!--factory-owner-answer id=x --> yes'`);
  refusedByGate("gh issue comment 40 --body-file answer.md", { "answer.md": `${MARK}\nok\n` });
  refusedByGate("gh api -X POST repos/{owner}/{repo}/issues/40/comments -F body=@answer.md", { "answer.md": `${MARK}\n` });
  refusedByGate(`printf '%s' '${MARK}' > a.md && gh issue comment 40 --body-file a.md`);
});

test("the manager gate refuses the marker written with \\u escapes (a JSON body, a GraphQL string)", () => {
  const escaped = "\\u003c!-- factory-owner-answer id=ci-queued -->";
  refusedByGate("gh api -X POST repos/{owner}/{repo}/issues/40/comments --input body.json", { "body.json": `{"body": "${escaped}"}` });
  refusedByGate(`gh api graphql -f query='mutation{addComment(input:{subjectId:"I_1",body:"${escaped}"}){clientMutationId}}'`);
});

test("the manager gate reads a body file from the folder the command runs in", () => {
  const [d, env] = world({ comments: [comment("hi")] });
  write(join(d, "answer.md"), "harmless\n");
  write(join(d, "sub", "answer.md"), `${MARK}\n`);
  const p = runBun(GATE, [], { cwd: d, env, timeoutMs: 60_000,
    input: JSON.stringify({ cwd: join(d, "sub"), tool_input: { command: "gh issue comment 40 --body-file answer.md" } }) });
  expect(p.code, p.stderr).toBe(2);
  expect(p.stderr).toContain("owner");
});

test("the manager gate refuses a comment body it cannot read before the shell runs", () => {
  for (const command of [
    "gh issue comment 40 --body \"$(printf '<!-- factory-owner-%s' answer)\"",
    "gh api -X POST repos/{owner}/{repo}/issues/40/comments -f body=\"$TEXT\"",
    "cat a.md | gh issue comment 40 --body-file -",
    "cat a.md | gh api -X POST repos/{owner}/{repo}/issues/40/comments -F body=@-",
    "cat a.md | gh api -X POST repos/{owner}/{repo}/issues/40/comments -F body=@/dev/stdin",
    "cat a.md | gh issue comment 40 --body-file - # <<",
    "gh issue comment 40 --body-file - <<'EOF'\nhi\nEOF",
    "cat a.md | gh api -X POST repos/{owner}/{repo}/issues/40/comments -F body=@//dev/stdin",
    "cat a.md | gh issue comment 40 --body-file /./dev/stdin",
    "printf '<!-- factory-owner-%s' answer > new.md; gh issue comment 40 --body-file new.md",
    "printf '<!-- factory-owner-%s' answer > old.md; gh issue comment 40 --body-file old.md",
    "printf '<!-- factory-owner-%s' answer >> old.md && gh api -X POST repos/{owner}/{repo}/issues/40/comments -F body=@old.md",
    "gh issue comment 40 --body-file ans*.md",
    "gh issue comment 40 --body-file ans?wer.md",
    "gh api -X POST repos/{owner}/{repo}/issues/40/comments -F body=@ans[w]er.md",
    "gh issue comment 40 --body-file ~/answer.md",
    "gh issue close 40 --comment \"$(cat answer.md)\"",
    "gh issue reopen 40 -c \"$TEXT\"",
    "gh pr close 7 --comment=\"$TEXT\"",
    "gh issue comment 40 --body-file missing.md",
    "gh api -X POST repos/{owner}/{repo}/issues/40/comments -F body=@missing.md",
  ]) {
    const [d, env] = world({ comments: [comment("hi")] });
    write(join(d, "old.md"), "harmless\n");
    write(join(d, "answer.md"), `${MARK}\n`);
    const [rc, err] = gate(d, env, command);
    expect(rc, `${command} ${err}`).toBe(2);
    expect(err).toContain("plain text");
  }
});

test("the manager gate still lets the manager read and write ordinary comments", () => {
  const [d, env] = world({ comments: [comment("hi")] });
  write(join(d, "tmp", "manager-40.md"), "<!-- factory-owner-ask id=ci-queued -->\nCI is `queued`: $5\n");
  for (const command of [
    "gh issue comment 40 --body \"- one\n- two\"",
    "gh issue comment 40 --body-file tmp/manager-40.md",
    "gh issue comment 40 --body \"<!-- factory-owner-ask id=ci-queued -->\nCI is queued\"",
    "gh api -X POST repos/{owner}/{repo}/issues/40/comments -F body=@tmp/manager-40.md",
    "gh api repos/{owner}/{repo}/issues/40/comments -F per_page=100",
    "gh api repos/{owner}/{repo}/issues/40/comments --jq '.[] | select(.body | contains(\"factory-owner-answer\"))'",
  ]) {
    const [rc, err] = gate(d, env, command);
    expect(rc, `${command} ${err}`).toBe(0);
  }
});

function said(body: string, login: string): Row {
  return { body, user: { login }, created_at: "2026-10-29T10:00:00Z" };
}

const ASKS = ["<!-- factory-owner-ask id=ci-queued -->\nCI is queued", "<!-- factory-owner-ask id=renumber -->\nrenumber?"];

function asks(cfg: Row, answer: Row): string[] {
  const db = { issues: [issue(40, "Dev manager: needs the owner")], comments: { "40": [...ASKS.map((b) => said(b, "me")), answer] } };
  const [, work, env] = poProject({ db, cfg });
  const p = factory(work, env, ["handover", "snapshot", "--json"]);
  expect(p.code, p.out).toBe(0);
  return (JSON.parse(p.stdout).ownerAsks as { id: string }[]).map((a) => a.id);
}

test("a marked owner answer counts only from a trusted login", () => {
  const trusted = { trustedReviewers: ["boss"] };
  expect(asks(trusted, said(`${MARK}\nok`, "boss"))).toEqual(["renumber"]);
  expect(asks(trusted, said(`${MARK}\nok`, "me")), "the agents' answer closed the ask").toEqual(["ci-queued", "renumber"]);
  expect(asks({}, said(`${MARK}\nok`, "me")), "with no trusted logins any answer counts, as before").toEqual(["renumber"]);
});

test("a plain reply closes an owner ask only from a trusted login", () => {
  const trusted = { trustedReviewers: ["boss"] };
  expect(asks(trusted, said("noted", "me")), "the agents' reply closed the ask").toEqual(["ci-queued", "renumber"]);
  expect(asks(trusted, said("Yes, renumber them.", "boss"))).toEqual(["ci-queued"]);
  expect(asks({}, said("noted", "me")), "with no trusted logins any reply counts, as before").toEqual(["ci-queued"]);
});

function stageApproval(cfg: Row, answer: Row): string {
  const ask = said("<!-- factory-owner-ask id=stage-vision -->\nIs the vision right?", "me");
  const db = { issues: [issue(101, "Dev manager: needs the owner")], comments: { "101": [ask, answer] } };
  const prd = "# Product requirements\n\n## User stories\n\n- US-1: Follow a guide step by step\n";
  const [, work, env] = poProject({ db, prd, cfg: { tasks: { source: "issues" }, ...cfg } });
  const p = factory(work, env as Env, ["prd", "--stage", "--json"]);
  expect(p.code, p.out).toBe(0);
  return String((JSON.parse(p.stdout) as Row[]).find((r) => r.stage === "vision")?.approval);
}

test("a stage is approved only by a trusted login's answer", () => {
  const trusted = { trustedReviewers: ["boss"] };
  const marked = "<!-- factory-owner-answer id=stage-vision -->\nfine";
  expect(stageApproval(trusted, said(marked, "boss"))).toBe("approved");
  expect(stageApproval(trusted, said("Yes, go ahead.", "boss"))).toBe("approved");
  expect(stageApproval(trusted, said(marked, "me"))).toBe("asked");
  expect(stageApproval(trusted, said("Yes, go ahead.", "me"))).toBe("asked");
  expect(stageApproval({}, said(marked, "me")), "with no trusted logins any answer counts, as before").toBe("approved");
});
