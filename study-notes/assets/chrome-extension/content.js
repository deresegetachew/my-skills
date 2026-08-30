// Injected via chrome.scripting.executeScript({ func: extractReadableContent })
// for full-page captures. Must be self-contained — no closures over outer
// scope, since it runs in the page's isolated world by reference, not as a
// module import.
export function extractReadableContent() {
  const candidate = document.querySelector('article') || document.querySelector('main') || document.body;
  const clone = candidate.cloneNode(true);
  clone.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg').forEach((el) => el.remove());
  const text = clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
  return { title: document.title, text };
}
