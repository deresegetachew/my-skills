// The web UI's server (#421, #422, decision 0005): Bun.serve on each address given, the page and its script, and a JSON
// API behind a token. Built-ins only.
//
//   GET  /  /app.js                            the page and the app (no data in them, so no token)
//   GET  /api/projects                         this project and those in ui.projects
//   GET  /api/projects/:p/channels             one per agent (with `avatar`, the owner's image, when there is one), one
//                                              per view
//   GET  /api/projects/:p/agents[/:name]       the agents live (factory_ui_data.ts live()), limit, githubCalls (the last hour)
//   GET  /api/projects/:p/machines             the machines, their agents and the CI runners
//   POST /api/projects/:p/agents/:name/start   {confirm: true}: factory owner start <role> <name>
//   POST /api/projects/:p/agents/:name/stop    {confirm: true}: factory owner stop <name>
//   POST /api/projects/:p/machines             {confirm: true, name, agents: ["haile", "taytu:manager"]}: factory machine add
//                                              <name> --json --agent ...; the answer carries `join` (code, command, expiresAt) (#445)
//   POST /api/projects/:p/machines/:name/remove {confirm: true}: factory machine remove <name>
//   GET|POST /api/projects/:p/agents/:name/chat, GET /api/projects/:p/owner-queue, POST .../owner-queue/:id/answer
//                                              the chat with each agent and the owner queue (factory_ui_chat.ts, #423)
//   GET  /api/ws?token=...                     a WebSocket: {type: "hello"}, then {type: "state", project, ...live} for
//                                              each project, and again whenever one changes; likewise {type: "views",
//                                              project, ...} for the tasks, pull requests and CI channels
//   GET  /api/projects/:p/docs, .../docs/page?id=, .../docs/search?q=: the PRD, the decisions and the wiki (factory_ui_docs.ts, #438)
//   GET  /api/projects/:p/tasks|pull-requests|ci, POST .../ci/actions/:name and .../refresh: factory_ui_views.ts (#424)
//   GET|POST /api/projects/:p/signoff, POST .../signoff/:id/confirm|result: the sign-off and testing queue (factory_ui_signoff.ts, #454)
//   GET  /api/projects/:p/artifacts, POST .../artifacts/pull: designs and artifacts (factory_ui_artifacts.ts, #454)
//   GET|POST /api/projects/:p/settings[/...]   Factory settings, releases and updates, maintenance (factory_ui_settings.ts,
//                                              #456): the team, project settings staged and proposed as one pull request,
//                                              this machine's saved at once, update, the clean-ups
//   POST /api/projects/:p/tasks/:id/actions/:name  the board's release, block and reassign (#439): factory_ui_views.ts
//   GET  /api/projects/:p/pull-requests/:n      a pull request's page (#453), read when it opens and kept until its head
//                                              changes; POST .../pull-requests/:n/actions/:name the owner's merge, ready,
//                                              comment, request-changes and close (factory_ui_pr.ts)
//   GET  /api/projects/:p/tasks/:id            a task's page from the message board (#498): the task, its thread and its
//                                              context entries (404 ui_board_absent when its tasks aren't on a board)
//   GET  /api/projects/:p/health|usage|activity|home, POST .../health/check: Health, Usage and cost, Activity and Home
//                                              (factory_ui_ops.ts, #455, #451); the WebSocket gets {type: "health", project} and
//                                              {type: "activity", project, items}, Activity's new entries (#583)
//   GET  /api/projects/:p/attention            Needs attention (#579, factory_ui_attention.ts): anything stuck, with its reason
//                                              and one action; the WebSocket gets {type: "attention", project, items} when it
//                                              changes (worked out from what the server already holds, no GitHub call)
//   GET|POST /api/add-project[/check|/runs/:id[/retry]]: add a project from the page (factory_ui_add.ts, #447); the
//                                              WebSocket gets {type: "add-project", run} and {type: "projects"}
//
// With a message board on this machine (#498, factory_ui_board.ts) a project's tasks and epics come from it, live: the
// server keeps one listen() and pushes a project's views when the board changes. Its snapshot then leaves the tasks
// out, so they aren't read from GitHub. A board that can't be read gives a notice and that project falls back to GitHub.
//
// The token goes in `Authorization: Bearer <token>` (or, for the WebSocket, which a browser can't give headers, in
// ?token=). Every refusal is {code, message, fix}. While a page is connected the server reads every project again each
// `ui.pollSeconds` and pushes what changed; with no page open it reads nothing.
//
// GET|POST|DELETE /api/projects/:p/signoff/:id/preview and /preview/:p/:id/...: a sign-off item's preview, the app run
// from the item's commit and served through this server behind the same token (factory_ui_preview.ts, #582). A result on
// the item stops it, and so does stopping the server.
import { timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { Previews, type WsData } from "./factory_ui_preview.ts";
import { AddRuns } from "./factory_ui_add.ts";
import { ChatHub } from "./factory_ui_chat.ts";
import { type Agent, channels, live, type Live, machineCommand, owner, type Problem, refreshConfig, roleOf, type UiProject } from "./factory_ui_data.ts";
import { artifactsApi } from "./factory_ui_artifacts.ts";
import { docsOf, pageById, searchDocs } from "./factory_ui_docs.ts";
import { settingsApi } from "./factory_ui_settings.ts";
import { signoffApi } from "./factory_ui_signoff.ts";
import { BoardFeed } from "./factory_ui_board.ts";
import { Ops } from "./factory_ui_ops.ts";
import { ciAction, pullRowOf, Refresher, repoOfProject, taskAction, viewsOf } from "./factory_ui_views.ts";
import { prAction, PrPages } from "./factory_ui_pr.ts";

export interface ServeOptions {
  hosts: string[];
  port: number;
  token: string;
  pollSeconds: number;
  projects: UiProject[];
  /** The app's JavaScript. */
  app: string;
  /** The message board's URL (#498); left out, this machine's (MB_URL, else the settings folder's url file), or none. */
  boardUrl?: string | null;
}

export interface Running {
  port: number;
  stop: () => void;
}

const TOPIC = "live";

/** The views' channels (#424) and the part of factory_ui_views.ts's Views each one is. */
const VIEW_PARTS: Record<string, "tasks" | "epics" | "pulls" | "ci"> = { tasks: "tasks", epics: "epics", "pull-requests": "pulls", ci: "ci" };

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Factory</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f46e5"/>` +
  `<path d="M9 23V9h14v4H13v2h8v4h-8v4z" fill="#fff"/></svg>`;

const HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store" } });
}

