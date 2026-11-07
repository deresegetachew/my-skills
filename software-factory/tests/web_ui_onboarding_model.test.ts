// The first-launch screens' rules (#457), from web/onboarding_model.ts and web/add_project_model.ts as they are (no
// React): Welcome's three ways in and when it opens by itself, the Machine check's rows from the Health answer (the one
// admin step that must be typed with sudo shown as it is), the join code's checks and what a code connects to, and
// Choose your team (the presets, the 12 legends in order of the picks, solo, your own agent, rename and picture).
import { expect, test } from "bun:test";
import { addPick, AVATAR_MAX_BYTES, avatarProblem, emptyForm, picksOf, presetOf, renamePick, requestOf, roleNameOf, setupProblem, TEAM_PRESETS,
  teamFromPicks, togglePick, withPreset, withRepo } from "../web/add_project_model.ts";
import { firstLaunch, joinHolds, joinProblem, machineCheck, onboardingRoute, WELCOME_CHOICES } from "../web/onboarding_model.ts";
import type { HealthData } from "../web/ops_model.ts";

// --- Welcome -------------------------------------------------------------------------------------------------------------

test("Welcome offers three ways in, the first the primary: start here, join my factory, open a project", () => {
  expect(WELCOME_CHOICES.map((c) => [c.title, c.cta, c.hash, c.primary])).toEqual([
    ["Start the factory here", "Start here", "#/setup/machine", true],
    ["Join my factory", "Paste a join code", "#/setup/join", false],
    ["Open a project", "Choose a folder", "#/add-project", false],
  ]);
  for (const c of WELCOME_CHOICES) expect(c.body).not.toMatch(/factory [a-z]+ |--/); // no command on screen
});

test("the onboarding addresses: welcome, the machine check and join; anything else is not onboarding", () => {
  expect(onboardingRoute("#/welcome")).toBe("welcome");
  expect(onboardingRoute("#/setup/machine")).toBe("machine");
  expect(onboardingRoute("#/setup/join")).toBe("join");
  expect(onboardingRoute("#/add-project")).toBeNull();
  expect(onboardingRoute("")).toBeNull();
  expect(onboardingRoute("#work/page:home")).toBeNull();
});

test("Welcome opens by itself only in a browser that has never opened a project nor left Welcome", () => {
  expect(firstLaunch(null, false, "")).toBe(true);
  expect(firstLaunch("work", false, "")).toBe(false); // it has used the UI before
  expect(firstLaunch(null, true, "")).toBe(false); // it left Welcome once
  expect(firstLaunch(null, false, "#work/page:home")).toBe(false); // a link to a page opens that page
  expect(firstLaunch(null, false, "#/add-project")).toBe(false);
});

// --- Machine check -------------------------------------------------------------------------------------------------------

const SUDO = "Run once in a terminal on this machine:\nsudo factory bootstrap machine\nsudo factory bootstrap machine --apply";

function health(more: Partial<HealthData> = {}): HealthData {
  return { ranAt: "2026-11-07T09:57:00Z", ok: false, running: false, counts: { ok: 4, warning: 1, failed: 2 }, problems: [],
    groups: [
      { id: "machine", title: "This machine", checks: [{ level: "ok", what: "git", fix: "" }, { level: "failed", what: "node is missing", fix: "Install Node 20 or newer." },
        { level: "ok", what: "bun 1.3", fix: "" }, { level: "failed", what: "the network guard isn't set up", fix: SUDO }] },
      { id: "project", title: "The project", checks: [{ level: "warning", what: "trustedReviewers is empty", fix: "Set it." }] },
      { id: "board", title: "The board", checks: [{ level: "ok", what: "the message board answers", fix: "" }] },
      { id: "github", title: "GitHub", checks: [{ level: "ok", what: "gh is signed in", fix: "" }] },
    ], ...more };
}

