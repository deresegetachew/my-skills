import { getConfig, setConfig, checkHealth, fetchStatus } from './common.js';

const statusEl = document.getElementById('status');
const baseUrlEl = document.getElementById('baseUrl');
const reviewLinkEl = document.getElementById('review-link');
const recentEl = document.getElementById('recent');

async function init() {
  const config = await getConfig();
  baseUrlEl.value = config.baseUrl;
  reviewLinkEl.href = config.baseUrl.replace(/\/$/, '') + '/__capture-review';

  const healthy = await checkHealth();
  if (healthy) {
    const { count } = await fetchStatus();
    statusEl.textContent = count > 0 ? `Connected — ${count} pending` : 'Connected — inbox clear';
  } else {
    statusEl.textContent = 'Dev server unreachable — run `npm run dev`';
  }
  statusEl.className = 'status ' + (healthy ? 'ok' : 'error');

  const { recentCaptures = [] } = await chrome.storage.local.get('recentCaptures');
  recentEl.innerHTML = recentCaptures
    .map((c) => `<li class="${c.ok ? '' : 'fail'}">${c.ok ? '✓' : '✗'} ${c.type} — ${escapeHtml(c.pageTitle || '')}</li>`)
    .join('') || '<li>No captures yet.</li>';
}

function escapeHtml(str) {
  return str.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

baseUrlEl.addEventListener('change', async () => {
  await setConfig({ baseUrl: baseUrlEl.value.trim() || 'http://localhost:4321' });
  init();
});

init();