function problem(status: number, code: string, message: string, fix: string): Response {
  return json(status, { code, message, fix } satisfies Problem);
}

const TOKEN_FIX = "Open the address `factory ui` printed (it ends in ?token=...), or read the token from .git/factory/ui-token.";

/** Null when the request carries the token, else the 401 to answer. */
function refuseToken(req: Request, url: URL, token: string): Response | null {
  const header = req.headers.get("authorization") ?? "";
  return refuseGiven(header.startsWith("Bearer ") ? header.slice(7).trim() : url.pathname === "/api/ws" ? url.searchParams.get("token") ?? "" : "", token);
}

/** Null when `given` is the token, else the 401 to answer (the API's and the previews', #582). */
function refuseGiven(given: string, token: string): Response | null {
  if (!given) return problem(401, "ui_token_missing", "This needs the web UI's token.", TOKEN_FIX);
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return problem(401, "ui_token_wrong", "That isn't the web UI's token (it may be from an older start in another project).", TOKEN_FIX);
  }
  return null;
}

interface Kept {
  data: Live;
  text: string;
  at: number;
}

/** Starts the server on every host in `o.hosts`, on one port. */
export function serve(o: ServeOptions): Running {
  const list = [...o.projects]; // grows when a project is added from the page (#447)
  const byId = new Map(list.map((p) => [p.id, p]));
  const kept = new Map<string, Kept>();
  const reading = new Map<string, Promise<Kept>>();
  const servers: Server<WsData>[] = [];
  let clients = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const previews = new Previews(); // a sign-off item's preview (#582)
  const chat = new ChatHub({ pollSeconds: o.pollSeconds, publish: (m) => {
    const text = JSON.stringify(m);
    for (const s of servers) s.publish(TOPIC, text);
  } });

  /** The project's live state, read again when older than `maxAgeMs` (one read at a time per project). */
  function state(p: UiProject, maxAgeMs: number): Promise<Kept> {
    const k = kept.get(p.id);
    if (k && Date.now() - k.at <= maxAgeMs) return Promise.resolve(k);
    const busy = reading.get(p.id);
    if (busy) return busy;
    const next = live(p).then((data) => {
      const fresh = { data, text: JSON.stringify(data), at: Date.now() };
      kept.set(p.id, fresh);
      return fresh;
    }).finally(() => reading.delete(p.id));
    reading.set(p.id, next);
    return next;
  }

  function message(p: UiProject, data: Live): string {
    return JSON.stringify({ type: "state", project: p.id, ...data });
  }

  async function tick(): Promise<void> {
    for (const p of list) {
      const before = kept.get(p.id)?.text;
      const now = await state(p, 0);
      if (now.text !== before) for (const s of servers) s.publish(TOPIC, message(p, now.data));
      refresher.ifStale(p);
      pushViews(p);
      pushAttention(p);
      pushActivity(p);
      await chat.tick(p);
    }
  }

  // the tasks, pull requests and CI channels (#424): from the snapshot's cache, sent when they change
  const viewsSent = new Map<string, string>();
  const feed: BoardFeed = new BoardFeed(o.projects, { url: o.boardUrl, repoOf: repoOfProject,
    changed: (p) => pushViews(p), fellBack: (p, wasLive) => refresher.tasksNeeded(p, wasLive), log: (line) => console.log(line),
    event: (p, items) => publish({ type: "activity", project: p.id, items: ops.pushed(p, items) }) });
  const refresher = new Refresher((p) => pushViews(p), (p) => (feed.settled() ? feed.live(p) : null));
  const prPages = new PrPages(); // a pull request's page (#453), kept until its head changes
  void feed.start();
  function viewsMessage(p: UiProject): string {
    return JSON.stringify({ type: "views", project: p.id, ...viewsOf(p, refresher.running(p), Date.now(), feed.view(p)) });
  }
  function pushViews(p: UiProject): void {
    const text = viewsMessage(p);
    if (viewsSent.get(p.id) === text) return;
    viewsSent.set(p.id, text);
    for (const s of servers) s.publish(TOPIC, text);
    pushAttention(p);
  }
  // Needs attention (#579): pushed when it changes, from the views and the agents last read
  const attentionSent = new Map<string, string>();
  function attentionMessage(p: UiProject): string {
    return JSON.stringify({ type: "attention", project: p.id, items: ops.attention(p, kept.get(p.id)?.data ?? null) });
  }
  function pushAttention(p: UiProject): void {
    if (!clients) return; // worked out only while a page is open
    const text = attentionMessage(p);
    if (attentionSent.get(p.id) === text) return;
    attentionSent.set(p.id, text);
    for (const s of servers) s.publish(TOPIC, text);
  }
  // Activity (#583): what the snapshot's cache newly knows (a pull request opened, its CI or review), pushed as entries
  function pushActivity(p: UiProject): void {
    if (!clients) return;
    const items = ops.freshFromSnapshot(p);
    if (items.length) publish({ type: "activity", project: p.id, items });
  }
  function publish(m: Record<string, unknown>): void {
    const text = JSON.stringify(m);
    for (const s of servers) s.publish(TOPIC, text);
  }
  const ops = new Ops({ views: (p) => viewsOf(p, refresher.running(p), Date.now(), feed.view(p)), live: (p) => state(p, o.pollSeconds * 1000).then((k) => k.data),
    queue: (p) => chat.ownerQueue(p), keptQueue: (p) => chat.keptQueue(p), board: feed, publish });

  // adding a project (#447)
  const adds = new AddRuns({
    serving: list.find((p) => p.current) ?? list[0] as UiProject,
    projects: () => list,
    list: (p) => {
      list.push(p);
      byId.set(p.id, p);
      for (const s of servers) s.publish(TOPIC, JSON.stringify({ type: "projects" }));
      if (clients) void tick();
    },
    publish: (m) => {
      const text = JSON.stringify(m);
      for (const s of servers) s.publish(TOPIC, text);
    },
  });

  function seen(p: UiProject): Agent[] {
    return kept.get(p.id)?.data.agents ?? [];
  }

  async function api(req: Request, url: URL, server: Server<WsData>): Promise<Response | undefined> {
    const refused = refuseToken(req, url, o.token);
    if (refused) return refused;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent).slice(1); // after "api"
    if (parts.length === 1 && parts[0] === "ws") {
      if (server.upgrade(req, { data: undefined })) return undefined;
      return problem(400, "ui_ws_upgrade", "This address is a WebSocket.", "Connect to it with a WebSocket client.");
    }
    if (parts[0] === "add-project") {
      const r = await adds.api(req, parts.slice(1));
      return r ? json(r.status, r.body) : problem(404, "not_found", `There is no ${req.method} ${url.pathname}.`,
        "Adding a project is GET or POST /api/add-project, POST /api/add-project/check, GET /api/add-project/runs/:id and POST .../retry.");
    }
    if (parts[0] !== "projects") return problem(404, "not_found", `There is no ${url.pathname}.`, "The API is under /api/projects; see factory_ui_server.ts.");
    if (parts.length === 1) {
      if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
      return json(200, { projects: list.map((p) => ({ id: p.id, name: p.name, path: p.path, current: p.current, problem: p.problem })) });
    }
    const p = byId.get(parts[1] ?? "");
    if (!p) return problem(404, "ui_project_unknown", `There is no project ${parts[1]} here.`, "GET /api/projects lists them; add one with ui.projects.");
    refreshConfig(p); // a merged and pulled settings change shows without a restart (#456)
    const rest = parts.slice(2);
    const talked = await chat.api(req, p, rest, seen(p));
    if (talked) return json(talked.status, talked.body);
    const ttl = o.pollSeconds * 1000;
    const page = await ops.api(req, p, rest, url); // Health, Usage and cost, Activity, Home (#455, #451)
    if (page) return json(page.status, page.body);
    if (rest[0] === "docs" && rest.length <= 2) { // the PRD, the decisions and the wiki (#438)
      if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
      if (rest.length === 1) return json(200, { project: p.id, sections: docsOf(p) });
      if (rest[1] === "page") {
        const r = pageById(p, url.searchParams.get("id") ?? "");
        return json(r.status, r.status === 200 ? { project: p.id, ...r.body } : r.body);
      }
      if (rest[1] === "search") return json(200, { project: p.id, q: url.searchParams.get("q") ?? "", hits: searchDocs(p, url.searchParams.get("q") ?? "") });
    }
    if (rest[0] === "signoff" && rest.length === 3 && rest[2] === "preview") { // Open preview (#582)
      const r = await previews.api(req, p, rest[1] as string);
      return json(r.status, r.body);
    }
    if (rest[0] === "signoff") { // the sign-off and testing page (#454)
      const result = rest.length === 3 && rest[2] === "result" && req.method === "POST"
        ? ((await req.clone().json().catch(() => null)) as { outcome?: unknown } | null) : null;
      const r = await signoffApi(req, p, rest);
      if (result && r.status === 200) { // signed off or sent back: its preview stops (#582)
        const outcome = result.outcome;
        void previews.stop(p, rest[1] as string, outcome === "pass" ? "Stopped: the item was signed off."
          : outcome === "fail" ? "Stopped: the item was sent back." : "Stopped: a result was recorded.");
      }
      return json(r.status, r.body);
    }
    if (rest[0] === "settings") { // Factory settings, releases and updates, maintenance (#456)
      const r = await settingsApi(req, p, rest, {
        agents: async () => (await state(p, 0)).data.agents,
        changed: () => {
          kept.delete(p.id); // read again: the next look shows what changed
          if (clients) void tick();
        },
      });
      return json(r.status, r.body);
    }
    if (rest[0] === "artifacts") { // designs and artifacts (#454)
      const r = await artifactsApi(req, p, rest);
      return json(r.status, r.body);
    }
    if (rest.length === 1 && rest[0] === "channels" && req.method === "GET") return json(200, { project: p.id, channels: channels(p, seen(p)) });
    if (rest.length === 1 && rest[0] === "agents" && req.method === "GET") {
      const s = await state(p, ttl);
      return json(200, { project: p.id, agents: s.data.agents, limit: s.data.limit, githubCalls: s.data.githubCalls, problems: s.data.problems });
    }
    if (rest.length === 1 && rest[0] === "machines" && req.method === "GET") {
      const s = await state(p, ttl);
      return json(200, { project: p.id, machines: s.data.machines, runners: s.data.runners, problems: s.data.problems });
    }
    if (rest[0] === "machines" && (rest.length === 1 || rest.length === 3) && req.method === "POST") { // #445
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        // no body: no confirm
      }
      if (body === null || typeof body !== "object" || body.confirm !== true) {
        return problem(400, "confirm_needed", "Adding or removing a machine changes the board's logins, so it needs a confirm.", 'Send {"confirm": true} (the page asks you first).');
      }
      const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
      const flag = (s: string): boolean => s.startsWith("-"); // a value never becomes an option of the command
      let args: string[];
      if (rest.length === 1) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const agents = strs(body.agents);
        if (flag(name) || agents.some(flag)) return problem(400, "ui_bad_machine", "A machine's name and agents can't start with a dash.", "Use lowercase letters, digits and dashes.");
        args = ["add", name, "--json", ...agents.flatMap((a) => ["--agent", a])];
      } else if (rest[2] === "remove" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(rest[1] ?? "")) args = ["remove", rest[1] as string]; // already decoded once
      else return problem(404, "not_found", `There is no ${url.pathname}.`, "A machine has remove.");
      const r = await machineCommand(p, args);
      if (r.status === 200 && args[0] === "add") {
        try {
          return json(200, { ...r.body, join: JSON.parse(String(r.body.output)) as unknown });
        } catch {
          return json(200, r.body);
        }
      }
      return json(r.status, r.body);
    }
    if (rest[0] === "agents" && rest.length === 2 && req.method === "GET") {
      const s = await state(p, ttl);
      const agent = s.data.agents.find((a) => a.name === rest[1]);
      if (!agent) return problem(404, "ui_agent_unknown", `${rest[1]} isn't reported in ${p.name}.`, "GET /api/projects/:p/agents lists them.");
      return json(200, { project: p.id, agent, limit: s.data.limit });
    }
    if (rest[0] === "agents" && rest.length === 3 && (rest[2] === "start" || rest[2] === "stop")) {
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST with {\"confirm\": true}.");
      const name = rest[1] as string;
      const role = roleOf(p, name, seen(p));
      if (!role) return problem(404, "ui_agent_unknown", `${name} isn't one of ${p.name}'s agents.`, "Its channels list them: GET /api/projects/:p/channels.");
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        // no body: no confirm
      }
      if (typeof body !== "object" || body === null || (body as { confirm?: unknown }).confirm !== true) {
        return problem(400, "confirm_needed", `${rest[2] === "start" ? "Starting" : "Stopping"} ${name} changes what runs on this machine, so it needs a confirm.`,
          'Send {"confirm": true} (the page asks you first).');
      }
      const r = await owner(p, rest[2] === "start" ? ["start", role, name] : ["stop", name]);
      kept.delete(p.id); // read again: the next look shows what changed
      if (clients) void tick();
      return json(r.status, r.body);
    }
    if (rest[0] === "agents" && rest.length === 3) return problem(404, "not_found", `There is no ${url.pathname}.`, "An agent has start and stop.");
    const view = rest.length === 1 ? VIEW_PARTS[rest[0] ?? ""] : undefined;
    if (view) {
      if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
      refresher.ifStale(p);
      const v = viewsOf(p, refresher.running(p), Date.now(), feed.view(p));
      const meta = { project: p.id, generatedAt: v.generatedAt, age: v.age, refreshing: v.refreshing, reads: refresher.reads(p) };
      return json(200, view === "ci" ? { ...v.ci, ...meta, problems: [...v.problems, ...v.ci.problems] } // the verdict first
        : { ...meta, ...v[view], problems: [...v.problems, ...v[view].problems] });
    }
    if (rest[0] === "ci" && rest[1] === "actions" && rest.length === 3) {
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST with {\"confirm\": true}.");
      const r = await ciAction(p, rest[2] as string, await req.json().catch(() => null));
      if (rest[2] !== "log" && (r.status === 200 || r.status === 500)) void refresher.readAgain(p); // read again: the next look shows what changed
      return json(r.status, r.body);
    }
    if (rest[0] === "tasks" && rest[2] === "actions" && rest.length === 4) {
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST with {\"confirm\": true}.");
      const r = await taskAction(p, rest[1] as string, rest[3] as string, await req.json().catch(() => null), feed.view(p).part, feed);
      // read again, started (or queued after a running read) before the answer, which comes at once (#519)
      if (r.status === 200 || r.status === 500) void refresher.readAgain(p);
      return json(r.status, r.body);
    }
    if (rest[0] === "pull-requests" && (rest.length === 2 || (rest.length === 4 && rest[2] === "actions"))) { // #453
      const n = rest[1] as string;
      if (rest.length === 2) {
        if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
        const r = await prPages.detail(p, n, pullRowOf(p, n), url.searchParams.get("fresh") === "1");
        return json(r.status, r.body);
      }
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST with {\"confirm\": true}.");
      const r = await prAction(p, n, rest[3] as string, await req.json().catch(() => null), feed);
      if (r.status === 200 || r.status === 500) {
        prPages.forget(p, n); // the next look reads it again
        void refresher.readAgain(p); // and the list, at once
      }
      return json(r.status, r.body);
    }
    if (rest[0] === "tasks" && rest.length === 2) { // a task's page from the message board (#498)
      if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
      const r = await feed.detail(p, rest[1] as string);
      return json(r.status, r.body);
    }
    if (rest.length === 1 && rest[0] === "refresh") {
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST.");
      refresher.start(p, true);
      return json(202, { ok: true, command: "factory snapshot", refreshing: refresher.running(p) });
    }
    return problem(404, "not_found", `There is no ${url.pathname}.`, "The API is under /api/projects; see factory_ui_server.ts.");
  }

  async function fetch(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") return api(req, url, server);
    if (url.pathname.startsWith("/preview/")) { // a sign-off item's preview, behind the same token (#582)
      return previews.proxy(req, url, server, (id) => byId.get(id), (given) => refuseGiven(given, o.token));
    }
    if (req.method !== "GET" && req.method !== "HEAD") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
    if (url.pathname === "/app.js") {
      return new Response(o.app, { headers: { ...HEADERS, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (url.pathname === "/favicon.svg") return new Response(ICON, { headers: { ...HEADERS, "content-type": "image/svg+xml" } });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE, { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    return new Response("Not found\n", { status: 404, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });
  }

  const websocket = {
    async open(ws: ServerWebSocket<WsData>): Promise<void> {
      if (ws.data?.preview) return previews.wsOpen(ws); // a preview's own socket (#582)
      clients++;
      ws.subscribe(TOPIC);
      ws.send(JSON.stringify({ type: "hello", pollSeconds: o.pollSeconds, projects: list.map((p) => p.id) }));
      if (!timer) timer = setInterval(() => void tick(), o.pollSeconds * 1000);
      for (const p of list) {
        refresher.ifStale(p);
        pushActivity(p); // the first time, Activity keeps what the snapshot knows, so only what is new later is pushed (#583)
        if (ws.readyState === 1) ws.send(viewsMessage(p));
        const s = await state(p, o.pollSeconds * 1000);
        if (ws.readyState === 1) ws.send(message(p, s.data));
        if (ws.readyState === 1) ws.send(attentionMessage(p));
      }
    },
    message(ws: ServerWebSocket<WsData>, m: string | Buffer): void {
      // the page only listens; what it does goes through the API. A preview's socket passes on to the app.
      if (ws.data?.preview) previews.wsMessage(ws, m);
    },
    close(ws: ServerWebSocket<WsData>): void {
      if (ws.data?.preview) return previews.wsClose(ws);
      clients = Math.max(clients - 1, 0);
      if (!clients && timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  let port = o.port;
  for (const hostname of o.hosts) {
    const s = Bun.serve<WsData>({ hostname, port, fetch, websocket, idleTimeout: 60 });
    port = s.port ?? port;
    servers.push(s);
  }
  return {
    port,
    stop: () => {
      previews.stopAll(); // their processes and worktrees go with the server (#582)
      feed.stop();
      if (timer) clearInterval(timer);
      for (const s of servers) s.stop(true);
    },
  };
}
