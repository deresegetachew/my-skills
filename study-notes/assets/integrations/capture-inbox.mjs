import { readFileSync, mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Dev-only capture inbox for the study-notes Chrome extension.
//
// Registers Vite dev middleware (never present in `astro build` output) that:
//   - accepts captured selections/pages from the browser and appends them to
//     a single module-scoped queue under captures/ (sibling to the Astro
//     project root, never under src/ or dist/)
//   - serves a standalone review/discard page at /__capture-review
//
// Deliberately has no concept of lessons/chapters — a module's content
// structure (folders, chapters, an Astro site's src/data/lessons.ts, whatever
// shape it takes) isn't something the browser can meaningfully guess while
// you're mid-article. Sorting captures into the right place happens later,
// as a conversation with Claude, not at capture time. See CAPTURE.md.

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function writeJsonl(path, entries) {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function appendJsonl(path, entry) {
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

function logPendingSummary(capturesRoot, logger) {
  const count = readJsonl(join(capturesRoot, 'pending.jsonl')).length;
  if (count === 0) return;
  logger.info(`[captures] ${count} pending — see /__capture-review or ask Claude to check the inbox`);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function reviewPageHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Study notes — pending captures</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.3rem; }
  .entry { border: 1px solid #ddd; border-radius: 8px; padding: .75rem 1rem; margin-bottom: .75rem; }
  .meta { font-size: .8rem; color: #666; margin-bottom: .25rem; }
  .meta a { color: #666; }
  .text { white-space: pre-wrap; max-height: 8rem; overflow: auto; background: #f7f7f7; padding: .5rem; border-radius: 4px; }
  button { cursor: pointer; border: 1px solid #ccc; background: #fff; border-radius: 4px; padding: .3rem .6rem; font-size: .8rem; margin-top: .5rem; margin-right: .4rem; }
  button.copy { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .empty { color: #666; }
</style>
</head>
<body>
<h1>Pending captures</h1>
<button class="copy" id="copy-prompt">Copy "check inbox" prompt</button>
<div id="root" class="empty">Loading…</div>
<script>
document.getElementById('copy-prompt').addEventListener('click', () => {
  navigator.clipboard.writeText('Check the captures inbox for this module and help me fold anything useful into the notes.');
});
async function load() {
  const res = await fetch('/api/capture/pending');
  const entries = await res.json();
  const root = document.getElementById('root');
  if (entries.length === 0) {
    root.className = 'empty';
    root.textContent = 'Nothing pending.';
    return;
  }
  root.className = '';
  root.innerHTML = '';
  for (const entry of entries) {
    const div = document.createElement('div');
    div.className = 'entry';
    const url = entry.url ? '<a href="' + entry.url + '" target="_blank">' + entry.url + '</a>' : '';
    div.innerHTML = '<div class="meta">' + (entry.type === 'page' ? 'Full page' : 'Selection') + ' · ' +
      (entry.pageTitle || '') + ' · ' + url + ' · ' + new Date(entry.timestamp).toLocaleString() + '</div>' +
      '<div class="text"></div>' +
      '<button class="discard" data-id="' + entry.id + '">Discard</button>';
    div.querySelector('.text').textContent = entry.text;
    root.appendChild(div);
  }
  root.querySelectorAll('button.discard').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch('/api/capture/pending/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
      load();
    });
  });
}
load();
</script>
</body>
</html>`;
}

export default function captureInbox() {
  let capturesRoot;

  return {
    name: 'capture-inbox',
    hooks: {
      'astro:config:setup': ({ config }) => {
        const projectRoot = fileURLToPath(config.root);
        capturesRoot = join(projectRoot, '..', 'captures');
      },
      'astro:server:setup': ({ server, logger }) => {
        mkdirSync(capturesRoot, { recursive: true });
        logPendingSummary(capturesRoot, logger);

        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, 'http://localhost');
          if (!url.pathname.startsWith('/api/capture') && url.pathname !== '/__capture-review') {
            return next();
          }

          res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            return res.end();
          }

          try {
            if (url.pathname === '/__capture-review' && req.method === 'GET') {
              res.setHeader('Content-Type', 'text/html');
              return res.end(reviewPageHtml());
            }

            if (url.pathname === '/api/capture/health' && req.method === 'GET') {
              return sendJson(res, 200, { ok: true });
            }

            if (url.pathname === '/api/capture/status' && req.method === 'GET') {
              return sendJson(res, 200, { count: readJsonl(join(capturesRoot, 'pending.jsonl')).length });
            }

            if (url.pathname === '/api/capture/pending' && req.method === 'GET') {
              return sendJson(res, 200, readJsonl(join(capturesRoot, 'pending.jsonl')));
            }

            const discardMatch = url.pathname.match(/^\/api\/capture\/pending\/([^/]+)$/);
            if (discardMatch && req.method === 'DELETE') {
              const id = decodeURIComponent(discardMatch[1]);
              const pendingPath = join(capturesRoot, 'pending.jsonl');
              writeJsonl(pendingPath, readJsonl(pendingPath).filter((e) => e.id !== id));
              return sendJson(res, 200, { ok: true });
            }

            if (url.pathname === '/api/capture' && req.method === 'POST') {
              const body = JSON.parse((await readBody(req)) || '{}');
              const entry = {
                id: randomUUID(),
                timestamp: new Date().toISOString(),
                type: body.type === 'page' ? 'page' : 'selection',
                url: body.url ?? '',
                pageTitle: body.pageTitle ?? '',
                text: body.text ?? '',
                html: body.html,
              };
              appendJsonl(join(capturesRoot, 'inbox.jsonl'), entry);
              appendJsonl(join(capturesRoot, 'pending.jsonl'), entry);
              logPendingSummary(capturesRoot, logger);
              return sendJson(res, 201, { id: entry.id });
            }

            return next();
          } catch (err) {
            logger.error(String(err && err.stack ? err.stack : err));
            return sendJson(res, 500, { error: String(err) });
          }
        });
      },
    },
  };
}
