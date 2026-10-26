// factory_tar.ts: the release archive reader and writer agree with an independent tar (GNU tar), in its PAX and GNU
// formats, for long paths, folders, links and modes.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { gzipFixed, tarCreate, TarError, tarEntries } from "../hooks/factory_tar.ts";
import { sh, tmp } from "./support.ts";

const LONG = "top/" + "d".repeat(60) + "/" + "e".repeat(60) + "/file-with-a-long-name.ts";

function tree(): string {
  const d = tmp();
  mkdirSync(join(d, "top", "d".repeat(60), "e".repeat(60)), { recursive: true });
  writeFileSync(join(d, LONG), "long\n");
  writeFileSync(join(d, "top", "run.sh"), "#!/bin/sh\n");
  chmodSync(join(d, "top", "run.sh"), 0o755);
  symlinkSync("run.sh", join(d, "top", "link"));
  return d;
}

for (const format of ["pax", "gnu", "ustar"]) {
  test(`reads what GNU tar writes in ${format} format`, () => {
    const d = tree();
    const out = join(tmp(), "a.tar.gz");
    const names = format === "ustar" ? ["top/run.sh", "top/link"] : ["top"];
    const p = sh(["tar", `--format=${format}`, "--owner=0", "--group=0", "-czf", out, ...names], { cwd: d });
    expect(p.code, p.out).toBe(0);
    const entries = [...tarEntries(gunzipSync(readFileSync(out)))];
    const byName = new Map(entries.map((e) => [e.name, e]));
    const run = byName.get("top/run.sh");
    expect(run?.kind).toBe("file");
    expect((run?.mode ?? 0) & 0o777).toBe(0o755);
    expect(new TextDecoder().decode(run?.data)).toBe("#!/bin/sh\n");
    expect(byName.get("top/link")?.kind).toBe("symlink");
    expect(byName.get("top/link")?.linkname).toBe("run.sh");
    if (format !== "ustar") {
      expect(byName.get("top")?.kind).toBe("dir");
      expect(new TextDecoder().decode(byName.get(LONG)?.data)).toBe("long\n");
    }
  });
}

test("GNU tar reads what the writer makes, long paths included, owned by 0/0 at time 0", () => {
  const files = [
    { name: "x/a.txt", mode: 0o644, data: new TextEncoder().encode("a\n") },
    { name: "x/" + "p".repeat(120) + "/b.ts", mode: 0o755, data: new TextEncoder().encode("b\n") },
    { name: "x/" + "q".repeat(150), mode: 0o644, data: new TextEncoder().encode("") },
  ];
  const dir = tmp();
  const path = join(dir, "w.tar.gz");
  writeFileSync(path, gzipFixed(tarCreate(files)));
  const list = sh(["tar", "--numeric-owner", "--full-time", "-tvzf", path]);
  expect(list.code, list.out).toBe(0);
  const lines = list.stdout.trim().split("\n");
  expect(lines.map((l) => l.split(/\s+/).pop())).toEqual(files.map((f) => f.name));
  expect(lines.map((l) => l.split(/\s+/)[0])).toEqual(["-rw-r--r--", "-rwxr-xr-x", "-rw-r--r--"]);
  expect(lines.every((l) => l.includes(" 0/0 ") && l.includes("1970-01-01"))).toBe(true);
  const x = sh(["tar", "-xzf", path], { cwd: dir });
  expect(x.code, x.out).toBe(0);
  expect(readFileSync(join(dir, files[1]?.name as string), "utf8")).toBe("b\n");
  // and the reader gets back exactly what went in
  const back = [...tarEntries(gunzipSync(readFileSync(path)))];
  expect(back.map((e) => [e.name, e.mode, new TextDecoder().decode(e.data)]))
    .toEqual(files.map((f) => [f.name, f.mode, new TextDecoder().decode(f.data)]));
});

test("a damaged archive is a TarError", () => {
  const good = tarCreate([{ name: "a", mode: 0o644, data: new TextEncoder().encode("hello") }]);
  const bad = good.slice();
  bad[10] = 0x41; // inside the name: the header checksum no longer matches
  expect(() => [...tarEntries(bad)]).toThrow(TarError);
  const short = good.slice(0, 600); // header says 5 bytes, then the data is cut
  expect(() => [...tarEntries(short.slice(0, 514))]).toThrow(TarError);
});
