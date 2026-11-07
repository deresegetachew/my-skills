// The rules of the Add a project screens (#447), with no React in them: the form's defaults, the folder a clone goes
// into, the team presets from the 12 legends, what stops Continue, the request the server takes
// (hooks/factory_ui_add.ts), the "What will be created" list and the words for a run's progress.

/** The 12 ready-made agents the owner picks from (the design's RULES.md). */
export const LEGENDS = ["menelik", "taytu", "haile", "tewodros", "yohannes", "zewditu", "lalibela", "ezana", "alula", "abebe",
  "fasil", "mentewab"];

export type Source = "clone" | "folder" | "new";

export const SOURCES: { id: Source; title: string }[] = [
  { id: "clone", title: "Clone from GitHub" },
  { id: "folder", title: "A folder on this machine" },
  { id: "new", title: "Create a new repo" },
];

/** The steps from first launch on, as the stepper on top shows them (Add a project and Set it up are this task's). */
export const SETUP_STEPS = ["Welcome", "Check this machine", "Connect", "Add a project", "Set it up", "Kick off"];

/** The wizard's tabs on Set it up. */
export const WIZARD = ["About the project", "Tasks", "Team", "CI", "Review"];

export const DEFAULT_PROTECTED = [".claude/", ".github/workflows/", "factory", "factory-loop.sh"];

export const TEAM_SIZES = [
  { builders: 1, title: "Small", detail: "One builder: tasks go one at a time" },
  { builders: 2, title: "Standard", detail: "Two builders work side by side" },
  { builders: 3, title: "Full", detail: "Three builders, for a long task list" },
];

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface Team {
  devManager: string;
  productOwner: string;
  builders: string[];
}

export interface Form {
  source: Source;
  repo: string;
  /** The folder clones go into. */
  folder: string;
  path: string;
  /** The owner typed the path: picking a repo leaves it. */
  pathEdited: boolean;
  visibility: "private" | "public";
  tasks: "issues" | "plan" | "board";
  mainBranch: string;
  /** The project's commands (#540): written as given; an empty one is left out, never a template's pnpm guess. */
  install: string;
  typecheck: string;
  lint: string;
  test: string;
  build: string;
  /** The GitHub login whose reviews count; it starts as the login signed in here. */
  reviewer: string;
  protected: string[];
  team: Team;
  /** Pictures chosen for agents (#457), by name, as data URLs; written to .claude/factory/avatars/ by the run. */
  avatars: Record<string, string>;
}

export interface Repo {
  name: string;
  private: boolean;
  updatedAt: string;
  inFactory: string | null;
}

export interface Problem {
  code: string;
  message: string;
  fix: string;
}

export interface RunStep {
  id: string;
  title: string;
  detail?: string;
  state: string;
  command?: string;
  output?: string;
  problem: { message: string; fix?: string } | null;
  /** What only the owner can do, each with its fix (the last step, #540). */
  todos?: { what: string; fix: string }[];
}

export interface Run {
  id?: string;
  name?: string;
  path?: string;
  state: string;
  project?: string | null;
  steps: RunStep[];
}

/** A team with the dev manager fasil, the product owner mentewab and the first `builders` other legends. */
export function teamOf(builders: number): Team {
  return { devManager: "fasil", productOwner: "mentewab", builders: LEGENDS.filter((n) => n !== "fasil" && n !== "mentewab").slice(0, builders) };
}

export function emptyForm(folder: string): Form {
  return { source: "clone", repo: "", folder, path: "", pathEdited: false, visibility: "private", tasks: "issues", mainBranch: "main",
    install: "", typecheck: "", lint: "", test: "", build: "", reviewer: "", protected: [...DEFAULT_PROTECTED], team: teamOf(2),
    avatars: {} };
}

/** Where `repo` (owner/name) is cloned in `folder`. */
export function pathFor(folder: string, repo: string): string {
  const name = repo.split("/").pop() ?? repo;
  return `${folder.replace(/\/+$/, "")}/${name}`;
}

export function withRepo(form: Form, repo: string): Form {
  return { ...form, repo, path: form.pathEdited ? form.path : repo ? pathFor(form.folder, repo) : "" };
}

/** The repos whose name has every word of `query`, in any case. */
export function filterRepos(repos: Repo[], query: string): Repo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return repos.filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
}

