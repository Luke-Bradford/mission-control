import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_ATTEMPTS_KEEP_MS,
  RUN_SNAPSHOT_KEEP_MS,
  VACUUM_MIN_FREE_BYTES,
} from "../src/store/types.ts";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 22, 12);

type Db = {
  exec(sql: string): void;
  prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
};

const opened: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const open = (path = ":memory:") => {
  const s = new Store(path);
  opened.push(s);
  return s;
};
const dbOf = (s: Store) => (s as unknown as { db: Db }).db;
const attempts = (s: Store) =>
  dbOf(s).prepare("SELECT run_id AS runId, kind, at FROM run_attempts ORDER BY id").all() as {
    runId: string;
    kind: string;
    at: number;
  }[];

function add(s: Store, runId: string, kind: string, at: number, data: object = {}) {
  dbOf(s)
    .prepare("INSERT INTO run_attempts (run_id, kind, at, data) VALUES (?, ?, ?, ?)")
    .run(runId, kind, at, JSON.stringify(data));
}

describe("run_attempts retention", () => {
  it("keeps each run's latest snapshot, recent rows and every loop row; drops the rest", () => {
    const s = open();
    add(s, "a", "run", NOW - 10 * DAY); // superseded, old: goes
    add(s, "a", "run", NOW - 9 * DAY); // the latest for a: stays
    add(s, "b", "run", NOW - 1000); // recent: stays
    add(s, "b", "run", NOW - 500); // recent: stays
    add(s, "a", "loop", NOW - 200 * DAY); // loop rows feed the death-loop list: stay
    add(s, "a", "wait", NOW - RUN_ATTEMPTS_KEEP_MS - DAY); // old non-loop: goes
    add(s, "a", "wait", NOW - DAY); // recent: stays
    const deleted = s.pruneRunAttempts(NOW);
    expect(deleted).toBe(2);
    expect(attempts(s).map((r) => [r.runId, r.kind, NOW - r.at])).toEqual([
      ["a", "run", 9 * DAY],
      ["b", "run", 1000],
      ["b", "run", 500],
      ["a", "loop", 200 * DAY],
      ["a", "wait", DAY],
    ]);
    expect(RUN_SNAPSHOT_KEEP_MS).toBeLessThan(9 * DAY);
  });

  it("deletes nothing the second time", () => {
    const s = open();
    for (let i = 0; i < 5; i++) add(s, "a", "run", NOW - (20 - i) * DAY);
    expect(s.pruneRunAttempts(NOW)).toBe(4);
    expect(s.pruneRunAttempts(NOW)).toBe(0);
  });

  it("has the indexes its readers need", () => {
    const names = (
      dbOf(open())
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
        .all("run_attempts") as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["run_attempts_kind_at", "run_attempts_run_kind"]),
    );
  });

  it("shrinks the file once on open when most of it is free pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-retention-"));
    dirs.push(dir);
    const path = join(dir, "mc.db");
    const first = new Store(path);
    const padding = "x".repeat(1800);
    dbOf(first).exec("BEGIN");
    const insert = dbOf(first).prepare(
      "INSERT INTO run_attempts (run_id, kind, at, data) VALUES (?, 'run', ?, ?)",
    );
    const rows = Math.ceil((VACUUM_MIN_FREE_BYTES * 3) / 1800);
    for (let i = 0; i < rows; i++) insert.run("r", NOW - 30 * DAY + i, padding);
    dbOf(first).exec("COMMIT");
    first.close();
    const before = statSync(path).size;

    const second = new Store(path);
    second.close();
    // the store opened with the real clock: rows are old, so all but the last were dropped
    const after = statSync(path).size;
    expect(after).toBeLessThan(before / 3);
  });
});
