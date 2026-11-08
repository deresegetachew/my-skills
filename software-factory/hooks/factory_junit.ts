// A JUnit XML report as a summary (#637, part 2): how many tests passed, failed and were skipped, and the failures with
// their message. A small parser of its own (no package): elements, attributes, text, CDATA, comments and the five named
// entities and numeric ones. Every <testcase> counts once: a <failure> or <error> in it is a failure, a <skipped> a skip,
// else a pass. A report with no <testcase> (only the totals) is read from its <testsuite> attributes. It never throws:
// what it can't read is `ok: false` with why.

export interface JunitFailure {
  suite: string;
  name: string;
  classname: string;
  /** failure or error */
  kind: string;
  message: string;
  /** The failure's text (a stack trace), at most 4000 characters. */
  text: string;
}

export interface JunitSummary {
  ok: boolean;
  /** Why it couldn't be read, when !ok. */
  why: string;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  /** The total time in seconds, when the report gives it. */
  seconds: number | null;
  failures: JunitFailure[];
}

interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

const MOST_FAILURES = 200;
/** The largest report summarised (a bigger one is a download only), and how deep its elements may nest: the summary
 *  runs in the web UI's request, so a hostile report must stay cheap (#637 review). */
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 256;
const TEXT_MAX = 4000;

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const n = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[\w:.-]/;

/** A tag's attributes, read once from left to right (a regex here was quadratic on a long tag, #637 review). What isn't
 *  `name="value"` or `name='value'` is skipped. */
function attributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (!NAME_START.test(s[i] as string)) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && NAME_CHAR.test(s[i] as string)) i++;
    const name = s.slice(start, i);
    while (i < n && /\s/.test(s[i] as string)) i++;
    if (s[i] !== "=") continue;
    i++;
    while (i < n && /\s/.test(s[i] as string)) i++;
    const q = s[i];
    if (q !== '"' && q !== "'") continue;
    const end = s.indexOf(q, i + 1);
    if (end < 0) break;
    out[name] = decode(s.slice(i + 1, end));
    i = end + 1;
  }
  return out;
}

/** The document's root element, or a string saying why it can't be read. */
export function parseXml(xml: string): Node | string {
  const root: Node = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: Node[] = [root];
  let i = 0;
  const top = (): Node => stack[stack.length - 1] as Node;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      top().text += decode(xml.slice(i));
      break;
    }
    if (lt > i) top().text += decode(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return "a comment isn't closed";
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return "a CDATA section isn't closed";
      top().text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) return "a declaration isn't closed";
      i = end + 2;
    } else if (xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) return "a doctype isn't closed";
      i = end + 1;
    } else if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) return "a closing tag isn't closed";
      const name = xml.slice(lt + 2, end).trim();
      if (stack.length < 2 || top().name !== name) return `</${name.slice(0, 40)}> doesn't close the element that is open`;
      stack.pop();
      i = end + 1;
    } else {
      let end = lt + 1;
      let quote = "";
      for (; end < xml.length; end++) {
        const c = xml[end];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (end >= xml.length) return "a tag isn't closed";
      let inner = xml.slice(lt + 1, end);
      const selfClosing = inner.endsWith("/");
      if (selfClosing) inner = inner.slice(0, -1);
      const name = /^[A-Za-z_:][\w:.-]*/.exec(inner)?.[0];
      if (!name) return "a tag has no name";
      const attrs: Record<string, string> = {};
      Object.assign(attrs, attributes(inner.slice(name.length)));
      const node: Node = { name, attrs, children: [], text: "" };
      top().children.push(node);
      if (!selfClosing) {
        if (stack.length > MAX_DEPTH) return `its elements are nested deeper than ${MAX_DEPTH}`;
        stack.push(node);
      }
      i = end + 1;
    }
  }
  if (stack.length > 1) return `<${top().name}> isn't closed`;
  const first = root.children[0];
  return first ?? "there is no element";
}

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function local(name: string): string {
  return name.includes(":") ? (name.split(":").at(-1) as string) : name;
}

function empty(why: string): JunitSummary {
  return { ok: false, why, tests: 0, passed: 0, failed: 0, skipped: 0, seconds: null, failures: [] };
}

/** The summary of a JUnit XML report. */
export function junitSummary(xml: string): JunitSummary {
  if (xml.length > MAX_BYTES) return empty(`It is too large to summarise (more than ${MAX_BYTES / (1024 * 1024)} MB); download it instead.`);
  try {
    return summarise(xml);
  } catch (e) {
    return empty(`It can't be read: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}.`);
  }
}

function summarise(xml: string): JunitSummary {
  const root = parseXml(xml);
  if (typeof root === "string") return empty(`It isn't well-formed XML: ${root}.`);
  if (local(root.name) !== "testsuites" && local(root.name) !== "testsuite") return empty(`Its root is <${root.name}>, not <testsuites> or <testsuite>.`);
  const out: JunitSummary = { ok: true, why: "", tests: 0, passed: 0, failed: 0, skipped: 0, seconds: null, failures: [] };
  let cases = 0;
  const walk = (n: Node, suite: string): void => {
    const name = local(n.name);
    if (name === "testsuite") suite = n.attrs.name ?? suite;
    if (name === "testcase") {
      cases++;
      const bad = n.children.find((c) => local(c.name) === "failure" || local(c.name) === "error");
      if (bad) {
        out.failed++;
        if (out.failures.length < MOST_FAILURES) {
          out.failures.push({ suite, name: n.attrs.name ?? "", classname: n.attrs.classname ?? "", kind: local(bad.name),
            message: (bad.attrs.message ?? bad.attrs.type ?? "").slice(0, 1000), text: bad.text.trim().slice(0, TEXT_MAX) });
        }
      } else if (n.children.some((c) => local(c.name) === "skipped")) out.skipped++;
      else out.passed++;
      return;
    }
    for (const c of n.children) walk(c, suite);
  };
  walk(root, root.attrs.name ?? "");
  if (cases === 0) {
    // only the totals: the suites' own counts (the root's when it is a single suite or carries them)
    const suites = local(root.name) === "testsuite" ? [root] : root.children.filter((c) => local(c.name) === "testsuite");
    for (const s of suites) {
      const tests = num(s.attrs.tests);
      const failed = num(s.attrs.failures) + num(s.attrs.errors);
      const skipped = num(s.attrs.skipped) + num(s.attrs.disabled);
      out.failed += failed;
      out.skipped += skipped;
      out.passed += Math.max(tests - failed - skipped, 0);
    }
  }
  out.tests = out.passed + out.failed + out.skipped;
  const time = Number(root.attrs.time);
  out.seconds = root.attrs.time !== undefined && Number.isFinite(time) ? time : null;
  return out;
}