/** What stops Continue on Add a project, or null. */
export function sourceProblem(form: Form): string | null {
  if (form.source !== "folder" && !form.repo) return form.source === "clone" ? "Pick a repo from the list." : "Type the new repo's name as owner/name.";
  if (form.source !== "folder" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(form.repo)) return "Type the repo as owner/name.";
  if (!form.path.trim()) return form.source === "folder" ? "Type the project's folder." : "Type the folder to clone into.";
  if (!form.path.trim().startsWith("/")) return "Type the folder as a full path, from the top (/home/…).";
  return null;
}

/** What stops Create on Set it up, or null. */
export function setupProblem(form: Form): string | null {
  if (!form.mainBranch.trim() || /\s/.test(form.mainBranch.trim())) return "Type the main branch, usually main.";
  const t = form.team;
  if (!t.builders.length) return "Pick at least one builder: the first agent plans, the next reviews and merges, the rest build.";
  const names = picksOf(t);
  if (names.some((n) => !AGENT_NAME.test(n))) return "Agent names are lowercase letters, digits and dashes.";
  if (new Set(names).size !== names.length) return "Two agents have the same name: give each its own.";
  return null;
}

/** The request the server takes (POST /api/add-project). */
export function requestOf(form: Form): Record<string, unknown> {
  return { source: form.source, repo: form.source === "folder" ? "" : form.repo.trim(), path: form.path.trim(), visibility: form.visibility,
    tasks: form.tasks, mainBranch: form.mainBranch.trim(), install: form.install.trim(), typecheck: form.typecheck.trim(),
    lint: form.lint.trim(), test: form.test.trim(), build: form.build.trim(), reviewer: form.reviewer.trim(), protected: form.protected,
    team: { devManager: form.team.devManager, productOwner: form.team.productOwner, builders: form.team.builders },
    ...avatarsOf(form) };
}

/** The pictures of the team's own agents, as the request carries them: none when there are none. */
function avatarsOf(form: Form): { avatars?: Record<string, string> } {
  const names = new Set(picksOf(form.team));
  const kept = Object.entries(form.avatars).filter(([n]) => names.has(n));
  return kept.length ? { avatars: Object.fromEntries(kept) } : {};
}

// --- Choose your team (#457) -------------------------------------------------------------------------------------------

export type PresetId = "solo" | "small" | "full" | "custom";

/** The team sizes on Choose your team; `picks` in role order (see teamFromPicks), null for your own mix. */
export const TEAM_PRESETS: { id: PresetId; name: string; what: string; picks: string[] | null }[] = [
  { id: "solo", name: "Just a builder", what: "One agent builds; you plan, review and merge.", picks: ["haile"] },
  { id: "small", name: "A small team", what: "A product owner, a dev manager and one builder.", picks: ["mentewab", "fasil", "haile"] },
  { id: "full", name: "The full team", what: "A product owner, a dev manager and three builders.", picks: ["mentewab", "fasil", "haile", "taytu", "menelik"] },
  { id: "custom", name: "Your own mix", what: "Pick any legends below, or add your own.", picks: null },
];

/** Who each legend is, shown under its name. */
export const LEGEND_WHO: Record<string, string> = {
  mentewab: "Empress Mentewab", fasil: "Emperor Fasilides", menelik: "Menelik II", taytu: "Empress Taytu", haile: "Haile Selassie",
  tewodros: "Tewodros II", yohannes: "Yohannes IV", zewditu: "Empress Zewditu", lalibela: "King Lalibela", ezana: "King Ezana of Aksum",
  alula: "Ras Alula", abebe: "Abebe Bikila",
};

/** The team from the picks in order: the first plans the product, the next reviews and merges, the rest build. One pick
 * alone builds, and you plan, review and merge yourself. */
export function teamFromPicks(picks: string[]): Team {
  if (picks.length === 1) return { productOwner: "", devManager: "", builders: [...picks] };
  return { productOwner: picks[0] ?? "", devManager: picks[1] ?? "", builders: picks.slice(2) };
}

/** The team's agents in pick order (the inverse of teamFromPicks). */
export function picksOf(t: Team): string[] {
  return [t.productOwner, t.devManager, ...t.builders].filter((n) => n !== "");
}

/** The role of the `i`th of `n` picks, in words. */
export function roleNameOf(i: number, n: number): string {
  if (n === 1 || i >= 2) return "Builder";
  return i === 0 ? "Product owner" : "Dev manager";
}

/** The preset the team is, or your own mix. */
export function presetOf(t: Team): PresetId {
  const picks = picksOf(t).join(",");
  return TEAM_PRESETS.find((p) => p.picks && p.picks.join(",") === picks)?.id ?? "custom";
}

