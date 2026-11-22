import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
let raw: { db: { prepare(sql: string): { run(...a: (string | number | null)[]): unknown } } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-malformed-"));
  store = new Store(join(dir, "mc.db"));
  raw = store as unknown as typeof raw;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("stored JSON that will not parse", () => {
  it("is skipped by the merged-PR read instead of failing it", () => {
    const insert = raw.db.prepare(
      "INSERT INTO pr_history (repo_id, number, merged_at, record) VALUES ('mc', ?, ?, ?)",
    );
    insert.run(1, 10, "{not json");
    insert.run(2, 20, JSON.stringify({ number: 2 }));
    const prs = store.prHistory("mc");
    expect(prs).toHaveLength(1);
    expect(prs[0]?.number).toBe(2);
  });
});
