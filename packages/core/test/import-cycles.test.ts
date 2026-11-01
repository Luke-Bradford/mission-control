import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { coreImportGraph, importCycles } from "../../../scripts/check-core-cycles.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "mc-core-imports-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(resolve(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
it("rejects a transitive type-only cycle through a re-export", () => {
  const dir = fixture({
    "a.ts": 'import type { B } from "./b.ts"; export type A = B;',
    "b.ts": 'export type { C as B } from "./c.ts";',
    "c.ts": 'export type C = import("./a.ts").A;',
  });
  expect(importCycles(coreImportGraph(dir))).toEqual([
    [join(dir, "a.ts"), join(dir, "b.ts"), join(dir, "c.ts")],
  ]);
});
it("resolves TypeScript .js aliases and nested index modules, ignoring comments and packages", () => {
  const dir = fixture({
    "a.ts": 'import { x } from "./leaf.js"; import "external"; // import "./a.ts"\n',
    "leaf.ts": 'export { x } from "./nested";',
    "nested/index.ts": "export const x = 1;",
  });
  const graph = coreImportGraph(dir);
  expect([...(graph.get(join(dir, "a.ts")) ?? [])]).toEqual([join(dir, "leaf.ts")]);
  expect(importCycles(graph)).toEqual([]);
});
it("rejects self imports and literal dynamic import cycles", () => {
  const dir = fixture({
    "a.ts": 'export const load = () => import("./b.ts");',
    "b.ts": 'import "./a.ts";',
    "self.ts": 'import type * as Self from "./self.ts";',
  });
  expect(importCycles(coreImportGraph(dir))).toHaveLength(2);
});
it("makes the lint command fail for a cycle and pass for the current core", () => {
  const script = resolve(import.meta.dirname, "../../../scripts/check-core-cycles.ts");
  const bad = fixture({ "a.ts": 'export * from "./b.ts";', "b.ts": 'export * from "./a.ts";' });
  const failed = spawnSync(process.execPath, ["--experimental-strip-types", script, bad], {
    encoding: "utf8",
  });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("Core import cycle:");
  expect(
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", script, resolve(import.meta.dirname, "../src")],
      { encoding: "utf8" },
    ),
  ).toContain("no cycles");
});

it("rejects a cycle through the package's own public barrel", () => {
  const dir = fixture({
    "index.ts": 'export * from "./a.ts";',
    "a.ts": 'import { b } from "@mc/core"; export const a = b;',
  });
  expect(importCycles(coreImportGraph(dir))).toEqual([[join(dir, "a.ts"), join(dir, "index.ts")]]);
});

it("follows .js specifiers to TSX source when checking cycles", () => {
  const dir = fixture({
    "a.ts": 'import { b } from "./leaf.js"; export const a = b;',
    "leaf.tsx": 'import { a } from "./a.ts"; export const b = a;',
  });
  expect(importCycles(coreImportGraph(dir))).toEqual([[join(dir, "a.ts"), join(dir, "leaf.tsx")]]);
});
