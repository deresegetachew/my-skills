// Helpers for ci.test.ts. Not a test file.
import { readFileSync } from "node:fs";

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function unescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** An XML property list read the way Python's plistlib.load reads one: dict, array, string, integer, true, false.
 * Throws on anything malformed, so the fake plutil can lint with it. */
export function parsePlist(xml: string): PlistValue {
  const body = /<plist[^>]*>([\s\S]*)<\/plist>\s*$/.exec(xml.replace(/^<\?xml[^>]*\?>\s*(<!DOCTYPE[^>]*>\s*)?/, ""));
  if (!body) throw new Error("not a plist");
  const text = body[1] as string;
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };
  const tag = (): string => {
    ws();
    const m = /^<(\/?)([a-z]+)\s*(\/?)>/.exec(text.slice(i));
    if (!m) throw new Error(`bad plist at ${i}: ${text.slice(i, i + 40)}`);
    i += m[0].length;
    return `${m[1]}${m[2]}${m[3]}`;
  };
  const textUntil = (close: string): string => {
    const end = text.indexOf(`</${close}>`, i);
    if (end < 0) throw new Error(`no </${close}>`);
    const raw = text.slice(i, end);
    if (raw.includes("<")) throw new Error(`markup inside <${close}>`);
    i = end + close.length + 3;
    return unescape(raw);
  };
  const value = (open: string): PlistValue => {
    if (open === "string") return textUntil("string");
    if (open === "string/") return "";
    if (open === "integer") {
      const v = textUntil("integer").trim();
      if (!/^-?\d+$/.test(v)) throw new Error("bad integer");
      return Number(v);
    }
    if (open === "true/") return true;
    if (open === "false/") return false;
    if (open === "array") {
      const out: PlistValue[] = [];
      for (let t = tag(); t !== "/array"; t = tag()) out.push(value(t));
      return out;
    }
    if (open === "dict") {
      const out: { [key: string]: PlistValue } = {};
      for (let t = tag(); t !== "/dict"; t = tag()) {
        if (t !== "key") throw new Error("a dict needs a key");
        const k = textUntil("key");
        out[k] = value(tag());
      }
      return out;
    }
    throw new Error(`unknown plist element <${open}>`);
  };
  const v = value(tag());
  ws();
  if (i !== text.length) throw new Error("trailing content");
  return v;
}

export function loadPlist(path: string): { [key: string]: PlistValue } {
  const v = parsePlist(readFileSync(path, "utf8"));
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("not a dict");
  return v;
}
