// The citations in a text (`decision 0004`, `ADR 5`, `US-12`): the one rule the task trackers, `factory prs` and the web UI share.
import { expect, test } from "bun:test";
import { citesIn } from "../hooks/factory_cites.ts";

test("citations come out as written, in first-seen order, once each", () => {
  expect(citesIn("See decision 0004, then US-12 and ADR 5. Again: decision 0004, us-3, Decision #7.")).toEqual(
    ["decision 0004", "US-12", "ADR 5", "us-3", "Decision #7"]);
});

test("what is not a citation is left out", () => {
  expect(citesIn("US- alone, decisions 4, ADR with no number, PROADR 4, and nothing else")).toEqual([]);
  expect(citesIn("")).toEqual([]);
});

test("at most 20 are returned", () => {
  const text = Array.from({ length: 30 }, (_, i) => `US-${i + 1}`).join(" ");
  expect(citesIn(text)).toEqual(Array.from({ length: 20 }, (_, i) => `US-${i + 1}`));
});
