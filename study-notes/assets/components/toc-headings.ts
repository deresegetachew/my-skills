// Shared by LessonToc and FloatingToc: finds the page's section headings and
// makes sure each has a stable id to link to.
export interface TocHeading {
  id: string;
  text: string;
  level: 2 | 3;
  el: HTMLElement;
}

function slugify(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
}

export function collectHeadings(depth = 3): TocHeading[] {
  const selector = depth >= 3 ? 'h2.lesson-heading, h3.lesson-heading' : 'h2.lesson-heading';
  const used = new Set(Array.from(document.querySelectorAll('[id]'), (el) => el.id));
  const headings: TocHeading[] = [];

  document.querySelectorAll<HTMLElement>(`.lesson-article ${selector.split(', ').join(', .lesson-article ')}`)
    .forEach((el) => {
      if (el.closest('details')) return;               // skip headings inside collapsed blocks
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.source-badge').forEach((b) => b.remove());
      const text = (clone.textContent || '').trim();
      if (!text) return;
      if (!el.id) {
        let id = slugify(text), n = 2;
        while (used.has(id)) id = `${slugify(text)}-${n++}`;
        el.id = id;
        used.add(id);
      }
      headings.push({ id: el.id, text, level: el.tagName === 'H3' ? 3 : 2, el });
    });

  const deepDive = document.getElementById('deep-dive');
  if (deepDive) headings.push({ id: 'deep-dive', text: 'Deep dive', level: 2, el: deepDive });
  return headings;
}
