// What the docs and the skills say about the board, where the fresh-install test found a gap (#520).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { KIT, read, readmeAndWiki } from "./support.ts";

test("the next-task skill keeps board_claim's token for board_heartbeat, board_release and board_close", () => {
  const skill = read(join(KIT, ".claude", "skills", "next-task", "board.md"));
  expect(skill).toContain("`board_claim` it and keep the token");
  for (const tool of ["board_heartbeat", "board_release", "board_close"]) {
    expect(skill, tool).toMatch(new RegExp(`token to\\s+\`${tool}\`|token[^.]*\`${tool}\``));
  }
});

test("the wiki says which board tasks the web UI's Board page leaves out, and where to see them", () => {
  const wiki = readmeAndWiki("board.md");
  expect(wiki).toContain("**What the Board page shows.**");
  expect(wiki).toContain("Done column");
  expect(wiki).toContain("`factory board tasks --all`");
  expect(wiki).toContain("`factory board status`");
});