export function withPreset(form: Form, id: PresetId): Form {
  const p = TEAM_PRESETS.find((x) => x.id === id);
  return p?.picks ? { ...form, team: teamFromPicks(p.picks) } : form;
}

function withPicks(form: Form, picks: string[]): Form {
  return { ...form, team: teamFromPicks(picks) };
}

/** A legend tapped: added at the end, or taken out. */
export function togglePick(form: Form, name: string): Form {
  const picks = picksOf(form.team);
  return withPicks(form, picks.includes(name) ? picks.filter((n) => n !== name) : [...picks, name]);
}

/** Your own agent: added at the end with the first free name agent-1, agent-2, ..., to rename. */
export function addPick(form: Form): Form {
  const picks = picksOf(form.team);
  let i = 1;
  while (picks.includes(`agent-${i}`)) i++;
  return withPicks(form, [...picks, `agent-${i}`]);
}

/** An agent renamed in its place; its picture goes with it. The name is checked by setupProblem. */
export function renamePick(form: Form, from: string, to: string): Form {
  const picks = picksOf(form.team).map((n) => (n === from ? to : n));
  const avatars = Object.fromEntries(Object.entries(form.avatars).map(([n, v]) => [n === from ? to : n, v]));
  return { ...withPicks(form, picks), avatars };
}

/** The pictures the server takes, and their largest size (as for an image in .claude/factory/avatars, #437). */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const AVATAR_MAX_BYTES = 256 * 1024;

/** What is wrong with a picked picture file, or null. */
export function avatarProblem(file: { type: string; size: number }): string | null {
  if (!AVATAR_TYPES.includes(file.type)) return "Pick a PNG, JPEG, WebP or GIF picture.";
  if (file.size > AVATAR_MAX_BYTES) return "That picture is over 256 KB: pick a smaller one.";
  return null;
}

export function addProtected(list: string[], text: string): string[] {
  const p = text.trim();
  return !p || list.includes(p) ? list : [...list, p];
}

/** "What will be created", beside the wizard. */
export function createsOf(form: Form): { title: string; where: string; detail: string }[] {
  return [
    ...(form.source === "new" ? [{ title: "The repo", where: "GitHub", detail: `${form.repo || "owner/name"}, ${form.visibility}, with a README` }] : []),
    { title: "Role folders", where: "Repo", detail: "One for the product owner, the dev manager and the builders" },
    ...(form.tasks === "issues" ? [{ title: "4 task labels", where: "GitHub", detail: "Ready, in progress, in review, blocked" }] : []),
    { title: "The owner queue", where: "GitHub issue", detail: "One issue where the agents ask what only you decide" },
    { title: "A starter PRD", where: "Repo", detail: `docs/PRD.md with headings for ${form.team.productOwner || "you"} to fill in${form.team.productOwner ? " with you" : ""}` },
    ...(Object.keys(avatarsOf(form).avatars ?? {}).length ? [{ title: "Your agents' pictures", where: "Repo", detail: "One picture for each agent you gave one" }] : []),
    { title: "Your answers", where: "Repo", detail: "Task source, protected paths, commands and the team, saved in the project" },
    { title: "What agents may run", where: "Repo", detail: "Your commands, allowed for unattended agents and run by CI" },
    { title: "The trusted reviewer", where: "Repo", detail: `${form.reviewer || "Your GitHub login"}: only these reviews count at a merge` },
    { title: "The setup pull request", where: "GitHub", detail: "All of the above, for you to merge" },
  ];
}

/** A run's progress in words, with its tone. */
export function runProgress(run: Run): { tone: "good" | "warn" | "bad"; text: string } {
  const through = run.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  if (run.state === "failed") {
    const f = run.steps.find((s) => s.state === "failed");
    return { tone: "bad", text: `Stopped at ${f?.title ?? "a step"}${f?.problem ? `: ${f.problem.message}` : "."}` };
  }
  const todos = run.steps.reduce((n, s) => n + (s.todos?.length ?? 0), 0);
  if (run.state === "done" && todos) {
    return { tone: "warn", text: `Done: all ${run.steps.length} steps. ${todos} to-do${todos === 1 ? "" : "s"} for you, below.` };
  }
  if (run.state === "done") return { tone: "good", text: `Done: all ${run.steps.length} steps.` };
  const now = run.steps.find((s) => s.state === "running");
  return { tone: "warn", text: `${now ? `${now.title}…` : "Starting…"} (${through} of ${run.steps.length} done)` };
}