test("Machine check shows this machine, the board and GitHub, not the project's checks, and counts what is ready", () => {
  const m = machineCheck(health());
  expect(m.groups.map((g) => g.title)).toEqual(["This machine", "The board", "GitHub"]);
  expect(m.summary).toBe("4 of 6 ready. Checking changes nothing.");
  expect(m.ready).toBe(false);
  const rows = m.groups[0]?.rows ?? [];
  expect(rows.map((r) => [r.name, r.state, r.tone])).toEqual([
    ["git", "Ready", "good"], ["node is missing", "Needs a fix", "warn"], ["bun 1.3", "Ready", "good"],
    ["the network guard isn't set up", "Needs you", "bad"],
  ]);
  expect(rows[1]?.fix).toBe("Install Node 20 or newer.");
  expect(rows[1]?.admin).toBeNull();
});

test("Machine check: a fix that must be typed with sudo is shown as its lines, to copy; the words around it stay words", () => {
  const row = machineCheck(health()).groups[0]?.rows[3];
  expect(row?.admin).toBe("sudo factory bootstrap machine\nsudo factory bootstrap machine --apply");
  expect(row?.fix).toBe("Run once in a terminal on this machine:");
});

test("Machine check: a note is worth a look but doesn't stop Continue; with every check ok it is ready", () => {
  const notes = health({ groups: [{ id: "machine", title: "This machine", checks: [{ level: "ok", what: "git", fix: "" }, { level: "warning", what: "docker is old", fix: "Update it." }] }] });
  const m = machineCheck(notes);
  expect(m.groups[0]?.rows[1]?.state).toBe("Worth a look");
  expect(m.ready).toBe(true);
  expect(m.summary).toBe("1 of 2 ready. Checking changes nothing.");
});

test("Machine check: while the first run goes it says so; a run that failed says what went wrong and how to fix it", () => {
  expect(machineCheck(health({ ranAt: null, running: true, groups: [] })).summary).toBe("Checking this machine…");
  expect(machineCheck(null).summary).toBe("Checking this machine…");
  const failed = machineCheck(health({ ranAt: null, groups: [], problems: [{ code: "ui_doctor_unreadable", message: "The checks didn't give a result.", fix: "Press Check again." }] }));
  expect(failed.summary).toBe("The checks didn't give a result. Press Check again.");
  expect(failed.ready).toBe(false);
});

// --- Join my factory -----------------------------------------------------------------------------------------------------

test("a join code is pasted whole: empty, or not starting with FM1-, says what to do", () => {
  expect(joinProblem("")).toMatch(/paste the join code/i);
  expect(joinProblem("  ")).toMatch(/paste the join code/i);
  expect(joinProblem("hello")).toMatch(/FM1-/);
  expect(joinProblem(" FM1-abc ")).toBeNull();
});

test("what a code connects to: the hub, this machine's name, the agents with their roles in words, when it expires", () => {
  const rows = joinHolds({ machine: "office-pc", hub: "100.64.0.1:5432", agents: [{ name: "menelik", role: "builder" }, { name: "fasil", role: "manager" }],
    expiresAt: Date.parse("2026-11-07T10:15:00Z") / 1000 }, Date.parse("2026-11-07T10:00:00Z"));
  expect(rows).toEqual([
    { label: "Hub", value: "100.64.0.1:5432", sub: "The message board" },
    { label: "This machine", value: "office-pc", sub: "Its own board login, kept here only" },
    { label: "Agents", value: "menelik, fasil", sub: "Builder, Dev manager" },
    { label: "Expires", value: "in 15 min", sub: "The code works once" },
  ]);
  const late = joinHolds({ machine: "x", hub: "h", agents: [{ name: "a", role: "po" }], expiresAt: 1 }, Date.parse("2026-11-07T10:00:00Z"));
  expect(late[2]?.sub).toBe("Product owner");
  expect(late[3]?.value).toBe("expired");
});

// --- Choose your team ----------------------------------------------------------------------------------------------------

test("the four team presets: just a builder, a small team, the full team, your own mix", () => {
  expect(TEAM_PRESETS.map((p) => [p.id, p.name, p.picks])).toEqual([
    ["solo", "Just a builder", ["haile"]],
    ["small", "A small team", ["mentewab", "fasil", "haile"]],
    ["full", "The full team", ["mentewab", "fasil", "haile", "taytu", "menelik"]],
    ["custom", "Your own mix", null],
  ]);
});

