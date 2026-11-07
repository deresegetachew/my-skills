// The in-memory TaskTracker adapter passes the port's contract (decision 0003, #377).
import { MemoryTaskTracker } from "../hooks/core/adapters/memory/task_tracker.ts";
import { taskTrackerContract } from "./contracts/task_tracker.ts";

taskTrackerContract("memory", (specs) => {
  const port = new MemoryTaskTracker();
  const ids = specs.map((s, k) => port.add({ title: s.title ?? `Task ${k + 1}`, state: s.state ?? "ready",
    dependsOn: (s.dependsOn ?? []).map((d) => String(d + 1)),
    todos: Array.from({ length: s.todos ?? 0 }, (_, j) => ({ text: `todo ${j + 1}`, done: false })),
    prdChange: s.prd ? "500" : undefined }));
  return { port, ids, missing: "99", foreign: "1.3", rival: (id, who) => port.rival(id, who), prd: "500", mergePrd: () => port.mergePrd("500") };
});
