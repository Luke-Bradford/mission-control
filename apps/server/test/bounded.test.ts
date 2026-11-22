import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addBounded, setBounded } from "../src/bounded.ts";
import { Store } from "../src/store.ts";

describe("bounded collections", () => {
  it("keeps the newest keys of a map and drops the oldest", () => {
    const m = new Map<number, number>();
    for (let i = 0; i < 10; i++) setBounded(m, i, i, 3);
    expect([...m.keys()]).toEqual([7, 8, 9]);
  });
  it("a key set again is the newest", () => {
    const m = new Map([
      [1, 1],
      [2, 2],
    ]);
    setBounded(m, 1, 9, 2);
    setBounded(m, 3, 3, 2);
    expect([...m.keys()]).toEqual([1, 3]);
  });
  it("keeps the newest members of a set", () => {
    const s = new Set<string>();
    for (let i = 0; i < 50; i++) addBounded(s, `k${i}`, 5);
    expect(s.size).toBe(5);
    expect(s.has("k49")).toBe(true);
    expect(s.has("k0")).toBe(false);
  });

  it("the store keeps a bounded number of prepared statements", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-bounded-"));
    const store = new Store(join(dir, "mc.db"));
    const inner = store as unknown as {
      statement(sql: string): { get(): unknown };
      statements: Map<string, unknown>;
    };
    for (let i = 0; i < 400; i++) inner.statement(`SELECT ${i} AS n`).get();
    expect(inner.statements.size).toBeLessThanOrEqual(256);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
