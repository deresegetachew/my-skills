// Per-machine agent names (FACTORY_AGENTS, #48): `factory loop` on a second machine takes its own names.
import { afterAll, expect, test } from "bun:test";
import { checkout, project } from "./claims_support.ts";

const loops: { kill(): void }[] = [];
afterAll(() => loops.forEach((l) => l.kill()));

test("this machines names are taken in order with their own folders", () => {
  const clone = project();
  let [p, l] = checkout(clone, "haile,tewodros");
  loops.push(l);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split(/\s+/)[0]).toBe("haile");
  expect((p.stdout.split(/\s+/)[1] as string).endsWith("proj-agents/haile")).toBe(true);
  [p, l] = checkout(clone, "haile, tewodros");
  loops.push(l);
  expect(p.stdout.split(/\s+/)[0]).toBe("tewodros");
  [p, l] = checkout(clone, "haile,tewodros");
  loops.push(l);
  expect(p.code).not.toBe(0);
  expect(p.stderr).toContain("FACTORY_AGENTS");
});

test("an unknown name is refused", () => {
  const [p, l] = checkout(project(), "haile,nobody");
  l.kill();
  expect(p.code).not.toBe(0);
  expect(p.stderr).toContain("nobody");
  expect(p.stderr).toContain("FACTORY_AGENTS");
});

test("without the setting every name is used as before", () => {
  const [p, l] = checkout(project());
  l.kill();
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split(/\s+/)[0]).toBe("menelik");
});
