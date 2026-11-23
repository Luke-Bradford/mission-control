import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BoundedMap, BoundedSet } from "../src/bounded.ts";
import { Store } from "../src/store.ts";

describe("bounded collections", () => {
  it("a map keeps the newest keys and drops the oldest", () => {
    const m = new BoundedMap<number, number>(3);
    for (let i = 0; i < 10; i++) m.set(i, i);
    expect([...m.keys()]).toEqual([7, 8, 9]);
  });
  it("a key set again is the newest", () => {
    const m = new BoundedMap<number, number>(2);
    m.set(1, 1).set(2, 2).set(1, 9).set(3, 3);
    expect([...m.keys()]).toEqual([1, 3]);
    expect(m.get(1)).toBe(9);
  });
  it("a set keeps the newest members", () => {
    const s = new BoundedSet<string>(5);
    for (let i = 0; i < 50; i++) s.add(`k${i}`);
    expect(s.size).toBe(5);
    expect(s.has("k49")).toBe(true);
    expect(s.has("k0")).toBe(false);
  });
  it("the store keeps a bounded number of prepared statements", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-bounded-"));
    const store = new Store(join(dir, "mc.db"));
    const inner = store as unknown as {
      statement(sql: string): { get(): unknown };
      statements: BoundedMap<string, unknown>;
    };
    for (let i = 0; i < 400; i++) inner.statement(`SELECT ${i} AS n`).get();
    expect(inner.statements.size).toBeLessThanOrEqual(inner.statements.max);
    expect(inner.statements.max).toBe(256);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
