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
  tasks: "issues" | "plan";
  mainBranch: string;
  test: string;
  lint: string;
  protected: string[];
  team: Team;
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
    test: "", lint: "", protected: [...DEFAULT_PROTECTED], team: teamOf(2) };
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
  if (!t.builders.length) return "Pick at least one builder.";
  const names = [t.devManager, t.productOwner, ...t.builders];
  if (names.some((n) => !AGENT_NAME.test(n))) return "Agent names are lowercase letters, digits and dashes.";
  if (new Set(names).size !== names.length) return "Two agents have the same name: give each its own.";
  return null;
}

/** The request the server takes (POST /api/add-project). */
export function requestOf(form: Form): Record<string, unknown> {
  return { source: form.source, repo: form.source === "folder" ? "" : form.repo.trim(), path: form.path.trim(), visibility: form.visibility,
    tasks: form.tasks, mainBranch: form.mainBranch.trim(), test: form.test.trim(), lint: form.lint.trim(), protected: form.protected,
    team: { devManager: form.team.devManager, productOwner: form.team.productOwner, builders: form.team.builders } };
}

export function addProtected(list: string[], text: string): string[] {
  const p = text.trim();
  return !p || list.includes(p) ? list : [...list, p];
}

/** "What will be created", beside the wizard. */
export function createsOf(form: Form, messaging: string): { title: string; where: string; detail: string }[] {
  const agents = 2 + form.team.builders.length;
  return [
    ...(form.source === "new" ? [{ title: "The repo", where: "GitHub", detail: `${form.repo || "owner/name"}, ${form.visibility}, with a README` }] : []),
    { title: "Role folders", where: "Repo", detail: "One for the product owner, the dev manager and the builders" },
    ...(form.tasks === "issues" ? [{ title: "4 task labels", where: "GitHub", detail: "Ready, in progress, in review, blocked" }] : []),
    { title: "The owner queue", where: "GitHub issue", detail: "One issue where the agents ask what only you decide" },
    { title: "A starter PRD", where: "Repo", detail: `docs/PRD.md with headings for ${form.team.productOwner} to fill in with you` },
    { title: "Your answers", where: "Repo", detail: "Task source, protected paths, commands and the team, saved in the project" },
    ...(messaging === "nats" ? [{ title: "Agent keys", where: "This machine", detail: `A key for each of the ${agents} agents on the NATS hub` }] : []),
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
  if (run.state === "done") return { tone: "good", text: `Done: all ${run.steps.length} steps.` };
  const now = run.steps.find((s) => s.state === "running");
  return { tone: "warn", text: `${now ? `${now.title}…` : "Starting…"} (${through} of ${run.steps.length} done)` };
}
