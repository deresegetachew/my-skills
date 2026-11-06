// The citations in a text (#438): a decision (`decision 0004`, `ADR 5`, `ADR #5`) or a PRD story (`US-12`). The task
// trackers and `factory prs` read them from a body, and the web UI links each one that has a Docs page. One rule for all;
// it is written in core/domain/cites.ts (the domain may import only the domain, decision 0003) and found here.
export { CITE, citesIn } from "./core/domain/cites.ts";
