// The web UI's server (#421, #422, decision 0005): Bun.serve on each address given, the page and its script, and a JSON
// API behind a token. Built-ins only.
//
//   GET  /  /app.js                            the page and the app (no data in them, so no token)
//   GET  /api/projects                         this project and those in ui.projects
//   GET  /api/projects/:p/channels             one per agent (with `avatar`, the owner's image, when there is one), one
//                                              per view
//   GET  /api/projects/:p/agents[/:name]       the agents live (factory_ui_data.ts live())
//   GET  /api/projects/:p/machines             the machines, their agents and the CI runners
//   POST /api/projects/:p/agents/:name/start   {confirm: true}: factory owner start <role> <name>
//   POST /api/projects/:p/agents/:name/stop    {confirm: true}: factory owner stop <name>
//   GET|POST /api/projects/:p/agents/:name/chat, GET /api/projects/:p/owner-queue, POST .../owner-queue/:id/answer
//                                              the chat with each agent and the owner queue (factory_ui_chat.ts, #423)
//   GET  /api/ws?token=...                     a WebSocket: {type: "hello"}, then {type: "state", project, ...live} for
//                                              each project, and again whenever one changes; likewise {type: "views",
//                                              project, ...} for the tasks, pull requests and CI channels
//   GET  /api/projects/:p/docs, .../docs/page?id=, .../docs/search?q=: the PRD, the decisions and the wiki (factory_ui_docs.ts, #438)
//   GET  /api/projects/:p/tasks|pull-requests|ci, POST .../ci/actions/:name and .../refresh: factory_ui_views.ts (#424)
//   GET  /api/projects/:p/integrations, POST .../integrations/:id/test: what the factory connects to (factory_ui_integrations.ts, #441)
//
// The token goes in `Authorization: Bearer <token>` (or, for the WebSocket, which a browser can't give headers, in
// ?token=). Every refusal is {code, message, fix}. While a page is connected the server reads every project again each
// `ui.pollSeconds` and pushes what changed; with no page open it reads nothing. (NATS comes later through the messaging
// port; this loop reads the same data functions the cockpit does.)
import { timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { ChatHub } from "./factory_ui_chat.ts";
import { type Agent, channels, live, type Live, owner, type Problem, roleOf, type UiProject } from "./factory_ui_data.ts";
import { docsOf, pageById, searchDocs } from "./factory_ui_docs.ts";
import { integrationsOf, testIntegration } from "./factory_ui_integrations.ts";
import { ciAction, Refresher, viewsOf } from "./factory_ui_views.ts";

export interface ServeOptions {
  hosts: string[];
  port: number;
  token: string;
  pollSeconds: number;
  projects: UiProject[];
  /** The app's JavaScript. */
  app: string;
}

export interface Running {
  port: number;
  stop: () => void;
}

const TOPIC = "live";

/** The views' channels (#424) and the part of factory_ui_views.ts's Views each one is. */
const VIEW_PARTS: Record<string, "tasks" | "pulls" | "ci"> = { tasks: "tasks", "pull-requests": "pulls", ci: "ci" };

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
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : url.pathname === "/api/ws" ? url.searchParams.get("token") ?? "" : "";
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
  const byId = new Map(o.projects.map((p) => [p.id, p]));
  const kept = new Map<string, Kept>();
  const reading = new Map<string, Promise<Kept>>();
  const servers: Server<undefined>[] = [];
  let clients = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
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
    for (const p of o.projects) {
      const before = kept.get(p.id)?.text;
      const now = await state(p, 0);
      if (now.text !== before) for (const s of servers) s.publish(TOPIC, message(p, now.data));
      refresher.ifStale(p);
      pushViews(p);
      await chat.tick(p);
    }
  }

  // the tasks, pull requests and CI channels (#424): from the cockpit's cache, sent when they change
  const viewsSent = new Map<string, string>();
  const refresher = new Refresher((p) => pushViews(p));
  function viewsMessage(p: UiProject): string {
    return JSON.stringify({ type: "views", project: p.id, ...viewsOf(p, refresher.running(p)) });
  }
  function pushViews(p: UiProject): void {
    const text = viewsMessage(p);
    if (viewsSent.get(p.id) === text) return;
    viewsSent.set(p.id, text);
    for (const s of servers) s.publish(TOPIC, text);
  }

  function seen(p: UiProject): Agent[] {
    return kept.get(p.id)?.data.agents ?? [];
  }

  async function api(req: Request, url: URL, server: Server<undefined>): Promise<Response | undefined> {
    const refused = refuseToken(req, url, o.token);
    if (refused) return refused;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent).slice(1); // after "api"
    if (parts.length === 1 && parts[0] === "ws") {
      if (server.upgrade(req, { data: undefined })) return undefined;
      return problem(400, "ui_ws_upgrade", "This address is a WebSocket.", "Connect to it with a WebSocket client.");
    }
    if (parts[0] !== "projects") return problem(404, "not_found", `There is no ${url.pathname}.`, "The API is under /api/projects; see factory_ui_server.ts.");
    if (parts.length === 1) {
      if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
      return json(200, { projects: o.projects.map((p) => ({ id: p.id, name: p.name, path: p.path, current: p.current, problem: p.problem })) });
    }
    const p = byId.get(parts[1] ?? "");
    if (!p) return problem(404, "ui_project_unknown", `There is no project ${parts[1]} here.`, "GET /api/projects lists them; add one with ui.projects.");
    const rest = parts.slice(2);
    const talked = await chat.api(req, p, rest, seen(p));
    if (talked) return json(talked.status, talked.body);
    const ttl = o.pollSeconds * 1000;
    if (rest[0] === "docs" && rest.length <= 2) { // the PRD, the decisions and the wiki (#438)
      if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
      if (rest.length === 1) return json(200, { project: p.id, sections: docsOf(p) });
      if (rest[1] === "page") {
        const r = pageById(p, url.searchParams.get("id") ?? "");
        return json(r.status, r.status === 200 ? { project: p.id, ...r.body } : r.body);
      }
      if (rest[1] === "search") return json(200, { project: p.id, q: url.searchParams.get("q") ?? "", hits: searchDocs(p, url.searchParams.get("q") ?? "") });
    }
    if (rest.length === 1 && rest[0] === "integrations") { // what the factory connects to (#441)
      if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
      return json(200, { project: p.id, ...integrationsOf(p) });
    }
    if (rest[0] === "integrations" && rest.length === 3 && rest[2] === "test") {
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST.");
      const r = await testIntegration(p, rest[1] as string);
      return json(r.status, r.body);
    }
    if (rest.length === 1 && rest[0] === "channels" && req.method === "GET") return json(200, { project: p.id, channels: channels(p, seen(p)) });
    if (rest.length === 1 && rest[0] === "agents" && req.method === "GET") {
      const s = await state(p, ttl);
      return json(200, { project: p.id, agents: s.data.agents, limit: s.data.limit, problems: s.data.problems });
    }
    if (rest.length === 1 && rest[0] === "machines" && req.method === "GET") {
      const s = await state(p, ttl);
      return json(200, { project: p.id, machines: s.data.machines, runners: s.data.runners, problems: s.data.problems });
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
      const v = viewsOf(p, refresher.running(p));
      const meta = { project: p.id, generatedAt: v.generatedAt, age: v.age, refreshing: v.refreshing };
      return json(200, view === "ci" ? { ...v.ci, ...meta, problems: [...v.problems, ...v.ci.problems] } // the verdict first
        : { ...meta, ...v[view], problems: [...v.problems, ...v[view].problems] });
    }
    if (rest[0] === "ci" && rest[1] === "actions" && rest.length === 3) {
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST with {\"confirm\": true}.");
      const r = await ciAction(p, rest[2] as string, await req.json().catch(() => null));
      if (rest[2] !== "log" && (r.status === 200 || r.status === 500)) refresher.start(p, true); // read again: the next look shows what changed
      return json(r.status, r.body);
    }
    if (rest.length === 1 && rest[0] === "refresh") {
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST.");
      refresher.start(p, true);
      return json(202, { ok: true, command: "factory cockpit --json", refreshing: refresher.running(p) });
    }
    return problem(404, "not_found", `There is no ${url.pathname}.`, "The API is under /api/projects; see factory_ui_server.ts.");
  }

  async function fetch(req: Request, server: Server<undefined>): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") return api(req, url, server);
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
    async open(ws: ServerWebSocket<undefined>): Promise<void> {
      clients++;
      ws.subscribe(TOPIC);
      ws.send(JSON.stringify({ type: "hello", pollSeconds: o.pollSeconds, projects: o.projects.map((p) => p.id) }));
      if (!timer) timer = setInterval(() => void tick(), o.pollSeconds * 1000);
      for (const p of o.projects) {
        refresher.ifStale(p);
        if (ws.readyState === 1) ws.send(viewsMessage(p));
        const s = await state(p, o.pollSeconds * 1000);
        if (ws.readyState === 1) ws.send(message(p, s.data));
      }
    },
    message(): void {
      // the page only listens; what it does goes through the API
    },
    close(): void {
      clients = Math.max(clients - 1, 0);
      if (!clients && timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  let port = o.port;
  for (const hostname of o.hosts) {
    const s = Bun.serve<undefined>({ hostname, port, fetch, websocket, idleTimeout: 60 });
    port = s.port ?? port;
    servers.push(s);
  }
  return {
    port,
    stop: () => {
      if (timer) clearInterval(timer);
      for (const s of servers) s.stop(true);
    },
  };
}
