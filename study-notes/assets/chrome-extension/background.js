import { postCapture, fetchStatus } from './common.js';
import { extractReadableContent } from './content.js';

const MENU_SELECTION = 'study-notes-capture-selection';
const MENU_PAGE = 'study-notes-capture-page';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_SELECTION,
    title: 'Capture selection to Study Notes',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: 'Capture full page to Study Notes',
    contexts: ['page'],
  });
  chrome.alarms.create('refresh-badge', { periodInMinutes: 10 });
  refreshBadge();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_SELECTION) {
    await captureSelection(info, tab);
  } else if (info.menuItemId === MENU_PAGE) {
    await capturePage(tab);
  }
  refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh-badge') refreshBadge();
});

async function captureSelection(info, tab) {
  const res = await postCapture({
    type: 'selection',
    url: tab.url,
    pageTitle: tab.title,
    text: info.selectionText || '',
  });
  await recordResult(res.ok, tab.title, 'selection');
}

async function capturePage(tab) {
  let extracted;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractReadableContent,
    });
    extracted = result;
  } catch (err) {
    await recordResult(false, tab.title, 'page');
    return;
  }
  const res = await postCapture({
    type: 'page',
    url: tab.url,
    pageTitle: extracted?.title || tab.title,
    text: extracted?.text || '',
  });
  await recordResult(res.ok, extracted?.title || tab.title, 'page');
}

// Popup reads this list to show recent capture outcomes — the "toast" the
// plan calls for, since a service worker has no UI of its own to show one in.
async function recordResult(ok, pageTitle, type) {
  const { recentCaptures = [] } = await chrome.storage.local.get('recentCaptures');
  const entry = { ok, pageTitle, type, timestamp: new Date().toISOString() };
  await chrome.storage.local.set({ recentCaptures: [entry, ...recentCaptures].slice(0, 10) });
}

async function refreshBadge() {
  const { ok, count } = await fetchStatus();
  if (!ok) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
}