test("the picks in order make the team: the first plans, the next reviews and merges, the rest build; one alone builds", () => {
  expect(teamFromPicks(["mentewab", "fasil", "haile", "taytu"])).toEqual({ productOwner: "mentewab", devManager: "fasil", builders: ["haile", "taytu"] });
  expect(teamFromPicks(["haile"])).toEqual({ productOwner: "", devManager: "", builders: ["haile"] });
  expect(picksOf({ productOwner: "mentewab", devManager: "fasil", builders: ["haile"] })).toEqual(["mentewab", "fasil", "haile"]);
  expect(picksOf({ productOwner: "", devManager: "", builders: ["haile"] })).toEqual(["haile"]);
  expect([0, 1, 2].map((i) => roleNameOf(i, 3))).toEqual(["Product owner", "Dev manager", "Builder"]);
  expect(roleNameOf(0, 1)).toBe("Builder");
});

test("a preset is recognised from the team, and anything else is your own mix", () => {
  const f = emptyForm("/d");
  expect(presetOf(withPreset(f, "solo").team)).toBe("solo");
  expect(presetOf(withPreset(f, "full").team)).toBe("full");
  expect(presetOf(withPreset(f, "small").team)).toBe("small");
  expect(presetOf(f.team)).toBe("custom"); // fasil, mentewab and two builders
  expect(withPreset(f, "custom").team).toEqual(f.team); // your own mix keeps what is picked
});

test("tapping a legend adds it at the end or takes it out; the roles follow the order", () => {
  const f = withPreset(emptyForm("/d"), "small");
  const more = togglePick(f, "zewditu");
  expect(picksOf(more.team)).toEqual(["mentewab", "fasil", "haile", "zewditu"]);
  expect(more.team.builders).toEqual(["haile", "zewditu"]);
  const less = togglePick(more, "mentewab");
  expect(picksOf(less.team)).toEqual(["fasil", "haile", "zewditu"]);
  expect(less.team.productOwner).toBe("fasil");
});

test("your own agent gets a free name of its own, and a rename moves its picture with it", () => {
  let f = withPreset(emptyForm("/d"), "solo");
  f = addPick(f);
  expect(picksOf(f.team)).toEqual(["haile", "agent-1"]);
  f = addPick(f);
  expect(picksOf(f.team)).toEqual(["haile", "agent-1", "agent-2"]);
  f = { ...f, avatars: { "agent-1": "data:image/png;base64,iVBORw0KGgo=" } };
  const r = renamePick(f, "agent-1", "kebede");
  expect(picksOf(r.team)).toEqual(["haile", "kebede", "agent-2"]);
  expect(r.avatars).toEqual({ kebede: "data:image/png;base64,iVBORw0KGgo=" });
});

test("a solo team is fine; two agents and no builder, or a renamed clash, stop Create with what to do", () => {
  const f = withRepo(emptyForm("/d"), "boss/shop");
  expect(setupProblem(withPreset(f, "solo"))).toBeNull();
  expect(setupProblem({ ...f, team: teamFromPicks(["mentewab", "fasil"]) })).toMatch(/builder/i);
  expect(setupProblem(renamePick(withPreset(f, "small"), "haile", "fasil"))).toMatch(/same name/i);
  expect(setupProblem(renamePick(withPreset(f, "small"), "haile", "Haile"))).toMatch(/lowercase/i);
});

test("a picture is a PNG, JPEG, WebP or GIF of 256 KB at most", () => {
  expect(avatarProblem({ type: "image/png", size: 1000 })).toBeNull();
  expect(avatarProblem({ type: "image/jpeg", size: AVATAR_MAX_BYTES })).toBeNull();
  expect(avatarProblem({ type: "image/svg+xml", size: 100 })).toMatch(/PNG, JPEG, WebP or GIF/);
  expect(avatarProblem({ type: "image/png", size: AVATAR_MAX_BYTES + 1 })).toMatch(/256 KB/);
});

test("the request carries the pictures of the team's agents only, and none when there are none", () => {
  const f = withPreset(withRepo(emptyForm("/d"), "boss/shop"), "solo");
  expect("avatars" in requestOf(f)).toBe(false);
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const r = requestOf({ ...f, avatars: { haile: png, gone: png } });
  expect(r.avatars).toEqual({ haile: png });
  expect(r.team).toEqual({ devManager: "", productOwner: "", builders: ["haile"] });
});
