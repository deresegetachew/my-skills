// Shared helpers for background.js and popup.js (ES module — both are loaded
// as modules; see manifest.json's background.type and popup.html's script tag).

export const DEFAULTS = {
  baseUrl: 'http://localhost:4321',
};

export async function getConfig() {
  const stored = await chrome.storage.local.get(['baseUrl']);
  return { ...DEFAULTS, ...stored };
}

export async function setConfig(partial) {
  await chrome.storage.local.set(partial);
}

export async function apiFetch(path, options) {
  const { baseUrl } = await getConfig();
  return fetch(baseUrl.replace(/\/$/, '') + path, options);
}

export async function fetchStatus() {
  try {
    const res = await apiFetch('/api/capture/status');
    if (!res.ok) return { ok: false, count: 0 };
    return { ok: true, ...(await res.json()) };
  } catch {
    return { ok: false, count: 0 };
  }
}

export async function checkHealth() {
  try {
    const res = await apiFetch('/api/capture/health');
    return res.ok;
  } catch {
    return false;
  }
}

export async function postCapture(payload) {
  return apiFetch('/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
