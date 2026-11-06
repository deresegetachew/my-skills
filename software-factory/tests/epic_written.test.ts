// Where an epic is written down (#440): its PRD, its decisions and its citations, linked through the same rule the tasks
// use (citeLinks in web/docs_model.ts, the rule in hooks/factory_cites.ts).
import { expect, test } from "bun:test";
import { writtenDown } from "../web/epics_model.ts";

const pages = [{ id: "prd", title: "PRD", path: "software-factory/docs/PRD.md" },
  { id: "decisions/0004-nats", title: "Decision 0004: NATS", path: "software-factory/docs/decisions/0004-nats.md" },
  { id: "decisions/0005-web-ui", title: "Decision 0005: the web UI", path: "software-factory/docs/decisions/0005-web-ui.md" }];

test("the PRD file, the decisions line and the citations each link to their page, once", () => {
  const w = writtenDown({ title: "Epics, see ADR 5", prd: "software-factory/docs/PRD.md", decisions: ["0004"], cites: ["ADR 5", "decision 0004", "US-12"] }, pages);
  expect(w).toEqual([
    { name: "PRD", tag: "PRD", channel: "doc:prd" },
    { name: "Decision 0004: NATS", tag: "Decision", channel: "doc:decisions/0004-nats" },
    { name: "Decision 0005: the web UI", tag: "Decision", channel: "doc:decisions/0005-web-ui" },
    { name: "PRD: US-12", tag: "Story", channel: "doc:prd#us-12" },
  ]);
});

test("a decision with no page is listed without a link; a citation with none is left out", () => {
  const w = writtenDown({ title: "T", prd: "docs/missing.md", decisions: ["0009"], cites: ["decision 0010"] }, pages);
  expect(w).toEqual([{ name: "docs/missing.md", tag: "PRD", channel: null }, { name: "Decision 0009", tag: "Decision", channel: null }]);
});

test("an epic that cites nothing is written down nowhere", () => {
  expect(writtenDown({ title: "T", prd: "", decisions: [] }, pages)).toEqual([]);
});
