// The Add a project screens' rules (#447): web/add_project_model.ts, with no React in it. The defaults, the folder a
// clone goes into, the team presets from the 12 legends, what stops Continue, the request sent to the server, the
// "What will be created" list and the words for a run's progress.
import { expect, test } from "bun:test";
import { addProtected, createsOf, emptyForm, filterRepos, LEGENDS, pathFor, requestOf, runProgress, setupProblem, sourceProblem,
  teamOf, withRepo } from "../web/add_project_model.ts";

test("the 12 legends, in the design's order", () => {
  expect(LEGENDS).toEqual(["menelik", "taytu", "haile", "tewodros", "yohannes", "zewditu", "lalibela", "ezana", "alula", "abebe", "fasil", "mentewab"]);
});

test("a new form clones from GitHub, takes tasks from issues into main, protects the factory's own files, and has a team of two builders", () => {
  const f = emptyForm("/home/me/dev");
  expect(f.source).toBe("clone");
  expect(f.tasks).toBe("issues");
  expect(f.mainBranch).toBe("main");
  expect(f.visibility).toBe("private");
  expect(f.protected).toEqual([".claude/", ".github/workflows/", "factory", "factory-loop.sh"]);
  expect(f.team).toEqual({ devManager: "fasil", productOwner: "mentewab", builders: ["menelik", "taytu"] });
});

test("a team preset takes its builders from the legends that aren't the dev manager or the product owner", () => {
  expect(teamOf(1).builders).toEqual(["menelik"]);
  expect(teamOf(3).builders).toEqual(["menelik", "taytu", "haile"]);
  expect(teamOf(12).builders.length).toBe(10);
  expect(teamOf(12).builders).not.toContain("fasil");
});

test("picking a repo puts the clone in the folder under its name, unless the owner typed a folder", () => {
  expect(pathFor("/home/me/dev", "boss/shop")).toBe("/home/me/dev/shop");
  expect(pathFor("/home/me/dev/", "boss/shop")).toBe("/home/me/dev/shop");
  const f = withRepo(emptyForm("/home/me/dev"), "boss/shop");
  expect(f.repo).toBe("boss/shop");
  expect(f.path).toBe("/home/me/dev/shop");
  const typed = withRepo({ ...emptyForm("/home/me/dev"), path: "/srv/x", pathEdited: true }, "boss/shop");
  expect(typed.path).toBe("/srv/x");
});

test("the repo search matches every word, in any case", () => {
  const repos = [{ name: "boss/shop", private: true, updatedAt: "", inFactory: null }, { name: "boss/my-skills", private: false, updatedAt: "", inFactory: "my-skills" }];
  expect(filterRepos(repos, "").length).toBe(2);
  expect(filterRepos(repos, "SHOP").map((r) => r.name)).toEqual(["boss/shop"]);
  expect(filterRepos(repos, "boss/").map((r) => r.name)).toEqual(["boss/shop", "boss/my-skills"]);
  expect(filterRepos(repos, "boss nope").length).toBe(0);
});

test("Continue on Add a project waits for a repo or a folder, each with what to do", () => {
  const f = emptyForm("/home/me/dev");
  expect(sourceProblem(f)).toMatch(/pick a repo/i);
  expect(sourceProblem(withRepo(f, "boss/shop"))).toBeNull();
  expect(sourceProblem({ ...f, source: "folder", path: "" })).toMatch(/folder/i);
  expect(sourceProblem({ ...f, source: "folder", path: "dev/shop" })).toMatch(/full path/i);
  expect(sourceProblem({ ...f, source: "folder", path: "/home/me/dev/shop" })).toBeNull();
  expect(sourceProblem({ ...f, source: "new", repo: "shop", path: "/home/me/dev/shop" })).toMatch(/owner\/name/);
  expect(sourceProblem({ ...f, source: "new", repo: "boss/shop", path: "/home/me/dev/shop" })).toBeNull();
});

test("Create waits for a main branch and a team where every agent has its own name", () => {
  const f = withRepo(emptyForm("/d"), "boss/shop");
  expect(setupProblem(f)).toBeNull();
  expect(setupProblem({ ...f, mainBranch: " " })).toMatch(/main branch/i);
  expect(setupProblem({ ...f, team: { ...f.team, builders: [] } })).toMatch(/builder/i);
  expect(setupProblem({ ...f, team: { ...f.team, builders: ["fasil"] } })).toMatch(/same name/i);
  expect(setupProblem({ ...f, team: { ...f.team, builders: ["Big Name"] } })).toMatch(/lowercase/i);
});

test("the request is what the server takes: trimmed, the repo left out for a folder", () => {
  const f = { ...withRepo(emptyForm("/d"), "boss/shop"), test: " bun test ", mainBranch: " main " };
  expect(requestOf(f)).toEqual({ source: "clone", repo: "boss/shop", path: "/d/shop", visibility: "private", tasks: "issues", mainBranch: "main",
    test: "bun test", lint: "", protected: [".claude/", ".github/workflows/", "factory", "factory-loop.sh"],
    team: { devManager: "fasil", productOwner: "mentewab", builders: ["menelik", "taytu"] } });
  expect(requestOf({ ...f, source: "folder" }).repo).toBe("");
});

test("adding a protected path trims it and adds it once", () => {
  expect(addProtected(["a/"], " b/ ")).toEqual(["a/", "b/"]);
  expect(addProtected(["a/"], "a/")).toEqual(["a/"]);
  expect(addProtected(["a/"], "  ")).toEqual(["a/"]);
});

test("What will be created names the labels only for issues, and the keys only with NATS", () => {
  const f = withRepo(emptyForm("/d"), "boss/shop");
  const titles = (x: ReturnType<typeof createsOf>) => x.map((c) => c.title);
  expect(titles(createsOf(f, "github"))).toContain("4 task labels");
  expect(titles(createsOf({ ...f, tasks: "plan" }, "github"))).not.toContain("4 task labels");
  expect(titles(createsOf(f, "github")).some((t) => /key/i.test(t))).toBe(false);
  expect(createsOf(f, "nats").find((c) => /key/i.test(c.title))?.detail).toContain("4 agents");
  expect(titles(createsOf({ ...f, source: "new" }, "github"))[0]).toBe("The repo");
  expect(titles(createsOf(f, "github"))).toContain("The setup pull request");
});

test("a run's progress: how many steps are through, and where it stopped", () => {
  const step = (id: string, state: string, problem: { message: string } | null = null) => ({ id, title: `Step ${id}`, state, problem });
  expect(runProgress({ state: "running", steps: [step("a", "done"), step("b", "skipped"), step("c", "running"), step("d", "waiting")] }))
    .toEqual({ tone: "warn", text: "Step c… (2 of 4 done)" });
  expect(runProgress({ state: "failed", steps: [step("a", "done"), step("b", "failed", { message: "It broke." })] }))
    .toEqual({ tone: "bad", text: "Stopped at Step b: It broke." });
  expect(runProgress({ state: "done", steps: [step("a", "done"), step("b", "skipped")] })).toEqual({ tone: "good", text: "Done: all 2 steps." });
});
